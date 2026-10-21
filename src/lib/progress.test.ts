import test from 'node:test';
import assert from 'node:assert/strict';
import type { ExamModule } from '../types/modules.ts';
import {
  EMPTY_PROGRESS,
  ProgressRecord,
  completeObjective,
  mergeProgress,
  parseProgress,
  resetModules,
  serializeProgress,
} from './progress.ts';

const mod = (id: string, objectives: string[]) => ({ id, objectives: objectives.map(o => ({ id: o })) }) as unknown as ExamModule;
const MODULES = [mod('m1', ['a', 'b', 'c']), mod('m2', ['x', 'y']), mod('m3', ['z'])];

test('Progress merge: union of objectives per module, in objective order', () => {
  // The two-tab case from the fact-check: tab 1 saved m1, tab 2 still had an empty copy and adds m2
  const tab1: ProgressRecord = { done: { m1: ['c', 'a'] }, resetAt: {} };
  const tab2: ProgressRecord = { done: { m1: ['b'], m2: ['x'] }, resetAt: {} };
  const m = mergeProgress(tab1, tab2, MODULES);
  assert.deepEqual(m, { done: { m1: ['a', 'b', 'c'], m2: ['x'] }, resetAt: {} });
  assert.deepEqual(mergeProgress(tab2, tab1, MODULES), m);
  assert.deepEqual(mergeProgress(m, m, MODULES), m);
  assert.deepEqual(mergeProgress(EMPTY_PROGRESS, EMPTY_PROGRESS, MODULES), EMPTY_PROGRESS);
});

test('Progress merge: a reset reaches every tab and is not undone by a stale copy', () => {
  const stale: ProgressRecord = { done: { m1: ['a', 'b'], m2: ['x'] }, resetAt: {} };
  const reset = resetModules(stale, ['m1'], 1000);
  assert.deepEqual(reset, { done: { m2: ['x'] }, resetAt: { m1: 1000 } });

  // Tab 2 has not seen the reset; whichever side is the stored one, m1 stays reset and m2 stays
  assert.deepEqual(mergeProgress(reset, stale, MODULES), reset);
  assert.deepEqual(mergeProgress(stale, reset, MODULES), reset);

  // Work done after seeing the reset counts again
  const after = completeObjective(mergeProgress(reset, stale, MODULES), 'm1', 'c');
  assert.deepEqual(mergeProgress(reset, after, MODULES).done, { m1: ['c'], m2: ['x'] });

  // Resetting again is always newer than the last reset, even if the clock went back
  assert.equal(resetModules(reset, ['m1'], 10).resetAt.m1, 1001);
});

test('Progress text: tombstones survive a round trip; older data without them still loads', () => {
  const r = resetModules({ done: { m2: ['y'] }, resetAt: {} }, ['m1'], 1000);
  const text = serializeProgress(r);
  assert.ok(text);
  assert.deepEqual(parseProgress(text, MODULES), r);
  // A reset with nothing left still keeps the key, so a later merge sees the tombstone
  assert.ok(serializeProgress(resetModules(EMPTY_PROGRESS, ['m1'], 5)));
  assert.equal(serializeProgress(EMPTY_PROGRESS), null);
  assert.deepEqual(parseProgress('{"m1":["b","a","nope"],"zz":["q"]}', MODULES), { done: { m1: ['a', 'b'] }, resetAt: {} });
  assert.deepEqual(parseProgress('{"#resetAt":{"m1":"soon","m3":-1}}', MODULES), EMPTY_PROGRESS);
  assert.deepEqual(parseProgress('not json', MODULES), EMPTY_PROGRESS);
});
