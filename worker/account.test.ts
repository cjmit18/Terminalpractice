// Portal part 7: account settings, sessions, password, sign-in methods, export and delete.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { PASSWORD, count, sessionOf, setup } from './testkit.ts';
import { REAUTH_WINDOW } from './session.ts';

const NEW_PASSWORD = 'a brand new long passphrase';
type Setup = ReturnType<typeof setup>;
const as = (session: string | null) => ({ Cookie: `__Host-session=${session}` });
const me = async (s: Setup, session: string | null) => (await (await s.call('GET', '/api/me', undefined, as(session))).json()).user;
const sessions = async (s: Setup, session: string | null) =>
  (await (await s.call('GET', '/api/account/sessions', undefined, as(session))).json()).sessions as { id: string; current: boolean }[];

/** A user who signs in with GitHub only, with a session signed in `signedInAgo` ms ago */
function githubUser(s: Setup, signedInAgo = 0, id = 'gh-user') {
  const now = s.advance(0);
  s.db.raw.prepare('INSERT INTO users (id, display_name, avatar_url, created_at) VALUES (?, ?, NULL, ?)').run(id, 'Octo', now);
  s.db.raw.prepare("INSERT INTO identities (provider, provider_id, user_id, login, linked_at) VALUES ('github', ?, ?, 'octo', ?)").run(`${id}-gh`, id, now);
  const token = `token-${id}`;
  s.db.raw
    .prepare('INSERT INTO sessions (token_hash, user_id, expires_at, created_at, authenticated_at) VALUES (?, ?, ?, ?, ?)')
    .run(createHash('sha256').update(token).digest('hex'), id, now + 86_400_000, now - signedInAgo, now - signedInAgo);
  return token;
}

test('account routes need a session, and changes need this site as Origin', async () => {
  const s = setup();
  for (const [method, path] of [
    ['GET', '/api/account'],
    ['GET', '/api/account/sessions'],
    ['GET', '/api/account/export'],
    ['DELETE', '/api/account/sessions'],
    ['POST', '/api/account/password'],
  ]) {
    assert.equal((await s.call(method, path, method === 'GET' ? undefined : {})).status, 401, `${method} ${path}`);
  }
  const session = sessionOf(await s.register());
  const foreign = await s.call('DELETE', '/api/account', { confirm: 'delete', currentPassword: PASSWORD }, { ...as(session), Origin: 'https://evil.example' });
  assert.equal(foreign.status, 403);
  assert.equal(count(s.db, 'users'), 1);
  assert.equal((await s.call('GET', '/api/account/sessions/zz', undefined, as(session))).status, 404, 'an id not in the expected form is no route');
});

test('GET /api/account lists the sign-in methods; PATCH changes the display name', async () => {
  const s = setup();
  const session = sessionOf(await s.register());
  const account = await (await s.call('GET', '/api/account', undefined, as(session))).json();
  assert.deepEqual(account.signInMethods, ['email']);
  assert.equal(account.hasPassword, true);
  assert.equal(account.identities[0].provider, 'email');
  const renamed = await (await s.call('PATCH', '/api/account', { displayName: '  New   Name ' }, as(session))).json();
  assert.equal(renamed.user.name, 'New Name');
  assert.equal((await s.call('PATCH', '/api/account', { displayName: '' }, as(session))).status, 400);
});

test('sessions: listed newest first with this one marked; one can be ended, or every other one', async () => {
  const s = setup();
  const a = sessionOf(await s.register());
  s.advance(1000);
  const b = sessionOf(await s.login());
  s.advance(1000);
  const c = sessionOf(await s.login());

  const list = await sessions(s, a);
  assert.equal(list.length, 3);
  assert.deepEqual(list.map(x => x.current), [false, false, true]);
  assert.ok(list.every(x => /^[0-9a-f]{16}$/.test(x.id)));
  const listed = JSON.stringify(list);
  for (const token of [a, b, c]) assert.ok(!listed.includes(token!), 'no cookie value is ever shown');

  // End the newest (c) from a
  assert.equal((await s.call('DELETE', `/api/account/sessions/${list[0].id}`, undefined, as(a))).status, 204);
  assert.equal(await me(s, c), null);
  assert.equal((await s.call('DELETE', `/api/account/sessions/${list[0].id}`, undefined, as(a))).status, 404, 'already ended');

  // Another account cannot end this account's sessions
  const other = sessionOf(await s.register({ email: 'other@example.com' }));
  assert.equal((await s.call('DELETE', `/api/account/sessions/${list[1].id}`, undefined, as(other))).status, 404);
  assert.ok(await me(s, b));

  // Sign out everywhere else: b ends, a stays
  const ended = await (await s.call('DELETE', '/api/account/sessions', undefined, as(a))).json();
  assert.equal(ended.ended, 1);
  assert.equal(await me(s, b), null);
  assert.ok(await me(s, a));
  assert.ok(await me(s, other), "another account's sessions are untouched");

  // Ending this session signs this browser out
  const self = (await sessions(s, a))[0];
  const res = await s.call('DELETE', `/api/account/sessions/${self.id}`, undefined, as(a));
  assert.equal(res.status, 204);
  assert.match(res.headers.get('Set-Cookie') ?? '', /__Host-session=;.*Max-Age=0/);
  assert.equal(await me(s, a), null);
});

test('password change: needs the current password, ends every other session and rotates this one', async () => {
  const s = setup();
  const a = sessionOf(await s.register());
  const b = sessionOf(await s.login());
  assert.equal((await (await s.call('POST', '/api/account/password', { newPassword: NEW_PASSWORD }, as(a))).json()).error, 'current_password_required');
  const wrong = await s.call('POST', '/api/account/password', { currentPassword: 'not the password', newPassword: NEW_PASSWORD }, as(a));
  assert.equal(wrong.status, 403);
  assert.equal((await (await s.call('POST', '/api/account/password', { currentPassword: PASSWORD, newPassword: 'short' }, as(a))).json()).error, 'password_too_short');

  const done = await s.call('POST', '/api/account/password', { currentPassword: PASSWORD, newPassword: NEW_PASSWORD }, as(a));
  assert.equal(done.status, 200);
  const fresh = sessionOf(done);
  assert.ok(fresh && fresh !== a);
  assert.equal(await me(s, a), null);
  assert.equal(await me(s, b), null);
  assert.ok(await me(s, fresh));
  assert.equal((await s.login()).status, 401);
  assert.equal((await s.login('learner@example.com', NEW_PASSWORD)).status, 200);
});

test('a password change racing another one is refused rather than both winning', async () => {
  const s = setup();
  const a = sessionOf(await s.register());
  // The hash the request checked is replaced before its update runs
  const realPrepare = s.db.prepare.bind(s.db);
  let swapped = false;
  s.db.prepare = (sql: string) => {
    if (!swapped && sql.startsWith('UPDATE users SET password_hash')) {
      swapped = true;
      s.db.raw.prepare("UPDATE users SET password_hash = 'changed-elsewhere'").run();
    }
    return realPrepare(sql);
  };
  const res = await s.call('POST', '/api/account/password', { currentPassword: PASSWORD, newPassword: NEW_PASSWORD }, as(a));
  assert.equal(res.status, 409);
  assert.equal((s.db.raw.prepare('SELECT password_hash FROM users').get() as { password_hash: string }).password_hash, 'changed-elsewhere');
});

test('without a password, sensitive actions need a sign-in within 10 minutes', async () => {
  const s = setup();
  const stale = githubUser(s, REAUTH_WINDOW + 1000);
  const res = await s.call('DELETE', '/api/account', { confirm: 'delete' }, as(stale));
  assert.equal(res.status, 403);
  assert.deepEqual(await res.json(), { providers: ['github'], error: 'reauth_required', message: 'Sign in again to confirm it is you, then retry.' });
  assert.equal(count(s.db, 'users'), 1);
  // POST /api/account/reauth is for password accounts; GitHub users sign in again instead
  assert.equal((await s.call('POST', '/api/account/reauth', {}, as(stale))).status, 403);

  const fresh = githubUser(s, 0, 'gh-fresh');
  assert.equal((await s.call('DELETE', '/api/account', { confirm: 'delete' }, as(fresh))).status, 204);
  assert.equal(count(s.db, 'users'), 1, 'only the freshly signed-in account was deleted');
});

test('unlinking: never the last sign-in method; GitHub can go when a password remains', async () => {
  const s = setup();
  const session = sessionOf(await s.register());
  const last = await s.call('DELETE', '/api/account/identities/email', { currentPassword: PASSWORD }, as(session));
  assert.equal(last.status, 409);
  assert.equal((await last.json()).error, 'last_method');
  assert.equal((await s.call('DELETE', '/api/account/identities/github', { currentPassword: PASSWORD }, as(session))).status, 404);

  const userId = (await me(s, session)).id;
  s.db.raw.prepare("INSERT INTO identities (provider, provider_id, user_id, login, linked_at) VALUES ('github', '42', ?, 'octo', 0)").run(userId);
  assert.deepEqual((await (await s.call('GET', '/api/account', undefined, as(session))).json()).signInMethods, ['github', 'email']);
  assert.equal((await s.call('DELETE', '/api/account/identities/github', { currentPassword: 'wrong password here' }, as(session))).status, 403);
  assert.equal((await s.call('DELETE', '/api/account/identities/github', { currentPassword: PASSWORD }, as(session))).status, 204);
  assert.deepEqual((await (await s.call('GET', '/api/account', undefined, as(session))).json()).signInMethods, ['email']);
});

test('export is a JSON download with the progress, and no password, session or token hashes', async () => {
  const s = setup();
  const session = sessionOf(await s.register());
  await s.call('PUT', '/api/progress', { items: [{ kind: 'objective', key: 'lab-a/t1', epoch: 0, earnedAt: 1 }] }, as(session));
  const res = await s.call('GET', '/api/account/export', undefined, as(session));
  assert.equal(res.status, 200);
  assert.match(res.headers.get('Content-Disposition') ?? '', /attachment; filename="terminus-account.json"/);
  const text = await res.text();
  const data = JSON.parse(text);
  assert.equal(data.user.email, 'learner@example.com');
  assert.equal(data.hasPassword, true);
  assert.equal(data.progress.items[0].key, 'lab-a/t1');
  const hash = (s.db.raw.prepare('SELECT password_hash FROM users').get() as { password_hash: string }).password_hash;
  const tokenHash = (s.db.raw.prepare('SELECT token_hash FROM sessions').get() as { token_hash: string }).token_hash;
  assert.ok(!text.includes(hash) && !text.includes(tokenHash) && !text.includes(session!));
});

test('delete account: needs the confirmation and the password, then removes everything and signs out', async () => {
  const s = setup();
  const session = sessionOf(await s.register());
  const other = sessionOf(await s.register({ email: 'other@example.com' }));
  await s.call('PUT', '/api/progress', { items: [{ kind: 'objective', key: 'lab-a/t1', epoch: 0, earnedAt: 1 }] }, as(session));
  await s.call('PUT', '/api/progress', { items: [{ kind: 'objective', key: 'lab-a/t1', epoch: 0, earnedAt: 1 }] }, as(other));

  assert.equal((await (await s.call('DELETE', '/api/account', { currentPassword: PASSWORD }, as(session))).json()).error, 'confirm_required');
  assert.equal((await s.call('DELETE', '/api/account', { confirm: 'delete', currentPassword: 'not the password' }, as(session))).status, 403);
  const done = await s.call('DELETE', '/api/account', { confirm: 'delete', currentPassword: PASSWORD }, as(session));
  assert.equal(done.status, 204);
  assert.match(done.headers.get('Set-Cookie') ?? '', /__Host-session=;.*Max-Age=0/);
  assert.equal(await me(s, session), null);
  assert.equal(count(s.db, 'users'), 1);
  for (const table of ['sessions', 'identities', 'progress_items']) assert.equal(count(s.db, table), 1, `only the other account's ${table} rows remain`);
  assert.equal((await s.login()).status, 401);
  assert.ok(await me(s, other));
});
