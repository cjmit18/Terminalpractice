// Confirming an email address: the link sent at sign-up, using it, and asking for a new one.
import test from 'node:test';
import assert from 'node:assert/strict';
import { verificationEmail } from './mail.ts';
import { TOKEN_TTL } from './tokens.ts';
import { ORIGIN, sessionOf, setup, tokenIn } from './testkit.ts';

const me = async (s: ReturnType<typeof setup>, session: string | null) =>
  (await (await s.call('GET', '/api/me', undefined, { Cookie: `__Host-session=${session}` })).json()).user;

test('sign-up sends one email with a single-use link to this site, and the link confirms the address', async () => {
  const s = setup();
  const session = sessionOf(await s.register());
  assert.equal(s.sent.length, 1);
  const mail = s.sent[0];
  assert.equal(mail.to, 'learner@example.com');
  assert.match(mail.subject, /Confirm your email/);
  assert.ok(mail.text.includes(`${ORIGIN}/#/account/verify?token=`));
  const token = tokenIn(mail);
  assert.ok(token.length >= 40);
  assert.ok(!JSON.stringify(s.db.raw.prepare('SELECT * FROM auth_tokens').all()).includes(token), 'only the hash is stored');

  assert.equal((await me(s, session)).emailVerified, false);
  const res = await s.call('POST', '/api/auth/email/verify', { token });
  assert.equal(res.status, 200);
  assert.equal(sessionOf(res), null, 'opening the link does not sign anyone in');
  assert.equal((await me(s, session)).emailVerified, true);

  const again = await s.call('POST', '/api/auth/email/verify', { token });
  assert.equal(again.status, 400);
  assert.equal((await again.json()).error, 'invalid_token');
});

test('an expired link says so; a made-up one is invalid', async () => {
  const s = setup();
  await s.register();
  const token = tokenIn(s.sent[0]);
  s.advance(TOKEN_TTL.verify);
  const expired = await s.call('POST', '/api/auth/email/verify', { token });
  assert.equal((await expired.json()).error, 'token_expired');
  const madeUp = await s.call('POST', '/api/auth/email/verify', { token: 'not-a-real-token' });
  assert.equal((await madeUp.json()).error, 'invalid_token');
});

test('resend: needs sign-in, sends a new link that replaces the old one, and is limited to 3 an hour', async () => {
  const s = setup();
  const session = sessionOf(await s.register());
  const first = tokenIn(s.sent[0]);

  assert.equal((await s.call('POST', '/api/auth/email/resend-verification', {})).status, 401);

  const cookie = { Cookie: `__Host-session=${session}` };
  assert.equal((await s.call('POST', '/api/auth/email/resend-verification', {}, cookie)).status, 202);
  assert.equal(s.sent.length, 2);
  const second = tokenIn(s.sent[1]);
  assert.notEqual(second, first);
  assert.equal((await (await s.call('POST', '/api/auth/email/verify', { token: first })).json()).error, 'invalid_token', 'the old link stopped working');

  await s.call('POST', '/api/auth/email/resend-verification', {}, cookie);
  await s.call('POST', '/api/auth/email/resend-verification', {}, cookie);
  assert.equal((await s.call('POST', '/api/auth/email/resend-verification', {}, cookie)).status, 429);

  // Once confirmed, a resend sends nothing
  await s.call('POST', '/api/auth/email/verify', { token: tokenIn(s.sent.at(-1)!) });
  s.advance(60 * 60 * 1000);
  const before = s.sent.length;
  assert.equal((await s.call('POST', '/api/auth/email/resend-verification', {}, cookie)).status, 202);
  assert.equal(s.sent.length, before);
});

test('without SMTP settings, or when the mail server fails, sign-up still works and nothing is sent', async () => {
  const off = setup({ SMTP_USER: undefined, SMTP_PASSWORD: undefined });
  assert.equal((await off.register()).status, 201);
  assert.equal(off.sent.length, 0);

  const failing = setup({}, { failMail: true });
  assert.equal((await failing.register()).status, 201);
});

test('the email is plain and safe: links and text are escaped in the HTML version', () => {
  const m = verificationEmail('https://terminuscli.com', 'a@example.com', 'tok"<en>&');
  assert.ok(m.html.includes('tok%22%3Cen%3E%26'));
  assert.ok(!m.html.includes('<en>'));
  assert.ok(!/!/.test(m.subject), 'calm wording, no exclamation marks');
  assert.match(m.text, /expires in 24 hours/);
});
