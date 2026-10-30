// Account settings for the signed-in user (portal part 7): the account and its sign-in methods, the
// sessions signed in to it, re-authentication, the password, unlinking a sign-in method, export and delete.
// Ported from portal/base by hand; email changes and Google arrive with their own parts.
import { HttpError, json, noContent, optStr, secureHeaders, str, type Db, type Route, type RouteContext } from './http';
import { hashPassword, verifyPassword } from './password';
import { LIMITS, enforceLimit, forgetLimits } from './ratelimit';
import {
  REAUTH_WINDOW,
  clearSessionCookie,
  createPasswordSession,
  emailUnverified,
  loadUser,
  markAuthenticated,
  requireUser,
  sessionCookie,
  toPublicUser,
  type Session,
  type UserRow,
} from './session';
import { revokeTokens } from './tokens';
import { SYNC_TABLES, readState } from './sync';
import { requireDisplayName, requireStrongPassword } from './auth/email';

const PROVIDERS = ['github', 'email'] as const;
type Provider = (typeof PROVIDERS)[number];

/** Sessions are shown by the first 16 hex characters of their token hash (never the cookie value) */
const SESSION_ID_LENGTH = 16;
const sessionId = (tokenHash: string) => tokenHash.slice(0, SESSION_ID_LENGTH);

interface IdentityRow {
  provider: string;
  login: string | null;
  linked_at: number | null;
}

async function identitiesOf(db: Db, userId: string): Promise<IdentityRow[]> {
  const { results } = await db
    .prepare('SELECT provider, login, linked_at FROM identities WHERE user_id = ? ORDER BY linked_at, provider')
    .bind(userId)
    .all<IdentityRow>();
  return results;
}

/** Ways this user can sign in: GitHub when linked, email when the account has both an address and a password */
function signInMethods(user: UserRow, identities: IdentityRow[]): Provider[] {
  const methods: Provider[] = [];
  if (identities.some(i => i.provider === 'github')) methods.push('github');
  if (user.email && user.password_hash) methods.push('email');
  return methods;
}

const publicIdentities = (rows: IdentityRow[]) => rows.map(i => ({ provider: i.provider, label: i.login ?? '', linkedAt: i.linked_at }));

/** Checks the current password when the account has one; refuses after too many wrong tries */
async function confirmPassword(c: RouteContext, user: UserRow, given: string | undefined): Promise<void> {
  if (!user.password_hash) return;
  if (given === undefined) throw new HttpError(400, 'current_password_required', 'Enter your current password.');
  await enforceLimit(c.env, LIMITS.passwordCheck, user.id, c.deps.now());
  // 403, not 401: the session is fine, only the password is wrong
  if (!(await verifyPassword(given, user.password_hash))) throw new HttpError(403, 'wrong_password', 'Your current password is not correct.');
}

/** The OAuth providers linked to the user: where an account without a password signs in again */
async function reauthRequired(c: RouteContext, user: UserRow): Promise<HttpError> {
  const providers = [...new Set((await identitiesOf(c.env.DB, user.id)).map(r => r.provider).filter(p => p === 'github'))];
  return new HttpError(403, 'reauth_required', 'Sign in again to confirm it is you, then retry.', {}, { providers });
}

/**
 * Re-authentication for sensitive actions (delete, password, unlink). With a password on the account:
 * `currentPassword` in the body, every time. Without one: a sign-in within the last 10 minutes, otherwise
 * 403 `reauth_required` with the providers to sign in again with.
 */
async function requireRecentAuth(c: RouteContext, user: UserRow, session: Session, currentPassword: string | undefined): Promise<void> {
  if (user.password_hash) return confirmPassword(c, user, currentPassword);
  if (c.deps.now() - session.authenticatedAt > REAUTH_WINDOW) throw await reauthRequired(c, user);
}

/** A body that may be absent (DELETE without one): {} when no Content-Type was sent */
async function optionalBody(c: RouteContext): Promise<Record<string, unknown>> {
  return c.request.headers.get('Content-Type') ? c.body() : {};
}

const iso = (ms: number | null) => (ms === null ? null : new Date(ms).toISOString());

// --- The account -----------------------------------------------------------------------------

async function getAccount(c: RouteContext): Promise<Response> {
  const { user } = await requireUser(c);
  const identities = await identitiesOf(c.env.DB, user.id);
  return json({
    user: toPublicUser(user),
    identities: publicIdentities(identities),
    signInMethods: signInMethods(user, identities),
    hasPassword: user.password_hash !== null,
    createdAt: user.created_at,
  });
}

async function patchAccount(c: RouteContext): Promise<Response> {
  const { user } = await requireUser(c);
  const name = optStr(await c.body(), 'displayName', 200);
  if (name !== undefined) {
    await c.env.DB.prepare('UPDATE users SET display_name = ?, updated_at = ? WHERE id = ?')
      .bind(requireDisplayName(name), c.deps.now(), user.id)
      .run();
  }
  return json({ user: toPublicUser((await loadUser(c.env.DB, user.id))!) });
}

/** POST /api/account/reauth { currentPassword }: proves the password again and refreshes this session's sign-in time */
async function reauth(c: RouteContext): Promise<Response> {
  const { session, user } = await requireUser(c);
  const body = await c.body();
  if (!user.password_hash) throw await reauthRequired(c, user);
  await confirmPassword(c, user, optStr(body, 'currentPassword', 1024));
  const now = c.deps.now();
  await markAuthenticated(c.env.DB, session.tokenHash, now);
  return json({ ok: true, authenticatedAt: now });
}

// --- Sessions --------------------------------------------------------------------------------

/** GET /api/account/sessions: every live session of this account, newest first, this one marked */
async function listSessions(c: RouteContext): Promise<Response> {
  const { session, user } = await requireUser(c);
  const now = c.deps.now();
  const { results } = await c.env.DB.prepare(
    'SELECT token_hash, created_at, expires_at, authenticated_at FROM sessions WHERE user_id = ? AND expires_at > ? ORDER BY created_at DESC',
  )
    .bind(user.id, now)
    .all<{ token_hash: string; created_at: number; expires_at: number; authenticated_at: number | null }>();
  const sessions = results.map(r => ({
    id: sessionId(r.token_hash),
    createdAt: r.created_at,
    expiresAt: r.expires_at,
    signedInAt: r.authenticated_at ?? r.created_at,
    current: r.token_hash === session.tokenHash,
  }));
  return json({ sessions });
}

/** DELETE /api/account/sessions/:id: ends one session of this account (this one too, which also clears the cookie) */
async function endSession(c: RouteContext): Promise<Response> {
  const { session, user } = await requireUser(c);
  const id = c.params.id ?? '';
  const ended = await c.env.DB.prepare('DELETE FROM sessions WHERE user_id = ? AND substr(token_hash, 1, ?) = ? RETURNING token_hash')
    .bind(user.id, SESSION_ID_LENGTH, id)
    .all<{ token_hash: string }>();
  if (ended.results.length === 0) throw new HttpError(404, 'session_not_found', 'This session has already ended.');
  const here = ended.results.some(r => r.token_hash === session.tokenHash);
  return noContent(here ? { 'Set-Cookie': clearSessionCookie() } : {});
}

/** DELETE /api/account/sessions: signs out everywhere else; this session stays */
async function endOtherSessions(c: RouteContext): Promise<Response> {
  const { session, user } = await requireUser(c);
  const ended = await c.env.DB.prepare('DELETE FROM sessions WHERE user_id = ? AND token_hash <> ? RETURNING token_hash')
    .bind(user.id, session.tokenHash)
    .all<{ token_hash: string }>();
  return json({ ended: ended.results.length });
}

// --- Password and sign-in methods ------------------------------------------------------------

/**
 * POST /api/account/password { currentPassword?, newPassword }: sets or changes the password. The update is
 * guarded by the hash that was checked, so two changes at once (or a reset landing in between) cannot both
 * win. Every session ends; this one continues with a fresh token.
 */
async function changePassword(c: RouteContext): Promise<Response> {
  const { session, user } = await requireUser(c);
  const now = c.deps.now();
  const body = await c.body();
  const newPassword = str(body, 'newPassword', 1024);
  if (!user.email) throw new HttpError(400, 'email_required', 'Add an email address before setting a password.');
  // A first password needs a confirmed address: otherwise anyone could hold someone else's email with a password
  if (!user.password_hash && emailUnverified(user)) {
    throw new HttpError(409, 'email_unverified', 'Confirm your email address first: open the link in the email we sent you.');
  }
  await requireRecentAuth(c, user, session, optStr(body, 'currentPassword', 1024));
  requireStrongPassword(newPassword, user.email, user.display_name);

  const newHash = await hashPassword(newPassword);
  const changed = await c.env.DB.prepare('UPDATE users SET password_hash = ?, updated_at = ? WHERE id = ? AND password_hash IS ? RETURNING id')
    .bind(newHash, now, user.id, user.password_hash)
    .first<{ id: string }>();
  if (!changed) throw new HttpError(409, 'conflict', 'Your password changed at the same time. Sign in again and retry.');
  await revokeTokens(c.env.DB, user.id, ['reset'], now);
  await c.env.DB.prepare('DELETE FROM sessions WHERE user_id = ?').bind(user.id).run();
  // The new session exists only while the password is still the one set here: a reset landing in
  // between (which ends every session) is not undone by this slower request
  const token = await createPasswordSession(c.env.DB, user.id, now, newHash);
  if (!token) {
    throw new HttpError(409, 'conflict', 'Your password was changed again elsewhere. Sign in with the newest one.', { 'Set-Cookie': clearSessionCookie() });
  }
  return json({ ok: true }, 200, { 'Set-Cookie': sessionCookie(token) });
}

/** DELETE /api/account/identities/:provider: removes a sign-in method, never the last one */
async function unlinkIdentity(c: RouteContext): Promise<Response> {
  const { session, user } = await requireUser(c);
  const body = await optionalBody(c);
  const provider = c.params.provider as Provider;
  const notLinked = () => new HttpError(404, 'not_linked', 'This sign-in method is not linked to your account.');
  if (!PROVIDERS.includes(provider)) throw notLinked();
  const identities = await identitiesOf(c.env.DB, user.id);
  const methods = signInMethods(user, identities);
  const linked = provider === 'email' ? user.email !== null || identities.some(i => i.provider === 'email') : methods.includes(provider);
  if (!linked) throw notLinked();
  if (methods.filter(m => m !== provider).length === 0) {
    throw new HttpError(409, 'last_method', 'This is the only way to sign in to your account. Add another method before removing it.');
  }
  await requireRecentAuth(c, user, session, optStr(body, 'currentPassword', 1024));

  // The check above read a snapshot; each removal below also requires, in the same statement, that
  // another way to sign in still exists. Two unlinks at once (GitHub and email) cannot both pass.
  const now = c.deps.now();
  const lastMethod = () => new HttpError(409, 'last_method', 'This is the only way to sign in to your account. Add another method before removing it.');
  if (provider === 'email') {
    const cleared = await c.env.DB.prepare(
      `UPDATE users SET email = NULL, email_verified_at = NULL, email_set_at = NULL, password_hash = NULL, updated_at = ?1
        WHERE id = ?2 AND EXISTS (SELECT 1 FROM identities WHERE user_id = ?2 AND provider = 'github') RETURNING id`,
    )
      .bind(now, user.id)
      .first<{ id: string }>();
    if (!cleared) throw lastMethod();
    await c.env.DB.prepare("DELETE FROM identities WHERE user_id = ? AND provider = 'email'").bind(user.id).run();
    await revokeTokens(c.env.DB, user.id, ['verify', 'reset'], now);
  } else {
    const removed = await c.env.DB.prepare(
      `DELETE FROM identities WHERE user_id = ?1 AND provider = ?2
          AND EXISTS (SELECT 1 FROM users WHERE id = ?1 AND email IS NOT NULL AND password_hash IS NOT NULL) RETURNING provider`,
    )
      .bind(user.id, provider)
      .first<{ provider: string }>();
    if (!removed) throw lastMethod();
  }
  return noContent();
}

// --- Export and delete -----------------------------------------------------------------------

async function exportAccount(c: RouteContext): Promise<Response> {
  const { user } = await requireUser(c);
  const sessions = await c.env.DB.prepare('SELECT created_at, expires_at FROM sessions WHERE user_id = ? ORDER BY created_at')
    .bind(user.id)
    .all<{ created_at: number; expires_at: number }>();
  // Only data about the person: no password hash, no session or token hashes
  const data = {
    exportedAt: iso(c.deps.now()),
    user: {
      id: user.id,
      name: user.display_name,
      email: user.email,
      emailVerified: user.email_verified_at !== null,
      emailVerifiedAt: iso(user.email_verified_at),
      avatarUrl: user.avatar_url,
      createdAt: iso(user.created_at),
      updatedAt: iso(user.updated_at),
    },
    hasPassword: user.password_hash !== null,
    signInMethods: (await identitiesOf(c.env.DB, user.id)).map(i => ({ provider: i.provider, label: i.login ?? '', linkedAt: iso(i.linked_at) })),
    sessions: sessions.results.map(s => ({ createdAt: iso(s.created_at), expiresAt: iso(s.expires_at) })),
    // Synced progress (worker/sync.ts): items, reset epochs and app settings, as GET /api/progress gives them
    progress: await readState(c.env.DB, user.id),
  };
  return new Response(JSON.stringify(data, null, 2), {
    headers: secureHeaders({
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Disposition': 'attachment; filename="terminus-account.json"',
    }),
  });
}

/** DELETE /api/account { confirm: "delete", currentPassword? }: removes the account and everything linked to it */
async function deleteAccount(c: RouteContext): Promise<Response> {
  const { session, user } = await requireUser(c);
  const body = await c.body();
  if (body.confirm !== 'delete') throw new HttpError(400, 'confirm_required', 'Send { "confirm": "delete" } to delete your account.');
  await requireRecentAuth(c, user, session, optStr(body, 'currentPassword', 1024));
  // ON DELETE CASCADE removes identities, sessions, tokens and synced progress; the explicit deletes
  // also cover a database where foreign keys are not enforced
  for (const table of ['sessions', 'identities', 'auth_tokens', ...SYNC_TABLES]) {
    await c.env.DB.prepare(`DELETE FROM ${table} WHERE user_id = ?`).bind(user.id).run();
  }
  await c.env.DB.prepare('DELETE FROM users WHERE id = ?').bind(user.id).run();
  // Rate-limit rows keyed by this account's email or id would otherwise outlive it
  await forgetLimits(c.env, user.id, user.email);
  return noContent({ 'Set-Cookie': clearSessionCookie() });
}

export const accountRoutes: Route[] = [
  { method: 'GET', path: '/api/account', handler: getAccount },
  { method: 'PATCH', path: '/api/account', handler: patchAccount },
  { method: 'DELETE', path: '/api/account', handler: deleteAccount },
  { method: 'POST', path: '/api/account/reauth', handler: reauth },
  { method: 'GET', path: '/api/account/sessions', handler: listSessions },
  { method: 'DELETE', path: '/api/account/sessions', handler: endOtherSessions },
  { method: 'DELETE', path: /^\/api\/account\/sessions\/(?<id>[0-9a-f]{16})$/, handler: endSession },
  { method: 'POST', path: '/api/account/password', handler: changePassword },
  { method: 'DELETE', path: /^\/api\/account\/identities\/(?<provider>[a-z]+)$/, handler: unlinkIdentity },
  { method: 'GET', path: '/api/account/export', handler: exportAccount },
];
