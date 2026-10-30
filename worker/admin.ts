// Admin dashboard API (portal part 9). The owner is the account whose confirmed email is the OWNER_EMAIL
// secret; the owner adds admins by email. Admin and owner accounts are left out of every total here.
// Totals only: no route here lists users or shows anyone's email except the admins themselves.
import { HttpError, json, noContent, str, type ApiEnv, type Db, type Route, type RouteContext } from './http';
import { requireUser, type UserRow } from './session';
import { normalizeEmail } from './auth/email';
import { mostMissed } from './answers';

export type Role = 'owner' | 'admin';

const DAY = 24 * 60 * 60 * 1000;

/** The owner's address from the OWNER_EMAIL secret, normalized; null when unset or not an address */
export function ownerEmail(env: Pick<ApiEnv, 'OWNER_EMAIL'>): string | null {
  return env.OWNER_EMAIL ? normalizeEmail(env.OWNER_EMAIL) : null;
}

/** The user's role: only a confirmed email counts, so an unconfirmed claim on an admin address grants nothing */
export async function roleOf(env: Pick<ApiEnv, 'DB' | 'OWNER_EMAIL'>, user: Pick<UserRow, 'email' | 'email_verified_at'>): Promise<Role | null> {
  if (!user.email || user.email_verified_at === null) return null;
  if (user.email === ownerEmail(env)) return 'owner';
  const row = await env.DB.prepare('SELECT 1 AS yes FROM admins WHERE email = ?').bind(user.email).first<{ yes: number }>();
  return row ? 'admin' : null;
}

async function requireRole(c: RouteContext, needed: Role): Promise<UserRow> {
  const { user } = await requireUser(c);
  const role = await roleOf(c.env, user);
  if (!role || (needed === 'owner' && role !== 'owner')) throw new HttpError(403, 'not_admin', 'This page is for the site’s admins.');
  return user;
}

/** Ids of the owner and admin accounts, left out of every total: `id NOT IN (${STAFF})`, bound to the owner's email */
const STAFF = `SELECT id FROM users WHERE email_verified_at IS NOT NULL AND (email = ?1 OR email IN (SELECT email FROM admins))`;

async function countOf(db: Db, sql: string, ...binds: unknown[]): Promise<number> {
  const row = await db.prepare(sql).bind(...binds).first<{ n: number }>();
  return Number(row?.n ?? 0);
}

/** GET /api/admin/stats: totals over learner accounts (never admins), as of now */
async function stats(c: RouteContext): Promise<Response> {
  await requireRole(c, 'admin');
  const db = c.env.DB;
  const now = c.deps.now();
  const owner = ownerEmail(c.env) ?? '';
  const learners = `FROM users WHERE id NOT IN (${STAFF})`;
  const accounts = {
    total: await countOf(db, `SELECT COUNT(*) AS n ${learners}`, owner),
    newLast7Days: await countOf(db, `SELECT COUNT(*) AS n ${learners} AND created_at >= ?2`, owner, now - 7 * DAY),
    newLast30Days: await countOf(db, `SELECT COUNT(*) AS n ${learners} AND created_at >= ?2`, owner, now - 30 * DAY),
    emailConfirmed: await countOf(db, `SELECT COUNT(*) AS n ${learners} AND email_verified_at IS NOT NULL`, owner),
    withPassword: await countOf(db, `SELECT COUNT(*) AS n ${learners} AND password_hash IS NOT NULL`, owner),
    withGithub: await countOf(
      db,
      `SELECT COUNT(DISTINCT user_id) AS n FROM identities WHERE provider = 'github' AND user_id NOT IN (${STAFF})`,
      owner,
    ),
  };
  const activity = {
    // From users.last_sign_in_at, which every sign-in sets and signing out leaves alone
    signedInLast7Days: await countOf(db, `SELECT COUNT(*) AS n ${learners} AND last_sign_in_at >= ?2`, owner, now - 7 * DAY),
    liveSessions: await countOf(db, `SELECT COUNT(*) AS n FROM sessions WHERE expires_at > ?2 AND user_id NOT IN (${STAFF})`, owner, now),
  };
  const { results } = await db
    .prepare(`SELECT kind, COUNT(*) AS n FROM progress_items WHERE user_id NOT IN (${STAFF}) GROUP BY kind`)
    .bind(owner)
    .all<{ kind: string; n: number }>();
  const byKind = Object.fromEntries(results.map(r => [r.kind, Number(r.n)]));
  const progress = {
    accountsWithProgress: await countOf(db, `SELECT COUNT(DISTINCT user_id) AS n FROM progress_items WHERE user_id NOT IN (${STAFF})`, owner),
    tasksDone: byKind.objective ?? 0,
    lessonsRead: byKind.lesson ?? 0,
    quizzesTaken: byKind.quiz ?? 0,
  };
  return json({ asOf: now, accounts, activity, progress });
}

/** GET /api/admin/missed: the questions learners who share their answers miss most (portal part 9c) */
async function missed(c: RouteContext): Promise<Response> {
  await requireRole(c, 'admin');
  return json({ asOf: c.deps.now(), ...(await mostMissed(c.env, STAFF, ownerEmail(c.env) ?? '')) });
}

/** GET /api/admin/admins (owner only): the admin addresses; the owner's own comes from the secret */
async function listAdmins(c: RouteContext): Promise<Response> {
  await requireRole(c, 'owner');
  const { results } = await c.env.DB.prepare('SELECT email, added_at FROM admins ORDER BY added_at, email').all<{ email: string; added_at: number }>();
  return json({ admins: results.map(r => ({ email: r.email, addedAt: r.added_at })) });
}

function adminEmail(c: RouteContext, body: Record<string, unknown>): string {
  const email = normalizeEmail(str(body, 'email', 320));
  if (!email) throw new HttpError(400, 'invalid_email', 'Enter an email address like name@example.com.');
  if (email === ownerEmail(c.env)) throw new HttpError(400, 'is_owner', 'That address is the owner’s, which is always an admin.');
  return email;
}

/** POST /api/admin/admins { email } (owner only): the account with that confirmed address becomes an admin */
async function addAdmin(c: RouteContext): Promise<Response> {
  const owner = await requireRole(c, 'owner');
  const email = adminEmail(c, await c.body());
  const added = await c.env.DB.prepare('INSERT INTO admins (email, added_by, added_at) VALUES (?, ?, ?) ON CONFLICT (email) DO NOTHING RETURNING email')
    .bind(email, owner.id, c.deps.now())
    .first<{ email: string }>();
  if (!added) throw new HttpError(409, 'already_admin', 'That address is already an admin.');
  return json({ ok: true }, 201);
}

/** DELETE /api/admin/admins { email } (owner only) */
async function removeAdmin(c: RouteContext): Promise<Response> {
  await requireRole(c, 'owner');
  const email = adminEmail(c, await c.body());
  const removed = await c.env.DB.prepare('DELETE FROM admins WHERE email = ? RETURNING email').bind(email).first<{ email: string }>();
  if (!removed) throw new HttpError(404, 'not_admin', 'That address is not an admin.');
  return noContent();
}

export const adminRoutes: Route[] = [
  { method: 'GET', path: '/api/admin/stats', handler: stats },
  { method: 'GET', path: '/api/admin/missed', handler: missed },
  { method: 'GET', path: '/api/admin/admins', handler: listAdmins },
  { method: 'POST', path: '/api/admin/admins', handler: addAdmin },
  { method: 'DELETE', path: '/api/admin/admins', handler: removeAdmin },
];
