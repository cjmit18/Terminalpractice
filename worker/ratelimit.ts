// Fixed-window rate limits kept in D1 (table rate_limits). Subjects (emails, IP addresses, user ids) are
// hashed into the key with HMAC-SHA256 under the RATE_LIMIT_PEPPER secret, so the table never holds them
// in readable form and a leaked table cannot be reversed against a list of candidate emails or the whole
// IPv4 space without the secret. Without the secret, rate-limited requests fail with 503 rather than
// storing guessable keys, unless ALLOW_UNPEPPERED_RATE_LIMITS is "1" (local runs, tests and previews).
import { HttpError, sha256, type ApiEnv } from './http';

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;

export interface Limit {
  name: string;
  max: number;
  windowMs: number;
}

/** The sign-in and sign-up limits, plus a few for signed-in actions that send email, check a password or store answers */
export const LIMITS = {
  /** Soft: a correct password still gets through while the per-IP limit holds (the email sign-in route applies this) */
  loginEmail: { name: 'login-email', max: 10, windowMs: 15 * MINUTE },
  /** Hard ceiling per email, whatever the password and wherever the attempts come from */
  loginEmailHour: { name: 'login-email-hour', max: 50, windowMs: HOUR },
  loginIp: { name: 'login-ip', max: 30, windowMs: 15 * MINUTE },
  registerIp: { name: 'register-ip', max: 5, windowMs: HOUR },
  forgotEmail: { name: 'forgot-email', max: 3, windowMs: HOUR },
  forgotIp: { name: 'forgot-ip', max: 10, windowMs: HOUR },
  resendVerification: { name: 'resend-user', max: 3, windowMs: HOUR },
  changeEmail: { name: 'email-user', max: 5, windowMs: HOUR },
  passwordCheck: { name: 'password-user', max: 10, windowMs: 15 * MINUTE },
  /** Shared answers (worker/answers.ts): the app sends small batches, far fewer than this */
  answerReports: { name: 'answers-user', max: 120, windowMs: HOUR },
} satisfies Record<string, Limit>;

/** The longest window of any limit: a row whose window started longer ago than this is dead */
export const MAX_WINDOW = Math.max(...Object.values(LIMITS).map(l => l.windowMs));

/** Limits keyed by a normalized email address, and those keyed by a user id (for clean-up on account delete) */
export const EMAIL_LIMITS: Limit[] = [LIMITS.loginEmail, LIMITS.loginEmailHour, LIMITS.forgotEmail];
export const USER_LIMITS: Limit[] = [LIMITS.resendVerification, LIMITS.changeEmail, LIMITS.passwordCheck, LIMITS.answerReports];

/** The settings that decide how rate-limit subjects are hashed */
export type PepperEnv = Pick<ApiEnv, 'RATE_LIMIT_PEPPER' | 'ALLOW_UNPEPPERED_RATE_LIMITS'>;

const keyCache = new Map<string, Promise<CryptoKey>>();
let warned = false;

async function hashSubject(env: PepperEnv, subject: string): Promise<string> {
  const pepper = env.RATE_LIMIT_PEPPER;
  if (!pepper) {
    if (env.ALLOW_UNPEPPERED_RATE_LIMITS !== '1') {
      console.error('ratelimit: RATE_LIMIT_PEPPER is not set; set it with `wrangler secret put RATE_LIMIT_PEPPER`');
      throw new HttpError(503, 'not_configured', 'Signing in is not available right now. Try again later.');
    }
    if (!warned) {
      warned = true;
      console.warn('ratelimit: RATE_LIMIT_PEPPER is not set; using plain SHA-256 keys (ALLOW_UNPEPPERED_RATE_LIMITS=1)');
    }
    return sha256(subject);
  }
  let key = keyCache.get(pepper);
  if (!key) {
    key = crypto.subtle.importKey('raw', new TextEncoder().encode(pepper), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    keyCache.set(pepper, key);
  }
  const mac = await crypto.subtle.sign('HMAC', await key, new TextEncoder().encode(subject));
  return [...new Uint8Array(mac)].map(b => b.toString(16).padStart(2, '0')).join('');
}

/** The rate_limits key for a limit and subject: `<limit name>:<HMAC-SHA256 hex>` */
export async function limitKey(env: PepperEnv, limit: Limit, subject: string): Promise<string> {
  return `${limit.name}:${await hashSubject(env, subject)}`;
}

export interface LimitResult {
  over: boolean;
  /** Seconds until the window ends */
  retryAfter: number;
}

export function rateLimited(retryAfter: number): HttpError {
  return new HttpError(429, 'rate_limited', 'Too many attempts. Wait a while and try again.', { 'Retry-After': String(retryAfter) });
}

/** Counts one attempt against `limit` for `subject` and says whether the window's count is over the maximum. */
export async function countLimit(env: Pick<ApiEnv, 'DB'> & PepperEnv, limit: Limit, subject: string, now: number): Promise<LimitResult> {
  const key = await limitKey(env, limit, subject);
  const windowStart = Math.floor(now / limit.windowMs) * limit.windowMs;
  const row = await env.DB.prepare(
    `INSERT INTO rate_limits (key, window_start, count) VALUES (?, ?, 1)
       ON CONFLICT (key) DO UPDATE SET
         count = CASE WHEN rate_limits.window_start = excluded.window_start THEN rate_limits.count + 1 ELSE 1 END,
         window_start = excluded.window_start
       RETURNING count`,
  )
    .bind(key, windowStart)
    .first<{ count: number }>();
  // Rows only matter until their window ends; sweep now and then (the daily cron sweeps the rest)
  if (Math.random() < 0.02) await sweepRateLimits(env.DB, now);
  return {
    over: Boolean(row && row.count > limit.max),
    retryAfter: Math.max(1, Math.ceil((windowStart + limit.windowMs - now) / 1000)),
  };
}

/**
 * Counts one attempt and throws 429 (with Retry-After) once the window's count goes over the maximum.
 * One upsert per call: the row is reset when a new window starts.
 */
export async function enforceLimit(env: Pick<ApiEnv, 'DB'> & PepperEnv, limit: Limit, subject: string, now: number): Promise<void> {
  const result = await countLimit(env, limit, subject, now);
  if (result.over) throw rateLimited(result.retryAfter);
}

/** Deletes rows whose window has ended for every limit */
export async function sweepRateLimits(db: ApiEnv['DB'], now: number): Promise<void> {
  await db.prepare('DELETE FROM rate_limits WHERE window_start <= ?').bind(now - MAX_WINDOW).run();
}

/** Deletes the rate-limit rows that can be traced to this account: its email's and its user id's */
export async function forgetLimits(env: Pick<ApiEnv, 'DB'> & PepperEnv, userId: string, email: string | null): Promise<void> {
  const keys: string[] = [];
  for (const limit of USER_LIMITS) keys.push(await limitKey(env, limit, userId));
  if (email) for (const limit of EMAIL_LIMITS) keys.push(await limitKey(env, limit, email));
  for (const key of keys) await env.DB.prepare('DELETE FROM rate_limits WHERE key = ?').bind(key).run();
}
