// Regression tests for the security review (SEC-1 ... SEC-14 and the API response headers).
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { ORIGIN, PASSWORD, cookieValue, oauth, register, registerVerified, setup, tokenFromEmail, verifyEmail, type Setup } from './testkit.ts';
import { expandIpv6, ipSubject, json, noContent, text } from './http.ts';
import { normalizeEmail } from './auth/email.ts';
import { COMMON_PASSWORDS } from './common-passwords.ts';
import { passwordProblem } from './password.ts';
import { sweepExpired } from './maintenance.ts';
import { DAY } from './session.ts';

const MIN = 60 * 1000;
const item = { kind: 'objective', key: 'mod1/obj1', epoch: 0, earnedAt: 1 };
const errorOf = async (res: Response) => ((await res.json()) as { error: string }).error;
const forgotAndReset = async (s: Setup, email: string, password: string) => {
  await s.call('POST', '/api/auth/password/forgot', { json: { email } });
  return s.call('POST', '/api/auth/password/reset', { json: { token: tokenFromEmail(s, 'reset'), password } });
};

// --- SEC-1: pre-account takeover -----------------------------------------------------------

test('SEC-1: an account with an unverified email cannot link GitHub or Google', async () => {
  const s = setup();
  const atk = await register(s, 'victim@example.com', 'attacker-pass-123456');
  for (const provider of ['github', 'google'] as const) {
    const res = await oauth(s, provider, { session: atk.session, link: true, returnTo: '#/account/security' });
    assert.equal(res.start.status, 302);
    assert.equal(res.start.headers.get('Location'), `${ORIGIN}/#/account/security?error=email_unverified`);
  }
  assert.equal(s.count("SELECT count(*) AS n FROM identities WHERE provider <> 'email'"), 0);
  // Once verified, linking works
  assert.equal((await verifyEmail(s)).status, 200);
  const ok = await oauth(s, 'github', { session: atk.session, link: true, returnTo: '#/account/security' });
  assert.equal(ok.cb.headers.get('Location'), `${ORIGIN}/#/account/security`);
});

test('SEC-1: a password cannot be set through /api/account/email for an unverified address', async () => {
  const s = setup();
  const g = await oauth(s, 'github');
  const res = await s.call('POST', '/api/account/email', { session: g.session, json: { email: 'victim2@example.com', password: 'attacker-pass-123456' } });
  assert.equal(res.status, 409);
  assert.equal(await errorOf(res), 'email_unverified');
  assert.equal(s.count('SELECT count(*) AS n FROM users WHERE email IS NOT NULL OR password_hash IS NOT NULL'), 0);
  // Without a password the address is added (unverified); a password can follow once it is verified
  assert.equal((await s.call('POST', '/api/account/email', { session: g.session, json: { email: 'mine@example.com' } })).status, 202);
  const again = await s.call('POST', '/api/account/email', { session: g.session, json: { email: 'mine@example.com', password: 'my-own-pass-123456' } });
  assert.equal(await errorOf(again), 'email_unverified');
  await verifyEmail(s);
  assert.equal((await s.call('POST', '/api/account/email', { session: g.session, json: { email: 'mine@example.com', password: 'my-own-pass-123456' } })).status, 202);
  assert.equal((await s.call('POST', '/api/auth/email/login', { json: { email: 'mine@example.com', password: 'my-own-pass-123456' } })).status, 200);
});

test('SEC-1: resetting an unverified account removes what the claimant attached (probe1 P1)', async () => {
  const s = setup();
  const atk = await register(s, 'victim@example.com', 'attacker-pass-123456');
  // An identity attached before the fix (or by any other route) while the address was unverified
  s.db.raw
    .prepare("INSERT INTO identities (provider, provider_id, user_id, login, linked_at) VALUES ('github', '4242', ?, 'octo-learner', 1)")
    .run(atk.user.id);
  await s.call('PUT', '/api/progress', { session: atk.session, json: { items: [item], settings: { theme: { value: 'dark', updatedAt: 5 } } } });
  await s.call('POST', '/api/progress/reset', { session: atk.session, json: { scope: 'lab:other' } });

  assert.equal((await register(s, 'victim@example.com', 'owner-pass-abcdefg')).res.status, 409);
  const r = await forgotAndReset(s, 'victim@example.com', 'owner-pass-abcdefg');
  assert.equal(r.status, 200);
  const victim = ((await r.json()) as { user: { id: string; emailVerified: boolean } }).user;
  assert.equal(victim.emailVerified, true);
  assert.deepEqual(
    (s.db.raw.prepare('SELECT provider FROM identities WHERE user_id = ?').all(victim.id) as { provider: string }[]).map(x => x.provider),
    ['email'],
  );
  for (const t of ['progress_items', 'progress_epochs', 'user_settings']) assert.equal(s.count(`SELECT count(*) AS n FROM ${t}`), 0, t);
  assert.equal(s.count('SELECT count(*) AS n FROM sessions'), 1); // only the victim's new session
  assert.equal((await s.call('GET', '/api/progress', { session: atk.session })).status, 401);

  // The victim syncs; the attacker's GitHub sign-in is a brand-new, empty account
  const victimSession = cookieValue(r, '__Host-session');
  await s.call('PUT', '/api/progress', { session: victimSession, json: { items: [item] } });
  const back = await oauth(s, 'github');
  const me = (await (await s.call('GET', '/api/me', { session: back.session })).json()) as { user: { id: string; email: string | null } };
  assert.notEqual(me.user.id, victim.id);
  assert.equal(me.user.email, null);
  const prog = (await (await s.call('GET', '/api/progress', { session: back.session })).json()) as { items: unknown[] };
  assert.equal(prog.items.length, 0);
});

test('SEC-1: resetting a verified account keeps its linked methods and data', async () => {
  const s = setup();
  const { session, user } = await registerVerified(s);
  await oauth(s, 'github', { session, link: true });
  await s.call('PUT', '/api/progress', { session, json: { items: [item] } });
  assert.equal((await forgotAndReset(s, 'learner@example.com', 'a-new-long-passphrase')).status, 200);
  assert.equal(s.count("SELECT count(*) AS n FROM identities WHERE user_id = ? AND provider = 'github'", user.id), 1);
  assert.equal(s.count('SELECT count(*) AS n FROM progress_items WHERE user_id = ?', user.id), 1);
});

// --- SEC-2: unverified claims expire -------------------------------------------------------

test('SEC-2: an unverified address is released 24 hours after it was set', async () => {
  const s = setup();
  const g = await oauth(s, 'github');
  assert.equal((await s.call('POST', '/api/account/email', { session: g.session, json: { email: 'victim2@example.com' } })).status, 202);
  const setAt = (s.db.raw.prepare('SELECT email_set_at AS v FROM users').get() as { v: number }).v;
  assert.equal(setAt, s.now());
  assert.equal((await register(s, 'victim2@example.com', 'owner-pass-abcdefg')).res.status, 409);

  s.advance(DAY);
  const v = await register(s, 'victim2@example.com', 'owner-pass-abcdefg', '198.51.100.9');
  assert.equal(v.res.status, 201);
  const holder = s.db.raw.prepare('SELECT email, password_hash FROM users WHERE id <> ?').get(v.user.id) as Record<string, unknown>;
  assert.deepEqual({ ...holder }, { email: null, password_hash: null });
  assert.equal(s.count("SELECT count(*) AS n FROM identities WHERE provider = 'email'"), 1);
});

test('SEC-2: password sign-in with a lapsed unverified address is invalid_credentials', async () => {
  const s = setup();
  await register(s, 'slow@example.com');
  assert.equal((await s.call('POST', '/api/auth/email/login', { json: { email: 'slow@example.com', password: PASSWORD } })).status, 200);
  s.advance(DAY + MIN);
  const late = await s.call('POST', '/api/auth/email/login', { json: { email: 'slow@example.com', password: PASSWORD } });
  assert.equal(late.status, 401);
  assert.equal(await errorOf(late), 'invalid_credentials');
  // A verified address never lapses
  const t = setup();
  await registerVerified(t, 'quick@example.com');
  t.advance(400 * DAY);
  assert.equal((await t.call('POST', '/api/auth/email/login', { json: { email: 'quick@example.com', password: PASSWORD } })).status, 200);
  assert.equal((await register(t, 'quick@example.com', PASSWORD, '192.0.2.8')).res.status, 409);
});

test('SEC-2: another account adding a lapsed address takes it over and can verify it', async () => {
  const s = setup();
  const squatter = await register(s, 'held@example.com');
  const squatterToken = tokenFromEmail(s, 'verify');
  s.advance(DAY + MIN);
  const g = await oauth(s, 'github');
  assert.equal((await s.call('POST', '/api/account/email', { session: g.session, json: { email: 'held@example.com' } })).status, 202);
  assert.equal(s.count('SELECT count(*) AS n FROM users WHERE id = ? AND email IS NULL', squatter.user.id), 1);
  // The squatter's old link no longer works; the new holder's does
  assert.equal((await s.call('POST', '/api/auth/email/verify', { json: { token: squatterToken } })).status, 400);
  const v = await verifyEmail(s);
  assert.equal(v.status, 200);
  assert.equal(((await v.json()) as { user: { email: string } }).user.email, 'held@example.com');
});

// --- SEC-3: re-authentication --------------------------------------------------------------

test('SEC-3: authenticated_at is set at registration, sign-in, reset and OAuth sign-in', async () => {
  const s = setup();
  const authAt = (session: string) =>
    (s.db.raw.prepare('SELECT authenticated_at AS v FROM sessions WHERE token_hash = ?').get(createHash('sha256').update(session).digest('hex')) as { v: number }).v;
  const r = await register(s);
  assert.equal(authAt(r.session), s.now());
  s.advance(MIN);
  const l = await s.call('POST', '/api/auth/email/login', { json: { email: 'learner@example.com', password: PASSWORD } });
  assert.equal(authAt(cookieValue(l, '__Host-session')!), s.now());
  s.advance(MIN);
  const reset = await forgotAndReset(s, 'learner@example.com', 'another-long-passphrase');
  assert.equal(authAt(cookieValue(reset, '__Host-session')!), s.now());
  s.advance(MIN);
  const g = await oauth(s, 'google');
  assert.equal(authAt(g.session!), s.now());
});

test('SEC-3: without a password, sensitive actions need a sign-in within 10 minutes', async () => {
  const s = setup();
  const g = await oauth(s, 'google');
  s.advance(11 * MIN);
  const add = await s.call('POST', '/api/account/email', { session: g.session, json: { email: 'thief@evil.example' } });
  assert.equal(add.status, 403);
  assert.deepEqual(await add.json(), { providers: ['google'], error: 'reauth_required', message: 'Sign in again to confirm it is you, then retry.' });
  assert.equal(await errorOf(await s.call('DELETE', '/api/account', { session: g.session, json: { confirm: 'delete' } })), 'reauth_required');
  assert.equal(s.count('SELECT count(*) AS n FROM users'), 1);
  // POST /api/account/reauth is for passwords; an OAuth-only account is pointed at its providers
  const pw = await s.call('POST', '/api/account/reauth', { session: g.session, json: { currentPassword: 'whatever-it-is' } });
  assert.equal(pw.status, 403);
  assert.deepEqual(((await pw.json()) as { providers: string[] }).providers, ['google']);

  // ?reauth=1 with the same Google account refreshes the session's sign-in time
  const re = await oauth(s, 'google', { session: g.session, reauth: true, returnTo: '#/account/security' });
  assert.equal(re.location!.searchParams.get('prompt'), 'select_account');
  assert.equal(re.location!.searchParams.get('max_age'), '0');
  assert.equal(re.cb.headers.get('Location'), `${ORIGIN}/#/account/security`);
  assert.equal(re.session, undefined); // the same session continues
  assert.equal((await s.call('POST', '/api/account/email', { session: g.session, json: { email: 'me@example.com' } })).status, 202);
  assert.equal((await s.call('DELETE', '/api/account', { session: g.session, json: { confirm: 'delete' } })).status, 204);
});

test('SEC-3: OAuth reauth must be the same person, and needs that provider linked', async () => {
  const s = setup();
  const g = await oauth(s, 'google');
  s.services.state.google = { ...s.services.state.google, sub: 'someone-else' };
  const re = await oauth(s, 'google', { session: g.session, reauth: true, returnTo: '#/account' });
  assert.equal(re.cb.headers.get('Location'), `${ORIGIN}/#/account?error=reauth_mismatch`);
  assert.equal(s.count('SELECT count(*) AS n FROM users'), 1); // no account was created
  const gh = await oauth(s, 'github', { session: g.session, reauth: true, returnTo: '#/account' });
  assert.equal(gh.start.headers.get('Location'), `${ORIGIN}/#/account?error=not_linked`);
  assert.equal((await s.call('GET', '/api/auth/google/start?reauth=1')).status, 401);
});

test('SEC-3: with a password, sensitive actions need currentPassword; POST /api/account/reauth refreshes the sign-in time', async () => {
  const s = setup();
  const { session } = await registerVerified(s);
  // Delete: confirm plus the current password
  assert.equal(await errorOf(await s.call('DELETE', '/api/account', { session, json: { confirm: 'delete' } })), 'current_password_required');
  assert.equal(await errorOf(await s.call('DELETE', '/api/account', { session, json: { confirm: 'delete', currentPassword: 'not-the-password' } })), 'wrong_password');
  // Change email accepts currentPassword
  assert.equal((await s.call('POST', '/api/account/email', { session, json: { email: 'second@example.com', currentPassword: PASSWORD } })).status, 202);
  await verifyEmail(s);

  // Linking is a navigation, so it checks the sign-in time; reauth with the password refreshes it
  s.advance(11 * MIN);
  const stale = await oauth(s, 'github', { session, link: true, returnTo: '#/account/security' });
  assert.equal(stale.start.headers.get('Location'), `${ORIGIN}/#/account/security?error=reauth_required`);
  assert.equal(await errorOf(await s.call('POST', '/api/account/reauth', { session, json: {} })), 'current_password_required');
  assert.equal(await errorOf(await s.call('POST', '/api/account/reauth', { session, json: { currentPassword: 'nope-nope-nope' } })), 'wrong_password');
  const ok = await s.call('POST', '/api/account/reauth', { session, json: { currentPassword: PASSWORD } });
  assert.equal(ok.status, 200);
  assert.deepEqual(await ok.json(), { ok: true, authenticatedAt: s.now() });
  const linked = await oauth(s, 'github', { session, link: true, returnTo: '#/account/security' });
  assert.equal(linked.cb.headers.get('Location'), `${ORIGIN}/#/account/security`);
  // Unlinking needs the password too
  assert.equal(await errorOf(await s.call('DELETE', '/api/account/identities/github', { session })), 'current_password_required');
  assert.equal((await s.call('DELETE', '/api/account/identities/github', { session, json: { currentPassword: PASSWORD } })).status, 204);
  assert.equal((await s.call('DELETE', '/api/account', { session, json: { confirm: 'delete', currentPassword: PASSWORD } })).status, 204);
});

test('SEC-3: a stolen OAuth-only session cannot plant a password that survives logout-all (probe2 P6)', async () => {
  const s = setup();
  const v = await oauth(s, 'google');
  const ch = await s.call('POST', '/api/account/email', { session: v.session, json: { email: 'thief@evil.example', password: 'thief-password-99' } });
  assert.equal(ch.status, 409);
  await s.call('POST', '/api/account/logout-all', { session: v.session });
  assert.equal((await s.call('POST', '/api/auth/email/login', { json: { email: 'thief@evil.example', password: 'thief-password-99' } })).status, 401);
});

// --- SEC-4: targeted lockout ---------------------------------------------------------------

test('SEC-4: past the per-email limit a correct password still signs in; the hourly ceiling is hard', async () => {
  const s = setup();
  await register(s, 'target@example.com');
  const login = (password: string, ip: string) => s.call('POST', '/api/auth/email/login', { json: { email: 'target@example.com', password }, ip });
  for (let i = 0; i < 10; i++) assert.equal((await login(`wrong-wrong-${i}`, `198.51.100.${i}`)).status, 401);
  assert.equal((await login('wrong-again-x', '198.51.100.50')).status, 429);
  assert.equal((await login(PASSWORD, '192.0.2.55')).status, 200);
  // 50 per hour per email, whatever the password
  for (let i = 0; i < 38; i++) await login(`wrong-wrong-${i}`, `198.51.101.${i}`);
  const capped = await login(PASSWORD, '192.0.2.56');
  assert.equal(capped.status, 429);
  assert.ok(Number(capped.headers.get('Retry-After')) > 0);
  // The per-IP limit still holds for a correct password
  const t = setup();
  await register(t, 'ip@example.com');
  for (let i = 0; i < 30; i++) await t.call('POST', '/api/auth/email/login', { json: { email: `u${i}@example.com`, password: 'x' }, ip: '192.0.2.77' });
  assert.equal((await t.call('POST', '/api/auth/email/login', { json: { email: 'ip@example.com', password: PASSWORD }, ip: '192.0.2.77' })).status, 429);
});

// --- SEC-5: IPv6 /64 -----------------------------------------------------------------------

test('SEC-5: IPv6 is limited per /64, IPv4 per address, and only CF-Connecting-IP counts', async () => {
  const s = setup();
  const statuses: number[] = [];
  for (let i = 0; i < 6; i++) statuses.push((await register(s, `bulk${i}@example.com`, PASSWORD, `2001:db8:1:2::${i + 1}`)).res.status);
  assert.deepEqual(statuses, [201, 201, 201, 201, 201, 429]);
  assert.equal((await register(s, 'other64@example.com', PASSWORD, '2001:db8:1:3::1')).res.status, 201);
  assert.equal((await register(s, 'v4@example.com', PASSWORD, '192.0.2.10')).res.status, 201);
  assert.equal((await register(s, 'v4b@example.com', PASSWORD, '192.0.2.11')).res.status, 201);
  const xff = await s.call('POST', '/api/auth/email/register', {
    json: { email: 'xff@example.com', password: PASSWORD, displayName: 'x', ageConfirmed: true },
    ip: '2001:db8:1:2::99',
    headers: { 'X-Forwarded-For': '1.2.3.4', 'X-Real-IP': '1.2.3.4' },
  });
  assert.equal(xff.status, 429);

  const req = (ip: string) => new Request(ORIGIN, { headers: { 'CF-Connecting-IP': ip } });
  assert.equal(ipSubject(req('2001:DB8:1:2:aaaa:bbbb:cccc:dddd')), '2001:db8:1:2::/64');
  assert.equal(ipSubject(req('2001:db8::1')), '2001:db8:0:0::/64');
  assert.equal(ipSubject(req('::ffff:192.0.2.1')), '192.0.2.1');
  assert.equal(ipSubject(req('203.0.113.7')), '203.0.113.7');
  assert.deepEqual(expandIpv6('::1'), [0, 0, 0, 0, 0, 0, 0, 1]);
  assert.equal(expandIpv6('1::2::3'), null);
  assert.equal(expandIpv6('12345::1'), null);
});

// --- SEC-7: email validation ---------------------------------------------------------------

test('SEC-7: emails are NFC-normalized, lowercased, strict ASCII locals, punycode domains', () => {
  for (const bad of [
    'victim@example.com,attacker@evil.example',
    'x<attacker@evil.example>',
    '"a"@b.c',
    'a@b.c>',
    'café@example.com',
    'cafe\u0301@example.com',
    'a@b.c\u200b',
    'a\u202e@b.c',
    'a@b',
    'a@@b.c',
    'a b@c.d',
    'a@b..c',
    '.a@b.c',
    'a@-b.c',
    'a@b.c/x',
    'a@1.2.3.4',
    'a@[127.0.0.1]',
    'a;b@c.d',
    'a\\b@c.d',
  ]) {
    assert.equal(normalizeEmail(bad), null, JSON.stringify(bad));
  }
  assert.equal(normalizeEmail('  Learner@Example.COM '), 'learner@example.com');
  assert.equal(normalizeEmail("o'brien+tag@example.co.uk"), "o'brien+tag@example.co.uk");
  assert.equal(normalizeEmail('a@xn--80ak6aa92e.com'), 'a@xn--80ak6aa92e.com');
  assert.equal(normalizeEmail('a@bücher.example'), 'a@xn--bcher-kva.example');
  // NFC and NFD spellings of a domain are one address
  assert.equal(normalizeEmail('a@bu\u0308cher.example'), 'a@xn--bcher-kva.example');
});

test('SEC-7: register refuses the review\'s lookalike addresses', async () => {
  const s = setup();
  for (const [i, e] of ['x<attacker@evil.example>', '"a"@b.c', 'a@b.c>', 'café@example.com', 'a@b.c\u200b'].entries()) {
    const r = await register(s, e, PASSWORD, `198.51.100.${100 + i}`);
    assert.equal(r.res.status, 400, e);
  }
  assert.equal(s.services.emails.length, 0);
});

// --- SEC-8: password rules -----------------------------------------------------------------

test('SEC-8: the common list holds about 1000 passwords that the length rule allows', () => {
  assert.ok(COMMON_PASSWORDS.length >= 950 && COMMON_PASSWORDS.length <= 1100, String(COMMON_PASSWORDS.length));
  assert.ok(COMMON_PASSWORDS.every(p => [...p].length >= 10 && p === p.toLowerCase()));
  assert.equal(new Set(COMMON_PASSWORDS).size, COMMON_PASSWORDS.length);
  for (const p of ['password123', 'qwertyuiop', '1q2w3e4r5t', 'iloveyou123', 'Welcome2024']) assert.equal(passwordProblem(p, null)?.code, 'common_password', p);
});

test('SEC-8: passwords may not contain the site name, the display name or the email local part', async () => {
  assert.equal(passwordProblem('my Terminus pass 9', null)?.code, 'password_contains_name');
  assert.equal(passwordProblem('certsim-is-great', null)?.code, 'password_contains_name');
  assert.equal(passwordProblem('hello-adalearner-1', 'x@example.com', 'Ada Learner')?.code, 'password_contains_name');
  assert.equal(passwordProblem('i am ada learner!', 'x@example.com', 'Ada Learner')?.code, 'password_contains_name');
  assert.equal(passwordProblem('zz-grace.hopper-zz', 'grace.hopper@example.com', 'G')?.code, 'password_contains_name');
  assert.equal(passwordProblem(PASSWORD, 'learner@example.com', 'Ada Learner'), null);
  const s = setup();
  const res = await s.call('POST', '/api/auth/email/register', {
    json: { email: 'zed@example.com', password: 'Grace Hopper rocks', displayName: 'Grace Hopper', ageConfirmed: true },
  });
  assert.equal(res.status, 400);
  assert.equal(await errorOf(res), 'password_contains_name');
});

// --- SEC-9: sessions -----------------------------------------------------------------------

test('SEC-9: a sign-in ends the session the browser already had', async () => {
  const s = setup();
  const a = await registerVerified(s);
  const g = await oauth(s, 'github', { session: a.session });
  assert.ok(g.session);
  assert.equal((await s.call('GET', '/api/progress', { session: a.session })).status, 401);
  const l = await s.call('POST', '/api/auth/email/login', { json: { email: 'learner@example.com', password: PASSWORD }, session: g.session });
  assert.equal(l.status, 200);
  assert.equal((await s.call('GET', '/api/progress', { session: g.session })).status, 401);
  const r = await register(s, 'second@example.com', PASSWORD);
  void r;
  const r2 = await s.call('POST', '/api/auth/email/register', {
    json: { email: 'third@example.com', password: PASSWORD, displayName: 'Third', ageConfirmed: true },
    session: cookieValue(l, '__Host-session'),
    ip: '192.0.2.200',
  });
  assert.equal(r2.status, 201);
  assert.equal((await s.call('GET', '/api/progress', { session: cookieValue(l, '__Host-session') })).status, 401);
});

test('SEC-9: sessions end 90 days after sign-in however often they are used', async () => {
  const s = setup();
  const a = await register(s);
  let maxAge = 0;
  for (let i = 0; i < 5; i++) {
    s.advance(16 * DAY);
    const me = await s.call('GET', '/api/me', { session: a.session });
    assert.ok(((await me.json()) as { user: unknown }).user, `day ${(i + 1) * 16}`);
    const set = me.headers.getSetCookie().find(c => c.startsWith('__Host-session='));
    if (set) maxAge = Number(/Max-Age=(\d+)/.exec(set)![1]);
  }
  // The day-64 renewal stops at day 90 (not day 94), and day 80 has nothing left to extend
  assert.equal(maxAge, 26 * 24 * 3600);
  s.advance(10 * DAY);
  assert.equal(((await (await s.call('GET', '/api/me', { session: a.session })).json()) as { user: unknown }).user, null);
  assert.equal((await s.call('GET', '/api/progress', { session: a.session })).status, 401);
});

test('SEC-9: the scheduled sweep deletes expired sessions, tokens and rate-limit rows', async () => {
  const s = setup();
  const a = await register(s);
  await s.call('POST', '/api/auth/password/forgot', { json: { email: 'learner@example.com' } });
  s.advance(2 * DAY);
  const b = await register(s, 'fresh@example.com', PASSWORD, '192.0.2.9');
  s.db.raw.prepare('UPDATE sessions SET expires_at = ? WHERE token_hash = ?').run(s.now() + DAY, createHash('sha256').update(a.session).digest('hex'));
  s.db.raw.prepare('UPDATE sessions SET created_at = ? WHERE token_hash = ?').run(s.now() - 91 * DAY, createHash('sha256').update(a.session).digest('hex'));
  await sweepExpired(s.db, s.now());
  assert.equal(s.count('SELECT count(*) AS n FROM sessions'), 1);
  assert.equal((await s.call('GET', '/api/progress', { session: b.session })).status, 200);
  assert.equal(s.count('SELECT count(*) AS n FROM auth_tokens WHERE expires_at <= ?', s.now()), 0);
  assert.ok(s.count('SELECT count(*) AS n FROM auth_tokens') >= 1); // b's verify token is still live
  assert.equal(s.count('SELECT count(*) AS n FROM rate_limits WHERE window_start <= ?', s.now() - 60 * MIN), 0);
  assert.ok(s.count('SELECT count(*) AS n FROM rate_limits') >= 1);
  const wrangler = readFileSync(new URL('../wrangler.jsonc', import.meta.url), 'utf8');
  assert.match(wrangler, /"triggers":\s*\{\s*"crons":\s*\["[^"]+"\]/);
  assert.match(readFileSync(new URL('./index.ts', import.meta.url), 'utf8'), /async scheduled\(/);
});

// --- SEC-10: peppered rate-limit keys ------------------------------------------------------

test('SEC-10: rate-limit keys are HMAC-SHA256 under RATE_LIMIT_PEPPER, and go with the account', async () => {
  const s = setup();
  const a = await registerVerified(s, 'gone@example.com');
  await s.call('POST', '/api/auth/email/login', { json: { email: 'gone@example.com', password: 'wrong wrong wrong' } });
  await s.call('POST', '/api/auth/password/forgot', { json: { email: 'gone@example.com' } });
  const keys = (s.db.raw.prepare('SELECT key FROM rate_limits').all() as { key: string }[]).map(r => r.key);
  const hmac = (v: string) => createHmac('sha256', 'test-pepper').update(v).digest('hex');
  assert.ok(keys.includes(`login-email:${hmac('gone@example.com')}`));
  assert.ok(keys.includes(`register-ip:${hmac('203.0.113.7')}`));
  assert.ok(!keys.some(k => k.endsWith(createHash('sha256').update('gone@example.com').digest('hex'))));

  const d = await s.call('DELETE', '/api/account', { session: a.session, json: { confirm: 'delete', currentPassword: PASSWORD } });
  assert.equal(d.status, 204);
  const left = (s.db.raw.prepare('SELECT key FROM rate_limits').all() as { key: string }[]).map(r => r.key);
  for (const name of ['login-email', 'login-email-hour', 'forgot-email']) assert.ok(!left.includes(`${name}:${hmac('gone@example.com')}`), name);
  for (const name of ['password-user', 'email-user', 'resend-user']) assert.ok(!left.includes(`${name}:${hmac(a.user.id)}`), name);
  // IP rows cannot be traced to the account and stay
  assert.ok(left.includes(`register-ip:${hmac('203.0.113.7')}`));
});

test('SEC-10: without the pepper, keys fall back to SHA-256 with a warning', async () => {
  const s = setup({ RATE_LIMIT_PEPPER: undefined });
  const warn = console.warn;
  const warnings: string[] = [];
  console.warn = (...a: unknown[]) => void warnings.push(a.join(' '));
  try {
    await s.call('POST', '/api/auth/email/login', { json: { email: 'nopepper@example.com', password: 'whatever-long' } });
  } finally {
    console.warn = warn;
  }
  const keys = (s.db.raw.prepare('SELECT key FROM rate_limits').all() as { key: string }[]).map(r => r.key);
  assert.ok(keys.includes(`login-email:${createHash('sha256').update('nopepper@example.com').digest('hex')}`));
  // Warned once per process (an earlier test may already have triggered it)
  assert.ok(warnings.length <= 1);
});

// --- SEC-11: forgot password ---------------------------------------------------------------

test('SEC-11: forgot password is limited to 10 per hour per /64 and always answers 202', async () => {
  const s = setup();
  for (let i = 0; i < 12; i++) await register(s, `u${i}@example.com`, PASSWORD, `198.51.${i}.1`);
  const before = s.services.emails.length;
  const statuses: number[] = [];
  for (let i = 0; i < 12; i++) {
    statuses.push((await s.call('POST', '/api/auth/password/forgot', { json: { email: `u${i}@example.com` }, ip: `2001:db8:5:5::${i + 1}` })).status);
  }
  assert.deepEqual([...new Set(statuses)], [202]);
  assert.equal(s.services.emails.length - before, 10);
  // Another /64 is not affected
  assert.equal((await s.call('POST', '/api/auth/password/forgot', { json: { email: 'u11@example.com' }, ip: '2001:db8:5:6::1' })).status, 202);
  assert.equal(s.services.emails.length - before, 11);
});

// --- SEC-12: OAuth start -------------------------------------------------------------------

test('SEC-12: OAuth start refuses cross-site requests; same-origin, none and no header pass', async () => {
  const s = setup();
  const { session } = await registerVerified(s);
  for (const provider of ['github', 'google']) {
    for (const site of ['cross-site', 'same-site']) {
      const res = await s.call('GET', `/api/auth/${provider}/start?link=1&return=%23%2Faccount`, { session, headers: { 'Sec-Fetch-Site': site } });
      assert.equal(res.status, 403, `${provider} ${site}`);
      assert.equal(cookieValue(res, '__Host-oauth'), undefined);
    }
    for (const headers of [{ 'Sec-Fetch-Site': 'same-origin' }, { 'Sec-Fetch-Site': 'none' }, {}] as Record<string, string>[]) {
      assert.equal((await s.call('GET', `/api/auth/${provider}/start`, { headers })).status, 302);
    }
  }
});

test('SEC-12: link mode is bound to the session that started it', async () => {
  const s = setup();
  const a = await registerVerified(s);
  const start = await s.call('GET', '/api/auth/github/start?link=1&return=%23%2Faccount%2Fsecurity', { session: a.session });
  const state = new URL(start.headers.get('Location')!).searchParams.get('state')!;
  const stateCookie = cookieValue(start, '__Host-oauth')!;
  // The browser's session changed before the callback (e.g. another account signed in)
  const b = await registerVerified(s, 'b@example.com', PASSWORD, '192.0.2.40');
  const cb = await s.call('GET', `/api/auth/github/callback?code=good-code&state=${state}`, {
    session: b.session,
    headers: { Cookie: `__Host-oauth=${stateCookie}` },
  });
  assert.equal(cb.headers.get('Location'), `${ORIGIN}/#/account/security?error=session_changed`);
  assert.equal(s.count("SELECT count(*) AS n FROM identities WHERE provider = 'github'"), 0);
});

// --- SEC-13: display names -----------------------------------------------------------------

test('SEC-13: display names with format characters (bidi overrides, zero-width) are refused', async () => {
  const s = setup();
  const { session } = await register(s);
  for (const name of ['admin\u202egnp.exe', 'a\u200bb', '\u2066x']) {
    const res = await s.call('PATCH', '/api/account', { session, json: { displayName: name } });
    assert.equal(res.status, 400, JSON.stringify(name));
    assert.equal(await errorOf(res), 'invalid_display_name');
  }
  assert.equal((await s.call('PATCH', '/api/account', { session, json: { displayName: 'Zoë Ünal' } })).status, 200);
});

// --- SEC-14: app origins -------------------------------------------------------------------

test('SEC-14: with APP_ORIGINS, links, redirect URIs and the Origin check use the allowlist', async () => {
  const s = setup({ APP_ORIGINS: 'https://terminuscli.com, https://www.terminuscli.com' });
  // The request arrives on an unlisted host (ORIGIN, a workers.dev name): only listed Origins may change state
  const refused = await s.call('POST', '/api/auth/email/register', { json: { email: 'a@example.com', password: PASSWORD, displayName: 'A', ageConfirmed: true } });
  assert.equal(refused.status, 403);
  const r = await s.call('POST', '/api/auth/email/register', {
    json: { email: 'a@example.com', password: PASSWORD, displayName: 'A', ageConfirmed: true },
    origin: 'https://terminuscli.com',
  });
  assert.equal(r.status, 201);
  assert.match(s.services.emails.at(-1)!.text, /^https:\/\/terminuscli\.com\/#\/account\/verify\?token=/m);
  const start = await s.call('GET', '/api/auth/github/start');
  assert.equal(new URL(start.headers.get('Location')!).searchParams.get('redirect_uri'), 'https://terminuscli.com/api/auth/github/callback');
  const g = await s.call('GET', '/api/auth/google/start');
  assert.equal(new URL(g.headers.get('Location')!).searchParams.get('redirect_uri'), 'https://terminuscli.com/api/auth/google/callback');

  // Without APP_ORIGINS (previews), the request's own origin
  const p = setup({ APP_ORIGINS: '' });
  assert.equal((await register(p)).res.status, 201);
  assert.match(p.services.emails.at(-1)!.text, new RegExp(`^${ORIGIN.replace(/\./g, '\\.')}/#/account/verify`, 'm'));
  assert.equal((await p.call('POST', '/api/logout', { origin: 'https://terminuscli.com' })).status, 403);

  const wrangler = readFileSync(new URL('../wrangler.jsonc', import.meta.url), 'utf8');
  assert.match(wrangler, /"workers_dev":\s*false/);
  assert.match(wrangler, /"preview_urls":\s*true/);
  assert.match(wrangler, /"APP_ORIGINS":\s*"https:\/\/terminuscli\.com"/);
});

// --- Response headers ----------------------------------------------------------------------

test('API answers carry nosniff, no-referrer and frame-ancestors none', async () => {
  const s = setup();
  const { session } = await register(s);
  const responses = [
    json({ ok: true }),
    text('x', 400),
    noContent(),
    await s.call('GET', '/api/me'),
    await s.call('GET', '/api/nope'),
    await s.call('GET', '/api/auth/github/start'),
    await s.call('GET', '/api/account/export', { session }),
  ];
  for (const res of responses) {
    assert.equal(res.headers.get('X-Content-Type-Options'), 'nosniff');
    assert.equal(res.headers.get('Referrer-Policy'), 'no-referrer');
    assert.equal(res.headers.get('Content-Security-Policy'), "frame-ancestors 'none'");
    assert.equal(res.headers.get('Cache-Control'), 'no-store');
  }
});
