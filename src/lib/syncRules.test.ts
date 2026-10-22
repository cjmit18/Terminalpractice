import test from 'node:test';
import assert from 'node:assert/strict';
import {
  AccountGate,
  acceptUpload,
  applyReset,
  importItems,
  isItemKey,
  isScope,
  mergeItem,
  mergeItems,
  mergeSettings,
  pendingUploads,
  sanitizeItem,
  sanitizeItems,
  sanitizeSettings,
  scopeOf,
  staleScopes,
  type LocalItem,
  type ProgressState,
  type SyncItem,
} from './syncRules.ts';

const obj = (key: string, epoch = 0, earnedAt = 1000): SyncItem => ({ kind: 'objective', key, scope: scopeOf('objective', key), epoch, earnedAt });
const quiz = (key: string, correct: number, total: number, epoch = 0): SyncItem => ({
  kind: 'quiz', key, scope: scopeOf('quiz', key), epoch, correct, total, earnedAt: 1000,
});
const ids = (items: { kind: string; key: string }[]) => items.map(i => `${i.kind}|${i.key}`);

test('keys and scopes: only the id shapes the app uses; the scope comes from the key', () => {
  assert.ok(isItemKey('lpi-101-1-system-architecture/hw-lspci'));
  assert.ok(isItemKey('lpic1-101/check.1_a'));
  for (const bad of ['', 'a', 'a/b/c', '/b', 'a/', 'A/b', 'a b/c', 'é/x', `a/${'x'.repeat(65)}`, 'a/b\n']) assert.ok(!isItemKey(bad), bad);
  assert.equal(scopeOf('objective', 'lab-1/task'), 'lab:lab-1');
  assert.equal(scopeOf('lesson', 'lpic1-101/intro'), 'path:lpic1-101');
  assert.equal(scopeOf('quiz', 'lpic1-101/check-1'), 'path:lpic1-101');
  assert.ok(isScope('lab:lab-1') && isScope('path:lpic1-101'));
  for (const bad of ['all', 'track:linux', 'lab:', 'lab:Hello world', 'path:a/b']) assert.ok(!isScope(bad), bad);

  // A sent scope is never trusted
  assert.equal(sanitizeItem({ kind: 'objective', key: 'lab-1/t', scope: 'lab:other', epoch: 0 })?.scope, 'lab:lab-1');
  assert.equal(sanitizeItem({ kind: 'objective', key: 'lab-1/t', epoch: 1.5 }), null);
  assert.equal(sanitizeItem({ kind: 'quiz', key: 'p/q', epoch: 0, correct: 3 }), null);
  assert.equal(sanitizeItem({ kind: 'quiz', key: 'p/q', epoch: 0, correct: 3, total: 2 }), null);
  assert.deepEqual(sanitizeItems([{ kind: 'objective', key: 'x', epoch: 0 }]), { items: [], error: 'invalid_items' });
  assert.equal(sanitizeItems(new Array(3).fill(obj('a/b')), 2).error, 'too_many_items');
});

test('merge within one owner: union, best quiz score, earliest time; order-free and idempotent', () => {
  const a = [obj('lab/t1', 0, 500), quiz('p/q', 3, 5)];
  const b = [obj('lab/t1', 0, 300), obj('lab/t2'), quiz('p/q', 4, 5)];
  const ab = mergeItems(a, b);
  assert.deepEqual(ab, mergeItems(b, a));
  assert.deepEqual(mergeItems(ab, ab), ab);
  assert.deepEqual(ids(ab), ['objective|lab/t1', 'objective|lab/t2', 'quiz|p/q']);
  assert.equal(ab[0].earnedAt, 300);
  assert.equal(ab[2].correct, 4);
  // Same fraction: the one out of more questions; a newer epoch replaces an older one
  assert.equal(mergeItem(quiz('p/q', 2, 4), quiz('p/q', 1, 2)).total, 4);
  assert.equal(mergeItem(quiz('p/q', 5, 5, 0), quiz('p/q', 1, 5, 1)).correct, 1);
});

test('reset then reconnect: the old snapshot is dropped, work after syncing the reset is kept', () => {
  // Server and both devices at epoch 0 with lab-a/t1 and t2
  let server: ProgressState = { items: [obj('lab-a/t1'), obj('lab-a/t2'), obj('lab-b/t1')], epochs: {} };
  const knownByB = { ...server.epochs };

  // Device A resets lab-a (it knew epoch 0)
  server = applyReset(server, 'lab:lab-a', 0);
  assert.deepEqual(server.epochs, { 'lab:lab-a': 1 });
  assert.deepEqual(ids(server.items), ['objective|lab-b/t1']);

  // Device B was offline: its snapshot plus new offline work all carry epoch 0
  const fromB = pendingUploads([{ kind: 'objective', key: 'lab-a/t1' }, { kind: 'objective', key: 'lab-a/t3' }], [], knownByB, 2000);
  assert.ok(fromB.every(i => i.epoch === 0));
  const up = acceptUpload(server, fromB);
  server = { items: up.items, epochs: up.epochs };
  assert.deepEqual(ids(server.items), ['objective|lab-b/t1'], 'nothing comes back');
  assert.equal(up.dropped.length, 2);

  // B learns the epoch from the response: lab-a is stale there, so its local copy is cleared
  assert.deepEqual(staleScopes(knownByB, server.epochs), ['lab:lab-a']);
  // Work done after that carries epoch 1 and is kept
  const later = pendingUploads([{ kind: 'objective', key: 'lab-a/t3' }], server.items, server.epochs, 3000);
  assert.equal(later[0].epoch, 1);
  server = { items: acceptUpload(server, later).items, epochs: server.epochs };
  assert.deepEqual(ids(server.items), ['objective|lab-a/t3', 'objective|lab-b/t1']);

  // The same reset again (another tab, a retry) is a no-op; epochs never go down
  const again = applyReset(server, 'lab:lab-a', 0);
  assert.deepEqual(again, server);
  assert.deepEqual(applyReset(server, 'lab:lab-a').epochs, { 'lab:lab-a': 2 });
});

test('pending uploads: only what the server copy does not cover', () => {
  const server = [obj('lab/t1'), quiz('p/q', 3, 5)];
  const local: LocalItem[] = [
    { kind: 'objective', key: 'lab/t1' },
    { kind: 'objective', key: 'lab/t2' },
    { kind: 'quiz', key: 'p/q', correct: 2, total: 5 },
    { kind: 'quiz', key: 'p/other', correct: 5, total: 5 },
    { kind: 'objective', key: 'not a key' },
  ];
  assert.deepEqual(ids(pendingUploads(local, server, { 'path:p': 3 }, 9)), ['objective|lab/t2', 'quiz|p/other']);
  const better = pendingUploads([{ kind: 'quiz', key: 'p/q', correct: 4, total: 5 }], server, { 'path:p': 3 }, 9);
  assert.deepEqual(better, [{ kind: 'quiz', key: 'p/q', scope: 'path:p', epoch: 3, correct: 4, total: 5, earnedAt: 9 }]);
});

test('import only after Add: stamped with the account epochs at that moment', () => {
  const local: LocalItem[] = [{ kind: 'objective', key: 'lab/t1' }, { kind: 'lesson', key: 'p/intro' }];
  assert.deepEqual(importItems(null, local, {}, 5), []);
  assert.deepEqual(importItems('not-now', local, {}, 5), []);
  const added = importItems('add', local, { 'lab:lab': 4 }, 5);
  assert.deepEqual(added.map(i => [i.key, i.epoch]), [['p/intro', 0], ['lab/t1', 4]]);
  // So the server keeps them even though the scope was reset before
  const server = acceptUpload({ items: [], epochs: { 'lab:lab': 4 } }, added);
  assert.equal(server.items.length, 2);
});

test('two accounts in one browser / late response after a switch: the gate drops old answers', () => {
  const gate = new AccountGate();
  gate.switchTo('user-a');
  const forA = gate.ticket();
  assert.ok(gate.isCurrent(forA));
  // A signs out, B signs in while A's request is still on its way
  gate.switchTo(null);
  assert.ok(!gate.isCurrent(forA));
  gate.switchTo('user-b');
  assert.ok(!gate.isCurrent(forA), "A's late answer is not B's");
  assert.ok(gate.isCurrent(gate.ticket()));
  // Switching back to A later is a new generation too: the old request still does not count
  gate.switchTo('user-a');
  assert.ok(!gate.isCurrent(forA));
  // Signed out, nothing is current
  gate.switchTo(null);
  assert.ok(!gate.isCurrent(gate.ticket()));
});

test('settings: newest write per field wins; malformed or free-text values are refused', () => {
  const a = { theme: { value: 'dark' as const, updatedAt: 5 }, badges: { value: { 'first-lab': 1 }, updatedAt: 9 } };
  const b = { theme: { value: 'light' as const, updatedAt: 7 }, badges: { value: {}, updatedAt: 3 }, cleared: { value: 4, updatedAt: 4 } };
  const m = mergeSettings(a, b);
  assert.deepEqual(m, { theme: b.theme, badges: a.badges, cleared: b.cleared });
  assert.deepEqual(mergeSettings(b, a), m);
  // A tie is decided by the value, so both orders agree
  const t1 = { theme: { value: 'dark' as const, updatedAt: 1 } };
  const t2 = { theme: { value: 'light' as const, updatedAt: 1 } };
  assert.deepEqual(mergeSettings(t1, t2), mergeSettings(t2, t1));

  assert.equal(sanitizeSettings({ theme: { value: 'neon', updatedAt: 1 } }, true), null);
  assert.equal(sanitizeSettings({ notes: { value: 'hello', updatedAt: 1 } }, true), null);
  assert.equal(sanitizeSettings({ badges: { value: { 'Bad Id!': 1 }, updatedAt: 1 } }, true), null);
  assert.equal(sanitizeSettings({ practice: { value: ['yesterday'], updatedAt: 1 } }, true), null);
  assert.equal(sanitizeSettings({ prefs: { value: { weeklyGoal: 3 }, updatedAt: 0 } }, true), null);
  // Unknown pref fields are dropped, never stored
  assert.deepEqual(sanitizeSettings({ prefs: { value: { weeklyGoal: 3, sandboxHost: 'My Secret Host' }, updatedAt: 1 } }, true), {
    prefs: { value: { weeklyGoal: 3 }, updatedAt: 1 },
  });
  assert.deepEqual(sanitizeSettings({ practice: { value: ['2026-10-21', '2026-10-20', '2026-10-21'], updatedAt: 2 } }), {
    practice: { value: ['2026-10-20', '2026-10-21'], updatedAt: 2 },
  });
});
