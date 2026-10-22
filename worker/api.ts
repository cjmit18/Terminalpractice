// Account API served by the Worker under /api/*. This file is the router: it matches the route, applies
// the rules every route shares (same-origin check and body cap on state-changing requests, JSON errors),
// and hands over to the modules:
//   auth/github.ts, auth/google.ts  OAuth sign-in and linking (auth/oauth.ts is shared)
//   auth/email.ts                   email + password accounts, verification, password reset
//   account.ts                      account settings, export, delete
//   session.ts, password.ts, tokens.ts, ratelimit.ts, mail.ts, http.ts   building blocks
// Kept free of Cloudflare-only imports so it runs (and is tested) in Node with a SQLite stand-in for D1.
import {
  HttpError,
  BODY_LIMIT,
  defaultDeps,
  errorResponse,
  isMissingSchema,
  json,
  readCookie,
  readJsonObject,
  sha256,
  type ApiDeps,
  type ApiEnv,
  type Route,
  type RouteContext,
} from './http';
import { SESSION_COOKIE, RENEW_BELOW, SESSION_TTL, USER_COLUMNS, clearSessionCookie, sessionCookie, toPublicUser, type UserRow } from './session';
import { emailSendingEnabled } from './mail';
import { githubConfigured, githubRoutes } from './auth/github';
import { googleConfigured, googleRoutes } from './auth/google';
import { emailRoutes } from './auth/email';
import { accountRoutes } from './account';

export type { ApiDeps, ApiEnv, Db, DbStatement, Route, RouteContext } from './http';
export type { PublicUser } from './session';
export { defaultDeps, safeReturn } from './http';

const STATE_CHANGING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

const coreRoutes: Route[] = [
  { method: 'GET', path: '/api/health', handler: () => json({ ok: true }) },
  { method: 'GET', path: '/api/me', handler: me },
  { method: 'POST', path: '/api/logout', handler: logout },
];

const routes: Route[] = [
  ...coreRoutes,
  ...githubRoutes,
  ...googleRoutes,
  ...emailRoutes,
  ...accountRoutes,
  // Progress sync goes here: `...syncRoutes` from worker/sync.ts (GET/PUT /api/progress,
  // POST /api/progress/reset), each with `bodyLimit: SYNC_BODY_LIMIT` from http.ts.
];

function match(route: Route, path: string): Record<string, string> | null {
  if (typeof route.path === 'string') return route.path === path ? {} : null;
  const m = route.path.exec(path);
  return m ? { ...m.groups } : null;
}

/** Handles /api/* requests; returns null for anything else so the caller can serve static assets. */
export async function handleApi(request: Request, env: ApiEnv, deps: ApiDeps = defaultDeps): Promise<Response | null> {
  const url = new URL(request.url);
  if (!url.pathname.startsWith('/api/')) return null;

  let found: { route: Route; params: Record<string, string> } | null = null;
  let pathKnown = false;
  for (const route of routes) {
    const params = match(route, url.pathname);
    if (!params) continue;
    pathKnown = true;
    if (route.method === request.method) {
      found = { route, params };
      break;
    }
  }
  if (!found) {
    return pathKnown
      ? json({ error: 'method_not_allowed', message: 'This method is not allowed here.' }, 405)
      : json({ error: 'not_found', message: 'There is nothing here.' }, 404);
  }

  const limit = found.route.bodyLimit ?? BODY_LIMIT;
  try {
    if (STATE_CHANGING.has(request.method)) {
      // Only this site's own pages may change anything (blocks cross-site requests)
      if (request.headers.get('Origin') !== url.origin) throw new HttpError(403, 'forbidden_origin', 'This request must come from the app itself.');
      if (Number(request.headers.get('Content-Length') ?? '0') > limit) throw new HttpError(413, 'payload_too_large', 'This request is too large.');
    }
    const c: RouteContext = { request, url, env, deps, params: found.params, body: () => readJsonObject(request, limit) };
    return await found.route.handler(c);
  } catch (err) {
    if (err instanceof HttpError) return errorResponse(err);
    // A database without the account tables (a preview build's empty D1) cannot hold accounts
    if (isMissingSchema(err)) return json({ error: 'unavailable', message: 'Accounts are not available on this server.' }, 503);
    throw err;
  }
}

// --- Who am I, sign out --------------------------------------------------------------------

async function providerFlags(env: ApiEnv) {
  return { github: githubConfigured(env), google: googleConfigured(env), email: await hasAccountSchema(env) };
}

/** Email accounts need the 0002 tables; a preview build's empty database has none */
async function hasAccountSchema(env: ApiEnv): Promise<boolean> {
  try {
    await env.DB.prepare('SELECT 1 AS x FROM auth_tokens LIMIT 1').first();
    return true;
  } catch (err) {
    if (isMissingSchema(err)) return false;
    throw err;
  }
}

async function me(c: RouteContext): Promise<Response> {
  const { request, env, deps } = c;
  const emailSending = emailSendingEnabled(env);
  const token = readCookie(request, SESSION_COOKIE);
  // Signed out is a normal answer, not an error: 200 with user null
  if (!token) return json({ user: null, providers: await providerFlags(env), emailSending });

  const hash = await sha256(token);
  let row: (UserRow & { expires_at: number }) | null;
  try {
    row = await env.DB.prepare(`SELECT s.expires_at, ${USER_COLUMNS} FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ?`)
      .bind(hash)
      .first();
  } catch (err) {
    // A database without the account tables (a preview build's empty D1, where sign-in is off) has
    // no sessions, so a stray cookie means signed out rather than a 500
    if (!isMissingSchema(err)) throw err;
    return json({ user: null, providers: await providerFlags(env), emailSending }, 200, { 'Set-Cookie': clearSessionCookie() });
  }

  const providers = { github: githubConfigured(env), google: googleConfigured(env), email: true };
  const now = deps.now();
  if (!row || row.expires_at <= now) {
    if (row) await env.DB.prepare('DELETE FROM sessions WHERE token_hash = ?').bind(hash).run();
    return json({ user: null, providers, emailSending }, 200, { 'Set-Cookie': clearSessionCookie() });
  }

  const user = toPublicUser(row);
  if (row.expires_at - now < RENEW_BELOW) {
    await env.DB.prepare('UPDATE sessions SET expires_at = ? WHERE token_hash = ?').bind(now + SESSION_TTL, hash).run();
    return json({ user, providers, emailSending }, 200, { 'Set-Cookie': sessionCookie(token) });
  }
  return json({ user, providers, emailSending });
}

async function logout(c: RouteContext): Promise<Response> {
  const token = readCookie(c.request, SESSION_COOKIE);
  if (token) await c.env.DB.prepare('DELETE FROM sessions WHERE token_hash = ?').bind(await sha256(token)).run();
  return json({ ok: true }, 200, { 'Set-Cookie': clearSessionCookie() });
}
