'use strict';

(() => {
  if (!('serviceWorker' in navigator)) return;

  let refreshingForUpdate = false;
  const SW_RELOAD_GUARD_KEY = 'gchat-sw-reload-guard-ts';
  const SW_RELOAD_GUARD_WINDOW_MS = 60 * 1000;

  function isDesktopShell() {
    return typeof window !== 'undefined' && !!window.electronAPI;
  }

  function shouldReloadForControllerChange() {
    // v1.3.9: never force-reload inside the desktop shell or while the app is
    // hidden/backgrounded — a silent full reload there is what made the app
    // "refresh and reload all chat history" in the background. The in-app
    // update banner offers a user-confirmed reload instead.
    if (isDesktopShell()) return false;
    if (document.hidden) return false;
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
