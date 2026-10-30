// Optional accounts. The app never depends on them: signed out, offline, or on a host without the
// account API (GitHub Pages, `vite preview`), everything works and sign-in is simply not offered.
//
// Every call sends and expects JSON with credentials: 'same-origin'. No password or token is ever
// written to storage: forms keep them in component state only until they are sent.
import { useCallback, useEffect, useSyncExternalStore } from 'react';
import { apiBase } from './apiBase';
import { describeError, type ErrorField } from '../components/account/messages';

export interface AccountUser {
  id: string;
  name: string;
  login: string | null;
  email?: string | null;
  emailVerified?: boolean;
  avatarUrl?: string | null;
}

/** The sign-in methods this server offers */
export interface Providers {
  github: boolean;
  email: boolean;
}

export type AccountState =
  /** Still asking the server */
  | { status: 'loading' }
  /** No account API here, no sign-in method configured, or offline: show nothing */
  | { status: 'unavailable' }
  | { status: 'signed-out' }
  | { status: 'signed-in'; user: AccountUser };

interface Snapshot {
  account: AccountState;
  providers: Providers;
  /** Whether the server can send confirmation and reset emails */
  emailSending: boolean;
}

/** Builds that ship without the account API (the GitHub Pages copy) set VITE_ACCOUNTS=off. */
// (`env` is missing when this module is loaded by the unit tests, outside Vite)
export const ACCOUNTS_ENABLED = import.meta.env?.VITE_ACCOUNTS !== 'off';

const NO_PROVIDERS: Providers = { github: false, email: false };

/**
 * Sent on window when the session ended: a sign-out here, a password reset that ended every session, or
 * the server no longer knowing the session (a 401 to the progress sync). The sync (src/lib/sync.ts) stops
 * and removes the account's data from this browser; the account store below shows signed out.
 */
export const SIGNED_OUT_EVENT = 'certsim:signed-out';
export const announceSignedOut = () => window.dispatchEvent(new Event(SIGNED_OUT_EVENT));

const apiUrl = (path: string) =>
  new URL(`api/${path}`, apiBase(import.meta.env.BASE_URL, window.location.origin, document.baseURI)).toString();

// ---- Shared store: one /api/me request for the whole app ----

let snapshot: Snapshot = {
  account: ACCOUNTS_ENABLED ? { status: 'loading' } : { status: 'unavailable' },
  providers: NO_PROVIDERS,
  emailSending: false,
};
const listeners = new Set<() => void>();
let started = false;

function update(patch: Partial<Snapshot>): void {
  snapshot = { ...snapshot, ...patch };
  listeners.forEach(l => l());
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Asks the server who is signed in, and which sign-in methods it offers. */
export async function refreshAccount(): Promise<void> {
  if (!ACCOUNTS_ENABLED) return;
  try {
    const res = await fetch(apiUrl('me'), { credentials: 'same-origin', headers: { Accept: 'application/json' } });
    const body = res.ok && res.headers.get('Content-Type')?.includes('application/json') ? await res.json() : null;
    const p = body?.providers ?? {};
    const providers: Providers = { github: p.github === true, email: p.email === true };
    const emailSending = body?.emailSending === true;
    if (body?.user) update({ account: { status: 'signed-in', user: body.user as AccountUser }, providers, emailSending });
    else if (providers.github || providers.email) update({ account: { status: 'signed-out' }, providers, emailSending });
    else update({ account: { status: 'unavailable' }, providers, emailSending });
  } catch {
    // Offline: keep what we knew, otherwise say nothing about accounts
    if (snapshot.account.status === 'loading') update({ account: { status: 'unavailable' } });
  }
}

// ---- Requests ----

export type ApiResult<T> =
  | { ok: true; status: number; data: T }
  | { ok: false; status: number; code: string; message: string; field?: ErrorField };

async function request<T>(method: 'GET' | 'POST', path: string, body?: unknown): Promise<ApiResult<T>> {
  const sendsBody = method !== 'GET';
  let res: Response;
  try {
    res = await fetch(apiUrl(path), {
      method,
      credentials: 'same-origin',
      headers: sendsBody ? { Accept: 'application/json', 'Content-Type': 'application/json' } : { Accept: 'application/json' },
      // State-changing requests always carry a JSON body (the server accepts JSON only)
      body: sendsBody ? JSON.stringify(body ?? {}) : undefined,
    });
  } catch {
    return { ok: false, status: 0, code: 'network', ...describeError('network', 0) };
  }
  let json: unknown = null;
  if (res.status !== 204 && res.headers.get('Content-Type')?.includes('application/json')) {
    try {
      json = await res.json();
    } catch {
      json = null;
    }
  }
  if (res.ok) return { ok: true, status: res.status, data: json as T };
  const err = (json && typeof json === 'object' ? json : {}) as { error?: unknown; message?: unknown };
  const code = typeof err.error === 'string' ? err.error : `http_${res.status}`;
  const retryAfter = Number(res.headers.get('Retry-After')) || undefined;
  const { message, field } = describeError(code, res.status, typeof err.message === 'string' ? err.message : undefined, retryAfter);
  return { ok: false, status: res.status, code, message, field };
}

/** The session ended: show signed out, and tell the sync to remove the account's data from this browser */
function setSignedOut(): void {
  update({ account: { status: 'signed-out' } });
  announceSignedOut();
}

/** Someone else announced the end of the session (the sync got a 401) */
function onSignedOutElsewhere(): void {
  if (snapshot.account.status === 'signed-in') update({ account: { status: 'signed-out' } });
}

/** The server set the session cookie: show signed in */
function signedIn<T extends { user: AccountUser }>(r: ApiResult<T>): ApiResult<T> {
  if (r.ok && r.data?.user) update({ account: { status: 'signed-in', user: r.data.user } });
  return r;
}

export interface RegisterInput {
  email: string;
  password: string;
  displayName: string;
  ageConfirmed: true;
}

/** emailSent is false when this site cannot send email yet, so no confirmation link is on its way */
export const register = async (input: RegisterInput) =>
  signedIn(await request<{ user: AccountUser; emailSent?: boolean }>('POST', 'auth/email/register', input));

export const login = async (input: { email: string; password: string }) =>
  signedIn(await request<{ user: AccountUser }>('POST', 'auth/email/login', input));

/**
 * Confirms an email. It never signs this browser in: the link may have been opened by someone other than
 * the account's owner. Whoever is signed in here (if anyone) is asked again, so they see it confirmed.
 */
export async function verifyEmail(token: string) {
  const r = await request<{ ok: true }>('POST', 'auth/email/verify', { token });
  if (r.ok) await refreshAccount();
  return r;
}

export const resendVerification = () => request<{ ok: true; emailSent?: boolean }>('POST', 'auth/email/resend-verification');

/** Always 202 from the server, whether or not the email has an account */
export const forgotPassword = (email: string) => request<{ ok: true }>('POST', 'auth/password/forgot', { email });

/** A reset ends every session of that account, this browser's included, and signs in afresh */
export async function resetPassword(token: string, password: string) {
  const r = await request<{ user: AccountUser }>('POST', 'auth/password/reset', { token, password });
  if (r.ok && snapshot.account.status === 'signed-in') setSignedOut();
  return signedIn(r);
}

/** "Continue with GitHub": GitHub sends the learner back to the page they were on (or `returnTo`). */
export function githubSignInHref(returnTo: string = window.location.hash): string {
  return `${apiUrl('auth/github/start')}?return=${encodeURIComponent(returnTo || '#/learn')}`;
}

/** Resolves true when the server ended the session; on failure (offline) the learner stays signed in. */
export async function signOut(): Promise<boolean> {
  const r = await request<unknown>('POST', 'logout');
  if (!r.ok) return false;
  setSignedOut();
  return true;
}

// ---- Hook ----

export function useAccount(): Snapshot & { signOut: () => Promise<boolean>; refresh: () => Promise<void> } {
  const snap = useSyncExternalStore(subscribe, () => snapshot, () => snapshot);
  useEffect(() => {
    if (started || !ACCOUNTS_ENABLED) return;
    started = true;
    window.addEventListener(SIGNED_OUT_EVENT, onSignedOutElsewhere);
    void refreshAccount();
  }, []);
  const doSignOut = useCallback(() => signOut(), []);
  const refresh = useCallback(() => refreshAccount(), []);
  return { ...snap, signOut: doSignOut, refresh };
}

/** Reads ?<name>=… from the hash (#/account/verify?token=…). Pure: see clearHashQuery. */
export function readHashParam(name: string, hash: string = window.location.hash): string | null {
  const q = hash.indexOf('?');
  if (q < 0) return null;
  return new URLSearchParams(hash.slice(q + 1)).get(name) || null;
}

/** Removes ?… from the hash with history.replaceState, so a one-time token does not stay in the address. */
export function clearHashQuery(): void {
  const hash = window.location.hash;
  const q = hash.indexOf('?');
  if (q < 0) return;
  try {
    window.history.replaceState(window.history.state, '', hash.slice(0, q));
  } catch {
    // Without history access the token stays visible; it is single use either way
  }
}
