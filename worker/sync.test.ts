import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { handleApi, type ApiDeps, type ApiEnv } from './api.ts';
import { testDb } from './testkit.ts';

const ORIGIN = 'https://terminuscli.example';
const NOW = Date.UTC(2026, 9, 22);

function setup() {
  const db = testDb();
  const env: ApiEnv = { DB: db, GITHUB_CLIENT_ID: 'id', GITHUB_CLIENT_SECRET: 'secret' };
  const deps: ApiDeps = { fetch: async () => new Response('no network in tests', { status: 500 }), now: () => NOW };
  let n = 0;
  /** A user with a live session; returns the cookie header */
  const user = (id = `user-${++n}`) => {
    db.raw.prepare('INSERT INTO users (id, display_name, avatar_url, created_at) VALUES (?, ?, NULL, ?)').run(id, id, NOW);
    const token = `token-${id}`;
    const hash = createHash('sha256').update(token).digest('hex');
    db.raw.prepare('INSERT INTO sessions (token_hash, user_id, expires_at, created_at) VALUES (?, ?, ?, ?)').run(hash, id, NOW + 86_400_000, NOW);
    return { id, cookie: `__Host-session=${token}` };
  };
  const call = async (method: string, path: string, opts: { cookie?: string; body?: unknown; headers?: Record<string, string> } = {}) => {
    const headers: Record<string, string> = { ...(opts.cookie ? { Cookie: opts.cookie } : {}) };
    if (method !== 'GET') {
      headers.Origin = ORIGIN;
      headers['Content-Type'] = 'application/json';
    }
    Object.assign(headers, opts.headers);
    const body = opts.body === undefined ? undefined : typeof opts.body === 'string' ? opts.body : JSON.stringify(opts.body);
    return (await handleApi(new Request(ORIGIN + path, { method, headers, body }), env, deps))!;
  };
  return { db, user, call };
}

const obj = (key: string, epoch = 0) => ({ kind: 'objective', key, epoch, earnedAt: NOW });
const quiz = (key: string, correct: number, total: number, epoch = 0) => ({ kind: 'quiz', key, epoch, correct, total, earnedAt: NOW });
const keys = (body: { items: { kind: string; key: string }[] }) => body.items.map(i => `${i.kind}|${i.key}`);

test('progress routes need a session, this site as Origin and a JSON body', async () => {
  const s = setup();
  const u = s.user();
  assert.equal((await s.call('GET', '/api/progress')).status, 401);
  assert.equal((await s.call('PUT', '/api/progress', { body: { items: [] } })).status, 401);
  assert.equal((await s.call('GET', '/api/progress', { cookie: '__Host-session=unknown' })).status, 401);
  const bad = await s.call('PUT', '/api/progress', { cookie: u.cookie, body: { items: [] }, headers: { Origin: 'https://evil.example' } });
  assert.equal(bad.status, 403);
  assert.equal((await s.call('POST', '/api/progress/reset', { cookie: u.cookie, body: { scope: 'lab:a' }, headers: { Origin: '' } })).status, 403);
  assert.equal((await s.call('PUT', '/api/progress', { cookie: u.cookie, body: '{}', headers: { 'Content-Type': 'text/plain' } })).status, 415);
  assert.equal((await s.call('PUT', '/api/progress', { cookie: u.cookie, body: '{nope' })).status, 400);
  assert.equal((await s.call('DELETE', '/api/progress', { cookie: u.cookie })).status, 405);
  assert.equal((await s.call('GET', '/api/progress/other', { cookie: u.cookie })).status, 404);
  const err = await (await s.call('GET', '/api/progress')).json();
  assert.equal(err.error, 'not_signed_in');
  assert.equal(typeof err.message, 'string');
});

test('a body over 512 KB is refused before it is parsed', async () => {
  const s = setup();
  const u = s.user();
  const big = JSON.stringify({ items: [], pad: 'x'.repeat(512 * 1024) });
  assert.equal((await s.call('PUT', '/api/progress', { cookie: u.cookie, body: big })).status, 413);
});

test('only ids in the shapes the app uses are stored, never free text', async () => {
  const s = setup();
  const u = s.user();
  for (const item of [
    obj('Hello world/x'),
    obj('only-one-part'),
    obj('a/b/c'),
    { ...obj('lab/task'), kind: 'note' },
    quiz('path/q', 5, 3),
    { ...obj('lab/task'), epoch: -1 },
    obj(`lab/${'x'.repeat(70)}`),
  ]) {
    const res = await s.call('PUT', '/api/progress', { cookie: u.cookie, body: { items: [item] } });
    assert.equal(res.status, 400, JSON.stringify(item));
  }
  const free = await s.call('PUT', '/api/progress', { cookie: u.cookie, body: { settings: { theme: { value: 'my secret', updatedAt: NOW } } } });
  assert.equal(free.status, 400);
  const extra = await s.call('PUT', '/api/progress', { cookie: u.cookie, body: { settings: { notes: { value: 'x', updatedAt: NOW } } } });
  assert.equal(extra.status, 400);
  assert.equal((await s.call('POST', '/api/progress/reset', { cookie: u.cookie, body: { scope: 'track:Linux stuff' } })).status, 400);
  assert.equal((s.db.raw.prepare('SELECT COUNT(*) AS n FROM progress_items').get() as { n: number }).n, 0);
});

test('item count caps: per request and per account', async () => {
  const s = setup();
  const u = s.user();
  const many = Array.from({ length: 2001 }, (_, i) => obj(`lab/t${i}`));
  assert.equal((await s.call('PUT', '/api/progress', { cookie: u.cookie, body: { items: many } })).status, 413);
  for (let round = 0; round < 2; round++) {
    const batch = Array.from({ length: 2000 }, (_, i) => obj(`lab${round}/t${i}`));
    assert.equal((await s.call('PUT', '/api/progress', { cookie: u.cookie, body: { items: batch } })).status, 200);
  }
  const over = Array.from({ length: 1001 }, (_, i) => obj(`lab9/t${i}`));
  assert.equal((await s.call('PUT', '/api/progress', { cookie: u.cookie, body: { items: over } })).status, 413);
});

test('at the item cap, held items still update and retries pass; only new items are refused', async () => {
  const s = setup();
  const u = s.user();
  assert.equal((await s.call('PUT', '/api/progress', { cookie: u.cookie, body: { items: [quiz('p1/q', 1, 5), obj('lab-a/t1')] } })).status, 200);
  const fill = s.db.raw.prepare("INSERT INTO progress_items (user_id, kind, item_key, scope, epoch, correct, total, earned_at) VALUES (?, 'objective', ?, 'lab:bulk', 0, NULL, NULL, ?)");
  for (let i = 0; i < 4998; i++) fill.run(u.id, `bulk/t${i}`, NOW);
  // A better score for a held quiz, and the same upload again, add no row
  const better = await s.call('PUT', '/api/progress', { cookie: u.cookie, body: { items: [quiz('p1/q', 5, 5), obj('lab-a/t1')] } });
  assert.equal(better.status, 200);
  assert.equal((await better.json()).items.find((i: { kind: string }) => i.kind === 'quiz').correct, 5);
  assert.equal((await s.call('PUT', '/api/progress', { cookie: u.cookie, body: { items: [quiz('p1/q', 5, 5)] } })).status, 200);
  // A new item would be number 5,001
  assert.equal((await s.call('PUT', '/api/progress', { cookie: u.cookie, body: { items: [obj('lab-a/t2')] } })).status, 413);
});

test('at the scope cap, held scopes still reset and retries pass; only new scopes are refused', async () => {
  const s = setup();
  const u = s.user();
  await s.call('POST', '/api/progress/reset', { cookie: u.cookie, body: { scope: 'lab:lab-a', epoch: 0 } });
  const fill = s.db.raw.prepare('INSERT INTO progress_epochs (user_id, scope, epoch) VALUES (?, ?, 1)');
  for (let i = 0; i < 1999; i++) fill.run(u.id, `lab:bulk${i}`);
  const epochOf = async () => (await (await s.call('GET', '/api/progress', { cookie: u.cookie })).json()).epochs['lab:lab-a'];
  // Resetting a held scope at its current epoch raises it
  assert.equal((await s.call('POST', '/api/progress/reset', { cookie: u.cookie, body: { scope: 'lab:lab-a', epoch: 1 } })).status, 200);
  assert.equal(await epochOf(), 2);
  // The same reset retried changes nothing, and is not refused
  assert.equal((await s.call('POST', '/api/progress/reset', { cookie: u.cookie, body: { resets: [{ scope: 'lab:lab-a', epoch: 1 }, { scope: 'lab:lab-a', epoch: 1 }] } })).status, 200);
  assert.equal(await epochOf(), 2);
  // A new scope would be number 2,001
  assert.equal((await s.call('POST', '/api/progress/reset', { cookie: u.cookie, body: { scope: 'lab:lab-b' } })).status, 413);
});

test('uploads merge: union of items, best quiz score, scope derived from the key', async () => {
  const s = setup();
  const u = s.user();
  assert.deepEqual(await (await s.call('GET', '/api/progress', { cookie: u.cookie })).json(), { items: [], epochs: {}, settings: {} });

  await s.call('PUT', '/api/progress', { cookie: u.cookie, body: { items: [obj('lpi-101-1/hw-lspci'), quiz('lpic1-101/check-1', 3, 5)] } });
  const res = await s.call('PUT', '/api/progress', {
    cookie: u.cookie,
    // A forged scope is ignored; a worse score does not replace a better one
    body: { items: [{ ...obj('lpi-101-1/hw-lsmod'), scope: 'lab:other' }, quiz('lpic1-101/check-1', 2, 5), { kind: 'lesson', key: 'lpic1-101/intro', epoch: 0 }] },
  });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.deepEqual(keys(body), ['lesson|lpic1-101/intro', 'objective|lpi-101-1/hw-lsmod', 'objective|lpi-101-1/hw-lspci', 'quiz|lpic1-101/check-1']);
  assert.equal(body.items.find((i: { key: string }) => i.key === 'lpi-101-1/hw-lsmod').scope, 'lab:lpi-101-1');
  assert.deepEqual(body.items.find((i: { kind: string }) => i.kind === 'quiz'), {
    kind: 'quiz', key: 'lpic1-101/check-1', scope: 'path:lpic1-101', epoch: 0, correct: 3, total: 5, earnedAt: NOW,
  });
  const better = await (await s.call('PUT', '/api/progress', { cookie: u.cookie, body: { items: [quiz('lpic1-101/check-1', 5, 5)] } })).json();
  assert.equal(better.items.find((i: { kind: string }) => i.kind === 'quiz').correct, 5);
});

test('reset then reconnect: an offline device cannot bring reset progress back, its later work is kept', async () => {
  const s = setup();
  const u = s.user();
  // Both devices synced lab A at epoch 0
  await s.call('PUT', '/api/progress', { cookie: u.cookie, body: { items: [obj('lab-a/t1'), obj('lab-a/t2'), obj('lab-b/t1')] } });

  // Device A resets lab A
  const reset = await s.call('POST', '/api/progress/reset', { cookie: u.cookie, body: { scope: 'lab:lab-a', epoch: 0 } });
  assert.equal(reset.status, 200);
  assert.deepEqual(await reset.json(), { epochs: { 'lab:lab-a': 1 } });

  // Device B, offline the whole time, uploads its old snapshot (epoch 0) plus offline work
  const b = await (await s.call('PUT', '/api/progress', { cookie: u.cookie, body: { items: [obj('lab-a/t1'), obj('lab-a/t2'), obj('lab-a/t3')] } })).json();
  assert.deepEqual(keys(b), ['objective|lab-b/t1']);
  assert.deepEqual(b.epochs, { 'lab:lab-a': 1 });

  // B learned the new epoch from that response; work after it is kept
  const later = await (await s.call('PUT', '/api/progress', { cookie: u.cookie, body: { items: [obj('lab-a/t3', 1)] } })).json();
  assert.deepEqual(keys(later), ['objective|lab-a/t3', 'objective|lab-b/t1']);

  // The same reset sent again (another tab, a retry) does nothing; a reset without an epoch always raises
  await s.call('POST', '/api/progress/reset', { cookie: u.cookie, body: { resets: [{ scope: 'lab:lab-a', epoch: 0 }] } });
  assert.deepEqual(keys(await (await s.call('GET', '/api/progress', { cookie: u.cookie })).json()), ['objective|lab-a/t3', 'objective|lab-b/t1']);
  const again = await (await s.call('POST', '/api/progress/reset', { cookie: u.cookie, body: { scope: 'lab:lab-a' } })).json();
  assert.deepEqual(again.epochs, { 'lab:lab-a': 2 });
  assert.deepEqual(keys(await (await s.call('GET', '/api/progress', { cookie: u.cookie })).json()), ['objective|lab-b/t1']);
});

test('every reset with the expected epoch works, not just the first', async () => {
  const s = setup();
  const u = s.user();
  for (let epoch = 0; epoch < 3; epoch++) {
    await s.call('PUT', '/api/progress', { cookie: u.cookie, body: { items: [obj('lab-a/t1', epoch)] } });
    assert.deepEqual(keys(await (await s.call('GET', '/api/progress', { cookie: u.cookie })).json()), ['objective|lab-a/t1']);
    const reset = await (await s.call('POST', '/api/progress/reset', { cookie: u.cookie, body: { scope: 'lab:lab-a', epoch } })).json();
    assert.deepEqual(reset.epochs, { 'lab:lab-a': epoch + 1 });
    assert.deepEqual(keys(await (await s.call('GET', '/api/progress', { cookie: u.cookie })).json()), []);
  }
  // A stale epoch (a retry of the last reset) still does nothing
  const stale = await (await s.call('POST', '/api/progress/reset', { cookie: u.cookie, body: { scope: 'lab:lab-a', epoch: 2 } })).json();
  assert.deepEqual(stale.epochs, { 'lab:lab-a': 3 });
});

test('a sync request that renews the session sends the renewed cookie', async () => {
  const s = setup();
  // The test session expires in a day, so any use renews it
  const u = s.user();
  for (const [method, path, body] of [
    ['GET', '/api/progress', undefined],
    ['PUT', '/api/progress', { items: [obj('lab-a/t1')] }],
    ['POST', '/api/progress/reset', { scope: 'lab:lab-a' }],
  ] as const) {
    s.db.raw.prepare('UPDATE sessions SET expires_at = ?').run(NOW + 86_400_000);
    const res = await s.call(method, path, { cookie: u.cookie, body });
    assert.equal(res.status, 200, `${method} ${path}`);
    assert.match(res.headers.get('Set-Cookie') ?? '', /^__Host-session=token-user-1; Path=\/; Max-Age=2592000;/, `${method} ${path}`);
  }
});

test('two accounts: each sees only its own progress, whatever the body says', async () => {
  const s = setup();
  const a = s.user('user-a');
  const b = s.user('user-b');
  await s.call('PUT', '/api/progress', { cookie: a.cookie, body: { userId: 'user-b', items: [obj('lab-a/t1')] } });
  await s.call('POST', '/api/progress/reset', { cookie: b.cookie, body: { scope: 'lab:lab-a' } });
  assert.deepEqual(keys(await (await s.call('GET', '/api/progress', { cookie: a.cookie })).json()), ['objective|lab-a/t1']);
  const bState = await (await s.call('GET', '/api/progress', { cookie: b.cookie })).json();
  assert.deepEqual(bState, { items: [], epochs: { 'lab:lab-a': 1 }, settings: {} });
  // Deleting a user removes their sync rows too
  s.db.raw.prepare('DELETE FROM users WHERE id = ?').run('user-a');
  assert.equal((s.db.raw.prepare('SELECT COUNT(*) AS n FROM progress_items').get() as { n: number }).n, 0);
});

test('settings: per field, the newest write wins', async () => {
  const s = setup();
  const u = s.user();
  await s.call('PUT', '/api/progress', {
    cookie: u.cookie,
    body: {
      settings: {
        theme: { value: 'dark', updatedAt: 200 },
        prefs: { value: { celebrations: 'lively', weeklyGoal: 3 }, updatedAt: 200 },
        badges: { value: { 'first-lab': 150 }, updatedAt: 200 },
      },
    },
  });
  const res = await s.call('PUT', '/api/progress', {
    cookie: u.cookie,
    body: {
      settings: {
        theme: { value: 'light', updatedAt: 100 },
        prefs: { value: { celebrations: 'off' }, updatedAt: 300 },
        practice: { value: ['2026-10-21', '2026-10-20'], updatedAt: 300 },
        cleared: { value: 250, updatedAt: 250 },
      },
    },
  });
  const { settings } = await res.json();
  assert.deepEqual(settings, {
    prefs: { value: { celebrations: 'off' }, updatedAt: 300 },
    theme: { value: 'dark', updatedAt: 200 },
    badges: { value: { 'first-lab': 150 }, updatedAt: 200 },
    practice: { value: ['2026-10-20', '2026-10-21'], updatedAt: 300 },
    cleared: { value: 250, updatedAt: 250 },
  });
});
