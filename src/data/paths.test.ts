import test from 'node:test';
import assert from 'node:assert/strict';
import { FIRST_STEPS_PATH_ID, LEARNING_PATHS } from './paths.ts';
import { LPI_MODULES } from './lpiModules.ts';
import { WINDOWS_PBQS } from './windowsPbqs.ts';

test('Learning paths: ids are unique and every step points at real content', () => {
  const moduleTrack = new Map([
    ...LPI_MODULES.map(m => [m.id, 'linux'] as const),
    ...WINDOWS_PBQS.map(m => [m.id, 'windows'] as const),
  ]);
  const pathIds = new Set<string>();

  for (const path of LEARNING_PATHS) {
    assert.ok(!pathIds.has(path.id), `duplicate path id ${path.id}`);
    pathIds.add(path.id);
    assert.ok(path.stages.length > 0, `${path.id} has no stages`);

    const stageIds = new Set<string>();
    const stepIds = new Set<string>();
    for (const stage of path.stages) {
      assert.ok(!stageIds.has(stage.id), `${path.id}: duplicate stage id ${stage.id}`);
      stageIds.add(stage.id);
      assert.ok(stage.steps.length > 0, `${path.id}/${stage.id} has no steps`);

      for (const step of stage.steps) {
        const where = `${path.id}/${stage.id}/${step.id}`;
        assert.ok(!stepIds.has(step.id), `duplicate step id ${where}`);
        stepIds.add(step.id);

        if (step.kind === 'lab') {
          // The beginners' path offers one lab per track; every other path stays on its own track
          if (path.id === FIRST_STEPS_PATH_ID) assert.ok(moduleTrack.has(step.moduleId), `${where}: unknown lab (${step.moduleId})`);
          else assert.equal(moduleTrack.get(step.moduleId), path.track, `${where}: unknown lab or wrong track (${step.moduleId})`);
        } else if (step.kind === 'lesson') {
          assert.ok(step.blocks.length > 0 && step.minutes > 0, `${where}: empty lesson`);
        } else {
          assert.ok(step.passMark > 0 && step.passMark <= 1, `${where}: passMark must be in (0, 1]`);
          assert.ok(step.questions.length > 0, `${where}: no questions`);
          const qIds = new Set<string>();
          for (const q of step.questions) {
            assert.ok(!qIds.has(q.id), `${where}: duplicate question id ${q.id}`);
            qIds.add(q.id);
            assert.ok(q.choices.length >= 2, `${where}/${q.id}: needs at least two choices`);
            assert.ok(Number.isInteger(q.answer) && q.answer >= 0 && q.answer < q.choices.length, `${where}/${q.id}: answer out of range`);
            assert.equal(new Set(q.choices).size, q.choices.length, `${where}/${q.id}: duplicate choices`);
            assert.ok(q.explanation.trim().length > 0, `${where}/${q.id}: missing explanation`);
          }
        }
      }
    }
  }
});

test('Learning paths: the exam paths keep their ids and stage order', () => {
  // Saved progress is keyed by these ids, so adding the beginners' path must not move or rename any of them
  const stages = Object.fromEntries(LEARNING_PATHS.filter(p => p.id !== FIRST_STEPS_PATH_ID).map(p => [p.id, p.stages.map(s => s.id)]));
  assert.deepEqual(stages, {
    'lpic1-101': ['hardware', 'text-streams', 'disks', 'permissions', 'exam-101'],
    'lpic1-102': ['accounts', 'jobs-and-logs', 'networking', 'security', 'exam-102'],
    'aplus-core2': ['cmd-basics', 'disks', 'repair', 'services-network', 'exam-1202'],
    'netsec-windows': ['client-network', 'active-directory', 'group-policy', 'incident-response', 'exam-netsec'],
  });
  assert.equal(LEARNING_PATHS[0].id, 'lpic1-101');
});

test('First steps: two short lessons, then a five-minute Beginner lab for bash and for Windows', () => {
  const path = LEARNING_PATHS.find(p => p.id === FIRST_STEPS_PATH_ID);
  assert.ok(path, 'first-steps path is missing');
  // One stage, so nothing in it is locked
  assert.equal(path.stages.length, 1);
  const steps = path.stages[0].steps;
  const lessons = steps.filter(s => s.kind === 'lesson');
  assert.deepEqual(lessons.map(s => s.id), ['what-the-prompt-means', 'you-cannot-break-anything']);
  for (const l of lessons) assert.ok(l.kind === 'lesson' && l.minutes <= 3, `${l.id} is longer than three minutes`);
  assert.deepEqual(steps.slice(0, 2).map(s => s.kind), ['lesson', 'lesson'], 'the lessons come before the labs');

  const labs = steps.flatMap(s => (s.kind === 'lab' ? [s.moduleId] : []));
  assert.deepEqual(labs, ['lpi-000-first-steps', 'win-000-first-steps']);
  const all = [...LPI_MODULES, ...WINDOWS_PBQS];
  for (const id of labs) {
    const m = all.find(x => x.id === id)!;
    assert.equal(m.difficulty, 'Beginner');
    assert.equal(m.estimatedMinutes, 5);
    assert.equal(m.objectives.length, 5);
    assert.equal(m.solutionWalkthrough.length, 5);
    for (const o of m.objectives) {
      assert.ok(o.nudge && o.shape && o.hint, `${id}/${o.id}: needs a nudge, a shape and a hint`);
      for (const text of [o.title, o.description, o.nudge, o.shape, o.hint]) assert.ok(!text.includes('!'), `${id}/${o.id}: no exclamation marks`);
    }
  }
  assert.equal(LPI_MODULES.find(m => m.id === 'lpi-000-first-steps')?.defaultShell, 'bash');
  const win = WINDOWS_PBQS.find(m => m.id === 'win-000-first-steps')!;
  assert.equal(win.defaultShell, 'cmd');
  assert.deepEqual(win.allowedShells, ['cmd', 'powershell']);
});

test('Quizzes: the right answer cannot be guessed by picking the longest choice', () => {
  // With four choices about a quarter of the keys are the longest by chance. Well above that,
  // learners can pass on length alone, so each path stays at or under 35%, and no key may be
  // more than 1.4 times as long as its longest distractor.
  for (const path of LEARNING_PATHS) {
    let total = 0;
    let longest = 0;
    for (const stage of path.stages) for (const step of stage.steps) {
      if (step.kind !== 'quiz') continue;
      for (const q of step.questions) {
        total++;
        const key = q.choices[q.answer].length;
        const maxOther = Math.max(...q.choices.filter((_, i) => i !== q.answer).map(c => c.length));
        if (key > maxOther) longest++;
        assert.ok(key <= 1.4 * maxOther, `${path.id}/${q.id}: the answer is ${(key / maxOther).toFixed(2)} times the longest distractor`);
      }
    }
    if (total > 0) assert.ok(longest / total <= 0.35, `${path.id}: the answer is the unique longest choice in ${longest} of ${total} questions`);
  }
});
