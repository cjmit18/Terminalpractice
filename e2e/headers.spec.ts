import { test, expect, runCommand, showTerminal } from './fixtures';

// public/_headers gives every static file its security headers on Cloudflare; vite preview (where these
// tests run) sends the same ones (vite.config.ts staticHeaders), so every test runs under the real CSP.

test('pages are served with the Content-Security-Policy and the other security headers', async ({ page }) => {
  const res = await page.goto('#/learn');
  const headers = res!.headers();
  expect(headers['content-security-policy']).toContain("script-src 'self'");
  expect(headers['content-security-policy']).toContain("frame-ancestors 'none'");
  expect(headers['x-content-type-options']).toBe('nosniff');
  expect(headers['x-frame-options']).toBe('DENY');
  expect(headers['referrer-policy']).toBe('strict-origin-when-cross-origin');
});

test('the app breaks no rule of the policy: theme, a lab and its terminal', async ({ page }) => {
  await page.addInitScript(() => {
    (window as unknown as { cspViolations: string[] }).cspViolations = [];
    document.addEventListener('securitypolicyviolation', e =>
      (window as unknown as { cspViolations: string[] }).cspViolations.push(`${e.violatedDirective} ${e.blockedURI}`),
    );
    localStorage.setItem('certsim:theme', 'dark');
  });
  await page.goto('#/linux/lpi-101-1-system-architecture');
  // The theme script (a file, not inline) still runs before the app
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await showTerminal(page);
  await runCommand(page, 'lspci');
  await page.goto('#/reference');
  await page.goto('#/account');
  expect(await page.evaluate(() => (window as unknown as { cspViolations: string[] }).cspViolations)).toEqual([]);
});
