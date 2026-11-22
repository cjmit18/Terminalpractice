// The coverage report: how much practice each exam objective has (docs/CONTENT_PLAN.md, section 3).
// It counts the lessons, labs, questions and challenges tagged with each objective, across every path,
// so new content goes to the thinnest objectives first. Run it with `npm run coverage`.
import type { LearningPath } from '../types/paths';
import { CHALLENGES, type Challenge } from './challenges';
import { EXAMS, EXAM_OBJECTIVES, type ExamId, type ExamObjective, objectiveSources } from './examObjectives';
import { LEARNING_PATHS } from './paths';

export interface CoverageRow {
  objective: ExamObjective;
  lessons: number;
  /** Distinct lab machines: one lab offered in two paths counts once */
  labs: number;
  questions: number;
  challenges: number;
}

export interface CoverageReport {
  /** One row per objective, grouped by exam in EXAMS order, thinnest first inside each exam */
  rows: CoverageRow[];
  /** Content that carries no objective tag, so no row counts it */
  untagged: { questions: number; totalQuestions: number; challenges: number; totalChallenges: number };
}

/** Practice counts first (questions, labs, challenges), then lessons; ties keep the exam's own order */
const thinnestFirst = (a: CoverageRow, b: CoverageRow) =>
  a.questions - b.questions || a.labs - b.labs || a.challenges - b.challenges || a.lessons - b.lessons;

export function coverageReport(paths: LearningPath[] = LEARNING_PATHS, challenges: Challenge[] = CHALLENGES): CoverageReport {
  const lessons = new Map<string, Set<string>>();
  const labs = new Map<string, Set<string>>();
  const questions = new Map<string, Set<string>>();
  const note = (into: Map<string, Set<string>>, objectiveId: string, item: string) => {
    const set = into.get(objectiveId) ?? new Set<string>();
    set.add(item);
    into.set(objectiveId, set);
  };

  let totalQuestions = 0;
  let untaggedQuestions = 0;
  for (const path of paths) {
    for (const [objectiveId, sources] of objectiveSources(path)) {
      for (const s of sources) {
        if (s.kind === 'question') note(questions, objectiveId, `${path.id}/${s.question.id}`);
        else if (s.step.kind === 'lab') note(labs, objectiveId, s.step.moduleId);
        else note(lessons, objectiveId, `${path.id}/${s.step.id}`);
      }
    }
    for (const stage of path.stages) {
      for (const step of stage.steps) {
        if (step.kind !== 'quiz') continue;
        totalQuestions += step.questions.length;
        untaggedQuestions += step.questions.filter(q => !q.objectives?.length).length;
      }
    }
  }

  const challengeCounts = new Map<string, number>();
  for (const c of challenges) for (const id of new Set(c.objectives ?? [])) challengeCounts.set(id, (challengeCounts.get(id) ?? 0) + 1);

  const exams = Object.keys(EXAMS) as ExamId[];
  const rows = exams.flatMap(exam =>
    EXAM_OBJECTIVES.filter(o => o.exam === exam)
      .map(objective => ({
        objective,
        lessons: lessons.get(objective.id)?.size ?? 0,
        labs: labs.get(objective.id)?.size ?? 0,
        questions: questions.get(objective.id)?.size ?? 0,
        challenges: challengeCounts.get(objective.id) ?? 0,
      }))
      .sort(thinnestFirst),
  );
  return {
    rows,
    untagged: {
      questions: untaggedQuestions,
      totalQuestions,
      challenges: challenges.filter(c => !c.objectives?.length).length,
      totalChallenges: challenges.length,
    },
  };
}

/** The report as plain text, one table per exam */
export function formatCoverage(report: CoverageReport): string {
  const out: string[] = [];
  for (const exam of Object.values(EXAMS)) {
    const rows = report.rows.filter(r => r.objective.exam === exam.id);
    if (rows.length === 0) continue;
    const empty = rows.filter(r => r.lessons + r.labs + r.questions + r.challenges === 0).length;
    out.push(`${exam.name}: ${rows.length} ${exam.level}s, ${empty} with no content`);
    out.push('  Number  Questions  Labs  Challenges  Lessons  Title');
    for (const r of rows) {
      const n = (value: number, width: number) => String(value).padStart(width);
      out.push(`  ${r.objective.number.padEnd(6)}  ${n(r.questions, 9)}  ${n(r.labs, 4)}  ${n(r.challenges, 10)}  ${n(r.lessons, 7)}  ${r.objective.title}`);
    }
    out.push('');
  }
  const u = report.untagged;
  out.push(`Not counted above: ${u.questions} of ${u.totalQuestions} questions and ${u.challenges} of ${u.totalChallenges} challenges have no objective tag.`);
  return out.join('\n');
}
