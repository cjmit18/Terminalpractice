import type { Page, Route } from '@playwright/test';
import { test, expect, expectNoHorizontalOverflow, commandInput } from './fixtures';

// The account portal (#/account, docs/ACCOUNTS_API.md) against a stubbed API: the preview server has
// no Worker behind it. Page routes take precedence over the fixture's context routes.

type Reply = { status?: number; json?: unknown; headers?: Record<string, string> };
type Handler = (body: Record<string, unknown> | null) => Reply;
interface Call {
  key: string;
  body: Record<string, unknown> | null;
}

const ADA = { id: 'u1', name: 'Ada', login: null, email: 'ada@example.com', emailVerified: false };
const ALL_PROVIDERS = { google: true, github: true, email: true };

async function stubApi(
  page: Page,
  me: { user: unknown; providers: Record<string, boolean>; emailSending: boolean },
  handlers: Record<string, Handler> = {},
): Promise<Call[]> {
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
    if (key === 'GET me') return route.fulfill({ json: me });
    const h = handlers[key] ?? PROGRESS_STUBS[key];
    if (!h) return route.fulfill({ status: 404, json: { error: 'not_found', message: 'Not found' } });
    const r = h(body);
    if (r.json === undefined) return route.fulfill({ status: r.status ?? 204, body: '', headers: r.headers });
    return route.fulfill({ status: r.status ?? 200, json: r.json, headers: r.headers });
  });
  return calls;
}

/** 4xx answers make Chromium log "Failed to load resource"; anything else is still a failure. */
const onlyHttpErrors = (errors: string[]) => errors.filter(e => !e.includes('Failed to load resource'));

/** Signed in, the progress sync talks to these: by default an account with nothing saved yet */
const PROGRESS_STUBS: Record<string, Handler> = {
  'GET progress': () => ({ json: { items: [], epochs: {}, settings: {} } }),
  'PUT progress': () => ({ json: { items: [], epochs: {}, settings: {} } }),
  'POST progress/reset': () => ({ json: { epochs: {} } }),
};

const passwordInput = (page: Page, label = 'Password') => page.getByLabel(label, { exact: true });

test.describe('signed out', () => {
  test.use({ allowConsoleErrors: true });

  test('create account: fields are checked, the 13+ box is required, then the dashboard', async ({ page, consoleErrors }) => {
    const calls = await stubApi(page, { user: null, providers: ALL_PROVIDERS, emailSending: true }, {
      'POST auth/email/register': () => ({ status: 201, json: { user: ADA } }),
    });
    await page.goto('#/account');
    await expect(page.getByRole('heading', { level: 1, name: 'Sign in' })).toBeVisible();
    await expect(page.getByRole('link', { name: 'Continue with Google' })).toBeVisible();
    await expect(page.getByRole('link', { name: 'Continue with GitHub' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'About accounts and your data' })).toBeVisible();
    await expect(page.getByText('never sold')).toBeVisible();
    await expect(page.getByText('Accounts are for people 13 or older.', { exact: false })).toBeVisible();

    await page.getByRole('tab', { name: 'Create account' }).click();
    await expect(page.getByRole('tab', { name: 'Create account' })).toHaveAttribute('aria-selected', 'true');
    const submit = page.getByRole('button', { name: 'Create account' });
    await submit.click();
    // Focus moves to the first field with an error, and the error is tied to it
    const name = page.getByLabel('Display name');
    await expect(name).toBeFocused();
    await expect(name).toHaveAttribute('aria-invalid', 'true');
    await expect(name).toHaveAccessibleDescription(/Enter a display name\./);
    await expect(name).toHaveAttribute('autocomplete', 'name');

    await name.fill('Ada');
    await page.getByLabel('Email', { exact: true }).fill('ada@example.com');
    await expect(page.getByLabel('Email', { exact: true })).toHaveAttribute('autocomplete', 'email');
    const pw = passwordInput(page);
    await expect(pw).toHaveAttribute('autocomplete', 'new-password');
    await pw.fill('abc');
    await expect(page.getByTestId('password-hint')).toHaveText('7 more characters needed (at least 10).');
    // Show/hide toggle
    await expect(pw).toHaveAttribute('type', 'password');
    await page.getByRole('button', { name: 'Show password' }).click();
    await expect(pw).toHaveAttribute('type', 'text');
    await page.getByRole('button', { name: 'Hide password' }).click();
    await expect(pw).toHaveAttribute('type', 'password');

    await submit.click();
    await expect(pw).toBeFocused();
    await expect(pw).toHaveAccessibleDescription(/Use at least 10 characters\./);

    await pw.fill('correct horse battery');
    await expect(page.getByTestId('password-hint')).toHaveText('Long enough.');
    await submit.click();
    const age = page.getByRole('checkbox', { name: 'I am 13 or older' });
    await expect(age).toBeFocused();
    await expect(age).toHaveAccessibleDescription('Confirm that you are 13 or older to create an account.');
    expect(calls.filter(c => c.key === 'POST auth/email/register')).toHaveLength(0);

    await age.check();
    await submit.click();
    await expect(page.getByRole('heading', { level: 1, name: 'Hello, Ada' })).toBeVisible();
    const reg = calls.find(c => c.key === 'POST auth/email/register');
    expect(reg?.body).toEqual({ email: 'ada@example.com', password: 'correct horse battery', displayName: 'Ada', ageConfirmed: true });
    // Nothing secret is kept in the browser
    const stored = await page.evaluate(() => JSON.stringify({ ...localStorage }) + JSON.stringify({ ...sessionStorage }));
    expect(stored).not.toContain('correct horse');
    expect(onlyHttpErrors(consoleErrors)).toEqual([]);
  });

  test('sign in: a wrong password says so plainly, then the dashboard', async ({ page, consoleErrors }) => {
    let attempts = 0;
    const calls = await stubApi(page, { user: null, providers: { email: true, google: false, github: false }, emailSending: true }, {
      'POST auth/email/login': () =>
        ++attempts === 1
          ? { status: 401, json: { error: 'invalid_credentials', message: 'Wrong email or password.' } }
          : { json: { user: ADA } },
      'POST auth/email/resend-verification': () => ({ status: 202 }),
    });
    await page.goto('#/account');
    // Only email is offered here
    await expect(page.getByRole('link', { name: 'Continue with Google' })).toHaveCount(0);
    await expect(page.getByRole('link', { name: 'Continue with GitHub' })).toHaveCount(0);

    await page.getByLabel('Email', { exact: true }).fill('ada@example.com');
    await expect(passwordInput(page)).toHaveAttribute('autocomplete', 'current-password');
    await passwordInput(page).fill('not the password');
    await page.getByRole('button', { name: 'Sign in' }).click();
    const alert = page.getByRole('alert');
    await expect(alert).toHaveText('That email and password don’t match an account. Check them and try again.');
    await expect(alert).toBeFocused();
    // The password is cleared after each try
    await expect(passwordInput(page)).toHaveValue('');

    await passwordInput(page).fill('the real password');
    await page.getByRole('button', { name: 'Sign in' }).click();
    await expect(page.getByRole('heading', { level: 1, name: 'Hello, Ada' })).toBeVisible();
    await expect(page.getByRole('navigation', { name: 'Account' }).getByRole('link', { name: 'Dashboard' })).toHaveAttribute('aria-current', 'page');
    await expect(page.getByTestId('sync-status')).toContainText('Progress synced just now.');
    await expect(page.getByRole('heading', { name: 'Learning paths' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Quick links' })).toBeVisible();

    // Email not confirmed yet: resend the link
    await expect(page.getByRole('heading', { name: 'Confirm your email' })).toBeVisible();
    await page.getByRole('button', { name: 'Resend the link' }).click();
    await expect(page.getByText('Sent. Check your inbox and spam folder.')).toBeVisible();
    expect(calls.some(c => c.key === 'POST auth/email/resend-verification')).toBe(true);

    // The header menu has the account pages
    await page.getByRole('button', { name: 'Account: Ada' }).click();
    const menu = page.getByRole('banner').getByRole('navigation', { name: 'Account' });
    await expect(menu.getByRole('link', { name: 'Dashboard' })).toHaveAttribute('href', '#/account');
    await expect(menu.getByRole('link', { name: 'Settings' })).toHaveAttribute('href', '#/account/settings');
    await menu.getByRole('link', { name: 'Security' }).click();
    await expect(page).toHaveURL(/#\/account\/security$/);
    expect(onlyHttpErrors(consoleErrors)).toEqual([]);
  });

  test('forgot password: always the same message', async ({ page, consoleErrors }) => {
    let n = 0;
    await stubApi(page, { user: null, providers: { email: true, google: false, github: false }, emailSending: true }, {
      'POST auth/password/forgot': () => (++n === 1 ? { status: 202 } : { status: 429, json: { error: 'rate_limited' }, headers: { 'Retry-After': '3600' } }),
    });
    await page.goto('#/account');
    await page.getByRole('link', { name: 'Forgot password?' }).click();
    await expect(page).toHaveURL(/#\/account\/forgot$/);
    await expect(page.getByRole('heading', { level: 1, name: 'Reset your password' })).toBeVisible();
    const email = page.getByLabel('Email', { exact: true });
    await email.fill('ada@example.com');
    await page.getByRole('button', { name: 'Send reset link' }).click();
    await expect(page.getByRole('status').filter({ hasText: 'If an account uses that email, we sent a reset link.' })).toBeVisible();
    await expect(email).toHaveValue('');
    // Over the limit: still the same answer
    await email.fill('someone@example.com');
    await page.getByRole('button', { name: 'Send reset link' }).click();
    await expect(page.getByRole('status').filter({ hasText: 'If an account uses that email, we sent a reset link.' })).toBeVisible();
    expect(onlyHttpErrors(consoleErrors)).toEqual([]);
  });

  test('without email sending, reset is said to be unavailable', async ({ page }) => {
    await stubApi(page, { user: null, providers: { email: true, google: false, github: false }, emailSending: false });
    await page.goto('#/account');
    await expect(page.getByText('Email links aren’t set up on this site yet, so password reset isn’t available.', { exact: false })).toBeVisible();
    await page.goto('#/account/forgot');
    await expect(page.getByText('Email links aren’t set up on this site yet, so password reset isn’t available.', { exact: false })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Send reset link' })).toHaveCount(0);
  });

  test('reset with a token: the token leaves the URL, then a new password signs you in', async ({ page, consoleErrors }) => {
    const calls = await stubApi(page, { user: null, providers: { email: true, google: false, github: false }, emailSending: true }, {
      'POST auth/password/reset': () => ({ json: { user: ADA } }),
      'POST auth/email/verify': () => ({ json: { user: { ...ADA, emailVerified: true } } }),
    });
    await page.goto('#/account/reset?token=tok-123');
    await expect(page.getByRole('heading', { level: 1, name: 'Choose a new password' })).toBeVisible();
    await expect(page).toHaveURL(/#\/account\/reset$/);
    const pw = passwordInput(page, 'New password');
    await expect(pw).toHaveAttribute('autocomplete', 'new-password');
    await pw.fill('short');
    await page.getByRole('button', { name: 'Set new password' }).click();
    await expect(pw).toBeFocused();
    await expect(pw).toHaveAccessibleDescription(/Use at least 10 characters\./);
    await pw.fill('a much longer password');
    await page.getByRole('button', { name: 'Set new password' }).click();
    await expect(page.getByText('Your new password is set and you are signed in.', { exact: false })).toBeVisible();
    expect(calls.find(c => c.key === 'POST auth/password/reset')?.body).toEqual({ token: 'tok-123', password: 'a much longer password' });
    await expect(page.getByRole('button', { name: 'Account: Ada' })).toBeVisible();

    // The verify link confirms on load and also leaves the URL clean
    await page.goto('#/account/verify?token=ver-9');
    await expect(page.getByText('Your email is confirmed.', { exact: false })).toBeVisible();
    await expect(page).toHaveURL(/#\/account\/verify$/);
    expect(calls.find(c => c.key === 'POST auth/email/verify')?.body).toEqual({ token: 'ver-9' });
    expect(onlyHttpErrors(consoleErrors)).toEqual([]);
  });
});

test.describe('dashboard and progress sync', () => {
  test.use({ allowConsoleErrors: true });

  test('the dashboard offers to add this browser\'s progress, once', async ({ page, consoleErrors }) => {
    const puts: Record<string, unknown>[] = [];
    await stubApi(page, { user: ADA, providers: ALL_PROVIDERS, emailSending: true }, {
      'PUT progress': body => {
        puts.push(body ?? {});
        return { json: { items: [], epochs: {}, settings: {} } };
      },
    });
    // Progress saved in this browser before signing in
    await page.addInitScript(() => {
      if (!localStorage.getItem('certsim:progress:v1'))
        localStorage.setItem('certsim:progress:v1', JSON.stringify({ 'lpi-101-1-system-architecture': ['hw-lspci'] }));
    });
    await page.goto('#/account');
    await expect(page.getByTestId('sync-status')).toContainText('Progress synced just now.');
    const prompt = page.getByRole('region', { name: 'Add the progress saved in this browser to your account?' });
    await expect(prompt).toBeVisible();
    await prompt.getByRole('button', { name: 'Add' }).click();
    await expect(prompt).toHaveCount(0);
    await expect.poll(() => puts.some(b => JSON.stringify(b.items ?? []).includes('hw-lspci'))).toBe(true);
    await page.reload();
    await expect(page.getByTestId('sync-status')).toContainText('Progress synced');
    await expect(prompt).toHaveCount(0);
    expect(onlyHttpErrors(consoleErrors)).toEqual([]);
  });

  test('a session the server no longer knows signs the browser out', async ({ page }) => {
    await stubApi(page, { user: ADA, providers: ALL_PROVIDERS, emailSending: true }, {
      'GET progress': () => ({ status: 401, json: { error: 'not_signed_in', message: 'Sign in to continue.' } }),
    });
    await page.goto('#/account');
    await expect(page.getByRole('banner').getByRole('link', { name: 'Sign in', exact: true })).toBeVisible();
    await expect(page.getByRole('heading', { level: 1, name: 'Sign in' })).toBeVisible();
    await expect.poll(() => page.evaluate(() => Object.keys(localStorage).filter(k => k.startsWith('certsim:acct:')))).toEqual([]);
  });
});

test('settings work without an account, and a moved setting still takes effect', async ({ page }) => {
  // The default fixture: no account API at all
  await page.goto('#/learn');
  await expect(page.getByRole('combobox', { name: 'Weekly goal' })).toHaveCount(0);
  await expect(page.getByRole('main').getByRole('link', { name: 'Settings', exact: true })).toBeVisible();
  await page.getByRole('banner').getByRole('link', { name: 'Settings' }).click();
  await expect(page).toHaveURL(/#\/account\/settings$/);
  await expect(page.getByRole('heading', { level: 1, name: 'Settings' })).toBeVisible();
  await expect(page.getByRole('banner').getByRole('link', { name: 'Settings' })).toHaveAttribute('aria-current', 'page');

  // Story notes moved here and still apply to labs
  await page.getByRole('group', { name: 'Story notes' }).getByRole('radio', { name: /^Hide/ }).check();
  // Basic config: the Sandbox's shell and the terminal text size
  await page.getByRole('group', { name: 'Shell the Sandbox opens with' }).getByRole('radio', { name: /^PowerShell/ }).check();
  await page.getByRole('group', { name: 'Terminal text size' }).getByRole('radio', { name: /^Large/ }).check();
  await page.getByRole('group', { name: 'Theme' }).getByRole('radio', { name: /^Dark/ }).check();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  const prefs = await page.evaluate(() => JSON.parse(localStorage.getItem('certsim:activity:v1') ?? '{}').prefs);
  expect(prefs).toEqual({ storyNotes: false, defaultShell: 'powershell', termFontSize: 'l' });

  // The moved story-notes setting still takes effect on labs
  await page.goto('#/linux/lpi-101-1-system-architecture');
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
  await expect(page.getByText('Ticket from Aiko Tanaka, Warehouse')).toHaveCount(0);

  await page.goto('#/sandbox');
  await expect(page.getByRole('group', { name: 'Shell' }).getByRole('button', { name: 'PowerShell' })).toHaveAttribute('aria-pressed', 'true');
  await expect(commandInput(page)).toHaveCSS('font-size', '16px');

  // Clear badges and activity is here too
  await page.goto('#/account/settings');
  await expect(page.getByRole('button', { name: 'Clear badges and activity' })).toBeVisible();
  // Settings survive a reload
  await page.reload();
  await expect(page.getByRole('group', { name: 'Terminal text size' }).getByRole('radio', { name: /^Large/ })).toBeChecked();
});

test.describe('security', () => {
  test.use({ allowConsoleErrors: true });

  const details = {
    user: ADA,
    identities: [{ provider: 'github', label: 'ada-gh', linkedAt: '2026-10-01T10:00:00Z' }],
    hasPassword: true,
    emailVerified: false,
  };

  test('change password and the last-method message', async ({ page, consoleErrors }) => {
    let pwTries = 0;
    const calls = await stubApi(page, { user: ADA, providers: ALL_PROVIDERS, emailSending: true }, {
      'GET account': () => ({ json: details }),
      'POST account/password': () =>
        ++pwTries === 1 ? { status: 400, json: { error: 'wrong_password', message: 'Wrong password.' } } : { json: { ok: true } },
      'DELETE account/identities/github': () => ({
        status: 409,
        json: { error: 'last_method', message: 'This is your only sign-in method.' },
      }),
    });
    await page.goto('#/account/security');
    await expect(page.getByRole('heading', { level: 1, name: 'Security' })).toBeVisible();

    const current = passwordInput(page, 'Current password');
    const next = passwordInput(page, 'New password');
    await expect(current).toHaveAttribute('autocomplete', 'current-password');
    await page.getByRole('button', { name: 'Change password' }).click();
    await expect(current).toBeFocused();
    await expect(current).toHaveAccessibleDescription('Enter your current password.');

    await current.fill('old password 1');
    await next.fill('new password 22');
    await page.getByRole('button', { name: 'Change password' }).click();
    await expect(current).toHaveAccessibleDescription('Your current password is not right. Check it and try again.');
    await expect(current).toBeFocused();
    await expect(current).toHaveValue('');
    await expect(next).toHaveValue('');

    await current.fill('old password 1');
    await next.fill('new password 22');
    await page.getByRole('button', { name: 'Change password' }).click();
    await expect(page.getByText('Password changed. Your other devices were signed out.')).toBeVisible();
    expect(calls.filter(c => c.key === 'POST account/password').at(-1)?.body).toEqual({
      currentPassword: 'old password 1',
      newPassword: 'new password 22',
    });

    // Linked methods: link Google, and the last method cannot be removed
    const link = page.getByRole('link', { name: 'Link Google' });
    const href = new URL((await link.getAttribute('href'))!);
    expect(href.pathname).toBe('/api/auth/google/start');
    expect(href.searchParams.get('link')).toBe('1');
    await page.getByRole('button', { name: 'Unlink GitHub' }).click();
    await expect(page.getByRole('alert').filter({ hasText: 'only way you can sign in' })).toBeVisible();
    expect(onlyHttpErrors(consoleErrors)).toEqual([]);
  });

  test('delete account needs the word delete typed', async ({ page }) => {
    const calls = await stubApi(page, { user: ADA, providers: ALL_PROVIDERS, emailSending: true }, {
      'GET account': () => ({ json: details }),
      'DELETE account': () => ({ status: 204 }),
    });
    await page.goto('#/account/security');
    const del = page.getByRole('button', { name: 'Delete my account' });
    const confirm = page.getByLabel('Type delete to confirm');
    await expect(del).toBeDisabled();
    await confirm.fill('delet');
    await expect(del).toBeDisabled();
    await confirm.fill('delete');
    await expect(del).toBeEnabled();
    await del.click();
    await expect(page).toHaveURL(/#\/account$/);
    await expect(page.getByText('Your account and everything linked to it, synced progress included, were deleted.', { exact: false })).toBeVisible();
    await expect(page.getByRole('banner').getByRole('link', { name: 'Sign in', exact: true })).toBeVisible();
    expect(calls.find(c => c.key === 'DELETE account')?.body).toEqual({ confirm: 'delete' });
  });
});

test.describe('phone', () => {
  test.skip(({ isMobile }) => !isMobile, 'phone layout only');

  test('the portal fits a phone, signed out and signed in', async ({ page }) => {
    await stubApi(page, { user: null, providers: ALL_PROVIDERS, emailSending: true });
    await page.goto('#/account');
    await expect(page.getByRole('link', { name: 'Continue with Google' })).toBeVisible();
    const banner = page.getByRole('banner');
    await expect(banner.getByRole('link', { name: 'Sign in', exact: true })).toBeInViewport();
    await expect(banner.getByRole('link', { name: 'Settings' })).toBeInViewport();
    await expectNoHorizontalOverflow(page);
    await page.getByRole('tab', { name: 'Create account' }).tap();
    await expectNoHorizontalOverflow(page);
    await banner.getByRole('link', { name: 'Settings' }).tap();
    await expect(page.getByRole('heading', { level: 1, name: 'Settings' })).toBeVisible();
    await expectNoHorizontalOverflow(page);
  });

  test('dashboard and security fit a phone', async ({ page }) => {
    await stubApi(page, { user: ADA, providers: ALL_PROVIDERS, emailSending: true }, {
      'GET account': () => ({
        json: { user: ADA, identities: [{ provider: 'github', label: 'ada-gh', linkedAt: 1760000000000 }], hasPassword: true, emailVerified: false },
      }),
    });
    await page.goto('#/account');
    await expect(page.getByRole('heading', { level: 1, name: 'Hello, Ada' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Account: Ada' })).toBeInViewport();
    await expectNoHorizontalOverflow(page);
    await page.goto('#/account/security');
    await expect(page.getByRole('button', { name: 'Delete my account' })).toBeAttached();
    await expectNoHorizontalOverflow(page);
  });
});
