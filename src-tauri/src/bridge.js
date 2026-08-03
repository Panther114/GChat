(() => {
  'use strict';

  const invoke = (command, args = {}) => window.__TAURI_INTERNALS__.invoke(command, args);
  const report = (label, error) => console.error(`[desktop:${label}]`, error);

  const updateListeners = new Set();

  function notifyUpdateStatus(status) {
    updateListeners.forEach((callback) => {
      try {
        callback(status);
      } catch (error) {
        report('update-status-listener', error);
      }
    });
  }

  window.__gchatDesktopUpdateStatus = notifyUpdateStatus;
  window.addEventListener('gchat-update-status', (event) => {
    notifyUpdateStatus(event.detail);
  });

  Object.defineProperty(window, 'electronAPI', {
    configurable: false,
    enumerable: false,
    writable: false,
    value: Object.freeze({
      setUnreadCount(count) {
        void invoke('set_unread_count', { count }).catch((error) => report('unread', error));
      },
      showNotification(options) {
        void invoke('show_notification', { payload: options || {} }).catch((error) => report('notification', error));
      },
      onFocusGroup(callback) {
        if (typeof callback !== 'function') return;
        window.__gchatDesktopFocusGroup = callback;
      },
      getLaunchAtStartup() {
        return invoke('get_launch_at_startup');
      },
      setLaunchAtStartup(enabled) {
        return invoke('set_launch_at_startup', { enabled: !!enabled });
      },
      retryConnection() {
        return invoke('retry_connection');
      },
      getConnectionContext() {
        return invoke('get_connection_context');
      },
      copyBinaryToClipboard(payload) {
        return invoke('copy_binary_to_clipboard', { payload: payload || {} });
      },
      clearCacheAndRestart() {
        return invoke('clear_cache_and_restart');
      },
      reloadHostedApp() {
        return invoke('reload_hosted_app');
      },
      checkForUpdates() {
        return invoke('check_for_updates_cmd');
      },
      getUpdateStatus() {
        return invoke('get_update_status');
      },
      installUpdate() {
        return invoke('install_update');
      },
      openLatestRelease() {
        return invoke('open_latest_release');
      },
      onUpdateStatus(callback) {
        if (typeof callback !== 'function') return () => {};
        updateListeners.add(callback);
        return () => {
          updateListeners.delete(callback);
        };
      },
    }),
  });

  // Official hosted origin, or any https origin in case of future custom domain aliases.
  const isHostedApp =
    window.location.protocol === 'https:'
    && (
      window.location.hostname === 'gchat.up.railway.app'
      || window.location.origin === 'https://gchat.up.railway.app'
    );

  if (isHostedApp) {
    const ready = () => {
      void invoke('desktop_renderer_ready').catch((error) => report('ready', error));
    };
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', ready, { once: true });
    } else {
      ready();
    }
    // Retry once after load in case the first invoke raced ahead of ACL wiring.
    window.addEventListener('load', ready, { once: true });
  }
})();

