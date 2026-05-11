'use strict';

const APP_CACHE = 'gchat-pwa-v1';
const APP_SHELL_ASSETS = [
  '/',
  '/index.html',
  '/chat.html',
  '/offline.html',
  '/manifest.json',
  '/style.css',
  '/theme-init.js',
  '/auth.js',
  '/app.js',
  '/gchat_icon.png',
  '/favicon.svg',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
  '/icons/icon-512-maskable.png',
];

function isCacheableResponse(response) {
  return !!response && response.ok && (response.type === 'basic' || response.type === 'default');
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
    return (await cache.match(url.pathname))
      || (await cache.match('/offline.html'));
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
      return (await cache.match('/icons/icon-192.png')) || Response.error();
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
