import type { LearningPath, PathStep, QuizQuestion } from '../types/paths';
import { type CompletionSource, quizPassed, stepComplete, stepKey } from '../lib/journey';

/**
 * Exam objectives and how far the learner has practised each one in a path.
 *
 * Numbers follow the published objectives:
 * - LPIC-1 version 5.0 (exams 101-500 and 102-500), one entry per objective (101.1, 104.5...).
 *   LPI's page: https://www.lpi.org/our-certifications/exam-101-102-objectives/
 *   Version 5.0 has no 104.4 or 105.3 (quotas and SQL were removed), so those numbers are absent on purpose.
 * - CompTIA A+ Core 2 (220-1202), Network+ (N10-009) and Security+ (SY0-701), one entry per domain (1.0, 2.0...).
 *   Domains are coarse, so "covered" there means the path has some practice inside that domain, not all of it.
 *
 * Titles are short paraphrases, not the official wording. Weights are left out on purpose: they change
 * between revisions, and the official page is the place to read them.
 *
 * `covered` says whether any lesson, lab or question in this app is tagged with the objective. A unit test
 * keeps it in step with the tags in src/data/paths.ts.
 */

export type ExamId = 'lpic1-101' | 'lpic1-102' | 'aplus-220-1202' | 'netplus-n10-009' | 'secplus-sy0-701';

export interface ExamInfo {
  id: ExamId;
  /** Display name, e.g. "LPIC-1 101-500" */
  name: string;
  /** The official objectives page for this exam */
  url: string;
  /** Plain name of that page, used as link text */
  urlLabel: string;
  /** 'objective' for LPI's numbered objectives, 'domain' for CompTIA's domains */
  level: 'objective' | 'domain';
}

export interface ExamObjective {
  /** Stable id used in content tags: "101.1" for LPIC-1, "<exam>:<domain>" for CompTIA, e.g. "n10-009:5.0" */
  id: string;
  exam: ExamId;
  /** The number as printed by the exam body, e.g. "104.5" or "5.0" */
  number: string;
  /** Short title in our own words */
  title: string;
  covered: boolean;
}

const LPI_URL = 'https://www.lpi.org/our-certifications/exam-101-102-objectives/';

export const EXAMS: Record<ExamId, ExamInfo> = {
  'lpic1-101': { id: 'lpic1-101', name: 'LPIC-1 101-500', url: LPI_URL, urlLabel: 'LPIC-1 exam objectives on lpi.org', level: 'objective' },
  'lpic1-102': { id: 'lpic1-102', name: 'LPIC-1 102-500', url: LPI_URL, urlLabel: 'LPIC-1 exam objectives on lpi.org', level: 'objective' },
  'aplus-220-1202': {
    id: 'aplus-220-1202',
    name: 'CompTIA A+ Core 2 (220-1202)',
    url: 'https://comptiacdn.azureedge.net/webcontent/docs/default-source/exam-objectives/comptia-a-220-1202-exam-objectives.pdf',
    urlLabel: 'A+ Core 2 exam objectives from CompTIA (PDF)',
    level: 'domain',
  },
  'netplus-n10-009': {
    id: 'netplus-n10-009',
    name: 'CompTIA Network+ (N10-009)',
    url: 'https://comptiacdn.azureedge.net/webcontent/docs/default-source/exam-objectives/comptia-network-n10-009-exam-objectives-(4-0)-(1).pdf',
    urlLabel: 'Network+ exam objectives from CompTIA (PDF)',
    level: 'domain',
  },
  'secplus-sy0-701': {
    id: 'secplus-sy0-701',
    name: 'CompTIA Security+ (SY0-701)',
    url: 'https://www.comptia.org/certifications/security',
    urlLabel: 'Security+ on comptia.org, where the objectives can be downloaded',
    level: 'domain',
  },
};

const lpi = (exam: ExamId, rows: [string, string, boolean][]): ExamObjective[] =>
  rows.map(([number, title, covered]) => ({ id: number, exam, number, title, covered }));

const comptia = (exam: ExamId, prefix: string, rows: [string, string, boolean][]): ExamObjective[] =>
  rows.map(([number, title, covered]) => ({ id: `${prefix}:${number}`, exam, number, title, covered }));

export const EXAM_OBJECTIVES: ExamObjective[] = [
  ...lpi('lpic1-101', [
    ['101.1', 'Hardware settings, kernel modules and /proc, /sys, /dev', true],
    ['101.2', 'The boot sequence and boot messages', true],
    ['101.3', 'Runlevels, systemd targets, shutdown and reboot', true],
    ['102.1', 'Planning a disk layout', true],
    ['102.2', 'Installing a boot manager (GRUB)', false],
    ['102.3', 'Shared libraries', false],
    ['102.4', 'Debian packages: dpkg and apt', false],
    ['102.5', 'RPM packages: rpm, yum, dnf and zypper', false],
    ['102.6', 'Linux as a virtual machine or container guest', false],
    ['103.1', 'Working on the command line: shell, variables, history', false],
    ['103.2', 'Text filters: grep, cut, sort, uniq and others', true],
    ['103.3', 'File management: cp, mv, find, tar, globbing', false],
    ['103.4', 'Streams, pipes and redirection', true],
    ['103.5', 'Starting, watching and stopping processes', true],
    ['103.6', 'Process priority: nice and renice', true],
    ['103.7', 'Searching text with regular expressions', false],
    ['103.8', 'Editing files with vi', false],
    ['104.1', 'Creating partitions and filesystems', true],
    ['104.2', 'Checking filesystem integrity and free space', true],
    ['104.3', 'Mounting, unmounting and /etc/fstab', true],
    ['104.5', 'Permissions and ownership', true],
    ['104.6', 'Hard and symbolic links', false],
    ['104.7', 'Finding system files and the FHS', false],
  ]),
  ...lpi('lpic1-102', [
    ['105.1', 'Customising the shell environment', false],
    ['105.2', 'Writing simple shell scripts', false],
    ['106.1', 'Installing and configuring X11', false],
    ['106.2', 'Graphical desktops', false],
    ['106.3', 'Accessibility', false],
    ['107.1', 'User and group accounts and their files', true],
    ['107.2', 'Scheduling jobs: cron, at and timers', true],
    ['107.3', 'Locales, languages and time zones', false],
    ['108.1', 'Keeping the system time', true],
    ['108.2', 'System logging and the journal', true],
    ['108.3', 'Mail transfer agent basics', false],
    ['108.4', 'Printers and printing', false],
    ['109.1', 'Internet protocol basics: addresses, subnets, ports', true],
    ['109.2', 'Persistent network configuration', true],
    ['109.3', 'Basic network troubleshooting', true],
    ['109.4', 'Client-side DNS', true],
    ['110.1', 'Security administration tasks', true],
    ['110.2', 'Host security', true],
    ['110.3', 'Encryption: SSH keys and GPG', true],
  ]),
  ...comptia('aplus-220-1202', 'aplus-1202', [
    ['1.0', 'Operating systems', true],
    ['2.0', 'Security', false],
    ['3.0', 'Software troubleshooting', true],
    ['4.0', 'Operational procedures', false],
  ]),
  ...comptia('netplus-n10-009', 'n10-009', [
    ['1.0', 'Networking concepts', true],
    ['2.0', 'Network implementation', false],
    ['3.0', 'Network operations', false],
    ['4.0', 'Network security', false],
    ['5.0', 'Network troubleshooting', true],
  ]),
  ...comptia('secplus-sy0-701', 'sy0-701', [
    ['1.0', 'General security concepts', false],
    ['2.0', 'Threats, vulnerabilities and mitigations', true],
    ['3.0', 'Security architecture', false],
    ['4.0', 'Security operations', true],
    ['5.0', 'Security programme management and oversight', false],
  ]),
];

export const OBJECTIVES_BY_ID: Map<string, ExamObjective> = new Map(EXAM_OBJECTIVES.map(o => [o.id, o]));

/** Which exams each learning path prepares for. Paths not listed here (the beginners' path) have no skill map. */
export const PATH_EXAMS: Record<string, ExamId[]> = {
  'lpic1-101': ['lpic1-101'],
  'lpic1-102': ['lpic1-102'],
  'aplus-core2': ['aplus-220-1202'],
  'netsec-windows': ['netplus-n10-009', 'secplus-sy0-701'],
};

// ---------- Where each objective is practised ----------

/** One piece of content tagged with an objective. Questions point at the quiz step that holds them. */
export type ObjectiveSource =
  | { kind: 'lesson' | 'lab'; step: PathStep }
  | { kind: 'question'; step: Extract<PathStep, { kind: 'quiz' }>; question: QuizQuestion };

/** objective id -> every lesson, lab and question in the path tagged with it, in path order. */
export function objectiveSources(path: LearningPath): Map<string, ObjectiveSource[]> {
  const out = new Map<string, ObjectiveSource[]>();
  const add = (id: string, src: ObjectiveSource) => {
    const list = out.get(id);
    if (list) list.push(src);
    else out.set(id, [src]);
  };
  for (const stage of path.stages) {
    for (const step of stage.steps) {
      if (step.kind === 'quiz') {
        for (const q of step.questions) for (const id of q.objectives ?? []) add(id, { kind: 'question', step, question: q });
      } else {
        for (const id of step.objectives ?? []) add(id, { kind: step.kind, step });
      }
    }
  }
  return out;
}

/** Every objective id tagged anywhere in the path. */
export function pathObjectiveIds(path: LearningPath): Set<string> {
  return new Set(objectiveSources(path).keys());
}

// ---------- State ----------

export type ObjectiveState = 'not-started' | 'practised' | 'confident' | 'not-covered';

export interface SkillOptions {
  /**
   * Hook for per-question answer history (see "Review queue", 2.8 in the recommendations). When it is
   * given and returns a history for a tagged question, Confident also needs that question's latest answer
   * to be right. Returns oldest-first booleans, or undefined when the question has never been answered.
   * Leave it out until answer history exists: Confident then rests on checkpoint scores alone.
   */
  questionHistory?: (pathId: string, questionId: string) => boolean[] | undefined;
}

/**
 * - Not covered: nothing in this path is tagged with it.
 * - Not started: nothing tagged with it is done yet.
 * - Practised: a tagged lesson is read or a tagged lab is done (or a tagged checkpoint is passed).
 * - Confident: every checkpoint with a question on it is passed (best score at or above its pass mark),
 *   and, once answer history exists, the latest answer to each of those questions was right.
 */
export function objectiveState(
  path: LearningPath,
  objectiveId: string,
  src: CompletionSource,
  opts: SkillOptions = {},
  sources: Map<string, ObjectiveSource[]> = objectiveSources(path),
): ObjectiveState {
  const list = sources.get(objectiveId);
  if (!list || list.length === 0) return 'not-covered';

  const quizzes = [...new Set(list.flatMap(s => (s.kind === 'question' ? [s.step] : [])))];
  const quizzesPassed =
    quizzes.length > 0 && quizzes.every(q => quizPassed(src.journey.quiz[stepKey(path.id, q.id)], q.passMark));
  const latestRight = list.every(s => {
    if (s.kind !== 'question' || !opts.questionHistory) return true;
    const h = opts.questionHistory(path.id, s.question.id);
    return !h || h.length === 0 || h[h.length - 1];
  });
  if (quizzesPassed && latestRight) return 'confident';

  const practised =
    list.some(s => s.kind !== 'question' && stepComplete(path.id, s.step, src)) ||
    quizzes.some(q => quizPassed(src.journey.quiz[stepKey(path.id, q.id)], q.passMark));
  return practised ? 'practised' : 'not-started';
}

export interface ExamSkillRow {
  objective: ExamObjective;
  state: ObjectiveState;
  lessons: number;
  labs: number;
  questions: number;
}

export interface PathSkillReport {
  exams: { exam: ExamInfo; rows: ExamSkillRow[] }[];
  /** Objectives this path has content for */
  covered: number;
  /** Of those, how many are practised or confident */
  practised: number;
  /** Mean of best checkpoint scores taken so far in this path, 0-100 rounded, or null if none taken */
  checkpointAverage: number | null;
  /** Objectives of this path's exams that this path does not cover */
  notCovered: ExamObjective[];
}

/** Everything the skill map shows for one path, or null for a path with no exam (the beginners' path). */
export function pathSkillReport(path: LearningPath, src: CompletionSource, opts: SkillOptions = {}): PathSkillReport | null {
  const examIds = PATH_EXAMS[path.id];
  if (!examIds || examIds.length === 0) return null;
  const sources = objectiveSources(path);

  const exams = examIds.map(id => ({
    exam: EXAMS[id],
    rows: EXAM_OBJECTIVES.filter(o => o.exam === id).map(objective => {
      const list = sources.get(objective.id) ?? [];
      return {
        objective,
        state: objectiveState(path, objective.id, src, opts, sources),
        lessons: list.filter(s => s.kind === 'lesson').length,
        labs: list.filter(s => s.kind === 'lab').length,
        questions: list.filter(s => s.kind === 'question').length,
      };
    }),
  }));
  const rows = exams.flatMap(e => e.rows);
  const coveredRows = rows.filter(r => r.state !== 'not-covered');

  const scores: number[] = [];
  for (const stage of path.stages)
    for (const step of stage.steps) {
      if (step.kind !== 'quiz') continue;
      const best = src.journey.quiz[stepKey(path.id, step.id)];
      if (best && best.total > 0) scores.push(best.correct / best.total);
    }

  return {
    exams,
    covered: coveredRows.length,
    practised: coveredRows.filter(r => r.state === 'practised' || r.state === 'confident').length,
    checkpointAverage: scores.length ? Math.round((scores.reduce((a, b) => a + b, 0) / scores.length) * 100) : null,
    notCovered: rows.filter(r => r.state === 'not-covered').map(r => r.objective),
  };
}
