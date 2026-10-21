import { test, expect } from './fixtures';
import type { Page, Route } from '@playwright/test';

// After a deploy, a tab still on the previous build asks for a lazy chunk that is gone; a host's
// SPA fallback answers with index.html (status 200), which fails as a module script. The page must
// reload once to get the new build, and never go blank. The failed chunk logs errors on purpose.
test.use({ allowConsoleErrors: true, serviceWorkers: 'block' });

const CHUNK = '**/assets/CommandEncyclopedia-*.js';
const spaFallback = (route: Route) =>
  route.fulfill({ status: 200, contentType: 'text/html', body: '<!doctype html><title>Terminus CertSim</title><div id="root"></div>' });

const countLoads = (page: Page) => {
  const loads = { n: 0 };
  page.on('load', () => loads.n++);
  return loads;
};

// In-app navigation (a hash change, as the nav links do), so the old build is still the one running
const openReference = (page: Page) => page.evaluate(() => (window.location.hash = '#/reference'));

test('a lazy page whose chunk is gone reloads once and then opens', async ({ page }) => {
  let failures = 1;
  await page.route(CHUNK, route => (failures-- > 0 ? spaFallback(route) : route.continue()));
  await page.goto('#/learn');
  await expect(page.getByRole('banner')).toBeVisible();
  const loads = countLoads(page);

  await openReference(page);
  await expect(page.getByRole('heading', { level: 1, name: 'Command reference' })).toBeVisible();
  expect(loads.n).toBe(1);
});

test('when reloading does not help, the page shows a Reload button instead of going blank', async ({ page }) => {
  await page.route(CHUNK, spaFallback);
  await page.goto('#/learn');
  const loads = countLoads(page);

  await openReference(page);
  const alert = page.getByRole('alert');
  await expect(alert.getByRole('heading', { name: 'This page did not load' })).toBeVisible();
  await expect(alert.getByRole('button', { name: 'Reload' })).toBeVisible();
  // One automatic reload, then no loop; the rest of the app is still there
  expect(loads.n).toBe(1);
  await expect(page.getByRole('banner')).toBeVisible();

  // Going to another page clears the error
  await page.goto('#/linux');
  await expect(page.getByRole('heading', { level: 1, name: 'Linux labs' })).toBeVisible();
});
