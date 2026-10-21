import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { handleApi, safeReturn, type ApiDeps, type ApiEnv, type Db, type DbStatement } from './api.ts';

const ORIGIN = 'https://terminalpractice.example.workers.dev';

/** D1's prepare/bind/first/run on top of Node's built-in SQLite, with the real migration applied. */
function testDb(): Db & { raw: DatabaseSync } {
  const raw = new DatabaseSync(':memory:');
  raw.exec('PRAGMA foreign_keys = ON;');
  raw.exec(readFileSync(new URL('../migrations/0001_accounts.sql', import.meta.url), 'utf8'));
  const statement = (sql: string, values: unknown[] = []): DbStatement => ({
    bind: (...v) => statement(sql, v),
    first: async <T,>() => (raw.prepare(sql).get(...(values as never[])) as T | undefined) ?? null,
    run: async () => raw.prepare(sql).run(...(values as never[])),
  });
  return { raw, prepare: sql => statement(sql) };
}

/** A fake GitHub: answers the token exchange and the profile request, and records what it was sent. */
function fakeGithub(profile = { id: 4242, login: 'octo-learner', name: 'Octo Learner', avatar_url: 'https://avatars.example/4242' }) {
  const calls: { url: string; init?: RequestInit }[] = [];
  const fetch: ApiDeps['fetch'] = async (url, init) => {
    calls.push({ url, init });
    if (url === 'https://github.com/login/oauth/access_token') {
      const body = new URLSearchParams(String(init?.body));
      return body.get('code') === 'good-code'
        ? Response.json({ access_token: 'gho_temp', token_type: 'bearer' })
        : Response.json({ error: 'bad_verification_code' });
    }
    if (url === 'https://api.github.com/user') return Response.json(profile);
    return new Response('unexpected', { status: 500 });
  };
  return { fetch, calls };
}

function setup(overrides: Partial<ApiEnv> = {}) {
  let now = Date.UTC(2026, 9, 21);
  const db = testDb();
  const github = fakeGithub();
  const env: ApiEnv = { DB: db, GITHUB_CLIENT_ID: 'Iv1.testclient', GITHUB_CLIENT_SECRET: 'shh', ...overrides };
  const deps: ApiDeps = { fetch: github.fetch, now: () => now };
  const call = async (method: string, path: string, headers: Record<string, string> = {}) =>
    (await handleApi(new Request(ORIGIN + path, { method, headers }), env, deps))!;
  return { db, env, github, call, advance: (ms: number) => (now += ms) };
}

const cookieValue = (res: Response, name: string) =>
  res.headers.getSetCookie().find(c => c.startsWith(`${name}=`))?.split(';')[0].slice(name.length + 1);

/** Runs start + callback and returns the session cookie value. */
async function signIn(s: ReturnType<typeof setup>, returnTo = '#/learn/lpic1-101') {
  const start = await s.call('GET', `/api/auth/github/start?return=${encodeURIComponent(returnTo)}`);
  const state = new URL(start.headers.get('Location')!).searchParams.get('state')!;
  const stateCookie = cookieValue(start, '__Host-oauth')!;
  const cb = await s.call('GET', `/api/auth/github/callback?code=good-code&state=${state}`, { Cookie: `__Host-oauth=${stateCookie}` });
  return { cb, session: cookieValue(cb, '__Host-session') };
}

test('non-API paths are left to the static assets', async () => {
  const s = setup();
  assert.equal(await handleApi(new Request(`${ORIGIN}/index.html`), s.env), null);
  assert.equal((await s.call('GET', '/api/nope')).status, 404);
  assert.equal((await s.call('DELETE', '/api/me')).status, 405);
});

test('/api/me says signed out, and whether GitHub sign-in is available', async () => {
  assert.deepEqual(await (await setup().call('GET', '/api/me')).json(), { user: null, providers: { github: true } });
  const unconfigured = setup({ GITHUB_CLIENT_ID: '', GITHUB_CLIENT_SECRET: undefined });
  assert.deepEqual(await (await unconfigured.call('GET', '/api/me')).json(), { user: null, providers: { github: false } });
  assert.equal((await unconfigured.call('GET', '/api/auth/github/start')).status, 503);
});

test('start redirects to GitHub with a callback on the current host and a state cookie', async () => {
  const s = setup();
  const res = await s.call('GET', '/api/auth/github/start?return=%23%2Fwindows');
  assert.equal(res.status, 302);
  const location = new URL(res.headers.get('Location')!);
  assert.equal(location.origin + location.pathname, 'https://github.com/login/oauth/authorize');
  assert.equal(location.searchParams.get('client_id'), 'Iv1.testclient');
  assert.equal(location.searchParams.get('redirect_uri'), `${ORIGIN}/api/auth/github/callback`);
  const state = location.searchParams.get('state')!;
  assert.ok(state.length >= 40);
  const stateCookie = res.headers.getSetCookie().find(c => c.startsWith('__Host-oauth='))!;
  assert.match(stateCookie, /HttpOnly; Secure; SameSite=Lax/);
  assert.equal(decodeURIComponent(cookieValue(res, '__Host-oauth')!), `${state}|#/windows`);
});

test('a full sign-in creates the user and a hashed session, and returns to where the learner was', async () => {
  const s = setup();
  const { cb, session } = await signIn(s, '#/learn/lpic1-101');
  assert.equal(cb.status, 302);
  assert.equal(cb.headers.get('Location'), `${ORIGIN}/#/learn/lpic1-101`);
  assert.ok(session && session.length >= 40);
  assert.match(cb.headers.getSetCookie().find(c => c.startsWith('__Host-session='))!, /Max-Age=2592000; HttpOnly; Secure; SameSite=Lax/);

  // The client secret went to GitHub, the token was used for the profile, and none of it is stored
  const exchange = new URLSearchParams(String(s.github.calls[0].init?.body));
  assert.equal(exchange.get('client_secret'), 'shh');
  assert.equal(exchange.get('redirect_uri'), `${ORIGIN}/api/auth/github/callback`);
  const stored = s.db.raw.prepare('SELECT token_hash FROM sessions').all() as { token_hash: string }[];
  assert.equal(stored.length, 1);
  assert.notEqual(stored[0].token_hash, session);
  assert.match(stored[0].token_hash, /^[0-9a-f]{64}$/);

  const me = await (await s.call('GET', '/api/me', { Cookie: `__Host-session=${session}` })).json();
  assert.deepEqual(me.user, { id: me.user.id, name: 'Octo Learner', login: 'octo-learner', avatarUrl: 'https://avatars.example/4242' });

  // Signing in again reuses the same user
  await signIn(s);
  assert.equal((s.db.raw.prepare('SELECT COUNT(*) AS n FROM users').get() as { n: number }).n, 1);
});

test('the callback rejects a missing or mismatched state, and a refused code', async () => {
  const s = setup();
  assert.equal((await s.call('GET', '/api/auth/github/callback?code=good-code&state=abc')).status, 400);
  const start = await s.call('GET', '/api/auth/github/start');
  const stateCookie = cookieValue(start, '__Host-oauth')!;
  const wrong = await s.call('GET', '/api/auth/github/callback?code=good-code&state=not-the-state', { Cookie: `__Host-oauth=${stateCookie}` });
  assert.equal(wrong.status, 400);
  const state = new URL(start.headers.get('Location')!).searchParams.get('state')!;
  const refused = await s.call('GET', `/api/auth/github/callback?code=bad-code&state=${state}`, { Cookie: `__Host-oauth=${stateCookie}` });
  assert.equal(refused.status, 502);
  assert.equal((s.db.raw.prepare('SELECT COUNT(*) AS n FROM sessions').get() as { n: number }).n, 0);
  // Cancelling on GitHub just goes back to the app
  const cancelled = await s.call('GET', '/api/auth/github/callback?error=access_denied', { Cookie: `__Host-oauth=${stateCookie}` });
  assert.equal(cancelled.status, 302);
});

test('sessions slide forward when used and end when they expire', async () => {
  const s = setup();
  const { session } = await signIn(s);
  const cookie = { Cookie: `__Host-session=${session}` };
  s.advance(20 * 86400_000);
  const renewed = await s.call('GET', '/api/me', cookie);
  assert.ok((await renewed.json()).user);
  assert.ok(cookieValue(renewed, '__Host-session'));
  s.advance(31 * 86400_000);
  const expired = await s.call('GET', '/api/me', cookie);
  assert.equal((await expired.json()).user, null);
  assert.equal(cookieValue(expired, '__Host-session'), '');
});

test('logout deletes the session, and only from this site', async () => {
  const s = setup();
  const { session } = await signIn(s);
  const cookie = `__Host-session=${session}`;
  assert.equal((await s.call('POST', '/api/logout', { Cookie: cookie, Origin: 'https://evil.example' })).status, 403);
  assert.equal((await s.call('POST', '/api/logout', { Cookie: cookie })).status, 403);
  const out = await s.call('POST', '/api/logout', { Cookie: cookie, Origin: ORIGIN });
  assert.equal(out.status, 200);
  assert.equal((await (await s.call('GET', '/api/me', { Cookie: cookie })).json()).user, null);
});

test('only in-app hash routes are accepted as a return address', () => {
  assert.equal(safeReturn('#/learn/lpic1-101/step-2'), '#/learn/lpic1-101/step-2');
  assert.equal(safeReturn('https://evil.example'), '#/learn');
  assert.equal(safeReturn('//evil.example'), '#/learn');
  assert.equal(safeReturn('#/../../x'), '#/learn');
  assert.equal(safeReturn(null), '#/learn');
});
