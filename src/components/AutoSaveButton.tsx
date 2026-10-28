import React from 'react';
import { Cloud, CloudOff, RefreshCw } from 'lucide-react';
import { useAccount } from '../lib/account';
import { accountHref } from '../lib/router';
import { syncStatusText, useSyncState } from './account/syncAdapter';

const base =
  'inline-flex items-center justify-center gap-2 h-10 md:h-9 min-w-10 px-2.5 md:px-3 rounded-md border text-sm font-medium whitespace-nowrap';

/**
 * Header control for saving progress to an account. Signed out, it leads to sign-in. Signed in, it
 * turns Auto save on and off (on by default) and shows how the last sync went. Renders nothing where
 * accounts are not offered.
 */
export const AutoSaveButton: React.FC = () => {
  const { account } = useAccount();
  const sync = useSyncState();
  if (account.status === 'loading' || account.status === 'unavailable') return null;

  if (account.status === 'signed-out') {
    return (
      <a
        href={accountHref()}
        aria-label="Auto save: sign in to save your progress to an account"
        title="Sign in to save your progress to an account"
        className={`${base} border-line-strong text-muted hover:bg-surface-2 hover:text-text`}
      >
        <CloudOff className="size-4" aria-hidden="true" />
        <span className="hidden sm:inline">Auto save</span>
      </a>
    );
  }

  // Signed in: on unless turned off in this browser (before the first sync starts, the status is still 'off')
  const on = sync.status !== 'paused';
  const Icon = !on ? CloudOff : sync.status === 'syncing' ? RefreshCw : Cloud;
  const problem = on && (sync.status === 'offline' || sync.status === 'error');
  return (
    <button
      type="button"
      aria-pressed={on}
      aria-label={`Auto save: ${on ? 'on' : 'off'}`}
      title={syncStatusText(sync)}
      onClick={() => void sync.setAutoSave(!on)}
      className={`${base} ${
        on ? 'border-accent text-accent hover:bg-accent-soft' : 'border-line-strong text-muted hover:bg-surface-2 hover:text-text'
      }`}
    >
      <Icon className={`size-4 ${sync.status === 'syncing' ? 'motion-safe:animate-spin' : ''}`} aria-hidden="true" />
      <span className="hidden sm:inline">Auto save{on ? '' : ' off'}</span>
      {problem && <span aria-hidden="true" className="size-2 rounded-full bg-danger" />}
    </button>
  );
};
