// Email + password accounts: sign up, sign in, confirm the address, and reset a forgotten password.
import { HttpError, appOrigin, inBackground, ipSubject, isUniqueViolation, json, sha256, str, type Db, type Route, type RouteContext } from '../http';
import { emailSendingEnabled, resetEmail, sendEmail, verificationEmail } from '../mail';
import { hashPassword, passwordProblem, pepperHash, pepperStoredHash, verifyAgainstDummy, verifyPassword } from '../password';
import { LIMITS, countLimit, enforceLimit, rateLimited } from '../ratelimit';
import { EMAIL_CLAIM_TTL, createPasswordSession, endIncomingSession, loadUser, requireUser, sessionCookie, staleEmailClaim, toPublicUser } from '../session';
import { SYNC_TABLES } from '../sync';
import { TOKEN_TTL, consumeToken, issueToken, peekToken, revokeTokens, tokenFailure, type TokenPurpose } from '../tokens';

const INVALID_CREDENTIALS = () => new HttpError(401, 'invalid_credentials', 'That email and password do not match an account.');
const INVALID_TOKEN = () => new HttpError(400, 'invalid_token', 'This link is invalid or was already used. Ask for a new one.');

/** invalid_token, or token_expired for a link that only ran out of time */
async function badToken(c: RouteContext, token: string, purpose: TokenPurpose): Promise<HttpError> {
  return (await tokenFailure(c.env.DB, token, purpose, c.deps.now())) === 'token_expired'
    ? new HttpError(400, 'token_expired', 'This link has expired. Ask for a new one.')
    : INVALID_TOKEN();
}

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
/**
 * Sends a confirm link for the account's unconfirmed address. The link lasts no longer than the claim on the
 * address (24 hours from when it was set): a link resent at hour 23 works for 1 hour and says so (#28, 14).
 */
export async function sendVerification(c: RouteContext, userId: string, email: string): Promise<void> {
  const now = c.deps.now();
  const row = await c.env.DB.prepare('SELECT email_set_at FROM users WHERE id = ?').bind(userId).first<{ email_set_at: number | null }>();
  const left = Math.min(TOKEN_TTL.verify, (row?.email_set_at ?? now) + EMAIL_CLAIM_TTL - now);
  if (left <= 0) return;
  const token = await issueToken(c.env.DB, userId, 'verify', now, email, left);
  await inBackground(c.deps, () => sendEmail(c.env, c.deps, verificationEmail(appOrigin(c), email, token, left)));
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
  const hash = await hashPassword(password, c.env);
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
  // Only while the account still has the password set here: if the inbox owner reset it meanwhile (taking
  // the address back), this sign-up gets no session (#51, 1)
  const session = await createPasswordSession(c.env.DB, id, now, hash);
  if (!session) {
    throw new HttpError(409, 'email_taken', 'The owner of this email address took it back while the account was being made. Sign in, or reset the password.');
  }
  await sendVerification(c, id, email);
  const user = await loadUser(c.env.DB, id);
  // emailSent false: this site cannot send email yet, so no confirmation link is on its way
  return json({ user: toPublicUser(user!), emailSent: emailSendingEnabled(c.env, c.deps) }, 201, { 'Set-Cookie': sessionCookie(session) });
}

async function login(c: RouteContext): Promise<Response> {
  const now = c.deps.now();
  const body = await c.body();
  const password = str(body, 'password', 1024);
  const email = normalizeEmail(str(body, 'email', 320));
  // The per-IP limit is hard. Both per-email limits are soft: past them, only a correct password gets
  // through, so strangers trying passwords from many addresses cannot lock the owner out.
  await enforceLimit(c.env, LIMITS.loginIp, ipSubject(c.request), now);
  const perHour = email ? await countLimit(c.env, LIMITS.loginEmailHour, email, now) : null;
  const perEmail = email ? await countLimit(c.env, LIMITS.loginEmail, email, now) : null;

  const row = email
    ? await c.env.DB.prepare('SELECT id, password_hash, email, email_verified_at, email_set_at FROM users WHERE email = ?')
        .bind(email)
        .first<{ id: string; password_hash: string | null; email: string; email_verified_at: number | null; email_set_at: number | null }>()
    : null;
  // An unconfirmed address still signs in to its account, even after its 24 hours, until someone else signs
  // up with it and takes it: a learner who signed out before confirming is not locked out of their account
  const usable = row && row.password_hash ? row : null;
  // Same work, same answer whether or not the account exists or has a password
  const ok = usable ? await verifyPassword(password, usable.password_hash!, c.env) : await verifyAgainstDummy(password, c.env);
  if (!usable || !ok) {
    const over = [perEmail, perHour].find(l => l?.over);
    if (over) throw rateLimited(over.retryAfter);
    throw INVALID_CREDENTIALS();
  }

  // Only while the password is still the one just checked: a reset that finished meanwhile wins
  // A hash from before the pepper is upgraded now; a sign-in elsewhere upgrading it meanwhile still counts
  const upgraded = await pepperStoredHash(usable.password_hash!, c.env);
  const session = await createPasswordSession(c.env.DB, usable.id, now, usable.password_hash!, upgraded);
  if (!session) throw INVALID_CREDENTIALS();
  if (upgraded) await pepperHash(c.env.DB, usable.id, usable.password_hash!, upgraded);
  await endIncomingSession(c);
  const user = await loadUser(c.env.DB, usable.id);
  return json({ user: toPublicUser(user!) }, 200, { 'Set-Cookie': sessionCookie(session) });
}

/**
 * POST /api/auth/email/verify { token }: the link from the email confirms the address. It does not sign the
 * browser in: whoever opens the link proves the inbox, not that they may use the account here.
 * A link only confirms the claim it was sent for: the account's current address must be the exact address the
 * link was sent to, set before the link was made, and the claim must not have lapsed. Comparing the address
 * itself covers an address that changes while a link is being sent (the link still goes to the old inbox).
 */
const LAPSED_MESSAGE = 'This address was not confirmed within 24 hours. To confirm it now, use Forgot password: the reset link confirms the address too.';

/** The confirm link's account still holds its address, unconfirmed, and the 24-hour claim on it has run out */
async function claimLapsed(db: Db, tokenHash: string, now: number): Promise<boolean> {
  const row = await db
    .prepare(
      `SELECT 1 AS x FROM users u JOIN auth_tokens t ON t.user_id = u.id
        WHERE t.token_hash = ? AND t.purpose = 'verify' AND u.email_verified_at IS NULL AND u.email = t.email AND u.email_set_at <= ?`,
    )
    .bind(tokenHash, now - EMAIL_CLAIM_TTL)
    .first();
  return row !== null;
}

async function verify(c: RouteContext): Promise<Response> {
  const now = c.deps.now();
  const token = str(await c.body(), 'token', 200);
  const tokenHash = await sha256(token);
  const userId = await consumeToken(c.env.DB, token, 'verify', now);
  if (!userId) {
    // A link now ends with the claim on its address: when that is why it no longer works, say how to confirm it now
    if (await claimLapsed(c.env.DB, tokenHash, now)) throw new HttpError(400, 'email_claim_lapsed', LAPSED_MESSAGE);
    throw await badToken(c, token, 'verify');
  }
  const confirmed = await c.env.DB.prepare(
    `UPDATE users SET email_verified_at = COALESCE(email_verified_at, ?)
      WHERE id = ? AND email IS NOT NULL
        AND (email_verified_at IS NOT NULL
          OR (email = (SELECT email FROM auth_tokens WHERE token_hash = ?)
            AND email_set_at <= (SELECT created_at FROM auth_tokens WHERE token_hash = ?)
            AND email_set_at > ?))
      RETURNING id`,
  )
    .bind(now, userId, tokenHash, tokenHash, now - EMAIL_CLAIM_TTL)
    .first<{ id: string }>();
  if (!confirmed) {
    // The address is still this account's but was not confirmed in time: say so, and how to confirm it now
    if (await claimLapsed(c.env.DB, tokenHash, now)) throw new HttpError(400, 'email_claim_lapsed', LAPSED_MESSAGE);
    throw new HttpError(400, 'invalid_token', 'This link is for an earlier sign-up or address on the account. Sign in and ask for a new link, or sign up again.');
  }
  return json({ ok: true });
}

/** POST /api/auth/email/resend-verification (signed in): a new link, at most 3 an hour; the older ones stop working */
async function resendVerification(c: RouteContext): Promise<Response> {
  const { user } = await requireUser(c);
  await enforceLimit(c.env, LIMITS.resendVerification, user.id, c.deps.now());
  if (!user.email) throw new HttpError(400, 'no_email', 'Add an email address to your account first.');
  // A lapsed claim gets no new links from a signed-in account (stops endless confirm emails to a stranger).
  // The inbox owner confirms it with a password reset instead: that link goes to the inbox, not to whoever signed up.
  if (staleEmailClaim(user, c.deps.now())) {
    throw new HttpError(409, 'email_claim_lapsed', LAPSED_MESSAGE);
  }
  if (user.email_verified_at === null) await sendVerification(c, user.id, user.email);
  return json({ ok: true, emailSent: emailSendingEnabled(c.env, c.deps) }, 202);
}

/**
 * POST /api/auth/password/forgot { email }: emails a reset link to the address if an account holds it. The answer
 * is always 202, also when limited or when no account has the address, so it never says which addresses have one.
 */
async function forgot(c: RouteContext): Promise<Response> {
  const now = c.deps.now();
  const raw = str(await c.body(), 'email', 320);
  const email = normalizeEmail(raw);
  const perIp = await countLimit(c.env, LIMITS.forgotIp, ipSubject(c.request), now);
  const perEmail = await countLimit(c.env, LIMITS.forgotEmail, email ?? raw, now);
  if (perIp.over || perEmail.over || !email) return json({ ok: true }, 202);
  // Looking the account up, issuing the token and sending all happen after the answer when possible,
  // so neither the answer nor its timing says whether the email has an account
  await inBackground(c.deps, async () => {
    const row = await c.env.DB.prepare('SELECT id FROM users WHERE email = ?').bind(email).first<{ id: string }>();
    if (!row) return;
    const token = await issueToken(c.env.DB, row.id, 'reset', now, email);
    await sendEmail(c.env, c.deps, resetEmail(appOrigin(c), email, token));
  });
  return json({ ok: true }, 202);
}

/**
 * POST /api/auth/password/reset { token, password }: sets a new password from the emailed link, confirms the
 * address (the link reached its inbox), ends every other session and signs this browser in.
 * An address that was never confirmed was only a claim: whoever signed up with it may not own the inbox
 * (address squatting), so before the inbox owner takes the account over, the claimant's other sign-in
 * methods and sessions are removed.
 */
async function reset(c: RouteContext): Promise<Response> {
  const now = c.deps.now();
  const body = await c.body();
  const token = str(body, 'token', 200);
  const password = str(body, 'password', 1024);
  // Check the new password before using the link up, so a refused password can be retried with the same link
  const pendingUser = await peekToken(c.env.DB, token, 'reset', now);
  if (!pendingUser) throw await badToken(c, token, 'reset');
  const before = await loadUser(c.env.DB, pendingUser);
  if (!before) throw INVALID_TOKEN();
  requireStrongPassword(password, before.email, before.display_name);
  const hash = await hashPassword(password, c.env);

  const tokenHash = await sha256(token);
  const userId = await consumeToken(c.env.DB, token, 'reset', now);
  if (!userId) throw await badToken(c, token, 'reset');
  // The link proves only the inbox it was sent to: if the account's address changed since, it is stale
  const current = await c.env.DB.prepare(
    `SELECT id, email_verified_at FROM users WHERE id = ? AND email IS NOT NULL
       AND email = (SELECT email FROM auth_tokens WHERE token_hash = ?)`,
  )
    .bind(userId, tokenHash)
    .first<{ id: string; email_verified_at: number | null }>();
  if (!current) throw INVALID_TOKEN();
  // Taking an unconfirmed address back: the claimant's other sign-in methods and synced progress go, and the
  // inbox owner starts fresh. This runs before the password write, with the same conditions as that write and
  // while the account is still unconfirmed, so whichever reset confirms the account has already done it: two
  // resets at once can never both skip it (#68 review).
  const authorized = `id = ?1 AND email_verified_at IS NULL AND email IS NOT NULL
    AND email = (SELECT email FROM auth_tokens WHERE token_hash = ?2)
    AND NOT EXISTS (SELECT 1 FROM auth_tokens WHERE user_id = ?1 AND purpose = 'reset'
                      AND rowid > (SELECT rowid FROM auth_tokens WHERE token_hash = ?2))`;
  if (current.email_verified_at === null) {
    const ifClaimed = (sql: string) => c.env.DB.prepare(sql).bind(userId, tokenHash).run();
    await ifClaimed(`DELETE FROM identities WHERE user_id = ?1 AND provider <> 'email' AND EXISTS (SELECT 1 FROM users WHERE ${authorized})`);
    for (const table of SYNC_TABLES) await ifClaimed(`DELETE FROM ${table} WHERE user_id = ?1 AND EXISTS (SELECT 1 FROM users WHERE ${authorized})`);
  }
  // The same check again inside the write: the address may have been released to a new sign-up since.
  // Nothing changes unless this account still holds the address the link was sent to, and no newer reset
  // link has been issued since this one: a newer reset, even one that finished first, always wins (#51, 2)
  const changed = await c.env.DB.prepare(
    `UPDATE users SET password_hash = ?1, email_verified_at = COALESCE(email_verified_at, ?2), updated_at = ?2
      WHERE id = ?3 AND email IS NOT NULL AND email = (SELECT email FROM auth_tokens WHERE token_hash = ?4)
        AND NOT EXISTS (SELECT 1 FROM auth_tokens WHERE user_id = ?3 AND purpose = 'reset'
                          AND rowid > (SELECT rowid FROM auth_tokens WHERE token_hash = ?4))
      RETURNING id`,
  )
    .bind(hash, now, userId, tokenHash)
    .first<{ id: string }>();
  if (!changed) throw INVALID_TOKEN();
  // Ending sessions and links runs only while the password is still the one set here, each step in its own
  // statement: a newer reset or change that lands meanwhile has done its own, and this slower request must not
  // end the sessions or links that one just made (#68 review). The peppered form of the hash counts as the same.
  const still = `(SELECT password_hash FROM users WHERE id = ?1) IN (?2, ?3)`;
  const peppered = (await pepperStoredHash(hash, c.env)) ?? hash;
  const ifStill = (sql: string) => c.env.DB.prepare(sql).bind(userId, hash, peppered).run();
  await c.env.DB.prepare(
    `UPDATE auth_tokens SET used_at = ?4 WHERE user_id = ?1 AND purpose IN ('verify', 'reset') AND used_at IS NULL AND ${still}`,
  )
    .bind(userId, hash, peppered, now)
    .run();
  await ifStill(`DELETE FROM sessions WHERE user_id = ?1 AND ${still}`);
  await endIncomingSession(c);
  // Only while the password is still the one set here: a newer reset or change that finished meanwhile wins
  const session = await createPasswordSession(c.env.DB, userId, now, hash, peppered);
  if (!session) throw new HttpError(409, 'conflict', 'Your password was changed again elsewhere. Sign in with the newest one.');
  const user = await loadUser(c.env.DB, userId);
  return json({ user: toPublicUser(user!) }, 200, { 'Set-Cookie': sessionCookie(session) });
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
  { method: 'POST', path: '/api/auth/password/forgot', handler: forgot },
  { method: 'POST', path: '/api/auth/password/reset', handler: reset },
];
