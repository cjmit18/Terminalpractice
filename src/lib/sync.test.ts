import test from 'node:test';
import assert from 'node:assert/strict';
import {
  SyncEngine,
  accountKeys,
  activityFromSettings,
  applyToJourney,
  applyToProgress,
  clearAccountKeys,
  itemsFromRecords,
  parseQueue,
  settingsDelta,
  settingsFromLocal,
  storageKeys,
  type KeyStore,
  type SyncAdapter,
} from './sync.ts';
import {
  acceptUpload,
  applyReset,
  itemId,
  mergeSettings,
  sanitizeItems,
  sanitizeSettings,
  scopeOf,
  type LocalItem,
  type ProgressState,
  type SyncItem,
  type SyncSettings,
} from './syncRules.ts';
import { mergeActivity, type Activity } from './activity.ts';

// ---------- Fakes: a server built from the shared rules, browser storage, and the app's data ----------

function fakeServer() {
  const users = new Map<string, ProgressState & { settings: SyncSettings }>();
  const state = (u: string) => {
    if (!users.has(u)) users.set(u, { items: [], epochs: {}, settings: {} });
    return users.get(u)!;
  };
  const log: { user: string; method: string; path: string; body?: unknown }[] = [];
  /** A browser: its own cookie (signed-in user) and connection */
  const client = () => {
    const c = { user: null as string | null, online: true, hold: null as null | Promise<void>, ignoreAbort: false };
    const fetch = async (url: string, init: RequestInit): Promise<Response> => {
      const signal = init.signal as AbortSignal;
      if (!c.online) throw new TypeError('Failed to fetch');
      const user = c.user;
      const path = url.replace('https://app.test/api/', '');
      const body = init.body ? JSON.parse(String(init.body)) : undefined;
      if (c.hold) await c.hold;
      if (signal?.aborted && !c.ignoreAbort) throw new DOMException('aborted', 'AbortError');
      if (!user) return Response.json({ error: 'unauthorized' }, { status: 401 });
      log.push({ user, method: init.method ?? 'GET', path, body });
      const s = state(user);
      if (path === 'progress/reset') {
        let next: ProgressState = s;
        for (const r of body.resets) next = applyReset(next, r.scope, r.epoch);
        Object.assign(s, next);
        return Response.json({ epochs: s.epochs });
      }
      if (init.method === 'PUT') {
        const up = acceptUpload(s, sanitizeItems(body.items).items);
        s.items = up.items;
        s.settings = mergeSettings(s.settings, sanitizeSettings(body.settings) ?? {});
      }
      return Response.json({ items: s.items, epochs: s.epochs, settings: s.settings });
    };
    return { c, fetch };
  };
  const keysOf = (u: string) => state(u).items.map(i => `${i.kind}|${i.key}`);
  return { state, client, log, keysOf };
}

function memoryStore(): KeyStore & { map: Map<string, string> } {
  const map = new Map<string, string>();
  return { map, get: k => map.get(k) ?? null, set: (k, v) => (v === null ? map.delete(k) : map.set(k, v)), keys: () => [...map.keys()] };
}

/** The app's records for one account, as plain items */
function fakeApp(signedOut: LocalItem[] = []) {
  const app = {
    items: new Map<string, LocalItem>(),
    applied: [] as { stale: string[]; items: SyncItem[] }[],
    imported: 0,
    earn(...keys: string[]) {
      for (const k of keys) app.items.set(`objective|${k}`, { kind: 'objective', key: k });
    },
    resetLocal(scope: string) {
      for (const [id, i] of app.items) if (scopeOf(i.kind, i.key) === scope) app.items.delete(id);
    },
    keys: () => [...app.items.keys()].sort(),
  };
  const adapter: SyncAdapter = {
    localItems: () => [...app.items.values()],
    localSettings: () => ({ theme: 'system', badges: {}, practice: [], goalWeeks: [] }),
    apply: u => {
      app.applied.push(u);
      for (const s of u.stale) app.resetLocal(s);
      for (const i of u.items) app.items.set(itemId(i), { kind: i.kind, key: i.key, correct: i.correct, total: i.total });
      return true;
    },
    hasSignedOutProgress: () => signedOut.length > 0,
    importSignedOut: () => {
      app.imported++;
      for (const i of signedOut) app.items.set(itemId(i), i);
    },
  };
  return { app, adapter };
}

function device(server: ReturnType<typeof fakeServer>, store = memoryStore()) {
  const { c, fetch } = server.client();
  const engine = new SyncEngine({
    fetch,
    store,
    now: () => 1_000_000,
    url: path => `https://app.test/api/${path}`,
    // Timers never fire on their own here; the tests call syncNow
    setTimer: () => 0,
    clearTimer: () => {},
  });
  return { c, engine, store };
}

// ---------- Records <-> items ----------

test('local records become items, and server items go back into the records', () => {
  const progress = { done: { 'lab-a': ['t1', 't2'] }, resetAt: {} };
  const journey = { read: ['p1/intro'], quiz: { 'p1/check': { correct: 3, total: 4 } }, last: null };
  assert.deepEqual(itemsFromRecords(progress, journey), [
    { kind: 'objective', key: 'lab-a/t1' },
    { kind: 'objective', key: 'lab-a/t2' },
    { kind: 'lesson', key: 'p1/intro' },
    { kind: 'quiz', key: 'p1/check', correct: 3, total: 4 },
  ]);

  const items: SyncItem[] = [
    { kind: 'objective', key: 'lab-b/x', scope: 'lab:lab-b', epoch: 0, earnedAt: 1 },
    { kind: 'quiz', key: 'p1/check', scope: 'path:p1', epoch: 0, correct: 4, total: 4, earnedAt: 1 },
    { kind: 'lesson', key: 'p2/intro', scope: 'path:p2', epoch: 0, earnedAt: 1 },
  ];
  // lab-a was reset on another device: cleared here with a tombstone, so other tabs drop it too
  const p = applyToProgress(progress, ['lab:lab-a'], items, 5000);
  assert.deepEqual(p.done, { 'lab-b': ['x'] });
  assert.equal(p.resetAt['lab-a'], 5000);
  const j = applyToJourney(journey, ['path:p1'], items, 5000);
  assert.deepEqual(j.read, ['p2/intro']);
  assert.deepEqual(j.quiz, { 'p1/check': { correct: 4, total: 4 } });
  assert.equal(j.resets?.p1, 5000);
  // Nothing new: the same objects come back (no rerender, no save)
  assert.equal(applyToProgress(p, [], items, 6000), p);
});

test('settings: only changed fields are sent, and the server copy merges back into activity', () => {
  const activity: Activity = { facts: ['shell:bash'], days: [], badges: { 'first-lab': 10 }, prefs: { weeklyGoal: 3 }, prefsAt: 50, practice: ['2026-10-20'] };
  const local = settingsFromLocal(activity, 'dark');
  const known: SyncSettings = { badges: { value: { 'first-lab': 10 }, updatedAt: 1 } };
  assert.deepEqual(settingsDelta(local, known, 99), {
    prefs: { value: { weeklyGoal: 3 }, updatedAt: 50 },
    theme: { value: 'dark', updatedAt: 99 },
    practice: { value: ['2026-10-20'], updatedAt: 99 },
  });
  // In step with the server: nothing to send
  const synced = mergeSettings(known, settingsDelta(local, known, 99));
  assert.deepEqual(settingsDelta(local, synced, 100), {});

  // Badges earned on another device and a newer "clear" both arrive through the merge
  const server: SyncSettings = { badges: { value: { 'first-lab': 10, 'night-owl': 20 }, updatedAt: 2 } };
  assert.deepEqual(mergeActivity(activity, activityFromSettings(server)).badges, { 'first-lab': 10, 'night-owl': 20 });
  const cleared = mergeActivity(activity, activityFromSettings({ cleared: { value: 500, updatedAt: 500 } }));
  assert.deepEqual([cleared.facts, cleared.badges, cleared.clearedAt], [[], {}, 500]);
});

test('storage keys: account data never shares keys with signed-out data; sign-out removes them all', () => {
  assert.deepEqual(storageKeys(null), { progress: 'certsim:progress:v1', journey: 'certsim:journey:v1', activity: 'certsim:activity:v1', queue: null });
  assert.deepEqual(accountKeys('u1'), {
    progress: 'certsim:acct:u1:progress',
    journey: 'certsim:acct:u1:journey',
    activity: 'certsim:acct:u1:activity',
    queue: 'certsim:acct:u1:queue',
  });
  const store = memoryStore();
  for (const k of [...Object.values(accountKeys('u1')), 'certsim:acct:u1:later', 'certsim:acct:u2:progress', 'certsim:progress:v1']) store.set(k, '{}');
  clearAccountKeys('u1', store);
  assert.deepEqual(store.keys().sort(), ['certsim:acct:u2:progress', 'certsim:progress:v1']);
});

// ---------- The engine against a fake server ----------

test('engine: first sync downloads, then local work is uploaded once', async () => {
  const server = fakeServer();
  server.state('u1').items = [{ kind: 'objective', key: 'lab-a/t1', scope: 'lab:lab-a', epoch: 0, earnedAt: 1 }];
  const d = device(server);
  d.c.user = 'u1';
  const { app, adapter } = fakeApp();
  d.engine.start('u1', adapter);
  await d.engine.syncNow();
  assert.deepEqual(app.keys(), ['objective|lab-a/t1']);
  assert.equal(d.engine.getSnapshot().status, 'synced');

  app.earn('lab-a/t2');
  await d.engine.syncNow();
  assert.deepEqual(server.keysOf('u1'), ['objective|lab-a/t1', 'objective|lab-a/t2']);
  const puts = server.log.filter(l => l.method === 'PUT');
  assert.equal(puts.length, 1);
  assert.deepEqual((puts[0].body as { items: SyncItem[] }).items.map(i => i.key), ['lab-a/t2']);
  // Nothing new: a sync is a plain download
  await d.engine.syncNow();
  assert.equal(server.log.filter(l => l.method === 'PUT').length, 1);
});

test('engine: reset then reconnect across two devices', async () => {
  const server = fakeServer();
  const a = device(server);
  const b = device(server);
  a.c.user = b.c.user = 'u1';
  const A = fakeApp();
  const B = fakeApp();
  a.engine.start('u1', A.adapter);
  b.engine.start('u1', B.adapter);
  A.app.earn('lab-a/t1', 'lab-a/t2', 'lab-b/t1');
  await a.engine.syncNow();
  await b.engine.syncNow();
  assert.deepEqual(B.app.keys(), ['objective|lab-a/t1', 'objective|lab-a/t2', 'objective|lab-b/t1']);

  // B goes offline and keeps working on lab-a
  b.c.online = false;
  B.app.earn('lab-a/t3');
  await b.engine.syncNow();
  assert.equal(b.engine.getSnapshot().status, 'offline');

  // A resets lab-a; work done right after the reset is stamped with the new epoch
  A.app.resetLocal('lab:lab-a');
  a.engine.reset(['lab:lab-a']);
  A.app.earn('lab-a/t1');
  await a.engine.syncNow();
  assert.deepEqual(server.state('u1').epochs, { 'lab:lab-a': 1 });
  assert.deepEqual(server.keysOf('u1'), ['objective|lab-a/t1', 'objective|lab-b/t1']);

  // B reconnects: its old snapshot and offline work do not come back; lab-a is cleared on B
  b.c.online = true;
  await b.engine.syncNow();
  assert.deepEqual(server.keysOf('u1'), ['objective|lab-a/t1', 'objective|lab-b/t1']);
  assert.deepEqual(B.app.keys(), ['objective|lab-a/t1', 'objective|lab-b/t1']);
  assert.deepEqual(B.app.applied.at(-1)?.stale, ['lab:lab-a']);

  // B's work after syncing the reset is kept
  B.app.earn('lab-a/t3');
  await b.engine.syncNow();
  assert.deepEqual(server.keysOf('u1'), ['objective|lab-a/t1', 'objective|lab-a/t3', 'objective|lab-b/t1']);
  // The reset was sent once: a repeat from another tab would carry the old epoch and change nothing
  assert.equal(server.log.filter(l => l.path === 'progress/reset').length, 1);
});

test('engine: two accounts in one browser never share progress', async () => {
  const server = fakeServer();
  const store = memoryStore();
  const d = device(server, store);
  d.c.user = 'user-a';
  const A = fakeApp();
  d.engine.start('user-a', A.adapter);
  A.app.earn('lab-a/t1');
  await d.engine.syncNow();
  assert.ok(store.get(accountKeys('user-a').queue));

  // A signs out: sync stops and A's keys leave the browser
  d.engine.stop();
  clearAccountKeys('user-a', store);
  assert.deepEqual(store.keys().filter(k => k.includes('user-a')), []);

  // B signs in on the same browser with B's own (empty) records
  d.c.user = 'user-b';
  const B = fakeApp();
  d.engine.start('user-b', B.adapter);
  await d.engine.syncNow();
  assert.deepEqual(server.keysOf('user-b'), []);
  assert.deepEqual(B.app.keys(), []);
  assert.ok(server.log.filter(l => l.user === 'user-b').every(l => !JSON.stringify(l.body ?? {}).includes('lab-a')));
  assert.equal(d.engine.getSnapshot().status, 'synced');
});

for (const ignoreAbort of [false, true]) test(`engine: a late response after an account switch is discarded (${ignoreAbort ? 'answer arrives anyway' : 'request aborted'})`, async () => {
  const server = fakeServer();
  server.state('user-a').items = [{ kind: 'objective', key: 'lab-a/secret', scope: 'lab:lab-a', epoch: 0, earnedAt: 1 }];
  const store = memoryStore();
  const d = device(server, store);
  d.c.ignoreAbort = ignoreAbort;
  let release!: () => void;
  d.c.hold = new Promise(r => (release = r));
  d.c.user = 'user-a';
  const A = fakeApp();
  d.engine.start('user-a', A.adapter);
  // A's download is on its way; the learner signs out and B signs in
  const B = fakeApp();
  d.engine.start('user-b', B.adapter);
  d.c.hold = null;
  d.c.user = 'user-b';
  release();
  await d.engine.syncNow();
  assert.deepEqual(A.app.applied, [], "A's answer was dropped");
  assert.deepEqual(B.app.keys(), [], "and none of A's progress reached B");
  assert.equal(store.get(accountKeys('user-a').queue), null, 'nothing was written for A after the switch');
  assert.ok(parseQueue(store.get(accountKeys('user-b').queue)).ready);
});

test('engine: signed-out progress is imported only after Add', async () => {
  const server = fakeServer();
  // The account had reset lab-a before: imported work must still be kept
  server.state('u1').epochs = { 'lab:lab-a': 2 };
  const store = memoryStore();
  const d = device(server, store);
  d.c.user = 'u1';
  const signedOut: LocalItem[] = [{ kind: 'objective', key: 'lab-a/t1' }, { kind: 'lesson', key: 'p1/intro' }];
  const { app, adapter } = fakeApp(signedOut);
  d.engine.start('u1', adapter);
  await d.engine.syncNow();
  assert.equal(d.engine.getSnapshot().importOffered, true);
  assert.deepEqual(server.keysOf('u1'), [], 'nothing is uploaded on its own');
  assert.equal(app.imported, 0);

  await d.engine.importLocal();
  assert.equal(app.imported, 1);
  assert.deepEqual(server.keysOf('u1'), ['lesson|p1/intro', 'objective|lab-a/t1']);
  assert.equal(server.state('u1').items.find(i => i.key === 'lab-a/t1')?.epoch, 2, 'stamped with the account epoch');
  assert.equal(d.engine.getSnapshot().importOffered, false);

  // Asked once per account: "Not now" on another account is remembered too
  const other = device(server, store);
  other.c.user = 'u2';
  const second = fakeApp(signedOut);
  other.engine.start('u2', second.adapter);
  await other.engine.syncNow();
  assert.equal(other.engine.getSnapshot().importOffered, true);
  other.engine.dismissImport();
  assert.equal(other.engine.getSnapshot().importOffered, false);
  assert.deepEqual(server.keysOf('u2'), []);
  other.engine.stop();
  other.engine.start('u2', second.adapter);
  await other.engine.syncNow();
  assert.equal(other.engine.getSnapshot().importOffered, false);
  assert.equal(second.app.imported, 0);
});

test('engine: a 401 (session ended elsewhere) signs out instead of retrying', async () => {
  const server = fakeServer();
  const d = device(server);
  let ended = 0;
  d.engine.onUnauthorized = () => ended++;
  d.engine.start('u1', fakeApp().adapter);
  await d.engine.syncNow();
  assert.ok(ended >= 1);
});
