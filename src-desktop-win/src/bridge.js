(() => {
  'use strict';

  const post = (type, payload) => {
    try {
      window.ipc.postMessage(JSON.stringify({ type, payload: payload || null }));
    } catch (error) {
      console.error('[desktop:' + type + ']', error);
    }
  };

  const requestId = (() => {
    let n = 1;
    return () => {
      n += 1;
      return String(n);
    };
  })();

  const pending = new Map();

  window.__gchatDesktopResolve = (id, value, error) => {
    const entry = pending.get(String(id));
    if (!entry) return;
    pending.delete(String(id));
    if (error) entry.reject(new Error(error));
    else entry.resolve(value);
  };

  const invoke = (type, payload, timeoutMs = 30000) => new Promise((resolve, reject) => {
    const id = requestId();
    pending.set(id, { resolve, reject });
    post(type, { ...(payload || {}), __requestId: id });
    setTimeout(() => {
      if (!pending.has(id)) return;
      pending.delete(id);
      reject(new Error('Desktop bridge timeout: ' + type));
    }, timeoutMs);
  });

  const updateListeners = new Set();
  window.__gchatDesktopUpdateStatus = (status) => {
    updateListeners.forEach((cb) => {
      try { cb(status); } catch (e) { console.error(e); }
    });
  };

  Object.defineProperty(window, 'electronAPI', {
    configurable: false,
    enumerable: false,
    writable: false,
    value: Object.freeze({
      setUnreadCount(count) {
        post('set-unread-count', { count });
      },
      showNotification(options) {
        post('show-notification', options || {});
      },
      onFocusGroup(callback) {
        if (typeof callback !== 'function') return;
        window.__gchatDesktopFocusGroup = callback;
      },
      getLaunchAtStartup() {
        return invoke('get-launch-at-startup');
      },
      setLaunchAtStartup(enabled) {
        return invoke('set-launch-at-startup', { enabled: !!enabled });
      },
      retryConnection() {
        return invoke('retry-connection');
      },
      getConnectionContext() {
        return invoke('get-connection-context');
      },
      copyBinaryToClipboard(payload) {
        return invoke('copy-binary-to-clipboard', payload || {});
      },
      clearCacheAndRestart() {
        return invoke('clear-cache-and-restart');
      },
      reloadHostedApp() {
        return invoke('reload-hosted-app');
      },
      checkForUpdates() {
        // v1.3.10: update checks/downloads can legitimately take minutes —
        // don't let the 30s bridge timeout report them as broken.
        return invoke('check-for-updates', null, 180000);
      },
      getUpdateStatus() {
        return invoke('get-update-status');
      },
      installUpdate() {
        return invoke('install-update', null, 180000);
      },
      openLatestRelease() {
        return invoke('open-latest-release');
      },
      onUpdateStatus(callback) {
        if (typeof callback !== 'function') return () => {};
        updateListeners.add(callback);
        return () => updateListeners.delete(callback);
      },
    }),
  });

  const isHosted =
    window.location.protocol === 'https:'
    && (
      window.location.hostname === 'gchat.up.railway.app'
      || window.location.origin === 'https://gchat.up.railway.app'
    );

  if (isHosted) {
    const ready = () => post('desktop-renderer-ready');
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', ready, { once: true });
    } else {
      ready();
    }
    window.addEventListener('load', ready, { once: true });
  }
})();
