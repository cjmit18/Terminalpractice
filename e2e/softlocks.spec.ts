import { test, expect, takeCheckpoint } from './fixtures';
import type { Page } from '@playwright/test';
import { LEARNING_PATHS } from '../src/data/paths';

// Later stages are suggested, not locked: a learner who knows the material can go ahead.
const path = LEARNING_PATHS.find(p => p.id === 'lpic1-101')!;
const [first, second] = path.stages;
const lesson = second.steps.find(s => s.kind === 'lesson')!;
const quiz = second.steps.find(s => s.kind === 'quiz')!;
if (lesson.kind !== 'lesson' || quiz.kind !== 'quiz') throw new Error('expected a lesson and a checkpoint in stage 2');
const stageLessons = second.steps.filter(s => s.kind === 'lesson');
const notice = `Suggested after ${first.title}. Go ahead if you know it already.`;

/** Stage 2's heading button (later stages mention it in their own "Suggested after" line) */
const stageButton = (page: Page) => page.getByRole('button', { name: new RegExp(`^Stage 2 ${second.title}`) });

const journey = async (page: Page) =>
  JSON.parse((await page.evaluate(() => localStorage.getItem('certsim:journey:v1'))) ?? '{}');

test('a later stage says when it is suggested and every step in it opens', async ({ page }) => {
  await page.goto(`#/learn/${path.id}`);
  await expect(page.getByText('Locked')).toHaveCount(0);
  const stage = stageButton(page);
  await expect(stage).toContainText(notice);
  await stage.click();
  await page.getByRole('link', { name: new RegExp(lesson.title) }).click();

  await expect(page.getByRole('heading', { level: 1, name: lesson.title })).toBeVisible();
  const banner = page.getByRole('note');
  await expect(banner).toContainText(notice);
  // The suggested order is still offered first
  await banner.getByRole('link').click();
  await expect(page).toHaveURL(new RegExp(`#/learn/${path.id}/${first.steps[0].id}$`));
  await expect(page.getByRole('note')).toHaveCount(0);

  // Continue on the overview still starts at the beginning
  await page.goto(`#/learn/${path.id}`);
  await expect(page.getByRole('main').getByRole('link', { name: /^(Start|Continue)$/ })).toHaveAttribute(
    'href',
    `#/learn/${path.id}/${first.steps[0].id}`,
  );
});

test('passing a later checkpoint tests out of that stage: its lessons are marked as known', async ({ page }) => {
  await page.goto(`#/learn/${path.id}/${quiz.id}`);
  await expect(page.getByRole('note')).toContainText('Passing this checkpoint marks the lessons in this stage as known.');
  await takeCheckpoint(page, quiz.questions, () => true);
  await expect(page.getByText(/^You passed\./)).toBeVisible();
  await expect(page.getByText(/so the (lesson|\d+ lessons) in this stage (is|are) marked as known/)).toBeVisible();

  const saved = await journey(page);
  for (const l of stageLessons) expect(saved.read).toContain(`${path.id}/${l.id}`);
  // Stage 1 is untouched
  expect(saved.read.some((k: string) => first.steps.some(s => `${path.id}/${s.id}` === k))).toBe(false);

  await page.goto(`#/learn/${path.id}`);
  const stage = stageButton(page);
  await stage.click();
  const done = stageLessons.length + 1; // the lessons and the checkpoint
  await expect(stage).toContainText(`${done} of ${second.steps.length} done`);
});
