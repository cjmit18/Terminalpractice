import test from 'node:test';
import assert from 'node:assert/strict';
import type { LearningPath } from '../types/paths.ts';
import type { ExamModule } from '../types/modules.ts';
import {
  CompletionSource,
  EMPTY_JOURNEY,
  Journey,
  correctNeeded,
  currentStageIndex,
  formatMinutes,
  labCheck,
  labPlacements,
  markRead,
  mergeJourney,
  nextStep,
  parseJourney,
  pathMinutes,
  pathPercent,
  pathStarted,
  recordQuizScore,
  resetPath,
  resumeTarget,
  sanitizeJourney,
  serializeJourney,
  stageComplete,
  stageUnlocked,
  stepAfter,
  stepComplete,
  stepUnlocked,
  visit,
} from './journey.ts';
import { parseHash, routeHref, learnHref } from './router.ts';

const PATH: LearningPath = {
  id: 'p',
  track: 'linux',
  title: 'Path',
  summary: '',
  exam: '',
  audience: '',
  stages: [
    {
      id: 's1',
      title: 'One',
      goal: '',
      steps: [
        { kind: 'lesson', id: 'l1', title: 'L1', minutes: 4, blocks: [{ type: 'p', text: 'x' }] },
        { kind: 'lab', id: 'lab1', moduleId: 'm1' },
        {
          kind: 'quiz',
          id: 'q1',
          title: 'Q1',
          passMark: 0.75,
          questions: [1, 2, 3, 4].map(n => ({ id: `q${n}`, prompt: '', choices: ['a', 'b'], answer: 0, explanation: 'e' })),
        },
      ],
    },
    {
      id: 's2',
      title: 'Two',
      goal: '',
      steps: [
        { kind: 'lesson', id: 'l2', title: 'L2', minutes: 3, blocks: [{ type: 'p', text: 'y' }] },
        { kind: 'lab', id: 'lab2', moduleId: 'm2' },
      ],
    },
  ],
};

const mod = (id: string, objectives: string[], estimatedMinutes = 10) =>
  ({ id, estimatedMinutes, objectives: objectives.map(o => ({ id: o })) }) as unknown as ExamModule;
const MODULES = [mod('m1', ['a', 'b'], 15), mod('m2', ['c'], 20)];

const src = (journey: Journey, progress: Record<string, string[]> = {}): CompletionSource => ({
  journey,
  labComplete: labCheck(progress, MODULES),
});

const stage1Done = () => {
  let j = markRead(EMPTY_JOURNEY, 'p', 'l1');
  j = recordQuizScore(j, 'p', 'q1', { correct: 3, total: 4 });
  return src(j, { m1: ['a', 'b'] });
};

test('Journey: step completion by kind', () => {
  const [l1, lab1, q1] = PATH.stages[0].steps;
  assert.equal(stepComplete('p', l1, src(EMPTY_JOURNEY)), false);
  assert.equal(stepComplete('p', l1, src(markRead(EMPTY_JOURNEY, 'p', 'l1'))), true);
  // A lesson read in another path does not count here
  assert.equal(stepComplete('p', l1, src(markRead(EMPTY_JOURNEY, 'other', 'l1'))), false);

  assert.equal(stepComplete('p', lab1, src(EMPTY_JOURNEY, { m1: ['a'] })), false);
  assert.equal(stepComplete('p', lab1, src(EMPTY_JOURNEY, { m1: ['b', 'a'] })), true);

  assert.equal(stepComplete('p', q1, src(recordQuizScore(EMPTY_JOURNEY, 'p', 'q1', { correct: 2, total: 4 }))), false);
  assert.equal(stepComplete('p', q1, src(recordQuizScore(EMPTY_JOURNEY, 'p', 'q1', { correct: 3, total: 4 }))), true);
  assert.equal(correctNeeded(4, 0.75), 3);
  assert.equal(correctNeeded(2, 0.5), 1);
  assert.equal(correctNeeded(5, 0.8), 4);
});

test('Journey: best quiz score is kept', () => {
  let j = recordQuizScore(EMPTY_JOURNEY, 'p', 'q1', { correct: 3, total: 4 });
  j = recordQuizScore(j, 'p', 'q1', { correct: 1, total: 4 });
  assert.deepEqual(j.quiz['p/q1'], { correct: 3, total: 4 });
  j = recordQuizScore(j, 'p', 'q1', { correct: 4, total: 4 });
  assert.deepEqual(j.quiz['p/q1'], { correct: 4, total: 4 });
});

test('Journey: stage completion and unlocking', () => {
  const s = src(markRead(EMPTY_JOURNEY, 'p', 'l1'), { m1: ['a', 'b'] });
  assert.equal(stageComplete('p', PATH.stages[0], s), false);
  assert.equal(stageUnlocked(PATH, 0, s), true);
  assert.equal(stageUnlocked(PATH, 1, s), false);
  assert.equal(stepUnlocked(PATH, 'l2', s), false);

  const done = stage1Done();
  assert.equal(stageComplete('p', PATH.stages[0], done), true);
  assert.equal(stageUnlocked(PATH, 1, done), true);
  assert.equal(stepUnlocked(PATH, 'lab2', done), true);
  assert.equal(stepUnlocked(PATH, 'nope', done), false);
});

test('Journey: percent, current stage and next step', () => {
  const empty = src(EMPTY_JOURNEY);
  assert.equal(pathPercent(PATH, empty), 0);
  assert.equal(currentStageIndex(PATH, empty), 0);
  assert.equal(nextStep(PATH, empty)?.step.id, 'l1');

  // Steps inside a stage can be done in any order: the next step is the first one still open
  const partial = src(markRead(EMPTY_JOURNEY, 'p', 'l1'));
  assert.equal(nextStep(PATH, partial)?.step.id, 'lab1');
  assert.equal(pathPercent(PATH, partial), 20);

  const done = stage1Done();
  assert.equal(pathPercent(PATH, done), 60);
  assert.equal(currentStageIndex(PATH, done), 1);
  assert.equal(nextStep(PATH, done)?.step.id, 'l2');

  // Work done in a locked stage does not move the next step past an unfinished earlier stage
  const skipped = src(markRead(EMPTY_JOURNEY, 'p', 'l2'), { m1: ['a', 'b'], m2: ['c'] });
  assert.equal(nextStep(PATH, skipped)?.step.id, 'l1');

  const all = src(stage1Done().journey, { m1: ['a', 'b'], m2: ['c'] });
  const finished = src(markRead(all.journey, 'p', 'l2'), { m1: ['a', 'b'], m2: ['c'] });
  assert.equal(pathPercent(PATH, finished), 100);
  assert.equal(currentStageIndex(PATH, finished), -1);
  assert.equal(nextStep(PATH, finished), null);
});

test('Journey: step after the current one', () => {
  const s = src(markRead(EMPTY_JOURNEY, 'p', 'l1'));
  assert.equal(stepAfter(PATH, 'l1', s)?.step.id, 'lab1');
  // Skips steps already done
  const labDone = src(markRead(EMPTY_JOURNEY, 'p', 'l1'), { m1: ['a', 'b'] });
  assert.equal(stepAfter(PATH, 'l1', labDone)?.step.id, 'q1');
  // The quiz is the last step of stage 1 but the lab is still open: go back to it, not into a locked stage
  assert.equal(stepAfter(PATH, 'q1', s)?.step.id, 'lab1');
  // Stage 1 done: crosses into stage 2
  assert.equal(stepAfter(PATH, 'q1', stage1Done())?.step.id, 'l2');
});

test('Journey: started and resume target', () => {
  assert.equal(pathStarted(PATH, src(EMPTY_JOURNEY)), false);
  assert.equal(resumeTarget([PATH], src(EMPTY_JOURNEY)), null);
  const visited = visit(EMPTY_JOURNEY, 'p', 'q1');
  assert.equal(pathStarted(PATH, src(visited)), true);
  assert.equal(resumeTarget([PATH], src(visited))?.loc.step.id, 'q1');
  // Last step finished: resume at the next open step instead
  const after = recordQuizScore(visited, 'p', 'q1', { correct: 4, total: 4 });
  assert.equal(resumeTarget([PATH], src(after))?.loc.step.id, 'l1');
  // A lab finished elsewhere counts as starting the path
  assert.equal(pathStarted(PATH, src(EMPTY_JOURNEY, { m1: ['a', 'b'] })), true);
});

test('Journey: sanitize drops unknown and malformed data', () => {
  const raw = {
    read: ['p/l1', 'p/lab1', 'p/q1', 'x/l1', 'p/zzz', 42],
    quiz: {
      'p/q1': { correct: 3, total: 4 },
      'p/l1': { correct: 1, total: 1 },
      'x/q1': { correct: 1, total: 1 },
    },
    last: { pathId: 'p', stepId: 'gone' },
  };
  assert.deepEqual(sanitizeJourney(raw, [PATH]), {
    read: ['p/l1'],
    quiz: { 'p/q1': { correct: 3, total: 4 } },
    last: { pathId: 'p', stepId: null },
  });
  assert.deepEqual(sanitizeJourney({ quiz: { 'p/q1': { correct: 5, total: 4 } } }, [PATH]).quiz, {});
  assert.deepEqual(sanitizeJourney({ quiz: { 'p/q1': { correct: 1.5, total: 4 } } }, [PATH]).quiz, {});
  assert.equal(sanitizeJourney({ last: { pathId: 'x', stepId: 'l1' } }, [PATH]).last, null);
  assert.deepEqual(sanitizeJourney(null, [PATH]), EMPTY_JOURNEY);
  assert.deepEqual(sanitizeJourney([1, 2], [PATH]), EMPTY_JOURNEY);
  assert.deepEqual(sanitizeJourney('text', [PATH]), EMPTY_JOURNEY);
});

test('Journey: reset one path keeps the others', () => {
  let j = markRead(EMPTY_JOURNEY, 'p', 'l1');
  j = markRead(j, 'other', 'x');
  j = recordQuizScore(j, 'p', 'q1', { correct: 1, total: 4 });
  j = visit(j, 'p', 'l1', 100);
  assert.deepEqual(resetPath(j, 'p', 5000), { read: ['other/x'], quiz: {}, last: null, resets: { p: 5000 } });
});

test('Journey merge: union of reads, best quiz score, newest last', () => {
  const a: Journey = { read: ['p/l2'], quiz: { 'p/q1': { correct: 4, total: 4 } }, last: { pathId: 'p', stepId: 'l2', at: 200 } };
  const b: Journey = { read: ['p/l1'], quiz: { 'p/q1': { correct: 2, total: 4 } }, last: { pathId: 'p', stepId: 'q1', at: 100 } };
  const m = mergeJourney(a, b, [PATH]);
  assert.deepEqual(m.read, ['p/l1', 'p/l2']);
  assert.deepEqual(m.quiz, { 'p/q1': { correct: 4, total: 4 } });
  assert.deepEqual(m.last, { pathId: 'p', stepId: 'l2', at: 200 });
  // Order of the arguments does not matter, and merging again changes nothing
  assert.deepEqual(mergeJourney(b, a, [PATH]), m);
  assert.deepEqual(mergeJourney(m, m, [PATH]), m);
  // A last without a time (older data) loses to one with a time
  assert.deepEqual(mergeJourney({ ...a, last: { pathId: 'p', stepId: 'l1' } }, b, [PATH]).last, b.last);
  assert.deepEqual(mergeJourney(EMPTY_JOURNEY, EMPTY_JOURNEY, [PATH]), EMPTY_JOURNEY);
});

test('Journey merge: a reset in one tab is not undone by a tab that has not seen it', () => {
  let stale = markRead(EMPTY_JOURNEY, 'p', 'l1');
  stale = recordQuizScore(stale, 'p', 'q1', { correct: 4, total: 4 });
  stale = visit(stale, 'p', 'q1', 100);
  const reset = resetPath(stale, 'p', 1000);
  // Tab 2 still has its old copy and saves: the stored reset wins
  const merged = mergeJourney(reset, stale, [PATH]);
  assert.deepEqual(merged, { read: [], quiz: {}, last: null, resets: { p: 1000 } });
  // After seeing the reset, new work in that path counts again
  const after = markRead(merged, 'p', 'l2');
  assert.deepEqual(mergeJourney(merged, after, [PATH]).read, ['p/l2']);
  // Text round trip keeps the tombstone, so the key is never removed while it matters
  assert.deepEqual(parseJourney(serializeJourney(merged), [PATH]), merged);
  assert.equal(serializeJourney(EMPTY_JOURNEY), null);
});

test('Journey: minutes, formatting and lab placements', () => {
  const byId = new Map(MODULES.map(m => [m.id, m]));
  // 4 + 15 + 4 questions + 3 + 20
  assert.equal(pathMinutes(PATH, byId), 46);
  assert.equal(formatMinutes(46), 'about 46 min');
  assert.equal(formatMinutes(60), 'about 1 hr');
  assert.equal(formatMinutes(131), 'about 2 hr 10 min');
  assert.equal(formatMinutes(178), 'about 3 hr');
  const placed = labPlacements([PATH]);
  assert.equal(placed.get('m2')?.[0].stage.id, 's2');
  assert.equal(placed.get('m2')?.[0].stepId, 'lab2');
  assert.equal(placed.has('m3'), false);
});

test('Router: learning path routes', () => {
  assert.deepEqual(parseHash('#/learn'), { section: 'learn', pathId: null, stepId: null });
  assert.deepEqual(parseHash('#/learn/p'), { section: 'learn', pathId: 'p', stepId: null });
  assert.deepEqual(parseHash('#/learn/p/l1'), { section: 'learn', pathId: 'p', stepId: 'l1' });
  assert.equal(parseHash('#/learn/p/l1/x'), null);
  assert.equal(parseHash(''), null);
  assert.deepEqual(parseHash('#/linux/abc'), { section: 'linux', moduleId: 'abc' });
  assert.deepEqual(parseHash('#/sandbox'), { section: 'sandbox' });
  assert.equal(routeHref({ section: 'learn', pathId: 'p', stepId: 'l 1' }), '#/learn/p/l%201');
  assert.equal(learnHref(), '#/learn');
  assert.equal(learnHref('p'), '#/learn/p');
  assert.equal(learnHref(null, 'x'), '#/learn');
});

test('Journey: steps sharing a choiceGroup are alternatives, any one completes them', () => {
  const CHOICE: LearningPath = {
    ...PATH,
    stages: [
      {
        id: 's1',
        title: 'One',
        goal: '',
        steps: [
          { kind: 'lesson', id: 'l1', title: 'L1', minutes: 4, blocks: [{ type: 'p', text: 'x' }] },
          { kind: 'lab', id: 'lab1', moduleId: 'm1', choiceGroup: 'pick' },
          { kind: 'lab', id: 'lab2', moduleId: 'm2', choiceGroup: 'pick' },
        ],
      },
    ],
  };
  const read = markRead(EMPTY_JOURNEY, 'p', 'l1');
  const none = src(read);
  assert.equal(stageComplete('p', CHOICE.stages[0], none), false);
  assert.equal(pathPercent(CHOICE, none), 50);
  assert.equal(nextStep(CHOICE, none)?.step.id, 'lab1');
  assert.equal(pathMinutes(CHOICE, new Map(MODULES.map(m => [m.id, m]))), 4 + 15);
  for (const progress of [{ m1: ['a', 'b'] }, { m2: ['c'] }] as Record<string, string[]>[]) {
    const s = src(read, progress);
    assert.equal(stageComplete('p', CHOICE.stages[0], s), true);
    assert.equal(currentStageIndex(CHOICE, s), -1);
    assert.equal(pathPercent(CHOICE, s), 100);
    assert.equal(stepAfter(CHOICE, 'l1', s), null);
  }
});
