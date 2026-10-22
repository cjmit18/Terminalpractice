import type { Page } from '@playwright/test';
import { test, expect, runCommand, showTerminal } from './fixtures';

const ACTIVITY_KEY = 'certsim:activity:v1';
const celebrations = (page: Page) => page.getByRole('status', { name: 'Celebrations' });
const earnedList = (page: Page) => page.getByRole('list', { name: 'Badges earned' });
const storedActivity = async (page: Page) => JSON.parse((await page.evaluate(k => localStorage.getItem(k), ACTIVITY_KEY)) ?? '{}');

test('a command earns badges: one polite note, then listed on the Learn page; nothing typed is stored', async ({ page }) => {
  await page.goto('#/sandbox');
  await runCommand(page, 'whoami');
  await expect(celebrations(page)).toHaveText('2 badges earned: whoami; hello, world.');
  await expect(page.getByTestId('celebration-note')).toBeVisible();
  await page.getByRole('button', { name: 'Dismiss note' }).click();
  await expect(page.getByTestId('celebration-note')).toHaveCount(0);

  await runCommand(page, 'echo my-secret-word > notes.txt');
  const saved = await storedActivity(page);
  expect(JSON.stringify(saved)).not.toContain('my-secret-word');
  expect(JSON.stringify(saved)).not.toContain('notes.txt');
  expect(saved.facts).toContain('redirect');

  await page.goto('#/learn');
  await expect(page.getByRole('heading', { name: 'Your badges' })).toBeVisible();
  await expect(earnedList(page)).toContainText('Badge earned: whoami. You asked the machine who you are.');
  await expect(earnedList(page)).toContainText('> saved');
  // Hidden badges are not listed until earned
  await page.getByText('Badges you can still earn').click();
  await expect(page.getByText('sudo make me a sandwich')).toHaveCount(0);
  await expect(page.getByText('How to earn: Open the manual or help page for any command.')).toBeVisible();
});

test('two tabs: a badge earned in one appears in the other without a reload', async ({ page, context }) => {
  await page.goto('#/learn');
  await expect(page.getByText('No badges yet.')).toBeVisible();
  const other = await context.newPage();
  await other.goto('#/sandbox');
  await runCommand(other, 'man ls');
  await expect(earnedList(page)).toContainText('man man');
  await expect(earnedList(page)).toContainText('hello, world');
});

test('a lab task passing is announced in the one status region', async ({ page }) => {
  await page.goto('#/linux/lpi-101-1-system-architecture');
  await showTerminal(page);
  await runCommand(page, 'lspci');
  await expect(celebrations(page)).toContainText('Task 1 of 3 done: List the PCI devices.');
});

test('settings: hide badges, turn celebrations off, clear badges and activity', async ({ page }) => {
  await page.goto('#/sandbox');
  await runCommand(page, 'whoami');
  await expect(celebrations(page)).toContainText('whoami');

  await page.goto('#/learn');
  await page.getByRole('group', { name: 'Celebrations' }).getByRole('radio', { name: /^Off/ }).check();
  await page.getByRole('group', { name: 'Badges' }).getByRole('radio', { name: /^Hide/ }).check();
  await expect(page.getByRole('heading', { name: 'Badges and celebrations', exact: true })).toBeVisible();
  await expect(page.getByText('Badges are hidden.')).toBeVisible();
  await expect(earnedList(page)).toHaveCount(0);
  expect((await storedActivity(page)).prefs).toEqual({ celebrations: 'off', showBadges: false });

  // Off: nothing is announced
  await page.goto('#/sandbox');
  await runCommand(page, 'ls --help');
  await expect(celebrations(page)).toHaveText('');

  await page.goto('#/learn');
  await page.getByRole('group', { name: 'Badges' }).getByRole('radio', { name: /^Show/ }).check();
  await expect(earnedList(page)).toContainText('--help');
  page.once('dialog', d => d.accept());
  await page.getByRole('button', { name: 'Clear badges and activity' }).click();
  await expect(page.getByText('No badges yet.')).toBeVisible();
  const after = await storedActivity(page);
  expect(after.facts).toEqual([]);
  expect(after.prefs).toEqual({ celebrations: 'off', showBadges: true });
});

/** Everything in the first stage of Linux foundations done, except one lesson. */
async function seedAlmostClearedStage(page: Page, celebrationsMode: string) {
  await page.goto('#/learn');
  await page.evaluate(mode => {
    localStorage.setItem('certsim:progress:v1', JSON.stringify({ 'lpi-101-1-system-architecture': ['hw-lspci', 'hw-lsmod', 'hw-dmesg'] }));
    localStorage.setItem(
      'certsim:journey:v1',
      JSON.stringify({ read: ['lpic1-101/how-linux-sees-hardware'], quiz: { 'lpic1-101/quiz-hardware': { correct: 5, total: 5 } }, last: null }),
    );
    localStorage.setItem('certsim:activity:v1', JSON.stringify({ facts: [], days: [], badges: {}, prefs: { celebrations: mode }, prefsAt: 1 }));
  }, celebrationsMode);
  await page.goto('#/learn/lpic1-101/from-power-on-to-login');
  await page.reload();
}

test('a cleared stage: quiet note with the badge; lively adds confetti', async ({ page }) => {
  await seedAlmostClearedStage(page, 'lively');
  // Progress from before is caught up quietly: no note on load
  await expect(celebrations(page)).toHaveText('');
  await page.getByRole('button', { name: 'Mark as read' }).click();
  await expect(celebrations(page)).toContainText('Stage clear: Hardware and boot.');
  await expect(celebrations(page)).toContainText('Badge earned: Stage clear.');
  await expect(page.getByTestId('confetti')).toBeAttached();
});

test('confetti never runs when the system asks for reduced motion', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await seedAlmostClearedStage(page, 'lively');
  await page.getByRole('button', { name: 'Mark as read' }).click();
  await expect(celebrations(page)).toContainText('Stage clear: Hardware and boot.');
  await expect(page.getByTestId('confetti')).toHaveCount(0);
});
