'use strict';

const {
  app,
  BrowserWindow,
  Tray,
  Menu,
  nativeImage,
  ipcMain,
  shell,
  Notification,
  clipboard,
} = require('electron');
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');
const {
  badgeLabelForUnread,
  buildFocusGroupPayload,
  isAbortedLoadError,
  normalizeUnreadCount,
  resolveIconPath,
} = require('./runtime-helpers');

const OFFICIAL_SERVER_URL = 'https://gchat.up.railway.app';
const OFFICIAL_SERVER_ORIGIN = new URL(OFFICIAL_SERVER_URL).origin;
const APP_USER_MODEL_ID = 'com.Gchat.app';
const GITHUB_RELEASES_URL = 'https://github.com/Panther114/GChat/releases/latest';
const ERR_ABORTED = -3;
const UPDATE_START_DELAY_MS = 15 * 1000;
// v1.3.14: H8 — clipboard copy bound to the app's max attachment (15MB bytes
// ≈ 20MB base64); a renderer can no longer OOM the main process with a
// multi-GB base64 string.
const MAX_CLIPBOARD_BASE64_LENGTH = 21 * 1024 * 1024;

// Lower Chromium memory surface: no WebGPU, tighter V8 heap, no background networking extras.
app.commandLine.appendSwitch(
  'disable-features',
  'WebGPU,CalculateNativeWinOcclusion,InterestFeedContentSuggestions,AutofillServerCommunication',
);
app.commandLine.appendSwitch('js-flags', '--max-old-space-size=384 --optimize-for-size');
app.commandLine.appendSwitch('disable-background-networking');
app.commandLine.appendSwitch('disable-renderer-backgrounding');
app.commandLine.appendSwitch('disable-background-timer-throttling');

if (process.platform === 'win32') app.setAppUserModelId(APP_USER_MODEL_ID);

let mainWindow = null;
let tray = null;
let isQuitting = false;
let lastLoadError = null;
let iconPathCache = null;
let appIconCache = null;
let trayIconCache = null;
let updaterController = null;
let updaterStartTimer = null;
let lastUnreadCount = null;
// Lightweight last-known updater status snapshot. Kept in the main process so
// did-finish-load can repaint the renderer without lazy-loading the 257KB
// updater bundle on every page load (cold start must stay off that path).
let lastUpdateStatusSnapshot = null;
// v1.3.9: connection monitor — mirrors the Rust shells' auto-retry so a
// transient load failure retries instead of stranding the user on the offline
// page with only a manual Retry button.
let connectionMonitorTimer = null;
let connectionMonitorAttempts = 0;
let lastTrayToggleAt = 0;
const CONNECTION_TIMEOUT_MS = 15 * 1000;
const MAX_CONNECTION_RETRIES = 3;
const badgeIconCache = new Map();

function getIconPath() {
  if (iconPathCache !== null) return iconPathCache;
  const candidates = [
    path.join(__dirname, '..', 'public', 'gchat_icon.png'),
    path.join(process.resourcesPath || '', 'public', 'gchat_icon.png'),
    // Fallback: the packaged build/app icon so the tray is never invisible.
    path.join(__dirname, '..', 'build', 'icon.ico'),
  ];
  iconPathCache = resolveIconPath(candidates, (candidate) => {
    fs.accessSync(candidate);
    return true;
  });
  return iconPathCache;
}

function getAppIcon() {
  if (!appIconCache) appIconCache = nativeImage.createFromPath(getIconPath());
  return appIconCache;
}

function getTrayIcon() {
  if (!trayIconCache) {
    const source = getAppIcon();
    trayIconCache = source.isEmpty() ? source : source.resize({ width: 16, height: 16 });
  }
  return trayIconCache;
}

function isHostedUrl(url) {
  try {
    return new URL(url).origin === OFFICIAL_SERVER_ORIGIN;
  } catch {
    return false;
  }
}

// v1.3.14: H8 — the offline recovery page is the only file:// document the
// shell ever loads in-window.
function getOfflineFileUrl() {
  return pathToFileURL(path.join(__dirname, 'offline.html')).href;
}

function isOfflineFileUrl(url) {
  try {
    return new URL(url).href === getOfflineFileUrl();
  } catch {
    return false;
  }
}

// v1.3.14: H8 — every IPC handler must come from the trusted renderer: the
// hosted app (official origin) or the offline page. A compromised/foreign
// page (data:/about:/file:/other origin) is cut off from all bridge commands.
function isTrustedSender(event) {
  const frame = event && event.senderFrame;
  const frameUrl = frame
    ? (typeof frame.url === 'function' ? frame.url() : frame.url) || ''
    : '';
  if (isHostedUrl(frameUrl) || isOfflineFileUrl(frameUrl)) return true;
  // Fallback for very old Electron where senderFrame may be null.
  const senderUrl = event && event.sender && event.sender !== mainWindow?.webContents
    ? ''
    : (event && event.sender && typeof event.sender.getURL === 'function' ? event.sender.getURL() : '');
  return isHostedUrl(senderUrl) || isOfflineFileUrl(senderUrl);
}

function hideToTray() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  mainWindow.hide();
  if (process.platform === 'win32') {
    mainWindow.setSkipTaskbar(true);
  }
}

function showMainWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  if (process.platform === 'win32') {
    mainWindow.setSkipTaskbar(false);
  }
  mainWindow.show();
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.focus();
}

/** Restore when hidden/minimized/unfocused; only hide when already frontmost. */
function toggleOrShowMainWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  const visible = mainWindow.isVisible();
  const minimized = mainWindow.isMinimized();
  const focused = mainWindow.isFocused();
  if (visible && !minimized && focused) {
    hideToTray();
    return;
  }
  showMainWindow();
}

function broadcastUpdateStatus(status) {
  if (status) lastUpdateStatusSnapshot = status;
  if (!mainWindow || mainWindow.isDestroyed()) return;
  mainWindow.webContents.send('update-status', status);
}

async function showOfflineScreen() {
  if (mainWindow && !mainWindow.isDestroyed()) {
    await mainWindow.loadFile(path.join(__dirname, 'offline.html'));
  }
}

// Returns the REAL load result: true when the hosted app finished loading,
// false on failure (recorded in lastLoadError) or on an aborted load (user or
// a competing navigation — never recorded, never retried). The retry handler
// and offline page depend on this outcome.
async function loadHostedApp() {
  if (!mainWindow || mainWindow.isDestroyed()) return false;
  try {
    // The persistent session keeps hosted login cookies and client-side keys between launches.
    await mainWindow.loadURL(OFFICIAL_SERVER_URL);
    return true;
  } catch (error) {
    // An aborted (-3) load is a navigation race, not an outage: do not
    // overwrite lastLoadError nor re-schedule the connection monitor.
    if (isAbortedLoadError(error)) return false;
    lastLoadError = {
      errorCode: 'LOAD_FAILED',
      errorDescription: error?.message || 'Unable to connect to the hosted app.',
      url: OFFICIAL_SERVER_URL,
      failedAt: new Date().toISOString(),
    };
    // v1.3.9: no immediate offline screen — the monitor retries first.
    scheduleConnectionMonitor();
    return false;
  }
}

// v1.3.9: auto-retry a failed hosted load (3 attempts × 15s) before showing
// the offline recovery page — a transient network blip must not strand the app.
function scheduleConnectionMonitor() {
  if (connectionMonitorTimer) {
    clearTimeout(connectionMonitorTimer);
    connectionMonitorTimer = null;
  }
  connectionMonitorTimer = setTimeout(() => {
    connectionMonitorTimer = null;
    if (!mainWindow || mainWindow.isDestroyed() || isQuitting) return;
    const currentUrl = mainWindow.webContents.getURL() || '';
    if (isHostedUrl(currentUrl)) {
      connectionMonitorAttempts = 0;
      return;
    }
    if (connectionMonitorAttempts < MAX_CONNECTION_RETRIES) {
      connectionMonitorAttempts += 1;
      void loadHostedApp();
      scheduleConnectionMonitor();
      return;
    }
    connectionMonitorAttempts = 0;
    void showOfflineScreen();
  }, CONNECTION_TIMEOUT_MS);
}

function cancelConnectionMonitor() {
  if (connectionMonitorTimer) {
    clearTimeout(connectionMonitorTimer);
    connectionMonitorTimer = null;
  }
  connectionMonitorAttempts = 0;
}

async function createWindow() {
  const icon = getAppIcon();
  if (process.platform === 'darwin' && app.dock && !icon.isEmpty()) app.dock.setIcon(icon);

  mainWindow = new BrowserWindow({
    width: 1100,
    height: 700,
    minWidth: 880,
    minHeight: 600,
    title: 'Gchat',
    icon,
    backgroundColor: '#0b1020',
    show: false,
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      partition: 'persist:gchat',
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: true,
      // Keep Socket.IO's normal heartbeat alive while the tray-hidden desktop
      // window is in the background, avoiding an unnecessary reconnect on focus.
      backgroundThrottling: false,
    },
  });

  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
    mainWindow.focus();
  });
  mainWindow.webContents.on('did-fail-load', async (_event, errorCode, errorDescription, validatedURL, isMainFrame) => {
    if (!isMainFrame || errorCode === ERR_ABORTED || !validatedURL || validatedURL.startsWith('file://')) return;
    lastLoadError = { errorCode, errorDescription, url: validatedURL, failedAt: new Date().toISOString() };
    // v1.3.9: retry automatically before showing the offline page.
    scheduleConnectionMonitor();
  });
  mainWindow.webContents.on('did-finish-load', () => {
    if (isHostedUrl(mainWindow?.webContents.getURL() || '')) {
      lastLoadError = null;
      cancelConnectionMonitor();
    }
    // Repaint the last known status WITHOUT touching the updater bundle —
    // lazily initializing it here would put 257KB on the cold-start path.
    if (lastUpdateStatusSnapshot) broadcastUpdateStatus(lastUpdateStatusSnapshot);
  });
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    // v1.3.14: H8 — only open safe https links externally; never hand file:/
    // or other schemes to the OS handler from renderer content.
    if (/^https:/i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  mainWindow.webContents.on('will-navigate', (event, url) => {
    // v1.3.14: H8 — the window may only show the hosted app or the packaged
    // offline page. Everything else (data:/about:/file:/foreign origins) is
    // blocked; safe https links open in the default browser.
    if (isHostedUrl(url) || isOfflineFileUrl(url)) return;
    event.preventDefault();
    if (/^https:/i.test(url)) shell.openExternal(url);
  });
  mainWindow.on('close', (event) => {
    if (!isQuitting) {
      event.preventDefault();
      hideToTray();
    }
  });
  mainWindow.on('minimize', (event) => {
    if (!isQuitting) {
      event.preventDefault();
      hideToTray();
    }
  });
  mainWindow.on('focus', () => mainWindow.flashFrame(false));
  await loadHostedApp();
}

async function createTray() {
  tray = new Tray(getTrayIcon());
  tray.on('click', () => {
    // v1.3.9: debounce — Windows tray double-click fires 'click' twice.
    const now = Date.now();
    if (now - lastTrayToggleAt < 400) return;
    lastTrayToggleAt = now;
    toggleOrShowMainWindow();
  });
  updateTrayMenu(0, true);
}

function updateTrayMenu(unread = 0, force = false) {
  if (!tray) return;
  if (!force && unread === lastUnreadCount) return;
  lastUnreadCount = unread;
  const label = unread > 0 ? `Gchat (${unread} unread)` : 'Gchat';
  tray.setContextMenu(Menu.buildFromTemplate([
    { label, enabled: false },
    { type: 'separator' },
    { label: 'Open Gchat', click: () => showMainWindow() },
    {
      label: 'Check for Updates',
      click: () => {
        void getUpdaterController().checkForUpdates({ silent: false });
      },
    },
    { type: 'separator' },
    { label: 'Quit', click: () => { isQuitting = true; app.quit(); } },
  ]));
  tray.setToolTip(unread > 0 ? `Gchat — ${unread} unread message${unread === 1 ? '' : 's'}` : 'Gchat');
}

function createBadgeIcon(count) {
  const label = badgeLabelForUnread(count);
  const cached = badgeIconCache.get(label);
  if (cached) return cached;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20"><circle cx="10" cy="10" r="10" fill="#e74c3c"/><text x="50%" y="50%" text-anchor="middle" dominant-baseline="central" font-family="Arial,sans-serif" font-size="${label.length > 1 ? 9 : 12}" font-weight="bold" fill="white">${label}</text></svg>`;
  const icon = nativeImage.createFromDataURL(`data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`);
  badgeIconCache.set(label, icon);
  return icon;
}

// v1.3.14: H8 — every bridge handler validates its sender. Only the hosted
// app (official origin) or the packaged offline page may invoke them.
ipcMain.on('set-unread-count', (event, count) => {
  if (!isTrustedSender(event)) return;
  const unread = normalizeUnreadCount(count);
  if (unread === lastUnreadCount) return;
  if (mainWindow && !mainWindow.isDestroyed()) {
    if (process.platform === 'darwin') {
      app.dock?.setBadge(unread ? badgeLabelForUnread(unread) : '');
    } else {
      mainWindow.setOverlayIcon(
        unread ? createBadgeIcon(unread) : null,
        unread ? `${unread} unread message${unread === 1 ? '' : 's'}` : '',
      );
    }
    if (unread && !mainWindow.isFocused()) mainWindow.flashFrame(true);
  }
  updateTrayMenu(unread);
});

ipcMain.on('show-notification', (event, payload = {}) => {
  if (!isTrustedSender(event)) return;
  if (!Notification.isSupported()) return;
  const options = payload && typeof payload === 'object' ? payload : {};
  // tag: identical notifications replace each other instead of stacking.
  const notification = new Notification({
    title: options.title || 'Gchat',
    body: options.body || 'New message',
    tag: 'gchat-message',
    icon: getAppIcon(),
    urgency: 'normal',
  });
  notification.on('click', () => {
    showMainWindow();
    const focusPayload = buildFocusGroupPayload(options);
    if (focusPayload) mainWindow?.webContents.send('focus-group', focusPayload);
  });
  notification.show();
});

ipcMain.handle('get-launch-at-startup', (event) => {
  if (!isTrustedSender(event)) return false;
  return !!app.getLoginItemSettings().openAtLogin;
});
ipcMain.handle('set-launch-at-startup', (event, enabled) => {
  if (!isTrustedSender(event)) return false;
  const openAtLogin = !!enabled;
  app.setLoginItemSettings({ openAtLogin });
  return openAtLogin;
});
ipcMain.handle('retry-connection', async (event) => {
  if (!isTrustedSender(event)) return false;
  // The offline page's Retry button re-enables itself when this resolves
  // false, so the outcome must be the REAL load result.
  try {
    if (!mainWindow || mainWindow.isDestroyed()) return false;
    cancelConnectionMonitor();
    connectionMonitorAttempts = 0;
    return (await loadHostedApp()) === true;
  } catch {
    return false;
  }
});
ipcMain.handle('get-connection-context', (event) => {
  if (!isTrustedSender(event)) return null;
  return {
    serverUrl: OFFICIAL_SERVER_URL,
    lastLoadError,
  };
});
ipcMain.handle('copy-binary-to-clipboard', (event, payload = {}) => {
  if (!isTrustedSender(event)) return false;
  try {
    const base64 = typeof payload.base64 === 'string' ? payload.base64 : '';
    // v1.3.14: H8 — bound the payload; the renderer's max attachment is 15MB
    // of bytes (~20MB base64), so anything beyond that is rejected up front.
    if (base64.length > MAX_CLIPBOARD_BASE64_LENGTH) return false;
    const buffer = Buffer.from(base64, 'base64');
    if (typeof payload.mimeType === 'string' && payload.mimeType.startsWith('image/')) {
      const image = nativeImage.createFromBuffer(buffer);
      if (!image.isEmpty()) {
        clipboard.writeImage(image);
        return true;
      }
    }
    clipboard.writeBuffer('application/octet-stream', buffer);
    return true;
  } catch {
    return false;
  }
});
ipcMain.handle('clear-cache-and-restart', async (event) => {
  if (!isTrustedSender(event)) return false;
  await mainWindow?.webContents.session.clearCache();
  // app.quit() (not app.exit) so the before-quit handler runs and disposes
  // the updater cleanly before the relaunch.
  isQuitting = true;
  app.relaunch();
  app.quit();
  return true;
});
ipcMain.handle('reload-hosted-app', async (event) => {
  if (!isTrustedSender(event)) return false;
  if (!mainWindow || mainWindow.isDestroyed()) return false;
  lastLoadError = null;
  cancelConnectionMonitor();
  await mainWindow.webContents.reloadIgnoringCache();
  // v1.3.9: arm the monitor so a failed reload auto-retries instead of leaving
  // a blank window.
  scheduleConnectionMonitor();
  return true;
});
ipcMain.handle('check-for-updates', async (event) => {
  if (!isTrustedSender(event)) return 'idle';
  const result = await getUpdaterController().checkForUpdates({ silent: false });
  return result.status;
});
ipcMain.handle('get-update-status', (event) => {
  if (!isTrustedSender(event)) return null;
  return getUpdaterController().getStatus();
});
ipcMain.handle('install-update', (event) => {
  if (!isTrustedSender(event)) return false;
  const installed = getUpdaterController().installUpdate();
  if (installed) isQuitting = true;
  return installed;
});
ipcMain.handle('open-latest-release', async (event) => {
  if (!isTrustedSender(event)) return false;
  await shell.openExternal(GITHUB_RELEASES_URL);
  return true;
});

function getUpdaterController() {
  if (!updaterController) {
    // Keep the updater's dependency tree off the cold startup path.
    const { createUpdaterController } = require('./updater.bundle.cjs');
    updaterController = createUpdaterController({
      isPackaged: app.isPackaged,
      currentVersion: app.getVersion(),
      autoInstallOnDownload: false,
      onUpdateReady() {
        // Renderer / Settings can choose Install and restart; do not force-quit mid-chat.
      },
      onError(error) {
        console.error('[updater] error:', error.message);
      },
      onStatus(status) {
        broadcastUpdateStatus(status);
      },
    });
  }
  return updaterController;
}

function scheduleAutoUpdater() {
  if (!app.isPackaged || updaterStartTimer) return;
  updaterStartTimer = setTimeout(() => {
    updaterStartTimer = null;
    getUpdaterController().start();
  }, UPDATE_START_DELAY_MS);
  updaterStartTimer.unref?.();
}

if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on('second-instance', () => {
    showMainWindow();
  });
  app.whenReady().then(async () => {
    await createWindow();
    await createTray();
    scheduleAutoUpdater();
  });
}

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin' && isQuitting) app.quit();
});
app.on('activate', async () => {
  if (BrowserWindow.getAllWindows().length === 0) await createWindow();
  else showMainWindow();
});
app.on('before-quit', () => {
  isQuitting = true;
  if (updaterStartTimer) clearTimeout(updaterStartTimer);
  updaterStartTimer = null;
  cancelConnectionMonitor();
  updaterController?.dispose();
});
