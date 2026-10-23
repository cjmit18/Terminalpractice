// One-time tokens for email verification and password reset: 32 random bytes, only the SHA-256 stored,
// single use, short-lived.
import { randomToken, sha256, type Db } from './http';

export type TokenPurpose = 'verify' | 'reset';

export const TOKEN_TTL: Record<TokenPurpose, number> = {
  verify: 24 * 60 * 60 * 1000,
  reset: 60 * 60 * 1000,
};

/**
 * Issues a new token and retires the user's earlier unused ones for the same purpose, so only the newest link works.
 * `email` records the address the link is sent to (a confirm link then verifies only that address).
 *
 * "Newest" is the highest rowid for the user and purpose. The token is inserted first and the older ones are retired
 * after, each in one statement, so two requests at once still leave only the later insert working; consumeToken
 * also accepts only the newest, which closes the moment between one request's insert and its retiring step.
 */
export async function issueToken(db: Db, userId: string, purpose: TokenPurpose, now: number, email: string | null = null): Promise<string> {
  await db.prepare('DELETE FROM auth_tokens WHERE user_id = ? AND expires_at <= ?').bind(userId, now).run();
  const token = randomToken();
  await db
    .prepare('INSERT INTO auth_tokens (token_hash, user_id, purpose, expires_at, created_at, email) VALUES (?, ?, ?, ?, ?, ?)')
    .bind(await sha256(token), userId, purpose, now + TOKEN_TTL[purpose], now, email)
    .run();
  await db
    .prepare(
      `UPDATE auth_tokens SET used_at = ?
        WHERE user_id = ? AND purpose = ? AND used_at IS NULL
          AND rowid < (SELECT MAX(rowid) FROM auth_tokens WHERE user_id = ? AND purpose = ?)`,
    )
    .bind(now, userId, purpose, userId, purpose)
    .run();
  return token;
}

/** SQL condition: the token row is the newest issued for its user and purpose */
const NEWEST = 'rowid = (SELECT MAX(t.rowid) FROM auth_tokens t WHERE t.user_id = auth_tokens.user_id AND t.purpose = auth_tokens.purpose)';

/** The user a still-valid token belongs to, without using it up */
export async function peekToken(db: Db, token: string, purpose: TokenPurpose, now: number): Promise<string | null> {
  const row = await db
    .prepare(`SELECT user_id FROM auth_tokens WHERE token_hash = ? AND purpose = ? AND used_at IS NULL AND expires_at > ? AND ${NEWEST}`)
    .bind(await sha256(token), purpose, now)
    .first<{ user_id: string }>();
  return row?.user_id ?? null;
}

/** Uses a token up in one statement (so two concurrent uses cannot both succeed); returns its user or null */
export async function consumeToken(db: Db, token: string, purpose: TokenPurpose, now: number): Promise<string | null> {
  const row = await db
    .prepare(
      `UPDATE auth_tokens SET used_at = ?
        WHERE token_hash = ? AND purpose = ? AND used_at IS NULL AND expires_at > ? AND ${NEWEST}
        RETURNING user_id`,
    )
    .bind(now, await sha256(token), purpose, now)
    .first<{ user_id: string }>();
  return row?.user_id ?? null;
}

/** Why a token did not work: 'token_expired' for an unused token past its time, otherwise 'invalid_token' */
export async function tokenFailure(db: Db, token: string, purpose: TokenPurpose, now: number): Promise<'token_expired' | 'invalid_token'> {
  const row = await db
    .prepare('SELECT 1 AS x FROM auth_tokens WHERE token_hash = ? AND purpose = ? AND used_at IS NULL AND expires_at <= ?')
    .bind(await sha256(token), purpose, now)
    .first();
  return row ? 'token_expired' : 'invalid_token';
}

/** Marks a user's unused tokens as used: after an email change, a password change or a reset */
export async function revokeTokens(db: Db, userId: string, purposes: TokenPurpose[], now: number): Promise<void> {
  for (const purpose of purposes) {
    await db.prepare('UPDATE auth_tokens SET used_at = ? WHERE user_id = ? AND purpose = ? AND used_at IS NULL').bind(now, userId, purpose).run();
  }
}
