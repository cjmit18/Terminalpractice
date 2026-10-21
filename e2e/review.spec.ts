import { test, expect } from './fixtures';
import type { Page } from '@playwright/test';
import { LEARNING_PATHS } from '../src/data/paths';
import type { QuizQuestion } from '../src/types/paths';

const JOURNEY_KEY = 'certsim:journey:v1';
const DAY = 86_400_000;

const quizOf = (pathId: string) => {
  const path = LEARNING_PATHS.find(p => p.id === pathId)!;
  const quiz = path.stages[0].steps.find(s => s.kind === 'quiz')!;
  if (quiz.kind !== 'quiz') throw new Error('expected a checkpoint');
  return { path, quiz };
};
const linux = quizOf('lpic1-101');
const windows = quizOf('aplus-core2');
const allQuestions: QuizQuestion[] = LEARNING_PATHS.flatMap(p =>
  p.stages.flatMap(s => s.steps.flatMap(st => (st.kind === 'quiz' ? st.questions : []))),
);

const journey = async (page: Page) => JSON.parse((await page.evaluate(k => localStorage.getItem(k), JOURNEY_KEY)) ?? '{}');

/** Answer the question on screen, right or wrong, and move on. */
async function answer(page: Page, right: boolean, nextLabel: string) {
  const legend = page.getByRole('main').locator('fieldset legend span[tabindex="-1"]');
  const prompt = (await legend.textContent())?.trim() ?? '';
  const q = allQuestions.find(x => x.prompt === prompt);
  if (!q) throw new Error(`unknown question: ${prompt}`);
  const choice = right ? q.answer : (q.answer + 1) % q.choices.length;
  await page.getByRole('main').getByRole('group', { name: q.prompt }).getByRole('radio').nth(choice).check();
  await page.getByRole('button', { name: 'Check answer' }).click();
  await expect(page.getByText(right ? 'Correct.' : 'Not quite.', { exact: false }).first()).toBeVisible();
  await page.getByRole('button', { name: nextLabel }).click();
  return q;
}

test('checkpoint answers are saved for review, one record per question', async ({ page }) => {
  const { path, quiz } = linux;
  await page.goto(`#/learn/${path.id}/${quiz.id}`);
  for (const [i, q] of quiz.questions.entries()) {
    const choice = i === 0 ? (q.answer + 1) % q.choices.length : q.answer;
    await page.getByRole('main').getByRole('group', { name: q.prompt }).getByRole('radio').nth(choice).check();
    await page.getByRole('button', { name: 'Check answer' }).click();
    await page.getByRole('button', { name: i < quiz.questions.length - 1 ? 'Next question' : 'See your score' }).click();
  }
  const saved = await journey(page);
  for (const [i, q] of quiz.questions.entries()) {
    expect(saved.answers[`${path.id}/${q.id}`].history).toEqual([i !== 0]);
  }

  // Nothing is due yet (the missed one comes back after a short break): the Learn page says so, no count
  await page.goto('#/learn');
  await expect(page.getByText('Nothing to review right now. The next checkpoint question comes back later today.')).toBeVisible();
  await expect(page.getByRole('link', { name: 'Review a few questions' })).toHaveCount(0);
  await expect(page.getByRole('banner')).not.toContainText('Review');
});

test('review: five due questions across paths, missed ones first, no score, and when they come back', async ({ page }) => {
  // Saved answers: two missed a day ago, three answered right two days ago, one right an hour ago (not due)
  await page.goto('#/learn');
  const now = Date.now();
  const lq = linux.quiz.questions;
  const wq = windows.quiz.questions;
  const answers: Record<string, { history: boolean[]; lastAt: number }> = {
    [`${linux.path.id}/${lq[0].id}`]: { history: [false], lastAt: now - DAY - 2000 },
    [`${windows.path.id}/${wq[0].id}`]: { history: [false], lastAt: now - DAY - 1000 },
    [`${linux.path.id}/${lq[1].id}`]: { history: [true], lastAt: now - 2 * DAY },
    [`${windows.path.id}/${wq[1].id}`]: { history: [true], lastAt: now - 2 * DAY },
    [`${linux.path.id}/${lq[2].id}`]: { history: [true], lastAt: now - 2 * DAY },
    [`${windows.path.id}/${wq[2].id}`]: { history: [true], lastAt: now - 3600_000 },
  };
  await page.evaluate(([k, v]) => localStorage.setItem(k, v), [JOURNEY_KEY, JSON.stringify({ read: [], quiz: {}, last: null, answers })]);
  await page.reload();

  await page.getByRole('link', { name: 'Review a few questions' }).click();
  await expect(page).toHaveURL(/#\/learn\/review$/);
  await expect(page.getByRole('heading', { level: 1, name: 'Review' })).toBeVisible();
  await expect(page).toHaveTitle(/^Review · Learn/);

  // Missed ones first, one from each path; the first is answered wrong again, the rest right
  await expect(page.getByText(`From ${linux.path.title}, ${linux.quiz.title}`)).toBeVisible();
  const asked = [await answer(page, false, 'Next question')];
  await expect(page.getByText(`From ${windows.path.title}, ${windows.quiz.title}`)).toBeVisible();
  for (let i = 1; i < 5; i++) asked.push(await answer(page, true, i < 4 ? 'Next question' : 'Finish'));
  expect(asked.map(q => q.id)).toEqual([lq[0].id, wq[0].id, lq[1].id, wq[1].id, lq[2].id]);

  await expect(page.getByRole('heading', { name: '4 of 5 right.' })).toBeVisible();
  await expect(page.getByText('1 comes back soon, 1 tomorrow and 3 in a few days.')).toBeVisible();
  // No score or percentage
  await expect(page.getByRole('main')).not.toContainText('%');
  await expect(page.getByRole('main')).not.toContainText('score');
  // Nothing else is due, so no second round is offered
  await expect(page.getByRole('button', { name: 'Review a few more' })).toHaveCount(0);

  const saved = await journey(page);
  expect(saved.answers[`${linux.path.id}/${lq[0].id}`].history).toEqual([false, false]);
  expect(saved.answers[`${windows.path.id}/${wq[0].id}`].history).toEqual([false, true]);
  expect(saved.answers[`${linux.path.id}/${lq[1].id}`].history).toEqual([true, true]);
  expect(saved.answers[`${windows.path.id}/${wq[2].id}`].history).toEqual([true]);
  // Recorded as a learning moment for the game layer
  const activity = JSON.parse((await page.evaluate(() => localStorage.getItem('certsim:activity:v1'))) ?? '{}');
  expect(activity.facts).toContain('review:done');

  await page.getByRole('link', { name: 'Back to learning paths' }).click();
  await expect(page).toHaveURL(/#\/learn$/);
  await expect(page.getByText('Nothing to review right now.', { exact: false })).toBeVisible();
});

test('review with nothing answered yet says how it works', async ({ page }) => {
  await page.goto('#/learn/review');
  await expect(page.getByRole('heading', { level: 1, name: 'Review' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Nothing to review right now' })).toBeVisible();
  await expect(page.getByText('Take a checkpoint in any path first.', { exact: false })).toBeVisible();
  await page.goto('#/learn');
  await expect(page.getByRole('link', { name: 'Review a few questions' })).toHaveCount(0);
  await expect(page.getByText('Nothing to review right now', { exact: false })).toHaveCount(0);
});

test('a path reset clears its saved answers', async ({ page }) => {
  await page.goto('#/learn');
  const key = `${linux.path.id}/${linux.quiz.questions[0].id}`;
  const other = `${windows.path.id}/${windows.quiz.questions[0].id}`;
  await page.evaluate(
    ([k, v]) => localStorage.setItem(k, v),
    [
      JOURNEY_KEY,
      JSON.stringify({
        read: [],
        quiz: { [`${linux.path.id}/${linux.quiz.id}`]: { correct: 1, total: linux.quiz.questions.length } },
        last: null,
        answers: { [key]: { history: [false], lastAt: Date.now() - DAY }, [other]: { history: [true], lastAt: Date.now() } },
      }),
    ],
  );
  await page.goto(`#/learn/${linux.path.id}`);
  await page.reload();
  page.once('dialog', d => void d.accept());
  await page.getByRole('button', { name: 'Reset path progress' }).click();
  await expect.poll(async () => Object.keys((await journey(page)).answers ?? {})).toEqual([other]);
});
