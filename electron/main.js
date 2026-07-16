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
const { autoUpdater } = require('electron-updater');

const OFFICIAL_SERVER_URL = 'https://gchat.up.railway.app';
const OFFICIAL_SERVER_ORIGIN = new URL(OFFICIAL_SERVER_URL).origin;
const APP_USER_MODEL_ID = 'com.Gchat.app';
const ERR_ABORTED = -3;
const UPDATE_CHECK_INTERVAL_MS = 30 * 60 * 1000;

if (process.platform === 'win32') app.setAppUserModelId(APP_USER_MODEL_ID);

let mainWindow = null;
let tray = null;
let isQuitting = false;
let lastLoadError = null;

function getIconPath() {
  const candidates = [
    path.join(__dirname, '..', 'public', 'gchat_icon.png'),
    path.join(process.resourcesPath, 'public', 'gchat_icon.png'),
  ];
  return candidates.find((candidate) => {
    try {
      fs.accessSync(candidate);
      return true;
    } catch {
      return false;
    }
  }) || '';
}

function isHostedUrl(url) {
  try {
    return new URL(url).origin === OFFICIAL_SERVER_ORIGIN;
  } catch {
    return false;
  }
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
  const icon = nativeImage.createFromPath(getIconPath());
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
  });
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });
  mainWindow.on('close', (event) => {
    if (!isQuitting) {
      event.preventDefault();
      mainWindow.hide();
    }
  });
  mainWindow.on('focus', () => mainWindow.flashFrame(false));
  await loadHostedApp();
}

async function createTray() {
  const source = nativeImage.createFromPath(getIconPath());
  tray = new Tray(source.isEmpty() ? source : source.resize({ width: 16, height: 16 }));
  tray.on('click', () => {
    if (!mainWindow) return;
    if (mainWindow.isVisible()) mainWindow.hide();
    else {
      mainWindow.show();
      mainWindow.focus();
    }
  });
  updateTrayMenu();
}

function updateTrayMenu(unread = 0) {
  if (!tray) return;
  const label = unread > 0 ? `Gchat (${unread} unread)` : 'Gchat';
  tray.setContextMenu(Menu.buildFromTemplate([
    { label, enabled: false },
    { type: 'separator' },
    { label: 'Open Gchat', click: () => { mainWindow?.show(); mainWindow?.focus(); } },
    { label: 'Check for Updates', click: () => autoUpdater.checkForUpdatesAndNotify() },
    { type: 'separator' },
    { label: 'Quit', click: () => { isQuitting = true; app.quit(); } },
  ]));
  tray.setToolTip(unread > 0 ? `Gchat — ${unread} unread message${unread === 1 ? '' : 's'}` : 'Gchat');
}

function createBadgeIcon(count) {
  const label = count > 99 ? '99+' : String(count);
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20"><circle cx="10" cy="10" r="10" fill="#e74c3c"/><text x="50%" y="50%" text-anchor="middle" dominant-baseline="central" font-family="Arial,sans-serif" font-size="${label.length > 1 ? 9 : 12}" font-weight="bold" fill="white">${label}</text></svg>`;
  return nativeImage.createFromDataURL(`data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`);
}

ipcMain.on('set-unread-count', (_event, count) => {
  const unread = Math.max(0, Number(count) || 0);
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.setOverlayIcon(unread ? createBadgeIcon(unread) : null, unread ? `${unread} unread message${unread === 1 ? '' : 's'}` : '');
    if (unread && !mainWindow.isFocused()) mainWindow.flashFrame(true);
  }
  updateTrayMenu(unread);
});
ipcMain.on('show-notification', (_event, { title, body, groupId } = {}) => {
  if (!Notification.isSupported()) return;
  const notification = new Notification({ title: title || 'Gchat', body: body || 'New message', icon: getIconPath(), urgency: 'normal' });
  notification.on('click', () => {
    mainWindow?.show();
    mainWindow?.focus();
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
ipcMain.handle('retry-connection', async () => { await loadHostedApp(); return true; });
ipcMain.handle('get-connection-context', () => ({ serverUrl: OFFICIAL_SERVER_URL, lastLoadError }));
ipcMain.handle('copy-binary-to-clipboard', (_event, payload = {}) => {
  try {
    const buffer = Buffer.from(typeof payload.base64 === 'string' ? payload.base64 : '', 'base64');
    if (typeof payload.mimeType === 'string' && payload.mimeType.startsWith('image/')) {
      const image = nativeImage.createFromBuffer(buffer);
      if (!image.isEmpty()) { clipboard.writeImage(image); return true; }
    }
    clipboard.writeBuffer('application/octet-stream', buffer);
    return true;
  } catch { return false; }
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

function setupAutoUpdater() {
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.on('update-downloaded', () => {
    // Restart once the verified assisted installer update is ready.
    isQuitting = true;
    autoUpdater.quitAndInstall(true, true);
  });
  autoUpdater.on('error', (error) => console.error('[updater] error:', error.message));
  if (app.isPackaged) {
    autoUpdater.checkForUpdatesAndNotify().catch(() => {});
    setInterval(() => autoUpdater.checkForUpdatesAndNotify().catch(() => {}), UPDATE_CHECK_INTERVAL_MS);
  }
}

if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on('second-instance', () => { mainWindow?.show(); mainWindow?.focus(); });
  app.whenReady().then(async () => { await createWindow(); await createTray(); setupAutoUpdater(); });
}
app.on('window-all-closed', () => { if (process.platform !== 'darwin' && isQuitting) app.quit(); });
app.on('activate', async () => { if (BrowserWindow.getAllWindows().length === 0) await createWindow(); else { mainWindow?.show(); mainWindow?.focus(); } });
app.on('before-quit', () => { isQuitting = true; });
