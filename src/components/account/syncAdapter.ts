// INTEGRATION POINT: progress sync.
//
// The sync hook and its import prompt are built on a parallel branch with this interface:
//   useSync(): { status, lastSyncedAt, syncNow, importLocal }
//   <ImportPrompt />
// This adapter finds them with import.meta.glob, which resolves to an empty object when a file
// does not exist, so this branch builds on its own and sync reads as "off". Once the sync branch
// is merged, check that one of the paths below matches where useSync and ImportPrompt live (add
// it if not), and the account pages pick them up with no other change.
import type React from 'react';

export type SyncStatus = 'off' | 'idle' | 'syncing' | 'synced' | 'offline' | 'error' | (string & {});

export interface SyncState {
  status: SyncStatus;
  /** ms since epoch, an ISO string, or null when it never synced */
  lastSyncedAt: number | string | null;
  syncNow: () => void | Promise<unknown>;
  importLocal: () => void | Promise<unknown>;
}

type SyncModule = { useSync?: () => Partial<SyncState> };
type PromptModule = { ImportPrompt?: React.ComponentType; default?: React.ComponentType };

const syncModules = import.meta.glob<SyncModule>(
  ['../../lib/sync.ts', '../../lib/useSync.ts', '../../lib/sync/index.ts', '../../lib/sync/useSync.ts', '../sync/useSync.ts'],
  { eager: true },
);
const promptModules = import.meta.glob<PromptModule>(
  ['../sync/ImportPrompt.tsx', './ImportPrompt.tsx', '../ImportPrompt.tsx', '../../lib/sync/ImportPrompt.tsx'],
  { eager: true },
);

const realUseSync = Object.values(syncModules).find(m => typeof m.useSync === 'function')?.useSync;
const RealImportPrompt =
  Object.values(promptModules)
    .map(m => m.ImportPrompt ?? m.default)
    .find((c): c is React.ComponentType => typeof c === 'function') ?? null;

const noop = () => {};
const OFF: SyncState = { status: 'off', lastSyncedAt: null, syncNow: noop, importLocal: noop };

/** Whether this build has the sync module at all */
export const SYNC_AVAILABLE = !!realUseSync;

/** The sync state, or "off" when this build has no sync module. Always called, so hook order is stable. */
export const useSyncState: () => SyncState = realUseSync
  ? () => {
      const s = realUseSync();
      return {
        status: s.status ?? 'off',
        lastSyncedAt: s.lastSyncedAt ?? null,
        syncNow: s.syncNow ?? noop,
        importLocal: s.importLocal ?? noop,
      };
    }
  : () => OFF;

/** "Add this browser's progress" prompt from the sync branch, or null when it is not in this build */
export const ImportPrompt: React.ComponentType | null = RealImportPrompt;

export function syncStatusText(s: SyncState): string {
  switch (s.status) {
    case 'off':
      return SYNC_AVAILABLE
        ? 'Sync is off. Your progress is saved in this browser only.'
        : 'Your progress is saved in this browser. Syncing it to your account is coming next.';
    case 'syncing':
      return 'Syncing your progress…';
    case 'synced':
    case 'idle':
      return s.lastSyncedAt ? `Progress synced ${whenText(s.lastSyncedAt)}.` : 'Your progress syncs to your account.';
    case 'offline':
      return 'You are offline. Changes are saved in this browser and sync when you are back online.';
    case 'error':
      return 'The last sync did not finish. Your progress is safe in this browser. Try again in a moment.';
    default:
      return `Sync: ${s.status}.`;
  }
}

function whenText(t: number | string): string {
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
