import type { Page } from '@playwright/test';
import { test, expect, runCommand, showTerminal } from './fixtures';

// The built app under the headers of public/_headers. `vite preview` sends them too (previewHeaders in
// vite.config.ts), so every e2e test runs under the real Content-Security-Policy; this file checks
// that the headers are there and that the main routes cause no CSP violation.

/** Records every CSP violation the page reports, from the first script on. */
async function recordViolations(page: Page): Promise<() => Promise<string[]>> {
  const fromConsole: string[] = [];
  page.on('console', msg => {
    if (/Content Security Policy/i.test(msg.text())) fromConsole.push(msg.text());
  });
  await page.addInitScript(() => {
    const w = window as unknown as { __csp: string[] };
    w.__csp = [];
    document.addEventListener('securitypolicyviolation', e => w.__csp.push(`${e.effectiveDirective} blocked ${e.blockedURI || '(inline)'}`));
  });
  return async () => [...fromConsole, ...(await page.evaluate(() => (window as unknown as { __csp: string[] }).__csp))];
}

test('the app is served with the security headers of public/_headers', async ({ page }) => {
  const res = await page.goto('./');
  const h = res!.headers();
  const csp = h['content-security-policy'];
  expect(csp).toContain("default-src 'self'");
  expect(csp).toContain("script-src 'self';");
  expect(csp).toContain("frame-ancestors 'none'");
  expect(csp).not.toContain('unsafe-inline');
  expect(h['x-content-type-options']).toBe('nosniff');
  expect(h['x-frame-options']).toBe('DENY');
  expect(h['referrer-policy']).toBe('strict-origin-when-cross-origin');
  expect(h['cross-origin-opener-policy']).toBe('same-origin');
  // No inline script is left in the page, so the policy needs no hash
  const inline = await page.evaluate(() => [...document.scripts].filter(s => !s.src && s.textContent?.trim()).length);
  expect(inline).toBe(0);
});

test.describe('signed out, sign-in offered', () => {
  test.use({ me: { user: null, providers: { github: true } } });

  test('the main routes run without a CSP violation', async ({ page }) => {
    const violations = await recordViolations(page);
    const routes: [string, RegExp][] = [
      ['#/learn', /Learning paths/],
      ['#/learn/review', /Review/],
      ['#/linux', /Linux labs/],
      ['#/linux/lpi-101-1-system-architecture', /./],
      ['#/windows', /Windows/],
      ['#/simulators', /./],
      ['#/sandbox', /./],
      ['#/sandbox/challenge', /./],
      ['#/reference', /Command reference/],
      ['#/account', /Sign in/],
      ['#/account/settings', /Settings/],
    ];
    for (const [hash, heading] of routes) {
      await page.goto(hash);
      await expect(page.getByRole('heading', { level: 1, name: heading }).first()).toBeVisible();
    }
    // A command in the terminal, and the theme switch (both touch styles at run time)
    await page.goto('#/sandbox');
    await showTerminal(page);
    await runCommand(page, 'ls -la');
    await page.goto('#/account/settings');
    await page.getByRole('group', { name: 'Theme' }).getByRole('radio', { name: /^Dark/ }).check();
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
    expect(await violations()).toEqual([]);
  });
});

test.describe('theme', () => {
  // The blocked app bundle logs an error on purpose
  test.use({ allowConsoleErrors: true });

  test('the saved theme applies before the app script runs, so there is no flash', async ({ page }) => {
    await page.addInitScript(() => localStorage.setItem('certsim:theme', 'dark'));
    // Without the app bundle, only public/theme.js can set the theme
    await page.route(/\/assets\/index-[^/]*\.js$/, route => route.abort());
    const errors: string[] = [];
    page.on('console', m => m.type() === 'error' && !m.text().includes('net::ERR_FAILED') && errors.push(m.text()));
    await page.goto('./', { waitUntil: 'domcontentloaded' });
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
    // A plain blocking script in <head>: it runs before the body is parsed and painted
    const tag = await page.evaluate(() => {
      const s = document.head.querySelector<HTMLScriptElement>('script[src$="theme.js"]');
      return s && { async: s.async, defer: s.defer, type: s.type, beforeBody: !document.body || !document.body.contains(s) };
    });
    expect(tag).toEqual({ async: false, defer: false, type: '', beforeBody: true });
    expect(errors.filter(e => /Content Security Policy/i.test(e))).toEqual([]);
  });
});
