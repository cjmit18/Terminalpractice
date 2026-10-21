import { test, expect } from './fixtures';

// Going offline makes the background revalidation fetches in the service worker fail;
// those network errors are expected here, so this file does not fail on console errors.
test.use({ allowConsoleErrors: true });

test('after the first visit the app loads offline', async ({ page, context }) => {
  await page.goto('#/linux');
  await expect(page.getByRole('heading', { level: 1, name: 'Linux labs' })).toBeVisible();

  // Wait until the service worker is active and controls this page
  await page.evaluate(async () => {
    const reg = await navigator.serviceWorker.ready;
    if (!navigator.serviceWorker.controller) {
      await new Promise<void>(resolve => navigator.serviceWorker.addEventListener('controllerchange', () => resolve(), { once: true }));
    }
    return reg.active?.state;
  });

  await context.setOffline(true);
  await page.reload();
  await expect(page.getByRole('heading', { level: 1, name: 'Linux labs' })).toBeVisible();
  await expect(page.getByRole('link', { name: /Manage file permissions and ownership/ })).toBeVisible();

  // A lab, which is part of the main bundle, also opens offline
  await page.getByRole('link', { name: /Manage file permissions and ownership/ }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Manage file permissions and ownership' })).toBeVisible();
});
