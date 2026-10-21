import test from 'node:test';
import assert from 'node:assert/strict';
import { FIRST_STEPS_PATH_ID, LEARNING_PATHS } from './paths.ts';
import { LPI_MODULES } from './lpiModules.ts';
import {
  EXAMS,
  EXAM_OBJECTIVES,
  OBJECTIVES_BY_ID,
  PATH_EXAMS,
  objectiveState,
  pathObjectiveIds,
  pathSkillReport,
} from './examObjectives.ts';
import { EMPTY_JOURNEY, type CompletionSource, type Journey, stepKey } from '../lib/journey.ts';
import type { LearningPath } from '../types/paths.ts';

const allTags = (path: LearningPath): { where: string; id: string }[] =>
  path.stages.flatMap(stage =>
    stage.steps.flatMap(step => {
      const own = step.kind === 'quiz' ? [] : (step.objectives ?? []).map(id => ({ where: `${path.id}/${step.id}`, id }));
      const qs =
        step.kind === 'quiz'
          ? step.questions.flatMap(q => (q.objectives ?? []).map(id => ({ where: `${path.id}/${step.id}/${q.id}`, id })))
          : [];
      return [...own, ...qs];
    }),
  );

test('Exam objectives: ids are unique, every objective belongs to a known exam', () => {
  assert.equal(OBJECTIVES_BY_ID.size, EXAM_OBJECTIVES.length, 'duplicate objective id');
  for (const o of EXAM_OBJECTIVES) {
    assert.ok(EXAMS[o.exam], `${o.id}: unknown exam ${o.exam}`);
    assert.ok(o.title.length > 0 && o.title.length <= 60, `${o.id}: title should be short`);
    assert.ok(!/[!]/.test(o.title), `${o.id}: no exclamation marks`);
  }
  // LPIC-1 v5.0 numbering: 101.1-104.7 on 101-500 and 105.1-110.3 on 102-500, without the removed 104.4 and 105.3
  const lpi101 = EXAM_OBJECTIVES.filter(o => o.exam === 'lpic1-101').map(o => o.id);
  const lpi102 = EXAM_OBJECTIVES.filter(o => o.exam === 'lpic1-102').map(o => o.id);
  assert.equal(lpi101[0], '101.1');
  assert.equal(lpi101.at(-1), '104.7');
  assert.equal(lpi102[0], '105.1');
  assert.equal(lpi102.at(-1), '110.3');
  assert.ok(!lpi101.includes('104.4') && !lpi102.includes('105.3'));
  for (const id of [...lpi101, ...lpi102]) {
    const topic = Number(id.split('.')[0]);
    assert.ok(lpi101.includes(id) ? topic >= 101 && topic <= 104 : topic >= 105 && topic <= 110, `${id} on the wrong exam`);
  }
  for (const exam of Object.values(EXAMS)) assert.match(exam.url, /^https:\/\/(www\.lpi\.org|comptiacdn\.azureedge\.net|www\.comptia\.org)\//);
});

test('Exam objectives: every tag names a real objective of that path\'s exam', () => {
  for (const path of LEARNING_PATHS) {
    const exams = PATH_EXAMS[path.id] ?? [];
    for (const { where, id } of allTags(path)) {
      const o = OBJECTIVES_BY_ID.get(id);
      assert.ok(o, `${where}: unknown objective "${id}"`);
      assert.ok(exams.includes(o.exam), `${where}: ${id} belongs to ${o.exam}, not to this path's exams`);
    }
  }
});

test('Exam objectives: every exam path has tags; covered matches the tags', () => {
  const tagged = new Set<string>();
  for (const path of LEARNING_PATHS) {
    if (path.id === FIRST_STEPS_PATH_ID) {
      assert.equal(PATH_EXAMS[path.id], undefined, 'the beginners\' path has no exam');
      continue;
    }
    assert.ok(PATH_EXAMS[path.id]?.length, `${path.id} has no exam in PATH_EXAMS`);
    const ids = pathObjectiveIds(path);
    assert.ok(ids.size > 0, `${path.id} has no objective tags`);
    for (const id of ids) tagged.add(id);
    // Every lab and every question says what it practises (lessons about the exam format need not)
    for (const stage of path.stages)
      for (const step of stage.steps) {
        if (step.kind === 'lab') assert.ok(step.objectives?.length, `${path.id}/${step.id}: lab has no objectives`);
        if (step.kind === 'quiz')
          for (const q of step.questions) assert.ok(q.objectives?.length, `${path.id}/${step.id}/${q.id}: question has no objectives`);
      }
  }
  for (const o of EXAM_OBJECTIVES) assert.equal(o.covered, tagged.has(o.id), `${o.id}: covered flag does not match the tags`);
});

test('Exam objectives: a lab tag agrees with the lab\'s own LPI topic number', () => {
  const topicOf = new Map(LPI_MODULES.map(m => [m.id, m.topicNumber.replace(/^Topic /, '')]));
  for (const path of LEARNING_PATHS)
    for (const stage of path.stages)
      for (const step of stage.steps) {
        if (step.kind !== 'lab') continue;
        const topic = topicOf.get(step.moduleId);
        if (topic && OBJECTIVES_BY_ID.has(topic)) assert.ok(step.objectives?.includes(topic), `${path.id}/${step.id}: should include ${topic}`);
      }
});

// ---------- States ----------

const lpic101 = LEARNING_PATHS.find(p => p.id === 'lpic1-101')!;
const src = (journey: Journey, labsDone: string[] = []): CompletionSource => ({ journey, labComplete: id => labsDone.includes(id) });
const state = (j: Journey, id: string, labs: string[] = [], opts = {}) => objectiveState(lpic101, id, src(j, labs), opts);

test('Skill states: not started, practised by lesson or lab, confident by passed checkpoints', () => {
  assert.equal(state(EMPTY_JOURNEY, '104.5'), 'not-started');
  assert.equal(state(EMPTY_JOURNEY, '102.2'), 'not-covered');

  const read: Journey = { ...EMPTY_JOURNEY, read: [stepKey('lpic1-101', 'reading-and-setting-permissions')] };
  assert.equal(state(read, '104.5'), 'practised');
  assert.equal(state(EMPTY_JOURNEY, '104.5', ['lpi-104-5-permissions']), 'practised');

  // 104.5 has questions in the permissions checkpoint and in the final check: both must be passed
  const checkpointOnly: Journey = { ...EMPTY_JOURNEY, quiz: { [stepKey('lpic1-101', 'quiz-permissions')]: { correct: 6, total: 6 } } };
  assert.equal(state(checkpointOnly, '104.5'), 'practised');
  const both: Journey = {
    ...checkpointOnly,
    quiz: { ...checkpointOnly.quiz, [stepKey('lpic1-101', 'final-101')]: { correct: 8, total: 10 } },
  };
  assert.equal(state(both, '104.5'), 'confident');
  const finalFailed: Journey = { ...both, quiz: { ...both.quiz, [stepKey('lpic1-101', 'final-101')]: { correct: 5, total: 10 } } };
  assert.equal(state(finalFailed, '104.5'), 'practised');

  // Answer-history hook: a wrong latest answer holds Confident back
  assert.equal(state(both, '104.5', [], { questionHistory: (_p: string, q: string) => (q === 'q-umask-027' ? [true, false] : undefined) }), 'practised');
  assert.equal(state(both, '104.5', [], { questionHistory: () => [false, true] }), 'confident');
});

test('Skill report: honest counts, checkpoint average, not-covered list; none for the beginners\' path', () => {
  const empty = pathSkillReport(lpic101, src(EMPTY_JOURNEY))!;
  const coveredCount = EXAM_OBJECTIVES.filter(o => o.exam === 'lpic1-101' && o.covered).length;
  assert.equal(empty.covered, coveredCount);
  assert.equal(empty.practised, 0);
  assert.equal(empty.checkpointAverage, null);
  assert.ok(empty.notCovered.some(o => o.id === '103.7'));

  const j: Journey = {
    ...EMPTY_JOURNEY,
    read: [stepKey('lpic1-101', 'how-linux-sees-hardware')],
    quiz: { [stepKey('lpic1-101', 'quiz-hardware')]: { correct: 4, total: 5 }, [stepKey('lpic1-101', 'quiz-disks')]: { correct: 3, total: 5 } },
  };
  const r = pathSkillReport(lpic101, src(j))!;
  assert.equal(r.checkpointAverage, 70);
  assert.ok(r.practised >= 1);

  const firstSteps = LEARNING_PATHS.find(p => p.id === FIRST_STEPS_PATH_ID)!;
  assert.equal(pathSkillReport(firstSteps, src(EMPTY_JOURNEY)), null);
  const netsec = pathSkillReport(LEARNING_PATHS.find(p => p.id === 'netsec-windows')!, src(EMPTY_JOURNEY))!;
  assert.deepEqual(netsec.exams.map(e => e.exam.id), ['netplus-n10-009', 'secplus-sy0-701']);
});
