import { test } from 'node:test';
import assert from 'node:assert/strict';
import { freshOrder, shuffled } from './rotation.ts';

const items = Array.from({ length: 12 }, (_, i) => `q${i}`);

test('shuffled keeps every item, is fixed by its seed, and differs between seeds', () => {
  for (const seed of [0, 1, 42, 2 ** 31, 2 ** 32 - 1]) {
    const order = shuffled(items, seed);
    assert.deepEqual([...order].sort(), [...items].sort());
    assert.deepEqual(shuffled(items, seed), order, 'same seed, same order');
  }
  assert.ok(new Set([1, 2, 3, 4, 5, 6].map(seed => shuffled(items, seed).join())).size > 1);
  assert.deepEqual(items, Array.from({ length: 12 }, (_, i) => `q${i}`), 'the input is not changed');
});

test('freshOrder never repeats the previous order, even when the seed would', () => {
  let previous: string[] | null = null;
  for (let attempt = 0; attempt < 50; attempt++) {
    const order: string[] = freshOrder(items, previous);
    assert.deepEqual([...order].sort(), [...items].sort());
    if (previous) assert.notDeepEqual(order, previous);
    previous = order;
  }
  // A stuck random source still gets a different order
  const stuck = shuffled(items, 7);
  assert.notDeepEqual(freshOrder(items, stuck, () => 7), stuck);
  // One question has only one order
  assert.deepEqual(freshOrder(['only'], ['only']), ['only']);
});
