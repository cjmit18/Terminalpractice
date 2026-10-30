// Progress sync as the account pages and the header's Auto save button show it, from useSync in src/lib/sync.ts.
import { useSync, type UseSync } from '../../lib/sync';

export type SyncState = UseSync;

/** The sync's state; "off" when signed out */
export const useSyncState: () => SyncState = useSync;

const SYNCS_WHEN_SIGNED_IN = 'Your progress syncs to your account while you are signed in, so it follows you to your other devices.';

export function syncStatusText(s: Pick<SyncState, 'status' | 'lastSyncedAt'>): string {
  switch (s.status) {
    case 'off':
      return SYNCS_WHEN_SIGNED_IN;
    case 'paused':
      return 'Auto save is off. Your progress is saved in this browser only; turn Auto save on to save it to your account.';
    case 'syncing':
      return 'Syncing your progress…';
    case 'synced':
      return s.lastSyncedAt ? `Progress synced ${whenText(s.lastSyncedAt)}.` : SYNCS_WHEN_SIGNED_IN;
    case 'offline':
      return 'You are offline. Changes are saved in this browser and sync when you are back online.';
    case 'error':
      return 'The last sync did not finish. Your progress is safe in this browser. Try again in a moment.';
  }
}

function whenText(t: number): string {
  const d = new Date(t);
  if (Number.isNaN(d.getTime())) return 'recently';
  const mins = Math.round((Date.now() - d.getTime()) / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins} ${mins === 1 ? 'minute' : 'minutes'} ago`;
  try {
    return `at ${d.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })}`;
  } catch {
    return 'recently';
  }
}
