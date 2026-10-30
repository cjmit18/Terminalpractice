// Portal part 7d: adding a way to sign in. Linking GitHub to an email account, and adding email and a
// password to an account made with GitHub.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { PASSWORD, count, sessionOf, setup } from './testkit.ts';
import type { ApiDeps } from './http.ts';
import { REAUTH_WINDOW } from './session.ts';

const RETURN = '#/account/security';
const as = (session: string | null) => ({ Cookie: `__Host-session=${session}` });
const cookieValue = (res: Response, name: string) =>
  res.headers.getSetCookie().find(c => c.startsWith(`${name}=`))?.split(';')[0].slice(name.length + 1);

/** A fake GitHub whose signed-in profile the test can switch */
function fakeGithub() {
  const gh = { profile: { id: 4242, login: 'octo', name: 'Octo From GitHub', avatar_url: 'https://avatars.example/4242' } };
  const fetch: ApiDeps['fetch'] = async (url, init) => {
    if (url === 'https://github.com/login/oauth/access_token') {
      return new URLSearchParams(String(init?.body)).get('code') === 'good-code' ? Response.json({ access_token: 'gho_temp' }) : Response.json({});
    }
    if (url === 'https://api.github.com/user') return Response.json(gh.profile);
    return new Response('unexpected', { status: 500 });
  };
  return { gh, fetch };
}

function linkSetup() {
  const { gh, fetch } = fakeGithub();
  const s = setup({ GITHUB_CLIENT_ID: 'Iv1.test', GITHUB_CLIENT_SECRET: 'shh' }, { fetch });
  return { ...s, gh };
}
type Setup = ReturnType<typeof linkSetup>;

/** An email account with a confirmed address; returns its session */
async function emailAccount(s: Setup, email = 'learner@example.com'): Promise<string> {
  const session = sessionOf(await s.register({ email }))!;
  s.db.raw.prepare('UPDATE users SET email_verified_at = 1 WHERE email = ?').run(email);
  return session;
}

/** Start and callback of a GitHub flow; `link` adds ?link=1. Returns the final redirect. */
async function github(s: Setup, opts: { session?: string; link?: boolean } = {}) {
  const cookies = opts.session ? `__Host-session=${opts.session}` : '';
  const start = await s.call('GET', `/api/auth/github/start?return=${encodeURIComponent(RETURN)}${opts.link ? '&link=1' : ''}`, undefined, { Cookie: cookies });
  const location = start.headers.get('Location') ?? '';
  if (!location.startsWith('https://github.com/')) return { start, done: start, location };
  const state = new URL(location).searchParams.get('state')!;
  const stateCookie = cookieValue(start, '__Host-oauth')!;
  const done = await s.call('GET', `/api/auth/github/callback?code=good-code&state=${state}`, undefined, {
    Cookie: `${cookies}; __Host-oauth=${stateCookie}`,
  });
  return { start, done, location: done.headers.get('Location') ?? '' };
}
const account = async (s: Setup, session: string) => (await s.call('GET', '/api/account', undefined, as(session))).json();

/** Runs `effect` just before the first statement starting with `prefix` is prepared */
function interleave(s: Setup, prefix: string, effect: () => void) {
  const prepare = s.db.prepare.bind(s.db);
  let done = false;
  s.db.prepare = sql => {
    if (!done && sql.replace(/\s+/g, ' ').trimStart().startsWith(prefix)) {
      done = true;
      effect();
    }
    return prepare(sql);
  };
  return () => done;
}

test('an email account links GitHub, keeps its own name, and can then sign in with either', async () => {
  const s = linkSetup();
  const session = await emailAccount(s);
  const { location } = await github(s, { session, link: true });
  assert.equal(location, `https://terminuscli.com/${RETURN}`);

  const details = await account(s, session);
  assert.deepEqual(details.signInMethods, ['github', 'email']);
  assert.equal(details.identities.find((i: { provider: string }) => i.provider === 'github').label, 'octo');
  assert.equal(details.user.name, 'Learner', 'the display name stays the learner’s own');
  assert.equal(details.user.avatarUrl, 'https://avatars.example/4242');

  // Signed out, GitHub signs in to the same account
  const { done } = await github(s);
  const viaGithub = cookieValue(done, '__Host-session')!;
  assert.equal((await account(s, viaGithub)).user.id, details.user.id);
  assert.equal((await account(s, viaGithub)).user.name, 'Learner', 'a GitHub sign-in no longer resets the name');
});

test('linking needs a confirmed email and a recent sign-in, and goes back with the reason', async () => {
  const s = linkSetup();
  const session = sessionOf(await s.register({ email: 'new@example.com' }))!;
  let r = await github(s, { session, link: true });
  assert.equal(r.location, `https://terminuscli.com/${RETURN}?error=email_unverified`);

  s.db.raw.prepare('UPDATE users SET email_verified_at = 1').run();
  s.advance(REAUTH_WINDOW + 1000);
  r = await github(s, { session, link: true });
  assert.equal(r.location, `https://terminuscli.com/${RETURN}?error=reauth_required`);
  assert.equal(count(s.db, 'identities'), 1, 'only the email identity');

  assert.equal((await s.call('POST', '/api/account/reauth', { currentPassword: PASSWORD }, as(session))).status, 200);
  r = await github(s, { session, link: true });
  assert.equal(r.location, `https://terminuscli.com/${RETURN}`);
  assert.deepEqual((await account(s, session)).signInMethods, ['github', 'email']);

  assert.equal((await s.call('GET', '/api/auth/github/start?link=1')).status, 401, 'signed out, there is nothing to link to');
  const crossSite = await s.call('GET', '/api/auth/github/start?link=1', undefined, { ...as(session), 'Sec-Fetch-Site': 'cross-site' });
  assert.equal(crossSite.status, 403);
});

test('a GitHub account that has its own Terminus account is not moved', async () => {
  const s = linkSetup();
  const { done } = await github(s);
  const githubSession = cookieValue(done, '__Host-session')!;
  const session = await emailAccount(s);
  const { location } = await github(s, { session, link: true });
  assert.equal(location, `https://terminuscli.com/${RETURN}?error=identity_in_use`);
  assert.deepEqual((await account(s, session)).signInMethods, ['email']);
  assert.deepEqual((await account(s, githubSession)).signInMethods, ['github']);
});

test('the link finishes only for the session that started it', async () => {
  const s = linkSetup();
  const session = await emailAccount(s);
  const start = await s.call('GET', `/api/auth/github/start?return=${encodeURIComponent(RETURN)}&link=1`, undefined, as(session));
  const state = new URL(start.headers.get('Location')!).searchParams.get('state')!;
  const stateCookie = cookieValue(start, '__Host-oauth')!;
  // Signed out and back in (a new session) before GitHub answered
  await s.call('POST', '/api/logout', undefined, as(session));
  const again = sessionOf(await s.login())!;
  const done = await s.call('GET', `/api/auth/github/callback?code=good-code&state=${state}`, undefined, {
    Cookie: `__Host-session=${again}; __Host-oauth=${stateCookie}`,
  });
  assert.equal(done.headers.get('Location'), `https://terminuscli.com/${RETURN}?error=session_changed`);
  assert.deepEqual((await account(s, again)).signInMethods, ['email']);
});

test('a sign-out that lands after the callback checked the session still stops the link', async () => {
  const s = linkSetup();
  const session = await emailAccount(s);
  // The callback has already checked the session; the learner signs out before the identity is written
  const happened = interleave(s, 'INSERT INTO identities (provider, provider_id, user_id, login, linked_at) SELECT', () =>
    s.db.raw.prepare('DELETE FROM sessions').run(),
  );
  const { location } = await github(s, { session, link: true });
  assert.ok(happened());
  assert.equal(location, `https://terminuscli.com/${RETURN}?error=session_changed`);
  assert.equal((s.db.raw.prepare("SELECT COUNT(*) AS n FROM identities WHERE provider = 'github'").get() as { n: number }).n, 0);

  // A GitHub sign-in afterwards makes its own account; it never reaches the email account
  const { done } = await github(s);
  const viaGithub = cookieValue(done, '__Host-session')!;
  assert.deepEqual((await account(s, viaGithub)).signInMethods, ['github']);
  assert.equal((await account(s, viaGithub)).user.email, null);
});

test('two links finishing at once leave one GitHub identity', async () => {
  const s = linkSetup();
  const session = await emailAccount(s);
  const userId = (await account(s, session)).user.id;
  // Another GitHub account is linked between this one's check and its insert
  const happened = interleave(s, 'INSERT INTO identities (provider, provider_id, user_id, login, linked_at) SELECT', () =>
    s.db.raw.prepare("INSERT INTO identities (provider, provider_id, user_id, login, linked_at) VALUES ('github', '9999', ?, 'other', 0)").run(userId),
  );
  const { location } = await github(s, { session, link: true });
  assert.ok(happened());
  assert.equal(location, `https://terminuscli.com/${RETURN}?error=provider_already_linked`);
  assert.equal((s.db.raw.prepare("SELECT COUNT(*) AS n FROM identities WHERE provider = 'github'").get() as { n: number }).n, 1);
});

/** A user who signs in with GitHub only, with a session signed in `signedInAgo` ms ago */
function githubUser(s: Setup, signedInAgo = 0) {
  const now = s.advance(0);
  s.db.raw.prepare('INSERT INTO users (id, display_name, avatar_url, created_at) VALUES (?, ?, NULL, ?)').run('gh-user', 'Octo', now);
  s.db.raw.prepare("INSERT INTO identities (provider, provider_id, user_id, login, linked_at) VALUES ('github', '1', 'gh-user', 'octo', ?)").run(now);
  const token = 'token-gh-user';
  s.db.raw
    .prepare('INSERT INTO sessions (token_hash, user_id, expires_at, created_at, authenticated_at) VALUES (?, ?, ?, ?, ?)')
    .run(createHash('sha256').update(token).digest('hex'), 'gh-user', now + 86_400_000, now - signedInAgo, now - signedInAgo);
  return token;
}
const addEmail = (s: Setup, session: string, email = 'octo@example.com', newPassword = PASSWORD) =>
  s.call('POST', '/api/account/email', { email, newPassword }, as(session));

test('a GitHub account adds email and a password, gets a confirmation link, and can sign in with them', async () => {
  const s = linkSetup();
  const session = githubUser(s);
  const res = await addEmail(s, session, 'Octo@Example.com');
  assert.equal(res.status, 201);
  assert.equal((await res.json()).user.email, 'octo@example.com');
  assert.equal(s.sent.length, 1);
  assert.equal(s.sent[0].to, 'octo@example.com');
  assert.deepEqual((await account(s, session)).signInMethods, ['github', 'email']);
  assert.equal((await s.login('octo@example.com')).status, 200);

  const again = await addEmail(s, session, 'other@example.com');
  assert.equal(again.status, 409);
  assert.equal((await again.json()).error, 'has_email');
});

test('adding email needs a recent sign-in, a strong password and a free address', async () => {
  const s = linkSetup();
  await emailAccount(s, 'taken@example.com');
  const stale = githubUser(s, REAUTH_WINDOW + 1000);
  const refused = await addEmail(s, stale);
  assert.equal(refused.status, 403);
  assert.equal((await refused.json()).error, 'reauth_required');

  s.db.raw.prepare('UPDATE sessions SET authenticated_at = ? WHERE user_id = ?').run(s.advance(0), 'gh-user');
  assert.equal((await addEmail(s, stale, 'not an email')).status, 400);
  assert.equal((await addEmail(s, stale, 'octo@example.com', 'short')).status, 400);
  const taken = await addEmail(s, stale, 'taken@example.com');
  assert.equal(taken.status, 409);
  assert.equal((await taken.json()).error, 'email_taken');
  assert.equal((await account(s, stale)).user.email, null);
  assert.equal(s.sent.length, 1, 'only the first account’s own confirmation');
});

test('a sign-out that lands during the request stops adding email', async () => {
  const s = linkSetup();
  const session = githubUser(s);
  const happened = interleave(s, 'UPDATE users SET email = ?1, email_verified_at = NULL', () => s.db.raw.prepare('DELETE FROM sessions').run());
  const res = await addEmail(s, session);
  assert.ok(happened());
  assert.equal(res.status, 401);
  assert.equal((s.db.raw.prepare("SELECT email, password_hash FROM users WHERE id = 'gh-user'").get() as { email: null }).email, null);
  assert.equal(count(s.db, 'auth_tokens'), 0, 'no confirmation link sent');
});

test('two adds at once: only the first address lands', async () => {
  const s = linkSetup();
  const session = githubUser(s);
  const happened = interleave(s, 'UPDATE users SET email = ?1, email_verified_at = NULL', () =>
    s.db.raw.prepare("UPDATE users SET email = 'first@example.com', email_set_at = 1 WHERE id = 'gh-user'").run(),
  );
  const res = await addEmail(s, session, 'second@example.com');
  assert.ok(happened());
  assert.equal(res.status, 409);
  assert.equal((await res.json()).error, 'has_email');
  assert.equal((await account(s, session)).user.email, 'first@example.com');
  assert.equal(count(s.db, 'auth_tokens'), 0, 'no link sent for the address that did not land');
});
