import { test, expect } from './fixtures';
import type { Page } from '@playwright/test';

// Going offline makes the service worker's background revalidation fetches fail and log
// network errors; those are expected here, so this file does not fail on console errors.
// Note: playwright.config.ts sets PW_EXPERIMENTAL_SERVICE_WORKER_NETWORK_EVENTS so that
// setOffline also cuts off the service worker's own fetches (otherwise they still reach the server).
test.use({ allowConsoleErrors: true });

async function waitForServiceWorkerControl(page: Page) {
  await page.evaluate(async () => {
    await navigator.serviceWorker.ready;
    if (!navigator.serviceWorker.controller) {
      await new Promise<void>(resolve =>
        navigator.serviceWorker.addEventListener('controllerchange', () => resolve(), { once: true }),
      );
    }
  });
}

async function expectAppOffline(page: Page) {
  await expect(page.getByRole('heading', { level: 1, name: 'Linux labs' })).toBeVisible();
  // A lab, which is part of the main bundle, also opens offline
  await page.getByRole('link', { name: /Manage file permissions and ownership/ }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Manage file permissions and ownership' })).toBeVisible();
}

test('the service worker cuts the network off for real in this suite', async ({ page, context }) => {
  await page.goto('#/linux');
  await waitForServiceWorkerControl(page);
  await context.setOffline(true);
  const result = await page.evaluate(() => fetch(`./offline-probe-${Date.now()}`).then(r => `status ${r.status}`, () => 'failed'));
  expect(result).toBe('failed');
});

test('after a second online visit the app loads offline', async ({ page, context }) => {
  await page.goto('#/linux');
  await waitForServiceWorkerControl(page);
  // This load goes through the service worker, which caches the hashed bundles
  await page.reload();
  await expect(page.getByRole('heading', { level: 1, name: 'Linux labs' })).toBeVisible();

  await context.setOffline(true);
  await page.reload();
  await expectAppOffline(page);
});

test('after the first visit the app loads offline', async ({ page, context }) => {
  // The build writes the hashed bundles into the worker's precache list, so one visit is enough.
  await page.goto('#/linux');
  await expect(page.getByRole('heading', { level: 1, name: 'Linux labs' })).toBeVisible();
  await waitForServiceWorkerControl(page);

  await context.setOffline(true);
  await page.reload();
  await expectAppOffline(page);
  // Lazily loaded pages that were never opened online still open (their chunks are precached)
  for (const [route, heading] of [['#/sandbox', /sandbox/i], ['#/reference', 'Command reference'], ['#/simulators', 'Simulators']] as const) {
    await page.goto(route);
    await expect(page.getByRole('heading', { level: 1, name: heading })).toBeVisible();
  }
});

test('the service worker does not cache an HTML answer for a script (SPA fallback for a gone chunk)', async ({ page, context }) => {
  await page.goto('#/linux');
  await waitForServiceWorkerControl(page);
  await context.route('**/assets/gone-chunk-*.js', route =>
    route.fulfill({ status: 200, contentType: 'text/html', body: '<!doctype html><div id="root"></div>' }),
  );
  const cached = await page.evaluate(async () => {
    const url = new URL(`./assets/gone-chunk-${Date.now()}.js`, document.baseURI).href;
    // As a module script (destination "script") and as a plain fetch
    await new Promise<void>(resolve => {
      const s = document.createElement('script');
      s.type = 'module';
      s.src = url;
      s.onload = s.onerror = () => resolve();
      document.head.append(s);
    });
    await fetch(url);
    await new Promise(r => setTimeout(r, 300));
    return !!(await caches.match(url, { ignoreVary: true }));
  });
  expect(cached).toBe(false);
});

test('activating the service worker deletes only this app scope\'s old caches, not other apps\' caches', async ({ page }) => {
  // Before the worker exists: another app's cache, this scope's cache from an older-style build
  // (it holds this scope's index.html), and an older-style cache from a sibling app at another path
  await page.addInitScript(() => {
    void (async () => {
      const index = new URL('./index.html', location.href).href;
      await (await caches.open('other-app-cache')).put(new URL('./other.txt', location.href).href, new Response('other'));
      await (await caches.open('certsim-oldbuild')).put(index, new Response('<!doctype html>', { headers: { 'Content-Type': 'text/html' } }));
      await (await caches.open('certsim-sibling')).put(new URL('/another-repo/index.html', location.href).href, new Response('sibling'));
    })();
  });
  await page.goto('#/linux');
  await waitForServiceWorkerControl(page);
  const keys = await page.evaluate(async () => {
    // Activation finishes its cleanup before it claims the page; give a just-claimed worker a moment
    await new Promise(r => setTimeout(r, 300));
    return caches.keys();
  });
  expect(keys).toContain('other-app-cache');
  expect(keys).toContain('certsim-sibling');
  expect(keys).not.toContain('certsim-oldbuild');
  // This build's own cache is named after the scope
  expect(keys.some(k => k.startsWith('certsim:') && k.includes(new URL(page.url()).origin))).toBe(true);
});

test('an old-style cache shared with a sibling app keeps the sibling\'s entries and loses only this app\'s', async ({ page }) => {
  // Same build, two apps on one origin: before cache names carried the scope, both used certsim-<build>
  await page.addInitScript(() => {
    void (async () => {
      const at = (path: string) => new URL(path, location.href).href;
      const shared = await caches.open('certsim-sharedbuild');
      await shared.put(at('./index.html'), new Response('<!doctype html>', { headers: { 'Content-Type': 'text/html' } }));
      await shared.put(at('./assets/app.js'), new Response('', { headers: { 'Content-Type': 'text/javascript' } }));
      await shared.put(at('./sibling/index.html'), new Response('<!doctype html>', { headers: { 'Content-Type': 'text/html' } }));
      await shared.put(at('./sibling/assets/app.js'), new Response('', { headers: { 'Content-Type': 'text/javascript' } }));
    })();
  });
  await page.goto('#/linux');
  await waitForServiceWorkerControl(page);
  const left = await page.evaluate(async () => {
    await new Promise(r => setTimeout(r, 300));
    if (!(await caches.keys()).includes('certsim-sharedbuild')) return null;
    const cache = await caches.open('certsim-sharedbuild');
    return (await cache.keys()).map(r => new URL(r.url).pathname).sort();
  });
  expect(left).toEqual(['/sibling/assets/app.js', '/sibling/index.html']);
});

test('the test-site build details always come from the network, never the offline cache', async ({ page, context }) => {
  // A test-site rebuild can change only test-site.json, so the build ID (and cache name) stays the same
  let main = 'aaaaaaa';
  await context.route('**/test-site.json', route =>
    route.fulfill({ json: { builtAt: '2026-01-01T00:00:00Z', main, included: [], skipped: [] } }));
  await page.goto('#/linux');
  await waitForServiceWorkerControl(page);
  const read = () => page.evaluate(() => fetch('./test-site.json', { cache: 'no-store' }).then(r => r.json()).then(b => b.main));
  expect(await read()).toBe('aaaaaaa');
  main = 'bbbbbbb';
  expect(await read()).toBe('bbbbbbb');
  // Nothing was kept for it
  expect(await page.evaluate(async () => {
    for (const name of await caches.keys()) if (await (await caches.open(name)).match('./test-site.json')) return true;
    return false;
  })).toBe(false);
});
