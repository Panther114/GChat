'use strict';

const APP_CACHE = 'gchat-pwa-v12';
const APP_SHELL_ASSETS = [
  '/',
  '/index.html',
  '/chat.html',
  '/offline.html',
  '/manifest.json',
  '/pwa.js',
  '/style.css',
  '/theme-init.js',
  '/auth.js',
  '/app.js',
  '/socket.io/socket.io.js',
  '/gchat_icon.png',
  '/gchat_icon_ios.png',
  '/gchat_icon_light.png',
  '/favicon.png',
];

function isCacheableResponse(response) {
  return !!response && response.ok && (response.type === 'basic' || response.type === 'default');
}

function getGenericNotificationBody(unreadCount) {
  const safeCount = Math.max(0, Number(unreadCount) || 0);
  if (safeCount > 0) {
    return `You have ${safeCount} unread message${safeCount === 1 ? '' : 's'} in GChat.`;
  }
  return 'You have unread messages in GChat.';
}

function parsePushPayload(event) {
  if (!event.data) return {};
  try {
    const parsed = event.data.json();
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    try {
      return JSON.parse(event.data.text());
    } catch {
      return {};
    }
  }
}

async function updateWorkerAppBadge(count) {
  const safeCount = Math.max(0, Number(count) || 0);
  const badgeTarget = self.navigator || null;
  if (safeCount > 0 && typeof badgeTarget?.setAppBadge === 'function') {
    await badgeTarget.setAppBadge(safeCount).catch(() => {});
    return;
  }
  if (typeof badgeTarget?.clearAppBadge === 'function') {
    await badgeTarget.clearAppBadge().catch(() => {});
  }
}

async function broadcastToClients(message) {
  const clients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
  await Promise.all(clients.map((client) => client.postMessage(message)));
}

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(APP_CACHE)
      .then((cache) => cache.addAll(APP_SHELL_ASSETS))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(
        keys
          .filter((key) => key.startsWith('gchat-pwa-') && key !== APP_CACHE)
          .map((key) => caches.delete(key))
      ))
      .then(() => self.clients.claim())
  );
});

async function cacheResponse(cacheKey, response) {
  if (!isCacheableResponse(response)) return response;
  const cache = await caches.open(APP_CACHE);
  await cache.put(cacheKey, response.clone());
  return response;
}

async function handleNavigation(request) {
  const url = new URL(request.url);

  try {
    const response = await fetch(request);
    return await cacheResponse(url.pathname, response);
  } catch {
    const cache = await caches.open(APP_CACHE);
    return (await cache.match('/offline.html'));
  }
}

async function handleAsset(request) {
  const url = new URL(request.url);

  try {
    const response = await fetch(request);
    return await cacheResponse(url.pathname, response);
  } catch {
    const cache = await caches.open(APP_CACHE);
    const cachedResponse = await cache.match(url.pathname);
    if (cachedResponse) return cachedResponse;
    if (request.destination === 'image') {
      return (await cache.match('/gchat_icon.png')) || Response.error();
    }
    return Response.error();
  }
}

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/socket.io/')) return;
  if (url.pathname === '/service-worker.js') return;

  if (request.mode === 'navigate') {
    event.respondWith(handleNavigation(request));
    return;
  }

  event.respondWith(handleAsset(request));
});

self.addEventListener('push', (event) => {
  const payload = parsePushPayload(event);
  const totalUnreadCount = Math.max(0, Number(payload.totalUnreadCount) || 0);
  const notificationPromise = self.registration.showNotification(payload.title || 'GChat', {
    body: typeof payload.body === 'string' && payload.body ? payload.body : getGenericNotificationBody(totalUnreadCount),
    icon: '/gchat_icon_ios.png',
    badge: '/gchat_icon_ios.png',
    tag: payload.tag || 'gchat-unread',
    renotify: true,
    data: {
      url: typeof payload.url === 'string' && payload.url ? payload.url : '/chat.html',
      totalUnreadCount,
    },
  });
  event.waitUntil(Promise.all([
    notificationPromise,
    updateWorkerAppBadge(totalUnreadCount),
    broadcastToClients({ type: 'push-unread-count', totalUnreadCount }),
  ]));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const targetUrl = event.notification?.data?.url || '/chat.html';
  event.waitUntil((async () => {
    const clients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const client of clients) {
      if (!client || !('focus' in client)) continue;
      try {
        const url = new URL(client.url);
        if (url.origin === self.location.origin) {
          if ('navigate' in client && url.pathname !== targetUrl) await client.navigate(targetUrl);
          await client.focus();
          return;
        }
      } catch {
        // Ignore malformed client URLs.
      }
    }
    if (self.clients.openWindow) {
      await self.clients.openWindow(targetUrl);
    }
  })());
});

self.addEventListener('notificationclose', (event) => {
  const totalUnreadCount = Math.max(0, Number(event.notification?.data?.totalUnreadCount) || 0);
  event.waitUntil(updateWorkerAppBadge(totalUnreadCount));
});
