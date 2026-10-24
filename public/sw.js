// Offline support: precache the app shell and build assets on install, then serve from cache and
// refresh in the background. Each build gets its own cache; older ones are deleted on activate.
//
// Updates: a new worker does not skipWaiting. It waits until no tab uses the old worker, so a tab
// that is still running the previous build keeps that build's cache and can still load its lazy
// chunks after a deploy (they are gone from the server). The old worker serves the new build's
// files meanwhile (caches.match looks in every cache), and its background refresh fetches the new
// index.html, so a reload still picks up a deploy. Old caches are deleted only on activate, when
// no tab is left on the old build. A first install has nothing to wait for and claims the page.
//
// CacheStorage is shared by every app on the origin (on GitHub Pages, every repository of the user),
// so cache names carry this worker's scope, and activate deletes only this scope's older caches.
// The build replaces these two placeholders (see precacheBuildAssets in vite.config.ts) with a
// per-build cache name and the hashed JS, CSS and font files, so one visit is enough to work offline.
const BUILD_ID = 'dev';
const BUILD_ASSETS = [];
const PREFIX = `certsim:${self.registration.scope}:`;
const CACHE = PREFIX + BUILD_ID;
const SHELL = ['./', './index.html', './manifest.webmanifest', './icons/icon.svg', './icons/icon-180.png', './icons/icon-192.png', './icons/icon-512.png', './icons/icon-512-maskable.png', ...BUILD_ASSETS];

self.addEventListener('install', event => {
  event.waitUntil(caches.open(CACHE).then(cache => cache.addAll(SHELL)));
});

// True when the response is what the request asked for. A host's SPA fallback answers a missing
// file (an old build's chunk after a deploy) with index.html and status 200; caching that under a
// .js URL would break the page for good, so only matching content types are cached or served.
function fits(request, response) {
  if (!response || !response.ok) return false;
  const type = (response.headers.get('Content-Type') || '').toLowerCase();
  const html = type.includes('text/html');
  switch (request.destination) {
    case 'document':
    case 'iframe':
      return html;
    case 'script':
    case 'worker':
    case 'sharedworker':
      return type.includes('javascript');
    case 'style':
      return type.includes('text/css');
    case 'image':
      return type.startsWith('image/');
    case 'font':
    case 'manifest':
      return !html;
    default: {
      // fetch() and the precache: HTML only for page URLs
      const path = new URL(request.url).pathname;
      return !html || path.endsWith('/') || path.endsWith('.html');
    }
  }
}

// Caches from builds before names carried the scope were called certsim-<build>, and two apps on the
// same origin with the same build shared one. Only entries that are this app's are removed: URLs under
// this scope that are not under another app's root (a deeper folder with its own index.html in the
// same cache). The cache itself goes only once nothing is left in it, so a sibling's copy survives.
async function cleanLegacyCache(key) {
  const cache = await caches.open(key);
  const requests = await cache.keys();
  const scope = self.registration.scope;
  const roots = requests
    .map(r => r.url)
    .filter(u => u.endsWith('/index.html'))
    .map(u => u.slice(0, -'index.html'.length))
    .filter(root => root !== scope && root.startsWith(scope));
  const mine = requests.filter(r => r.url.startsWith(scope) && !roots.some(root => r.url.startsWith(root)));
  // Not this scope's cache at all (no index.html of ours): leave it as it is
  if (!mine.some(r => r.url === `${scope}index.html` || r.url === scope)) return;
  await Promise.all(mine.map(r => cache.delete(r)));
  if ((await cache.keys()).length === 0) await caches.delete(key);
}

async function deleteOldCaches() {
  for (const key of await caches.keys()) {
    if (key === CACHE) continue;
    if (key.startsWith(PREFIX)) await caches.delete(key);
    else if (/^certsim-[^:]+$/.test(key)) await cleanLegacyCache(key);
  }
}

self.addEventListener('activate', event => {
  event.waitUntil(deleteOldCaches().then(() => self.clients.claim()));
});

self.addEventListener('fetch', event => {
  const { request } = event;
  const url = new URL(request.url);
  if (request.method !== 'GET' || url.origin !== self.location.origin) return;
  // The account API is always live: never cache or answer it from here (sign-in, "who am I")
  if (url.pathname.startsWith(new URL('./api/', self.registration.scope).pathname)) return;
  // The test site's build details change without a new build ID, so they always come from the network
  if (url.pathname === new URL('./test-site.json', self.registration.scope).pathname) return;

  event.respondWith(
    // ignoreVary: hosts send "Vary: Origin", and module scripts carry an Origin header the precache requests lacked
    caches.match(request, { ignoreVary: true }).then(match => {
      // An entry of the wrong type (cached by an older worker) is ignored and replaced
      const cached = match && fits(request, match) ? match : undefined;
      const network = fetch(request)
        .then(response => {
          if (fits(request, response)) {
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
