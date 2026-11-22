import test from 'node:test';
import assert from 'node:assert/strict';
import { nextSubnetSeed } from './next.ts';
import { generateSubnetQuestion } from './subnet.ts';

test('next drill: never repeats the question just asked', () => {
  // The review's case: seeds 6 and 10 both ask for the host count of a /27
  const prompt = generateSubnetQuestion(6).prompt;
  assert.equal(generateSubnetQuestion(10).prompt, prompt);
  const offered = [10, 11, 10, 12];
  const seed = nextSubnetSeed(prompt, () => offered.shift()!);
  assert.equal(seed, 12, 'seeds that repeat the question (10 and 11 here) are skipped');
  assert.notEqual(generateSubnetQuestion(seed).prompt, prompt);

  // With no question before it, the first seed is taken
  assert.equal(nextSubnetSeed(null, () => 10), 10);

  // Over many real draws the next prompt always differs
  let previous = generateSubnetQuestion(6).prompt;
  for (let i = 0; i < 2000; i++) {
    const next = generateSubnetQuestion(nextSubnetSeed(previous)).prompt;
    assert.notEqual(next, previous);
    previous = next;
  }
});
