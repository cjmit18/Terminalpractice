import { ExamModule } from '../types/modules';
import { LearningPath, PathStage, PathStep, QuizQuestion } from '../types/paths';
import type { SyncedCodec } from './syncedStorage';

/**
 * Progress through the guided learning paths, saved in this browser.
 *
 * Lab completion is not stored here: a lab step is done when all of the lab's
 * objectives are in the shared lab progress record, wherever the learner did them.
 */

export const JOURNEY_KEY = 'certsim:journey:v1';

export interface QuizScore {
  correct: number;
  total: number;
}

export interface Journey {
  /** "pathId/stepId" of lessons marked read */
  read: string[];
  /** "pathId/stepId" -> best score for that quiz */
  quiz: Record<string, QuizScore>;
  /** The last path (and step, if any) the learner had open, and when (ms since epoch; missing in older data) */
  last: { pathId: string; stepId: string | null; at?: number } | null;
  /**
   * pathId -> time (ms since epoch) of the last reset of that path. A tombstone, so that a reset in one
   * tab is not undone when another tab's copy is merged in. Same rule as ProgressRecord.resetAt: a
   * copy whose reset time for a path is older than the newest one has not seen that reset, and its
   * reads, quiz scores and `last` for that path are dropped in the merge.
   */
  resets?: Record<string, number>;
  /**
   * "pathId/questionId" -> the last few answers to that checkpoint question (oldest first, at most
   * ANSWER_HISTORY) and when it was last answered. Feeds the review queue (reviewQueue). Missing in
   * older data. In a merge the record answered last wins; a path reset clears that path's answers.
   */
  answers?: Record<string, AnswerRecord>;
}

export interface AnswerRecord {
  /** true = answered right, oldest first */
  history: boolean[];
  /** ms since epoch */
  lastAt: number;
}

/** How many answers per question are kept */
export const ANSWER_HISTORY = 5;

export const EMPTY_JOURNEY: Journey = { read: [], quiz: {}, last: null };

export const stepKey = (pathId: string, stepId: string) => `${pathId}/${stepId}`;

// ---------- Loading and saving ----------

/** Keep only known paths, steps of the right kind and well-formed scores. Anything else is dropped. */
export function sanitizeJourney(raw: unknown, paths: LearningPath[]): Journey {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return EMPTY_JOURNEY;
  const data = raw as Record<string, unknown>;
  const readIn = Array.isArray(data.read) ? data.read : [];
  const quizIn =
    data.quiz && typeof data.quiz === 'object' && !Array.isArray(data.quiz) ? (data.quiz as Record<string, unknown>) : {};

  const read: string[] = [];
  const quiz: Record<string, QuizScore> = {};
  for (const path of paths) {
    for (const step of allSteps(path)) {
      const key = stepKey(path.id, step.id);
      if (step.kind === 'lesson' && readIn.includes(key)) read.push(key);
      if (step.kind === 'quiz') {
        const s = quizIn[key] as Record<string, unknown> | undefined;
        if (
          s &&
          typeof s === 'object' &&
          Number.isInteger(s.correct) &&
          Number.isInteger(s.total) &&
          (s.total as number) > 0 &&
          (s.correct as number) >= 0 &&
          (s.correct as number) <= (s.total as number)
        ) {
          quiz[key] = { correct: s.correct as number, total: s.total as number };
        }
      }
    }
  }

  let last: Journey['last'] = null;
  const l = data.last as Record<string, unknown> | null | undefined;
  if (l && typeof l === 'object' && typeof l.pathId === 'string') {
    const path = paths.find(p => p.id === l.pathId);
    if (path) {
      const stepId = typeof l.stepId === 'string' && findStep(path, l.stepId) ? l.stepId : null;
      last = isTime(l.at) ? { pathId: path.id, stepId, at: l.at } : { pathId: path.id, stepId };
    }
  }

  const answers: Record<string, AnswerRecord> = {};
  const answersIn = data.answers;
  if (answersIn && typeof answersIn === 'object' && !Array.isArray(answersIn)) {
    for (const path of paths) {
      for (const step of allSteps(path)) {
        if (step.kind !== 'quiz') continue;
        for (const q of step.questions) {
          const key = stepKey(path.id, q.id);
          const rec = answerRecord((answersIn as Record<string, unknown>)[key]);
          if (rec) answers[key] = rec;
        }
      }
    }
  }

  const resets: Record<string, number> = {};
  const resetsIn = data.resets;
  if (resetsIn && typeof resetsIn === 'object' && !Array.isArray(resetsIn)) {
    for (const path of paths) {
      const t = (resetsIn as Record<string, unknown>)[path.id];
      if (isTime(t)) resets[path.id] = t;
    }
  }
  const out: Journey = { read, quiz, last };
  if (Object.keys(resets).length) out.resets = resets;
  if (Object.keys(answers).length) out.answers = answers;
  return out;
}

const isTime = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v > 0;

/** A well-formed answer record (history trimmed to the newest ANSWER_HISTORY), or null. */
function answerRecord(v: unknown): AnswerRecord | null {
  const r = v as Record<string, unknown> | null | undefined;
  if (!r || typeof r !== 'object' || !Array.isArray(r.history) || !isTime(r.lastAt)) return null;
  const history = r.history.filter((h): h is boolean => typeof h === 'boolean').slice(-ANSWER_HISTORY);
  return history.length > 0 ? { history, lastAt: r.lastAt } : null;
}

const isScore = (s: unknown): s is QuizScore => {
  const r = s as Record<string, unknown> | null;
  return (
    !!r && typeof r === 'object' &&
    Number.isInteger(r.correct) && Number.isInteger(r.total) &&
    (r.total as number) > 0 && (r.correct as number) >= 0 && (r.correct as number) <= (r.total as number)
  );
};
const isKey = (v: unknown): v is string => typeof v === 'string' && v.length <= 300 && /^[^/]+\/./.test(v);

/**
 * The saved journey, well-formed: what sanitizeJourney keeps, plus reads, scores, answers, resets and
 * `last` for paths, steps and questions this build does not know (saved by a newer build, e.g. in another tab after a
 * deploy), so an older tab never deletes them. Only what is shown and counted goes through
 * sanitizeJourney. Unknown entries follow the known ones, sorted.
 */
export function sanitizeJourneyRecord(raw: unknown, paths: LearningPath[]): Journey {
  const known = sanitizeJourney(raw, paths);
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return known;
  const data = raw as Record<string, unknown>;
  const stepKeys = new Set(paths.flatMap(p => allSteps(p).map(s => stepKey(p.id, s.id))));
  const foreign = (k: unknown): k is string => isKey(k) && !stepKeys.has(k);

  const readIn = Array.isArray(data.read) ? data.read : [];
  const read = [...known.read, ...[...new Set(readIn.filter(foreign))].sort()];
  const quizIn = data.quiz && typeof data.quiz === 'object' && !Array.isArray(data.quiz) ? (data.quiz as Record<string, unknown>) : {};
  const quiz = { ...known.quiz };
  for (const k of Object.keys(quizIn).filter(foreign).sort()) if (isScore(quizIn[k])) quiz[k] = quizIn[k] as QuizScore;

  let last = known.last;
  const l = data.last as Record<string, unknown> | null | undefined;
  if (l && typeof l === 'object' && typeof l.pathId === 'string' && l.pathId && !l.pathId.includes('/')) {
    // Kept as saved, also when its path or step is unknown here
    const stepId = typeof l.stepId === 'string' ? l.stepId : null;
    last = isTime(l.at) ? { pathId: l.pathId, stepId, at: l.at } : { pathId: l.pathId, stepId };
  }

  const resets = { ...known.resets };
  const resetsIn = data.resets;
  if (resetsIn && typeof resetsIn === 'object' && !Array.isArray(resetsIn)) {
    const r = resetsIn as Record<string, unknown>;
    for (const k of Object.keys(r).filter(k => !(k in resets)).sort()) if (isTime(r[k])) resets[k] = r[k] as number;
  }
  const answers = { ...known.answers };
  const answersIn = data.answers;
  if (answersIn && typeof answersIn === 'object' && !Array.isArray(answersIn)) {
    const questionKeys = new Set(
      paths.flatMap(p => allSteps(p).flatMap(s => (s.kind === 'quiz' ? s.questions.map(q => stepKey(p.id, q.id)) : []))),
    );
    const r = answersIn as Record<string, unknown>;
    for (const k of Object.keys(r).filter(k => isKey(k) && !questionKeys.has(k)).sort()) {
      const rec = answerRecord(r[k]);
      if (rec) answers[k] = rec;
    }
  }

  const out: Journey = { read, quiz, last };
  if (Object.keys(resets).length) out.resets = resets;
  if (Object.keys(answers).length) out.answers = answers;
  return out;
}

export function parseJourney(text: string | null, paths: LearningPath[]): Journey {
  if (!text) return EMPTY_JOURNEY;
  try {
    return sanitizeJourneyRecord(JSON.parse(text), paths);
  } catch {
    return EMPTY_JOURNEY;
  }
}

/** Null (remove the key) only when there is nothing at all to keep, tombstones included. */
export function serializeJourney(journey: Journey): string | null {
  const empty =
    journey.read.length === 0 &&
    Object.keys(journey.quiz).length === 0 &&
    !journey.last &&
    Object.keys(journey.resets ?? {}).length === 0 &&
    Object.keys(journey.answers ?? {}).length === 0;
  return empty ? null : JSON.stringify(journey);
}

const pathOfKey = (key: string) => key.slice(0, key.indexOf('/'));

/**
 * Merge two copies of the journey (what another tab saved, and this tab's): the union of lessons
 * read, the best score per quiz, the newest `last` and, per question, the answer record answered
 * last, leaving out what a newer reset of a path
 * cleared (see Journey.resets). The result is in canonical order (as sanitizeJourney gives it).
 */
export function mergeJourney(a: Journey, b: Journey, paths: LearningPath[]): Journey {
  const resets: Record<string, number> = {};
  for (const j of [a, b]) for (const [k, t] of Object.entries(j.resets ?? {})) resets[k] = Math.max(resets[k] ?? 0, t);
  // True when copy j has seen the newest reset of this path, so its data for the path still counts
  const current = (j: Journey, pathId: string) => (j.resets?.[pathId] ?? 0) >= (resets[pathId] ?? 0);

  const read = [...a.read.filter(k => current(a, pathOfKey(k))), ...b.read.filter(k => current(b, pathOfKey(k)))];
  const quiz: Record<string, QuizScore> = {};
  for (const j of [a, b]) {
    for (const [k, s] of Object.entries(j.quiz)) {
      if (!current(j, pathOfKey(k))) continue;
      const prev = quiz[k];
      if (!prev || s.correct / s.total > prev.correct / prev.total) quiz[k] = s;
    }
  }
  // The newest `last` wins (b, this tab's, on a tie); one older than its path's newest reset is dropped
  let last: Journey['last'] = null;
  for (const j of [a, b]) {
    const l = j.last;
    if (!l || !current(j, l.pathId)) continue;
    if (!last || (l.at ?? 0) >= (last.at ?? 0)) last = l;
  }
  // Per question, the record answered last wins (on a tie the longer history, then the text, so both orders agree)
  const answers: Record<string, AnswerRecord> = {};
  for (const j of [a, b]) {
    for (const [k, r] of Object.entries(j.answers ?? {})) {
      if (!current(j, pathOfKey(k))) continue;
      const prev = answers[k];
      if (
        !prev ||
        r.lastAt > prev.lastAt ||
        (r.lastAt === prev.lastAt &&
          (r.history.length > prev.history.length ||
            (r.history.length === prev.history.length && JSON.stringify(r.history) > JSON.stringify(prev.history))))
      )
        answers[k] = r;
    }
  }
  return sanitizeJourneyRecord({ read, quiz, last, resets, answers }, paths);
}

/** How useSyncedStorage reads, merges and writes the journey. */
export function journeyCodec(paths: LearningPath[]): SyncedCodec<Journey> {
  return {
    parse: text => parseJourney(text, paths),
    merge: (stored, mine) => mergeJourney(stored, mine, paths),
    serialize: serializeJourney,
  };
}

// ---------- Updates (return a new journey, or the same one when nothing changes) ----------

export function markRead(j: Journey, pathId: string, stepId: string): Journey {
  const key = stepKey(pathId, stepId);
  return j.read.includes(key) ? j : { ...j, read: [...j.read, key] };
}

/** Keeps the better of the saved and the new score (by fraction correct). */
export function recordQuizScore(j: Journey, pathId: string, stepId: string, score: QuizScore): Journey {
  const key = stepKey(pathId, stepId);
  const prev = j.quiz[key];
  if (prev && prev.correct / prev.total >= score.correct / score.total) return j;
  return { ...j, quiz: { ...j.quiz, [key]: score } };
}

export function visit(j: Journey, pathId: string, stepId: string | null, now: number = Date.now()): Journey {
  if (j.last && j.last.pathId === pathId && j.last.stepId === stepId) return j;
  return { ...j, last: { pathId, stepId, at: now } };
}

/**
 * Forget lesson reads and quiz scores for one path, in every tab: it also writes a reset tombstone
 * (see Journey.resets). Lab progress is shared with the lab lists and stays.
 */
export function resetPath(j: Journey, pathId: string, now: number = Date.now()): Journey {
  const prefix = `${pathId}/`;
  const quiz: Record<string, QuizScore> = {};
  for (const [k, v] of Object.entries(j.quiz)) if (!k.startsWith(prefix)) quiz[k] = v;
  const answers: Record<string, AnswerRecord> = {};
  for (const [k, v] of Object.entries(j.answers ?? {})) if (!k.startsWith(prefix)) answers[k] = v;
  const resets = { ...j.resets };
  // Strictly newer than any earlier reset (and than `last`), even if the clock went back
  resets[pathId] = Math.max(now, (resets[pathId] ?? 0) + 1, (j.last?.pathId === pathId ? (j.last.at ?? 0) : 0) + 1);
  const out: Journey = {
    read: j.read.filter(k => !k.startsWith(prefix)),
    quiz,
    last: j.last?.pathId === pathId ? null : j.last,
    resets,
  };
  if (Object.keys(answers).length) out.answers = answers;
  return out;
}

/** Adds one answer to a checkpoint question's record (the newest ANSWER_HISTORY are kept). */
export function recordAnswer(j: Journey, pathId: string, questionId: string, right: boolean, now: number = Date.now()): Journey {
  const key = stepKey(pathId, questionId);
  const prev = j.answers?.[key];
  const history = [...(prev?.history ?? []), right].slice(-ANSWER_HISTORY);
  // Strictly newer than the answer before, even if the clock went back, so this one wins a merge
  const lastAt = Math.max(now, (prev?.lastAt ?? 0) + 1);
  return { ...j, answers: { ...j.answers, [key]: { history, lastAt } } };
}

// ---------- Lookups ----------

export function allSteps(path: LearningPath): PathStep[] {
  return path.stages.flatMap(s => s.steps);
}

export interface StepLocation {
  stage: PathStage;
  stageIndex: number;
  step: PathStep;
  /** Position in the whole path, 0-based */
  index: number;
}

export function findStep(path: LearningPath, stepId: string): StepLocation | null {
  let index = 0;
  for (let stageIndex = 0; stageIndex < path.stages.length; stageIndex++) {
    const stage = path.stages[stageIndex];
    for (const step of stage.steps) {
      if (step.id === stepId) return { stage, stageIndex, step, index };
      index++;
    }
  }
  return null;
}

export function stepAt(path: LearningPath, index: number): StepLocation | null {
  const step = allSteps(path)[index];
  return step ? findStep(path, step.id) : null;
}

// ---------- Completion rules ----------

/** What the completion rules need to know besides the journey itself. */
export interface CompletionSource {
  journey: Journey;
  /** True when every objective of that lab is done */
  labComplete: (moduleId: string) => boolean;
}

/** Builds the lab check from the shared lab progress record. Unknown labs are never complete. */
export function labCheck(progress: Record<string, string[]>, modules: ExamModule[]): (moduleId: string) => boolean {
  const byId = new Map(modules.map(m => [m.id, m]));
  return moduleId => {
    const mod = byId.get(moduleId);
    if (!mod || mod.objectives.length === 0) return false;
    const done = progress[moduleId] ?? [];
    return mod.objectives.every(o => done.includes(o.id));
  };
}

export function quizPassed(score: QuizScore | undefined, passMark: number): boolean {
  return !!score && score.total > 0 && score.correct / score.total >= passMark - 1e-9;
}

/** Number of right answers needed to pass a quiz of this many questions. */
export function correctNeeded(total: number, passMark: number): number {
  return Math.max(1, Math.ceil(total * passMark - 1e-9));
}

export function stepComplete(pathId: string, step: PathStep, src: CompletionSource): boolean {
  switch (step.kind) {
    case 'lesson':
      return src.journey.read.includes(stepKey(pathId, step.id));
    case 'lab':
      return src.labComplete(step.moduleId);
    case 'quiz':
      return quizPassed(src.journey.quiz[stepKey(pathId, step.id)], step.passMark);
  }
}

/** A stage's steps as the things to do: one step, or the alternatives sharing a choiceGroup (in first-seen order). */
export function stageUnits(stage: PathStage): PathStep[][] {
  const units: PathStep[][] = [];
  const groups = new Map<string, PathStep[]>();
  for (const step of stage.steps) {
    if (!step.choiceGroup) {
      units.push([step]);
      continue;
    }
    const unit = groups.get(step.choiceGroup);
    if (unit) unit.push(step);
    else {
      const fresh = [step];
      groups.set(step.choiceGroup, fresh);
      units.push(fresh);
    }
  }
  return units;
}

/** Done, or one of its alternatives (same choiceGroup in the same stage) is done. */
export function stepSatisfied(pathId: string, stage: PathStage, step: PathStep, src: CompletionSource): boolean {
  if (stepComplete(pathId, step, src)) return true;
  return !!step.choiceGroup && stage.steps.some(s => s.choiceGroup === step.choiceGroup && stepComplete(pathId, s, src));
}

export function stageComplete(pathId: string, stage: PathStage, src: CompletionSource): boolean {
  return stageUnits(stage).every(unit => unit.some(step => stepComplete(pathId, step, src)));
}

/**
 * The suggested order: the first stage, then each later one once the stage before it is complete.
 * Nothing is locked. A stage that is not suggested yet can still be opened ("Suggested after ...
 * Go ahead if you know it already"); "Continue" (nextStep, stepAfter, resumeTarget) keeps to this order.
 */
export function stageSuggested(path: LearningPath, stageIndex: number, src: CompletionSource): boolean {
  if (stageIndex <= 0) return true;
  const prev = path.stages[stageIndex - 1];
  return !!prev && stageComplete(path.id, prev, src);
}

export function stepSuggested(path: LearningPath, stepId: string, src: CompletionSource): boolean {
  const loc = findStep(path, stepId);
  return !!loc && stageSuggested(path, loc.stageIndex, src);
}

/** The stage a not-yet-suggested stage is suggested after (the one before it), or null when it is suggested now. */
export function suggestedAfter(path: LearningPath, stageIndex: number, src: CompletionSource): PathStage | null {
  return stageSuggested(path, stageIndex, src) ? null : path.stages[stageIndex - 1] ?? null;
}

/**
 * @deprecated Stages are no longer locked; this is the suggested order (stageSuggested).
 * Every stage can be opened.
 */
export const stageUnlocked = stageSuggested;
/** @deprecated See stageUnlocked; use stepSuggested. */
export const stepUnlocked = stepSuggested;

/**
 * "Test out": the lessons of a stage marked as known, because the learner passed that stage's
 * checkpoint. Labs are not touched: a lab is done when its tasks are. Lessons that are alternatives
 * of one another (a choiceGroup) count once: the first is marked, and none when one is read already.
 */
export function lessonsToTestOut(path: LearningPath, stageIndex: number, journey: Journey): string[] {
  const stage = path.stages[stageIndex];
  if (!stage) return [];
  const read = (s: PathStep) => journey.read.includes(stepKey(path.id, s.id));
  // Alternatives (a choiceGroup) count once: none when one of them is read already, else the first lesson
  const out: string[] = [];
  for (const unit of stageUnits(stage)) {
    const lessons = unit.filter(s => s.kind === 'lesson');
    if (lessons.length === 0 || lessons.some(read)) continue;
    out.push(lessons[0].id);
  }
  return out;
}

/** Things done and to do; alternatives (see stageUnits) count once. */
export function stepsDone(path: LearningPath, src: CompletionSource): { done: number; total: number } {
  const units = path.stages.flatMap(stageUnits);
  return { done: units.filter(u => u.some(s => stepComplete(path.id, s, src))).length, total: units.length };
}

/** Whole-number percent of steps complete. */
export function pathPercent(path: LearningPath, src: CompletionSource): number {
  const { done, total } = stepsDone(path, src);
  return total === 0 ? 0 : Math.round((done / total) * 100);
}

/** Index of the stage the learner is working on: the earliest incomplete stage, or -1 when all are done. */
export function currentStageIndex(path: LearningPath, src: CompletionSource): number {
  return path.stages.findIndex(stage => !stageComplete(path.id, stage, src));
}

/**
 * The step "Continue" goes to: the first incomplete step of the earliest incomplete stage.
 * That stage is always in the suggested order, because every stage before it is complete. Null when the path is finished.
 */
export function nextStep(path: LearningPath, src: CompletionSource): StepLocation | null {
  const stageIndex = currentStageIndex(path, src);
  if (stageIndex < 0) return null;
  const stage = path.stages[stageIndex];
  const step = stage.steps.find(s => !stepSatisfied(path.id, stage, s, src));
  return step ? findStep(path, step.id) : null;
}

/**
 * Where to go after finishing the step `fromStepId`: the next incomplete step after it, in a suggested stage,
 * in path order, otherwise the first incomplete step anywhere (via nextStep). Null when the path is finished.
 */
export function stepAfter(path: LearningPath, fromStepId: string, src: CompletionSource): StepLocation | null {
  const from = findStep(path, fromStepId);
  const steps = allSteps(path);
  if (from) {
    for (let i = from.index + 1; i < steps.length; i++) {
      const loc = findStep(path, steps[i].id)!;
      // Within the stage of `from` any open step will do (a learner who went ahead stays there);
      // a later stage only once it is in the suggested order
      if (loc.stageIndex !== from.stageIndex && !stageSuggested(path, loc.stageIndex, src)) break;
      if (!stepSatisfied(path.id, loc.stage, loc.step, src)) return loc;
    }
  }
  const next = nextStep(path, src);
  return next && next.step.id !== fromStepId ? next : null;
}

/** True once the learner has done anything in the path or opened it. */
export function pathStarted(path: LearningPath, src: CompletionSource): boolean {
  if (src.journey.last?.pathId === path.id) return true;
  const prefix = `${path.id}/`;
  if (src.journey.read.some(k => k.startsWith(prefix))) return true;
  if (Object.keys(src.journey.quiz).some(k => k.startsWith(prefix))) return true;
  if (Object.keys(src.journey.answers ?? {}).some(k => k.startsWith(prefix))) return true;
  return stepsDone(path, src).done > 0;
}

/**
 * "Continue where you left off": the last step opened, if it is still unfinished and in the suggested order,
 * otherwise the next step of that path. Null when there is nothing to resume.
 */
export function resumeTarget(
  paths: LearningPath[],
  src: CompletionSource,
): { path: LearningPath; loc: StepLocation } | null {
  const last = src.journey.last;
  if (!last) return null;
  const path = paths.find(p => p.id === last.pathId);
  if (!path) return null;
  if (last.stepId) {
    const loc = findStep(path, last.stepId);
    if (loc && !stepSatisfied(path.id, loc.stage, loc.step, src) && stageSuggested(path, loc.stageIndex, src)) return { path, loc };
  }
  const next = nextStep(path, src);
  return next ? { path, loc: next } : null;
}

// ---------- Display helpers ----------

/** Minutes for one step: lesson minutes, the lab's estimate, about a minute per quiz question. */
export function stepMinutes(step: PathStep, modulesById: Map<string, ExamModule>): number {
  switch (step.kind) {
    case 'lesson':
      return step.minutes;
    case 'lab':
      return modulesById.get(step.moduleId)?.estimatedMinutes ?? 0;
    case 'quiz':
      return step.questions.length;
  }
}

/** Alternatives count once, by the first of them. */
export function pathMinutes(path: LearningPath, modulesById: Map<string, ExamModule>): number {
  return path.stages.flatMap(stageUnits).reduce((sum, unit) => sum + stepMinutes(unit[0], modulesById), 0);
}

/** "about 45 min", "about 2 hr 10 min", "about 3 hr" */
export function formatMinutes(total: number): string {
  if (total < 60) return `about ${total} min`;
  const h = Math.floor(total / 60);
  const m = Math.round((total % 60) / 5) * 5;
  if (m === 0) return `about ${h} hr`;
  if (m === 60) return `about ${h + 1} hr`;
  return `about ${h} hr ${m} min`;
}

export function stepTitle(step: PathStep, modulesById: Map<string, ExamModule>): string {
  if (step.kind === 'lab') return modulesById.get(step.moduleId)?.title ?? 'Lab';
  return step.title;
}

export interface LabPlacement {
  path: LearningPath;
  stage: PathStage;
  stageIndex: number;
  stepId: string;
}

/** moduleId -> every path step that uses that lab, in path order. */
export function labPlacements(paths: LearningPath[]): Map<string, LabPlacement[]> {
  const out = new Map<string, LabPlacement[]>();
  for (const path of paths) {
    path.stages.forEach((stage, stageIndex) => {
      for (const step of stage.steps) {
        if (step.kind !== 'lab') continue;
        const list = out.get(step.moduleId) ?? [];
        list.push({ path, stage, stageIndex, stepId: step.id });
        out.set(step.moduleId, list);
      }
    });
  }
  return out;
}

// ---------- Review queue ----------

const DAY_MS = 86_400_000;
/** After 1, 2, 3 and 4 or more right answers in a row, a question comes back this many days later */
export const REVIEW_DAYS = [1, 3, 7, 21];
/** A wrong answer brings the question back soon: in the next review that starts this long after */
export const REVIEW_SOON_MS = 10 * 60_000;
/** Questions in one review */
export const REVIEW_SIZE = 5;

/** Right answers in a row at the end of the history. */
export function rightStreak(history: boolean[]): number {
  let n = 0;
  for (let i = history.length - 1; i >= 0 && history[i]; i--) n++;
  return n;
}

/** How long after its last answer a question comes back (ms). */
export function reviewInterval(history: boolean[]): number {
  const streak = rightStreak(history);
  if (streak === 0) return REVIEW_SOON_MS;
  return REVIEW_DAYS[Math.min(streak, REVIEW_DAYS.length) - 1] * DAY_MS;
}

export const reviewDueAt = (r: AnswerRecord): number => r.lastAt + reviewInterval(r.history);

export interface ReviewItem {
  path: LearningPath;
  /** The checkpoint the question belongs to */
  quiz: Extract<PathStep, { kind: 'quiz' }>;
  question: QuizQuestion;
  /** "pathId/questionId", the key in Journey.answers */
  key: string;
}

/** Interleave lists so neighbours come from different paths where possible. */
function mixByPath(items: ReviewItem[], paths: LearningPath[]): ReviewItem[] {
  const lists = paths.map(p => items.filter(i => i.path.id === p.id)).filter(l => l.length > 0);
  const out: ReviewItem[] = [];
  for (let round = 0; out.length < items.length; round++) for (const l of lists) if (l[round]) out.push(l[round]);
  return out;
}

/**
 * Up to REVIEW_SIZE questions that are due, mixed across the paths the learner has started:
 * first the ones last answered wrong, then the ones answered right a while ago (most overdue
 * first), then questions from checkpoints taken before answers were recorded (older saved data).
 */
export function reviewQueue(paths: LearningPath[], src: CompletionSource, now: number = Date.now(), size = REVIEW_SIZE): ReviewItem[] {
  const answers = src.journey.answers ?? {};
  const missed: [ReviewItem, number][] = [];
  const spaced: [ReviewItem, number][] = [];
  const legacy: ReviewItem[] = [];
  for (const path of paths) {
    if (!pathStarted(path, src)) continue;
    for (const step of allSteps(path)) {
      if (step.kind !== 'quiz') continue;
      const taken = !!src.journey.quiz[stepKey(path.id, step.id)];
      for (const question of step.questions) {
        const key = stepKey(path.id, question.id);
        const item: ReviewItem = { path, quiz: step, question, key };
        const r = answers[key];
        if (!r) {
          if (taken) legacy.push(item);
          continue;
        }
        const due = reviewDueAt(r);
        if (due > now) continue;
        if (r.history[r.history.length - 1]) spaced.push([item, due]);
        else missed.push([item, r.lastAt]);
      }
    }
  }
  const byTime = (list: [ReviewItem, number][]) => list.sort((x, y) => x[1] - y[1]).map(([i]) => i);
  return [...mixByPath(byTime(missed), paths), ...mixByPath(byTime(spaced), paths), ...mixByPath(legacy, paths)].slice(0, size);
}

/** For the Learn page: how many questions are due now, and when the next one comes back if none is. */
export function reviewStatus(paths: LearningPath[], src: CompletionSource, now: number = Date.now()): { due: number; nextAt: number | null } {
  const due = reviewQueue(paths, src, now, Infinity).length;
  let nextAt: number | null = null;
  if (due === 0) {
    for (const path of paths) {
      if (!pathStarted(path, src)) continue;
      for (const [k, r] of Object.entries(src.journey.answers ?? {})) {
        if (pathOfKey(k) !== path.id) continue;
        const t = reviewDueAt(r);
        if (nextAt === null || t < nextAt) nextAt = t;
      }
    }
  }
  return { due, nextAt };
}

/** "tomorrow", "in a few days", "in a week", "in three weeks", "soon": when a question comes back after this history. */
export function comeBackPhrase(history: boolean[]): string {
  const streak = rightStreak(history);
  if (streak === 0) return 'soon';
  return ['tomorrow', 'in a few days', 'in a week', 'in three weeks'][Math.min(streak, REVIEW_DAYS.length) - 1];
}

/** "later today", "tomorrow", "in 3 days": how far off a time is, for the Learn page. */
export function whenText(at: number, now: number = Date.now()): string {
  const days = Math.ceil((at - now) / DAY_MS);
  if (days <= 0 || at - now < 12 * 3_600_000) return 'later today';
  if (days === 1) return 'tomorrow';
  return `in ${days} days`;
}

/** "1 comes back soon and 4 in a few days.": when each question (given its answer history) comes back, grouped. */
export function comeBackText(histories: boolean[][]): string {
  const groups = new Map<string, { count: number; interval: number }>();
  for (const h of histories) {
    const phrase = comeBackPhrase(h);
    const g = groups.get(phrase) ?? { count: 0, interval: reviewInterval(h) };
    g.count++;
    groups.set(phrase, g);
  }
  const parts = [...groups.entries()]
    .sort((a, b) => a[1].interval - b[1].interval)
    .map(([phrase, g], i) => (i === 0 ? `${g.count} ${g.count === 1 ? 'comes' : 'come'} back ${phrase}` : `${g.count} ${phrase}`));
  if (parts.length === 0) return '';
  const last = parts.pop()!;
  return `${parts.length ? `${parts.join(', ')} and ${last}` : last}.`;
}
