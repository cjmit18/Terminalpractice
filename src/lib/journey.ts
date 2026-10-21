import { ExamModule } from '../types/modules';
import { LearningPath, PathStage, PathStep } from '../types/paths';
import { readStorage, writeStorage } from './storage';

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
  /** The last path (and step, if any) the learner had open */
  last: { pathId: string; stepId: string | null } | null;
}

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
      last = { pathId: path.id, stepId };
    }
  }
  return { read, quiz, last };
}

export function loadJourney(paths: LearningPath[]): Journey {
  const text = readStorage(JOURNEY_KEY);
  if (!text) return EMPTY_JOURNEY;
  try {
    return sanitizeJourney(JSON.parse(text), paths);
  } catch {
    return EMPTY_JOURNEY;
  }
}

export function saveJourney(journey: Journey): void {
  const empty = journey.read.length === 0 && Object.keys(journey.quiz).length === 0 && !journey.last;
  writeStorage(JOURNEY_KEY, empty ? null : JSON.stringify(journey));
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

export function visit(j: Journey, pathId: string, stepId: string | null): Journey {
  if (j.last && j.last.pathId === pathId && j.last.stepId === stepId) return j;
  return { ...j, last: { pathId, stepId } };
}

/** Forget lesson reads and quiz scores for one path. Lab progress is shared with the lab lists and stays. */
export function resetPath(j: Journey, pathId: string): Journey {
  const prefix = `${pathId}/`;
  const quiz: Record<string, QuizScore> = {};
  for (const [k, v] of Object.entries(j.quiz)) if (!k.startsWith(prefix)) quiz[k] = v;
  return {
    read: j.read.filter(k => !k.startsWith(prefix)),
    quiz,
    last: j.last?.pathId === pathId ? null : j.last,
  };
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

export function stageComplete(pathId: string, stage: PathStage, src: CompletionSource): boolean {
  return stage.steps.every(step => stepComplete(pathId, step, src));
}

/** The first stage is always open; each later one opens when the stage before it is complete. */
export function stageUnlocked(path: LearningPath, stageIndex: number, src: CompletionSource): boolean {
  if (stageIndex <= 0) return true;
  const prev = path.stages[stageIndex - 1];
  return !!prev && stageComplete(path.id, prev, src);
}

export function stepUnlocked(path: LearningPath, stepId: string, src: CompletionSource): boolean {
  const loc = findStep(path, stepId);
  return !!loc && stageUnlocked(path, loc.stageIndex, src);
}

export function stepsDone(path: LearningPath, src: CompletionSource): { done: number; total: number } {
  const steps = allSteps(path);
  return { done: steps.filter(s => stepComplete(path.id, s, src)).length, total: steps.length };
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
 * That stage is always unlocked, because every stage before it is complete. Null when the path is finished.
 */
export function nextStep(path: LearningPath, src: CompletionSource): StepLocation | null {
  const stageIndex = currentStageIndex(path, src);
  if (stageIndex < 0) return null;
  const step = path.stages[stageIndex].steps.find(s => !stepComplete(path.id, s, src));
  return step ? findStep(path, step.id) : null;
}

/**
 * Where to go after finishing the step `fromStepId`: the next incomplete, unlocked step after it
 * in path order, otherwise the first incomplete step anywhere (via nextStep). Null when the path is finished.
 */
export function stepAfter(path: LearningPath, fromStepId: string, src: CompletionSource): StepLocation | null {
  const from = findStep(path, fromStepId);
  const steps = allSteps(path);
  if (from) {
    for (let i = from.index + 1; i < steps.length; i++) {
      const loc = findStep(path, steps[i].id)!;
      if (!stageUnlocked(path, loc.stageIndex, src)) break;
      if (!stepComplete(path.id, loc.step, src)) return loc;
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
  return stepsDone(path, src).done > 0;
}

/**
 * "Continue where you left off": the last step opened, if it is still unfinished and open,
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
    if (loc && !stepComplete(path.id, loc.step, src) && stageUnlocked(path, loc.stageIndex, src)) return { path, loc };
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

export function pathMinutes(path: LearningPath, modulesById: Map<string, ExamModule>): number {
  return allSteps(path).reduce((sum, s) => sum + stepMinutes(s, modulesById), 0);
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
