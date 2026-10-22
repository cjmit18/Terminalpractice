// Shared parts of the OAuth sign-in flows (GitHub, Google): the state cookie, the redirect back to the
// app, finding or creating the user, and linking a provider to the signed-in user (`?link=1`).
import { clearCookie, cookie, readCookie, safeReturn, text, type Db, type RouteContext } from '../http';
import { createSession, currentSession, sessionCookie } from '../session';

export type OAuthProvider = 'github' | 'google';

export const STATE_COOKIE = '__Host-oauth';
const STATE_TTL_SECONDS = 10 * 60;

export interface SavedState {
  state: string;
  returnTo: string;
  /** Link the provider to the signed-in user instead of signing in */
  link: boolean;
  provider: OAuthProvider;
  /** PKCE code verifier ('' when the flow does not use PKCE) */
  verifier: string;
}

/**
 * The cookie value. A plain GitHub sign-in keeps the original `state|return` form, so a sign-in that
 * started before this version was deployed still completes.
 */
export function encodeState(s: SavedState): string {
  const parts = [s.state, s.returnTo];
  if (s.link || s.provider !== 'github' || s.verifier) parts.push(s.link ? 'link' : '', s.provider, s.verifier);
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
  const [state, returnTo, mode, provider, verifier] = saved.split('|');
  if (!state) return null;
  return {
    state,
    returnTo: safeReturn(returnTo ?? null),
    link: mode === 'link',
    provider: provider === 'google' ? 'google' : 'github',
    verifier: verifier ?? '',
  };
}

export function stateCookie(s: SavedState): string {
  return cookie(STATE_COOKIE, encodeState(s), STATE_TTL_SECONDS);
}

/** Starting a link needs a signed-in user; answers the plain-text refusal, or null to go on */
export async function linkRefusal(c: RouteContext, link: boolean): Promise<Response | null> {
  if (!link) return null;
  if (await currentSession(c)) return null;
  return text('Sign in first, then link another sign-in method from your account settings.', 401);
}

/** A 302 back into the app at an in-app route, clearing the state cookie. `error` is appended as `?error=<code>`. */
export function backToApp(c: RouteContext, returnTo: string, opts: { error?: string; cookies?: string[] } = {}): Response {
  const target = opts.error ? `${returnTo}?error=${encodeURIComponent(opts.error)}` : returnTo;
  const headers = new Headers({ Location: `${c.url.origin}/${target}`, 'Cache-Control': 'no-store' });
  headers.append('Set-Cookie', clearCookie(STATE_COOKIE));
  for (const v of opts.cookies ?? []) headers.append('Set-Cookie', v);
  return new Response(null, { status: 302, headers });
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

/** After the provider confirmed who this is: sign in (or create the account), or link to the signed-in user */
export async function finishOAuth(c: RouteContext, saved: SavedState, profile: OAuthProfile): Promise<Response> {
  const now = c.deps.now();
  if (saved.link) {
    const session = await currentSession(c);
    if (!session) return backToApp(c, saved.returnTo, { error: 'not_signed_in' });
    const result = await linkIdentity(c.env.DB, session.userId, profile, now);
    return backToApp(c, saved.returnTo, result === 'ok' ? {} : { error: result });
  }
  const userId = await findOrCreateUser(c.env.DB, now, profile);
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
