// Email + password accounts: register, sign in, verify the address, resend, forgot and reset password.
import {
  HttpError,
  clientIp,
  inBackground,
  isUniqueViolation,
  json,
  str,
  type Route,
  type RouteContext,
} from '../http';
import { hashPassword, passwordProblem, verifyAgainstDummy, verifyPassword } from '../password';
import { LIMITS, enforceLimit } from '../ratelimit';
import { createSession, endAllSessions, loadUser, requireUser, sessionCookie, toPublicUser } from '../session';
import { consumeToken, issueToken, peekToken, revokeTokens, tokenFailure } from '../tokens';
import { resetEmail, sendEmail, verificationEmail } from '../mail';

const INVALID_CREDENTIALS = () => new HttpError(401, 'invalid_credentials', 'That email and password do not match an account.');
const INVALID_TOKEN = () => new HttpError(400, 'invalid_token', 'This link is invalid or was already used. Ask for a new one.');

/** invalid_token, or token_expired for a link that only ran out of time */
async function badToken(c: RouteContext, token: string, purpose: 'verify' | 'reset'): Promise<HttpError> {
  return (await tokenFailure(c.env.DB, token, purpose, c.deps.now())) === 'token_expired'
    ? new HttpError(400, 'token_expired', 'This link has expired. Ask for a new one.')
    : INVALID_TOKEN();
}

/** Trimmed and lowercased; null when it does not look like an email address */
export function normalizeEmail(value: string): string | null {
  const email = value.trim().toLowerCase();
  if (email.length > 254 || !/^[^\s@]+@[^\s@.]+(\.[^\s@.]+)+$/.test(email)) return null;
  return email;
}

export function requireEmail(value: string): string {
  const email = normalizeEmail(value);
  if (!email) throw new HttpError(400, 'invalid_email', 'Enter a valid email address.');
  return email;
}

export function requireDisplayName(value: string): string {
  const name = value.trim().replace(/\s+/g, ' ');
  // No control characters; 1 to 50 characters
  if (!name || [...name].length > 50 || /\p{Cc}/u.test(name)) throw new HttpError(400, 'invalid_display_name', 'Enter a name of 1 to 50 characters.');
  return name;
}

export function requireStrongPassword(password: string, email: string | null): void {
  const problem = passwordProblem(password, email);
  if (problem) throw new HttpError(400, problem.code, problem.message);
}

/** Issues a verification token and emails the link (in the background when the platform allows it) */
export async function sendVerification(c: RouteContext, userId: string, email: string): Promise<void> {
  const token = await issueToken(c.env.DB, userId, 'verify', c.deps.now());
  await inBackground(c.deps, () => sendEmail(c.env, c.deps, verificationEmail(c.url.origin, email, token)));
}

async function register(c: RouteContext): Promise<Response> {
  const now = c.deps.now();
  await enforceLimit(c.env.DB, LIMITS.registerIp, clientIp(c.request), now);
  const body = await c.body();
  const email = requireEmail(str(body, 'email', 320));
  const password = str(body, 'password', 1024);
  const displayName = requireDisplayName(str(body, 'displayName', 200));
  if (body.ageConfirmed !== true) throw new HttpError(400, 'age_required', 'Confirm that you are 13 or older to create an account.');
  requireStrongPassword(password, email);

  const taken = () => new HttpError(409, 'email_taken', 'An account with this email already exists. Sign in, or reset the password.');
  if (await c.env.DB.prepare('SELECT 1 AS x FROM users WHERE email = ?').bind(email).first()) throw taken();

  const id = crypto.randomUUID();
  const hash = await hashPassword(password);
  try {
    await c.env.DB.prepare(
      'INSERT INTO users (id, display_name, avatar_url, created_at, email, password_hash, updated_at) VALUES (?, ?, NULL, ?, ?, ?, ?)',
    )
      .bind(id, displayName, now, email, hash, now)
      .run();
  } catch (err) {
    // A second sign-up for the same address at the same moment
    if (isUniqueViolation(err)) throw taken();
    throw err;
  }
  await c.env.DB.prepare('INSERT INTO identities (provider, provider_id, user_id, login, linked_at) VALUES (?, ?, ?, ?, ?)')
    .bind('email', email, id, email, now)
    .run();

  const session = await createSession(c.env.DB, id, now);
  await sendVerification(c, id, email);
  const user = await loadUser(c.env.DB, id);
  return json({ user: toPublicUser(user!) }, 201, { 'Set-Cookie': sessionCookie(session) });
}

async function login(c: RouteContext): Promise<Response> {
  const now = c.deps.now();
  const body = await c.body();
  const password = str(body, 'password', 1024);
  const email = normalizeEmail(str(body, 'email', 320));
  await enforceLimit(c.env.DB, LIMITS.loginIp, clientIp(c.request), now);
  if (email) await enforceLimit(c.env.DB, LIMITS.loginEmail, email, now);

  const row = email
    ? await c.env.DB.prepare('SELECT id, password_hash FROM users WHERE email = ?').bind(email).first<{ id: string; password_hash: string | null }>()
    : null;
  // Same work, same answer whether or not the account exists or has a password
  const ok = row?.password_hash ? await verifyPassword(password, row.password_hash) : await verifyAgainstDummy(password);
  if (!row || !ok) throw INVALID_CREDENTIALS();

  const session = await createSession(c.env.DB, row.id, now);
  const user = await loadUser(c.env.DB, row.id);
  return json({ user: toPublicUser(user!) }, 200, { 'Set-Cookie': sessionCookie(session) });
}

async function verify(c: RouteContext): Promise<Response> {
  const now = c.deps.now();
  const token = str(await c.body(), 'token', 200);
  const userId = await consumeToken(c.env.DB, token, 'verify', now);
  if (!userId) throw await badToken(c, token, 'verify');
  await c.env.DB.prepare('UPDATE users SET email_verified_at = COALESCE(email_verified_at, ?) WHERE id = ? AND email IS NOT NULL')
    .bind(now, userId)
    .run();
  const user = await loadUser(c.env.DB, userId);
  if (!user) throw INVALID_TOKEN();
  return json({ user: toPublicUser(user) });
}

async function resendVerification(c: RouteContext): Promise<Response> {
  const { user } = await requireUser(c);
  await enforceLimit(c.env.DB, LIMITS.resendVerification, user.id, c.deps.now());
  if (!user.email) throw new HttpError(400, 'no_email', 'Add an email address to your account first.');
  if (user.email_verified_at === null) await sendVerification(c, user.id, user.email);
  return json({ ok: true }, 202);
}

async function forgot(c: RouteContext): Promise<Response> {
  const now = c.deps.now();
  const raw = str(await c.body(), 'email', 320);
  const email = normalizeEmail(raw);
  await enforceLimit(c.env.DB, LIMITS.forgotEmail, email ?? raw, now);
  // Looking the account up, issuing the token and sending all happen after the answer when possible,
  // so neither the answer nor its timing says whether the email has an account
  if (email) {
    await inBackground(c.deps, async () => {
      const row = await c.env.DB.prepare('SELECT id FROM users WHERE email = ?').bind(email).first<{ id: string }>();
      if (!row) return;
      const token = await issueToken(c.env.DB, row.id, 'reset', now);
      await sendEmail(c.env, c.deps, resetEmail(c.url.origin, email, token));
    });
  }
  return json({ ok: true }, 202);
}

async function reset(c: RouteContext): Promise<Response> {
  const now = c.deps.now();
  const body = await c.body();
  const token = str(body, 'token', 200);
  const password = str(body, 'password', 1024);
  // Check the new password before using the token up, so a refused password can be retried with the same link
  const pendingUser = await peekToken(c.env.DB, token, 'reset', now);
  if (!pendingUser) throw await badToken(c, token, 'reset');
  const before = await loadUser(c.env.DB, pendingUser);
  if (!before) throw INVALID_TOKEN();
  requireStrongPassword(password, before.email);
  const hash = await hashPassword(password);

  const userId = await consumeToken(c.env.DB, token, 'reset', now);
  if (!userId) throw await badToken(c, token, 'reset');
  // The link reached this inbox, which also proves the address
  await c.env.DB.prepare(
    `UPDATE users SET password_hash = ?, updated_at = ?,
       email_verified_at = CASE WHEN email IS NOT NULL THEN COALESCE(email_verified_at, ?) END
     WHERE id = ?`,
  )
    .bind(hash, now, now, userId)
    .run();
  await revokeTokens(c.env.DB, userId, ['reset'], now);
  await endAllSessions(c.env.DB, userId);
  const session = await createSession(c.env.DB, userId, now);
  const user = await loadUser(c.env.DB, userId);
  return json({ user: toPublicUser(user!) }, 200, { 'Set-Cookie': sessionCookie(session) });
}

export const emailRoutes: Route[] = [
  { method: 'POST', path: '/api/auth/email/register', handler: register },
  { method: 'POST', path: '/api/auth/email/login', handler: login },
  { method: 'POST', path: '/api/auth/email/verify', handler: verify },
  { method: 'POST', path: '/api/auth/email/resend-verification', handler: resendVerification },
  { method: 'POST', path: '/api/auth/password/forgot', handler: forgot },
  { method: 'POST', path: '/api/auth/password/reset', handler: reset },
];
