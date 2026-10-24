// Sessions (the __Host-session cookie, stored as a SHA-256 hash) and the public view of a user.
import { HttpError, cookie, clearCookie, randomToken, readCookie, sha256, type Db, type RouteContext } from './http';

export const SESSION_COOKIE = '__Host-session';
export const DAY = 24 * 60 * 60 * 1000;
export const SESSION_TTL = 30 * DAY;
/** Sliding expiry: a session used with less than this left is extended to the full TTL */
export const RENEW_BELOW = 15 * DAY;
/** Absolute lifetime: however often it is used, a session ends this long after it was created */
export const SESSION_MAX_AGE = 90 * DAY;
/** How long a sign-in counts as recent for sensitive actions on an account without a password */
export const REAUTH_WINDOW = 10 * 60 * 1000;

/** When a session should expire after being used at `now`: the sliding TTL, capped by the absolute lifetime */
export function renewedExpiry(createdAt: number, now: number): number {
  return Math.min(now + SESSION_TTL, createdAt + SESSION_MAX_AGE);
}

/** Whether a session row is still valid at `now` */
export function sessionAlive(row: { expires_at: number; created_at: number }, now: number): boolean {
  return row.expires_at > now && row.created_at + SESSION_MAX_AGE > now;
}

export interface PublicUser {
  id: string;
  name: string;
  /** GitHub username, when GitHub is linked */
  login: string | null;
  email: string | null;
  emailVerified: boolean;
  avatarUrl: string | null;
}

export interface UserRow {
  id: string;
  display_name: string;
  avatar_url: string | null;
  email: string | null;
  email_verified_at: number | null;
  /** When the current (unverified) email was set; an unverified claim lapses EMAIL_CLAIM_TTL later */
  email_set_at: number | null;
  password_hash: string | null;
  created_at: number;
  updated_at: number | null;
  login: string | null;
}

/** Selects a UserRow from `users u` (plus the GitHub username) */
export const USER_COLUMNS = `u.id, u.display_name, u.avatar_url, u.email, u.email_verified_at, u.email_set_at, u.password_hash,
  u.created_at, u.updated_at,
  (SELECT login FROM identities i WHERE i.user_id = u.id AND i.provider = 'github') AS login`;

/** An unverified email holds its address for this long after it was set; then a sign-up or another account may take it */
export const EMAIL_CLAIM_TTL = DAY;

/** Whether the row's email is an unverified claim that has lapsed */
export function staleEmailClaim(row: Pick<UserRow, 'email' | 'email_verified_at' | 'email_set_at'>, now: number): boolean {
  return row.email !== null && row.email_verified_at === null && (row.email_set_at ?? 0) + EMAIL_CLAIM_TTL <= now;
}

/** The account's email is set but not verified (a claim, not proof of the inbox) */
export const emailUnverified = (row: Pick<UserRow, 'email' | 'email_verified_at'>) => row.email !== null && row.email_verified_at === null;

export function toPublicUser(row: UserRow): PublicUser {
  return {
    id: row.id,
    name: row.display_name,
    login: row.login,
    email: row.email,
    emailVerified: row.email_verified_at !== null,
    avatarUrl: row.avatar_url,
  };
}

export async function loadUser(db: Db, userId: string): Promise<UserRow | null> {
  return db.prepare(`SELECT ${USER_COLUMNS} FROM users u WHERE u.id = ?`).bind(userId).first<UserRow>();
}

/**
 * Creates a session and returns the raw token (only its hash is stored). Drops the user's expired sessions.
 * Every new session comes from a sign-in (password, OAuth, registration, reset or password change), so
 * `authenticated_at` starts at `now`.
 */
export async function createSession(db: Db, userId: string, now: number): Promise<string> {
  const token = randomToken();
  await db
    .prepare('DELETE FROM sessions WHERE user_id = ? AND (expires_at <= ? OR created_at <= ?)')
    .bind(userId, now, now - SESSION_MAX_AGE)
    .run();
  await db
    .prepare('INSERT INTO sessions (token_hash, user_id, expires_at, created_at, authenticated_at) VALUES (?, ?, ?, ?, ?)')
    .bind(await sha256(token), userId, now + SESSION_TTL, now, now)
    .run();
  return token;
}

/**
 * A session for a password sign-in, created only if the account still has the password hash that was checked,
 * in the same statement. A reset or password change that lands between the check and here (and ends every
 * session) is not undone by the slower sign-in. Null when the password changed.
 */
export async function createPasswordSession(db: Db, userId: string, now: number, passwordHash: string): Promise<string | null> {
  const token = randomToken();
  await db
    .prepare('DELETE FROM sessions WHERE user_id = ? AND (expires_at <= ? OR created_at <= ?)')
    .bind(userId, now, now - SESSION_MAX_AGE)
    .run();
  const made = await db
    .prepare(
      `INSERT INTO sessions (token_hash, user_id, expires_at, created_at, authenticated_at)
       SELECT ?, id, ?, ?, ? FROM users WHERE id = ? AND password_hash = ?
       RETURNING token_hash`,
    )
    .bind(await sha256(token), now + SESSION_TTL, now, now, userId, passwordHash)
    .first<{ token_hash: string }>();
  return made ? token : null;
}

export function sessionCookie(token: string, maxAgeMs = SESSION_TTL): string {
  return cookie(SESSION_COOKIE, token, maxAgeMs / 1000);
}

/** Ends the session named by the request's cookie, if any: a new sign-in replaces it instead of leaving it valid */
export async function endIncomingSession(c: Pick<RouteContext, 'request' | 'env'>): Promise<void> {
  const token = readCookie(c.request, SESSION_COOKIE);
  if (token) await c.env.DB.prepare('DELETE FROM sessions WHERE token_hash = ?').bind(await sha256(token)).run();
}

/** Marks this session as just authenticated (POST /api/account/reauth, OAuth `?reauth=1`) */
export async function markAuthenticated(db: Db, tokenHash: string, now: number): Promise<void> {
  await db.prepare('UPDATE sessions SET authenticated_at = ? WHERE token_hash = ?').bind(now, tokenHash).run();
}

export const clearSessionCookie = () => clearCookie(SESSION_COOKIE);

/** Ends every session of a user: sign out everywhere, password change, password reset */
export async function endAllSessions(db: Db, userId: string): Promise<void> {
  await db.prepare('DELETE FROM sessions WHERE user_id = ?').bind(userId).run();
}

export interface Session {
  userId: string;
  tokenHash: string;
  createdAt: number;
  /** When this session's user last proved who they are (sign-in or re-authentication) */
  authenticatedAt: number;
  /** When the session now expires (after any renewal below) */
  expiresAt: number;
  /**
   * Set when this request renewed the session: a Set-Cookie value with the matching new Max-Age, for the
   * response to send so the browser keeps the cookie as long as the server keeps the session.
   */
  renewedCookie?: string;
}

/**
 * The signed-in session for this request, or null (no cookie, unknown, expired, or past its absolute lifetime).
 * A session used with less than RENEW_BELOW left slides forward to the full TTL, never past its absolute
 * lifetime; the result then carries `renewedCookie` for the response.
 */
export async function currentSession(c: Pick<RouteContext, 'request' | 'env' | 'deps'>): Promise<Session | null> {
  const token = readCookie(c.request, SESSION_COOKIE);
  if (!token) return null;
  const tokenHash = await sha256(token);
  const row = await c.env.DB.prepare('SELECT user_id, expires_at, created_at, authenticated_at FROM sessions WHERE token_hash = ?')
    .bind(tokenHash)
    .first<{ user_id: string; expires_at: number; created_at: number; authenticated_at: number | null }>();
  const now = c.deps.now();
  if (!row || !sessionAlive(row, now)) return null;
  const session: Session = {
    userId: row.user_id,
    tokenHash,
    createdAt: row.created_at,
    authenticatedAt: row.authenticated_at ?? row.created_at,
    expiresAt: row.expires_at,
  };
  const renewed = renewedExpiry(row.created_at, now);
  if (row.expires_at - now < RENEW_BELOW && renewed > row.expires_at) {
    // One atomic statement that never moves the expiry backward: when two requests renew at once, the later
    // expiry wins whatever order the writes land in, and each cookie follows what the row actually holds
    const updated = await c.env.DB.prepare('UPDATE sessions SET expires_at = MAX(expires_at, ?) WHERE token_hash = ? RETURNING expires_at')
      .bind(renewed, tokenHash)
      .first<{ expires_at: number }>();
    if (!updated) return null; // ended (sign out) between the read and the renewal
    session.expiresAt = updated.expires_at;
    session.renewedCookie = sessionCookie(token, updated.expires_at - now);
  }
  return session;
}

export async function requireSession(c: Pick<RouteContext, 'request' | 'env' | 'deps'>): Promise<Session> {
  const session = await currentSession(c);
  if (!session) throw new HttpError(401, 'not_signed_in', 'Sign in to continue.');
  return session;
}

/** The signed-in user's row, or a 401 */
export async function requireUser(c: Pick<RouteContext, 'request' | 'env' | 'deps'>): Promise<{ session: Session; user: UserRow }> {
  const session = await requireSession(c);
  const user = await loadUser(c.env.DB, session.userId);
  if (!user) throw new HttpError(401, 'not_signed_in', 'Sign in to continue.');
  return { session, user };
}
