// Portal part 9: the owner, admins, and totals that never count them.
import test from 'node:test';
import assert from 'node:assert/strict';
import { sessionOf, setup } from './testkit.ts';

const OWNER = 'owner@example.com';
type Setup = ReturnType<typeof setup>;
const as = (session: string | null) => ({ Cookie: `__Host-session=${session}` });

/** Registers an account and, unless `confirmed` is false, confirms its email; returns its session */
async function account(s: Setup, email: string, confirmed = true): Promise<string> {
  const session = sessionOf(await s.register({ email }))!;
  if (confirmed) s.db.raw.prepare('UPDATE users SET email_verified_at = 1 WHERE email = ?').run(email);
  return session;
}
const role = async (s: Setup, session: string) => (await (await s.call('GET', '/api/me', undefined, as(session))).json()).role;
const stats = (s: Setup, session: string | null) => s.call('GET', '/api/admin/stats', undefined, session ? as(session) : {});

test('the role in /api/me: owner by the OWNER_EMAIL secret, admins added by the owner, only with a confirmed email', async () => {
  const s = setup({ OWNER_EMAIL: ' Owner@Example.com ' });
  const unconfirmed = await account(s, OWNER, false);
  assert.equal(await role(s, unconfirmed), null, 'an unconfirmed claim on the owner address is not the owner');
  s.db.raw.prepare('UPDATE users SET email_verified_at = 1 WHERE email = ?').run(OWNER);
  assert.equal(await role(s, unconfirmed), 'owner');

  const helper = await account(s, 'helper@example.com');
  assert.equal(await role(s, helper), null);
  assert.equal((await s.call('POST', '/api/admin/admins', { email: 'Helper@Example.com' }, as(unconfirmed))).status, 201);
  assert.equal(await role(s, helper), 'admin');

  const signedOut = await (await s.call('GET', '/api/me')).json();
  assert.equal(signedOut.role, undefined, 'signed out, there is no role');
  const noOwner = setup();
  assert.equal(await role(noOwner, await account(noOwner, OWNER)), null, 'without OWNER_EMAIL there is no owner');
});

test('totals need an admin, and never count the owner or admins', async () => {
  const s = setup({ OWNER_EMAIL: OWNER });
  const owner = await account(s, OWNER);
  const learner = await account(s, 'learner@example.com');
  await account(s, 'other@example.com', false);
  const helper = await account(s, 'helper@example.com');
  await s.call('POST', '/api/admin/admins', { email: 'helper@example.com' }, as(owner));
  // Progress from a learner and from the owner (which must not count)
  const items = [{ kind: 'objective', key: 'lab-a/t1', epoch: 0, earnedAt: 1 }, { kind: 'lesson', key: 'p1/intro', epoch: 0, earnedAt: 1 }];
  await s.call('PUT', '/api/progress', { items }, as(learner));
  await s.call('PUT', '/api/progress', { items }, as(owner));

  assert.equal((await stats(s, null)).status, 401);
  const refused = await stats(s, learner);
  assert.equal(refused.status, 403);
  assert.equal((await refused.json()).error, 'not_admin');

  for (const session of [owner, helper]) {
    const body = await (await stats(s, session)).json();
    assert.deepEqual(body.accounts, { total: 2, newLast7Days: 2, newLast30Days: 2, emailConfirmed: 1, withPassword: 2, withGithub: 0 });
    assert.deepEqual(body.activity, { signedInLast7Days: 2, liveSessions: 2 });
    assert.deepEqual(body.progress, { accountsWithProgress: 1, tasksDone: 1, lessonsRead: 1, quizzesTaken: 0 });
    // Totals only: no address or name of anyone
    const text = JSON.stringify(body);
    assert.ok(!text.includes('@') && !text.includes('Learner'));
  }

  // A week later the new-account count moves on; the 30-day one keeps them
  s.advance(8 * 86_400_000);
  const later = await (await stats(s, owner)).json();
  assert.equal(later.accounts.newLast7Days, 0);
  assert.equal(later.accounts.newLast30Days, 2);
});

test('only the owner lists, adds and removes admins, by email', async () => {
  const s = setup({ OWNER_EMAIL: OWNER });
  const owner = await account(s, OWNER);
  const helper = await account(s, 'helper@example.com');
  const add = (email: string, session = owner, headers: Record<string, string> = {}) =>
    s.call('POST', '/api/admin/admins', { email }, { ...as(session), ...headers });

  assert.equal((await add('helper@example.com')).status, 201);
  assert.equal((await (await add('HELPER@example.com')).json()).error, 'already_admin');
  assert.equal((await (await add('not an email')).json()).error, 'invalid_email');
  assert.equal((await (await add(OWNER)).json()).error, 'is_owner');
  assert.equal((await add('x@example.com', owner, { Origin: 'https://evil.example' })).status, 403, 'this site as Origin');

  // An admin cannot manage admins
  assert.equal((await add('friend@example.com', helper)).status, 403);
  assert.equal((await s.call('GET', '/api/admin/admins', undefined, as(helper))).status, 403);

  // A not-yet-registered address can be added; it counts once that account confirms the address
  assert.equal((await add('later@example.com')).status, 201);
  const list = await (await s.call('GET', '/api/admin/admins', undefined, as(owner))).json();
  assert.deepEqual(list.admins.map((a: { email: string }) => a.email), ['helper@example.com', 'later@example.com']);

  assert.equal((await s.call('DELETE', '/api/admin/admins', { email: 'helper@example.com' }, as(owner))).status, 204);
  assert.equal(await role(s, helper), null);
  assert.equal((await stats(s, helper)).status, 403);
  assert.equal((await s.call('DELETE', '/api/admin/admins', { email: 'helper@example.com' }, as(owner))).status, 404);
});
