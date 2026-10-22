// Sessions (the __Host-session cookie, stored as a SHA-256 hash) and the public view of a user.
import { HttpError, cookie, clearCookie, randomToken, readCookie, sha256, type Db, type RouteContext } from './http';

export const SESSION_COOKIE = '__Host-session';
export const DAY = 24 * 60 * 60 * 1000;
export const SESSION_TTL = 30 * DAY;
/** Sliding expiry: a session used with less than this left is extended to the full TTL */
export const RENEW_BELOW = 15 * DAY;

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
  password_hash: string | null;
  created_at: number;
  updated_at: number | null;
  login: string | null;
}

/** Selects a UserRow from `users u` (plus the GitHub username) */
export const USER_COLUMNS = `u.id, u.display_name, u.avatar_url, u.email, u.email_verified_at, u.password_hash,
  u.created_at, u.updated_at,
  (SELECT login FROM identities i WHERE i.user_id = u.id AND i.provider = 'github') AS login`;

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

/** Creates a session and returns the raw token (only its hash is stored). Drops the user's expired sessions. */
export async function createSession(db: Db, userId: string, now: number): Promise<string> {
  const token = randomToken();
  await db.prepare('DELETE FROM sessions WHERE user_id = ? AND expires_at <= ?').bind(userId, now).run();
  await db
    .prepare('INSERT INTO sessions (token_hash, user_id, expires_at, created_at) VALUES (?, ?, ?, ?)')
    .bind(await sha256(token), userId, now + SESSION_TTL, now)
    .run();
  return token;
}

export function sessionCookie(token: string): string {
  return cookie(SESSION_COOKIE, token, SESSION_TTL / 1000);
}

export const clearSessionCookie = () => clearCookie(SESSION_COOKIE);

/** Ends every session of a user: sign out everywhere, password change, password reset */
export async function endAllSessions(db: Db, userId: string): Promise<void> {
  await db.prepare('DELETE FROM sessions WHERE user_id = ?').bind(userId).run();
}

export interface Session {
  userId: string;
  tokenHash: string;
}

/** The signed-in session for this request, or null (no cookie, unknown, or expired) */
export async function currentSession(c: Pick<RouteContext, 'request' | 'env' | 'deps'>): Promise<Session | null> {
  const token = readCookie(c.request, SESSION_COOKIE);
  if (!token) return null;
  const tokenHash = await sha256(token);
  const row = await c.env.DB.prepare('SELECT user_id, expires_at FROM sessions WHERE token_hash = ?')
    .bind(tokenHash)
    .first<{ user_id: string; expires_at: number }>();
  if (!row || row.expires_at <= c.deps.now()) return null;
  return { userId: row.user_id, tokenHash };
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
