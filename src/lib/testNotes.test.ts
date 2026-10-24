import test from 'node:test';
import assert from 'node:assert/strict';
import { notesInBuild } from './testNotes.ts';
import type { TestNote } from '../data/testing/types.ts';

const note = (pr: number): TestNote => ({ pr, title: `PR ${pr}`, steps: [], links: [] });
const pr = (number: number) => ({ number, title: '', url: '' });

test('the testing page shows only changes the build holds: a skipped PR is hidden, a merged one is marked', () => {
  const notes = [note(43), note(39), note(35)];
  // 43 merged into this build, 39 left out (a conflict), 35 no longer open: merged into main
  const shown = notesInBuild(notes, { included: [pr(43)], skipped: [{ ...pr(39), reason: 'conflicts' }] });
  assert.deepEqual(shown.map(s => [s.note.pr, s.inMain]), [[43, false], [35, true]]);
});

test('without build details (a local build) every note is shown', () => {
  assert.deepEqual(notesInBuild([note(1), note(2)], null).map(s => s.note.pr), [1, 2]);
});
