import test from 'node:test';
import assert from 'node:assert/strict';
import type { ExamModule } from '../types/modules.ts';
import type { LearningPath } from '../types/paths.ts';
import { linuxSession } from '../terminal/testUtils.ts';
import { LEARNING_PATHS } from './paths.ts';
import { ALL_MODULES } from '../lib/modules.ts';
import { EMPTY_JOURNEY, Journey } from '../lib/journey.ts';
import { Activity, CommandOutcome, EMPTY_ACTIVITY, addFacts, classifyCommand, earnBadges } from '../lib/activity.ts';
import { BadgeInputs, allBadges, newlyEarned, pathBadgeId } from './badges.ts';

const BADGES = allBadges(LEARNING_PATHS);
const inputs = (activity: Activity, over: Partial<BadgeInputs> = {}): BadgeInputs => ({
  activity,
  progress: {},
  journey: EMPTY_JOURNEY,
  paths: LEARNING_PATHS,
  modules: ALL_MODULES,
  ...over,
});

test('Badges: the starter set is complete, with stable unique ids and calm copy', () => {
  const ids = BADGES.map(b => b.id);
  assert.equal(new Set(ids).size, ids.length, 'ids are unique');
  assert.ok(BADGES.length >= 24, `at least 24 badges, got ${BADGES.length}`);
  for (const b of BADGES) {
    assert.ok(b.name.trim(), b.id);
    for (const text of [b.name, b.description, b.howTo]) assert.ok(!text.includes('!'), `no exclamation marks: ${b.id}`);
    assert.match(b.description, /\.$/, `description is a sentence: ${b.id}`);
    assert.match(b.description, /^You /, `second person: ${b.id}`);
  }
  // One per path, computed from the paths, so a new path (first steps) gets one without an edit here
  for (const p of LEARNING_PATHS) assert.ok(ids.includes(pathBadgeId(p.id)), p.id);
  for (const id of ['first-lab', 'checkpoint', 'stage-clear', 'try-again', 'typo-fixed', 'permission-granted', 'man-man', 'tab']) {
    assert.ok(ids.includes(id), id);
  }
  assert.ok(BADGES.some(b => b.hidden), 'a few are surprises');
});

test('Badges: repeating one command fifty times earns at most "hello, world"', () => {
  const run = linuxSession();
  let activity = EMPTY_ACTIVITY;
  let prev: CommandOutcome | undefined;
  for (let i = 0; i < 50; i++) {
    const res = run('ls');
    const outcome: CommandOutcome = { line: 'ls', exitCode: res.exitCode, stdout: res.stdout, stderr: res.stderr };
    activity = addFacts(activity, classifyCommand(outcome, 'bash', prev), '2026-10-21');
    prev = outcome;
  }
  assert.deepEqual(newlyEarned(BADGES, inputs(activity)), ['hello-world']);
});

test('Badges: earned once, kept on later checks, and survive a lab reset of progress', () => {
  const lab = ALL_MODULES[0];
  const progress = { [lab.id]: lab.objectives.map(o => o.id) };
  const first = newlyEarned(BADGES, inputs(EMPTY_ACTIVITY, { progress }));
  assert.ok(first.includes('first-lab'));
  const saved = earnBadges(EMPTY_ACTIVITY, first, 1000);
  assert.deepEqual(newlyEarned(BADGES, inputs(saved, { progress })), []);
  // Progress reset: nothing new is earned, and nothing earned is taken away (badges live in the activity record)
  assert.deepEqual(newlyEarned(BADGES, inputs(saved, { progress: {} })), []);
  assert.equal(saved.badges['first-lab'], 1000);
});

test('Badges: recovery and hint badges come from facts plus progress', () => {
  const lab = ALL_MODULES[0];
  const obj = lab.objectives[0];
  const hinted = addFacts(EMPTY_ACTIVITY, [`hint:${lab.id}/${obj.id}`, `reset:${lab.id}`], '2026-10-01');
  assert.ok(!newlyEarned(BADGES, inputs(hinted)).includes('hints-are-tools'));
  const partly = { [lab.id]: [obj.id] };
  assert.ok(newlyEarned(BADGES, inputs(hinted, { progress: partly })).includes('hints-are-tools'));
  assert.ok(!newlyEarned(BADGES, inputs(hinted, { progress: partly })).includes('fresh-start'));
  const all = { [lab.id]: lab.objectives.map(o => o.id) };
  assert.ok(newlyEarned(BADGES, inputs(hinted, { progress: all })).includes('fresh-start'));

  const twoDays = addFacts(hinted, [], '2026-10-02');
  assert.ok(newlyEarned(BADGES, inputs(twoDays)).includes('welcome-back'));
  assert.ok(!newlyEarned(BADGES, inputs(hinted)).includes('welcome-back'));
});

test('Badges: Second wind, Checkpoint, Stage clear and the path badge', () => {
  const lab: ExamModule = { ...ALL_MODULES[0], id: 'lab-x', objectives: [ALL_MODULES[0].objectives[0]] };
  const path: LearningPath = {
    id: 'mini',
    track: 'linux',
    title: 'Mini path',
    summary: '',
    exam: '',
    audience: '',
    stages: [
      {
        id: 's1',
        title: 'Only stage',
        goal: '',
        steps: [
          { kind: 'lab', id: 'l', moduleId: 'lab-x' },
          { kind: 'quiz', id: 'q', title: 'Check', passMark: 0.5, questions: [] },
        ],
      },
    ],
  };
  const badges = allBadges([path]);
  const missed = addFacts(EMPTY_ACTIVITY, ['quizmiss:mini/q'], '2026-10-01');
  const passed: Journey = { ...EMPTY_JOURNEY, quiz: { 'mini/q': { correct: 1, total: 1 } } };
  const base = { paths: [path], modules: [lab] };

  assert.deepEqual(newlyEarned(badges, inputs(missed, base)), []);
  const quizOnly = newlyEarned(badges, inputs(missed, { ...base, journey: passed }));
  assert.ok(quizOnly.includes('second-wind') && quizOnly.includes('checkpoint'));
  assert.ok(!quizOnly.includes('stage-clear') && !quizOnly.includes('path:mini'));

  const everything = newlyEarned(badges, inputs(missed, { ...base, journey: passed, progress: { 'lab-x': [lab.objectives[0].id] } }));
  for (const id of ['first-lab', 'stage-clear', 'path:mini']) assert.ok(everything.includes(id), id);
  assert.equal(badges.find(b => b.id === 'path:mini')?.name, 'Mini path: done');
});
