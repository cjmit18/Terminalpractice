import test from 'node:test';
import assert from 'node:assert/strict';
import { coverageReport, formatCoverage } from './coverage.ts';
import { EXAMS, EXAM_OBJECTIVES } from './examObjectives.ts';
import { LEARNING_PATHS } from './paths.ts';
import { CHALLENGES } from './challenges.ts';
import type { LearningPath } from '../types/paths.ts';

const quiz = (id: string, questions: { id: string; objectives?: string[] }[]) => ({
  kind: 'quiz' as const,
  id,
  title: id,
  passMark: 0.75,
  questions: questions.map(q => ({ ...q, prompt: 'p', choices: ['a', 'b'], answer: 0, explanation: 'e' })),
});
const path = (id: string, steps: LearningPath['stages'][number]['steps']): LearningPath =>
  ({ id, title: id, stages: [{ id: 's', title: 's', steps }] }) as unknown as LearningPath;

test('coverage: counts each kind of content per objective, and one lab used by two paths once', () => {
  const paths = [
    path('one', [
      { kind: 'lesson', id: 'l1', title: 't', minutes: 1, blocks: [], objectives: ['104.5', '104.6'] },
      { kind: 'lab', id: 'lab', moduleId: 'machine-a', objectives: ['104.5'] },
      quiz('q', [{ id: 'q1', objectives: ['104.5'] }, { id: 'q2', objectives: ['104.5', '104.6'] }, { id: 'q3' }]),
    ]),
    path('two', [
      { kind: 'lab', id: 'same-lab', moduleId: 'machine-a', objectives: ['104.5'] },
      quiz('q', [{ id: 'q1', objectives: ['104.5'] }]),
    ]),
  ];
  const challenges = [{ id: 'c1', objectives: ['104.5', '104.5'] }, { id: 'c2' }] as unknown as typeof CHALLENGES;
  const report = coverageReport(paths, challenges);
  const row = (id: string) => report.rows.find(r => r.objective.id === id)!;
  assert.deepEqual(
    { lessons: row('104.5').lessons, labs: row('104.5').labs, questions: row('104.5').questions, challenges: row('104.5').challenges },
    { lessons: 1, labs: 1, questions: 3, challenges: 1 },
    'the same question id in another path is another question; the same lab machine is one lab',
  );
  assert.deepEqual([row('104.6').lessons, row('104.6').questions], [1, 1]);
  assert.equal(row('104.7').questions + row('104.7').labs + row('104.7').lessons, 0);
  assert.deepEqual(report.untagged, { questions: 1, totalQuestions: 4, challenges: 1, totalChallenges: 2 });
});

test('coverage: one row per objective, grouped by exam, thinnest first inside each exam', () => {
  const report = coverageReport();
  assert.equal(report.rows.length, EXAM_OBJECTIVES.length);
  assert.deepEqual([...new Set(report.rows.map(r => r.objective.exam))], Object.keys(EXAMS), 'exams in EXAMS order');
  for (const exam of Object.keys(EXAMS)) {
    const rows = report.rows.filter(r => r.objective.exam === exam);
    for (let i = 1; i < rows.length; i++) {
      assert.ok(rows[i - 1].questions <= rows[i].questions, `${exam}: ${rows[i - 1].objective.number} before ${rows[i].objective.number}`);
    }
  }
});

test('coverage: the real content adds up, and "covered" matches the counts', () => {
  const report = coverageReport();
  // Every tag on a question, counted the plain way
  const tags = LEARNING_PATHS.flatMap(p => p.stages.flatMap(s => s.steps.flatMap(step => (step.kind === 'quiz' ? step.questions.flatMap(q => q.objectives ?? []) : []))));
  assert.equal(report.rows.reduce((n, r) => n + r.questions, 0), tags.length);
  assert.equal(report.untagged.totalChallenges, CHALLENGES.length);
  for (const r of report.rows) {
    const any = r.lessons + r.labs + r.questions > 0;
    assert.equal(any, r.objective.covered, `${r.objective.id}: covered is ${r.objective.covered}, the paths have ${any ? 'some' : 'no'} content`);
  }
});

test('coverage: the text report lists every objective once and says what is not counted', () => {
  const report = coverageReport();
  const text = formatCoverage(report);
  for (const exam of Object.values(EXAMS)) assert.ok(text.includes(`${exam.name}: `), exam.name);
  const lines = text.split('\n').filter(l => /^ {2}\d/.test(l));
  assert.equal(lines.length, EXAM_OBJECTIVES.length);
  assert.match(text, new RegExp(`Not counted above: ${report.untagged.questions} of ${report.untagged.totalQuestions} questions and \\d+ of ${CHALLENGES.length} challenges have no objective tag\\.$`));
});
