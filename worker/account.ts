// Account settings for the signed-in user: profile, sign out everywhere, password, email, linked
// sign-in methods, export and delete.
import { HttpError, isUniqueViolation, json, noContent, optStr, str, type Db, type Route, type RouteContext } from './http';
import { hashPassword, verifyPassword } from './password';
import { LIMITS, enforceLimit } from './ratelimit';
import {
  clearSessionCookie,
  createSession,
  endAllSessions,
  loadUser,
  requireUser,
  sessionCookie,
  toPublicUser,
  type UserRow,
} from './session';
import { revokeTokens } from './tokens';
import { requireDisplayName, requireEmail, requireStrongPassword, sendVerification } from './auth/email';

const PROVIDERS = ['github', 'google', 'email'] as const;
type Provider = (typeof PROVIDERS)[number];

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

/** Ways this user can sign in: each GitHub/Google identity, plus email when it has both an address and a password */
function signInMethods(user: UserRow, identities: IdentityRow[]): Provider[] {
  const methods: Provider[] = [];
  for (const i of identities) if (i.provider === 'github' || i.provider === 'google') methods.push(i.provider);
  if (user.email && user.password_hash) methods.push('email');
  return methods;
}

const publicIdentities = (rows: IdentityRow[]) => rows.map(i => ({ provider: i.provider, label: i.login ?? '', linkedAt: i.linked_at }));

/** Checks the current password when the account has one; refuses after too many wrong tries */
async function confirmPassword(c: RouteContext, user: UserRow, given: string | undefined): Promise<void> {
  if (!user.password_hash) return;
  if (given === undefined) throw new HttpError(400, 'current_password_required', 'Enter your current password.');
  await enforceLimit(c.env.DB, LIMITS.passwordCheck, user.id, c.deps.now());
  // 403, not 401: the session is fine, only the password is wrong
  if (!(await verifyPassword(given, user.password_hash))) throw new HttpError(403, 'wrong_password', 'Your current password is not correct.');
}

async function getAccount(c: RouteContext): Promise<Response> {
  const { user } = await requireUser(c);
  return json({
    user: toPublicUser(user),
    identities: publicIdentities(await identitiesOf(c.env.DB, user.id)),
    hasPassword: user.password_hash !== null,
    emailVerified: user.email_verified_at !== null,
  });
}

async function patchAccount(c: RouteContext): Promise<Response> {
  const { user } = await requireUser(c);
  const body = await c.body();
  const name = optStr(body, 'displayName', 200);
  if (name !== undefined) {
    await c.env.DB.prepare('UPDATE users SET display_name = ?, updated_at = ? WHERE id = ?')
      .bind(requireDisplayName(name), c.deps.now(), user.id)
      .run();
  }
  return json({ user: toPublicUser((await loadUser(c.env.DB, user.id))!) });
}

async function logoutAll(c: RouteContext): Promise<Response> {
  const { user } = await requireUser(c);
  await endAllSessions(c.env.DB, user.id);
  return json({ ok: true }, 200, { 'Set-Cookie': clearSessionCookie() });
}

async function changePassword(c: RouteContext): Promise<Response> {
  const { user } = await requireUser(c);
  const now = c.deps.now();
  const body = await c.body();
  const newPassword = str(body, 'newPassword', 1024);
  const current = optStr(body, 'currentPassword', 1024);
  if (!user.email) throw new HttpError(400, 'email_required', 'Add an email address before setting a password.');
  await confirmPassword(c, user, current);
  requireStrongPassword(newPassword, user.email);

  await c.env.DB.prepare('UPDATE users SET password_hash = ?, updated_at = ? WHERE id = ?').bind(await hashPassword(newPassword), now, user.id).run();
  await revokeTokens(c.env.DB, user.id, ['reset'], now);
  // Every other session ends; this one continues with a fresh token
  await endAllSessions(c.env.DB, user.id);
  const token = await createSession(c.env.DB, user.id, now);
  return json({ ok: true }, 200, { 'Set-Cookie': sessionCookie(token) });
}

/**
 * Adds an email to the account or changes it. With a password on the account, `password` is the
 * current password (required). Without one, an optional `password` becomes the account's password.
 * The new address starts unverified and gets a verification link.
 */
async function changeEmail(c: RouteContext): Promise<Response> {
  const { user } = await requireUser(c);
  const now = c.deps.now();
  await enforceLimit(c.env.DB, LIMITS.changeEmail, user.id, now);
  const body = await c.body();
  const email = requireEmail(str(body, 'email', 320));
  const password = optStr(body, 'password', 1024);

  let newHash: string | null = null;
  if (user.password_hash) await confirmPassword(c, user, password);
  else if (password !== undefined) {
    requireStrongPassword(password, email);
    newHash = await hashPassword(password);
  }

  if (email === user.email) {
    if (newHash) await c.env.DB.prepare('UPDATE users SET password_hash = ?, updated_at = ? WHERE id = ?').bind(newHash, now, user.id).run();
    if (user.email_verified_at === null) await sendVerification(c, user.id, email);
    return json({ ok: true }, 202);
  }

  const taken = () => new HttpError(409, 'email_in_use', 'Another account already uses this email address.');
  if (await c.env.DB.prepare('SELECT 1 AS x FROM users WHERE email = ? AND id <> ?').bind(email, user.id).first()) throw taken();
  try {
    await c.env.DB.prepare(
      'UPDATE users SET email = ?, email_verified_at = NULL, password_hash = COALESCE(?, password_hash), updated_at = ? WHERE id = ?',
    )
      .bind(email, newHash, now, user.id)
      .run();
  } catch (err) {
    if (isUniqueViolation(err)) throw taken();
    throw err;
  }
  await c.env.DB.prepare("DELETE FROM identities WHERE user_id = ? AND provider = 'email'").bind(user.id).run();
  await c.env.DB.prepare('INSERT INTO identities (provider, provider_id, user_id, login, linked_at) VALUES (?, ?, ?, ?, ?)')
    .bind('email', email, user.id, email, now)
    .run();
  // Links mailed to the old address stop working
  await revokeTokens(c.env.DB, user.id, ['verify', 'reset'], now);
  await sendVerification(c, user.id, email);
  return json({ ok: true }, 202);
}

async function unlinkIdentity(c: RouteContext): Promise<Response> {
  const { user } = await requireUser(c);
  const provider = c.params.provider as Provider;
  if (!PROVIDERS.includes(provider)) throw new HttpError(404, 'not_linked', 'This sign-in method is not linked to your account.');
  const identities = await identitiesOf(c.env.DB, user.id);
  const methods = signInMethods(user, identities);
  const linked = provider === 'email' ? user.email !== null || identities.some(i => i.provider === 'email') : methods.includes(provider);
  if (!linked) throw new HttpError(404, 'not_linked', 'This sign-in method is not linked to your account.');
  if (methods.filter(m => m !== provider).length === 0) {
    throw new HttpError(409, 'last_method', 'This is the only way to sign in to your account. Add another method before removing it.');
  }

  const now = c.deps.now();
  await c.env.DB.prepare('DELETE FROM identities WHERE user_id = ? AND provider = ?').bind(user.id, provider).run();
  if (provider === 'email') {
    await c.env.DB.prepare('UPDATE users SET email = NULL, email_verified_at = NULL, password_hash = NULL, updated_at = ? WHERE id = ?')
      .bind(now, user.id)
      .run();
    await revokeTokens(c.env.DB, user.id, ['verify', 'reset'], now);
  }
  return noContent();
}

const iso = (ms: number | null) => (ms === null ? null : new Date(ms).toISOString());

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
    // Progress sync (worker/sync.ts) adds the user's progress here
  };
  return new Response(JSON.stringify(data, null, 2), {
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Disposition': 'attachment; filename="terminus-account.json"',
      'Cache-Control': 'no-store',
    },
  });
}

async function deleteAccount(c: RouteContext): Promise<Response> {
  const { user } = await requireUser(c);
  const body = await c.body();
  if (body.confirm !== 'delete') throw new HttpError(400, 'confirm_required', 'Send { "confirm": "delete" } to delete your account.');
  // ON DELETE CASCADE removes identities, sessions, tokens and (later) progress; the explicit deletes
  // also cover a database where foreign keys are not enforced
  for (const table of ['sessions', 'identities', 'auth_tokens']) {
    await c.env.DB.prepare(`DELETE FROM ${table} WHERE user_id = ?`).bind(user.id).run();
  }
  await c.env.DB.prepare('DELETE FROM users WHERE id = ?').bind(user.id).run();
  return noContent({ 'Set-Cookie': clearSessionCookie() });
}

export const accountRoutes: Route[] = [
  { method: 'GET', path: '/api/account', handler: getAccount },
  { method: 'PATCH', path: '/api/account', handler: patchAccount },
  { method: 'DELETE', path: '/api/account', handler: deleteAccount },
  { method: 'POST', path: '/api/account/logout-all', handler: logoutAll },
  { method: 'POST', path: '/api/account/password', handler: changePassword },
  { method: 'POST', path: '/api/account/email', handler: changeEmail },
  { method: 'DELETE', path: /^\/api\/account\/identities\/(?<provider>[a-z]+)$/, handler: unlinkIdentity },
  { method: 'GET', path: '/api/account/export', handler: exportAccount },
];
