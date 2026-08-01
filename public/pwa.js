'use strict';

(() => {
  if (!('serviceWorker' in navigator)) return;

  let refreshingForUpdate = false;
  const SW_RELOAD_GUARD_KEY = 'gchat-sw-reload-guard-ts';
  const SW_RELOAD_GUARD_WINDOW_MS = 60 * 1000;

  function shouldReloadForControllerChange() {
    const now = Date.now();
    try {
      const lastReloadAt = Number(sessionStorage.getItem(SW_RELOAD_GUARD_KEY)) || 0;
      if (lastReloadAt > 0 && (now - lastReloadAt) < SW_RELOAD_GUARD_WINDOW_MS) return false;
      sessionStorage.setItem(SW_RELOAD_GUARD_KEY, String(now));
    } catch {
      // best effort only
    }
    return true;
  }

  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (refreshingForUpdate) return;
    if (!shouldReloadForControllerChange()) return;
    refreshingForUpdate = true;
    window.location.reload();
  });

  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/service-worker.js', {
      scope: '/',
      updateViaCache: 'none',
    }).then((registration) => {
      void registration.update().catch(() => {});
    }).catch(() => {});
  });
})();
