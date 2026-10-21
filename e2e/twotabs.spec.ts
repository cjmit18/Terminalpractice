import { test, expect, headerProgress, runCommand, showLab, showTerminal, terminalLog } from './fixtures';
import { LEARNING_PATHS } from '../src/data/paths';

const HW_LAB = '#/linux/lpi-101-1-system-architecture';
const PERMISSIONS_LAB = '#/linux/lpi-104-5-permissions';
const PROGRESS_KEY = 'certsim:progress:v1';

const done = (n: number) => new RegExp(`^${n} of \\d+ (lab tasks |tasks )?done$`);
const stored = async (page: import('@playwright/test').Page) =>
  JSON.parse((await page.evaluate(key => localStorage.getItem(key), PROGRESS_KEY)) ?? '{}');

// Two tabs of the app in one browser share localStorage. Neither may overwrite the other's progress,
// each shows the other's progress without a reload, and a reset in one is not undone by the other.
test('two tabs: progress from both is kept and shown in both; a reset reaches the other tab', async ({ page, context }) => {
  const tab1 = page;
  await tab1.goto(HW_LAB);
  const tab2 = await context.newPage();
  await tab2.goto(PERMISSIONS_LAB);

  await showTerminal(tab1);
  for (const c of ['lspci', 'lsmod', 'dmesg | grep -i sata']) await runCommand(tab1, c);
  await expect(headerProgress(tab1)).toHaveText(done(3));
  // Tab 2 learns about tab 1's work from the storage event
  await expect(headerProgress(tab2)).toHaveText(done(3));

  await showTerminal(tab2);
  await runCommand(tab2, 'chmod 750 /home/student/finance');
  await expect(headerProgress(tab2)).toHaveText(done(4));

  const saved = await stored(tab2);
  expect(saved['lpi-101-1-system-architecture']).toEqual(['hw-lspci', 'hw-lsmod', 'hw-dmesg']);
  expect(saved['lpi-104-5-permissions']).toEqual(['perm-chmod']);
  // Tab 1 shows both without a reload
  await expect(headerProgress(tab1)).toHaveText(done(4));

  // Reset the Linux track in tab 1; tab 2 still holds the old copy in memory
  await tab1.goto('#/linux');
  tab1.once('dialog', dialog => void dialog.accept());
  await tab1.getByRole('button', { name: 'Reset progress' }).click();
  await expect(headerProgress(tab1)).toHaveText(done(0));
  await expect(headerProgress(tab2)).toHaveText(done(0));

  // New work in tab 2 after the reset counts, and the old progress does not come back
  await runCommand(tab2, 'umask 027');
  await expect(headerProgress(tab2)).toHaveText(done(1));
  await expect(headerProgress(tab1)).toHaveText(done(1));
  const after = await stored(tab1);
  expect(after['lpi-101-1-system-architecture']).toBeUndefined();
  expect(after['lpi-104-5-permissions']).toEqual(['perm-umask']);

  await tab1.reload();
  await expect(headerProgress(tab1)).toHaveText(done(1));
  await tab2.close();
});

// The lab's own checklist follows the other tab too, and a reset there lets this tab earn tasks again
test('two tabs on one lab: completions and resets from the other tab reach the running lab', async ({ page, context }) => {
  const tab1 = page;
  await tab1.goto(HW_LAB);
  const tab2 = await context.newPage();
  await tab2.goto(HW_LAB);
  const tasks = (p: import('@playwright/test').Page) => p.getByText(/^\d of 3 done$/);

  await showTerminal(tab1);
  await runCommand(tab1, 'lspci');
  await expect(headerProgress(tab2)).toHaveText(done(1));
  await expect(tasks(tab2)).toHaveText('1 of 3 done');

  // Work typed in tab 2 before the reset is still on its machine; the reset does not restart it
  await showTerminal(tab2);
  await runCommand(tab2, 'echo kept > /home/student/marker');
  await tab1.goto('#/linux');
  tab1.once('dialog', dialog => void dialog.accept());
  await tab1.getByRole('button', { name: 'Reset progress' }).click();
  await expect(headerProgress(tab2)).toHaveText(done(0));
  await runCommand(tab2, 'lspci');
  await expect(headerProgress(tab2)).toHaveText(done(1));
  await expect(headerProgress(tab1)).toHaveText(done(1));
  await runCommand(tab2, 'cat /home/student/marker');
  await expect(terminalLog(tab2)).toContainText('kept');
  await showLab(tab2);
  await expect(tasks(tab2)).toHaveText('1 of 3 done');
  await tab2.close();
});

// An older build (an old tab after a deploy, or a rollback) must never delete what a newer build saved
test('progress for labs, tasks, paths and steps this build does not know is kept', async ({ page }) => {
  const seededProgress = { 'future-lab-xyz': ['obj1'], 'lpi-101-1-system-architecture': ['hw-lspci', 'future-obj'] };
  const seededJourney = { read: ['future-path/intro', 'lpic1-101/how-linux-sees-hardware'], quiz: { 'future-path/quiz': { correct: 3, total: 4 } }, last: { pathId: 'future-path', stepId: 'intro', at: 1 } };
  await page.goto('#/learn');
  await page.evaluate(([p, j]) => {
    localStorage.setItem('certsim:progress:v1', JSON.stringify(p));
    localStorage.setItem('certsim:journey:v1', JSON.stringify(j));
  }, [seededProgress, seededJourney] as const);
  await page.reload();
  await page.goto(HW_LAB);
  await expect(headerProgress(page)).toHaveText(done(1));
  const journeyText = async () => (await page.evaluate(() => localStorage.getItem('certsim:journey:v1'))) ?? '';
  expect(await stored(page)).toEqual(seededProgress);
  expect(JSON.parse(await journeyText())).toEqual(seededJourney);

  // Saving new work keeps it too
  await showTerminal(page);
  await runCommand(page, 'lsmod');
  await expect(headerProgress(page)).toHaveText(done(2));
  expect(await stored(page)).toEqual({ ...seededProgress, 'lpi-101-1-system-architecture': ['hw-lspci', 'hw-lsmod', 'future-obj'] });
  await page.goto('#/learn/lpic1-101/how-linux-sees-hardware');
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
  const journey = JSON.parse(await journeyText());
  expect(journey.read).toEqual(expect.arrayContaining(['future-path/intro']));
  expect(journey.quiz['future-path/quiz']).toEqual({ correct: 3, total: 4 });
});

// A command's own result is fresh evidence: when it was this tab's last command at the reset, running
// it again still earns the task (only unchanged machine state waits to stop passing once)
test('two tabs on one lab: a reset does not hold back a task whose command was the last one run here', async ({ page, context }) => {
  const tab1 = page;
  await tab1.goto(HW_LAB);
  const tab2 = await context.newPage();
  await tab2.goto(HW_LAB);

  await showTerminal(tab1);
  await runCommand(tab1, 'lspci');
  await expect(headerProgress(tab2)).toHaveText(done(1));
  await showTerminal(tab2);
  await runCommand(tab2, 'lspci');

  await tab1.goto('#/linux');
  tab1.once('dialog', dialog => void dialog.accept());
  await tab1.getByRole('button', { name: 'Reset progress' }).click();
  await expect(headerProgress(tab2)).toHaveText(done(0));
  await runCommand(tab2, 'lspci');
  await expect(headerProgress(tab2)).toHaveText(done(1));
  expect((await stored(tab2))['lpi-101-1-system-architecture']).toEqual(['hw-lspci']);
  await tab2.close();
});

// Two tabs open on different steps must not keep re-stamping "last step opened" over each other
test('two tabs on different learning steps settle instead of ping-ponging the last step', async ({ page, context }) => {
  const path = LEARNING_PATHS[0];
  const [a, b] = path.stages.flatMap(s => s.steps);
  const last = async () => JSON.parse((await page.evaluate(() => localStorage.getItem('certsim:journey:v1'))) ?? '{}').last;
  await page.goto(`#/learn/${path.id}/${a.id}`);
  const tab2 = await context.newPage();
  await tab2.goto(`#/learn/${path.id}/${b.id}`);
  await expect.poll(async () => (await last())?.stepId).toBe(b.id);
  const settled = await last();
  await page.waitForTimeout(1000);
  expect(await last()).toEqual(settled);
  // Opening a step is still a visit
  await page.goto(`#/learn/${path.id}`);
  await page.goto(`#/learn/${path.id}/${a.id}`);
  await expect.poll(async () => (await last())?.stepId).toBe(a.id);
  await tab2.close();
});
