// Service worker za "Изјава за фискални рачун за гориво".
//
// Strategija:
//   - Navigacija (HTML)         -> network-first, fallback na keširani shell
//   - Isti-origin statika       -> stale-while-revalidate
//   - Cross-origin              -> ne dira (samo PURS-a nema više; sve je lokalno)
//
// Bumpuj CACHE_VERSION kad se menjaju ikonice ili kad treba obrisati stari keš.
const CACHE_VERSION = 'v16';
const CACHE_NAME = `fiskalac-${CACHE_VERSION}`;

const SCOPE = new URL(self.registration.scope).pathname;

const SHELL = [
  SCOPE,
  SCOPE + 'index.html',
  SCOPE + 'app.js',
  SCOPE + 'style.css',
  SCOPE + 'manifest.json',
  SCOPE + 'vendor_js/zbar-wasm.js',
  SCOPE + 'vendor_js/zbar.wasm',
  SCOPE + 'vendor_js/jspdf.umd.min.js',
  SCOPE + 'favicon.svg',
  SCOPE + 'favicon-96x96.png',
  SCOPE + 'apple-touch-icon.png',
  SCOPE + 'web-app-manifest-192x192.png',
  SCOPE + 'web-app-manifest-512x512.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) =>
      Promise.all(SHELL.map((url) => cache.add(url).catch(() => null)))
    )
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const names = await caches.keys();
    await Promise.all(
      names.filter((n) => n.startsWith('fiskalac-') && n !== CACHE_NAME)
           .map((n) => caches.delete(n))
    );
    await self.clients.claim();
  })());
});

function isSameOrigin(request) {
  return new URL(request.url).origin === self.location.origin;
}

async function staleWhileRevalidate(request) {
  const cache = await caches.open(CACHE_NAME);
  const cached = await cache.match(request);
  const network = fetch(request)
    .then((response) => {
      if (response && (response.ok || response.type === 'opaque')) {
        cache.put(request, response.clone());
      }
      return response;
    })
    .catch(() => null);
  return cached || network || fetch(request);
}

async function networkFirst(request) {
  try {
    const response = await fetch(request);
    if (response && response.ok) {
      const cache = await caches.open(CACHE_NAME);
      cache.put(request, response.clone());
    }
    return response;
  } catch (err) {
    const cache = await caches.open(CACHE_NAME);
    const cached = await cache.match(request);
    if (cached) return cached;
    if (request.mode === 'navigate') {
      const shell = await cache.match(SCOPE + 'index.html');
      if (shell) return shell;
    }
    throw err;
  }
}

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;
  if (!isSameOrigin(request)) return;            // cross-origin (PURS proxy uklonjen) — ne diraj

  const isNavigation =
    request.mode === 'navigate' ||
    (request.headers.get('accept') || '').includes('text/html');
  if (isNavigation) {
    event.respondWith(networkFirst(request));
    return;
  }
  event.respondWith(staleWhileRevalidate(request));
});

self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'CLEAR_CACHE') {
    event.waitUntil((async () => {
      const names = await caches.keys();
      await Promise.all(
        names.filter((n) => n.startsWith('fiskalac-')).map((n) => caches.delete(n))
      );
      const cache = await caches.open(CACHE_NAME);
      await Promise.all(SHELL.map((url) => cache.add(url).catch(() => null)));
      if (event.source) event.source.postMessage({ type: 'CACHE_CLEARED' });
    })());
  }
});
