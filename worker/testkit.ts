// Test helpers for the Worker API: D1 on Node's built-in SQLite with every migration applied, and fake
// GitHub, Google and Resend endpoints behind deps.fetch.
import { readFileSync, readdirSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { handleApi, type ApiDeps, type ApiEnv, type DbStatement } from './api.ts';
import type { SyncDb } from './sync.ts';

export const ORIGIN = 'https://terminalpractice.example.workers.dev';

/** D1's prepare/bind/first/all/run/batch on top of SQLite. `migrations: false` gives an empty database. */
export function testDb(migrations = true): SyncDb & { raw: DatabaseSync } {
  const raw = new DatabaseSync(':memory:');
  raw.exec('PRAGMA foreign_keys = ON;');
  if (migrations) {
    const dir = new URL('../migrations/', import.meta.url);
    for (const file of readdirSync(dir).filter(f => f.endsWith('.sql')).sort()) {
      raw.exec(readFileSync(new URL(file, dir), 'utf8'));
    }
  }
  const statement = (sql: string, values: unknown[] = []): DbStatement & { exec(): unknown } => ({
    bind: (...v) => statement(sql, v),
    first: async <T,>() => (raw.prepare(sql).get(...(values as never[])) as T | undefined) ?? null,
    all: async <T,>() => ({ results: raw.prepare(sql).all(...(values as never[])) as T[] }),
    // D1 reports the changed rows as meta.changes
    run: async () => {
      const res = raw.prepare(sql).run(...(values as never[]));
      return { ...res, meta: { changes: Number(res.changes) } };
    },
    exec: () => raw.prepare(sql).run(...(values as never[])),
  });
  return {
    raw,
    prepare: sql => statement(sql),
    // One transaction, as D1's batch is
    batch: async stmts => {
      raw.exec('BEGIN');
      try {
        const out = stmts.map(s => (s as ReturnType<typeof statement>).exec());
        raw.exec('COMMIT');
        return out;
      } catch (err) {
        raw.exec('ROLLBACK');
        throw err;
      }
    },
  };
}

export interface SentEmail {
  to: string[];
  from: string;
  subject: string;
  text: string;
  html: string;
}

export const GITHUB_PROFILE = { id: 4242, login: 'octo-learner', name: 'Octo Learner', avatar_url: 'https://avatars.example/4242' };
export const GOOGLE_PROFILE = { sub: '110248495921238986420', email: 'learner@gmail.example', email_verified: true, name: 'Google Learner' };

/** One fake for every outside service the API talks to; records each call */
export function fakeServices() {
  const calls: { url: string; init?: RequestInit }[] = [];
  const emails: SentEmail[] = [];
  const state = { github: { ...GITHUB_PROFILE }, google: { ...GOOGLE_PROFILE } as Record<string, unknown>, resendStatus: 200 };
  const fetch: ApiDeps['fetch'] = async (url, init) => {
    calls.push({ url, init });
    if (url === 'https://github.com/login/oauth/access_token') {
      const body = new URLSearchParams(String(init?.body));
      return body.get('code') === 'good-code'
        ? Response.json({ access_token: 'gho_temp', token_type: 'bearer' })
        : Response.json({ error: 'bad_verification_code' });
    }
    if (url === 'https://api.github.com/user') return Response.json(state.github);
    if (url === 'https://oauth2.googleapis.com/token') {
      const body = new URLSearchParams(String(init?.body));
      return body.get('code') === 'google-code' && body.get('code_verifier') && body.get('grant_type') === 'authorization_code'
        ? Response.json({ access_token: 'ya29.temp', id_token: 'header.payload.sig', token_type: 'Bearer', expires_in: 3599 })
        : Response.json({ error: 'invalid_grant' }, { status: 400 });
    }
    if (url === 'https://openidconnect.googleapis.com/v1/userinfo') {
      const auth = new Headers(init?.headers).get('Authorization');
      return auth === 'Bearer ya29.temp' ? Response.json(state.google) : Response.json({ error: 'invalid_token' }, { status: 401 });
    }
    if (url === 'https://api.resend.com/emails') {
      emails.push(JSON.parse(String(init?.body)) as SentEmail);
      return state.resendStatus === 200 ? Response.json({ id: `email-${emails.length}` }) : new Response('nope', { status: state.resendStatus });
    }
    return new Response('unexpected', { status: 500 });
  };
  return { fetch, calls, emails, state };
}

export interface CallOptions {
  headers?: Record<string, string>;
  /** A JSON body; sent with Content-Type: application/json */
  json?: unknown;
  /** Session cookie value to send */
  session?: string;
  /** Origin header; defaults to the site's own origin for state-changing methods */
  origin?: string | null;
  ip?: string;
}

export function setup(overrides: Partial<ApiEnv> = {}) {
  let now = Date.UTC(2026, 9, 21);
  const db = testDb();
  const services = fakeServices();
  const env: ApiEnv = {
    DB: db,
    GITHUB_CLIENT_ID: 'Iv1.testclient',
    GITHUB_CLIENT_SECRET: 'shh',
    GOOGLE_CLIENT_ID: 'google-client.apps.googleusercontent.com',
    GOOGLE_CLIENT_SECRET: 'g-secret',
    RESEND_API_KEY: 're_test',
    EMAIL_FROM: 'Terminus <accounts@terminuscli.example>',
    ...overrides,
  };
  const deps: ApiDeps = { fetch: services.fetch, now: () => now };
  const call = async (method: string, path: string, opts: CallOptions = {}) => {
    const headers: Record<string, string> = { 'CF-Connecting-IP': opts.ip ?? '203.0.113.7', ...opts.headers };
    const stateChanging = !['GET', 'HEAD'].includes(method);
    const origin = opts.origin === undefined ? (stateChanging ? ORIGIN : null) : opts.origin;
    if (origin) headers.Origin = origin;
    if (opts.session) headers.Cookie = [headers.Cookie, `__Host-session=${opts.session}`].filter(Boolean).join('; ');
    let body: string | undefined;
    if (opts.json !== undefined) {
      body = JSON.stringify(opts.json);
      headers['Content-Type'] ??= 'application/json';
    }
    return (await handleApi(new Request(ORIGIN + path, { method, headers, body }), env, deps))!;
  };
  const count = (sql: string, ...args: unknown[]) => (db.raw.prepare(sql).get(...(args as never[])) as { n: number }).n;
  return { db, env, deps, services, call, count, advance: (ms: number) => (now += ms), now: () => now };
}

export type Setup = ReturnType<typeof setup>;

export const cookieValue = (res: Response, name: string) =>
  res.headers.getSetCookie().find(c => c.startsWith(`${name}=`))?.split(';')[0].slice(name.length + 1);

/** The token from the link in the newest email (verify or reset) */
export function tokenFromEmail(s: Setup, kind: 'verify' | 'reset'): string {
  const mail = s.services.emails.at(-1);
  if (!mail) throw new Error('no email sent');
  const m = new RegExp(`#/account/${kind}\\?token=([A-Za-z0-9_-]+)`).exec(mail.text);
  if (!m) throw new Error(`no ${kind} link in the email`);
  return m[1];
}

export const PASSWORD = 'correct horse battery staple';

/** Registers an email account; returns the session cookie value and the user */
export async function register(s: Setup, email = 'Learner@Example.com', password = PASSWORD, ip?: string) {
  const res = await s.call('POST', '/api/auth/email/register', { json: { email, password, displayName: 'Ada Learner', ageConfirmed: true }, ip });
  const body = (await res.json()) as { user: { id: string; email: string; emailVerified: boolean } };
  return { res, session: cookieValue(res, '__Host-session')!, user: body.user };
}

/** Runs an OAuth start + callback. Returns the callback response and the new session cookie (if any). */
export async function oauth(
  s: Setup,
  provider: 'github' | 'google',
  opts: { session?: string; link?: boolean; returnTo?: string; code?: string } = {},
) {
  const q = new URLSearchParams({ return: opts.returnTo ?? '#/learn' });
  if (opts.link) q.set('link', '1');
  const start = await s.call('GET', `/api/auth/${provider}/start?${q}`, { session: opts.session });
  if (start.status !== 302) return { start, cb: start, session: undefined };
  const location = new URL(start.headers.get('Location')!);
  const state = location.searchParams.get('state')!;
  const stateCookie = cookieValue(start, '__Host-oauth')!;
  const code = opts.code ?? (provider === 'github' ? 'good-code' : 'google-code');
  const cb = await s.call('GET', `/api/auth/${provider}/callback?code=${code}&state=${state}`, {
    session: opts.session,
    headers: { Cookie: `__Host-oauth=${stateCookie}` },
  });
  return { start, location, cb, session: cookieValue(cb, '__Host-session') };
}
