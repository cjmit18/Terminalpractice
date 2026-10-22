// Email sign-up and sign-in through the API, on Node's SQLite with every migration applied.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { handleApi, type ApiEnv, type Db, type DbStatement } from './api.ts';
import { normalizeEmail } from './auth/email.ts';
import { DAY } from './session.ts';

const ORIGIN = 'https://terminuscli.com';
const PASSWORD = 'correct horse battery staple';

function testDb(): Db & { raw: DatabaseSync } {
  const raw = new DatabaseSync(':memory:');
  raw.exec('PRAGMA foreign_keys = ON;');
  for (const name of readdirSync(new URL('../migrations/', import.meta.url)).filter(f => f.endsWith('.sql')).sort()) {
    raw.exec(readFileSync(new URL(`../migrations/${name}`, import.meta.url), 'utf8'));
  }
  const statement = (sql: string, values: unknown[] = []): DbStatement => ({
    bind: (...v) => statement(sql, v),
    first: async <T,>() => (raw.prepare(sql).get(...(values as never[])) as T | undefined) ?? null,
    all: async <T,>() => ({ results: raw.prepare(sql).all(...(values as never[])) as T[] }),
    run: async () => raw.prepare(sql).run(...(values as never[])),
  });
  return { raw, prepare: sql => statement(sql) };
}

function setup(overrides: Partial<ApiEnv> = {}) {
  let now = Date.UTC(2026, 9, 23);
  const db = testDb();
  const env: ApiEnv = { DB: db, RATE_LIMIT_PEPPER: 'test-pepper', ...overrides };
  const deps = { fetch: async () => new Response('unexpected', { status: 500 }), now: () => now };
  const call = (method: string, path: string, body?: unknown, headers: Record<string, string> = {}) =>
    handleApi(
      new Request(`${ORIGIN}${path}`, {
        method,
        headers: { Origin: ORIGIN, 'Content-Type': 'application/json', 'CF-Connecting-IP': '203.0.113.9', ...headers },
        body: body === undefined ? undefined : JSON.stringify(body),
      }),
      env,
      deps,
    ).then(r => r!);
  const register = (fields: Record<string, unknown> = {}, headers?: Record<string, string>) =>
    call('POST', '/api/auth/email/register', { email: 'Learner@Example.com', password: PASSWORD, displayName: 'Learner', ageConfirmed: true, ...fields }, headers);
  const login = (email = 'learner@example.com', password = PASSWORD, headers?: Record<string, string>) =>
    call('POST', '/api/auth/email/login', { email, password }, headers);
  return { db, env, call, register, login, advance: (ms: number) => (now += ms) };
}

const sessionOf = (res: Response) => /__Host-session=([^;]*)/.exec(res.headers.get('Set-Cookie') ?? '')?.[1] ?? null;
const count = (db: { raw: DatabaseSync }, table: string) => (db.raw.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;

test('sign-up: creates the account and an email sign-in method, signs in, and stores only a password hash', async () => {
  const s = setup();
  const res = await s.register();
  assert.equal(res.status, 201);
  const body = await res.json();
  assert.equal(body.user.email, 'learner@example.com');
  assert.equal(body.user.emailVerified, false);
  assert.equal(body.user.name, 'Learner');
  const token = sessionOf(res);
  assert.ok(token);
  assert.match(res.headers.get('Set-Cookie')!, /HttpOnly; Secure; SameSite=Lax/);

  const row = s.db.raw.prepare('SELECT password_hash, email_set_at FROM users').get() as { password_hash: string; email_set_at: number };
  assert.match(row.password_hash, /^pbkdf2\$sha256\$/);
  assert.ok(!row.password_hash.includes(PASSWORD));
  assert.ok(row.email_set_at > 0);
  assert.deepEqual({ ...s.db.raw.prepare('SELECT provider, provider_id FROM identities').get() }, { provider: 'email', provider_id: 'learner@example.com' });

  const me = await (await s.call('GET', '/api/me', undefined, { Cookie: `__Host-session=${token}` })).json();
  assert.equal(me.user.email, 'learner@example.com');
  assert.equal(me.user.emailVerified, false);
});

test('sign-up: refuses bad emails, weak passwords, bad names, a missing age confirmation and a taken address', async () => {
  const s = setup();
  // A different address each time: refused sign-ups count against the per-address limit too
  let n = 0;
  const attempt = async (fields: Record<string, unknown> = {}) => {
    const res = await s.register(fields, { 'CF-Connecting-IP': `198.51.100.${++n}` });
    return { status: res.status, error: res.status === 201 ? undefined : (await res.json()).error };
  };
  assert.deepEqual(await attempt({ email: 'not-an-email' }), { status: 400, error: 'invalid_email' });
  assert.deepEqual(await attempt({ email: 'a@192.168.1.1' }), { status: 400, error: 'invalid_email' });
  assert.deepEqual(await attempt({ password: 'short' }), { status: 400, error: 'password_too_short' });
  assert.deepEqual(await attempt({ password: '1234567890' }), { status: 400, error: 'common_password' });
  assert.deepEqual(await attempt({ displayName: 'evil‮eman' }), { status: 400, error: 'invalid_display_name' });
  assert.deepEqual(await attempt({ ageConfirmed: false }), { status: 400, error: 'age_required' });
  assert.equal(count(s.db, 'users'), 0, 'nothing stored for a refused sign-up');

  assert.deepEqual(await attempt(), { status: 201, error: undefined });
  assert.deepEqual(await attempt({ email: ' LEARNER@example.COM ' }), { status: 409, error: 'email_taken' });
});

test('emails are normalized to one canonical form', () => {
  assert.equal(normalizeEmail('  Learner@Example.COM '), 'learner@example.com');
  assert.equal(normalizeEmail('a@bücher.example'), 'a@xn--bcher-kva.example');
  for (const bad of ['a b@x.com', 'a@b@c.com', '"a"@x.com', 'a@x', 'a​@x.com', '@x.com', 'a@x.123']) {
    assert.equal(normalizeEmail(bad), null, bad);
  }
});

test('sign-in: the right password signs in and replaces the browser\'s old session; a wrong one or an unknown email gets the same answer', async () => {
  const s = setup();
  const old = sessionOf(await s.register());

  const ok = await s.login('LEARNER@example.com', PASSWORD, { Cookie: `__Host-session=${old}` });
  assert.equal(ok.status, 200);
  assert.equal((await ok.json()).user.email, 'learner@example.com');
  assert.ok(sessionOf(ok));
  assert.notEqual(sessionOf(ok), old);
  const me = await (await s.call('GET', '/api/me', undefined, { Cookie: `__Host-session=${old}` })).json();
  assert.equal(me.user, null, 'the old session ended');

  const wrong = await s.login('learner@example.com', 'not the password at all');
  const unknown = await s.login('nobody@example.com', PASSWORD);
  assert.equal(wrong.status, 401);
  assert.equal(unknown.status, 401);
  assert.deepEqual(await wrong.json(), await unknown.json());
  assert.equal(sessionOf(wrong), null);
});

test('sign-in: past 10 tries an email answers 429 to wrong passwords, but the owner\'s right password still works', async () => {
  const s = setup();
  await s.register();
  for (let i = 0; i < 10; i++) assert.equal((await s.login('learner@example.com', `guess number ${i}!`)).status, 401);
  const limited = await s.login('learner@example.com', 'one more guess here');
  assert.equal(limited.status, 429);
  assert.ok(Number(limited.headers.get('Retry-After')) > 0);
  assert.equal((await s.login()).status, 200);
});

test('an unverified address held for over 24 hours gives way to a new sign-up, and no longer signs in', async () => {
  const s = setup();
  await s.register();
  s.advance(DAY - 1000);
  assert.equal((await s.register({ displayName: 'Someone Else' })).status, 409, 'still held within 24 hours');
  s.advance(2000);
  const second = await s.register({ displayName: 'Inbox Owner', password: 'a different long passphrase' }, { 'CF-Connecting-IP': '198.51.100.7' });
  assert.equal(second.status, 201);
  assert.equal((await s.login()).status, 401, 'the first password no longer opens the address');
  assert.equal((await s.login('learner@example.com', 'a different long passphrase')).status, 200);
});

test('routes: only the app\'s own pages may call them, wrong methods get 405, and the pepper is required', async () => {
  const s = setup();
  const cross = await s.register({}, { Origin: 'https://evil.example' });
  assert.equal(cross.status, 403);
  assert.equal((await cross.json()).error, 'forbidden_origin');
  assert.equal(count(s.db, 'users'), 0);

  assert.equal((await s.call('GET', '/api/auth/email/login')).status, 405);

  const noPepper = setup({ RATE_LIMIT_PEPPER: undefined });
  const res = await noPepper.register();
  assert.equal(res.status, 503);
  assert.equal((await res.json()).error, 'not_configured');
});

test('sign-up: five per hour from one address, then 429', async () => {
  const s = setup();
  for (let i = 0; i < 5; i++) assert.equal((await s.register({ email: `learner${i}@example.com` })).status, 201);
  assert.equal((await s.register({ email: 'learner9@example.com' })).status, 429);
});
