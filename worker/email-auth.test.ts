import test from 'node:test';
import assert from 'node:assert/strict';
import { PASSWORD, cookieValue, register, setup, tokenFromEmail } from './testkit.ts';
import { COMMON_PASSWORDS } from './common-passwords.ts';
import { hashPassword, passwordProblem, verifyPassword } from './password.ts';

const HOUR = 60 * 60 * 1000;

test('register creates the account, signs in, stores a PBKDF2 hash and sends a verification link', async () => {
  const s = setup();
  const { res, session, user } = await register(s);
  assert.equal(res.status, 201);
  assert.match(res.headers.getSetCookie().find(c => c.startsWith('__Host-session='))!, /HttpOnly; Secure; SameSite=Lax/);
  assert.deepEqual(user, { id: user.id, name: 'Ada Learner', login: null, email: 'learner@example.com', emailVerified: false, avatarUrl: null });

  const row = s.db.raw.prepare('SELECT email, password_hash FROM users').get() as { email: string; password_hash: string };
  assert.equal(row.email, 'learner@example.com');
  assert.match(row.password_hash, /^pbkdf2\$sha256\$100000\$[A-Za-z0-9+/=]{24}\$[A-Za-z0-9+/=]{44}$/);
  assert.equal(s.count("SELECT count(*) AS n FROM identities WHERE provider = 'email'"), 1);

  const mail = s.services.emails[0];
  assert.deepEqual(mail.to, ['learner@example.com']);
  assert.equal(mail.from, 'Terminus <accounts@terminuscli.example>');
  assert.match(mail.text, /^https:\/\/terminalpractice\.example\.workers\.dev\/#\/account\/verify\?token=[A-Za-z0-9_-]{43}$/m);
  assert.match(mail.html, /#\/account\/verify\?token=/);
  // Only the hash of the token is stored
  const token = tokenFromEmail(s, 'verify');
  assert.equal(s.count('SELECT count(*) AS n FROM auth_tokens WHERE token_hash = ?', token), 0);

  const me = await (await s.call('GET', '/api/me', { session })).json();
  assert.equal(me.user.email, 'learner@example.com');
  assert.equal(me.providers.email, true);

  // The same address again (any case) is refused
  const again = await register(s, ' LEARNER@example.com ');
  assert.equal(again.res.status, 409);
});

test('register validates its input', async () => {
  const s = setup();
  const post = (json: unknown) => s.call('POST', '/api/auth/email/register', { json });
  const base = { email: 'new@example.com', password: PASSWORD, displayName: 'New', ageConfirmed: true };
  assert.equal((await (await post({ ...base, ageConfirmed: false })).json()).error, 'age_required');
  assert.equal((await (await post({ ...base, email: 'not-an-email' })).json()).error, 'invalid_email');
  assert.equal((await (await post({ ...base, displayName: '   ' })).json()).error, 'invalid_display_name');
  assert.equal((await (await post({ ...base, password: 42 })).json()).error, 'invalid_request');
  assert.equal(s.count('SELECT count(*) AS n FROM users'), 0);
});

test('password rules: 10 to 128 characters, not common, not the email', async () => {
  assert.equal(COMMON_PASSWORDS.length, 1000);
  assert.equal(new Set(COMMON_PASSWORDS).size, 1000);
  assert.equal(passwordProblem('short1234', null)!.code, 'password_too_short');
  assert.equal(passwordProblem('x'.repeat(129), null)!.code, 'password_too_long');
  assert.equal(passwordProblem('x'.repeat(128), null), null);
  assert.equal(passwordProblem('password123', null)!.code, 'common_password');
  assert.equal(passwordProblem('QwertyUiop', null)!.code, 'common_password');
  assert.equal(passwordProblem('Learner@Example.com', 'learner@example.com')!.code, 'password_equals_email');
  assert.equal(passwordProblem('correct horse battery staple', 'learner@example.com'), null);

  const s = setup();
  for (const [password, code, why] of [
    ['short', 'password_too_short', /at least 10/],
    ['1234567890', 'common_password', /common/],
    ['iloveyou123', 'common_password', /common/],
    ['someone@example.com', 'password_equals_email', /email/],
  ] as const) {
    const res = await s.call('POST', '/api/auth/email/register', {
      json: { email: 'someone@example.com', password, displayName: 'S', ageConfirmed: true },
    });
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.equal(body.error, code);
    assert.match(body.message, why);
  }
});

test('hashes verify, and malformed or over-strong hashes are refused', async () => {
  const hash = await hashPassword('a fine passphrase');
  assert.equal(await verifyPassword('a fine passphrase', hash), true);
  assert.equal(await verifyPassword('a fine passphrasf', hash), false);
  assert.equal(await verifyPassword('x', 'garbage'), false);
  assert.equal(await verifyPassword('x', hash.replace('$100000$', '$900000$')), false);
  assert.notEqual(await hashPassword('a fine passphrase'), hash);
});

test('login: right password signs in with a new session; wrong password and unknown email get the same answer', async () => {
  const s = setup();
  const { session: first } = await register(s);
  const ok = await s.call('POST', '/api/auth/email/login', { json: { email: ' Learner@EXAMPLE.com', password: PASSWORD } });
  assert.equal(ok.status, 200);
  const second = cookieValue(ok, '__Host-session')!;
  assert.ok(second && second !== first);
  assert.equal((await ok.json()).user.email, 'learner@example.com');

  const wrong = await s.call('POST', '/api/auth/email/login', { json: { email: 'learner@example.com', password: 'not the password' } });
  const unknown = await s.call('POST', '/api/auth/email/login', { json: { email: 'nobody@example.com', password: 'not the password' } });
  assert.equal(wrong.status, 401);
  assert.equal(unknown.status, 401);
  const [a, b] = [await wrong.json(), await unknown.json()];
  assert.deepEqual(a, b);
  assert.equal(a.error, 'invalid_credentials');
  assert.equal(cookieValue(wrong, '__Host-session'), undefined);

  // A GitHub-only user has no password: same answer again
  const malformed = await s.call('POST', '/api/auth/email/login', { json: { email: 'nonsense', password: 'x' } });
  assert.deepEqual(await malformed.json(), a);
});

test('verify tokens are single use and expire after 24 hours', async () => {
  const s = setup();
  const { session } = await register(s);
  const token = tokenFromEmail(s, 'verify');
  const res = await s.call('POST', '/api/auth/email/verify', { json: { token } });
  assert.equal(res.status, 200);
  assert.equal((await res.json()).user.emailVerified, true);
  const reuse = await s.call('POST', '/api/auth/email/verify', { json: { token } });
  assert.equal(reuse.status, 400);
  assert.equal((await reuse.json()).error, 'invalid_token');

  // A second account: its link is too old after 24 h
  const other = setup();
  await register(other);
  const late = tokenFromEmail(other, 'verify');
  other.advance(24 * HOUR + 1);
  const expired = await other.call('POST', '/api/auth/email/verify', { json: { token: late } });
  assert.equal(expired.status, 400);
  assert.equal((await expired.json()).error, 'token_expired');

  // Resending gives a new link and retires the old one
  const fresh = setup();
  const { session: fs } = await register(fresh);
  const old = tokenFromEmail(fresh, 'verify');
  assert.equal((await fresh.call('POST', '/api/auth/email/resend-verification', { session: fs })).status, 202);
  const newer = tokenFromEmail(fresh, 'verify');
  assert.notEqual(newer, old);
  assert.equal((await fresh.call('POST', '/api/auth/email/verify', { json: { token: old } })).status, 400);
  assert.equal((await fresh.call('POST', '/api/auth/email/verify', { json: { token: newer } })).status, 200);

  // Resend needs a session; when already verified it sends nothing
  assert.equal((await s.call('POST', '/api/auth/email/resend-verification')).status, 401);
  const sent = s.services.emails.length;
  assert.equal((await s.call('POST', '/api/auth/email/resend-verification', { session })).status, 202);
  assert.equal(s.services.emails.length, sent);
});

test('forgot password always answers 202 and only mails existing accounts', async () => {
  const s = setup();
  await register(s);
  const before = s.services.emails.length;
  const known = await s.call('POST', '/api/auth/password/forgot', { json: { email: 'learner@example.com' } });
  const unknown = await s.call('POST', '/api/auth/password/forgot', { json: { email: 'nobody@example.com' } });
  const invalid = await s.call('POST', '/api/auth/password/forgot', { json: { email: 'nonsense' } });
  for (const r of [known, unknown, invalid]) assert.equal(r.status, 202);
  assert.deepEqual(await known.json(), await unknown.json());
  assert.equal(s.services.emails.length, before + 1);
  assert.match(s.services.emails.at(-1)!.text, /#\/account\/reset\?token=/);
});

test('forgot password runs its lookup after the answer when waitUntil is available', async () => {
  const s = setup();
  await register(s);
  const pending: Promise<unknown>[] = [];
  s.deps.waitUntil = p => pending.push(p);
  const before = s.services.emails.length;
  assert.equal((await s.call('POST', '/api/auth/password/forgot', { json: { email: 'learner@example.com' } })).status, 202);
  assert.equal(s.services.emails.length, before);
  await Promise.all(pending);
  assert.equal(s.services.emails.length, before + 1);
});

test('reset: single use, expires after an hour, ends all other sessions, and verifies the email', async () => {
  const s = setup();
  const { session: a } = await register(s);
  const b = cookieValue(await s.call('POST', '/api/auth/email/login', { json: { email: 'learner@example.com', password: PASSWORD } }), '__Host-session')!;
  await s.call('POST', '/api/auth/password/forgot', { json: { email: 'learner@example.com' } });
  const token = tokenFromEmail(s, 'reset');

  // A refused password does not use up the link
  const weak = await s.call('POST', '/api/auth/password/reset', { json: { token, password: 'password123' } });
  assert.equal((await weak.json()).error, 'common_password');

  const res = await s.call('POST', '/api/auth/password/reset', { json: { token, password: 'a brand new passphrase' } });
  assert.equal(res.status, 200);
  const fresh = cookieValue(res, '__Host-session')!;
  assert.ok(fresh);
  assert.equal((await res.json()).user.emailVerified, true);
  for (const old of [a, b]) assert.equal((await (await s.call('GET', '/api/me', { session: old })).json()).user, null);
  assert.ok((await (await s.call('GET', '/api/me', { session: fresh })).json()).user);
  assert.equal(s.count('SELECT count(*) AS n FROM sessions'), 1);

  // Used once only, and the old password is gone
  assert.equal((await s.call('POST', '/api/auth/password/reset', { json: { token, password: 'another new passphrase' } })).status, 400);
  assert.equal((await s.call('POST', '/api/auth/email/login', { json: { email: 'learner@example.com', password: PASSWORD } })).status, 401);
  assert.equal((await s.call('POST', '/api/auth/email/login', { json: { email: 'learner@example.com', password: 'a brand new passphrase' } })).status, 200);

  // Expiry
  s.advance(2 * HOUR); // leave the forgot-password window
  await s.call('POST', '/api/auth/password/forgot', { json: { email: 'learner@example.com' } });
  const late = tokenFromEmail(s, 'reset');
  s.advance(HOUR + 1);
  const expired = await s.call('POST', '/api/auth/password/reset', { json: { token: late, password: 'yet another passphrase' } });
  assert.equal(expired.status, 400);
  assert.equal((await expired.json()).error, 'token_expired');
  // A verify token is not a reset token
  assert.equal((await s.call('POST', '/api/auth/password/reset', { json: { token: 'x'.repeat(43), password: 'yet another passphrase' } })).status, 400);
});

test('rate limits answer 429 with Retry-After', async () => {
  const s = setup();
  await register(s);
  const login = (email: string, ip?: string) => s.call('POST', '/api/auth/email/login', { json: { email, password: 'wrong password!' }, ip });

  // 10 per 15 minutes per email (from any address)
  for (let i = 0; i < 10; i++) assert.equal((await login('learner@example.com', `198.51.100.${i}`)).status, 401);
  const limited = await login('learner@example.com', '198.51.100.99');
  assert.equal(limited.status, 429);
  assert.equal((await limited.json()).error, 'rate_limited');
  const retry = Number(limited.headers.get('Retry-After'));
  assert.ok(retry > 0 && retry <= 15 * 60);
  // A new window lets the learner try again
  s.advance(15 * 60 * 1000);
  assert.equal((await login('learner@example.com')).status, 401);

  // 30 per 15 minutes per IP address (any emails)
  const t = setup();
  for (let i = 0; i < 30; i++) assert.equal((await t.call('POST', '/api/auth/email/login', { json: { email: `u${i}@example.com`, password: 'x' } })).status, 401);
  assert.equal((await t.call('POST', '/api/auth/email/login', { json: { email: 'u99@example.com', password: 'x' } })).status, 429);

  // Sign-up: 5 per hour per IP
  const u = setup();
  for (let i = 0; i < 5; i++) assert.equal((await register(u, `p${i}@example.com`)).res.status, 201);
  assert.equal((await register(u, 'p5@example.com')).res.status, 429);
  assert.equal((await register(u, 'p5@example.com', PASSWORD, '192.0.2.1')).res.status, 201);

  // Forgot password: 3 per hour per email
  const v = setup();
  for (let i = 0; i < 3; i++) assert.equal((await v.call('POST', '/api/auth/password/forgot', { json: { email: 'x@example.com' } })).status, 202);
  assert.equal((await v.call('POST', '/api/auth/password/forgot', { json: { email: 'X@Example.com' } })).status, 429);
  // Limit keys never hold the email or IP in readable form
  const keys = (v.db.raw.prepare('SELECT key FROM rate_limits').all() as { key: string }[]).map(r => r.key).join(' ');
  assert.doesNotMatch(keys, /example\.com|203\.0\.113/);
});

test('state-changing requests from another origin are refused with 403', async () => {
  const s = setup();
  const { session } = await register(s);
  const evil = { origin: 'https://evil.example' };
  assert.equal((await s.call('POST', '/api/auth/email/login', { ...evil, json: { email: 'learner@example.com', password: PASSWORD } })).status, 403);
  assert.equal((await s.call('POST', '/api/auth/email/register', { ...evil, json: {} })).status, 403);
  assert.equal((await s.call('POST', '/api/account/logout-all', { ...evil, session })).status, 403);
  assert.equal((await s.call('PATCH', '/api/account', { ...evil, session, json: { displayName: 'Hacked' } })).status, 403);
  assert.equal((await s.call('DELETE', '/api/account', { origin: null, session, json: { confirm: 'delete' } })).status, 403);
  const res = await s.call('POST', '/api/auth/password/forgot', { ...evil, json: { email: 'learner@example.com' } });
  assert.equal((await res.json()).error, 'forbidden_origin');
  assert.equal(s.count('SELECT count(*) AS n FROM users'), 1);
});

test('bodies must be JSON and at most 64 KB', async () => {
  const s = setup();
  const big = { email: 'a@example.com', password: PASSWORD, displayName: 'A', ageConfirmed: true, pad: 'x'.repeat(70 * 1024) };
  const declared = await s.call('POST', '/api/auth/email/register', { json: big });
  assert.equal(declared.status, 413);
  assert.equal((await declared.json()).error, 'payload_too_large');

  // Without a Content-Length (a streamed body), the cap still holds
  const { handleApi } = await import('./api.ts');
  const stream = new ReadableStream({
    start(controller) {
      for (let i = 0; i < 80; i++) controller.enqueue(new TextEncoder().encode('x'.repeat(1024)));
      controller.close();
    },
  });
  const streamed = await handleApi(
    new Request(`https://terminalpractice.example.workers.dev/api/auth/email/login`, {
      method: 'POST',
      headers: { Origin: 'https://terminalpractice.example.workers.dev', 'Content-Type': 'application/json' },
      body: stream,
      duplex: 'half',
    } as RequestInit),
    s.env,
    s.deps,
  );
  assert.equal(streamed!.status, 413);

  const form = await s.call('POST', '/api/auth/email/login', { headers: { 'Content-Type': 'text/plain' }, json: { email: 'a@example.com', password: 'x' } });
  assert.equal(form.status, 415);
  const broken = await s.call('POST', '/api/auth/email/login', { headers: { 'Content-Type': 'application/json' }, json: undefined });
  assert.equal(broken.status, 400);
  assert.equal(s.count('SELECT count(*) AS n FROM users'), 0);
});

test('without Resend configured, accounts work and nothing is sent', async () => {
  const s = setup({ RESEND_API_KEY: undefined });
  const { res } = await register(s);
  assert.equal(res.status, 201);
  assert.equal(s.services.emails.length, 0);
  assert.equal(s.services.calls.length, 0);
  assert.equal((await (await s.call('GET', '/api/me')).json()).emailSending, false);

  // Resend refusing a message does not fail the request
  const t = setup();
  t.services.state.resendStatus = 422;
  assert.equal((await register(t)).res.status, 201);
});
