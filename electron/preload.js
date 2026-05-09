'use strict';

/**
 * Gchat Desktop — Electron Preload Script
 *
 * This script runs in a privileged context before the renderer page loads.
 * It uses contextBridge to expose a narrow, safe API surface (electronAPI)
 * to the renderer WITHOUT enabling full Node.js access.
 *
 * Security model:
 *  - contextIsolation: true  — renderer JS cannot access Node / Electron APIs
 *  - nodeIntegration: false  — no require() in renderer
 *  - sandbox: true           — renderer is fully sandboxed
 *  - Only explicitly listed channels are allowed through ipcRenderer
 */

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  /**
   * Notify the main process of the current unread message count.
   * Main process updates the taskbar overlay badge and tray menu.
   * @param {number} count
   */
  setUnreadCount(count) {
    ipcRenderer.send('set-unread-count', count);
  },

  /**
   * Ask the main process to show a native OS notification.
   * Used when the window is hidden or not focused.
   * @param {{ title: string, body: string, groupId?: string }} opts
   */
  showNotification(opts) {
    ipcRenderer.send('show-notification', opts);
  },

  /**
   * Called by the renderer when a specific group should be focused
   * (e.g. after clicking a notification). The main process sends
   * 'focus-group' back, which the renderer listens for.
   * @param {function(groupId: string): void} callback
   */
  onFocusGroup(callback) {
    ipcRenderer.on('focus-group', (_event, groupId) => callback(groupId));
  },

  /**
   * Returns whether the app was launched at startup.
   * @returns {Promise<boolean>}
   */
  getLaunchAtStartup() {
    return ipcRenderer.invoke('get-launch-at-startup');
  },

  /**
   * Enable or disable launch at system startup.
   * @param {boolean} enabled
   * @returns {Promise<boolean>} the new state
   */
  setLaunchAtStartup(enabled) {
    return ipcRenderer.invoke('set-launch-at-startup', enabled);
  },

  /**
   * Read the desktop bootstrap state used by the local onboarding pages.
   * @returns {Promise<{serverUrl: string, launchAtStartup: boolean, onboardingCompleted: boolean}>}
   */
  getDesktopBootstrap() {
    return ipcRenderer.invoke('get-desktop-bootstrap');
  },

  /**
   * Check that the locked Railway deployment is reachable.
   * @returns {Promise<{ok: boolean, status?: number, url: string, error?: string, checkedAt: string}>}
   */
  checkServerConnectivity() {
    return ipcRenderer.invoke('check-server-connectivity');
  },

  /**
   * Persist onboarding choices and launch the hosted app.
   * @param {{ launchAtStartup?: boolean }} payload
   * @returns {Promise<{success: boolean}>}
   */
  completeOnboarding(payload) {
    return ipcRenderer.invoke('complete-onboarding', payload);
  },

  /**
   * Retry connecting to the hosted app after a failed startup load.
   * @returns {Promise<boolean>}
   */
  retryConnection() {
    return ipcRenderer.invoke('retry-connection');
  },

  /**
   * Returns the latest startup connection failure context for the offline page.
   * @returns {Promise<{serverUrl: string, lastLoadError: object|null}>}
   */
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
});
