// Email + password accounts: sign up, sign in, and confirm the address. Resetting a password comes next.
import { HttpError, appOrigin, inBackground, ipSubject, isUniqueViolation, json, sha256, str, type Db, type Route, type RouteContext } from '../http';
import { sendEmail, verificationEmail } from '../mail';
import { hashPassword, passwordProblem, verifyAgainstDummy, verifyPassword } from '../password';
import { LIMITS, countLimit, enforceLimit, rateLimited } from '../ratelimit';
import { EMAIL_CLAIM_TTL, createSession, endIncomingSession, loadUser, requireUser, sessionCookie, staleEmailClaim, toPublicUser } from '../session';
import { consumeToken, issueToken, revokeTokens, tokenFailure } from '../tokens';

const INVALID_CREDENTIALS = () => new HttpError(401, 'invalid_credentials', 'That email and password do not match an account.');

const LOCAL_PART = /^[a-z0-9!#$%&'*+/=?^_`{|}~-]+(\.[a-z0-9!#$%&'*+/=?^_`{|}~-]+)*$/;
const DOMAIN = /^(?=.{1,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)(\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/;
/** Characters an address may never hold: specials that make "Name <addr>" or quoted forms, controls, format characters, spaces */
const FORBIDDEN = /[<>"(),;:[\]\\\s\p{Cc}\p{Cf}]/u;

/**
 * The canonical form of an email address, or null when it is not one we accept. NFC-normalized, trimmed
 * and lowercased. The local part is plain ASCII (dot-atom, no quoting); an internationalized domain is
 * converted to punycode with the URL API (UTS #46), so lookalike Unicode forms map to one address.
 */
export function normalizeEmail(value: string): string | null {
  const email = value.normalize('NFC').trim().toLowerCase();
  if (email.length > 254 || FORBIDDEN.test(email)) return null;
  const at = email.indexOf('@');
  if (at < 1 || at !== email.lastIndexOf('@')) return null;
  const local = email.slice(0, at);
  let domain = email.slice(at + 1);
  if (local.length > 64 || !LOCAL_PART.test(local)) return null;
  if (/[^\x00-\x7f]/.test(domain)) {
    // Only letters of other scripts may need conversion; URL syntax characters would change what is parsed
    if (/[/?#%@\\]/.test(domain)) return null;
    try {
      domain = new URL(`http://${domain}`).hostname;
    } catch {
      return null;
    }
  }
  if (!DOMAIN.test(domain)) return null;
  // The last label must name a top-level domain (letters, or punycode), never an IP address
  if (!/[a-z]/.test(domain.slice(domain.lastIndexOf('.') + 1))) return null;
  const out = `${local}@${domain}`;
  return out.length > 254 ? null : out;
}

export function requireEmail(value: string): string {
  const email = normalizeEmail(value);
  if (!email) throw new HttpError(400, 'invalid_email', 'Enter a valid email address.');
  return email;
}

export function requireDisplayName(value: string): string {
  const name = value.trim().replace(/\s+/g, ' ');
  // No control or format characters (bidi overrides, zero-width marks); 1 to 50 characters
  if (!name || [...name].length > 50 || /[\p{Cc}\p{Cf}]/u.test(name)) throw new HttpError(400, 'invalid_display_name', 'Enter a name of 1 to 50 characters.');
  return name;
}

export function requireStrongPassword(password: string, email: string | null, displayName: string | null = null): void {
  const problem = passwordProblem(password, email, displayName);
  if (problem) throw new HttpError(400, problem.code, problem.message);
}

/** Issues a verification token and emails the link (after the answer is sent, when the platform allows it) */
export async function sendVerification(c: RouteContext, userId: string, email: string): Promise<void> {
  const token = await issueToken(c.env.DB, userId, 'verify', c.deps.now());
  await inBackground(c.deps, () => sendEmail(c.env, c.deps, verificationEmail(appOrigin(c), email, token)));
}

async function register(c: RouteContext): Promise<Response> {
  const now = c.deps.now();
  await enforceLimit(c.env, LIMITS.registerIp, ipSubject(c.request), now);
  const body = await c.body();
  const email = requireEmail(str(body, 'email', 320));
  const password = str(body, 'password', 1024);
  const displayName = requireDisplayName(str(body, 'displayName', 200));
  if (body.ageConfirmed !== true) throw new HttpError(400, 'age_required', 'Confirm that you are 13 or older to create an account.');
  requireStrongPassword(password, email, displayName);

  const taken = () => new HttpError(409, 'email_taken', 'An account with this email already exists. Sign in, or reset the password.');
  // A lapsed unverified claim on the address gives way to this sign-up
  if (!(await releaseStaleClaim(c.env.DB, email, now))) throw taken();

  const id = crypto.randomUUID();
  const hash = await hashPassword(password);
  try {
    await c.env.DB.prepare(
      'INSERT INTO users (id, display_name, avatar_url, created_at, email, email_set_at, password_hash, updated_at) VALUES (?, ?, NULL, ?, ?, ?, ?, ?)',
    )
      .bind(id, displayName, now, email, now, hash, now)
      .run();
  } catch (err) {
    // A second sign-up for the same address at the same moment
    if (isUniqueViolation(err)) throw taken();
    throw err;
  }
  await c.env.DB.prepare('INSERT INTO identities (provider, provider_id, user_id, login, linked_at) VALUES (?, ?, ?, ?, ?)')
    .bind('email', email, id, email, now)
    .run();

  // A sign-up replaces whatever session this browser had
  await endIncomingSession(c);
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
  // The per-IP limit and the hourly per-email ceiling are hard. The 15-minute per-email limit is soft:
  // past it, only a correct password gets through, so strangers cannot lock the owner out.
  await enforceLimit(c.env, LIMITS.loginIp, ipSubject(c.request), now);
  if (email) await enforceLimit(c.env, LIMITS.loginEmailHour, email, now);
  const perEmail = email ? await countLimit(c.env, LIMITS.loginEmail, email, now) : null;

  const row = email
    ? await c.env.DB.prepare('SELECT id, password_hash, email, email_verified_at, email_set_at FROM users WHERE email = ?')
        .bind(email)
        .first<{ id: string; password_hash: string | null; email: string; email_verified_at: number | null; email_set_at: number | null }>()
    : null;
  // A lapsed unverified address no longer signs in (same answer as a wrong password)
  const usable = row && row.password_hash && !staleEmailClaim(row, now) ? row : null;
  // Same work, same answer whether or not the account exists or has a password
  const ok = usable ? await verifyPassword(password, usable.password_hash!) : await verifyAgainstDummy(password);
  if (!usable || !ok) {
    if (perEmail?.over) throw rateLimited(perEmail.retryAfter);
    throw INVALID_CREDENTIALS();
  }

  await endIncomingSession(c);
  const session = await createSession(c.env.DB, usable.id, now);
  const user = await loadUser(c.env.DB, usable.id);
  return json({ user: toPublicUser(user!) }, 200, { 'Set-Cookie': sessionCookie(session) });
}

/**
 * POST /api/auth/email/verify { token }: the link from the email confirms the address. It does not sign the
 * browser in: whoever opens the link proves the inbox, not that they may use the account here.
 * A link only confirms the claim it was sent for: the account's current address must have been set before
 * the link was made (an older link never confirms a newer address), and the claim must not have lapsed.
 */
async function verify(c: RouteContext): Promise<Response> {
  const now = c.deps.now();
  const token = str(await c.body(), 'token', 200);
  const userId = await consumeToken(c.env.DB, token, 'verify', now);
  if (!userId) {
    throw (await tokenFailure(c.env.DB, token, 'verify', now)) === 'token_expired'
      ? new HttpError(400, 'token_expired', 'This link has expired. Ask for a new one.')
      : new HttpError(400, 'invalid_token', 'This link is invalid or was already used. Ask for a new one.');
  }
  const confirmed = await c.env.DB.prepare(
    `UPDATE users SET email_verified_at = COALESCE(email_verified_at, ?)
      WHERE id = ? AND email IS NOT NULL
        AND (email_verified_at IS NOT NULL
          OR (email_set_at <= (SELECT created_at FROM auth_tokens WHERE token_hash = ?) AND email_set_at > ?))
      RETURNING id`,
  )
    .bind(now, userId, await sha256(token), now - EMAIL_CLAIM_TTL)
    .first<{ id: string }>();
  if (!confirmed) {
    throw new HttpError(400, 'invalid_token', 'This link is for an earlier sign-up or address on the account. Sign in and ask for a new link, or sign up again.');
  }
  return json({ ok: true });
}

/** POST /api/auth/email/resend-verification (signed in): a new link, at most 3 an hour; the older ones stop working */
async function resendVerification(c: RouteContext): Promise<Response> {
  const { user } = await requireUser(c);
  await enforceLimit(c.env, LIMITS.resendVerification, user.id, c.deps.now());
  if (!user.email) throw new HttpError(400, 'no_email', 'Add an email address to your account first.');
  // A lapsed claim no longer holds the address, so it gets no new links (stops endless confirm emails to a stranger)
  if (staleEmailClaim(user, c.deps.now())) {
    throw new HttpError(409, 'email_claim_lapsed', 'This address was not confirmed within 24 hours, so it is no longer held for this account. Sign up again to use it.');
  }
  if (user.email_verified_at === null) await sendVerification(c, user.id, user.email);
  return json({ ok: true }, 202);
}

/**
 * Makes `email` free for a new owner when its holder's claim has lapsed (unverified and set more than 24 h
 * ago): the holder loses the address, its password (which only signed in with that address) and its
 * pending links. Returns whether the address is free now; false when someone holds it validly.
 */
export async function releaseStaleClaim(db: Db, email: string, now: number, exceptUserId: string | null = null): Promise<boolean> {
  const holder = await db
    .prepare('SELECT id, email, email_verified_at, email_set_at FROM users WHERE email = ?')
    .bind(email)
    .first<{ id: string; email: string; email_verified_at: number | null; email_set_at: number | null }>();
  if (!holder || holder.id === exceptUserId) return true;
  if (!staleEmailClaim(holder, now)) return false;
  // Recheck eligibility in the write: verification or a refreshed claim may have won the race.
  const released = await db
    .prepare(`UPDATE users SET email = NULL, email_verified_at = NULL, email_set_at = NULL, password_hash = NULL, updated_at = ?
      WHERE id = ? AND email = ? AND email_verified_at IS NULL AND COALESCE(email_set_at, 0) <= ?
      RETURNING id`)
    .bind(now, holder.id, email, now - EMAIL_CLAIM_TTL)
    .first<{ id: string }>();
  if (!released) return false;
  await db.prepare("DELETE FROM identities WHERE user_id = ? AND provider = 'email'").bind(holder.id).run();
  await revokeTokens(db, holder.id, ['verify', 'reset'], now);
  return true;
}

export const emailRoutes: Route[] = [
  { method: 'POST', path: '/api/auth/email/register', handler: register },
  { method: 'POST', path: '/api/auth/email/login', handler: login },
  { method: 'POST', path: '/api/auth/email/verify', handler: verify },
  { method: 'POST', path: '/api/auth/email/resend-verification', handler: resendVerification },
];
