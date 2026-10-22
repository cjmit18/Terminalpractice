// The daily sweep (the Worker's scheduled() handler, triggers.crons in wrangler.jsonc): deletes sessions
// past their expiry or their absolute lifetime, one-time tokens past their expiry, and rate-limit rows
// whose window has ended. Requests already ignore all of these; the sweep keeps the tables small.
import type { Db } from './http';
import { sweepRateLimits } from './ratelimit';
import { SESSION_MAX_AGE } from './session';

export async function sweepExpired(db: Db, now: number): Promise<void> {
  await db.prepare('DELETE FROM sessions WHERE expires_at <= ? OR created_at <= ?').bind(now, now - SESSION_MAX_AGE).run();
  await db.prepare('DELETE FROM auth_tokens WHERE expires_at <= ?').bind(now).run();
  await sweepRateLimits(db, now);
}
