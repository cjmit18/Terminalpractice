// Optional accounts. The app never depends on them: signed out, offline, or on a host without the
// account API (GitHub Pages, `vite preview`), everything works and sign-in is simply not offered.
//
// The API contract is docs/ACCOUNTS_API.md. Every call here sends and expects JSON with
// credentials: 'same-origin'. No password or token is ever written to storage: forms keep them in
// component state only until they are sent.
import { useCallback, useEffect, useSyncExternalStore } from 'react';
import { apiBase } from './apiBase';
import { describeError, type ErrorField } from '../components/account/messages';
import type { Epochs, SyncItem, SyncSettings } from './syncRules';

/** PublicUser in the contract. avatarUrl is only sent by older servers and is never shown. */
export interface AccountUser {
  id: string;
  name: string;
  login: string | null;
  email?: string | null;
  emailVerified?: boolean;
  avatarUrl?: string | null;
}

export interface Providers {
  github: boolean;
  google: boolean;
  email: boolean;
}

export type OAuthProvider = 'google' | 'github';

export type AccountState =
  /** Still asking the server */
  | { status: 'loading' }
  /** No account API here, no sign-in method configured, or offline */
  | { status: 'unavailable' }
  | { status: 'signed-out' }
  | { status: 'signed-in'; user: AccountUser };

interface Snapshot {
  account: AccountState;
  providers: Providers;
  /** Whether the server can send verification and reset emails */
  emailSending: boolean;
  /** A one-time note for the next page shown (e.g. after deleting the account) */
  notice: string | null;
}

/** Builds that ship without the account API (the GitHub Pages copy) set VITE_ACCOUNTS=off. */
// (`env` is missing when this module is loaded by the unit tests, outside Vite)
export const ACCOUNTS_ENABLED = import.meta.env?.VITE_ACCOUNTS !== 'off';

const NO_PROVIDERS: Providers = { github: false, google: false, email: false };

const apiUrl = (path: string) =>
  new URL(`api/${path}`, apiBase(import.meta.env.BASE_URL, window.location.origin, document.baseURI)).toString();

/**
 * Sent on window when the session ended: a sign-out here (the menu, sign out everywhere, account
 * deletion, a password reset that ended every session), or the server no longer knowing the session
 * (a 401 to the progress sync). The sync (src/lib/sync.ts) stops and removes the account's data from
 * this browser; the account store below shows signed out.
 */
export const SIGNED_OUT_EVENT = 'certsim:signed-out';
export const announceSignedOut = () => window.dispatchEvent(new Event(SIGNED_OUT_EVENT));

// ---- Shared store: one /api/me request for the whole app ----

let snapshot: Snapshot = {
  account: ACCOUNTS_ENABLED ? { status: 'loading' } : { status: 'unavailable' },
  providers: NO_PROVIDERS,
  emailSending: false,
  notice: null,
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

/** Ask the server who is signed in (also after a sign-in method changes). */
export async function refreshAccount(): Promise<void> {
  if (!ACCOUNTS_ENABLED) return;
  try {
    const res = await fetch(apiUrl('me'), { credentials: 'same-origin', headers: { Accept: 'application/json' } });
    const body = res.ok && res.headers.get('Content-Type')?.includes('application/json') ? await res.json() : null;
    const p = body?.providers ?? {};
    const providers: Providers = { github: p.github === true, google: p.google === true, email: p.email === true };
    const emailSending = body?.emailSending === true;
    if (body?.user) update({ account: { status: 'signed-in', user: body.user as AccountUser }, providers, emailSending });
    else if (providers.github || providers.google || providers.email) update({ account: { status: 'signed-out' }, providers, emailSending });
    else update({ account: { status: 'unavailable' }, providers, emailSending });
  } catch {
    // Offline: keep what we knew if anything, otherwise say nothing about accounts
    if (snapshot.account.status === 'loading') update({ account: { status: 'unavailable' } });
  }
}

function setSignedIn(user: AccountUser): void {
  update({ account: { status: 'signed-in', user }, notice: null });
}

/**
 * The session ended. Announced, so the sync stops and removes the account's data from this browser
 * (certsim:acct:<userId>:*, see useSyncUser in sync.ts).
 */
function setSignedOut(notice: string | null = null): void {
  update({ account: { status: 'signed-out' }, notice });
  announceSignedOut();
}

/** Someone else announced the end of the session (the sync got a 401, another tab signed out) */
function onSignedOutElsewhere(): void {
  if (snapshot.account.status === 'signed-in') update({ account: { status: 'signed-out' } });
}

// ---- Requests ----

export type ApiResult<T> =
  | { ok: true; status: number; data: T }
  | {
      ok: false;
      status: number;
      code: string;
      message: string;
      field?: ErrorField;
      /** With 403 `reauth_required`: the sign-in methods that can confirm it is you (e.g. ["github"]) */
      providers?: string[];
    };

async function request<T>(method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE', path: string, body?: unknown): Promise<ApiResult<T>> {
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
  const err = (json && typeof json === 'object' ? json : {}) as { error?: unknown; message?: unknown; providers?: unknown };
  const code = typeof err.error === 'string' ? err.error : `http_${res.status}`;
  const retryAfter = Number(res.headers.get('Retry-After')) || undefined;
  const { message, field } = describeError(code, res.status, typeof err.message === 'string' ? err.message : undefined, retryAfter);
  const providers = Array.isArray(err.providers) ? err.providers.filter((p): p is string => typeof p === 'string') : undefined;
  return { ok: false, status: res.status, code, message, field, ...(providers ? { providers } : {}) };
}

/** Signs in on success: the server set the session cookie */
function signedIn(r: ApiResult<{ user: AccountUser }>): ApiResult<{ user: AccountUser }> {
  if (r.ok && r.data?.user) setSignedIn(r.data.user);
  return r;
}

export interface RegisterInput {
  email: string;
  password: string;
  displayName: string;
  ageConfirmed: true;
}

export const register = async (input: RegisterInput) =>
  signedIn(await request<{ user: AccountUser }>('POST', 'auth/email/register', input));

export const login = async (input: { email: string; password: string }) =>
  signedIn(await request<{ user: AccountUser }>('POST', 'auth/email/login', input));

/**
 * Confirms an email. It never signs this browser in: /verify sets no session cookie, and the link may
 * have been opened by someone other than the account's owner. Whoever is signed in here (if anyone)
 * is asked again, so a signed-in owner sees the email as confirmed.
 */
export async function verifyEmail(token: string) {
  const r = await request<{ user: AccountUser }>('POST', 'auth/email/verify', { token });
  if (r.ok) await refreshAccount();
  return r;
}

export const resendVerification = () => request<null>('POST', 'auth/email/resend-verification');

/** Always 202 from the server, whether or not the email has an account */
export const forgotPassword = (email: string) => request<null>('POST', 'auth/password/forgot', { email });

/** A reset ends every session of that account, this browser's included, and signs in afresh */
export async function resetPassword(token: string, password: string) {
  const r = await request<{ user: AccountUser }>('POST', 'auth/password/reset', { token, password });
  if (r.ok && snapshot.account.status === 'signed-in') setSignedOut();
  return signedIn(r);
}

/**
 * Where "Continue with Google/GitHub" goes. With link, adds that method to the signed-in account;
 * with reauth, signs in again to confirm it is you before a sensitive change (accounts without a password).
 */
export function oauthStartHref(provider: OAuthProvider, opts: { link?: boolean; reauth?: boolean; returnTo?: string } = {}): string {
  const params = new URLSearchParams();
  if (opts.reauth) params.set('reauth', '1');
  params.set('return', opts.returnTo ?? '#/account');
  if (opts.link) params.set('link', '1');
  return `${apiUrl(`auth/${provider}/start`)}?${params.toString()}`;
}

/** The current route without its ?query, e.g. "#/account/security" */
export function currentRoute(hash: string = window.location.hash): string {
  const bare = hash.split('?')[0];
  return bare.startsWith('#/') ? bare : '#/account';
}

/** "Sign in again with …" after 403 reauth_required: back to the current route afterwards */
export const reauthHref = (provider: OAuthProvider) => oauthStartHref(provider, { reauth: true, returnTo: currentRoute() });

/** Kept for older callers: GitHub sign-in that returns to the current page */
export function githubSignInHref(hash: string = window.location.hash): string {
  return oauthStartHref('github', { returnTo: hash || '#/learn' });
}

/** Resolves true when the server ended the session; on failure (offline) the learner stays signed in. */
export async function signOut(): Promise<boolean> {
  const r = await request<unknown>('POST', 'logout');
  if (!r.ok) return false;
  setSignedOut();
  return true;
}

export async function signOutEverywhere(): Promise<ApiResult<unknown>> {
  const r = await request<unknown>('POST', 'account/logout-all');
  if (r.ok) setSignedOut('You are signed out on all your devices.');
  return r;
}

export interface Identity {
  provider: string;
  label: string;
  linkedAt: number | string;
}

export interface AccountDetails {
  user: AccountUser;
  identities: Identity[];
  hasPassword: boolean;
  emailVerified: boolean;
}

export const getAccount = () => request<AccountDetails>('GET', 'account');

export async function updateDisplayName(displayName: string) {
  const r = await request<{ user: AccountUser }>('PATCH', 'account', { displayName });
  return signedIn(r);
}

export const changePassword = (input: { currentPassword?: string; newPassword: string }) =>
  request<unknown>('POST', 'account/password', input);

// Sensitive changes confirm it is you: accounts with a password send `currentPassword`; accounts
// without one may get 403 `reauth_required` with `providers`, and then sign in again (reauthHref).

/** Adds or changes the email. `currentPassword` is required when the account has a password. */
export const changeEmail = (input: { email: string; currentPassword?: string }) => request<unknown>('POST', 'account/email', input);

export const unlinkIdentity = (provider: string, currentPassword?: string) =>
  request<null>('DELETE', `account/identities/${encodeURIComponent(provider)}`, currentPassword ? { currentPassword } : {});

/** Confirms the password before leaving for Google/GitHub to link it (the link itself is a redirect) */
export const reauthWithPassword = (currentPassword: string) => request<unknown>('POST', 'account/reauth', { currentPassword });

/** Fetches the export and hands it to the browser as a file download. */
export async function downloadExport(): Promise<ApiResult<null>> {
  let res: Response;
  try {
    res = await fetch(apiUrl('account/export'), { credentials: 'same-origin', headers: { Accept: 'application/json' } });
  } catch {
    return { ok: false, status: 0, code: 'network', ...describeError('network', 0) };
  }
  if (!res.ok) {
    const { message, field } = describeError(`http_${res.status}`, res.status);
    return { ok: false, status: res.status, code: `http_${res.status}`, message, field };
  }
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `terminus-certsim-account-${new Date().toISOString().slice(0, 10)}.json`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  return { ok: true, status: res.status, data: null };
}

export async function deleteAccount(currentPassword?: string): Promise<ApiResult<null>> {
  const r = await request<null>('DELETE', 'account', currentPassword ? { confirm: 'delete', currentPassword } : { confirm: 'delete' });
  if (r.ok) setSignedOut('Your account and everything linked to it, synced progress included, were deleted. Progress saved in this browser while signed out is still here.');
  return r;
}

// Progress sync. The sync engine (src/lib/sync.ts) makes these requests itself, with its own abort and
// retry handling; they are typed here too so every endpoint has one client function. Shapes are in
// syncRules.ts and docs/ACCOUNTS_API.md.
export interface ProgressState {
  items: SyncItem[];
  epochs: Epochs;
  settings: SyncSettings;
}
export interface ProgressUpload {
  items?: SyncItem[];
  settings?: SyncSettings;
}
/** One scope, with the epoch this device knew (the reset is skipped when the scope moved on) */
export interface ProgressReset {
  scope: string;
  epoch?: number;
}
export const getProgress = () => request<ProgressState>('GET', 'progress');
export const putProgress = (body: ProgressUpload) => request<ProgressState>('PUT', 'progress', body);
export const resetProgress = (resets: ProgressReset | ProgressReset[]) =>
  request<{ epochs: Epochs }>('POST', 'progress/reset', Array.isArray(resets) ? { resets } : resets);

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

/** Reads ?<name>=… from the hash (#/account/verify?token=…, #/account/security?error=…). Pure: see clearHashQuery. */
export function readHashParam(name: string, hash: string = window.location.hash): string | null {
  const q = hash.indexOf('?');
  if (q < 0) return null;
  return new URLSearchParams(hash.slice(q + 1)).get(name) || null;
}

export const readHashToken = (hash: string = window.location.hash) => readHashParam('token', hash);

/** Removes ?… from the hash with history.replaceState, so a one-time token does not stay in the URL. */
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
