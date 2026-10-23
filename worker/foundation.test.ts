// The account foundation on its own: the migrations on top of 0001 (with existing GitHub data), and the
// password, session, one-time token, rate-limit and request helpers the sign-in routes will build on.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { ipSubject, originAllowed, readCookie, safeReturn, sha256, type ApiEnv, type Db, type DbStatement } from './http.ts';
import { hashPassword, passwordProblem, verifyPassword, PBKDF2_ITERATIONS } from './password.ts';
import {
  DAY, SESSION_COOKIE, SESSION_MAX_AGE, SESSION_TTL, createSession, currentSession, endAllSessions, renewedExpiry, sessionAlive,
} from './session.ts';
import { consumeToken, issueToken, peekToken, tokenFailure, TOKEN_TTL } from './tokens.ts';
import { LIMITS, enforceLimit, forgetLimits, limitKey, sweepRateLimits } from './ratelimit.ts';
import { sweepExpired } from './maintenance.ts';

const MIGRATIONS = ['0001_accounts.sql', '0002_accounts_email.sql', '0003_security.sql', '0004_token_email.sql'];
const migration = (name: string) => readFileSync(new URL(`../migrations/${name}`, import.meta.url), 'utf8');

/** D1's prepare/bind/first/all/run on top of Node's built-in SQLite */
function testDb(upTo = MIGRATIONS.length): Db & { raw: DatabaseSync } {
  const raw = new DatabaseSync(':memory:');
  raw.exec('PRAGMA foreign_keys = ON;');
  for (const name of MIGRATIONS.slice(0, upTo)) raw.exec(migration(name));
  const statement = (sql: string, values: unknown[] = []): DbStatement => ({
    bind: (...v) => statement(sql, v),
    first: async <T,>() => (raw.prepare(sql).get(...(values as never[])) as T | undefined) ?? null,
    all: async <T,>() => ({ results: raw.prepare(sql).all(...(values as never[])) as T[] }),
    run: async () => raw.prepare(sql).run(...(values as never[])),
  });
  return { raw, prepare: sql => statement(sql) };
}

const NOW = Date.UTC(2026, 9, 22);
const addUser = (db: { raw: DatabaseSync }, id = 'u1', createdAt = NOW) =>
  db.raw.prepare('INSERT INTO users (id, display_name, created_at) VALUES (?, ?, ?)').run(id, 'Learner', createdAt);
const withCookie = (token: string) => new Request('https://terminuscli.com/api/me', { headers: { Cookie: `${SESSION_COOKIE}=${token}` } });
const ctx = (db: Db, token: string, now = NOW) => ({ request: withCookie(token), env: { DB: db } as ApiEnv, deps: { fetch, now: () => now } });

// --- Migrations ------------------------------------------------------------------------------

test('migrations: 0002 and 0003 keep existing GitHub users, identities and sessions, and backfill the new columns', () => {
  const db = testDb(1);
  addUser(db, 'gh-user', NOW - 5 * DAY);
  db.raw.prepare("INSERT INTO identities (provider, provider_id, user_id, login) VALUES ('github', '42', 'gh-user', 'octo')").run();
  db.raw.prepare("INSERT INTO sessions (token_hash, user_id, expires_at, created_at) VALUES ('h', 'gh-user', ?, ?)").run(NOW + DAY, NOW - DAY);
  db.raw.exec(migration('0002_accounts_email.sql'));
  db.raw.exec(migration('0003_security.sql'));

  const user = db.raw.prepare('SELECT display_name, email, password_hash FROM users WHERE id = ?').get('gh-user');
  assert.deepEqual({ ...user }, { display_name: 'Learner', email: null, password_hash: null });
  const identity = db.raw.prepare('SELECT login, linked_at FROM identities').get();
  assert.deepEqual({ ...identity }, { login: 'octo', linked_at: NOW - 5 * DAY });
  const session = db.raw.prepare('SELECT authenticated_at FROM sessions').get();
  assert.equal(session?.authenticated_at, NOW - DAY, 'existing sessions count from their creation');
});

test('migrations: an email belongs to one account only', () => {
  const db = testDb();
  addUser(db, 'a');
  addUser(db, 'b');
  db.raw.prepare("UPDATE users SET email = 'x@example.com' WHERE id = 'a'").run();
  assert.throws(() => db.raw.prepare("UPDATE users SET email = 'x@example.com' WHERE id = 'b'").run(), /UNIQUE/);
  // Accounts without an email never clash
  db.raw.prepare("UPDATE users SET email = NULL WHERE id = 'a'").run();
});

// --- Passwords -------------------------------------------------------------------------------

test('passwords: PBKDF2 hash with a random salt, verified in constant time, never stored as typed', async () => {
  const stored = await hashPassword('correct horse battery staple');
  assert.match(stored, new RegExp(`^pbkdf2\\$sha256\\$${PBKDF2_ITERATIONS}\\$[A-Za-z0-9+/=]+\\$[A-Za-z0-9+/=]+$`));
  assert.ok(!stored.includes('correct horse'));
  assert.notEqual(await hashPassword('correct horse battery staple'), stored, 'a new salt each time');
  assert.equal(await verifyPassword('correct horse battery staple', stored), true);
  assert.equal(await verifyPassword('correct horse battery stapl', stored), false);
  assert.equal(await verifyPassword('anything', 'not-a-hash'), false);
});

test('passwords: too short, too long, common, the email, or containing the name or site are refused', () => {
  assert.equal(passwordProblem('short1', null)?.code, 'password_too_short');
  assert.equal(passwordProblem('x'.repeat(129), null)?.code, 'password_too_long');
  assert.equal(passwordProblem('1234567890', null)?.code, 'common_password');
  assert.equal(passwordProblem('Learner@Example.com', 'learner@example.com')?.code, 'password_equals_email');
  assert.equal(passwordProblem('learner-is-great-42', 'learner@example.com')?.code, 'password_contains_name');
  assert.equal(passwordProblem('my-terminus-pass-42', null)?.code, 'password_contains_name');
  assert.equal(passwordProblem('i am Octo Learner now', null, 'Octo Learner')?.code, 'password_contains_name');
  assert.equal(passwordProblem('correct horse battery staple', 'learner@example.com', 'Octo Learner'), null);
});

// --- Sessions --------------------------------------------------------------------------------

test('sessions: only the SHA-256 of the token is stored, and the cookie finds the session', async () => {
  const db = testDb();
  addUser(db);
  const token = await createSession(db, 'u1', NOW);
  const row = db.raw.prepare('SELECT token_hash, expires_at, authenticated_at FROM sessions').get();
  assert.equal(row?.token_hash, await sha256(token));
  assert.equal(row?.expires_at, NOW + SESSION_TTL);
  assert.equal(row?.authenticated_at, NOW);
  const session = await currentSession(ctx(db, token));
  assert.equal(session?.userId, 'u1');
  assert.equal(await currentSession(ctx(db, 'not-a-real-token')), null);
});

test('sessions: expire after their TTL and after 90 days however often they are renewed', async () => {
  assert.equal(renewedExpiry(NOW, NOW + DAY), NOW + DAY + SESSION_TTL);
  assert.equal(renewedExpiry(NOW, NOW + 80 * DAY), NOW + SESSION_MAX_AGE, 'capped by the absolute lifetime');
  assert.equal(sessionAlive({ created_at: NOW, expires_at: NOW + SESSION_TTL }, NOW + SESSION_TTL), false);
  assert.equal(sessionAlive({ created_at: NOW, expires_at: NOW + 200 * DAY }, NOW + SESSION_MAX_AGE), false);

  const db = testDb();
  addUser(db);
  const token = await createSession(db, 'u1', NOW);
  assert.equal(await currentSession(ctx(db, token, NOW + SESSION_TTL)), null, 'unused for its whole TTL');
});

test('sessions: use slides the expiry forward with a matching cookie, up to the 90-day cap', async () => {
  const db = testDb();
  addUser(db);
  const token = await createSession(db, 'u1', NOW);
  const maxAge = (cookie?: string) => Number(/Max-Age=(\d+)/.exec(cookie ?? '')?.[1]);

  // Plenty of time left: nothing changes, no cookie to send
  const early = await currentSession(ctx(db, token, NOW + 5 * DAY));
  assert.equal(early?.expiresAt, NOW + SESSION_TTL);
  assert.equal(early?.renewedCookie, undefined);

  // Under RENEW_BELOW left: renewed to a full TTL from now, cookie Max-Age to match
  const at = NOW + 20 * DAY;
  const renewed = await currentSession(ctx(db, token, at));
  assert.equal(renewed?.expiresAt, at + SESSION_TTL);
  assert.equal(maxAge(renewed?.renewedCookie), SESSION_TTL / 1000);
  assert.match(renewed?.renewedCookie ?? '', /^__Host-session=[^;]+; Path=\/; Max-Age=\d+; HttpOnly; Secure; SameSite=Lax$/);
  assert.equal(db.raw.prepare('SELECT expires_at FROM sessions').get()?.expires_at, at + SESSION_TTL);

  // Used every 10 days it stays signed in, but never past 90 days from sign-in
  const cookies: { day: number; cookie: string }[] = [];
  let last;
  for (let day = 30; day < 90; day += 10) {
    last = await currentSession(ctx(db, token, NOW + day * DAY));
    if (last?.renewedCookie) cookies.push({ day, cookie: last.renewedCookie });
  }
  assert.equal(last?.expiresAt, NOW + SESSION_MAX_AGE);
  // The last renewal reached the cap; its cookie lasts exactly until then, and nothing renews past it
  const final = cookies.at(-1)!;
  assert.equal(maxAge(final.cookie) * 1000, SESSION_MAX_AGE - final.day * DAY);
  assert.equal(last?.renewedCookie, undefined);
  assert.ok(await currentSession(ctx(db, token, NOW + SESSION_MAX_AGE - 1)));
  assert.equal(await currentSession(ctx(db, token, NOW + SESSION_MAX_AGE)), null);
});

test('sessions: two renewals at once never move the expiry backward, and each cookie matches the row', async () => {
  const db = testDb();
  addUser(db);
  const token = await createSession(db, 'u1', NOW);
  // Request A reads the near-expiry row first, but its write is held until request B has renewed
  let release!: () => void;
  const gate = new Promise<void>(r => (release = r));
  let held!: () => void;
  const reachedGate = new Promise<void>(r => (held = r));
  const slowDb: Db = {
    prepare: sql => {
      const inner = db.prepare(sql);
      if (!sql.startsWith('UPDATE sessions')) return inner;
      const wrap = (st: DbStatement): DbStatement => ({
        ...st,
        bind: (...v) => wrap(st.bind(...v)),
        first: async <T,>() => { held(); await gate; return st.first<T>(); },
      });
      return wrap(inner);
    },
  };
  const maxAgeMs = (cookie?: string) => Number(/Max-Age=(\d+)/.exec(cookie ?? '')?.[1]) * 1000;
  const tA = NOW + 20 * DAY;
  const tB = NOW + 21 * DAY;
  const a = currentSession(ctx(slowDb, token, tA));
  await reachedGate;
  const b = await currentSession(ctx(db, token, tB));
  release();
  const sa = await a;

  const stored = db.raw.prepare('SELECT expires_at FROM sessions').get()?.expires_at;
  assert.equal(stored, tB + SESSION_TTL, 'the later expiry wins');
  assert.equal(b?.expiresAt, tB + SESSION_TTL);
  assert.equal(sa?.expiresAt, stored, 'the slower request reports what the row holds, not its own value');
  assert.equal(maxAgeMs(sa?.renewedCookie), (stored as number) - tA);
  assert.equal(maxAgeMs(b?.renewedCookie), (stored as number) - tB);
});

test('sessions: sign out everywhere ends every session of that user only', async () => {
  const db = testDb();
  addUser(db, 'u1');
  addUser(db, 'u2');
  const a = await createSession(db, 'u1', NOW);
  const b = await createSession(db, 'u1', NOW);
  const other = await createSession(db, 'u2', NOW);
  await endAllSessions(db, 'u1');
  assert.equal(await currentSession(ctx(db, a)), null);
  assert.equal(await currentSession(ctx(db, b)), null);
  assert.equal((await currentSession(ctx(db, other)))?.userId, 'u2');
});

// --- One-time tokens -------------------------------------------------------------------------

test('one-time tokens: stored hashed, work once, expire, and only the newest link works', async () => {
  const db = testDb();
  addUser(db);
  const first = await issueToken(db, 'u1', 'verify', NOW);
  const token = await issueToken(db, 'u1', 'verify', NOW);
  assert.equal(await peekToken(db, first, 'verify', NOW), null, 'an earlier link stops working');
  assert.ok(!JSON.stringify(db.raw.prepare('SELECT * FROM auth_tokens').all()).includes(token));

  assert.equal(await consumeToken(db, token, 'reset', NOW), null, 'the purpose must match');
  assert.equal(await peekToken(db, token, 'verify', NOW), 'u1');
  assert.equal(await consumeToken(db, token, 'verify', NOW), 'u1');
  assert.equal(await consumeToken(db, token, 'verify', NOW), null, 'single use');

  const reset = await issueToken(db, 'u1', 'reset', NOW);
  const later = NOW + TOKEN_TTL.reset;
  assert.equal(await consumeToken(db, reset, 'reset', later), null);
  assert.equal(await tokenFailure(db, reset, 'reset', later), 'token_expired');
  assert.equal(await tokenFailure(db, 'made-up', 'reset', later), 'invalid_token');
});

test('one-time tokens: two resends at once leave exactly one working link, whatever the interleaving', async () => {
  // Request A is held just before one of its statements while request B issues a link from start to end
  for (const holdAt of ['INSERT INTO auth_tokens', 'UPDATE auth_tokens SET used_at']) {
    const db = testDb();
    addUser(db);
    let release!: () => void;
    const gate = new Promise<void>(r => (release = r));
    let held!: () => void;
    const reachedGate = new Promise<void>(r => (held = r));
    let holding = true;
    const slowDb: Db = {
      prepare: sql => {
        const inner = db.prepare(sql);
        if (!sql.startsWith(holdAt) || !holding) return inner;
        holding = false;
        const wrap = (st: DbStatement): DbStatement => ({
          ...st,
          bind: (...v) => wrap(st.bind(...v)),
          run: async () => { held(); await gate; return st.run(); },
          first: async <T,>() => { held(); await gate; return st.first<T>(); },
        });
        return wrap(inner);
      },
    };
    const a = issueToken(slowDb, 'u1', 'verify', NOW);
    await reachedGate;
    const tokenB = await issueToken(db, 'u1', 'verify', NOW);
    release();
    const tokenA = await a;
    const working = [tokenA, tokenB].filter(t => t);
    const results = await Promise.all(working.map(t => peekToken(db, t, 'verify', NOW)));
    assert.equal(results.filter(Boolean).length, 1, `held at ${holdAt}: exactly one link works`);
    const used = await Promise.all([tokenA, tokenB].map(t => consumeToken(db, t, 'verify', NOW)));
    assert.equal(used.filter(Boolean).length, 1, `held at ${holdAt}: exactly one link can be used`);
  }
});

// --- Rate limits -----------------------------------------------------------------------------

test('rate limits: 429 with Retry-After once over the maximum, and a new window starts fresh', async () => {
  const db = testDb();
  const env = { DB: db, RATE_LIMIT_PEPPER: 'test-pepper' };
  const limit = LIMITS.registerIp; // 5 per hour
  const start = Date.UTC(2026, 9, 22, 10);
  for (let i = 0; i < limit.max; i++) await enforceLimit(env, limit, '203.0.113.9', start);
  await assert.rejects(enforceLimit(env, limit, '203.0.113.9', start + 1000), (err: { status: number; headers: Record<string, string> }) => {
    assert.equal(err.status, 429);
    assert.equal(err.headers['Retry-After'], String(Math.ceil((limit.windowMs - 1000) / 1000)));
    return true;
  });
  await enforceLimit(env, limit, '198.51.100.1', start); // another subject is unaffected
  await enforceLimit(env, limit, '203.0.113.9', start + limit.windowMs);
});

test('rate limits: without the pepper they refuse to run (503), unless plain keys are explicitly allowed', async () => {
  const db = testDb();
  await assert.rejects(enforceLimit({ DB: db }, LIMITS.loginIp, '203.0.113.9', NOW), (err: { status: number; code: string }) => {
    assert.equal(err.status, 503);
    assert.equal(err.code, 'not_configured');
    return true;
  });
  assert.equal(db.raw.prepare('SELECT COUNT(*) AS n FROM rate_limits').get()?.n, 0, 'nothing stored');

  await enforceLimit({ DB: db, ALLOW_UNPEPPERED_RATE_LIMITS: '1' }, LIMITS.loginIp, '203.0.113.9', NOW);
  assert.equal(db.raw.prepare('SELECT key FROM rate_limits').get()?.key, `login-ip:${await sha256('203.0.113.9')}`);
});

test('rate limits: keys never hold the email or address, and depend on the secret pepper', async () => {
  const db = testDb();
  const env = { DB: db, RATE_LIMIT_PEPPER: 'pepper-one' };
  await enforceLimit(env, LIMITS.loginEmail, 'learner@example.com', NOW);
  const keys = (db.raw.prepare('SELECT key FROM rate_limits').all() as { key: string }[]).map(r => r.key);
  assert.equal(keys.length, 1);
  assert.match(keys[0], /^login-email:[0-9a-f]{64}$/);
  assert.notEqual(keys[0], `login-email:${await sha256('learner@example.com')}`, 'not a plain hash anyone could recompute');
  assert.notEqual(await limitKey({ RATE_LIMIT_PEPPER: 'pepper-two' }, LIMITS.loginEmail, 'learner@example.com'), keys[0]);

  await forgetLimits(env, 'u1', 'learner@example.com');
  assert.equal(db.raw.prepare('SELECT COUNT(*) AS n FROM rate_limits').get()?.n, 0);
});

// --- Requests --------------------------------------------------------------------------------

test('requests: IPv6 is limited by its /64, IPv4-mapped counts as IPv4, X-Forwarded-For is ignored', () => {
  const req = (ip: string, extra: Record<string, string> = {}) => new Request('https://x.test/', { headers: { 'CF-Connecting-IP': ip, ...extra } });
  assert.equal(ipSubject(req('2001:db8:1:2:aaaa::1')), ipSubject(req('2001:db8:1:2:bbbb::2')));
  assert.notEqual(ipSubject(req('2001:db8:1:2::1')), ipSubject(req('2001:db8:1:3::1')));
  assert.equal(ipSubject(req('::ffff:203.0.113.9')), '203.0.113.9');
  assert.equal(ipSubject(req('203.0.113.9', { 'X-Forwarded-For': '198.51.100.1' })), '203.0.113.9');
});

test('requests: return paths stay inside the app, cookies are read by exact name, origins are allowlisted', () => {
  assert.equal(safeReturn('#/account/security'), '#/account/security');
  for (const bad of ['https://evil.example', '//evil.example', '#/../x', null]) assert.equal(safeReturn(bad), '#/learn');
  const r = new Request('https://x.test/', { headers: { Cookie: 'a=1; __Host-session=tok=en; b=2' } });
  assert.equal(readCookie(r, SESSION_COOKIE), 'tok=en');
  assert.equal(readCookie(r, 'session'), null);

  const env = { DB: testDb(), APP_ORIGINS: 'https://terminuscli.com' } as ApiEnv;
  const url = new URL('https://terminuscli.com/api/auth/email/login');
  assert.equal(originAllowed(env, url, 'https://terminuscli.com'), true);
  assert.equal(originAllowed(env, url, 'https://evil.example'), false);
});

// --- Daily sweep -----------------------------------------------------------------------------

test('daily sweep: removes ended sessions, expired tokens and finished rate-limit windows, keeps the rest', async () => {
  const db = testDb();
  addUser(db);
  const live = await createSession(db, 'u1', NOW);
  await createSession(db, 'u1', NOW - SESSION_MAX_AGE - DAY); // past its absolute lifetime
  await issueToken(db, 'u1', 'reset', NOW - 2 * TOKEN_TTL.reset);
  await enforceLimit({ DB: db, RATE_LIMIT_PEPPER: 'p' }, LIMITS.loginIp, '203.0.113.9', NOW - 2 * DAY);
  await sweepExpired(db, NOW);
  assert.equal(db.raw.prepare('SELECT COUNT(*) AS n FROM sessions').get()?.n, 1);
  assert.ok(await currentSession(ctx(db, live)));
  assert.equal(db.raw.prepare('SELECT COUNT(*) AS n FROM auth_tokens').get()?.n, 0);
  assert.equal(db.raw.prepare('SELECT COUNT(*) AS n FROM rate_limits').get()?.n, 0);
  await sweepRateLimits(db, NOW); // safe on an empty table
});
