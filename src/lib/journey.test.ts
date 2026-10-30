import test from 'node:test';
import assert from 'node:assert/strict';
import type { LearningPath } from '../types/paths.ts';
import type { ExamModule } from '../types/modules.ts';
import {
  ANSWER_HISTORY,
  CompletionSource,
  EMPTY_JOURNEY,
  Journey,
  correctNeeded,
  currentStageIndex,
  formatMinutes,
  labCheck,
  labPlacements,
  lessonsToTestOut,
  markRead,
  mergeJourney,
  nextStep,
  parseJourney,
  pathMinutes,
  pathPercent,
  pathStarted,
  comeBackText,
  recordAnswer,
  recordQuizScore,
  resetPath,
  resumeTarget,
  reviewInterval,
  reviewQueue,
  reviewStatus,
  stageSuggested,
  stepSuggested,
  suggestedAfter,
  sanitizeJourney,
  sanitizeJourneyRecord,
  serializeJourney,
  stageComplete,
  stepAfter,
  stepComplete,
  visit,
} from './journey.ts';
import { parseHash, routeHref, learnHref, reviewHref } from './router.ts';
import { LEARNING_PATHS } from '../data/paths.ts';

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

test('Journey: stage completion and the suggested order (nothing is locked)', () => {
  const s = src(markRead(EMPTY_JOURNEY, 'p', 'l1'), { m1: ['a', 'b'] });
  assert.equal(stageComplete('p', PATH.stages[0], s), false);
  assert.equal(stageSuggested(PATH, 0, s), true);
  assert.equal(stageSuggested(PATH, 1, s), false);
  assert.equal(stepSuggested(PATH, 'l2', s), false);
  // "Suggested after One": the stage before it
  assert.equal(suggestedAfter(PATH, 1, s)?.id, 's1');
  assert.equal(suggestedAfter(PATH, 0, s), null);

  const done = stage1Done();
  assert.equal(stageComplete('p', PATH.stages[0], done), true);
  assert.equal(stageSuggested(PATH, 1, done), true);
  assert.equal(suggestedAfter(PATH, 1, done), null);
  assert.equal(stepSuggested(PATH, 'lab2', done), true);
  assert.equal(stepSuggested(PATH, 'nope', done), false);
});

test('Journey: test out marks the unread lessons of a stage as known', () => {
  assert.deepEqual(lessonsToTestOut(PATH, 1, EMPTY_JOURNEY), ['l2']);
  assert.deepEqual(lessonsToTestOut(PATH, 1, markRead(EMPTY_JOURNEY, 'p', 'l2')), []);
  // Labs are never in the list
  assert.deepEqual(lessonsToTestOut(PATH, 0, EMPTY_JOURNEY), ['l1']);
  assert.deepEqual(lessonsToTestOut(PATH, 9, EMPTY_JOURNEY), []);
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
  // Went ahead into stage 2: stays in that stage while it has open steps
  assert.equal(stepAfter(PATH, 'l2', src(markRead(EMPTY_JOURNEY, 'p', 'l2')))?.step.id, 'lab2');
  // ...and then goes back to the suggested order, not further ahead
  assert.equal(stepAfter(PATH, 'lab2', src(markRead(EMPTY_JOURNEY, 'p', 'l2'), { m2: ['c'] }))?.step.id, 'l1');
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
  // Last opened a step ahead of the suggested order: Continue still follows the suggested order
  assert.equal(resumeTarget([PATH], src(visit(EMPTY_JOURNEY, 'p', 'l2')))?.loc.step.id, 'l1');
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
  assert.deepEqual(parseHash('#/settings'), { section: 'settings' });
  assert.equal(parseHash('#/settings/x'), null);
  assert.equal(routeHref({ section: 'settings' }), '#/settings');
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

test('Journey: what a newer build saved survives parse, merge and save; only known steps are shown', () => {
  const text = JSON.stringify({
    read: ['future-path/intro', 'p/l1', 'p/new-lesson'],
    quiz: { 'future-path/q': { correct: 2, total: 3 } },
    last: { pathId: 'future-path', stepId: 'intro', at: 10 },
    resets: { 'future-path': 5 },
  });
  const stored = parseJourney(text, [PATH]);
  assert.deepEqual(stored.read, ['p/l1', 'future-path/intro', 'p/new-lesson']);
  assert.deepEqual(stored.quiz, { 'future-path/q': { correct: 2, total: 3 } });
  assert.deepEqual(stored.last, { pathId: 'future-path', stepId: 'intro', at: 10 });
  const mine = markRead(stored, 'p', 'l2');
  const saved = parseJourney(serializeJourney(mergeJourney(stored, mine, [PATH])), [PATH]);
  assert.ok(saved.read.includes('future-path/intro') && saved.read.includes('p/new-lesson') && saved.read.includes('p/l2'));
  assert.deepEqual(saved.resets, { 'future-path': 5 });
  assert.deepEqual(sanitizeJourneyRecord(saved, [PATH]), saved, 'canonical');
  // Shown and counted: known paths and steps only
  assert.deepEqual(sanitizeJourney(saved, [PATH]), { read: ['p/l1', 'p/l2'], quiz: {}, last: null });
});

test('Router: the review page', () => {
  assert.deepEqual(parseHash('#/learn/review'), { section: 'learn', pathId: null, stepId: null, page: 'review' });
  assert.equal(reviewHref(), '#/learn/review');
  // Not the review page: a path (or step) that happens to be called review
  assert.deepEqual(parseHash('#/learn/review/x'), { section: 'learn', pathId: 'review', stepId: 'x' });
  assert.deepEqual(parseHash('#/learn/p/review'), { section: 'learn', pathId: 'p', stepId: 'review' });
  // So no path may be called review, and answers are keyed by "pathId/questionId"
  for (const path of LEARNING_PATHS) {
    assert.notEqual(path.id, 'review');
    const ids = path.stages.flatMap(st => st.steps).flatMap(st => (st.kind === 'quiz' ? st.questions.map(q => q.id) : []));
    assert.equal(new Set(ids).size, ids.length, `${path.id}: question ids must be unique in the path`);
  }
});

// ---------- Review queue ----------

const PATH2: LearningPath = {
  id: 'r',
  track: 'windows',
  title: 'Path 2',
  summary: '',
  exam: '',
  audience: '',
  stages: [
    {
      id: 't1',
      title: 'T1',
      goal: '',
      steps: [
        {
          kind: 'quiz',
          id: 'k1',
          title: 'K1',
          passMark: 0.5,
          questions: ['x1', 'x2', 'x3'].map(id => ({ id, prompt: '', choices: ['a', 'b'], answer: 1, explanation: 'e' })),
        },
      ],
    },
  ],
};
const PATHS = [PATH, PATH2];
const DAY = 86_400_000;

test('Answers: recorded with a capped history and a time that only moves forward', () => {
  let j = EMPTY_JOURNEY;
  for (let i = 0; i < 7; i++) j = recordAnswer(j, 'p', 'q1', i % 2 === 0, 1000 + i);
  assert.equal(j.answers?.['p/q1'].history.length, ANSWER_HISTORY);
  assert.deepEqual(j.answers?.['p/q1'], { history: [true, false, true, false, true], lastAt: 1006 });
  // The clock went back: still newer than the answer before
  assert.equal(recordAnswer(j, 'p', 'q1', true, 5).answers?.['p/q1'].lastAt, 1007);
  assert.deepEqual(j.read, []);
});

test('Answers: sanitize keeps known questions and well-formed records only; older data still loads', () => {
  const raw = {
    read: ['p/l1'],
    quiz: {},
    last: null,
    answers: {
      'p/q2': { history: [true, false, 'x', true, true, true, false], lastAt: 50 },
      'p/l1': { history: [true], lastAt: 50 },
      'p/nope': { history: [true], lastAt: 50 },
      'zz/q1': { history: [true], lastAt: 50 },
      'p/q1': { history: [true], lastAt: -1 },
      'p/q3': { history: [], lastAt: 50 },
      'p/q4': { history: 'yes', lastAt: 50 },
      'r/x1': { history: [false], lastAt: 70 },
    },
  };
  assert.deepEqual(sanitizeJourney(raw, PATHS).answers, {
    'p/q2': { history: [false, true, true, true, false], lastAt: 50 },
    'r/x1': { history: [false], lastAt: 70 },
  });
  // Data saved before answers existed: unchanged, and no empty answers key appears
  const old = { read: ['p/l1'], quiz: { 'p/q1': { correct: 3, total: 4 } }, last: { pathId: 'p', stepId: 'l1', at: 9 } };
  assert.deepEqual(parseJourney(JSON.stringify(old), PATHS), old);
  assert.equal('answers' in sanitizeJourney({ ...old, answers: [] }, PATHS), false);
  // A journey with only answers is still saved
  const only = recordAnswer(EMPTY_JOURNEY, 'p', 'q1', true, 100);
  assert.notEqual(serializeJourney(only), null);
  assert.deepEqual(parseJourney(serializeJourney(only), PATHS), only);
});

test('Answers merge: the record answered last wins, in either order', () => {
  const a = recordAnswer(recordAnswer(EMPTY_JOURNEY, 'p', 'q1', true, 100), 'p', 'q2', false, 300);
  const b = recordAnswer(recordAnswer(EMPTY_JOURNEY, 'p', 'q1', false, 200), 'p', 'q2', true, 250);
  const m = mergeJourney(a, b, PATHS);
  assert.deepEqual(m.answers, { 'p/q1': { history: [false], lastAt: 200 }, 'p/q2': { history: [false], lastAt: 300 } });
  assert.deepEqual(mergeJourney(b, a, PATHS), m);
  assert.deepEqual(mergeJourney(m, m, PATHS), m);
  // Same time: both orders still agree
  const c = recordAnswer(EMPTY_JOURNEY, 'p', 'q1', true, 200);
  assert.deepEqual(mergeJourney(c, b, PATHS), mergeJourney(b, c, PATHS));
});

test('Answers: a path reset clears that path only, in every tab', () => {
  let j = recordAnswer(EMPTY_JOURNEY, 'p', 'q1', true, 100);
  j = recordAnswer(j, 'r', 'x1', false, 100);
  const reset = resetPath(j, 'p', 1000);
  assert.deepEqual(reset.answers, { 'r/x1': { history: [false], lastAt: 100 } });
  // Another tab that has not seen the reset cannot bring them back
  assert.deepEqual(mergeJourney(reset, j, PATHS).answers, { 'r/x1': { history: [false], lastAt: 100 } });
  // Resetting the last path with answers leaves no answers key
  assert.equal('answers' in resetPath(reset, 'r', 2000), false);
});

test('Review: spacing grows with each right answer in a row; a wrong one comes back soon', () => {
  assert.equal(reviewInterval([true]), DAY);
  assert.equal(reviewInterval([false, true, true]), 3 * DAY);
  assert.equal(reviewInterval([true, true, true]), 7 * DAY);
  assert.equal(reviewInterval([true, true, true, true]), 21 * DAY);
  assert.equal(reviewInterval([true, true, true, true, true]), 21 * DAY);
  assert.ok(reviewInterval([true, true, false]) < DAY / 24);
});

test('Review queue: missed first, then right ones answered a while ago, mixed across started paths', () => {
  const now = 100 * DAY;
  let j = EMPTY_JOURNEY;
  j = recordAnswer(j, 'p', 'q1', true, now - 2 * DAY); // due (1 day)
  j = recordAnswer(j, 'p', 'q2', false, now - DAY); // missed
  j = recordAnswer(j, 'p', 'q3', true, now - 3600_000); // right an hour ago: not due
  j = recordAnswer(j, 'r', 'x1', false, now - 2 * DAY); // missed, earlier
  j = recordAnswer(j, 'r', 'x2', true, now - 5 * DAY); // due, most overdue
  j = recordAnswer(j, 'p', 'q4', false, now - 60_000); // missed a minute ago: not yet
  const keys = reviewQueue(PATHS, src(j), now).map(i => i.key);
  // Missed: one from each path in turn (oldest first in each), then the due right ones by how overdue
  assert.deepEqual(keys, ['p/q2', 'r/x1', 'p/q1', 'r/x2']);
  assert.deepEqual(reviewStatus(PATHS, src(j), now), { due: 4, nextAt: null });

  // Never more than five
  let many = j;
  for (const id of ['q3', 'q4']) many = recordAnswer(many, 'p', id, false, now - DAY);
  many = recordAnswer(many, 'r', 'x3', false, now - DAY);
  assert.equal(reviewQueue(PATHS, src(many), now).length, 5);

  // Reset paths give nothing
  const resetBoth = resetPath(resetPath(j, 'p', now), 'r', now);
  assert.deepEqual(reviewQueue(PATHS, src(resetBoth), now), []);
});

test('Review queue: checkpoints taken before answers were saved still give questions, last', () => {
  const now = 100 * DAY;
  let j = recordQuizScore(EMPTY_JOURNEY, 'r', 'k1', { correct: 3, total: 3 });
  j = recordAnswer(j, 'p', 'q1', false, now - DAY);
  const queue = reviewQueue(PATHS, src(j), now);
  assert.deepEqual(queue.map(i => i.key), ['p/q1', 'r/x1', 'r/x2', 'r/x3']);
  assert.equal(queue[1].quiz.id, 'k1');
});

test('Review: nothing due says when the next one comes back', () => {
  const now = 100 * DAY;
  const j = recordAnswer(EMPTY_JOURNEY, 'p', 'q1', true, now);
  assert.deepEqual(reviewQueue(PATHS, src(j), now), []);
  assert.deepEqual(reviewStatus(PATHS, src(j), now), { due: 0, nextAt: now + DAY });
  assert.deepEqual(reviewStatus(PATHS, src(EMPTY_JOURNEY), now), { due: 0, nextAt: null });
});

test('Review: the summary says when questions come back', () => {
  assert.equal(comeBackText([[true, true], [true, true], [false]]), '1 comes back soon and 2 in a few days.');
  assert.equal(comeBackText([[true]]), '1 comes back tomorrow.');
  assert.equal(
    comeBackText([[false], [false], [true], [true, true, true], [true, true, true, true]]),
    '2 come back soon, 1 tomorrow, 1 in a week and 1 in three weeks.',
  );
  assert.equal(comeBackText([]), '');
});

// ---------- Where alternatives (choiceGroup) meet soft locks, test out and the review queue ----------

const CHOICE2: LearningPath = {
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
        {
          kind: 'quiz',
          id: 'q1',
          title: 'Q1',
          passMark: 0.5,
          questions: [1, 2].map(n => ({ id: `q${n}`, prompt: '', choices: ['a', 'b'], answer: 0, explanation: 'e' })),
        },
      ],
    },
    {
      id: 's2',
      title: 'Two',
      goal: '',
      steps: [
        { kind: 'lesson', id: 'la', title: 'LA', minutes: 3, blocks: [{ type: 'p', text: 'a' }], choiceGroup: 'read' },
        { kind: 'lesson', id: 'lb', title: 'LB', minutes: 5, blocks: [{ type: 'p', text: 'b' }], choiceGroup: 'read' },
        { kind: 'lesson', id: 'lc', title: 'LC', minutes: 2, blocks: [{ type: 'p', text: 'c' }] },
        {
          kind: 'quiz',
          id: 'q2',
          title: 'Q2',
          passMark: 0.5,
          questions: [3, 4].map(n => ({ id: `q${n}`, prompt: '', choices: ['a', 'b'], answer: 0, explanation: 'e' })),
        },
      ],
    },
  ],
};

test('Alternatives and soft locks: one lab of the group opens the next stage, and Continue skips the other', () => {
  let j = markRead(EMPTY_JOURNEY, 'p', 'l1');
  j = recordQuizScore(j, 'p', 'q1', { correct: 2, total: 2 });
  // No lab yet: stage 2 is not suggested yet, and Continue offers the first lab of the group
  const noLab = src(j);
  assert.equal(stageSuggested(CHOICE2, 1, noLab), false);
  assert.equal(suggestedAfter(CHOICE2, 1, noLab)?.id, 's1');
  assert.equal(nextStep(CHOICE2, noLab)?.step.id, 'lab1');

  // Either lab of the group will do
  for (const progress of [{ m1: ['a', 'b'] }, { m2: ['c'] }] as Record<string, string[]>[]) {
    const s = src(j, progress);
    assert.equal(stageComplete('p', CHOICE2.stages[0], s), true);
    assert.equal(stageSuggested(CHOICE2, 1, s), true);
    assert.equal(suggestedAfter(CHOICE2, 1, s), null);
    assert.equal(stepSuggested(CHOICE2, 'la', s), true);
    assert.equal(nextStep(CHOICE2, s)?.step.id, 'la');
    // The other lab of the group is skipped, in stage order and when resuming
    assert.equal(stepAfter(CHOICE2, 'l1', s)?.step.id, 'la');
    assert.equal(resumeTarget([CHOICE2], src(visit(j, 'p', 'lab1'), progress))?.loc.step.id, 'la');
    assert.equal(resumeTarget([CHOICE2], src(visit(j, 'p', 'lab2'), progress))?.loc.step.id, 'la');
    // Counted once: l1, the group and q1 of 3 + 3 things to do
    assert.equal(pathPercent(CHOICE2, s), 50);
  }

  // Went ahead into stage 2 with stage 1 unfinished: stays there, skipping the alternative already read
  const ahead = src(markRead(EMPTY_JOURNEY, 'p', 'la'));
  assert.equal(stageSuggested(CHOICE2, 1, ahead), false);
  assert.equal(stepAfter(CHOICE2, 'la', ahead)?.step.id, 'lc');
  // ...and Continue still follows the suggested order
  assert.equal(nextStep(CHOICE2, ahead)?.step.id, 'l1');
  assert.equal(resumeTarget([CHOICE2], src(visit(ahead.journey, 'p', 'lb')))?.loc.step.id, 'l1');
});

test('Alternatives and test out: a group of lessons is marked once, and completes the stage with the checkpoint', () => {
  // la and lb are alternatives: only the first is marked, and lc
  assert.deepEqual(lessonsToTestOut(CHOICE2, 1, EMPTY_JOURNEY), ['la', 'lc']);
  // One of them read already: nothing more to mark for the group
  assert.deepEqual(lessonsToTestOut(CHOICE2, 1, markRead(EMPTY_JOURNEY, 'p', 'lb')), ['lc']);
  // A group of labs is never marked
  assert.deepEqual(lessonsToTestOut(CHOICE2, 0, EMPTY_JOURNEY), ['l1']);

  // Passing stage 2's checkpoint and testing out (as the checkpoint does) completes stage 2
  let j = recordQuizScore(EMPTY_JOURNEY, 'p', 'q2', { correct: 2, total: 2 });
  for (const id of lessonsToTestOut(CHOICE2, 1, j)) j = markRead(j, 'p', id);
  const s = src(j);
  assert.equal(stageComplete('p', CHOICE2.stages[1], s), true);
  assert.deepEqual(lessonsToTestOut(CHOICE2, 1, j), []);
  // The group counts once: la (with lb), lc and q2 are 3 of 6
  assert.equal(pathPercent(CHOICE2, s), 50);
  assert.equal(currentStageIndex(CHOICE2, s), 0);
  // Stage 1 done with one lab of its group: the whole path is done
  let all = markRead(j, 'p', 'l1');
  all = recordQuizScore(all, 'p', 'q1', { correct: 1, total: 2 });
  const finished = src(all, { m2: ['c'] });
  assert.equal(pathPercent(CHOICE2, finished), 100);
  assert.equal(nextStep(CHOICE2, finished), null);
  assert.equal(pathMinutes(CHOICE2, new Map(MODULES.map(m => [m.id, m]))), 4 + 15 + 2 + 3 + 2 + 2);
});

test('Alternatives and the review queue: questions of a path started through either alternative', () => {
  const now = 100 * DAY;
  // Only the second lab of the group done: the path counts as started, and taken checkpoints give questions
  const j = recordQuizScore(EMPTY_JOURNEY, 'p', 'q1', { correct: 2, total: 2 });
  assert.equal(pathStarted(CHOICE2, src(EMPTY_JOURNEY, { m2: ['c'] })), true);
  assert.deepEqual(reviewQueue([CHOICE2], src(j, { m2: ['c'] }), now).map(i => i.key), ['p/q1', 'p/q2']);
});

test('Answers saved by a newer build survive parse, merge and save; only known questions are shown', () => {
  const text = JSON.stringify({
    read: ['p/l1'],
    quiz: {},
    last: null,
    answers: {
      'p/q1': { history: [true], lastAt: 10 },
      'future-path/q9': { history: [false, true], lastAt: 20 },
      'p/new-question': { history: [true], lastAt: 30 },
      'bad-key': { history: [true], lastAt: 30 },
      'future-path/broken': { history: 'no', lastAt: 30 },
    },
  });
  const stored = parseJourney(text, PATHS);
  assert.deepEqual(stored.answers, {
    'p/q1': { history: [true], lastAt: 10 },
    'future-path/q9': { history: [false, true], lastAt: 20 },
    'p/new-question': { history: [true], lastAt: 30 },
  });
  const mine = recordAnswer(stored, 'p', 'q2', false, 40);
  const saved = parseJourney(serializeJourney(mergeJourney(stored, mine, PATHS)), PATHS);
  assert.deepEqual(saved.answers?.['future-path/q9'], { history: [false, true], lastAt: 20 });
  assert.deepEqual(saved.answers?.['p/new-question'], { history: [true], lastAt: 30 });
  assert.deepEqual(saved.answers?.['p/q2'], { history: [false], lastAt: 40 });
  assert.deepEqual(sanitizeJourneyRecord(saved, PATHS), saved, 'canonical');
  // Shown and counted: known questions only
  assert.deepEqual(Object.keys(sanitizeJourney(saved, PATHS).answers ?? {}).sort(), ['p/q1', 'p/q2']);
  // A path reset still clears that path's unknown answers too
  assert.equal(resetPath(saved, 'p', 1000).answers?.['p/new-question'], undefined);
  assert.deepEqual(Object.keys(resetPath(saved, 'p', 1000).answers ?? {}), ['future-path/q9']);
});
