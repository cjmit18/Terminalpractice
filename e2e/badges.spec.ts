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
  // Only the tab where it was earned says so
  await expect(celebrations(other)).toContainText('man man');
  await page.waitForTimeout(500);
  await expect(celebrations(page)).toHaveText('');
});

test('two tabs: clearing badges in one is quiet in the other', async ({ page, context }) => {
  // A finished lab, so a badge comes back after the clear
  await page.goto('#/learn');
  await page.evaluate(() => localStorage.setItem('certsim:progress:v1', JSON.stringify({ 'lpi-101-1-system-architecture': ['hw-lspci', 'hw-lsmod', 'hw-dmesg'] })));
  await page.reload();
  await expect(earnedList(page)).toContainText('First lab');
  const other = await context.newPage();
  await other.goto('#/settings');
  other.once('dialog', d => d.accept());
  await other.getByRole('button', { name: 'Clear badges and activity' }).click();
  await expect.poll(async () => (await storedActivity(page)).clearedAt).toBeTruthy();
  await expect(earnedList(page)).toContainText('First lab');
  await page.waitForTimeout(500);
  await expect(celebrations(page)).toHaveText('');
  await other.close();
});

test('two tabs: a lab finished in one is celebrated there only, and the other catches up quietly (#28, 15)', async ({ page, context }) => {
  // The issue's case: an idle tab used to announce "Lab done" for the other tab's work
  await page.goto('#/learn');
  await expect(page.getByText('No badges yet.')).toBeVisible();
  const other = await context.newPage();
  await other.goto('#/linux/lpi-101-1-system-architecture');
  await showTerminal(other);
  for (const c of ['lspci', 'lsmod', 'dmesg | grep -i sata']) await runCommand(other, c);
  await expect(celebrations(other)).toContainText('Lab done: Determine and configure hardware settings.');
  // This tab shows the badge the lab earned, and says nothing
  await expect(earnedList(page)).toContainText('First lab');
  await page.waitForTimeout(800);
  await expect(celebrations(page)).toHaveText('');
  await expect(page.getByTestId('celebration-note')).toHaveCount(0);

  // Its own work afterwards is still announced
  await page.goto('#/sandbox');
  await runCommand(page, 'man ls');
  await expect(celebrations(page)).toContainText('man man');
  await other.close();
});

test('the note waits while the pointer is over its text, then goes', async ({ page, isMobile }) => {
  test.skip(isMobile, 'hover');
  await page.clock.install();
  await page.goto('#/linux/lpi-101-1-system-architecture');
  await runCommand(page, 'lspci');
  await page.clock.runFor(400);
  const note = page.getByTestId('celebration-note');
  await expect(note).toBeVisible();
  await note.getByText('Task 1 of 3 done', { exact: false }).hover();
  await page.clock.runFor(20_000);
  await expect(note).toBeVisible();
  await page.mouse.move(700, 100);
  await page.clock.runFor(20_000);
  await expect(note).toHaveCount(0);
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

  // The Learn page links to Settings
  await page.goto('#/learn');
  await page.getByRole('link', { name: 'Settings for badges, celebrations and your weekly goal' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Settings' })).toBeVisible();
  await page.getByRole('group', { name: 'Celebrations' }).getByRole('radio', { name: /^Off/ }).check();
  await page.getByRole('group', { name: 'Badges' }).getByRole('radio', { name: /^Hide/ }).check();
  await page.goto('#/learn');
  await expect(page.getByRole('heading', { name: 'Badges and celebrations', exact: true })).toBeVisible();
  await expect(page.getByText('Badges are hidden.')).toBeVisible();
  await expect(earnedList(page)).toHaveCount(0);
  expect((await storedActivity(page)).prefs).toEqual({ celebrations: 'off', showBadges: false });

  // Off: nothing is announced
  await page.goto('#/sandbox');
  await runCommand(page, 'ls --help');
  await expect(celebrations(page)).toHaveText('');

  await page.goto('#/settings');
  await page.getByRole('group', { name: 'Badges' }).getByRole('radio', { name: /^Show/ }).check();
  await page.goto('#/learn');
  await expect(earnedList(page)).toContainText('--help');
  await page.goto('#/settings');
  page.once('dialog', d => d.accept());
  await page.getByRole('button', { name: 'Clear badges and activity' }).click();
  await page.goto('#/learn');
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

test('a stage cleared by marking its last lesson read shows the stage recap', async ({ page }) => {
  await seedAlmostClearedStage(page, 'quiet');
  await expect(page.getByRole('heading', { name: 'Stage clear: Hardware and boot' })).toHaveCount(0);
  await page.getByRole('button', { name: 'Mark as read' }).click();
  await expect(page.getByRole('heading', { level: 2, name: 'Stage clear: Hardware and boot' })).toBeVisible();
});

test('a stage cleared by finishing its lab shows the stage recap', async ({ page }) => {
  await page.goto('#/learn');
  await page.evaluate(() => {
    localStorage.setItem('certsim:progress:v1', JSON.stringify({ 'lpi-101-1-system-architecture': ['hw-lspci', 'hw-lsmod'] }));
    localStorage.setItem(
      'certsim:journey:v1',
      JSON.stringify({
        read: ['lpic1-101/how-linux-sees-hardware', 'lpic1-101/from-power-on-to-login'],
        quiz: { 'lpic1-101/quiz-hardware': { correct: 5, total: 5 } },
        last: null,
      }),
    );
  });
  await page.goto('#/learn/lpic1-101/lab-hardware');
  await page.reload();
  await showTerminal(page);
  await runCommand(page, 'dmesg | grep -i sata');
  const show = page.getByRole('group', { name: 'Show' }).getByRole('button', { name: /^Lab/ });
  if (await show.isVisible()) await show.click();
  await expect(page.getByRole('heading', { level: 2, name: 'Stage clear: Hardware and boot' })).toBeVisible();
});

test('confetti never runs when the system asks for reduced motion', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await seedAlmostClearedStage(page, 'lively');
  await page.getByRole('button', { name: 'Mark as read' }).click();
  await expect(celebrations(page)).toContainText('Stage clear: Hardware and boot.');
  await expect(page.getByTestId('confetti')).toHaveCount(0);
});

/** Saves new preferences as another tab would, and tells this tab with a storage event. */
async function prefsFromAnotherTab(page: Page, prefs: Record<string, unknown>) {
  await page.evaluate(
    ({ key, prefs }) => {
      const a = JSON.parse(localStorage.getItem(key) ?? '{"facts":[],"days":[],"badges":{}}');
      localStorage.setItem(key, JSON.stringify({ ...a, prefs: { ...a.prefs, ...prefs }, prefsAt: Date.now() + 60_000 }));
      window.dispatchEvent(new StorageEvent('storage', { key }));
    },
    { key: ACTIVITY_KEY, prefs },
  );
}

test('celebrations turned off during the batch delay: nothing is said', async ({ page }) => {
  await page.goto('#/sandbox');
  const input = page.getByRole('textbox', { name: 'Command' });
  await input.fill('whoami');
  await input.press('Enter');
  await prefsFromAnotherTab(page, { celebrations: 'off' });
  await page.waitForTimeout(800);
  await expect(celebrations(page)).toHaveText('');
  await expect(page.getByTestId('celebration-note')).toHaveCount(0);
});

test('hiding badges while a note shows drops the badge text and keeps the task', async ({ page }) => {
  await page.goto('#/linux/lpi-101-1-system-architecture');
  await showTerminal(page);
  await runCommand(page, 'lspci');
  await expect(celebrations(page)).toContainText('Task 1 of 3 done');
  await expect(celebrations(page)).toContainText('hello, world');
  await prefsFromAnotherTab(page, { showBadges: false });
  await expect(celebrations(page)).toHaveText('Task 1 of 3 done: List the PCI devices.');
  await expect(page.getByTestId('celebration-note')).not.toContainText('hello, world');
});
