import { test, expect, headerProgress, runCommand, showTerminal } from './fixtures';
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
