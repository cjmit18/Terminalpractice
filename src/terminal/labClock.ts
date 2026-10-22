// The lab machines' clock. Every simulated machine lives on Monday 19 October 2026 (UTC), so dates
// printed by date, ls -l, stat, /etc/shadow and the journal agree with each other and with the
// lessons, whatever day the learner practises on. The clock starts at 10:25:00, the time uptime
// shows, and then runs at real speed so files created one after another still sort by time.

/** Milliseconds in a day (the unit conversion /etc/shadow's day counts need). */
export const MS_PER_DAY = 86_400_000;

/** The lab date and start time: Monday 2026-10-19 10:25:00 UTC, in epoch milliseconds. */
export const LAB_DATE = Date.UTC(2026, 9, 19, 10, 25, 0);

/** The lab date in days since 1970-01-01, the unit /etc/shadow and chage use. */
export const LAB_DAY = Math.floor(LAB_DATE / MS_PER_DAY);

const startedAt = Date.now();

/** The current lab time. */
export function labNow(): Date {
  return new Date(LAB_DATE + Math.max(0, Date.now() - startedAt));
}

/** The current lab time as an ISO string (FileNode.updatedAt). */
export const labNowIso = (): string => labNow().toISOString();
