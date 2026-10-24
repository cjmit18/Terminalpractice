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
import { emailSendingEnabled } from './mail';
import { currentSession, loadUser, toPublicUser } from './session';

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

  const routed = emailRoutes.filter(r => r.path === url.pathname);
  if (routed.length) return handleRoute(routed.find(r => r.method === request.method), request, url, env, deps);

  const route = `${request.method} ${url.pathname}`;
  switch (route) {
    case 'GET /api/health':
      return json({ ok: true });
    case 'GET /api/me':
      return me(request, env, deps);
    case 'GET /api/auth/github/start':
      return githubStart(url, env);
    case 'GET /api/auth/github/callback':
      return githubCallback(request, url, env, deps);
    case 'POST /api/logout':
      return logout(request, url, env);
  }
  const known = ['/api/health', '/api/me', '/api/auth/github/start', '/api/auth/github/callback', '/api/logout'];
  return known.includes(url.pathname) ? json({ error: 'Method not allowed' }, 405) : json({ error: 'Not found' }, 404);
}

/**
 * Runs a route from the route modules (auth/email.ts): state-changing requests must come from the app's
 * own pages, bodies are size-capped JSON, and errors answer as JSON with a stable `error` code.
 */
async function handleRoute(route: Route | undefined, request: Request, url: URL, env: ApiEnv, deps: ApiDeps): Promise<Response> {
  if (!route) return json({ error: 'method_not_allowed', message: 'This method is not allowed here.' }, 405);
  const limit = route.bodyLimit ?? BODY_LIMIT;
  try {
    if (route.method !== 'GET') {
      if (!originAllowed(env, url, request.headers.get('Origin'))) throw new HttpError(403, 'forbidden_origin', 'This request must come from the app itself.');
      if (Number(request.headers.get('Content-Length') ?? '0') > limit) throw new HttpError(413, 'payload_too_large', 'This request is too large.');
    }
    const c: RouteContext = { request, url, env, deps, params: {}, body: () => readJsonObject(request, limit) };
    return await route.handler(c);
  } catch (err) {
    if (err instanceof HttpError) return errorResponse(err);
    // A database without the account tables (a preview build's empty D1) cannot hold accounts
    if (isMissingSchema(err)) return json({ error: 'unavailable', message: 'Accounts are not available on this server.' }, 503);
    throw err;
  }
}

// --- Sign-in with GitHub -------------------------------------------------------------------

function githubStart(url: URL, env: ApiEnv): Response {
  if (!env.GITHUB_CLIENT_ID || !env.GITHUB_CLIENT_SECRET) {
    return text('Sign-in with GitHub is not set up on this server yet.', 503);
  }
  const state = randomToken();
  const returnTo = safeReturn(url.searchParams.get('return'));
  const authorize = new URL(GITHUB_AUTHORIZE);
  authorize.searchParams.set('client_id', env.GITHUB_CLIENT_ID);
  // Derived from the request, so the same code works on workers.dev, localhost and a custom domain
  authorize.searchParams.set('redirect_uri', `${url.origin}/api/auth/github/callback`);
  authorize.searchParams.set('state', state);

  const headers = new Headers({ Location: authorize.toString(), 'Cache-Control': 'no-store' });
  headers.append('Set-Cookie', cookie(STATE_COOKIE, encodeURIComponent(`${state}|${returnTo}`), STATE_TTL_SECONDS));
  return new Response(null, { status: 302, headers });
}

async function githubCallback(request: Request, url: URL, env: ApiEnv, deps: ApiDeps): Promise<Response> {
  let saved = '';
  try {
    saved = decodeURIComponent(readCookie(request, STATE_COOKIE) ?? '');
  } catch {
    // A malformed cookie (bad %-escape) is no saved state: the check below answers 400
  }
  const [savedState, savedReturn] = saved.split('|');
  const returnTo = safeReturn(savedReturn ?? null);
  const back = (extra?: (h: Headers) => void) => {
    const headers = new Headers({ Location: `${url.origin}/${returnTo}`, 'Cache-Control': 'no-store' });
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

  const userId = await upsertGithubUser(env.DB, deps.now(), {
    providerId: String(profile.id),
    login: profile.login,
    name: profile.name || profile.login,
    avatarUrl: profile.avatar_url ?? null,
  });
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
    // Keep the name, username and picture current with GitHub
    await db.prepare('UPDATE users SET display_name = ?, avatar_url = ? WHERE id = ?').bind(p.name, p.avatarUrl, userId).run();
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

// --- Sessions ------------------------------------------------------------------------------

async function createSession(db: Db, userId: string, now: number): Promise<string> {
  const token = randomToken();
  await db
    .prepare('INSERT INTO sessions (token_hash, user_id, expires_at, created_at) VALUES (?, ?, ?, ?)')
    .bind(await sha256(token), userId, now + SESSION_TTL, now)
    .run();
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
    return json({ user, providers, emailSending }, 200, session.renewedCookie ? { 'Set-Cookie': session.renewedCookie } : {});
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
