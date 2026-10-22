// Shared parts of the OAuth sign-in flows (GitHub, Google): the state cookie, the redirect back to the
// app, finding or creating the user, and linking a provider to the signed-in user (`?link=1`).
import { appOrigin, clearCookie, cookie, readCookie, redirect, safeReturn, text, type Db, type RouteContext } from '../http';
import {
  REAUTH_WINDOW,
  createSession,
  currentSession,
  emailUnverified,
  endIncomingSession,
  loadUser,
  markAuthenticated,
  sessionCookie,
} from '../session';

export type OAuthProvider = 'github' | 'google';

export const STATE_COOKIE = '__Host-oauth';
const STATE_TTL_SECONDS = 10 * 60;

/** What the flow does at the callback: sign in, link the provider to the signed-in user, or re-authenticate them */
export type OAuthMode = 'signin' | 'link' | 'reauth';

export interface SavedState {
  state: string;
  returnTo: string;
  mode: OAuthMode;
  provider: OAuthProvider;
  /** PKCE code verifier ('' when the flow does not use PKCE) */
  verifier: string;
  /** link and reauth: the hash of the session that started the flow; the callback must see the same one */
  sessionHash: string;
}

/**
 * The cookie value. A plain GitHub sign-in keeps the original `state|return` form, so a sign-in that
 * started before this version was deployed still completes.
 */
export function encodeState(s: SavedState): string {
  const parts = [s.state, s.returnTo];
  if (s.mode !== 'signin' || s.provider !== 'github' || s.verifier || s.sessionHash) {
    parts.push(s.mode === 'signin' ? '' : s.mode, s.provider, s.verifier, s.sessionHash);
  }
  return encodeURIComponent(parts.join('|'));
}

export function readSavedState(request: Request): SavedState | null {
  let saved = '';
  try {
    saved = decodeURIComponent(readCookie(request, STATE_COOKIE) ?? '');
  } catch {
    // A malformed cookie (bad %-escape) is no saved state
  }
  if (!saved) return null;
  const [state, returnTo, mode, provider, verifier, sessionHash] = saved.split('|');
  if (!state) return null;
  return {
    state,
    returnTo: safeReturn(returnTo ?? null),
    mode: mode === 'link' || mode === 'reauth' ? mode : 'signin',
    provider: provider === 'google' ? 'google' : 'github',
    verifier: verifier ?? '',
    sessionHash: sessionHash ?? '',
  };
}

export function stateCookie(s: SavedState): string {
  return cookie(STATE_COOKIE, encodeState(s), STATE_TTL_SECONDS);
}

export interface StartPlan {
  mode: OAuthMode;
  returnTo: string;
  sessionHash: string;
}

/**
 * The checks every `/api/auth/<provider>/start` makes before redirecting to the provider. Answers a
 * refusal, or the plan to go on with:
 * - `Sec-Fetch-Site` other than same-origin or none (a cross-site page triggering the start) is a 403;
 *   a missing header is allowed (older browsers).
 * - `?link=1` and `?reauth=1` need a session (401). Link also needs a verified email when the account
 *   has one (`?error=email_unverified`) and a sign-in within the last 10 minutes (`?error=reauth_required`;
 *   POST /api/account/reauth or `?reauth=1` refreshes it). Reauth needs this provider linked (`?error=not_linked`).
 * Both bind the flow to the current session's hash, checked again at the callback.
 */
export async function planStart(c: RouteContext, provider: OAuthProvider): Promise<Response | StartPlan> {
  const site = c.request.headers.get('Sec-Fetch-Site');
  if (site !== null && site !== 'same-origin' && site !== 'none') {
    return text('Sign-in has to start from the app itself. Go back to the app and choose Sign in again.', 403);
  }
  const link = c.url.searchParams.get('link') === '1';
  const reauth = c.url.searchParams.get('reauth') === '1';
  const returnTo = safeReturn(c.url.searchParams.get('return'));
  if (link && reauth) return text('Choose either link or reauth, not both.', 400);
  if (!link && !reauth) return { mode: 'signin', returnTo, sessionHash: '' };

  const session = await currentSession(c);
  if (!session) return text('Sign in first, then link another sign-in method from your account settings.', 401);
  const user = await loadUser(c.env.DB, session.userId);
  if (!user) return text('Sign in first, then link another sign-in method from your account settings.', 401);
  const back = (error: string) => backToApp(c, returnTo, { error, keepState: true });
  if (link) {
    if (emailUnverified(user)) return back('email_unverified');
    if (c.deps.now() - session.authenticatedAt > REAUTH_WINDOW) return back('reauth_required');
    return { mode: 'link', returnTo, sessionHash: session.tokenHash };
  }
  const has = await c.env.DB.prepare('SELECT 1 AS x FROM identities WHERE user_id = ? AND provider = ?').bind(user.id, provider).first();
  if (!has) return back('not_linked');
  return { mode: 'reauth', returnTo, sessionHash: session.tokenHash };
}

/** The OAuth redirect URI for a provider, on the app's own origin (APP_ORIGINS) */
export const callbackUrl = (c: RouteContext, provider: OAuthProvider) => `${appOrigin(c)}/api/auth/${provider}/callback`;

/** A 302 back into the app at an in-app route, clearing the state cookie. `error` is appended as `?error=<code>`. */
export function backToApp(c: RouteContext, returnTo: string, opts: { error?: string; cookies?: string[]; keepState?: boolean } = {}): Response {
  const target = opts.error ? `${returnTo}?error=${encodeURIComponent(opts.error)}` : returnTo;
  // keepState: a refusal at start, which must not end a flow already running in another tab
  const cookies = opts.keepState ? [] : [clearCookie(STATE_COOKIE)];
  return redirect(`${appOrigin(c)}/${target}`, [...cookies, ...(opts.cookies ?? [])]);
}

export function stateMismatch(): Response {
  return text('This sign-in link expired or was opened in a different browser. Go back to the app and choose Sign in again.', 400, {
    'Set-Cookie': clearCookie(STATE_COOKIE),
  });
}

export function providerFailed(message: string): Response {
  return text(message, 502, { 'Set-Cookie': clearCookie(STATE_COOKIE) });
}

/** The state from the callback URL matches the cookie set at start, for this provider */
export function checkState(c: RouteContext, saved: SavedState | null, provider: OAuthProvider): saved is SavedState {
  const state = c.url.searchParams.get('state');
  return Boolean(saved && state && c.url.searchParams.get('code') && saved.provider === provider && state === saved.state);
}

export interface OAuthProfile {
  provider: OAuthProvider;
  /** The provider's stable user id (GitHub numeric id, Google `sub`) */
  providerId: string;
  /** Shown in account settings: the GitHub username or the Google email */
  label: string;
  name: string;
  avatarUrl: string | null;
}

/**
 * After the provider confirmed who this is: sign in (or create the account), link to the signed-in user,
 * or re-authenticate the signed-in user. Link and reauth only complete for the session that started them.
 */
export async function finishOAuth(c: RouteContext, saved: SavedState, profile: OAuthProfile): Promise<Response> {
  const now = c.deps.now();
  if (saved.mode !== 'signin') {
    const session = await currentSession(c);
    if (!session) return backToApp(c, saved.returnTo, { error: 'not_signed_in' });
    if (!saved.sessionHash || session.tokenHash !== saved.sessionHash) return backToApp(c, saved.returnTo, { error: 'session_changed' });
    if (saved.mode === 'reauth') {
      const owner = await findOwner(c.env.DB, profile);
      // Re-authentication proves the same person: the identity must be this user's own
      if (owner?.user_id !== session.userId) return backToApp(c, saved.returnTo, { error: 'reauth_mismatch' });
      await refreshLabel(c.env.DB, profile);
      await markAuthenticated(c.env.DB, session.tokenHash, now);
      return backToApp(c, saved.returnTo);
    }
    const user = await loadUser(c.env.DB, session.userId);
    if (!user) return backToApp(c, saved.returnTo, { error: 'not_signed_in' });
    if (emailUnverified(user)) return backToApp(c, saved.returnTo, { error: 'email_unverified' });
    const result = await linkIdentity(c.env.DB, session.userId, profile, now);
    return backToApp(c, saved.returnTo, result === 'ok' ? {} : { error: result });
  }
  const userId = await findOrCreateUser(c.env.DB, now, profile);
  // A sign-in replaces whatever session this browser had
  await endIncomingSession(c);
  const token = await createSession(c.env.DB, userId, now);
  return backToApp(c, saved.returnTo, { cookies: [sessionCookie(token)] });
}

const findOwner = (db: Db, p: OAuthProfile) =>
  db.prepare('SELECT user_id FROM identities WHERE provider = ? AND provider_id = ?').bind(p.provider, p.providerId).first<{ user_id: string }>();

/** Keeps the label current (a renamed GitHub account, a changed Google email). The display name is the user's own now. */
const refreshLabel = (db: Db, p: OAuthProfile) =>
  db.prepare('UPDATE identities SET login = ? WHERE provider = ? AND provider_id = ?').bind(p.label, p.provider, p.providerId).run();

/**
 * Find or create the user for a provider account. Safe when two first sign-ins of the same account
 * run at once (two tabs, a double click): both may get past the first lookup and create a users
 * row, but only one identities row can exist for (provider, provider_id). The loser's insert does
 * nothing, it re-reads the winner's user id and deletes its own unused users row.
 * Accounts are never merged by email: a new provider account is a new user unless it was linked.
 */
export async function findOrCreateUser(db: Db, now: number, p: OAuthProfile): Promise<string> {
  const existing = await findOwner(db, p);
  if (existing) {
    await refreshLabel(db, p);
    return existing.user_id;
  }
  const id = crypto.randomUUID();
  await db.prepare('INSERT INTO users (id, display_name, avatar_url, created_at) VALUES (?, ?, ?, ?)').bind(id, p.name, p.avatarUrl, now).run();
  await db
    .prepare(
      'INSERT INTO identities (provider, provider_id, user_id, login, linked_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT (provider, provider_id) DO NOTHING',
    )
    .bind(p.provider, p.providerId, id, p.label, now)
    .run();
  const winner = await findOwner(db, p);
  if (!winner) throw new Error('identity missing right after insert');
  if (winner.user_id !== id) {
    // Another sign-in created this account first: drop the users row this one made and use theirs
    await db.prepare('DELETE FROM users WHERE id = ?').bind(id).run();
    await refreshLabel(db, p);
  }
  return winner.user_id;
}

type LinkResult = 'ok' | 'identity_in_use' | 'provider_already_linked';

/** Links a provider account to a user. Never moves an identity that belongs to someone else. */
export async function linkIdentity(db: Db, userId: string, p: OAuthProfile, now: number): Promise<LinkResult> {
  const owner = await findOwner(db, p);
  if (owner) {
    if (owner.user_id !== userId) return 'identity_in_use';
    await refreshLabel(db, p);
    return 'ok';
  }
  const same = await db.prepare('SELECT 1 AS x FROM identities WHERE user_id = ? AND provider = ?').bind(userId, p.provider).first();
  if (same) return 'provider_already_linked';
  await db
    .prepare(
      'INSERT INTO identities (provider, provider_id, user_id, login, linked_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT (provider, provider_id) DO NOTHING',
    )
    .bind(p.provider, p.providerId, userId, p.label, now)
    .run();
  const winner = await findOwner(db, p);
  return winner?.user_id === userId ? 'ok' : 'identity_in_use';
}
