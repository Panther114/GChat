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
const {
  badgeLabelForUnread,
  normalizeUnreadCount,
} = require('./runtime-helpers');

const OFFICIAL_SERVER_URL = 'https://gchat.up.railway.app';
const OFFICIAL_SERVER_ORIGIN = new URL(OFFICIAL_SERVER_URL).origin;
const APP_USER_MODEL_ID = 'com.Gchat.app';
const GITHUB_RELEASES_URL = 'https://github.com/Panther114/GChat/releases/latest';
const ERR_ABORTED = -3;
const UPDATE_START_DELAY_MS = 15 * 1000;

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
const badgeIconCache = new Map();

function getIconPath() {
  if (iconPathCache !== null) return iconPathCache;
  const candidates = [
    path.join(__dirname, '..', 'public', 'gchat_icon.png'),
    path.join(process.resourcesPath, 'public', 'gchat_icon.png'),
  ];
  iconPathCache = candidates.find((candidate) => {
    try {
      fs.accessSync(candidate);
      return true;
    } catch {
      return false;
    }
  }) || '';
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
  if (!mainWindow || mainWindow.isDestroyed()) return;
  mainWindow.webContents.send('update-status', status);
}

async function showOfflineScreen() {
  if (mainWindow && !mainWindow.isDestroyed()) {
    await mainWindow.loadFile(path.join(__dirname, 'offline.html'));
  }
}

async function loadHostedApp() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  try {
    // The persistent session keeps hosted login cookies and client-side keys between launches.
    await mainWindow.loadURL(OFFICIAL_SERVER_URL);
  } catch (error) {
    lastLoadError = {
      errorCode: 'LOAD_FAILED',
      errorDescription: error?.message || 'Unable to connect to the hosted app.',
      url: OFFICIAL_SERVER_URL,
      failedAt: new Date().toISOString(),
    };
    await showOfflineScreen();
  }
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
    await showOfflineScreen();
  });
  mainWindow.webContents.on('did-finish-load', () => {
    if (isHostedUrl(mainWindow?.webContents.getURL() || '')) lastLoadError = null;
    const status = getUpdaterController().getStatus();
    broadcastUpdateStatus(status);
  });
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });
  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (isHostedUrl(url) || url.startsWith('file://')) return;
    event.preventDefault();
    if (/^https?:/i.test(url)) shell.openExternal(url);
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

ipcMain.on('set-unread-count', (_event, count) => {
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

ipcMain.on('show-notification', (_event, { title, body, groupId } = {}) => {
  if (!Notification.isSupported()) return;
  const notification = new Notification({
    title: title || 'Gchat',
    body: body || 'New message',
    icon: getAppIcon(),
    urgency: 'normal',
  });
  notification.on('click', () => {
    showMainWindow();
    if (groupId) mainWindow?.webContents.send('focus-group', groupId);
  });
  notification.show();
});

ipcMain.handle('get-launch-at-startup', () => !!app.getLoginItemSettings().openAtLogin);
ipcMain.handle('set-launch-at-startup', (_event, enabled) => {
  const openAtLogin = !!enabled;
  app.setLoginItemSettings({ openAtLogin });
  return openAtLogin;
});
ipcMain.handle('retry-connection', async () => {
  await loadHostedApp();
  return true;
});
ipcMain.handle('get-connection-context', () => ({
  serverUrl: OFFICIAL_SERVER_URL,
  lastLoadError,
}));
ipcMain.handle('copy-binary-to-clipboard', (_event, payload = {}) => {
  try {
    const buffer = Buffer.from(typeof payload.base64 === 'string' ? payload.base64 : '', 'base64');
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
ipcMain.handle('clear-cache-and-restart', async () => {
  await mainWindow?.webContents.session.clearCache();
  isQuitting = true;
  app.relaunch();
  app.exit(0);
  return true;
});
ipcMain.handle('reload-hosted-app', async () => {
  if (!mainWindow || mainWindow.isDestroyed()) return false;
  await mainWindow.webContents.reloadIgnoringCache();
  return true;
});
ipcMain.handle('check-for-updates', async () => {
  const result = await getUpdaterController().checkForUpdates({ silent: false });
  return result.status;
});
ipcMain.handle('get-update-status', () => getUpdaterController().getStatus());
ipcMain.handle('install-update', () => {
  const installed = getUpdaterController().installUpdate();
  if (installed) isQuitting = true;
  return installed;
});
ipcMain.handle('open-latest-release', async () => {
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
  updaterController?.dispose();
});
