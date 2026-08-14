'use strict';

(() => {
  if (!('serviceWorker' in navigator)) return;

  let reloadRequested = false;
  let activeRegistration = null;

  function announceUpdate(registration) {
    activeRegistration = registration;
    window.dispatchEvent(new CustomEvent('gchat:update-available'));
  }

  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (!reloadRequested) return;
    reloadRequested = false;
    window.location.reload();
  });

  window.addEventListener('gchat:apply-update', async () => {
    const registration = activeRegistration || await navigator.serviceWorker.getRegistration('/');
    if (!registration?.waiting) return;
    reloadRequested = true;
    registration.waiting.postMessage({ type: 'SKIP_WAITING' });
  });

  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/service-worker.js', {
      scope: '/',
      updateViaCache: 'none',
    }).then((registration) => {
      activeRegistration = registration;
      if (registration.waiting) announceUpdate(registration);
      registration.addEventListener('updatefound', () => {
        const worker = registration.installing;
        if (!worker) return;
        worker.addEventListener('statechange', () => {
          if (worker.state === 'installed' && navigator.serviceWorker.controller) {
            announceUpdate(registration);
          }
        });
      });
      void registration.update().catch(() => {});
    }).catch(() => {});
  });
})();
