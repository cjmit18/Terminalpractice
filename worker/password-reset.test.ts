// Portal part 4: resetting a forgotten password, and the email-claim fixes that come with it (SV3-1, SV3-3, SV3-4, SV3-11).
import test from 'node:test';
import assert from 'node:assert/strict';
import { PASSWORD, ORIGIN, count, sessionOf, setup, tokenIn } from './testkit.ts';
import { DAY } from './session.ts';
import { TOKEN_TTL } from './tokens.ts';

const NEW_PASSWORD = 'a brand new long passphrase';
const forgot = (s: ReturnType<typeof setup>, email = 'learner@example.com', headers?: Record<string, string>) =>
  s.call('POST', '/api/auth/password/forgot', { email }, headers);
const reset = (s: ReturnType<typeof setup>, token: string, password = NEW_PASSWORD) =>
  s.call('POST', '/api/auth/password/reset', { token, password });
const me = async (s: ReturnType<typeof setup>, session: string | null) =>
  (await (await s.call('GET', '/api/me', undefined, { Cookie: `__Host-session=${session}` })).json()).user;

test('forgot password: emails a single-use reset link; resetting sets the new password and signs out everywhere else', async () => {
  const s = setup();
  const oldSession = sessionOf(await s.register());
  s.sent.length = 0;

  const asked = await forgot(s);
  assert.equal(asked.status, 202);
  assert.equal(s.sent.length, 1);
  assert.match(s.sent[0].subject, /Reset your/);
  assert.ok(s.sent[0].text.includes(`${ORIGIN}/#/account/reset?token=`));
  const token = tokenIn(s.sent[0]);

  const done = await reset(s, token);
  assert.equal(done.status, 200);
  const newSession = sessionOf(done);
  assert.ok(newSession, 'the reset signs this browser in');
  assert.equal(await me(s, oldSession), null, 'the old session ended');
  assert.equal((await me(s, newSession)).emailVerified, true, 'the link reached the inbox, so the address is confirmed');

  assert.equal((await s.login()).status, 401, 'the old password stopped working');
  assert.equal((await s.login('learner@example.com', NEW_PASSWORD)).status, 200);
  assert.equal((await (await reset(s, token, 'yet another long passphrase')).json()).error, 'invalid_token', 'single use');
});

test('forgot password answers the same whether or not the address has an account, and stays quiet when limited', async () => {
  const s = setup();
  await s.register();
  s.sent.length = 0;
  for (const email of ['nobody@example.com', 'not an email', 'learner@example.com']) {
    const res = await forgot(s, email);
    assert.equal(res.status, 202);
    assert.deepEqual(await res.json(), { ok: true });
  }
  assert.equal(s.sent.length, 1, 'only the real account gets mail');
  await forgot(s);
  await forgot(s);
  const limited = await forgot(s);
  assert.equal(limited.status, 202, 'past 3 an hour the answer is unchanged');
  assert.equal(s.sent.length, 3, 'but no fourth email goes out');
});

test('reset links: a weak password can be retried with the same link; an expired or replaced link is refused', async () => {
  const s = setup();
  await s.register();
  await forgot(s);
  const first = tokenIn(s.sent.at(-1)!);
  const weak = await reset(s, first, 'short');
  assert.equal(weak.status, 400);
  await forgot(s);
  const second = tokenIn(s.sent.at(-1)!);
  assert.equal((await (await reset(s, first)).json()).error, 'invalid_token', 'a newer link replaces the older one');
  s.advance(TOKEN_TTL.reset);
  assert.equal((await (await reset(s, second)).json()).error, 'token_expired');
});

test('SV3-3: an unconfirmed learner who signed out can still sign in after 24 hours, and a reset confirms the address', async () => {
  const s = setup();
  await s.register();
  s.advance(DAY + 1000);
  const back = await s.login();
  assert.equal(back.status, 200, 'the same account, not a lockout');
  const session = sessionOf(back);
  const resend = await s.call('POST', '/api/auth/email/resend-verification', {}, { Cookie: `__Host-session=${session}` });
  assert.equal(resend.status, 409);
  assert.match((await resend.json()).message, /Forgot password/);

  s.sent.length = 0;
  await forgot(s);
  const done = await reset(s, tokenIn(s.sent[0]));
  assert.equal(done.status, 200);
  assert.equal((await me(s, sessionOf(done))).emailVerified, true);
  assert.equal(count(s.db, 'users'), 1, 'still the one account');
});

test('SV3-1: the inbox owner takes a squatted address back with a reset, and the squatter loses every way in', async () => {
  const s = setup();
  // A stranger signs up with someone else's address, and links another sign-in method to that account
  const squatter = sessionOf(await s.register({ password: PASSWORD }));
  const userId = (s.db.raw.prepare('SELECT id FROM users').get() as { id: string }).id;
  s.db.raw.prepare("INSERT INTO identities (provider, provider_id, user_id, login, linked_at) VALUES ('github', '42', ?, 'squatter', 0)").run(userId);

  s.sent.length = 0;
  await forgot(s, 'learner@example.com', { 'CF-Connecting-IP': '198.51.100.7' });
  const done = await reset(s, tokenIn(s.sent[0]));
  assert.equal(done.status, 200);
  assert.equal(await me(s, squatter), null, "the squatter's session ended");
  assert.equal((await s.login()).status, 401, "the squatter's password no longer works");
  const left = s.db.raw.prepare('SELECT provider FROM identities WHERE user_id = ?').all(userId).map(r => (r as { provider: string }).provider);
  assert.deepEqual(left, ['email'], 'other sign-in methods the claimant attached are removed');
});

test('a confirmed account keeps its other sign-in methods through a reset', async () => {
  const s = setup();
  await s.register();
  await s.call('POST', '/api/auth/email/verify', { token: tokenIn(s.sent[0]) });
  const userId = (s.db.raw.prepare('SELECT id FROM users').get() as { id: string }).id;
  s.db.raw.prepare("INSERT INTO identities (provider, provider_id, user_id, login, linked_at) VALUES ('github', '7', ?, 'owner', 0)").run(userId);
  await forgot(s);
  assert.equal((await reset(s, tokenIn(s.sent.at(-1)!))).status, 200);
  assert.equal(count(s.db, 'identities'), 2);
});

test('SV3-4: strangers spreading wrong passwords over many addresses cannot lock the owner out for the hour', async () => {
  const s = setup();
  await s.register();
  // 50 wrong tries from 2 addresses, each under its own per-IP limit
  for (let i = 0; i < 50; i++) {
    await s.login('learner@example.com', `wrong guess number ${i}`, { 'CF-Connecting-IP': i % 2 ? '198.51.100.1' : '198.51.100.2' });
  }
  assert.equal((await s.login('learner@example.com', 'still a wrong guess', { 'CF-Connecting-IP': '198.51.100.3' })).status, 429);
  assert.equal((await s.login(undefined, undefined, { 'CF-Connecting-IP': '198.51.100.3' })).status, 200, 'the right password still works');
});

test('SV3-11: sign-up and resend say whether a confirmation email could be sent', async () => {
  const on = setup();
  assert.equal((await (await on.register()).json()).emailSent, true);

  const off = setup({ SMTP_PASSWORD: undefined });
  const res = await off.register();
  assert.equal(res.status, 201);
  assert.equal((await res.json()).emailSent, false);
  const resend = await off.call('POST', '/api/auth/email/resend-verification', {}, { Cookie: `__Host-session=${sessionOf(res)}` });
  assert.equal((await resend.json()).emailSent, false);
  assert.equal(off.sent.length, 0);
});
