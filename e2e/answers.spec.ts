import { test, expect, takeCheckpoint } from './fixtures';
import type { BrowserContext } from '@playwright/test';
import { LEARNING_PATHS } from '../src/data/paths';

// Opt-in most-missed questions (portal part 9c). The preview server has no Worker behind it, so the
// sharing and answers API is stubbed here.

const USER = { id: 'u1', name: 'Casey', login: null, email: 'casey@example.com', emailVerified: true, avatarUrl: null };
const path = LEARNING_PATHS.find(p => p.id === 'lpic1-101')!;
const quiz = path.stages[0].steps.find(s => s.kind === 'quiz')!;
if (quiz.kind !== 'quiz') throw new Error('expected a checkpoint');

async function answersApi(context: BrowserContext, share: boolean) {
  const stub = { share, puts: [] as unknown[], answers: [] as { key: string; right: boolean }[] };
  await context.route('**/api/answers/sharing', async route => {
    const req = route.request();
    if (req.method() === 'PUT') {
      const body = req.postDataJSON() as { share: boolean };
      stub.puts.push(body);
      stub.share = body.share;
      if (!body.share) stub.answers = [];
      return route.fulfill({ json: { share: stub.share } });
    }
    return route.fulfill({ json: { share: stub.share, questions: 0 } });
  });
  await context.route('**/api/answers', async route => {
    if (!stub.share) return route.fulfill({ status: 409, json: { error: 'not_sharing', message: 'Sharing answers is turned off for this account.' } });
    stub.answers.push(...(route.request().postDataJSON() as { answers: { key: string; right: boolean }[] }).answers);
    return route.fulfill({ status: 204 });
  });
  // The security page's own calls, enough to render it
  await context.route(/\/api\/account(\/.*)?$/, route => {
    const p = new URL(route.request().url()).pathname;
    if (p === '/api/account/sessions') return route.fulfill({ json: { sessions: [] } });
    return route.fulfill({ json: { user: USER, identities: [], signInMethods: ['email'], hasPassword: true, createdAt: 1 } });
  });
  return stub;
}

test.describe('signed in', () => {
  test.use({ me: { user: USER, providers: { github: false, email: true }, emailSending: true } });

  test('sharing is off by default: checkpoint answers stay in this browser', async ({ page, context }) => {
    const stub = await answersApi(context, false);
    let posted = 0;
    page.on('request', req => {
      if (req.url().endsWith('/api/answers')) posted++;
    });
    await page.goto('#/account/security');
    await expect(page.getByRole('checkbox', { name: 'Share which questions I miss' })).not.toBeChecked();

    await page.goto(`#/learn/${path.id}/${quiz.id}`);
    await takeCheckpoint(page, quiz.questions, (_, i) => i !== 0);
    // Hidden tabs send what is queued at once; with sharing off nothing is queued
    await page.evaluate(() => window.dispatchEvent(new Event('pagehide')));
    await page.waitForTimeout(300);
    expect(posted).toBe(0);
    expect(stub.answers).toEqual([]);
  });

  test('turned on, each answer sends its question and whether it was right; turned off, the server deletes them', async ({ page, context }) => {
    const stub = await answersApi(context, false);
    await page.goto('#/account/security');
    const box = page.getByRole('checkbox', { name: 'Share which questions I miss' });
    await box.check();
    await expect(page.getByText('Thanks! Your answers now help improve the questions.')).toBeVisible();
    expect(stub.puts).toEqual([{ share: true }]);

    await page.goto(`#/learn/${path.id}/${quiz.id}`);
    const shown = await takeCheckpoint(page, quiz.questions, (_, i) => i !== 0);
    await page.evaluate(() => window.dispatchEvent(new Event('pagehide')));
    await expect.poll(() => stub.answers.length).toBe(shown.length);
    expect(stub.answers).toEqual(shown.map((q, i) => ({ key: `${path.id}/${q.id}`, right: i !== 0 })));

    await page.goto('#/account/security');
    await box.uncheck();
    await expect(page.getByText('Sharing is off, and the answers you shared are deleted.')).toBeVisible();
    expect(stub.puts).toEqual([{ share: true }, { share: false }]);
    expect(stub.answers).toEqual([]);
  });
});

test.describe('the owner', () => {
  const OWNER = { ...USER, name: 'CJ', email: 'owner@example.com' };
  test.use({ me: { user: OWNER, role: 'owner', providers: { github: true, email: true }, emailSending: true } });

  test('the dashboard lists the most-missed questions by their text', async ({ page, context }) => {
    const [q1, q2] = quiz.questions;
    await context.route('**/api/admin/stats', route =>
      route.fulfill({
        json: {
          asOf: 1,
          accounts: { total: 0, newLast7Days: 0, newLast30Days: 0, emailConfirmed: 0, withPassword: 0, withGithub: 0 },
          activity: { signedInLast7Days: 0, liveSessions: 0 },
          progress: { accountsWithProgress: 0, tasksDone: 0, lessonsRead: 0, quizzesTaken: 0 },
        },
      }),
    );
    await context.route('**/api/admin/admins', route => route.fulfill({ json: { admins: [] } }));
    await context.route('**/api/admin/missed', route =>
      route.fulfill({
        json: {
          asOf: 1,
          learnersSharing: 4,
          questions: [
            { key: `${path.id}/${q1.id}`, learners: 3, missedBy: 2, answered: 5, missed: 3 },
            { key: `${path.id}/${q2.id}`, learners: 1, missedBy: 1, answered: 1, missed: 1 },
            { key: `${path.id}/q-gone`, learners: 1, missedBy: 1, answered: 2, missed: 1 },
          ],
        },
      }),
    );
    await page.goto('#/admin');
    await expect(page.getByText('(4 now)')).toBeVisible();
    const items = page.getByRole('list', { name: 'Most-missed questions' }).getByRole('listitem');
    await expect(items).toHaveCount(3);
    await expect(items.nth(0)).toContainText(q1.prompt);
    await expect(items.nth(0)).toContainText(`${path.title} · ${quiz.title} · missed by 2 of 3 learners · 60% of 5 answers wrong`);
    await expect(items.nth(1)).toContainText('missed by 1 of 1 learner · 100% of 1 answer wrong');
    await expect(items.nth(2)).toContainText('A question no longer in the app');
  });
});
