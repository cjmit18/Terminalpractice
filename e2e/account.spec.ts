import { test, expect } from './fixtures';

test.describe('sign-in not configured', () => {
  test('no sign-in control is shown', async ({ page }) => {
    await page.goto('#/learn');
    await expect(page.getByRole('heading', { level: 1, name: 'Learning paths' })).toBeVisible();
    await expect(page.getByRole('link', { name: 'Sign in', exact: true })).toHaveCount(0);
    // Settings stay reachable without accounts
    await expect(page.getByRole('banner').getByRole('link', { name: 'Settings' })).toBeVisible();
  });
});

test.describe('signed out, GitHub sign-in available', () => {
  test.use({ me: { user: null, providers: { github: true } } });

  test('Sign in opens the account page, whose GitHub button goes to the API', async ({ page }) => {
    await page.goto('#/reference');
    const link = page.getByRole('banner').getByRole('link', { name: 'Sign in', exact: true });
    await expect(link).toHaveAttribute('href', '#/account');
    await link.click();
    const github = page.getByRole('link', { name: 'Continue with GitHub' });
    await expect(github).toBeVisible();
    // Only the methods the server offers are shown
    await expect(page.getByRole('link', { name: 'Continue with Google' })).toHaveCount(0);
    await expect(page.getByRole('tab', { name: 'Create account' })).toHaveCount(0);
    const href = new URL((await github.getAttribute('href'))!);
    expect(href.pathname).toBe('/api/auth/github/start');
    expect(href.searchParams.get('return')).toBe('#/account');
  });
});

test.describe('signed in', () => {
  test.use({ me: { user: { id: 'u1', name: 'Octo Learner', login: 'octo-learner', avatarUrl: null }, providers: { github: true } } });

  test('the account menu shows who is signed in and signs out', async ({ page }) => {
    await page.goto('#/learn');
    const button = page.getByRole('button', { name: 'Account: Octo Learner' });
    await button.click();
    await expect(page.getByText('Signed in with GitHub as octo-learner')).toBeVisible();
    const logout = page.waitForRequest(req => req.url().endsWith('/api/logout') && req.method() === 'POST');
    await page.getByRole('button', { name: 'Sign out' }).click();
    await logout;
    await expect(page.getByRole('banner').getByRole('link', { name: 'Sign in', exact: true })).toBeVisible();
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
