import type { Page, Route } from '@playwright/test';
import { test, expect } from './fixtures';

// Confirming it is you before sensitive changes (SEC-3), link and sign-in-again errors on return
// (SEC-15), and verify links that never sign the browser in. Against a stubbed API, as in portal.spec.ts.

type Reply = { status?: number; json?: unknown };
type Handler = (body: Record<string, unknown> | null) => Reply;
interface Call {
  key: string;
  body: Record<string, unknown> | null;
}

const ADA = { id: 'u1', name: 'Ada', login: null, email: 'ada@example.com', emailVerified: true };
const OCTO = { id: 'u2', name: 'Octo', login: 'octo', email: null, emailVerified: false };
const ALL_PROVIDERS = { google: true, github: true, email: true };
const GH = { provider: 'github', label: 'ada-gh', linkedAt: 1760000000000 };

async function stubApi(page: Page, me: { user: unknown }, handlers: Record<string, Handler> = {}): Promise<Call[]> {
  const calls: Call[] = [];
  await page.route('**/api/**', async (route: Route) => {
    const req = route.request();
    const path = new URL(req.url()).pathname.replace(/^.*\/api\//, '');
    const key = `${req.method()} ${path}`;
    let body: Record<string, unknown> | null = null;
    try {
      body = req.postDataJSON();
    } catch {
      body = null;
    }
    calls.push({ key, body });
    if (key === 'GET me') return route.fulfill({ json: { ...me, providers: ALL_PROVIDERS, emailSending: true } });
    if (key === 'GET progress' || key === 'PUT progress') return route.fulfill({ json: { items: [], epochs: {}, settings: {} } });
    const h = handlers[key];
    if (!h) return route.fulfill({ status: 404, json: { error: 'not_found', message: 'Not found' } });
    const r = h(body);
    if (r.json === undefined) return route.fulfill({ status: r.status ?? 204, body: '' });
    return route.fulfill({ status: r.status ?? 200, json: r.json });
  });
  return calls;
}

const region = (page: Page, name: string) => page.getByRole('region', { name });
const REAUTH = { status: 403, json: { error: 'reauth_required', message: 'Sign in again.', providers: ['github'] } };

test.describe('confirming it is you', () => {
  test.use({ allowConsoleErrors: true });

  test('with a password, every sensitive form asks for it and sends currentPassword', async ({ page }) => {
    const calls = await stubApi(page, { user: ADA }, {
      'GET account': () => ({ json: { user: ADA, identities: [GH], hasPassword: true, emailVerified: true } }),
      'POST account/email': () => ({ status: 202 }),
      'POST account/password': () => ({ json: { ok: true } }),
      'DELETE account/identities/github': () => ({ status: 204 }),
      'POST account/reauth': b => (b?.currentPassword === 'right password' ? { json: { ok: true } } : { status: 403, json: { error: 'wrong_password' } }),
      'GET auth/google/start': () => ({ json: { ok: true } }),
    });
    await page.goto('#/account/security');
    for (const name of ['Change password', 'Change email', 'Ways to sign in', 'Delete account']) {
      await expect(region(page, name).getByLabel('Current password', { exact: true })).toBeVisible();
    }

    // Email: NFC-normalized and trimmed, with the current password
    const email = region(page, 'Change email');
    await email.getByLabel('New email').fill('  café@example.com ');
    await email.getByRole('button', { name: 'Change email' }).click();
    await expect(email.getByLabel('Current password', { exact: true })).toBeFocused();
    await email.getByLabel('Current password', { exact: true }).fill('right password');
    await email.getByRole('button', { name: 'Change email' }).click();
    await expect(email.getByText('We sent a link to café@example.com.', { exact: false })).toBeVisible();
    expect(calls.find(c => c.key === 'POST account/email')?.body).toEqual({ email: 'café@example.com', currentPassword: 'right password' });

    // Unlink: the password goes with it
    const methods = region(page, 'Ways to sign in');
    const methodsPw = methods.getByLabel('Current password', { exact: true });
    await methods.getByRole('button', { name: 'Unlink GitHub' }).click();
    await expect(methodsPw).toBeFocused();
    expect(calls.some(c => c.key === 'DELETE account/identities/github')).toBe(false);
    await methodsPw.fill('right password');
    await methods.getByRole('button', { name: 'Unlink GitHub' }).click();
    await expect(methods.getByText('GitHub is no longer linked.')).toBeVisible();
    expect(calls.find(c => c.key === 'DELETE account/identities/github')?.body).toEqual({ currentPassword: 'right password' });

    // Link: a wrong password stays here; the right one is confirmed first, then off to Google
    await methodsPw.fill('wrong password');
    await methods.getByRole('button', { name: 'Link Google' }).click();
    await expect(methodsPw).toHaveAccessibleDescription('Your current password is not right. Check it and try again.');
    expect(calls.some(c => c.key === 'GET auth/google/start')).toBe(false);
    await methodsPw.fill('right password');
    const start = page.waitForRequest(r => r.url().includes('/api/auth/google/start'));
    await methods.getByRole('button', { name: 'Link Google' }).click();
    const url = new URL((await start).url());
    expect(url.searchParams.get('link')).toBe('1');
    expect(url.searchParams.get('return')).toBe('#/account/security');
    await expect.poll(() => calls.some(c => c.key === 'GET auth/google/start')).toBe(true);
    const keys = calls.map(c => c.key);
    expect(keys.lastIndexOf('POST account/reauth')).toBeLessThan(keys.indexOf('GET auth/google/start'));
    expect(calls.filter(c => c.key === 'POST account/reauth').at(-1)?.body).toEqual({ currentPassword: 'right password' });
  });

  test('without a password there is no password field, and reauth_required offers to sign in again', async ({ page }) => {
    const calls = await stubApi(page, { user: OCTO }, {
      'GET account': () => ({ json: { user: OCTO, identities: [{ ...GH, label: 'octo' }], hasPassword: false, emailVerified: false } }),
      'POST account/email': () => REAUTH,
      'DELETE account': () => REAUTH,
    });
    await page.goto('#/account/security');
    await expect(page.getByRole('heading', { name: 'Add an email' })).toBeVisible();
    await expect(page.getByLabel('Current password', { exact: true })).toHaveCount(0);
    // No email on the account: linking is open, as a plain link
    await expect(page.getByRole('link', { name: 'Link Google' })).toBeVisible();

    const email = region(page, 'Add an email');
    await email.getByLabel('Email', { exact: true }).fill('octo@example.com');
    await email.getByRole('button', { name: 'Add email' }).click();
    const notice = email.getByTestId('reauth');
    await expect(notice).toBeFocused();
    await expect(notice).toContainText('For your security, sign in again to continue');
    const again = notice.getByRole('link', { name: 'Sign in again with GitHub' });
    const href = new URL((await again.getAttribute('href'))!);
    expect(href.pathname).toBe('/api/auth/github/start');
    expect(href.searchParams.get('reauth')).toBe('1');
    expect(href.searchParams.get('return')).toBe('#/account/security');
    await expect(notice.getByRole('link', { name: /Google/ })).toHaveCount(0);

    const del = region(page, 'Delete account');
    await del.getByLabel('Type delete to confirm').fill('delete');
    await del.getByRole('button', { name: 'Delete my account' }).click();
    await expect(del.getByTestId('reauth').getByRole('link', { name: 'Sign in again with GitHub' })).toBeVisible();
    expect(calls.find(c => c.key === 'DELETE account')?.body).toEqual({ confirm: 'delete' });
    // Still signed in: nothing was deleted
    await expect(page.getByRole('button', { name: 'Account: Octo' })).toBeVisible();
  });

  test('with an unconfirmed email, linking waits until it is confirmed', async ({ page }) => {
    const unverified = { ...ADA, emailVerified: false };
    await stubApi(page, { user: unverified }, {
      'GET account': () => ({ json: { user: unverified, identities: [{ provider: 'email', label: ADA.email, linkedAt: 1 }], hasPassword: true, emailVerified: false } }),
    });
    await page.goto('#/account/security');
    for (const name of ['Link Google', 'Link GitHub']) {
      const b = page.getByRole('button', { name });
      await expect(b).toBeDisabled();
      await expect(b).toHaveAccessibleDescription('Verify your email first, then you can link Google or GitHub.');
    }
  });
});

test.describe('errors on return from Google or GitHub', () => {
  test.use({ allowConsoleErrors: true });

  const cases: [string, RegExp][] = [
    ['identity_in_use', /already linked to a different account/],
    ['provider_already_linked', /Unlink it first/],
    ['not_signed_in', /Sign in, then try again/],
    ['reauth_failed', /could not confirm it was you/],
    ['email_unverified', /Verify your email first/],
  ];

  test('each code shows a plain message once, and leaves the URL', async ({ page }) => {
    await stubApi(page, { user: ADA }, {
      'GET account': () => ({ json: { user: ADA, identities: [GH], hasPassword: true, emailVerified: true } }),
    });
    for (const [code, message] of cases) {
      for (const hash of ['#/account/security', '#/account']) {
        await page.goto(`${hash}?error=${code}`);
        await expect(page.getByTestId('return-error')).toHaveText(message);
        await expect(page).toHaveURL(new RegExp(`${hash}$`));
      }
    }
    // Once gone from the URL, a reload does not show it again
    await page.reload();
    await expect(page.getByRole('heading', { level: 1, name: 'Hello, Ada' })).toBeVisible();
    await expect(page.getByTestId('return-error')).toHaveCount(0);
  });

  test('signed out, not_signed_in is explained above the sign-in card', async ({ page }) => {
    await stubApi(page, { user: null });
    await page.goto('#/account?error=not_signed_in');
    await expect(page.getByTestId('return-error')).toHaveText(/You were signed out before that finished/);
    await expect(page.getByRole('heading', { level: 1, name: 'Sign in' })).toBeVisible();
    await expect(page).toHaveURL(/#\/account$/);
  });
});

test.describe('verify link', () => {
  test.use({ allowConsoleErrors: true });

  test('confirming an email does not sign this browser in', async ({ page }) => {
    const calls = await stubApi(page, { user: null }, {
      // The server answers with the account's user, but sets no session cookie
      'POST auth/email/verify': () => ({ json: { user: ADA } }),
    });
    await page.goto('#/account/verify?token=ver-1');
    await expect(page.getByText('Your email is confirmed.', { exact: false })).toBeVisible();
    await expect(page).toHaveURL(/#\/account\/verify$/);
    // Asked the server who is signed in after verifying, and stayed signed out
    const keys = calls.map(c => c.key);
    expect(keys.lastIndexOf('GET me')).toBeGreaterThan(keys.indexOf('POST auth/email/verify'));
    await expect(page.getByRole('banner').getByRole('link', { name: 'Sign in', exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Account: Ada' })).toHaveCount(0);
    await page.getByRole('link', { name: 'Go to your account' }).click();
    await expect(page.getByRole('heading', { level: 1, name: 'Sign in' })).toBeVisible();
  });
});
