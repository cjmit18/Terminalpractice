// Optional accounts. The app never depends on them: signed out, offline, or on a host without the
// account API (GitHub Pages, `vite preview`), everything works and sign-in is simply not offered.
//
// The API contract is docs/ACCOUNTS_API.md. Every call here sends and expects JSON with
// credentials: 'same-origin'. No password or token is ever written to storage: forms keep them in
// component state only until they are sent.
import { useCallback, useEffect, useSyncExternalStore } from 'react';
import { apiBase } from './apiBase';
import { describeError, type ErrorField } from '../components/account/messages';

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
export const ACCOUNTS_ENABLED = import.meta.env.VITE_ACCOUNTS !== 'off';

const NO_PROVIDERS: Providers = { github: false, google: false, email: false };

const apiUrl = (path: string) =>
  new URL(`api/${path}`, apiBase(import.meta.env.BASE_URL, window.location.origin, document.baseURI)).toString();

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

/** Account data in this browser lives under certsim:acct:<userId>:*, removed on sign-out. */
function forgetLocalAccountData(userId: string): void {
  try {
    const prefix = `certsim:acct:${userId}:`;
    const doomed: string[] = [];
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k?.startsWith(prefix)) doomed.push(k);
    }
    doomed.forEach(k => localStorage.removeItem(k));
  } catch {
    // Storage blocked: nothing was saved either
  }
}

function setSignedOut(notice: string | null = null): void {
  const cur = snapshot.account;
  if (cur.status === 'signed-in') forgetLocalAccountData(cur.user.id);
  update({ account: { status: 'signed-out' }, notice });
}

// ---- Requests ----

export type ApiResult<T> =
  | { ok: true; status: number; data: T }
  | { ok: false; status: number; code: string; message: string; field?: ErrorField };

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
  const err = (json && typeof json === 'object' ? json : {}) as { error?: unknown; message?: unknown };
  const code = typeof err.error === 'string' ? err.error : `http_${res.status}`;
  const retryAfter = Number(res.headers.get('Retry-After')) || undefined;
  const { message, field } = describeError(code, res.status, typeof err.message === 'string' ? err.message : undefined, retryAfter);
  return { ok: false, status: res.status, code, message, field };
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

export const verifyEmail = async (token: string) =>
  signedIn(await request<{ user: AccountUser }>('POST', 'auth/email/verify', { token }));

export const resendVerification = () => request<null>('POST', 'auth/email/resend-verification');

/** Always 202 from the server, whether or not the email has an account */
export const forgotPassword = (email: string) => request<null>('POST', 'auth/password/forgot', { email });

export const resetPassword = async (token: string, password: string) =>
  signedIn(await request<{ user: AccountUser }>('POST', 'auth/password/reset', { token, password }));

/** Where "Continue with Google/GitHub" goes. With link, adds that method to the signed-in account. */
export function oauthStartHref(provider: OAuthProvider, opts: { link?: boolean; returnTo?: string } = {}): string {
  const params = new URLSearchParams();
  params.set('return', opts.returnTo ?? '#/account');
  if (opts.link) params.set('link', '1');
  return `${apiUrl(`auth/${provider}/start`)}?${params.toString()}`;
}

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

export const changeEmail = (input: { email: string; password?: string }) => request<unknown>('POST', 'account/email', input);

export const unlinkIdentity = (provider: string) =>
  request<null>('DELETE', `account/identities/${encodeURIComponent(provider)}`);

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

export async function deleteAccount(): Promise<ApiResult<null>> {
  const r = await request<null>('DELETE', 'account', { confirm: 'delete' });
  if (r.ok) setSignedOut('Your account and everything linked to it were deleted. Your progress in this browser is still here.');
  return r;
}

// Progress sync (Phase 3). The sync hook owns how these are used; they are typed here so every
// endpoint has one client function.
export interface ProgressPayload {
  items: unknown;
  epochs: unknown;
  settings?: unknown;
}
export const getProgress = () => request<ProgressPayload>('GET', 'progress');
export const putProgress = (body: ProgressPayload) => request<ProgressPayload>('PUT', 'progress', body);
export const resetProgress = (scope: string) => request<{ epochs: unknown }>('POST', 'progress/reset', { scope });

// ---- Hook ----

export function useAccount(): Snapshot & { signOut: () => Promise<boolean>; refresh: () => Promise<void> } {
  const snap = useSyncExternalStore(subscribe, () => snapshot, () => snapshot);
  useEffect(() => {
    if (started || !ACCOUNTS_ENABLED) return;
    started = true;
    void refreshAccount();
  }, []);
  const doSignOut = useCallback(() => signOut(), []);
  const refresh = useCallback(() => refreshAccount(), []);
  return { ...snap, signOut: doSignOut, refresh };
}

/** Reads ?token=… from the hash (#/account/verify?token=…). Pure: see clearHashQuery. */
export function readHashToken(hash: string = window.location.hash): string | null {
  const q = hash.indexOf('?');
  if (q < 0) return null;
  return new URLSearchParams(hash.slice(q + 1)).get('token') || null;
}

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
