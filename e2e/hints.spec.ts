import { test, expect, runCommand, showLab, showTerminal, takeCheckpoint, terminalLog } from './fixtures';
import type { Page } from '@playwright/test';
import { LEARNING_PATHS } from '../src/data/paths';
import { LPI_MODULES } from '../src/data/lpiModules';
import { correctNeeded } from '../src/lib/journey';

const HARDWARE_LAB = '#/linux/lpi-101-1-system-architecture';
const hardware = LPI_MODULES.find(m => m.id === 'lpi-101-1-system-architecture')!;
const lspci = hardware.objectives.find(o => o.id === 'hw-lspci')!;

test('hint ladder: a nudge, then the shape, then the full hint, at no cost', async ({ page }) => {
  await page.goto(HARDWARE_LAB);
  await showLab(page);
  const task = page.getByRole('listitem').filter({ hasText: lspci.title });

  await expect(task.getByText('Hints never cost anything.')).toBeVisible();
  // Only the first task carries the note
  await expect(page.getByText('Hints never cost anything.')).toHaveCount(1);
  await expect(task.getByText('Many hardware listing tools', { exact: false })).toBeHidden();

  await task.getByRole('button', { name: 'Show a nudge' }).click();
  await expect(task.getByText('Many hardware listing tools', { exact: false })).toBeVisible();
  await expect(task.getByText(lspci.shape!)).toBeHidden();

  await task.getByRole('button', { name: 'Show more' }).click();
  await expect(task.getByText(lspci.shape!)).toBeVisible();
  await expect(task.getByText('On a real system, lspci -k', { exact: false })).toBeHidden();

  await task.getByRole('button', { name: 'Show more' }).click();
  await expect(task.getByText('On a real system, lspci -k', { exact: false })).toBeVisible();
  // The ladder is used up: no more rungs, and focus stays on the hint controls
  await expect(task.getByRole('button', { name: 'Show more' })).toHaveCount(0);
  await expect(task.getByRole('button', { name: 'Hide hints' })).toBeFocused();

  // No count of hints anywhere on the page
  await expect(page.getByText(/hints? used|\d+ hints?/i)).toHaveCount(0);

  await task.getByRole('button', { name: 'Hide hints' }).click();
  await expect(task.getByText('Many hardware listing tools', { exact: false })).toBeHidden();
  await expect(task.getByRole('button', { name: 'Show a nudge' })).toBeVisible();
  // "Hide hints" goes away with the hints; focus moves to the button that brings them back
  await expect(task.getByRole('button', { name: 'Show a nudge' })).toBeFocused();
});

test('a hint opened on a task already done does not count towards "Hints are tools"', async ({ page }) => {
  await page.goto(HARDWARE_LAB);
  await page.evaluate(() => localStorage.setItem('certsim:progress:v1', JSON.stringify({ 'lpi-101-1-system-architecture': ['hw-lspci'] })));
  await page.reload();
  await showLab(page);
  const task = page.getByRole('listitem').filter({ hasText: lspci.title });
  await task.getByRole('button', { name: 'Show a nudge' }).click();
  await expect(task.getByText('Many hardware listing tools', { exact: false })).toBeVisible();
  const facts = async () => JSON.parse((await page.evaluate(() => localStorage.getItem('certsim:activity:v1'))) ?? '{"facts":[]}').facts as string[];
  // A hint on an open task still counts
  const lsmod = page.getByRole('listitem').filter({ hasText: hardware.objectives.find(o => o.id === 'hw-lsmod')!.title });
  await lsmod.getByRole('button', { name: 'Show a nudge' }).click();
  await expect.poll(facts).toContain('hint:lpi-101-1-system-architecture/hw-lsmod');
  expect(await facts()).not.toContain('hint:lpi-101-1-system-architecture/hw-lspci');
});

test('did you mean: a mistyped command gets a suggestion in the note, the shell output is unchanged', async ({ page }) => {
  await page.goto(HARDWARE_LAB);
  await showTerminal(page);
  await runCommand(page, 'lspic');
  const log = terminalLog(page);
  await expect(log).toContainText('bash: lspic: command not found');
  await expect(log).toContainText('There is no command named lspic. Did you mean lspci?');
  // The suggestion is a note, not part of the error output
  await expect(log.locator('pre', { hasText: 'Did you mean' })).toHaveCount(0);
});

const path = LEARNING_PATHS.find(p => p.stages[0].steps.some(s => s.kind === 'quiz'))!;
const quiz = path.stages[0].steps.find(s => s.kind === 'quiz')!;
if (quiz.kind !== 'quiz') throw new Error('expected a quiz');

/** Answers each question in the order shown, right only where `right(i)` says so. */
async function takeQuiz(page: Page, right: (i: number) => boolean) {
  if (quiz.kind !== 'quiz') return;
  await takeCheckpoint(page, quiz.questions, (_, i) => right(i));
}

test('quiz not passed yet: neutral, missed explanations first, compared with the best so far', async ({ page }) => {
  const total = quiz.questions.length;
  test.skip(correctNeeded(total, quiz.passMark) < 2, 'needs a quiz that one right answer does not pass');
  await page.goto(`#/learn/${path.id}/${quiz.id}`);

  await takeQuiz(page, () => false);
  const status = page.getByText('Not passed yet.', { exact: false });
  await expect(status).toBeVisible();
  // Neutral text, not the error color
  await expect(status).not.toHaveClass(/text-danger/);
  await expect(page.locator('.text-danger')).toHaveCount(0);
  await expect(page.getByRole('heading', { name: 'Questions to look at again' })).toBeVisible();
  // Missed questions come first, with their explanations
  await expect(page.getByText(quiz.questions[0].explanation)).toBeVisible();
  await expect(page.getByText(/than your best so far/)).toHaveCount(0);

  await page.getByRole('button', { name: 'Try again' }).click();
  await takeQuiz(page, i => i === 0);
  await expect(page.getByText('1 right, one more than your best so far.')).toBeVisible();
  await expect(page.getByRole('heading', { name: 'You got these right' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Try again' })).toBeVisible();
});

test('commands in task text and hints show as code, and the quotes a command needs stay on screen', async ({ page, isMobile }) => {
  test.skip(isMobile, 'same rendering on both projects');
  // Windows first steps: the command named type is marked, so "type type" never reads as one muddle
  await page.goto('#/learn/first-steps/lab-first-steps-windows');
  const read = page.getByRole('listitem').filter({ hasText: 'Read a file' });
  await expect(read.locator('code', { hasText: /^type$/ }).first()).toBeVisible();
  await read.getByRole('button', { name: 'Show a nudge' }).click();
  await read.getByRole('button', { name: 'Show more' }).click();
  await read.getByRole('button', { name: 'Show more' }).click();
  await expect(read.locator('code', { hasText: /^type welcome\.txt$/ })).toBeVisible();
  await expect(read.getByText(/type type/i)).toHaveCount(0);

  // A hint whose command has quotes in it shows them, so copying it gives the right command
  await page.goto('#/linux/lpi-103-2-text-processing');
  await showLab(page);
  const find = page.getByRole('listitem').filter({ hasText: 'Find the failed logins' });
  await find.getByRole('button', { name: 'Show a nudge' }).click();
  await find.getByRole('button', { name: 'Show more' }).click();
  await find.getByRole('button', { name: 'Show more' }).click();
  await expect(find.locator('code', { hasText: 'grep "Failed password" /var/log/auth.log' })).toBeVisible();
});
