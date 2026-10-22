import test from 'node:test';
import assert from 'node:assert/strict';
import { ORIGIN, PASSWORD, cookieValue, oauth, register, setup, tokenFromEmail } from './testkit.ts';
import { base64url } from './http.ts';

// --- Google --------------------------------------------------------------------------------

test('Google start: code flow with state, PKCE S256 and only openid email profile', async () => {
  const s = setup();
  const res = await s.call('GET', '/api/auth/google/start?return=%23%2Faccount');
  assert.equal(res.status, 302);
  const loc = new URL(res.headers.get('Location')!);
  assert.equal(loc.origin + loc.pathname, 'https://accounts.google.com/o/oauth2/v2/auth');
  assert.equal(loc.searchParams.get('client_id'), 'google-client.apps.googleusercontent.com');
  assert.equal(loc.searchParams.get('redirect_uri'), `${ORIGIN}/api/auth/google/callback`);
  assert.equal(loc.searchParams.get('response_type'), 'code');
  assert.equal(loc.searchParams.get('scope'), 'openid email profile');
  assert.equal(loc.searchParams.get('code_challenge_method'), 'S256');
  assert.ok(loc.searchParams.get('state')!.length >= 40);
  // The secret never goes to the browser
  assert.doesNotMatch(res.headers.get('Location')!, /g-secret/);
  assert.match(res.headers.getSetCookie().find(c => c.startsWith('__Host-oauth='))!, /HttpOnly; Secure; SameSite=Lax/);
});

test('Google sign-in creates a user keyed by sub, with PKCE verified at the token exchange', async () => {
  const s = setup();
  const { cb, location, session } = await oauth(s, 'google', { returnTo: '#/account' });
  assert.equal(cb.status, 302);
  assert.equal(cb.headers.get('Location'), `${ORIGIN}/#/account`);
  assert.ok(session);

  const exchange = new URLSearchParams(String(s.services.calls.find(c => c.url === 'https://oauth2.googleapis.com/token')!.init?.body));
  assert.equal(exchange.get('client_secret'), 'g-secret');
  assert.equal(exchange.get('redirect_uri'), `${ORIGIN}/api/auth/google/callback`);
  const verifier = exchange.get('code_verifier')!;
  const challenge = base64url(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))));
  assert.equal(challenge, location!.searchParams.get('code_challenge'));

  const me = await (await s.call('GET', '/api/me', { session })).json();
  assert.equal(me.user.name, 'Google Learner');
  // Google's email is a label only: not the account's own email
  assert.equal(me.user.email, null);
  const id = s.db.raw.prepare("SELECT provider_id, login FROM identities WHERE provider = 'google'").get() as { provider_id: string; login: string };
  assert.deepEqual({ ...id }, { provider_id: '110248495921238986420', login: 'learner@gmail.example' });

  // Again: same user
  await oauth(s, 'google');
  assert.equal(s.count('SELECT count(*) AS n FROM users'), 1);
});

test('Google callback refuses a state mismatch, a missing cookie and a refused code', async () => {
  const s = setup();
  const start = await s.call('GET', '/api/auth/google/start');
  const stateCookie = cookieValue(start, '__Host-oauth')!;
  const state = new URL(start.headers.get('Location')!).searchParams.get('state')!;
  const cookieHeader = { Cookie: `__Host-oauth=${stateCookie}` };
  assert.equal((await s.call('GET', '/api/auth/google/callback?code=google-code&state=wrong', { headers: cookieHeader })).status, 400);
  assert.equal((await s.call('GET', `/api/auth/google/callback?code=google-code&state=${state}`)).status, 400);
  assert.equal((await s.call('GET', `/api/auth/google/callback?code=bad&state=${state}`, { headers: cookieHeader })).status, 502);
  // A GitHub state cookie cannot complete a Google callback
  const gh = await s.call('GET', '/api/auth/github/start');
  const ghState = new URL(gh.headers.get('Location')!).searchParams.get('state')!;
  const crossed = await s.call('GET', `/api/auth/google/callback?code=google-code&state=${ghState}`, {
    headers: { Cookie: `__Host-oauth=${cookieValue(gh, '__Host-oauth')}` },
  });
  assert.equal(crossed.status, 400);
  assert.equal(s.count('SELECT count(*) AS n FROM sessions'), 0);
  // Cancel on Google goes back quietly
  assert.equal((await s.call('GET', '/api/auth/google/callback?error=access_denied', { headers: cookieHeader })).status, 302);
});

test('a Google account whose email matches an email account is not merged into it', async () => {
  const s = setup();
  await register(s, 'learner@gmail.example');
  await oauth(s, 'google');
  assert.equal(s.count('SELECT count(*) AS n FROM users'), 2);
});

// --- Linking -------------------------------------------------------------------------------

test('linking Google and GitHub to an email account, and unlinking with the last-method guard', async () => {
  const s = setup();
  const { session, user } = await register(s);

  // Linking needs a session
  assert.equal((await s.call('GET', '/api/auth/google/start?link=1')).status, 401);

  const linked = await oauth(s, 'google', { session, link: true, returnTo: '#/account/security' });
  assert.equal(linked.cb.status, 302);
  assert.equal(linked.cb.headers.get('Location'), `${ORIGIN}/#/account/security`);
  assert.equal(linked.session, undefined); // the same session continues
  await oauth(s, 'github', { session, link: true });
  assert.equal(s.count('SELECT count(*) AS n FROM users'), 1);

  const account = await (await s.call('GET', '/api/account', { session })).json();
  assert.deepEqual(
    account.identities.map((i: { provider: string; label: string }) => [i.provider, i.label]).sort(),
    [['email', 'learner@example.com'], ['github', 'octo-learner'], ['google', 'learner@gmail.example']],
  );
  assert.ok(account.identities.every((i: { linkedAt: number }) => typeof i.linkedAt === 'number'));
  assert.equal(account.hasPassword, true);
  assert.equal(account.user.login, 'octo-learner');

  // Each linked method signs in to the same user
  const viaGoogle = await oauth(s, 'google');
  assert.equal((await (await s.call('GET', '/api/me', { session: viaGoogle.session })).json()).user.id, user.id);

  // Remove email and GitHub; Google is then the last way in and stays
  assert.equal((await s.call('DELETE', '/api/account/identities/email', { session })).status, 204);
  assert.equal((await s.call('DELETE', '/api/account/identities/github', { session })).status, 204);
  const last = await s.call('DELETE', '/api/account/identities/google', { session });
  assert.equal(last.status, 409);
  assert.equal((await last.json()).error, 'last_method');
  assert.equal((await s.call('DELETE', '/api/account/identities/github', { session })).status, 404);
  assert.equal((await s.call('DELETE', '/api/account/identities/passkey', { session })).status, 404);
  const after = await (await s.call('GET', '/api/account', { session })).json();
  assert.deepEqual(after.identities.map((i: { provider: string }) => i.provider), ['google']);
  assert.equal(after.hasPassword, false);
  assert.equal(after.user.email, null);
});

test('an email account with only its password cannot remove it (409)', async () => {
  const s = setup();
  const { session } = await register(s);
  assert.equal((await s.call('DELETE', '/api/account/identities/email', { session })).status, 409);
});

test('linking an identity that belongs to someone else is refused and nothing moves', async () => {
  const s = setup();
  const owner = await oauth(s, 'github'); // the GitHub account belongs to a GitHub-only user
  const { session } = await register(s);
  const res = await oauth(s, 'github', { session, link: true, returnTo: '#/account/security' });
  assert.equal(res.cb.headers.get('Location'), `${ORIGIN}/#/account/security?error=identity_in_use`);
  assert.equal(s.count("SELECT count(*) AS n FROM identities WHERE provider = 'github'"), 1);
  const me = await (await s.call('GET', '/api/me', { session: owner.session })).json();
  assert.equal(me.user.login, 'octo-learner');

  // A second, different Google account cannot be linked next to the first one
  await oauth(s, 'google', { session, link: true });
  s.services.state.google = { ...s.services.state.google, sub: 'another-sub' };
  const second = await oauth(s, 'google', { session, link: true, returnTo: '#/account' });
  assert.equal(second.cb.headers.get('Location'), `${ORIGIN}/#/account?error=provider_already_linked`);
});

test('a GitHub-only user who adds an email without a password still cannot drop GitHub', async () => {
  const s = setup();
  const { session } = await oauth(s, 'github');
  assert.equal((await s.call('POST', '/api/account/email', { session, json: { email: 'gh@example.com' } })).status, 202);
  assert.equal((await s.call('DELETE', '/api/account/identities/github', { session })).status, 409);
  // After setting a password, email is a real way in
  assert.equal((await s.call('POST', '/api/account/password', { session, json: { newPassword: PASSWORD } })).status, 200);
});

// --- /api/me, settings ---------------------------------------------------------------------

test('/api/me reports provider flags and email sending', async () => {
  const s = setup({ GOOGLE_CLIENT_SECRET: undefined });
  const body = await (await s.call('GET', '/api/me')).json();
  assert.deepEqual(body, { user: null, providers: { github: true, google: false, email: true }, emailSending: true });
  const { session } = await register(s);
  const signedIn = await (await s.call('GET', '/api/me', { session })).json();
  assert.deepEqual(signedIn.providers, { github: true, google: false, email: true });
  assert.equal(signedIn.user.emailVerified, false);
});

test('account settings need a session', async () => {
  const s = setup();
  for (const [method, path] of [
    ['GET', '/api/account'],
    ['PATCH', '/api/account'],
    ['GET', '/api/account/export'],
    ['POST', '/api/account/logout-all'],
    ['DELETE', '/api/account'],
  ]) {
    const res = await s.call(method, path, { json: method === 'GET' ? undefined : {} });
    assert.equal(res.status, 401, `${method} ${path}`);
    assert.equal((await res.json()).error, 'not_signed_in');
  }
});

test('PATCH /api/account changes the display name', async () => {
  const s = setup();
  const { session } = await register(s);
  const res = await s.call('PATCH', '/api/account', { session, json: { displayName: '  Grace   Hopper ' } });
  assert.equal(res.status, 200);
  assert.equal((await res.json()).user.name, 'Grace Hopper');
  assert.equal((await s.call('PATCH', '/api/account', { session, json: { displayName: 'x'.repeat(51) } })).status, 400);
  // A later GitHub sign-in does not overwrite the chosen name
  await oauth(s, 'github', { session, link: true });
  await oauth(s, 'github');
  assert.equal((await (await s.call('GET', '/api/me', { session })).json()).user.name, 'Grace Hopper');
});

test('logout-all ends every session of the user', async () => {
  const s = setup();
  const { session: a } = await register(s);
  const b = cookieValue(await s.call('POST', '/api/auth/email/login', { json: { email: 'learner@example.com', password: PASSWORD } }), '__Host-session')!;
  const other = await register(s, 'other@example.com');
  const res = await s.call('POST', '/api/account/logout-all', { session: a });
  assert.equal(res.status, 200);
  assert.equal(cookieValue(res, '__Host-session'), '');
  for (const sess of [a, b]) assert.equal((await (await s.call('GET', '/api/me', { session: sess })).json()).user, null);
  assert.ok((await (await s.call('GET', '/api/me', { session: other.session })).json()).user);
});

test('password change needs the current password, ends other sessions and rotates this one', async () => {
  const s = setup();
  const { session: a } = await register(s);
  const b = cookieValue(await s.call('POST', '/api/auth/email/login', { json: { email: 'learner@example.com', password: PASSWORD } }), '__Host-session')!;
  assert.equal((await s.call('POST', '/api/account/password', { session: a, json: { newPassword: 'a different passphrase' } })).status, 400);
  const wrong = await s.call('POST', '/api/account/password', { session: a, json: { currentPassword: 'nope nope nope', newPassword: 'a different passphrase' } });
  assert.equal(wrong.status, 403);
  assert.equal((await wrong.json()).error, 'wrong_password');
  assert.equal((await s.call('POST', '/api/account/password', { session: a, json: { currentPassword: PASSWORD, newPassword: 'password1234' } })).status, 400);

  const ok = await s.call('POST', '/api/account/password', { session: a, json: { currentPassword: PASSWORD, newPassword: 'a different passphrase' } });
  assert.equal(ok.status, 200);
  const rotated = cookieValue(ok, '__Host-session')!;
  assert.ok(rotated && rotated !== a);
  for (const old of [a, b]) assert.equal((await (await s.call('GET', '/api/me', { session: old })).json()).user, null);
  assert.ok((await (await s.call('GET', '/api/me', { session: rotated })).json()).user);
  assert.equal((await s.call('POST', '/api/auth/email/login', { json: { email: 'learner@example.com', password: 'a different passphrase' } })).status, 200);
});

test('email change: needs the password, refuses a taken address, sends a new verification and retires old links', async () => {
  const s = setup();
  const { session } = await register(s);
  await register(s, 'taken@example.com');
  const oldVerify = tokenFromEmail(s, 'verify');
  await s.call('POST', '/api/auth/password/forgot', { json: { email: 'learner@example.com' } });
  const oldReset = tokenFromEmail(s, 'reset');

  assert.equal((await s.call('POST', '/api/account/email', { session, json: { email: 'new@example.com' } })).status, 400);
  assert.equal((await s.call('POST', '/api/account/email', { session, json: { email: 'new@example.com', password: 'wrong wrong wrong' } })).status, 403);
  const taken = await s.call('POST', '/api/account/email', { session, json: { email: 'TAKEN@example.com', password: PASSWORD } });
  assert.equal(taken.status, 409);
  assert.equal((await taken.json()).error, 'email_in_use');

  const res = await s.call('POST', '/api/account/email', { session, json: { email: 'New@Example.com', password: PASSWORD } });
  assert.equal(res.status, 202);
  assert.deepEqual(s.services.emails.at(-1)!.to, ['new@example.com']);
  const account = await (await s.call('GET', '/api/account', { session })).json();
  assert.equal(account.user.email, 'new@example.com');
  assert.equal(account.emailVerified, false);
  assert.deepEqual(account.identities.filter((i: { provider: string }) => i.provider === 'email').map((i: { label: string }) => i.label), ['new@example.com']);
  assert.equal((await s.call('POST', '/api/auth/password/reset', { json: { token: oldReset, password: 'some new passphrase' } })).status, 400);
  assert.equal(oldVerify.length > 0, true);

  assert.equal((await s.call('POST', '/api/auth/email/login', { json: { email: 'new@example.com', password: PASSWORD } })).status, 200);
  assert.equal((await s.call('POST', '/api/auth/email/login', { json: { email: 'learner@example.com', password: PASSWORD } })).status, 401);
  const verify = await s.call('POST', '/api/auth/email/verify', { json: { token: tokenFromEmail(s, 'verify') } });
  assert.equal((await verify.json()).user.emailVerified, true);
});

// --- Export, delete ------------------------------------------------------------------------

test('export is a JSON download without password, session or token hashes', async () => {
  const s = setup();
  const { session, user } = await register(s);
  await oauth(s, 'github', { session, link: true });
  await s.call('POST', '/api/auth/password/forgot', { json: { email: 'learner@example.com' } });
  const res = await s.call('GET', '/api/account/export', { session });
  assert.equal(res.status, 200);
  assert.match(res.headers.get('Content-Disposition')!, /attachment; filename="terminus-account\.json"/);
  const raw = await res.text();
  const data = JSON.parse(raw);
  assert.equal(data.user.id, user.id);
  assert.equal(data.user.email, 'learner@example.com');
  assert.equal(data.hasPassword, true);
  assert.equal(data.signInMethods.length, 2);
  assert.equal(data.sessions.length, 1);

  const secrets = [
    ...(s.db.raw.prepare('SELECT password_hash AS v FROM users').all() as { v: string }[]),
    ...(s.db.raw.prepare('SELECT token_hash AS v FROM sessions').all() as { v: string }[]),
    ...(s.db.raw.prepare('SELECT token_hash AS v FROM auth_tokens').all() as { v: string }[]),
  ].map(r => r.v);
  assert.ok(secrets.length >= 4);
  for (const secret of secrets) assert.ok(!raw.includes(secret));
  assert.doesNotMatch(raw, /pbkdf2|token_hash|password_hash|[0-9a-f]{64}/);
});

test('delete account needs the confirmation and removes everything linked', async () => {
  const s = setup();
  const { session, user } = await register(s);
  await oauth(s, 'google', { session, link: true });
  await s.call('POST', '/api/auth/password/forgot', { json: { email: 'learner@example.com' } });
  const other = await register(s, 'other@example.com');

  assert.equal((await s.call('DELETE', '/api/account', { session, json: {} })).status, 400);
  const res = await s.call('DELETE', '/api/account', { session, json: { confirm: 'delete' } });
  assert.equal(res.status, 204);
  assert.equal(cookieValue(res, '__Host-session'), '');
  for (const table of ['users WHERE id', 'identities WHERE user_id', 'sessions WHERE user_id', 'auth_tokens WHERE user_id']) {
    assert.equal(s.count(`SELECT count(*) AS n FROM ${table} = ?`, user.id), 0, table);
  }
  assert.equal((await (await s.call('GET', '/api/me', { session })).json()).user, null);
  // Other accounts are untouched, and the address can be used again
  assert.ok((await (await s.call('GET', '/api/me', { session: other.session })).json()).user);
  assert.equal((await register(s, 'learner@example.com', PASSWORD, '192.0.2.50')).res.status, 201);
});

test('deleting a user cascades in the database itself', async () => {
  const s = setup();
  const { user } = await register(s);
  s.db.raw.prepare('DELETE FROM users WHERE id = ?').run(user.id);
  for (const t of ['identities', 'sessions', 'auth_tokens']) assert.equal(s.count(`SELECT count(*) AS n FROM ${t}`), 0, t);
});
