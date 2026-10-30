import React, { useEffect, useRef, useState } from 'react';
import { LogIn, LogOut } from 'lucide-react';
import { useAccount } from '../lib/account';
import { accountHref } from '../lib/router';

/** Header control for optional sign-in. Renders nothing where sign-in is not offered. */
export const AccountMenu: React.FC = () => {
  const { account, signOut } = useAccount();
  const [open, setOpen] = useState(false);
  const [error, setError] = useState('');
  const rootRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);

  // Close on outside click and Escape, like a native menu
  useEffect(() => {
    if (!open) return;
    const onPointer = (e: PointerEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setOpen(false);
        buttonRef.current?.focus();
      }
    };
    // A link in the menu was followed
    const onHash = () => setOpen(false);
    document.addEventListener('pointerdown', onPointer);
    document.addEventListener('keydown', onKey);
    window.addEventListener('hashchange', onHash);
    return () => {
      document.removeEventListener('pointerdown', onPointer);
      document.removeEventListener('keydown', onKey);
      window.removeEventListener('hashchange', onHash);
    };
  }, [open]);

  if (account.status === 'loading' || account.status === 'unavailable') return null;

  if (account.status === 'signed-out') {
    return (
      <a
        href={accountHref()}
        aria-label="Sign in"
        className="inline-flex items-center gap-2 h-10 md:h-9 px-2.5 md:px-3 rounded-md border border-line-strong text-sm font-medium text-text hover:bg-surface-2 whitespace-nowrap"
      >
        <LogIn className="size-4" aria-hidden="true" />
        <span className="hidden sm:inline">Sign in</span>
      </a>
    );
  }

  const { user } = account;
  const initial = user.name.trim().charAt(0).toUpperCase() || '?';
  return (
    <div ref={rootRef} className="relative">
      <button
        ref={buttonRef}
        type="button"
        aria-haspopup="true"
        aria-expanded={open}
        aria-label={`Account: ${user.name}`}
        onClick={() => setOpen(o => !o)}
        className="inline-flex items-center gap-2 h-10 md:h-9 pl-1 pr-1 lg:pr-3 rounded-md hover:bg-surface-2"
      >
        {/* An initial, not the GitHub picture: no image is fetched from another site */}
        <span aria-hidden="true" className="grid place-items-center size-7 rounded-full bg-accent-soft text-accent text-sm font-semibold">
          {initial}
        </span>
        <span className="hidden lg:inline text-sm font-medium text-text max-w-40 truncate">{user.name}</span>
      </button>

      {open && (
        <div className="absolute right-0 top-full mt-2 w-72 max-w-[calc(100vw-2rem)] rounded-md border border-line bg-surface p-4 shadow-lg z-50 text-sm">
          <p className="font-medium text-text truncate">{user.name}</p>
          {user.email ? (
            <p className="text-muted truncate">{user.email}</p>
          ) : (
            user.login && <p className="text-muted truncate">Signed in with GitHub as {user.login}</p>
          )}
          <p className="mt-3 text-muted">
            Your progress syncs to your account while you are signed in.
          </p>
          <a href={accountHref()} className="mt-3 flex items-center min-h-10 px-2 -mx-2 rounded-sm text-text hover:bg-surface-2">
            Your account
          </a>
          <button
            type="button"
            onClick={async () => {
              setError('');
              if (await signOut()) setOpen(false);
              else setError('Could not sign out. Check your connection and try again.');
            }}
            className="mt-4 inline-flex items-center gap-2 h-9 px-3 rounded-md border border-line-strong font-medium text-text hover:bg-surface-2"
          >
            <LogOut className="size-4" aria-hidden="true" />
            Sign out
          </button>
          {error && (
            <p role="alert" className="mt-2 text-danger">
              {error}
            </p>
          )}
        </div>
      )}
    </div>
  );
};
