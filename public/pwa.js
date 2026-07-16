'use strict';

(() => {
  if (!('serviceWorker' in navigator)) return;

  let refreshingForUpdate = false;

  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (refreshingForUpdate) return;
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
