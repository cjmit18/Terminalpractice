// Fixed-window rate limits kept in D1 (table rate_limits). Subjects (emails, IP addresses) are hashed
// into the key, so the table never holds them in readable form.
import { HttpError, sha256, type Db } from './http';

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;

export interface Limit {
  name: string;
  max: number;
  windowMs: number;
}

/** The limits from docs/ACCOUNTS_API.md, plus a few for signed-in actions that send email or check a password */
export const LIMITS = {
  loginEmail: { name: 'login-email', max: 10, windowMs: 15 * MINUTE },
  loginIp: { name: 'login-ip', max: 30, windowMs: 15 * MINUTE },
  registerIp: { name: 'register-ip', max: 5, windowMs: HOUR },
  forgotEmail: { name: 'forgot-email', max: 3, windowMs: HOUR },
  resendVerification: { name: 'resend-user', max: 3, windowMs: HOUR },
  changeEmail: { name: 'email-user', max: 5, windowMs: HOUR },
  passwordCheck: { name: 'password-user', max: 10, windowMs: 15 * MINUTE },
} satisfies Record<string, Limit>;

/**
 * Counts one attempt against `limit` for `subject` and throws 429 (with Retry-After) once the window's
 * count goes over the maximum. One upsert per call: the row is reset when a new window starts.
 */
export async function enforceLimit(db: Db, limit: Limit, subject: string, now: number): Promise<void> {
  const key = `${limit.name}:${await sha256(subject)}`;
  const windowStart = Math.floor(now / limit.windowMs) * limit.windowMs;
  const row = await db
    .prepare(
      `INSERT INTO rate_limits (key, window_start, count) VALUES (?, ?, 1)
       ON CONFLICT (key) DO UPDATE SET
         count = CASE WHEN rate_limits.window_start = excluded.window_start THEN rate_limits.count + 1 ELSE 1 END,
         window_start = excluded.window_start
       RETURNING count`,
    )
    .bind(key, windowStart)
    .first<{ count: number }>();
  // Old rows only matter until their window ends; sweep them now and then
  if (Math.random() < 0.02) await db.prepare('DELETE FROM rate_limits WHERE window_start < ?').bind(now - 24 * HOUR).run();
  if (row && row.count > limit.max) {
    const retryAfter = Math.max(1, Math.ceil((windowStart + limit.windowMs - now) / 1000));
    throw new HttpError(429, 'rate_limited', 'Too many attempts. Wait a while and try again.', { 'Retry-After': String(retryAfter) });
  }
}
