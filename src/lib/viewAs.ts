// "View as" for admins (portal part 9): use the site as another kind of visitor. It changes only what the
// page shows (the header's account controls, the account pages, the admin link). The real account keeps
// syncing underneath, so viewing as a signed-out visitor never signs out or clears anything.
// Kept for this tab only (sessionStorage): a new tab starts as yourself.
import { useSyncExternalStore } from 'react';
import { useAccount, type AccountState, type Role } from './account';

export type ViewAs = 'signed-out' | 'learner';
const KEY = 'certsim:view-as';
const listeners = new Set<() => void>();

function read(): ViewAs | null {
  try {
    const v = sessionStorage.getItem(KEY);
    return v === 'signed-out' || v === 'learner' ? v : null;
  } catch {
    return null;
  }
}

let current: ViewAs | null = typeof window === 'undefined' ? null : read();

export function setViewAs(next: ViewAs | null): void {
  current = next;
  try {
    if (next) sessionStorage.setItem(KEY, next);
    else sessionStorage.removeItem(KEY);
  } catch {
    // Without storage it lasts until the page reloads
  }
  listeners.forEach(l => l());
}

const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => void listeners.delete(l);
};

/** The "view as" choice; always null for an account that is not an admin */
export function useViewAs(): ViewAs | null {
  const { role } = useAccount();
  const v = useSyncExternalStore(subscribe, () => current, () => null);
  return role ? v : null;
}

/** What the page shows: the real account and role, or the visitor an admin is viewing as */
export function useDisplayAccount(): ReturnType<typeof useAccount> {
  const real = useAccount();
  const viewAs = useViewAs();
  if (viewAs === 'signed-out') return { ...real, account: { status: 'signed-out' } as AccountState, role: null as Role };
  if (viewAs === 'learner') return { ...real, role: null };
  return real;
}
