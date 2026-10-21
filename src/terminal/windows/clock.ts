import { SystemState } from '../../types/terminal';

// The Windows lab clock. Labs are set on Monday 10/19/2026; the clock starts at 10:30:15 AM and
// moves on only when a command takes time, so output stays the same from run to run.

const START = Date.UTC(2026, 9, 19, 10, 30, 15);

/** Seconds on the lab clock now. */
export const windowsNow = (state: SystemState): number => state.windowsClockSeconds ?? 0;

/** Moves the lab clock on by `seconds` and returns the new time. */
export function advanceWindowsClock(state: SystemState, seconds: number): number {
  state.windowsClockSeconds = windowsNow(state) + seconds;
  return state.windowsClockSeconds;
}

/** A lab-clock time (seconds; negative is before the start) as gpresult prints it: 10/19/2026 at 10:30:15 AM. */
export function gpresultTime(seconds: number): string {
  const d = new Date(START + seconds * 1000);
  const p2 = (n: number) => String(n).padStart(2, '0');
  const h = d.getUTCHours();
  return `${p2(d.getUTCMonth() + 1)}/${p2(d.getUTCDate())}/${d.getUTCFullYear()} at ${h % 12 || 12}:${p2(d.getUTCMinutes())}:${p2(d.getUTCSeconds())} ${h < 12 ? 'AM' : 'PM'}`;
}

/**
 * A Group Policy refresh (gpupdate, Invoke-GPUpdate): computer policy applies a few seconds
 * from now, then user policy, and the clock moves on past both.
 */
export function applyGroupPolicy(state: SystemState, target?: 'computer' | 'user'): void {
  const now = windowsNow(state);
  const applied = { ...(state.gpApplied ?? {}) };
  if (target !== 'user') applied.computer = now + 4;
  if (target !== 'computer') applied.user = now + (target ? 4 : 7);
  state.gpApplied = applied;
  advanceWindowsClock(state, 12);
}

/** Group Policy applied during boot: computer policy at 10:28:44 AM, user policy at sign-in, 10:29:02 AM. */
export const BOOT_GP = { computer: -91, user: -73 };
