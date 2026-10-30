import { test, expect } from './fixtures';
import type { BrowserContext } from '@playwright/test';

// #/admin (portal part 9). The preview server has no Worker behind it, so the admin API is stubbed here.

const OWNER = { id: 'u1', name: 'CJ', login: null, email: 'owner@example.com', emailVerified: true, avatarUrl: null };
const STATS = {
  asOf: Date.UTC(2026, 9, 30),
  accounts: { total: 12, newLast7Days: 3, newLast30Days: 9, emailConfirmed: 8, withPassword: 10, withGithub: 4 },
  activity: { signedInLast7Days: 5, liveSessions: 7 },
  progress: { accountsWithProgress: 6, tasksDone: 140, lessonsRead: 33, quizzesTaken: 21 },
};

async function adminApi(context: BrowserContext) {
  const admins = [{ email: 'helper@example.com', addedAt: 1 }];
  const sent: { method: string; body: unknown }[] = [];
  await context.route('**/api/admin/stats', route => route.fulfill({ json: STATS }));
  await context.route('**/api/admin/missed', route => route.fulfill({ json: { asOf: STATS.asOf, learnersSharing: 0, questions: [] } }));
  await context.route('**/api/admin/admins', async route => {
    const req = route.request();
    const body = req.postData() ? req.postDataJSON() : undefined;
    sent.push({ method: req.method(), body });
    if (req.method() === 'POST') admins.push({ email: (body as { email: string }).email, addedAt: 2 });
    if (req.method() === 'DELETE') admins.splice(admins.findIndex(a => a.email === (body as { email: string }).email), 1);
    if (req.method() === 'GET') return route.fulfill({ json: { admins } });
    return req.method() === 'DELETE' ? route.fulfill({ status: 204 }) : route.fulfill({ status: 201, json: { ok: true } });
  });
  return sent;
}

test.describe('the owner', () => {
  test.use({ me: { user: OWNER, role: 'owner', providers: { github: true, email: true }, emailSending: true } });

  test('the account menu leads to the dashboard: totals, and the admin list to add to and remove from', async ({ page, context }) => {
    const sent = await adminApi(context);
    await page.goto('#/learn');
    await page.getByRole('button', { name: 'Account: CJ' }).click();
    await page.getByRole('link', { name: 'Admin dashboard' }).click();
    await expect(page.getByRole('heading', { level: 1, name: 'Admin dashboard' })).toBeVisible();

    const accounts = page.getByRole('table', { name: 'Accounts' });
    await expect(accounts.getByRole('row', { name: /Learner accounts/ })).toContainText('12');
    await expect(page.getByRole('table', { name: 'Saved progress' }).getByRole('row', { name: /Lab tasks done/ })).toContainText('140');
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);

    const list = page.getByRole('list', { name: 'Admins' }).getByRole('listitem');
    await expect(list).toHaveCount(1);
    await page.getByLabel('Add an admin by email').fill('Friend@Example.com ');
    await page.getByRole('button', { name: 'Add admin' }).click();
    await expect(list).toHaveCount(2);
    expect(sent.find(s => s.method === 'POST')?.body).toEqual({ email: 'friend@example.com' });

    await page.getByRole('button', { name: 'Remove helper@example.com' }).click();
    await expect(page.getByText('helper@example.com is no longer an admin.')).toBeVisible();
    await expect(list).toHaveCount(1);
  });

  test('view as a signed-out visitor: the header shows Sign in, the account data stays, and the banner leads back', async ({ page, context }) => {
    await adminApi(context);
    await page.goto('#/admin');
    await page.getByRole('button', { name: 'View as a signed-out visitor' }).click();
    await expect(page.getByRole('heading', { level: 1, name: 'Learning paths' })).toBeVisible();
    await expect(page.getByRole('status').filter({ hasText: 'Viewing as a signed-out visitor' })).toBeVisible();
    await expect(page.getByRole('link', { name: 'Sign in', exact: true })).toBeVisible();
    // The real account is untouched: still signed in underneath, its data still here
    expect(await page.evaluate(() => localStorage.getItem('certsim:account'))).toBe('u1');

    await page.getByRole('button', { name: 'Stop and go back to the admin dashboard' }).click();
    await expect(page.getByRole('heading', { level: 1, name: 'Admin dashboard' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Account: CJ' })).toBeVisible();
  });

  test('view as a learner: the account menu has no admin link', async ({ page, context }) => {
    await adminApi(context);
    await page.goto('#/admin');
    await page.getByRole('button', { name: 'View as a learner' }).click();
    await page.getByRole('button', { name: 'Account: CJ' }).click();
    await expect(page.getByRole('link', { name: 'Your account' })).toBeVisible();
    await expect(page.getByRole('link', { name: 'Admin dashboard' })).toHaveCount(0);
  });
});

test.describe('a learner', () => {
  test.use({ me: { user: { ...OWNER, name: 'Casey', email: 'casey@example.com' }, role: null, providers: { github: true, email: true } } });

  test('sees no admin link, and #/admin says it is for admins', async ({ page }) => {
    await page.goto('#/admin');
    await expect(page.getByText('This page is for the site’s admins.')).toBeVisible();
    await page.getByRole('button', { name: 'Account: Casey' }).click();
    await expect(page.getByRole('link', { name: 'Admin dashboard' })).toHaveCount(0);
  });
});
