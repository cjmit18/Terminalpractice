import test from 'node:test';
import assert from 'node:assert/strict';
import { LEARNING_PATHS } from './paths.ts';
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
          assert.equal(moduleTrack.get(step.moduleId), path.track, `${where}: unknown lab or wrong track (${step.moduleId})`);
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
