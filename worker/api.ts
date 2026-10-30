// Account API served by the Worker under /api/*: GitHub sign-in, email sign-up and sign-in (auth/email.ts),
// sessions, "who am I" and sign-out.
// Kept free of Cloudflare-only imports so it runs (and is tested) in Node with a SQLite stand-in for D1.

import {
  BODY_LIMIT,
  HttpError,
  errorResponse,
  isMissingSchema,
  originAllowed,
  readJsonObject,
  type ApiDeps,
  type ApiEnv,
  type Db,
  type Route,
  type RouteContext,
} from './http';
import { emailRoutes } from './auth/email';
import { syncRoutes } from './sync';
import { accountRoutes } from './account';
import { adminRoutes, roleOf } from './admin';
import { emailSendingEnabled } from './mail';
import { REAUTH_WINDOW, SESSION_MAX_AGE, currentSession, emailUnverified, loadUser, recordSignIn, toPublicUser } from './session';

export type { ApiDeps, ApiEnv, Db, DbStatement } from './http';

const SESSION_COOKIE = '__Host-session';
const STATE_COOKIE = '__Host-oauth';
const DAY = 24 * 60 * 60 * 1000;
const SESSION_TTL = 30 * DAY;
const STATE_TTL_SECONDS = 10 * 60;
const DEFAULT_RETURN = '#/learn';

const GITHUB_AUTHORIZE = 'https://github.com/login/oauth/authorize';
const GITHUB_TOKEN = 'https://github.com/login/oauth/access_token';
const GITHUB_USER = 'https://api.github.com/user';

export interface PublicUser {
  id: string;
  name: string;
  login: string | null;
  email: string | null;
  emailVerified: boolean;
  avatarUrl: string | null;
}

const defaultDeps: ApiDeps = {
  // Wrapped so the platform fetch is never called with a detached `this`
  fetch: (input, init) => fetch(input, init),
  now: () => Date.now(),
};

/** Handles /api/* requests; returns null for anything else so the caller can serve static assets. */
export async function handleApi(request: Request, env: ApiEnv, deps: ApiDeps = defaultDeps): Promise<Response | null> {
  const url = new URL(request.url);
  if (!url.pathname.startsWith('/api/')) return null;

  const routed = [...emailRoutes, ...syncRoutes, ...accountRoutes, ...adminRoutes]
    .map(route => ({ route, params: matchPath(route.path, url.pathname) }))
    .filter((m): m is { route: Route; params: Record<string, string> } => m.params !== null);
  if (routed.length) {
    const hit = routed.find(m => m.route.method === request.method);
    return handleRoute(hit?.route, hit?.params ?? {}, request, url, env, deps);
  }

  const route = `${request.method} ${url.pathname}`;
  switch (route) {
    case 'GET /api/health':
      return json({ ok: true });
    case 'GET /api/me':
      return me(request, env, deps);
    case 'GET /api/auth/github/start':
      return githubStart(request, url, env, deps);
    case 'GET /api/auth/github/callback':
      return githubCallback(request, url, env, deps);
    case 'POST /api/logout':
      return logout(request, url, env);
  }
  const known = ['/api/health', '/api/me', '/api/auth/github/start', '/api/auth/github/callback', '/api/logout'];
  return known.includes(url.pathname) ? json({ error: 'Method not allowed' }, 405) : json({ error: 'Not found' }, 404);
}

/** The route's named parameters when `pathname` matches it (an exact path, or a pattern with named groups), else null */
function matchPath(path: string | RegExp, pathname: string): Record<string, string> | null {
  if (typeof path === 'string') return path === pathname ? {} : null;
  const m = path.exec(pathname);
  return m ? { ...m.groups } : null;
}

/**
 * Runs a route from the route modules (auth/email.ts, sync.ts, account.ts): state-changing requests must come from the app's
 * own pages, bodies are size-capped JSON, and errors answer as JSON with a stable `error` code.
 */
async function handleRoute(
  route: Route | undefined,
  params: Record<string, string>,
  request: Request,
  url: URL,
  env: ApiEnv,
  deps: ApiDeps,
): Promise<Response> {
  if (!route) return json({ error: 'method_not_allowed', message: 'This method is not allowed here.' }, 405);
  const limit = route.bodyLimit ?? BODY_LIMIT;
  try {
    if (route.method !== 'GET') {
      if (!originAllowed(env, url, request.headers.get('Origin'))) throw new HttpError(403, 'forbidden_origin', 'This request must come from the app itself.');
      if (Number(request.headers.get('Content-Length') ?? '0') > limit) throw new HttpError(413, 'payload_too_large', 'This request is too large.');
    }
    const c: RouteContext = { request, url, env, deps, params, body: () => readJsonObject(request, limit) };
    return await route.handler(c);
  } catch (err) {
    if (err instanceof HttpError) return errorResponse(err);
    // A database without the account tables (a preview build's empty D1) cannot hold accounts
    if (isMissingSchema(err)) return json({ error: 'unavailable', message: 'Accounts are not available on this server.' }, 503);
    throw err;
  }
}

// --- Sign-in with GitHub -------------------------------------------------------------------

/**
 * Starts a GitHub sign-in, or with `?link=1` links GitHub to the signed-in account (portal part 7d).
 * Linking needs a session, a confirmed email when the account has one, and a sign-in or password check
 * within the last 10 minutes (POST /api/account/reauth); otherwise it goes back to the app with `?error=`.
 * The flow is tied to this session: the callback links only for the same one.
 */
async function githubStart(request: Request, url: URL, env: ApiEnv, deps: ApiDeps): Promise<Response> {
  if (!env.GITHUB_CLIENT_ID || !env.GITHUB_CLIENT_SECRET) {
    return text('Sign-in with GitHub is not set up on this server yet.', 503);
  }
  const state = randomToken();
  const returnTo = safeReturn(url.searchParams.get('return'));
  let link = '';
  if (url.searchParams.get('link') === '1') {
    // A page on another site must not start a link for the signed-in visitor (a missing header is an older browser)
    const site = request.headers.get('Sec-Fetch-Site');
    if (site !== null && site !== 'same-origin' && site !== 'none') return text('Linking has to start from the app itself.', 403);
    const session = await currentSession({ request, env, deps });
    const user = session && (await loadUser(env.DB, session.userId));
    if (!session || !user) return text('Sign in first, then link GitHub from your account’s security page.', 401);
    if (emailUnverified(user)) return backTo(url, returnTo, 'email_unverified');
    if (deps.now() - session.authenticatedAt > REAUTH_WINDOW) return backTo(url, returnTo, 'reauth_required');
    link = `|link|${session.tokenHash}`;
  }
  const authorize = new URL(GITHUB_AUTHORIZE);
  authorize.searchParams.set('client_id', env.GITHUB_CLIENT_ID);
  // Derived from the request, so the same code works on workers.dev, localhost and a custom domain
  authorize.searchParams.set('redirect_uri', `${url.origin}/api/auth/github/callback`);
  authorize.searchParams.set('state', state);

  const headers = new Headers({ Location: authorize.toString(), 'Cache-Control': 'no-store' });
  headers.append('Set-Cookie', cookie(STATE_COOKIE, encodeURIComponent(`${state}|${returnTo}${link}`), STATE_TTL_SECONDS));
  return new Response(null, { status: 302, headers });
}

/** A redirect into the app with `?error=<code>` for the page to explain; the state cookie is left alone */
function backTo(url: URL, returnTo: string, error: string): Response {
  return new Response(null, { status: 302, headers: { Location: `${url.origin}/${returnTo}?error=${error}`, 'Cache-Control': 'no-store' } });
}

async function githubCallback(request: Request, url: URL, env: ApiEnv, deps: ApiDeps): Promise<Response> {
  let saved = '';
  try {
    saved = decodeURIComponent(readCookie(request, STATE_COOKIE) ?? '');
  } catch {
    // A malformed cookie (bad %-escape) is no saved state: the check below answers 400
  }
  const [savedState, savedReturn, mode, linkSession] = saved.split('|');
  const returnTo = safeReturn(savedReturn ?? null);
  const back = (extra?: (h: Headers) => void, error?: string) => {
    const headers = new Headers({ Location: `${url.origin}/${returnTo}${error ? `?error=${error}` : ''}`, 'Cache-Control': 'no-store' });
    headers.append('Set-Cookie', clearCookie(STATE_COOKIE));
    extra?.(headers);
    return new Response(null, { status: 302, headers });
  };

  // The learner pressed Cancel on GitHub: go back quietly
  if (url.searchParams.get('error')) return back();

  const code = url.searchParams.get('code');
  const state = url.searchParams.get('state');
  if (!code || !state || !savedState || state !== savedState) {
    return text('This sign-in link expired or was opened in a different browser. Go back to the app and choose Sign in again.', 400, {
      'Set-Cookie': clearCookie(STATE_COOKIE),
    });
  }
  if (!env.GITHUB_CLIENT_ID || !env.GITHUB_CLIENT_SECRET) {
    return text('Sign-in with GitHub is not set up on this server yet.', 503);
  }

  // Exchange the one-time code for a short-lived token, then read the GitHub profile with it.
  // The GitHub token is used once here and never stored.
  const tokenRes = await deps.fetch(GITHUB_TOKEN, {
    method: 'POST',
    headers: { Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: env.GITHUB_CLIENT_ID,
      client_secret: env.GITHUB_CLIENT_SECRET,
      code,
      redirect_uri: `${url.origin}/api/auth/github/callback`,
    }).toString(),
  });
  const token = (await tokenRes.json().catch(() => ({}))) as { access_token?: string };
  if (!tokenRes.ok || !token.access_token) {
    return text('GitHub did not accept this sign-in. Go back to the app and try again.', 502, { 'Set-Cookie': clearCookie(STATE_COOKIE) });
  }

  const profileRes = await deps.fetch(GITHUB_USER, {
    headers: {
      Authorization: `Bearer ${token.access_token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'terminus-certsim',
    },
  });
  const profile = (await profileRes.json().catch(() => ({}))) as { id?: number; login?: string; name?: string | null; avatar_url?: string };
  if (!profileRes.ok || typeof profile.id !== 'number' || !profile.login) {
    return text('Could not read your GitHub profile. Go back to the app and try again.', 502, { 'Set-Cookie': clearCookie(STATE_COOKIE) });
  }

  const github = {
    providerId: String(profile.id),
    login: profile.login,
    name: profile.name || profile.login,
    avatarUrl: profile.avatar_url ?? null,
  };
  if (mode === 'link') {
    // Only for the session that started the link: not after a sign-out, or with another account signed in
    const session = await currentSession({ request, env, deps });
    if (!session || session.tokenHash !== linkSession) return back(undefined, 'session_changed');
    const result = await linkGithub(env.DB, session.userId, session.tokenHash, github, deps.now());
    return back(undefined, result === 'ok' ? undefined : result);
  }
  const userId = await upsertGithubUser(env.DB, deps.now(), github);
  const sessionToken = await createSession(env.DB, userId, deps.now());
  return back(h => h.append('Set-Cookie', cookie(SESSION_COOKIE, sessionToken, SESSION_TTL / 1000)));
}

/**
 * Find or create the user for a GitHub account. Safe when two first sign-ins of the same account
 * run at once (two tabs, a double click): both may get past the first lookup and create a users
 * row, but only one identities row can exist for (provider, provider_id). The loser's insert does
 * nothing, it re-reads the winner's user id and deletes its own unused users row.
 */
async function upsertGithubUser(
  db: Db,
  now: number,
  p: { providerId: string; login: string; name: string; avatarUrl: string | null },
): Promise<string> {
  const findUser = () =>
    db
      .prepare('SELECT user_id FROM identities WHERE provider = ? AND provider_id = ?')
      .bind('github', p.providerId)
      .first<{ user_id: string }>();
  const refresh = async (userId: string) => {
    // Keep the username and picture current with GitHub. Not the display name: it is the learner's own to
    // change on the security page, and an account that linked GitHub chose its name itself
    await db.prepare('UPDATE users SET avatar_url = ? WHERE id = ?').bind(p.avatarUrl, userId).run();
    await db.prepare('UPDATE identities SET login = ? WHERE provider = ? AND provider_id = ?').bind(p.login, 'github', p.providerId).run();
  };

  const existing = await findUser();
  if (existing) {
    await refresh(existing.user_id);
    return existing.user_id;
  }
  const id = crypto.randomUUID();
  await db.prepare('INSERT INTO users (id, display_name, avatar_url, created_at) VALUES (?, ?, ?, ?)').bind(id, p.name, p.avatarUrl, now).run();
  await db
    .prepare('INSERT INTO identities (provider, provider_id, user_id, login) VALUES (?, ?, ?, ?) ON CONFLICT (provider, provider_id) DO NOTHING')
    .bind('github', p.providerId, id, p.login)
    .run();
  const winner = await findUser();
  if (!winner) throw new Error('GitHub identity missing right after insert');
  if (winner.user_id !== id) {
    // Another sign-in created this account first: drop the users row this one made and use theirs
    await db.prepare('DELETE FROM users WHERE id = ?').bind(id).run();
    await refresh(winner.user_id);
  }
  return winner.user_id;
}

/**
 * Links a GitHub account to a user (portal part 7d). Never moves an identity that belongs to another
 * account, and never gives one account two GitHub identities. The insert checks both, and that the
 * session which started the link is still alive, in the same statement: two links finishing at once
 * cannot both land, and a sign-out or password change that lands after the callback's own session check
 * still stops the link.
 */
async function linkGithub(
  db: Db,
  userId: string,
  sessionHash: string,
  p: { providerId: string; login: string; avatarUrl: string | null },
  now: number,
): Promise<'ok' | 'identity_in_use' | 'provider_already_linked' | 'session_changed'> {
  const ownerOf = () =>
    db
      .prepare('SELECT user_id FROM identities WHERE provider = ? AND provider_id = ?')
      .bind('github', p.providerId)
      .first<{ user_id: string }>();
  const owner = await ownerOf();
  if (owner) return owner.user_id === userId ? 'ok' : 'identity_in_use';
  const linked = await db
    .prepare(
      `INSERT INTO identities (provider, provider_id, user_id, login, linked_at)
         SELECT 'github', ?2, id, ?3, ?4 FROM users
         WHERE id = ?1
           AND NOT EXISTS (SELECT 1 FROM identities WHERE user_id = ?1 AND provider = 'github')
           AND EXISTS (SELECT 1 FROM sessions WHERE token_hash = ?5 AND user_id = ?1 AND expires_at > ?4 AND created_at > ?6)
       ON CONFLICT (provider, provider_id) DO NOTHING
       RETURNING user_id`,
    )
    .bind(userId, p.providerId, p.login, now, sessionHash, now - SESSION_MAX_AGE)
    .first<{ user_id: string }>();
  if (linked) {
    // The GitHub picture fills an account that has none; the display name stays the learner's own
    await db.prepare('UPDATE users SET avatar_url = COALESCE(avatar_url, ?) WHERE id = ?').bind(p.avatarUrl, userId).run();
    return 'ok';
  }
  const winner = await ownerOf();
  if (winner) return winner.user_id === userId ? 'ok' : 'identity_in_use';
  const alive = await db.prepare('SELECT 1 AS x FROM sessions WHERE token_hash = ? AND user_id = ?').bind(sessionHash, userId).first();
  return alive ? 'provider_already_linked' : 'session_changed';
}

// --- Sessions ------------------------------------------------------------------------------

async function createSession(db: Db, userId: string, now: number): Promise<string> {
  const token = randomToken();
  await db
    .prepare('INSERT INTO sessions (token_hash, user_id, expires_at, created_at) VALUES (?, ?, ?, ?)')
    .bind(await sha256(token), userId, now + SESSION_TTL, now)
    .run();
  await recordSignIn(db, userId, now);
  return token;
}

async function me(request: Request, env: ApiEnv, deps: ApiDeps): Promise<Response> {
  // Which sign-in methods the app may offer. GitHub once its app is configured; email and password once
  // the rate limits can run (they need the RATE_LIMIT_PEPPER secret, see ratelimit.ts).
  const providers = {
    github: Boolean(env.GITHUB_CLIENT_ID && env.GITHUB_CLIENT_SECRET),
    email: Boolean(env.RATE_LIMIT_PEPPER || env.ALLOW_UNPEPPERED_RATE_LIMITS === '1'),
  };
  // Whether confirmation and reset emails can go out (SMTP configured), so the app can say so
  const emailSending = emailSendingEnabled(env, deps);
  const token = readCookie(request, SESSION_COOKIE);
  // Signed out is a normal answer, not an error: 200 with user null
  if (!token) return json({ user: null, providers, emailSending });
  const signedOut = () => json({ user: null, providers, emailSending }, 200, { 'Set-Cookie': clearCookie(SESSION_COOKIE) });

  try {
    // Expiry, the 90-day cap and sliding renewal follow the same rules for every sign-in method (session.ts)
    const session = await currentSession({ request, env, deps });
    const row = session && (await loadUser(env.DB, session.userId));
    if (!session || !row) {
      await env.DB.prepare('DELETE FROM sessions WHERE token_hash = ?').bind(await sha256(token)).run();
      return signedOut();
    }
    const user: PublicUser = toPublicUser(row);
    // 'owner' or 'admin' opens the admin dashboard; null for everyone else
    const role = await roleOf(env, row);
    return json({ user, role, providers, emailSending }, 200, session.renewedCookie ? { 'Set-Cookie': session.renewedCookie } : {});
  } catch (err) {
    // A database without the account tables (a preview build's empty D1, where sign-in is off) has
    // no sessions, so a stray cookie means signed out rather than a 500
    if (!isMissingTable(err)) throw err;
    return signedOut();
  }
}

async function logout(request: Request, url: URL, env: ApiEnv): Promise<Response> {
  // Only this site's own pages may sign someone out (blocks cross-site requests)
  if (request.headers.get('Origin') !== url.origin) return json({ error: 'Forbidden' }, 403);
  const token = readCookie(request, SESSION_COOKIE);
  if (token) await env.DB.prepare('DELETE FROM sessions WHERE token_hash = ?').bind(await sha256(token)).run();
  return json({ ok: true }, 200, { 'Set-Cookie': clearCookie(SESSION_COOKIE) });
}

// --- Helpers -------------------------------------------------------------------------------

/** Only in-app hash routes are allowed as a place to return to, so the callback cannot redirect elsewhere. */
export function safeReturn(value: string | null): string {
  return value && /^#\/[A-Za-z0-9\-_/.]*$/.test(value) && !value.includes('..') ? value : DEFAULT_RETURN;
}

/** SQLite's (and so D1's) error for a query on a table that was never created */
function isMissingTable(err: unknown): boolean {
  return err instanceof Error && /no such table/i.test(err.message);
}

function randomToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, '0')).join('');
}

function cookie(name: string, value: string, maxAgeSeconds: number): string {
  // __Host- cookies must be Secure, have Path=/ and no Domain: they stay on this exact host
  return `${name}=${value}; Path=/; Max-Age=${Math.floor(maxAgeSeconds)}; HttpOnly; Secure; SameSite=Lax`;
}

function clearCookie(name: string): string {
  return `${name}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax`;
}

function readCookie(request: Request, name: string): string | null {
  for (const part of (request.headers.get('Cookie') ?? '').split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) return v.join('=');
  }
  return null;
}

function json(body: unknown, status = 200, extra: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...extra },
  });
}

function text(body: string, status: number, extra: Record<string, string> = {}): Response {
  return new Response(body, {
    status,
    headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store', ...extra },
  });
}
