'use strict';

/**
 * Gchat Desktop — Electron Preload Script
 *
 * Exposes a narrow window.electronAPI surface to the hosted renderer.
 * Security: contextIsolation, no nodeIntegration, sandbox, explicit channels only.
 */

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  setUnreadCount(count) {
    ipcRenderer.send('set-unread-count', count);
  },

  showNotification(opts) {
    ipcRenderer.send('show-notification', opts);
  },

  onFocusGroup(callback) {
    if (typeof callback !== 'function') return;
    ipcRenderer.on('focus-group', (_event, groupId) => callback(groupId));
  },

  getLaunchAtStartup() {
    return ipcRenderer.invoke('get-launch-at-startup');
  },

  setLaunchAtStartup(enabled) {
    return ipcRenderer.invoke('set-launch-at-startup', enabled);
  },

  retryConnection() {
    return ipcRenderer.invoke('retry-connection');
  },

  getConnectionContext() {
    return ipcRenderer.invoke('get-connection-context');
  },

  copyBinaryToClipboard(payload) {
    return ipcRenderer.invoke('copy-binary-to-clipboard', payload);
  },

  clearCacheAndRestart() {
    return ipcRenderer.invoke('clear-cache-and-restart');
  },

  reloadHostedApp() {
    return ipcRenderer.invoke('reload-hosted-app');
  },

  /** Manual check; returns latest update status object. Packaged desktop only. */
  checkForUpdates() {
    return ipcRenderer.invoke('check-for-updates');
  },

  getUpdateStatus() {
    return ipcRenderer.invoke('get-update-status');
  },

  installUpdate() {
    return ipcRenderer.invoke('install-update');
  },

  openLatestRelease() {
    return ipcRenderer.invoke('open-latest-release');
  },

  onUpdateStatus(callback) {
    if (typeof callback !== 'function') return () => {};
    const handler = (_event, status) => callback(status);
    ipcRenderer.on('update-status', handler);
    return () => {
      ipcRenderer.removeListener('update-status', handler);
    };
  },
});
