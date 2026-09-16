// Service worker : cache applicatif pour le fonctionnement hors-ligne.
// Stratégie : app-shell en cache-first, mise à jour en arrière-plan.
// Ne jamais cacher /_next/ ni /api/ (sinon le hot reload / les mises à jour cassent).
const CACHE = 'tfhb-caisse-next-v2';
const ASSETS = [
  '/',
  '/manifest.webmanifest',
  '/icons/icon.svg',
  '/icons/logo.png',
  '/icons/logo-white.png',
  '/fonts/oswald-500.woff2',
  '/fonts/oswald-600.woff2',
  '/fonts/oswald-700.woff2',
];

function shouldBypassCache(url) {
  return (
    url.pathname.startsWith('/_next/') ||
    url.pathname.startsWith('/api/') ||
    url.pathname.includes('hot-update') ||
    url.search.includes('t=') // cache-bust Next
  );
}

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(ASSETS)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});
self.addEventListener('fetch', (e) => {
  const { request } = e;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (shouldBypassCache(url)) return;

  e.respondWith(
    caches.match(request).then((cached) => {
      const network = fetch(request).then((res) => {
        if (res && res.status === 200 && res.type === 'basic') {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(request, copy));
        }
        return res;
      }).catch(() => cached);
      // Shell : cache-first. Assets Next exclus via shouldBypassCache.
      return cached || network;
    })
  );
});
