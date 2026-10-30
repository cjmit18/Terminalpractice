// Portal part 4: resetting a forgotten password, and the email-claim fixes that come with it (SV3-1, SV3-3, SV3-4, SV3-11).
import test from 'node:test';
import assert from 'node:assert/strict';
import { PASSWORD, ORIGIN, count, sessionOf, setup, tokenIn } from './testkit.ts';
import { DAY } from './session.ts';
import type { Db, DbStatement } from './http.ts';
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
  s.db.raw.prepare("INSERT INTO progress_items (user_id, kind, item_key, scope, epoch, earned_at) VALUES (?, 'objective', 'm/o', 'lab:m', 0, 1)").run(userId);

  s.sent.length = 0;
  await forgot(s, 'learner@example.com', { 'CF-Connecting-IP': '198.51.100.7' });
  const done = await reset(s, tokenIn(s.sent[0]));
  assert.equal(done.status, 200);
  assert.equal(await me(s, squatter), null, "the squatter's session ended");
  assert.equal((await s.login()).status, 401, "the squatter's password no longer works");
  const left = s.db.raw.prepare('SELECT provider FROM identities WHERE user_id = ?').all(userId).map(r => (r as { provider: string }).provider);
  assert.deepEqual(left, ['email'], 'other sign-in methods the claimant attached are removed');
  assert.equal(count(s.db, 'progress_items'), 0, "the claimant's synced progress is removed too");
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

/** Holds the next statement that starts with `sql` until `release()`; every other statement runs at once */
function holdNext(s: ReturnType<typeof setup>, sql: string) {
  const db = s.env.DB as Db;
  let release!: () => void;
  const gate = new Promise<void>(r => (release = r));
  let reached!: () => void;
  const atGate = new Promise<void>(r => (reached = r));
  let armed = true;
  s.env.DB = {
    ...db,
    prepare: (text: string) => {
      const inner = db.prepare(text);
      if (!armed || !text.trimStart().startsWith(sql)) return inner;
      armed = false;
      const wrap = (st: DbStatement): DbStatement => ({
        ...st,
        bind: (...v: unknown[]) => wrap(st.bind(...v)),
        run: async () => { reached(); await gate; return st.run(); },
        first: async <T,>() => { reached(); await gate; return st.first<T>(); },
      });
      return wrap(inner);
    },
  } as Db;
  return { atGate, release };
}

test('a sign-in with the old password that was checked before a reset finished gets no session after it', async () => {
  const s = setup();
  await s.register();
  await forgot(s);
  const token = tokenIn(s.sent.at(-1)!);
  // The old-password sign-in has checked the password and waits just before creating its session
  const hold = holdNext(s, 'INSERT INTO sessions');
  const slowLogin = s.login();
  await hold.atGate;
  const done = await reset(s, token);
  assert.equal(done.status, 200);
  hold.release();
  const late = await slowLogin;
  assert.equal(late.status, 401, 'the old password no longer signs in');
  assert.equal(sessionOf(late), null);
  assert.equal(count(s.db, 'sessions'), 1, "only the reset's own session exists");
});

test('a reset whose address was released to a new sign-up meanwhile changes nothing and signs no one in', async () => {
  const s = setup();
  await s.register();
  s.advance(DAY + 1000);
  await forgot(s);
  const token = tokenIn(s.sent.at(-1)!);
  // The reset has checked the link and waits just before writing the new password
  const hold = holdNext(s, 'UPDATE users SET password_hash');
  const slowReset = reset(s, token);
  await hold.atGate;
  const other = await s.register({ displayName: 'New Owner', password: 'violet harbor lantern quiz' }, { 'CF-Connecting-IP': '198.51.100.7' });
  assert.equal(other.status, 201, 'the lapsed claim gave way to a new sign-up');
  hold.release();
  const late = await slowReset;
  assert.equal(late.status, 400);
  assert.equal((await late.json()).error, 'invalid_token');
  assert.equal(sessionOf(late), null, 'no session for the account that lost the address');
  assert.equal((await s.login('learner@example.com', NEW_PASSWORD)).status, 401);
  assert.equal((await s.login('learner@example.com', 'violet harbor lantern quiz')).status, 200, 'the new owner keeps the address');
});

test('#51-1: a sign-up still in flight gets no session once the inbox owner has reset the password', async () => {
  const s = setup();
  // Someone signs up with an address that is not theirs; the sign-up waits just before making its session
  const hold = holdNext(s, 'INSERT INTO sessions');
  const slowSignUp = s.register();
  await hold.atGate;
  // Meanwhile the inbox owner takes the address back with a reset
  await forgot(s);
  const done = await reset(s, tokenIn(s.sent.at(-1)!));
  assert.equal(done.status, 200);
  const owner = sessionOf(done);
  hold.release();
  const late = await slowSignUp;
  assert.equal(late.status, 409);
  assert.equal(sessionOf(late), null, 'the claimant keeps no way in');
  assert.equal(count(s.db, 'sessions'), 1, "only the owner's session exists");
  assert.equal((await me(s, owner)).emailVerified, true);
});

test('#51-1: a reset that is about to sign in gets no session if a newer reset finished meanwhile', async () => {
  const s = setup();
  await s.register();
  await forgot(s);
  const first = tokenIn(s.sent.at(-1)!);
  // The first reset has written its password and waits just before making its session
  const hold = holdNext(s, 'INSERT INTO sessions');
  const slowReset = reset(s, first);
  await hold.atGate;
  await forgot(s);
  const newer = await reset(s, tokenIn(s.sent.at(-1)!), 'violet harbor lantern quiz');
  assert.equal(newer.status, 200);
  hold.release();
  const late = await slowReset;
  assert.equal(late.status, 409);
  assert.equal(sessionOf(late), null);
  assert.equal(count(s.db, 'sessions'), 1, "only the newer reset's session exists");
  assert.equal((await s.login('learner@example.com', 'violet harbor lantern quiz')).status, 200, 'the newer password works');
});

test('#51-2: an older reset that resumes after a newer one finished changes nothing', async () => {
  const s = setup();
  await s.register();
  await forgot(s);
  const older = tokenIn(s.sent.at(-1)!);
  // The older reset has used up its link and waits just before writing its password
  const hold = holdNext(s, 'UPDATE users SET password_hash');
  const slowReset = reset(s, older);
  await hold.atGate;
  await forgot(s);
  const newer = await reset(s, tokenIn(s.sent.at(-1)!), 'violet harbor lantern quiz');
  assert.equal(newer.status, 200);
  const newerSession = sessionOf(newer);
  hold.release();
  const late = await slowReset;
  assert.equal(late.status, 400);
  assert.equal((await late.json()).error, 'invalid_token');
  assert.equal((await s.login('learner@example.com', NEW_PASSWORD)).status, 401, "the older reset's password was never set");
  assert.notEqual(await me(s, newerSession), null, "the newer reset's session is still signed in");
  assert.equal((await s.login('learner@example.com', 'violet harbor lantern quiz')).status, 200);
});
