// Offline support: precache the app shell and build assets on install, then serve from cache and
// refresh in the background. Each build gets its own cache; older ones are deleted on activate.
// The build replaces these two placeholders (see precacheBuildAssets in vite.config.ts) with a
// per-build cache name and the hashed JS, CSS and font files, so one visit is enough to work offline.
const BUILD_ID = 'dev';
const BUILD_ASSETS = [];
const CACHE = `certsim-${BUILD_ID}`;
const SHELL = ['./', './index.html', './manifest.webmanifest', './icons/icon.svg', './icons/icon-192.png', './icons/icon-512.png', ...BUILD_ASSETS];

self.addEventListener('install', event => {
  event.waitUntil(caches.open(CACHE).then(cache => cache.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', event => {
  const { request } = event;
  const url = new URL(request.url);
  if (request.method !== 'GET' || url.origin !== self.location.origin) return;
  // The account API is always live: never cache or answer it from here (sign-in, "who am I")
  if (url.pathname.startsWith(new URL('./api/', self.registration.scope).pathname)) return;

  event.respondWith(
    // ignoreVary: hosts send "Vary: Origin", and module scripts carry an Origin header the precache requests lacked
    caches.match(request, { ignoreVary: true }).then(cached => {
      const network = fetch(request)
        .then(response => {
          if (response.ok) {
            const copy = response.clone();
            caches.open(CACHE).then(cache => cache.put(request, copy));
          }
          return response;
        })
        .catch(() => cached || (request.mode === 'navigate' ? caches.match('./index.html') : undefined));
      return cached || network;
    })
  );
});
