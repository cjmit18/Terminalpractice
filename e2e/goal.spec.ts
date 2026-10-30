import type { Page } from '@playwright/test';
import { test, expect, runCommand } from './fixtures';

const ACTIVITY_KEY = 'certsim:activity:v1';
const storedActivity = async (page: Page) => JSON.parse((await page.evaluate(k => localStorage.getItem(k), ACTIVITY_KEY)) ?? '{}');
const weekly = (page: Page) => page.getByTestId('weekly-goal');
const recap = (page: Page) => page.getByTestId('today-recap');
const goalSelect = (page: Page) => page.getByRole('combobox', { name: 'Weekly goal' });
/** Sets the weekly goal in Settings, then comes back to the Learn page */
async function setGoal(page: Page, days: string) {
  await page.goto('#/settings');
  await goalSelect(page).selectOption(days);
  await page.goto('#/learn');
}

/** Today as the app stores it: local YYYY-MM-DD */
const today = (page: Page) =>
  page.evaluate(() => {
    const d = new Date();
    const p = (n: number) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
  });

test('weekly goal: off by default; three Sandbox commands make a day; today is recapped', async ({ page }) => {
  await page.goto('#/settings');
  await expect(goalSelect(page)).toHaveValue('0');
  await page.goto('#/learn');
  await expect(weekly(page)).toHaveCount(0);
  await expect(recap(page)).toHaveCount(0);

  await setGoal(page, '3');
  await expect(weekly(page)).toBeVisible();
  await expect(weekly(page).getByRole('list', { name: 'Days this week' }).getByRole('listitem')).toHaveCount(7);
  await expect(weekly(page)).toContainText('Your goal: practise on 3 days this week. Rest days are fine.');
  expect((await storedActivity(page)).prefs.weeklyGoal).toBe(3);

  await page.goto('#/sandbox');
  await runCommand(page, 'pwd');
  await runCommand(page, 'whoami');
  // Two commands are not a practice day yet
  expect((await storedActivity(page)).practice ?? []).toEqual([]);
  await runCommand(page, 'ls');
  expect((await storedActivity(page)).practice).toEqual([await today(page)]);

  await page.goto('#/learn');
  await expect(weekly(page)).toContainText('1 of 3 days so far.');
  await expect(weekly(page)).toContainText(', today, practised');
  await expect(recap(page)).toHaveText('Today: 3 new commands (ls, pwd, whoami).');
  // Nothing typed is stored, only command names
  expect(JSON.stringify(await storedActivity(page))).not.toContain('/home');
});

test('weekly goal: a met week says so and is counted once; the count stays when the goal is lowered', async ({ page }) => {
  await page.goto('#/learn');
  const day = await today(page);
  await page.evaluate(
    ([k, d]) => localStorage.setItem(k, JSON.stringify({ facts: [], days: [d], badges: {}, practice: [d], prefs: { weeklyGoal: 1 }, prefsAt: 1 })),
    [ACTIVITY_KEY, day],
  );
  await page.reload();
  await expect(weekly(page)).toContainText('You met this week’s goal.');
  await expect(weekly(page)).toContainText('Weeks you met your goal: 1');
  await expect.poll(async () => (await storedActivity(page)).goalWeeks?.length).toBe(1);

  // Raising the goal does not take the week away
  await setGoal(page, '5');
  await expect(weekly(page)).toContainText('1 of 5 days so far.');
  await expect(weekly(page)).toContainText('Weeks you met your goal: 1');
  // Turning it off hides it all, and nothing negative is shown anywhere
  await setGoal(page, '0');
  await expect(weekly(page)).toHaveCount(0);
});

test('a lesson read counts toward the goal and shows in the recap', async ({ page }) => {
  await setGoal(page, '2');
  await page.goto('#/learn/lpic1-101/how-linux-sees-hardware');
  await page.getByRole('button', { name: 'Mark as read' }).click();
  await page.goto('#/learn');
  await expect(recap(page)).toHaveText('Today: 1 lesson read.');
  await expect(weekly(page)).toContainText('1 of 2 days so far.');
});

test('progress summary: plain text, copied only on the button, no scores or name', async ({ page, context }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await page.goto('#/sandbox');
  await runCommand(page, 'whoami');
  await page.goto('#/learn');
  await page.getByText('See what it says').click();
  const preview = page.getByTestId('progress-summary');
  await expect(preview).toContainText('My progress in Terminus CertSim');
  await expect(preview).toContainText('Learning paths: none started yet');
  await expect(preview).toContainText(/Labs finished: 0 of \d+/);
  await expect(preview).toContainText('Badges (2): whoami; hello, world');
  await page.getByRole('button', { name: 'Copy my progress summary' }).click();
  await expect(page.getByText('Copied.')).toBeVisible();
  const copied = await page.evaluate(() => navigator.clipboard.readText());
  expect(copied.split('\n')[0]).toMatch(/^My progress in Terminus CertSim/);
  expect(copied).toContain('Badges (2): whoami; hello, world');
  expect(copied).not.toMatch(/%|score/i);
});

test('badge links explain a badge and carry nothing personal', async ({ page }) => {
  await page.goto('#/badge/plumber');
  await expect(page.getByRole('heading', { level: 1, name: 'Plumber' })).toBeVisible();
  await expect(page.getByText('You joined two commands with a pipe and got output.')).toBeVisible();
  await expect(page.getByRole('heading', { name: 'How it is earned' })).toBeVisible();
  await expect(page.getByText('You have this badge in this browser.')).toHaveCount(0);
  await expect(page).toHaveTitle(/Badge/);

  // Hidden badges stay a surprise
  await page.goto('#/badge/sandwich');
  await expect(page.getByText('This badge is a surprise.')).toBeVisible();

  await page.goto('#/badge/no-such-badge');
  await expect(page.getByRole('heading', { name: 'No badge with that name' })).toBeVisible();

  // An earned badge links to its page; the page says you have it, from this browser only
  await page.goto('#/sandbox');
  await runCommand(page, 'ls | wc -l');
  await page.goto('#/learn');
  await page.getByRole('list', { name: 'Badges earned' }).getByRole('link', { name: 'Plumber' }).click();
  await expect(page).toHaveURL(/#\/badge\/plumber$/);
  await expect(page.getByText('You have this badge in this browser.')).toBeVisible();
});
