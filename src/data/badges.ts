import type { ExamModule } from '../types/modules';
import type { LearningPath } from '../types/paths';
import type { Activity } from '../lib/activity';
import {
  CompletionSource,
  Journey,
  allSteps,
  currentStageIndex,
  labCheck,
  quizPassed,
  stageComplete,
  stepKey,
} from '../lib/journey';

/**
 * Badges: feedback on a new ability or a curious act, never on volume. Every check is a distinct
 * act or a set of different things, so repeating one command can never farm a badge.
 *
 * Badges are never required, never expire, and survive lab and path resets (they live in the
 * activity record, which no reset touches). Ids are stable: they key saved badges.
 */

export type BadgeFamily = 'curiosity' | 'resilience' | 'milestone';

/** What a badge check can look at */
export interface BadgeContext {
  facts: ReadonlySet<string>;
  activity: Activity;
  /** moduleId -> completed objective ids */
  progress: Record<string, string[]>;
  journey: Journey;
  src: CompletionSource;
  paths: LearningPath[];
  modules: ExamModule[];
}

export interface Badge {
  id: string;
  family: BadgeFamily;
  name: string;
  /** True when the name is literally something you type: shown in monospace */
  nameIsCommand?: boolean;
  /** What you did, one plain sentence, second person, shown once earned */
  description: string;
  /** How to earn it, shown in muted text while not earned */
  howTo: string;
  /** Not listed until earned */
  hidden?: boolean;
  check: (ctx: BadgeContext) => boolean;
}

export const FAMILY_LABEL: Record<BadgeFamily, string> = {
  curiosity: 'Curiosity',
  resilience: 'Recovering from errors',
  milestone: 'Milestones',
};

const has = (prefix: string) => (ctx: BadgeContext) => [...ctx.facts].some(f => f.startsWith(prefix));
const countPrefix = (ctx: BadgeContext, prefix: string) => [...ctx.facts].filter(f => f.startsWith(prefix)).length;

const labsDone = (ctx: BadgeContext) => ctx.modules.filter(m => ctx.src.labComplete(m.id));

const STATIC_BADGES: Badge[] = [
  // ---------- Curiosity ----------
  {
    id: 'whoami',
    family: 'curiosity',
    name: 'whoami',
    nameIsCommand: true,
    description: 'You asked the machine who you are.',
    howTo: 'Ask the machine which user you are logged in as.',
    check: ctx => ctx.facts.has('whoami'),
  },
  {
    id: 'man-man',
    family: 'curiosity',
    name: 'man man',
    nameIsCommand: true,
    description: 'You opened a manual page.',
    howTo: 'Open the manual or help page for any command.',
    check: has('help:'),
  },
  {
    id: 'flag-help',
    family: 'curiosity',
    name: '--help',
    nameIsCommand: true,
    description: 'You asked a command to explain itself.',
    howTo: 'Ask a command for its own usage with --help, /? or -?.',
    check: ctx => ctx.facts.has('flaghelp'),
  },
  {
    id: 'apropos',
    family: 'curiosity',
    name: 'apropos',
    nameIsCommand: true,
    description: 'You searched the manual by keyword.',
    howTo: 'Search the manual by keyword instead of by command name.',
    check: ctx => ctx.facts.has('search'),
  },
  {
    id: 'bookworm',
    family: 'curiosity',
    name: 'Bookworm',
    description: 'You read the manual for ten different commands.',
    howTo: 'Read the manual or help for ten different commands.',
    check: ctx => countPrefix(ctx, 'help:') >= 10,
  },
  {
    id: 'tab',
    family: 'curiosity',
    name: 'Tab',
    description: 'You pressed Tab and it finished a command name for you.',
    howTo: 'Type the start of a command name and press Tab.',
    check: ctx => ctx.facts.has('tab'),
  },
  {
    id: 'history',
    family: 'curiosity',
    name: 'history',
    nameIsCommand: true,
    description: 'You brought back an earlier command instead of typing it again.',
    howTo: 'Bring back an earlier command with the up arrow or history.',
    check: ctx => ctx.facts.has('history'),
  },
  {
    id: 'three-shells',
    family: 'curiosity',
    name: 'Three shells',
    description: 'You ran commands in bash, Command Prompt and PowerShell.',
    howTo: 'Run a command in each of bash, Command Prompt and PowerShell.',
    check: ctx => ['shell:bash', 'shell:cmd', 'shell:ps'].every(f => ctx.facts.has(f)),
  },
  {
    id: 'free-play',
    family: 'curiosity',
    name: 'Free play',
    description: 'You tried five different commands in the Sandbox, outside any lab.',
    howTo: 'Try five different commands in the Sandbox.',
    check: ctx => countPrefix(ctx, 'sandbox:') >= 5,
  },
  {
    id: 'sandwich',
    family: 'curiosity',
    name: 'sudo make me a sandwich',
    nameIsCommand: true,
    hidden: true,
    description: 'You tried a real command just to see what happens here. Some are not simulated, and now you know.',
    howTo: 'A surprise.',
    check: ctx => ctx.facts.has('notsim'),
  },

  // ---------- Recovering from errors ----------
  {
    id: 'try-again',
    family: 'resilience',
    name: 'Try, try again',
    description: 'You had a command fail and you fixed it. That is most of the job.',
    howTo: 'When a command fails, change it until the same command works.',
    check: ctx => ctx.facts.has('recover:retry'),
  },
  {
    id: 'permission-granted',
    family: 'resilience',
    name: 'Permission granted',
    description: 'You hit "Permission denied" and found a way past it.',
    howTo: 'Get past a "Permission denied" with sudo, chmod or the right user.',
    check: ctx => ctx.facts.has('recover:permission'),
  },
  {
    id: 'typo-fixed',
    family: 'resilience',
    name: 'Typo, fixed',
    description: 'You saw "command not found" and then ran the command you meant.',
    howTo: 'After a "command not found", run the command you meant.',
    check: ctx => ctx.facts.has('recover:typo'),
  },
  {
    id: 'fresh-start',
    family: 'resilience',
    name: 'Fresh start',
    description: 'You reset a lab and later finished it.',
    howTo: 'Reset a lab you have not finished, then finish it.',
    check: ctx =>
      [...ctx.facts].some(f => f.startsWith('reset:') && ctx.src.labComplete(f.slice('reset:'.length))),
  },
  {
    id: 'second-wind',
    family: 'resilience',
    name: 'Second wind',
    description: 'You passed a checkpoint you had not passed the first time.',
    howTo: 'Pass a checkpoint you did not pass the first time.',
    check: ctx =>
      [...ctx.facts].some(f => {
        if (!f.startsWith('quizmiss:')) return false;
        const key = f.slice('quizmiss:'.length);
        const [pathId, stepId] = key.split('/');
        const step = ctx.paths.find(p => p.id === pathId)?.stages.flatMap(s => s.steps).find(s => s.id === stepId);
        return step?.kind === 'quiz' && quizPassed(ctx.journey.quiz[stepKey(pathId, stepId)], step.passMark);
      }),
  },
  {
    id: 'hints-are-tools',
    family: 'resilience',
    name: 'Hints are tools',
    description: 'You opened a hint and then finished that task yourself.',
    howTo: 'Open a hint for a task, then finish the task.',
    check: ctx =>
      [...ctx.facts].some(f => {
        if (!f.startsWith('hint:')) return false;
        const [moduleId, objectiveId] = f.slice('hint:'.length).split('/');
        return !!ctx.progress[moduleId]?.includes(objectiveId);
      }),
  },
  {
    id: 'welcome-back',
    family: 'resilience',
    name: 'Welcome back',
    description: 'You came back on a different day. Rest days are fine.',
    howTo: 'Come back on another day.',
    check: ctx => ctx.activity.days.length >= 2,
  },

  // ---------- Milestones ----------
  {
    id: 'hello-world',
    family: 'milestone',
    name: 'hello, world',
    nameIsCommand: true,
    description: 'You ran your first command.',
    howTo: 'Run any command in a terminal.',
    check: has('shell:'),
  },
  {
    id: 'plumber',
    family: 'milestone',
    name: 'Plumber',
    description: 'You joined two commands with a pipe and got output.',
    howTo: 'Send one command’s output into another with |.',
    check: ctx => ctx.facts.has('pipe'),
  },
  {
    id: 'redirect',
    family: 'milestone',
    name: '> saved',
    nameIsCommand: true,
    description: 'You sent a command’s output into a file.',
    howTo: 'Save a command’s output to a file with >.',
    check: ctx => ctx.facts.has('redirect'),
  },
  {
    id: 'first-lab',
    family: 'milestone',
    name: 'First lab',
    description: 'You finished every task in a lab.',
    howTo: 'Finish every task in one lab.',
    check: ctx => labsDone(ctx).length >= 1,
  },
  {
    id: 'checkpoint',
    family: 'milestone',
    name: 'Checkpoint',
    description: 'You passed your first checkpoint quiz.',
    howTo: 'Pass a checkpoint quiz in any path.',
    check: ctx =>
      ctx.paths.some(p => allSteps(p).some(s => s.kind === 'quiz' && quizPassed(ctx.journey.quiz[stepKey(p.id, s.id)], s.passMark))),
  },
  {
    id: 'stage-clear',
    family: 'milestone',
    name: 'Stage clear',
    description: 'You finished a whole stage of a path.',
    howTo: 'Finish every step of one stage in a path.',
    check: ctx => ctx.paths.some(p => p.stages.some(st => stageComplete(p.id, st, ctx.src))),
  },
  {
    id: 'lab-regular',
    family: 'milestone',
    name: 'Lab regular',
    description: 'You finished six different labs.',
    howTo: 'Finish six different labs.',
    check: ctx => labsDone(ctx).length >= 6,
  },
];

/** What finishing each path means you can do, as one sentence. Paths without an entry get a plain fallback. */
const PATH_ABILITIES: Record<string, string> = {
  'first-steps': 'You can open a terminal, run a command, read its output and ask it for help.',
  'lpic1-101': 'You can find hardware, filter logs, read disks and set permissions.',
  'lpic1-102': 'You can manage accounts, schedule jobs, read the network setup and secure a host.',
  'aplus-core2': 'You can work a Windows PC from the command prompt, prepare disks, repair system files and check services.',
  'netsec-windows': 'You can trace a network fault, manage Active Directory accounts, apply Group Policy and follow an incident to its process.',
};

export const pathBadgeId = (pathId: string) => `path:${pathId}`;

/** One badge per path, from the paths themselves, so a new path gets one automatically. */
export function pathBadges(paths: LearningPath[]): Badge[] {
  return paths.map(path => ({
    id: pathBadgeId(path.id),
    family: 'milestone' as const,
    name: `${path.title}: done`,
    description: PATH_ABILITIES[path.id] ?? `You finished every stage of ${path.title}.`,
    howTo: `Finish every stage of ${path.title}.`,
    check: (ctx: BadgeContext) => path.stages.length > 0 && currentStageIndex(path, ctx.src) === -1,
  }));
}

export function allBadges(paths: LearningPath[]): Badge[] {
  return [...STATIC_BADGES, ...pathBadges(paths)];
}

export interface BadgeInputs {
  activity: Activity;
  progress: Record<string, string[]>;
  journey: Journey;
  paths: LearningPath[];
  modules: ExamModule[];
}

export function badgeContext(inp: BadgeInputs): BadgeContext {
  return {
    ...inp,
    facts: new Set(inp.activity.facts),
    src: { journey: inp.journey, labComplete: labCheck(inp.progress, inp.modules) },
  };
}

/** Ids of the badges whose check passes now but are not saved as earned yet, in list order. */
export function newlyEarned(badges: Badge[], inp: BadgeInputs): string[] {
  const ctx = badgeContext(inp);
  return badges
    .filter(b => !(b.id in inp.activity.badges))
    .filter(b => {
      try {
        return b.check(ctx);
      } catch {
        return false;
      }
    })
    .map(b => b.id);
}
