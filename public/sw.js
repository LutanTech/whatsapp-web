const CACHE_PREFIX = 'wa-bot-pwa-';
const CACHE_VERSION = 'v1';
const SHELL_CACHE = `${CACHE_PREFIX}shell-${CACHE_VERSION}`;
const ASSET_CACHE = `${CACHE_PREFIX}assets-${CACHE_VERSION}`;
const OFFLINE_URL = '/offline.html';
const MAX_CACHED_ASSETS = 80;

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(SHELL_CACHE)
      .then((cache) => cache.add(OFFLINE_URL))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const names = await caches.keys();
    await Promise.all(names
      .filter((name) => name.startsWith(CACHE_PREFIX) && ![SHELL_CACHE, ASSET_CACHE].includes(name))
      .map((name) => caches.delete(name)));
    await self.clients.claim();
  })());
});

function isCacheableStaticAsset(url) {
  if (url.origin !== self.location.origin) return false;
  if (/\/(api|auth|socket\.io)(\/|$)/i.test(url.pathname)) return false;
  return /\.(?:js|mjs|css|png|jpe?g|webp|gif|svg|ico|woff2?|ttf|otf)$/i.test(url.pathname);
}

async function trimAssetCache(cache) {
  const keys = await cache.keys();
  if (keys.length > MAX_CACHED_ASSETS) {
    await Promise.all(keys.slice(0, keys.length - MAX_CACHED_ASSETS).map((key) => cache.delete(key)));
  }
}

self.addEventListener('fetch', (event) => {
  const request = event.request;
  const url = new URL(request.url);

  if (request.method !== 'GET' || url.origin !== self.location.origin) return;

  // Admin pages are network-only: never persist potentially private console HTML.
  if (request.mode === 'navigate') {
    event.respondWith((async () => {
      try {
        return await fetch(request);
      } catch {
        return (await caches.match(OFFLINE_URL)) || Response.error();
      }
    })());
    return;
  }

  // Leave APIs, authentication, Socket.IO and all non-static requests to the app.
  if (!isCacheableStaticAsset(url)) return;

  event.respondWith((async () => {
    const cache = await caches.open(ASSET_CACHE);
    try {
      const response = await fetch(request);
      const cacheControl = response.headers.get('Cache-Control') || '';
      if (response.ok && !/no-store|private/i.test(cacheControl)) {
        await cache.put(request, response.clone());
        await trimAssetCache(cache);
      }
      return response;
    } catch {
      return (await cache.match(request)) || Response.error();
    }
  })());
});
