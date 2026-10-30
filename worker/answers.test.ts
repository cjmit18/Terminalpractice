// Portal part 9c: opt-in shared answers and the most-missed questions.
import test from 'node:test';
import assert from 'node:assert/strict';
import { count, sessionOf, setup } from './testkit.ts';
import { ANSWERS_PER_REQUEST, QUESTION_KEYS } from './answers.ts';

const OWNER = 'owner@example.com';
type Setup = ReturnType<typeof setup>;
const as = (session: string | null) => ({ Cookie: `__Host-session=${session}` });
const [Q1, Q2, Q3] = [...QUESTION_KEYS];

async function account(s: Setup, email: string): Promise<string> {
  const session = sessionOf(await s.register({ email }))!;
  s.db.raw.prepare('UPDATE users SET email_verified_at = 1 WHERE email = ?').run(email);
  return session;
}
const share = (s: Setup, session: string, on: boolean) => s.call('PUT', '/api/answers/sharing', { share: on }, as(session));
const send = (s: Setup, session: string, answers: unknown) => s.call('POST', '/api/answers', { answers }, as(session));
const missed = async (s: Setup, session: string) => (await s.call('GET', '/api/admin/missed', undefined, as(session))).json();

test('the question keys are the checkpoint questions the app ships', () => {
  assert.ok(QUESTION_KEYS.size > 50);
  assert.ok(QUESTION_KEYS.has('lpic1-101/q-modprobe-deps'));
  for (const key of QUESTION_KEYS) assert.match(key, /^[^/]+\/[^/]+$/);
});

test('sharing is off by default; answers are refused until it is turned on, then counted', async () => {
  const s = setup();
  const learner = await account(s, 'learner@example.com');
  assert.deepEqual(await (await s.call('GET', '/api/answers/sharing', undefined, as(learner))).json(), { share: false, questions: 0 });
  assert.equal((await s.call('GET', '/api/answers/sharing')).status, 401);

  const refused = await send(s, learner, [{ key: Q1, right: false }]);
  assert.equal(refused.status, 409);
  assert.equal((await refused.json()).error, 'not_sharing');
  assert.equal(count(s.db, 'question_answers'), 0);

  assert.equal((await (await share(s, learner, true)).json()).share, true);
  const answers = [
    { key: Q1, right: false },
    { key: Q1, right: true },
    { key: Q2, right: true },
    { key: 'lpic1-101/a-removed-question', right: false },
  ];
  assert.equal((await send(s, learner, answers)).status, 204);
  assert.equal((await send(s, learner, [{ key: Q1, right: false }])).status, 204);
  const rows = s.db.raw.prepare('SELECT question_key, answered, missed FROM question_answers ORDER BY question_key').all();
  assert.deepEqual(
    rows.map(r => ({ ...r })),
    [
      { question_key: Q1, answered: 3, missed: 2 },
      { question_key: Q2, answered: 1, missed: 0 },
    ].sort((a, b) => a.question_key.localeCompare(b.question_key)),
    'unknown keys are skipped; nothing but the key and counts is kept',
  );
  assert.deepEqual(await (await s.call('GET', '/api/answers/sharing', undefined, as(learner))).json(), { share: true, questions: 2 });
});

test('malformed answers and oversized batches are refused', async () => {
  const s = setup();
  const learner = await account(s, 'learner@example.com');
  await share(s, learner, true);
  for (const bad of [[], 'x', [{ key: Q1 }], [{ key: 1, right: true }], [null]]) {
    assert.equal((await send(s, learner, bad)).status, 400, JSON.stringify(bad));
  }
  const many = Array.from({ length: ANSWERS_PER_REQUEST + 1 }, () => ({ key: Q1, right: true }));
  assert.equal((await send(s, learner, many)).status, 413);
  assert.equal((await s.call('PUT', '/api/answers/sharing', { share: 'yes' }, as(learner))).status, 400);
  assert.equal(count(s.db, 'question_answers'), 0);
});

test('turning sharing off deletes what was sent, even when an answer is on its way', async () => {
  const s = setup();
  const learner = await account(s, 'learner@example.com');
  await share(s, learner, true);
  await send(s, learner, [{ key: Q1, right: false }]);
  await share(s, learner, false);
  assert.equal(count(s.db, 'question_answers'), 0);

  // An answer that passed the opt-in check, then the learner turns sharing off before its write
  await share(s, learner, true);
  const prepare = s.db.prepare.bind(s.db);
  let turnedOff = false;
  s.db.prepare = sql => {
    if (!turnedOff && sql.trimStart().startsWith('INSERT INTO question_answers')) {
      turnedOff = true;
      s.db.raw.prepare('UPDATE users SET share_answers = 0').run();
      s.db.raw.prepare('DELETE FROM question_answers').run();
    }
    return prepare(sql);
  };
  await send(s, learner, [{ key: Q2, right: false }]);
  assert.ok(turnedOff);
  assert.equal(count(s.db, 'question_answers'), 0, 'the write checks the opt-in itself');
});

test('the most-missed list: admins only, learners who share only, ranked by how many learners missed', async () => {
  const s = setup({ OWNER_EMAIL: OWNER });
  const owner = await account(s, OWNER);
  const a = await account(s, 'a@example.com');
  const b = await account(s, 'b@example.com');
  const quiet = await account(s, 'quiet@example.com');
  for (const session of [owner, a, b]) await share(s, session, true);

  // One learner misses Q1 five times; two learners miss Q2 once each; Q3 is only answered right
  await send(s, a, Array.from({ length: 5 }, () => ({ key: Q1, right: false })));
  await send(s, a, [{ key: Q2, right: false }, { key: Q3, right: true }]);
  await send(s, b, [{ key: Q2, right: false }, { key: Q2, right: true }]);
  // The owner's misses never count
  await send(s, owner, Array.from({ length: 9 }, () => ({ key: Q3, right: false })));

  assert.equal((await s.call('GET', '/api/admin/missed', undefined, as(quiet))).status, 403);
  const body = await missed(s, owner);
  assert.equal(body.learnersSharing, 2);
  assert.deepEqual(body.questions, [
    { key: Q2, learners: 2, missedBy: 2, answered: 3, missed: 2 },
    { key: Q1, learners: 1, missedBy: 1, answered: 5, missed: 5 },
  ]);
  assert.ok(!JSON.stringify(body).includes('@'), 'no addresses');
});

test('the export includes shared answers; deleting the account removes them', async () => {
  const s = setup();
  const learner = await account(s, 'learner@example.com');
  await share(s, learner, true);
  await send(s, learner, [{ key: Q1, right: false }]);
  const exported = await (await s.call('GET', '/api/account/export', undefined, as(learner))).json();
  assert.deepEqual(exported.sharedAnswers, { share: true, questions: [{ key: Q1, answered: 1, missed: 1 }] });

  const res = await s.call('DELETE', '/api/account', { confirm: 'delete', currentPassword: 'correct horse battery staple' }, as(learner));
  assert.equal(res.status, 204);
  assert.equal(count(s.db, 'question_answers'), 0);
});
