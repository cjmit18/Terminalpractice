// Opt-in most-missed questions (portal part 9c). A learner who turns sharing on sends, for each checkpoint
// or review answer, the question's key and whether it was right; the admin dashboard shows which questions
// learners miss most, so the content can be improved. Off by default; turning it off deletes what was sent.
//
// Only keys of questions the app ships are stored (others are skipped), never the choice picked or any
// text, and every write checks the opt-in in the same statement, so nothing lands after sharing is off.
import { HttpError, json, noContent, type ApiEnv, type Db, type Route, type RouteContext } from './http';
import { requireUser } from './session';
import { LIMITS, enforceLimit } from './ratelimit';
import type { SyncDb } from './sync';
import { LEARNING_PATHS } from '../src/data/paths';

/** Answers per POST /api/answers; the app sends them in small batches */
export const ANSWERS_PER_REQUEST = 50;

/** Every checkpoint question's key, "pathId/questionId" (the key the app's review queue uses) */
export const QUESTION_KEYS: ReadonlySet<string> = new Set(
  LEARNING_PATHS.flatMap(path =>
    path.stages.flatMap(stage => stage.steps.flatMap(step => (step.kind === 'quiz' ? step.questions.map(q => `${path.id}/${q.id}`) : []))),
  ),
);

/** The user's opt-in, read fresh (it is not part of UserRow) */
async function sharing(db: Db, userId: string): Promise<boolean> {
  const row = await db.prepare('SELECT share_answers FROM users WHERE id = ?').bind(userId).first<{ share_answers: number }>();
  return row?.share_answers === 1;
}

/** GET /api/answers/sharing: whether this account shares its answers, and for how many questions */
async function getSharing(c: RouteContext): Promise<Response> {
  const { user } = await requireUser(c);
  const row = await c.env.DB.prepare('SELECT COUNT(*) AS n FROM question_answers WHERE user_id = ?').bind(user.id).first<{ n: number }>();
  return json({ share: await sharing(c.env.DB, user.id), questions: Number(row?.n ?? 0) });
}

/** PUT /api/answers/sharing { share }: turning it off deletes every answer this account sent */
async function putSharing(c: RouteContext): Promise<Response> {
  const { user } = await requireUser(c);
  const share = (await c.body()).share;
  if (typeof share !== 'boolean') throw new HttpError(400, 'invalid_share', 'Send { "share": true } or { "share": false }.');
  const db = c.env.DB as SyncDb;
  const set = db.prepare('UPDATE users SET share_answers = ?, updated_at = ? WHERE id = ?').bind(share ? 1 : 0, c.deps.now(), user.id);
  // One transaction, flag first: an answer arriving after it is refused by its own guard, one before it is deleted here
  if (share) await set.run();
  else await db.batch([set, db.prepare('DELETE FROM question_answers WHERE user_id = ?').bind(user.id)]);
  return json({ share });
}

/** POST /api/answers { answers: [{ key, right }] }: counts each answer against its question, when sharing is on */
async function postAnswers(c: RouteContext): Promise<Response> {
  const { user } = await requireUser(c);
  const list = (await c.body()).answers;
  if (!Array.isArray(list) || list.length === 0) throw new HttpError(400, 'invalid_answers', 'Send { "answers": [{ "key", "right" }] }.');
  if (list.length > ANSWERS_PER_REQUEST) throw new HttpError(413, 'too_many_answers', `At most ${ANSWERS_PER_REQUEST} answers per request.`);
  const counts = new Map<string, { answered: number; missed: number }>();
  for (const a of list) {
    const r = a as Record<string, unknown> | null;
    if (!r || typeof r !== 'object' || typeof r.key !== 'string' || typeof r.right !== 'boolean') {
      throw new HttpError(400, 'invalid_answers', 'An answer is not in the expected form.');
    }
    // A question removed from the app since this page loaded is skipped, not an error
    if (!QUESTION_KEYS.has(r.key)) continue;
    const n = counts.get(r.key) ?? { answered: 0, missed: 0 };
    n.answered++;
    if (!r.right) n.missed++;
    counts.set(r.key, n);
  }
  if (!(await sharing(c.env.DB, user.id))) throw new HttpError(409, 'not_sharing', 'Sharing answers is turned off for this account.');
  await enforceLimit(c.env, LIMITS.answerReports, user.id, c.deps.now());
  if (counts.size === 0) return noContent();
  const now = c.deps.now();
  const db = c.env.DB as SyncDb;
  // Each upsert checks the opt-in itself, so a turn-off that lands between the check above and here wins
  await db.batch(
    [...counts].map(([key, n]) =>
      db
        .prepare(
          `INSERT INTO question_answers (user_id, question_key, answered, missed, updated_at)
             SELECT id, ?2, ?3, ?4, ?5 FROM users WHERE id = ?1 AND share_answers = 1
           ON CONFLICT (user_id, question_key) DO UPDATE SET
             answered = answered + excluded.answered, missed = missed + excluded.missed, updated_at = excluded.updated_at`,
        )
        .bind(user.id, key, n.answered, n.missed, now),
    ),
  );
  return noContent();
}

/** This account's shared answers, for the account export */
export async function sharedAnswersOf(db: Db, userId: string) {
  const { results } = await db
    .prepare('SELECT question_key, answered, missed FROM question_answers WHERE user_id = ? ORDER BY question_key')
    .bind(userId)
    .all<{ question_key: string; answered: number; missed: number }>();
  return { share: await sharing(db, userId), questions: results.map(r => ({ key: r.question_key, answered: r.answered, missed: r.missed })) };
}

/** Questions on the admin dashboard's most-missed list */
export const MOST_MISSED = 50;

/**
 * The most-missed questions over learners who share (never staff: `staff` is the admin module's subquery,
 * bound to ?1). Ranked by how many learners missed each one, so one learner retrying a question many
 * times cannot push it up the list on their own.
 */
export async function mostMissed(env: Pick<ApiEnv, 'DB'>, staff: string, owner: string) {
  const learners = `user_id NOT IN (${staff})`;
  const { results } = await env.DB.prepare(
    `SELECT question_key, COUNT(*) AS learners, SUM(missed > 0) AS missed_by, SUM(answered) AS answered, SUM(missed) AS missed
       FROM question_answers WHERE ${learners}
       GROUP BY question_key HAVING SUM(missed) > 0
       ORDER BY missed_by DESC, CAST(SUM(missed) AS REAL) / SUM(answered) DESC, question_key
       LIMIT ${MOST_MISSED}`,
  )
    .bind(owner)
    .all<{ question_key: string; learners: number; missed_by: number; answered: number; missed: number }>();
  const sharingRow = await env.DB.prepare(`SELECT COUNT(*) AS n FROM users WHERE share_answers = 1 AND id NOT IN (${staff})`)
    .bind(owner)
    .first<{ n: number }>();
  return {
    learnersSharing: Number(sharingRow?.n ?? 0),
    questions: results.map(r => ({
      key: r.question_key,
      learners: Number(r.learners),
      missedBy: Number(r.missed_by),
      answered: Number(r.answered),
      missed: Number(r.missed),
    })),
  };
}

export const answerRoutes: Route[] = [
  { method: 'GET', path: '/api/answers/sharing', handler: getSharing },
  { method: 'PUT', path: '/api/answers/sharing', handler: putSharing },
  { method: 'POST', path: '/api/answers', handler: postAnswers },
];
