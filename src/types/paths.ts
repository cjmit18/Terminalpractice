/**
 * Guided learning paths: an ordered course for one exam, built from short lessons,
 * the existing labs and checkpoint quizzes.
 *
 * Rules the UI relies on:
 * - Path ids, stage ids and step ids are stable (they key saved progress). Step ids are unique within a path.
 * - A stage unlocks when every step of the previous stage is complete. Steps inside a stage can be done in any order.
 * - A lesson is complete once the learner marks it read; a lab once all its objectives pass;
 *   a quiz once the learner scores at least `passMark` (fraction of questions, 0-1).
 */

export type PathTrack = 'linux' | 'windows';

/** One block of lesson content. Plain text only: no HTML or Markdown inside strings. */
export type LessonBlock =
  | { type: 'p'; text: string }
  | { type: 'heading'; text: string }
  | { type: 'list'; items: string[]; ordered?: boolean }
  /** Something to type or read in a terminal. `shell` picks the prompt style. */
  | { type: 'code'; code: string; shell?: 'bash' | 'cmd' | 'powershell'; caption?: string }
  /** A short aside: an exam trap, a common mistake, a real-world note */
  | { type: 'note'; tone: 'tip' | 'warning' | 'exam'; text: string }
  /** Two-column reference table, e.g. octal digit -> permissions */
  | { type: 'table'; columns: [string, string]; rows: [string, string][] };

export interface QuizQuestion {
  id: string;
  prompt: string;
  /** Optional command or output shown under the prompt, in monospace */
  code?: string;
  choices: string[];
  /** Index into `choices` */
  answer: number;
  /** Why the answer is right (and the tempting wrong one is wrong). Shown after answering. */
  explanation: string;
}

export type PathStep =
  | {
      kind: 'lesson';
      id: string;
      title: string;
      minutes: number;
      blocks: LessonBlock[];
    }
  | {
      kind: 'lab';
      id: string;
      /** An ExamModule id from src/data/lpiModules.ts or windowsPbqs.ts */
      moduleId: string;
      /** One sentence on why this lab sits here in the path */
      note?: string;
    }
  | {
      kind: 'quiz';
      id: string;
      title: string;
      /** Fraction of questions needed to pass, e.g. 0.75 */
      passMark: number;
      questions: QuizQuestion[];
    };

export interface PathStage {
  id: string;
  title: string;
  /** What you will be able to do after this stage, one sentence */
  goal: string;
  steps: PathStep[];
}

export interface LearningPath {
  id: string;
  track: PathTrack;
  title: string;
  /** One or two plain sentences for the path list */
  summary: string;
  /** Exam(s) the path prepares for, e.g. "LPIC-1 101-500" */
  exam: string;
  /** Who it is for / what you should know first, one sentence */
  audience: string;
  stages: PathStage[];
}
