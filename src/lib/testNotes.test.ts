import test from 'node:test';
import assert from 'node:assert/strict';
import { notesInBuild } from './testNotes.ts';
import type { TestNote } from '../data/testing/types.ts';

const note = (pr: number): TestNote => ({ pr, title: `PR ${pr}`, steps: [], links: [] });
const pr = (number: number) => ({ number, title: '', url: '' });

test('the testing page shows only changes the build holds', () => {
  const notes = [note(43), note(39), note(35)];
  // 43 merged into this build, 39 left out (a conflict), 35 no longer open
  assert.deepEqual(notesInBuild(notes, { included: [pr(43)] }).map(n => n.pr), [43]);
});

test('a PR closed without merging is not offered: no longer open says nothing about main', () => {
  // The builder sees only open pull requests, so a closed PR is in neither list, merged or not
  assert.deepEqual(notesInBuild([note(39)], { included: [] }), []);
});

test('without build details (a local build) every note is shown', () => {
  assert.deepEqual(notesInBuild([note(1), note(2)], null).map(n => n.pr), [1, 2]);
});
