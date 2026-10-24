import test from 'node:test';
import assert from 'node:assert/strict';
import { LPI_MODULES } from './lpiModules.ts';
import { WINDOWS_PBQS } from './windowsPbqs.ts';
import { CHALLENGES } from './challenges.ts';

// Task text, nudges and hints mark what to type with `backticks`, shown as code. An unpaired backtick
// would swallow the rest of the sentence into code, or print a stray ` on screen.
const shown = [
  ...[...LPI_MODULES, ...WINDOWS_PBQS].flatMap(m =>
    m.objectives.flatMap(o => [o.description, o.nudge, o.hint].filter((t): t is string => !!t).map(t => ({ where: `${m.id}/${o.id}`, t })))),
  ...CHALLENGES.map(c => ({ where: `challenge ${c.id}`, t: c.hint })),
];

test('every backtick in task text, nudges and hints has a partner', () => {
  for (const { where, t } of shown) assert.equal((t.match(/`/g) ?? []).length % 2, 0, `${where}: ${t}`);
});

test('a command named like an English word is marked as code, so the sentence reads clearly', () => {
  // "Here type is the name of a command" and "Type type welcome.txt" read as nonsense without it
  const read = WINDOWS_PBQS.flatMap(m => m.objectives).find(o => o.id === 'fs-read' && /welcome\.txt/.test(o.hint))!;
  for (const t of [read.description, read.nudge!, read.hint]) {
    assert.doesNotMatch(t, /\b[Tt]ype type\b/, t);
    assert.match(t, /`type( welcome\.txt)?`/, t);
  }
});
