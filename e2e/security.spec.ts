import { test, expect } from './fixtures';
import type { BrowserContext } from '@playwright/test';

// #/account/security (portal part 7). The preview server has no Worker behind it, so the account API is
// stubbed here with a small in-memory server.

const USER = { id: 'u1', name: 'Casey', login: null as string | null, email: 'casey@example.com' as string | null, emailVerified: true, avatarUrl: null };
const GITHUB_USER = { ...USER, login: 'octo', email: null };
const DAY = 86_400_000;

interface Stub {
  sessions: { id: string; createdAt: number; expiresAt: number; signedInAt: number; current: boolean }[];
  sent: { method: string; path: string; body: unknown }[];
  /** The answer to DELETE /api/account */
  deleteAnswer?: { status: number; json: unknown };
}

async function accountApi(context: BrowserContext, opts: { hasPassword: boolean; github?: boolean; user?: typeof USER }): Promise<Stub> {
  const user = opts.user ?? USER;
  const now = Date.UTC(2026, 9, 30);
  const stub: Stub = {
    sessions: [
      { id: 'aaaaaaaaaaaaaaaa', createdAt: now, expiresAt: now + 30 * DAY, signedInAt: now, current: true },
      { id: 'bbbbbbbbbbbbbbbb', createdAt: now - DAY, expiresAt: now + 29 * DAY, signedInAt: now - DAY, current: false },
      { id: 'cccccccccccccccc', createdAt: now - 2 * DAY, expiresAt: now + 28 * DAY, signedInAt: now - 2 * DAY, current: false },
    ],
    sent: [],
  };
  const identities = [
    ...(opts.github ? [{ provider: 'github', label: 'octo', linkedAt: now - 10 * DAY }] : []),
    ...(opts.hasPassword ? [{ provider: 'email', label: user.email, linkedAt: now - 5 * DAY }] : []),
  ];
  await context.route(/\/api\/account(\/.*)?$/, async route => {
    const req = route.request();
    const path = new URL(req.url()).pathname;
    const body = req.postData() ? req.postDataJSON() : undefined;
    stub.sent.push({ method: req.method(), path, body });
    if (path === '/api/account' && req.method() === 'GET') {
      return route.fulfill({
        json: { user, identities, signInMethods: identities.map(i => i.provider), hasPassword: opts.hasPassword, createdAt: now - 10 * DAY },
      });
    }
    if (path === '/api/account' && req.method() === 'DELETE') {
      const a = stub.deleteAnswer ?? { status: 204, json: null };
      return a.status === 204 ? route.fulfill({ status: 204 }) : route.fulfill({ status: a.status, json: a.json });
    }
    if (path === '/api/account/sessions' && req.method() === 'GET') return route.fulfill({ json: { sessions: stub.sessions } });
    if (path === '/api/account/sessions' && req.method() === 'DELETE') {
      const ended = stub.sessions.filter(s => !s.current).length;
      stub.sessions = stub.sessions.filter(s => s.current);
      return route.fulfill({ json: { ended } });
    }
    if (path.startsWith('/api/account/sessions/') && req.method() === 'DELETE') {
      const id = path.split('/').pop();
      stub.sessions = stub.sessions.filter(s => s.id !== id);
      return route.fulfill({ status: 204 });
    }
    if (path === '/api/account/password') {
      const b = body as { currentPassword?: string };
      if (b.currentPassword !== 'violet harbor lantern quiz') {
        return route.fulfill({ status: 403, json: { error: 'wrong_password', message: 'Your current password is not correct.' } });
      }
      // Like the server: every session ends, and this browser gets a new one
      stub.sessions = [{ id: 'dddddddddddddddd', createdAt: now, expiresAt: now + 30 * DAY, signedInAt: now, current: true }];
      return route.fulfill({ json: { ok: true } });
    }
    return route.fulfill({ status: 404, json: { error: 'not_found', message: 'Not found' } });
  });
  return stub;
}

test.describe('signed in with a password', () => {
  test.use({ me: { user: USER, providers: { github: true, email: true }, emailSending: true } });

  test('the account page leads here; sessions can be signed out one at a time or all at once', async ({ page, context }) => {
    const stub = await accountApi(context, { hasPassword: true });
    await page.goto('#/account');
    await page.getByRole('link', { name: 'Open security and data' }).click();
    await expect(page.getByRole('heading', { level: 1, name: 'Security and data' })).toBeVisible();

    const sessions = page.getByRole('list', { name: 'Sessions' }).getByRole('listitem');
    await expect(sessions).toHaveCount(3);
    await expect(sessions.first()).toContainText('This browser');
    // Nothing scrolls sideways, on a phone too
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);

    await sessions.nth(1).getByRole('button', { name: /^Sign out the session from/ }).click();
    await expect(sessions).toHaveCount(2);
    expect(stub.sent.some(s => s.method === 'DELETE' && s.path === '/api/account/sessions/bbbbbbbbbbbbbbbb')).toBe(true);

    await page.getByRole('button', { name: 'Sign out everywhere else' }).click();
    await expect(page.getByText('Signed out on 1 other device.')).toBeVisible();
    await expect(sessions).toHaveCount(1);
    await expect(page.getByRole('button', { name: 'Sign out everywhere else' })).toHaveCount(0);
  });

  test.describe('a refused password', () => {
    // The browser logs the stubbed 403 as a console error
    test.use({ allowConsoleErrors: true });

    test('changing the password: a wrong current password is shown at its field, then it works', async ({ page, context }) => {
      const stub = await accountApi(context, { hasPassword: true });
      await page.goto('#/account/security');
      await page.getByLabel('Current password', { exact: true }).first().fill('not my password');
      await page.getByLabel('New password', { exact: true }).fill('a brand new long passphrase');
      await page.getByRole('button', { name: 'Change password' }).click();
      await expect(page.getByText('That isn’t your current password. Check it and try again.')).toBeVisible();
      await expect(page.getByLabel('New password', { exact: true })).toHaveValue('');

      await page.getByLabel('Current password', { exact: true }).first().fill('violet harbor lantern quiz');
      await page.getByLabel('New password', { exact: true }).fill('a brand new long passphrase');
      await page.getByRole('button', { name: 'Change password' }).click();
      await expect(page.getByText('Password changed. Your other devices were signed out.')).toBeVisible();

      // The sessions list follows: only the new session, and signing out this browser ends that one
      const sessions = page.getByRole('list', { name: 'Sessions' }).getByRole('listitem');
      await expect(sessions).toHaveCount(1);
      await page.getByRole('button', { name: 'Sign out of this browser' }).click();
      expect(stub.sent.some(s => s.method === 'DELETE' && s.path === '/api/account/sessions/dddddddddddddddd')).toBe(true);
    });
  });

  test('deleting the account needs the word delete and the password, then signs out', async ({ page, context }) => {
    const stub = await accountApi(context, { hasPassword: true });
    await page.goto('#/account/security');
    const del = page.getByRole('button', { name: 'Delete my account' });
    await expect(del).toBeDisabled();
    await page.getByLabel('Type delete to confirm').fill('delete');
    await del.click();
    await expect(page.getByText('Enter your current password to confirm it is you.')).toBeVisible();
    expect(stub.sent.some(s => s.method === 'DELETE' && s.path === '/api/account')).toBe(false);

    const section = page.getByRole('region', { name: 'Delete account' });
    await section.getByLabel('Current password', { exact: true }).fill('violet harbor lantern quiz');
    await del.click();
    await expect(page.getByRole('link', { name: 'Sign in', exact: true })).toBeVisible();
    await expect(page.getByRole('heading', { level: 1, name: 'Sign in' })).toBeVisible();
    expect(stub.sent.find(s => s.method === 'DELETE' && s.path === '/api/account')?.body).toEqual({
      confirm: 'delete',
      currentPassword: 'violet harbor lantern quiz',
    });
  });
});

test.describe('signed in with GitHub only', () => {
  test.use({ me: { user: GITHUB_USER, providers: { github: true } } });
  // The browser logs the stubbed 403 as a console error
  test.use({ allowConsoleErrors: true });

  test('a delete long after signing in asks to sign in again with GitHub, coming back here', async ({ page, context }) => {
    const stub = await accountApi(context, { hasPassword: false, github: true, user: GITHUB_USER });
    stub.deleteAnswer = {
      status: 403,
      json: { error: 'reauth_required', message: 'Sign in again to confirm it is you, then retry.', providers: ['github'] },
    };
    await page.goto('#/account/security');
    await expect(page.getByText('You sign in with GitHub, so this account has no password.')).toBeVisible();
    await expect(page.getByText('This is your only way to sign in, so it can’t be removed.')).toBeVisible();
    await page.getByLabel('Type delete to confirm').fill('delete');
    await page.getByRole('button', { name: 'Delete my account' }).click();
    const again = page.getByRole('link', { name: 'Sign in again with GitHub' });
    await expect(again).toBeVisible();
    const href = new URL((await again.getAttribute('href'))!);
    expect(href.pathname).toBe('/api/auth/github/start');
    expect(href.searchParams.get('return')).toBe('#/account/security');
  });
});

test.describe('signed out', () => {
  test.use({ me: { user: null, providers: { github: false, email: true }, emailSending: true } });

  test('the security page asks to sign in', async ({ page }) => {
    await page.goto('#/account/security');
    await expect(page.getByRole('heading', { level: 1, name: 'Sign in' })).toBeVisible();
  });
});
