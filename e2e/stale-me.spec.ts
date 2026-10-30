import { test, expect } from './fixtures';
import type { Page } from '@playwright/test';

// #51, 3: a /api/me answer that was asked for before a sign-in or sign-out finished must not undo it.
// The confirm-email page asks /api/me again; that second answer is held back here until after the change.

const USER = { id: 'u1', name: 'Casey', login: null, email: 'casey@example.com', emailVerified: true, avatarUrl: null };

/** The first /api/me answers at once; the next one waits for `release()` and then answers `later` */
async function holdSecondMe(page: Page, later: unknown) {
  let calls = 0;
  let release!: () => void;
  const gate = new Promise<void>(r => (release = r));
  let reached!: () => void;
  const atGate = new Promise<void>(r => (reached = r));
  await page.route('**/api/me', async route => {
    calls++;
    if (calls === 2) {
      reached();
      await gate;
      return route.fulfill({ json: later });
    }
    return route.fallback();
  });
  await page.route('**/api/auth/email/verify', route => route.fulfill({ json: { ok: true } }));
  return { atGate, release };
}

test.describe('signed in', () => {
  test.use({ me: { user: USER, providers: { github: false, email: true }, emailSending: true } });

  test('signing out wins over an older answer that still says signed in', async ({ page }) => {
    const hold = await holdSecondMe(page, { user: USER, providers: { github: false, email: true }, emailSending: true });
    await page.goto('#/learn');
    await expect(page.getByRole('button', { name: 'Account: Casey' })).toBeVisible();
    await page.goto('#/account/verify?token=confirm-code');
    await hold.atGate;

    await page.getByRole('button', { name: 'Account: Casey' }).click();
    await page.getByRole('button', { name: 'Sign out' }).click();
    await expect(page.getByRole('link', { name: 'Sign in', exact: true })).toBeVisible();

    hold.release();
    await expect(page.getByText('Your email is confirmed. Thank you.')).toBeVisible();
    await page.waitForTimeout(300);
    await expect(page.getByRole('link', { name: 'Sign in', exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Account: Casey' })).toHaveCount(0);
  });
});

test.describe('signed out', () => {
  test.use({ me: { user: null, providers: { github: false, email: true }, emailSending: true } });

  test('signing in wins over an older answer that still says signed out', async ({ page }) => {
    const hold = await holdSecondMe(page, { user: null, providers: { github: false, email: true }, emailSending: true });
    await page.route('**/api/auth/email/login', route => route.fulfill({ json: { user: USER } }));
    await page.goto('#/account/verify?token=confirm-code');
    await hold.atGate;

    await page.goto('#/account');
    await page.getByLabel('Email', { exact: true }).fill('casey@example.com');
    await page.getByLabel('Password', { exact: true }).fill('violet harbor lantern quiz');
    await page.getByRole('button', { name: 'Sign in' }).click();
    await expect(page.getByRole('button', { name: 'Account: Casey' })).toBeVisible();

    hold.release();
    await page.waitForTimeout(300);
    await expect(page.getByRole('button', { name: 'Account: Casey' })).toBeVisible();
    await expect(page.getByRole('link', { name: 'Sign in', exact: true })).toHaveCount(0);
  });
});
