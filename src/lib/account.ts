// Optional sign-in. The app never depends on it: signed out, offline, or on a host without the
// account API (GitHub Pages, `vite preview`), sign-in is simply not offered.
import { useCallback, useEffect, useState } from 'react';
import { apiBase } from './apiBase';

export interface AccountUser {
  id: string;
  name: string;
  login: string | null;
  avatarUrl: string | null;
}

export type AccountState =
  /** Still asking the server */
  | { status: 'loading' }
  /** No account API here, sign-in not configured yet, or offline: show nothing */
  | { status: 'unavailable' }
  | { status: 'signed-out' }
  | { status: 'signed-in'; user: AccountUser };

/** Builds that ship without the account API (the GitHub Pages copy) set VITE_ACCOUNTS=off. */
// (`env` is missing when this module is loaded by the unit tests, outside Vite)
export const ACCOUNTS_ENABLED = import.meta.env?.VITE_ACCOUNTS !== 'off';

const apiUrl = (path: string) =>
  new URL(`api/${path}`, apiBase(import.meta.env.BASE_URL, window.location.origin, document.baseURI)).toString();

/** Where "Sign in with GitHub" goes; GitHub sends the learner back to the page they were on. */
export function githubSignInHref(hash: string = window.location.hash): string {
  return `${apiUrl('auth/github/start')}?return=${encodeURIComponent(hash || '#/learn')}`;
}

/** Sent on window when the session ended (sign-out here, or the server no longer knows the session) */
export const SIGNED_OUT_EVENT = 'certsim:signed-out';
export const announceSignedOut = () => window.dispatchEvent(new Event(SIGNED_OUT_EVENT));

export function useAccount(): { account: AccountState; signOut: () => Promise<boolean> } {
  const [account, setAccount] = useState<AccountState>(ACCOUNTS_ENABLED ? { status: 'loading' } : { status: 'unavailable' });

  // Every useAccount (the header menu, the app's sync) hears about a sign-out
  useEffect(() => {
    const onSignedOut = () => setAccount(a => (a.status === 'signed-in' ? { status: 'signed-out' } : a));
    window.addEventListener(SIGNED_OUT_EVENT, onSignedOut);
    return () => window.removeEventListener(SIGNED_OUT_EVENT, onSignedOut);
  }, []);

  useEffect(() => {
    if (!ACCOUNTS_ENABLED) return;
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(apiUrl('me'), { credentials: 'same-origin', headers: { Accept: 'application/json' } });
        const body = res.ok && res.headers.get('Content-Type')?.includes('application/json') ? await res.json() : null;
        if (cancelled) return;
        if (body?.user) setAccount({ status: 'signed-in', user: body.user as AccountUser });
        else if (body?.providers?.github) setAccount({ status: 'signed-out' });
        else setAccount({ status: 'unavailable' });
      } catch {
        if (!cancelled) setAccount({ status: 'unavailable' });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  /** Resolves true when the server ended the session; on failure (offline) the learner stays signed in. */
  const signOut = useCallback(async () => {
    try {
      const res = await fetch(apiUrl('logout'), { method: 'POST', credentials: 'same-origin' });
      if (!res.ok) return false;
      setAccount({ status: 'signed-out' });
      announceSignedOut();
      return true;
    } catch {
      return false;
    }
  }, []);

  return { account, signOut };
}
