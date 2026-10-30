import { test, expect } from './fixtures';
import type { Page } from '@playwright/test';

const EMAIL_USER = { id: 'u2', name: 'Casey', login: null, email: 'casey@example.com', emailVerified: false, avatarUrl: null };

/** Answers one account API call with `json` (and `status`), and records what was sent */
async function stub(page: Page, path: string, json: unknown, status = 200) {
  const sent: unknown[] = [];
  await page.route(`**/api/${path}`, async route => {
    sent.push(route.request().postDataJSON());
    await route.fulfill({ status, json });
  });
  return sent;
}

test.describe('sign-in not configured', () => {
  test('no sign-in control is shown', async ({ page }) => {
    await page.goto('#/learn');
    await expect(page.getByRole('heading', { level: 1, name: 'Learning paths' })).toBeVisible();
    await expect(page.getByRole('link', { name: 'Sign in', exact: true })).toHaveCount(0);
  });
});

test.describe('signed out, GitHub sign-in available', () => {
  test.use({ me: { user: null, providers: { github: true, email: false } } });

  test('Sign in opens the account page, whose GitHub button returns to it', async ({ page }) => {
    await page.goto('#/reference');
    await page.getByRole('link', { name: 'Sign in', exact: true }).click();
    await expect(page.getByRole('heading', { level: 1, name: 'Sign in' })).toBeVisible();
    const href = new URL((await page.getByRole('link', { name: 'Continue with GitHub' }).getAttribute('href'))!);
    expect(href.pathname).toBe('/api/auth/github/start');
    expect(href.searchParams.get('return')).toBe('#/account');
    // Email sign-in is not offered when the server does not offer it
    await expect(page.getByRole('tab', { name: 'Create account' })).toHaveCount(0);
  });
});

test.describe('signed out, email sign-in available', () => {
  test.use({ me: { user: null, providers: { github: false, email: true }, emailSending: true } });

  test('creating an account signs in and asks to confirm the email', async ({ page }) => {
    const sent = await stub(page, 'auth/email/register', { user: EMAIL_USER, emailSent: true }, 201);
    await page.goto('#/account');
    await page.getByRole('tab', { name: 'Create account' }).click();
    // The form checks what it can before sending anything
    await page.getByRole('button', { name: 'Create account' }).click();
    await expect(page.getByText('Enter a display name.')).toBeVisible();
    expect(sent).toHaveLength(0);

    await page.getByLabel('Display name').fill('Casey');
    await page.getByLabel('Email', { exact: true }).fill('casey@example.com');
    await page.getByLabel('Password', { exact: true }).fill('violet harbor lantern');
    await page.getByLabel('I am 13 or older').check();
    await page.getByRole('button', { name: 'Create account' }).click();
    await expect(page.getByRole('heading', { level: 1, name: 'Hello, Casey' })).toBeVisible();
    expect(sent[0]).toEqual({ email: 'casey@example.com', password: 'violet harbor lantern', displayName: 'Casey', ageConfirmed: true });
    await expect(page.getByRole('heading', { name: 'Confirm your email' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Resend the link' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Account: Casey' })).toBeVisible();
  });

  test.describe('a refused sign-in', () => {
    // The browser logs the stubbed 401 as a console error
    test.use({ allowConsoleErrors: true });

    test('a wrong password shows a plain message and keeps the email', async ({ page }) => {
      await stub(page, 'auth/email/login', { error: 'invalid_credentials', message: 'x' }, 401);
      await page.goto('#/account');
      await page.getByLabel('Email', { exact: true }).fill('casey@example.com');
      await page.getByLabel('Password', { exact: true }).fill('not the password');
      await page.getByRole('button', { name: 'Sign in' }).click();
      await expect(page.getByRole('alert')).toHaveText(/don’t match an account/);
      await expect(page.getByLabel('Email', { exact: true })).toHaveValue('casey@example.com');
      await expect(page.getByLabel('Password', { exact: true })).toHaveValue('');
    });
  });

  test('forgot password always gives the same answer', async ({ page }) => {
    const sent = await stub(page, 'auth/password/forgot', { ok: true }, 202);
    await page.goto('#/account');
    await page.getByRole('link', { name: 'Forgot password?' }).click();
    await expect(page.getByRole('heading', { level: 1, name: 'Reset your password' })).toBeVisible();
    await page.getByLabel('Email', { exact: true }).fill('casey@example.com');
    await page.getByRole('button', { name: 'Send reset link' }).click();
    await expect(page.getByText('If an account uses that email, we sent a reset link.')).toBeVisible();
    expect(sent[0]).toEqual({ email: 'casey@example.com' });
  });

  test('the reset link sets a new password, signs in, and takes the code out of the address', async ({ page }) => {
    const sent = await stub(page, 'auth/password/reset', { user: { ...EMAIL_USER, emailVerified: true } });
    await page.goto('#/account/reset?token=reset-code-123');
    await expect(page.getByRole('heading', { level: 1, name: 'Choose a new password' })).toBeVisible();
    await expect(page).toHaveURL(/#\/account\/reset$/);
    await page.getByLabel('New password', { exact: true }).fill('a fresh long passphrase');
    await page.getByRole('button', { name: 'Set new password' }).click();
    await expect(page.getByText('Your new password is set and you are signed in.')).toBeVisible();
    expect(sent[0]).toEqual({ token: 'reset-code-123', password: 'a fresh long passphrase' });
    await expect(page.getByRole('button', { name: 'Account: Casey' })).toBeVisible();
  });

  test.describe('a lapsed claim', () => {
    // The browser logs the stubbed 400 as a console error
    test.use({ allowConsoleErrors: true });

    test('a confirm link that ran out with the claim leads to a password reset', async ({ page }) => {
      await stub(
        page,
        'auth/email/verify',
        { error: 'email_claim_lapsed', message: 'This address was not confirmed within 24 hours. To confirm it now, use Forgot password: the reset link confirms the address too.' },
        400,
      );
      await page.goto('#/account/verify?token=old-code');
      await expect(page.getByRole('alert')).toContainText('not confirmed within 24 hours');
      await page.getByRole('link', { name: 'Reset your password to confirm this address' }).click();
      await expect(page.getByRole('heading', { level: 1, name: 'Reset your password' })).toBeVisible();
    });
  });

  test('the confirm link confirms the email as the page opens', async ({ page }) => {
    const sent = await stub(page, 'auth/email/verify', { ok: true });
    await page.goto('#/account/verify?token=confirm-code-9');
    await expect(page.getByText('Your email is confirmed. Thank you.')).toBeVisible();
    expect(sent[0]).toEqual({ token: 'confirm-code-9' });
    await expect(page).toHaveURL(/#\/account\/verify$/);
  });
});

test.describe('signed out, email cannot be sent yet', () => {
  test.use({ me: { user: null, providers: { github: false, email: true }, emailSending: false } });

  test('no reset is offered, and the page says why', async ({ page }) => {
    await page.goto('#/account');
    await expect(page.getByRole('link', { name: 'Forgot password?' })).toHaveCount(0);
    await expect(page.getByText('This site can’t send email yet')).toBeVisible();
  });
});

test.describe('signed in', () => {
  test.use({ me: { user: { id: 'u1', name: 'Octo Learner', login: 'octo-learner', avatarUrl: null }, providers: { github: true, email: true } } });

  test('the account menu shows who is signed in and signs out', async ({ page }) => {
    await page.goto('#/learn');
    const button = page.getByRole('button', { name: 'Account: Octo Learner' });
    await button.click();
    await expect(page.getByText('Signed in with GitHub as octo-learner')).toBeVisible();
    await page.getByRole('link', { name: 'Your account' }).click();
    await expect(page.getByRole('heading', { level: 1, name: 'Hello, Octo Learner' })).toBeVisible();
    const logout = page.waitForRequest(req => req.url().endsWith('/api/logout') && req.method() === 'POST');
    await page.getByRole('button', { name: 'Sign out' }).click();
    await logout;
    await expect(page.getByRole('link', { name: 'Sign in', exact: true })).toBeVisible();
    await expect(page.getByRole('heading', { level: 1, name: 'Sign in' })).toBeVisible();
  });

  test('Escape closes the menu and returns focus to the button', async ({ page }) => {
    await page.goto('#/learn');
    const button = page.getByRole('button', { name: 'Account: Octo Learner' });
    await button.click();
    await expect(button).toHaveAttribute('aria-expanded', 'true');
    await page.keyboard.press('Escape');
    await expect(button).toHaveAttribute('aria-expanded', 'false');
    await expect(button).toBeFocused();
  });
});
