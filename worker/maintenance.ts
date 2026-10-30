// The daily sweep (the Worker's scheduled() handler, triggers.crons in wrangler.jsonc): deletes sessions
// past their expiry or their absolute lifetime, one-time tokens past their expiry, and rate-limit rows
// whose window has ended. Requests already ignore all of these; the sweep keeps the tables small.
// It also upgrades password hashes from before the pepper (password.ts), a batch at a time.
import type { ApiEnv, Db } from './http';
import { pepperStoredHashes } from './password';
import { sweepRateLimits } from './ratelimit';
import { SESSION_MAX_AGE } from './session';

export async function sweepExpired(db: Db, now: number): Promise<void> {
  await db.prepare('DELETE FROM sessions WHERE expires_at <= ? OR created_at <= ?').bind(now, now - SESSION_MAX_AGE).run();
  await db.prepare('DELETE FROM auth_tokens WHERE expires_at <= ?').bind(now).run();
  await sweepRateLimits(db, now);
}

/** The daily cron: the sweep, then a batch of pepper upgrades */
export async function dailyMaintenance(env: Pick<ApiEnv, 'DB' | 'PASSWORD_PEPPER'>, now: number): Promise<void> {
  await sweepExpired(env.DB, now);
  await pepperStoredHashes(env);
}
