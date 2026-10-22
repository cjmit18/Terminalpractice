import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import type { ExamModule } from '../../types/modules';
import type { LearningPath } from '../../types/paths';
import {
  Activity,
  ActivityPrefs,
  DEFAULT_PREFS,
  EMPTY_ACTIVITY,
  addFacts,
  addPractice,
  clearActivity,
  countSandboxCommand,
  dayKey,
  earnBadges,
  labFact,
  lessonFact,
  localeWeekStart,
  markGoalWeek,
  passFact,
  prefsOf,
  setPrefs as withPrefs,
  taskFact,
  weekGoal,
} from '../../lib/activity';
import { EMPTY_JOURNEY, Journey, allSteps, labCheck, quizPassed, stageComplete, stepKey, stepTitle } from '../../lib/journey';
import { Announcement, Batch, batchMessage } from '../../lib/celebrate';
import { Badge, allBadges, newlyEarned } from '../../data/badges';
import { Celebration } from './Celebration';
import { Confetti } from './Confetti';

/**
 * The game layer: the activity log, badges, and quiet celebrations, for the whole app.
 * Components reach it with useGameLayer(); without a provider every call is a harmless no-op.
 */
export interface GameLayer {
  activity: Activity;
  prefs: Required<ActivityPrefs>;
  badges: Badge[];
  /** Record learning facts (and today as a day practised) */
  record: (facts: string[]) => void;
  setPrefs: (prefs: ActivityPrefs) => void;
  /** Forget badges and activity, in every tab */
  clear: () => void;
  /** Queue a celebration; things announced close together are said as one message */
  announce: (a: Announcement) => void;
  /** One command run in the Sandbox (three in a day count toward the weekly goal) */
  sandboxCommand: () => void;
  /** Lab progress and the journey, for summaries (read only) */
  progress: Record<string, string[]>;
  journey: Journey;
  paths: LearningPath[];
  modules: ExamModule[];
  /** Cosmetic Sandbox options earned so far. Once earned they stay, whatever is reset */
  unlocks: Unlocks;
  /** First day of the week for this learner's locale, 0 Sunday ... 6 Saturday */
  weekStart: number;
}

export interface Unlocks {
  /** After the first lab: choose the machine name */
  hostname: boolean;
  /** After a stage: choose the prompt format */
  prompt: boolean;
  /** After a path: choose a login banner line */
  banner: boolean;
}

const NO_UNLOCKS: Unlocks = { hostname: false, prompt: false, banner: false };

const noop = () => {};
const GameLayerContext = createContext<GameLayer>({
  activity: EMPTY_ACTIVITY,
  prefs: DEFAULT_PREFS,
  badges: [],
  record: noop,
  setPrefs: noop,
  clear: noop,
  announce: noop,
  sandboxCommand: noop,
  progress: {},
  journey: EMPTY_JOURNEY,
  paths: [],
  modules: [],
  unlocks: NO_UNLOCKS,
  weekStart: 1,
});

export const useGameLayer = () => useContext(GameLayerContext);

/** How long to wait for more news before saying it, so a batch is one message */
const BATCH_MS = 300;

/** Whether the learner's preferences let this be said */
const allowed = (a: Announcement, p: Required<ActivityPrefs>) => p.celebrations !== 'off' && (a.kind !== 'badge' || p.showBadges);

const prefersReducedMotion = () => {
  try {
    return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  } catch {
    return false;
  }
};

interface Snapshot {
  labs: Set<string>;
  quizzes: Set<string>;
  stages: Set<string>;
  paths: Set<string>;
  /** "moduleId/objectiveId" of every task done */
  tasks: Set<string>;
  /** "pathId/stepId" of every lesson read */
  lessons: Set<string>;
}

function snapshot(paths: LearningPath[], modules: ExamModule[], progress: Record<string, string[]>, journey: Journey): Snapshot {
  const src = { journey, labComplete: labCheck(progress, modules) };
  const s: Snapshot = {
    labs: new Set(),
    quizzes: new Set(),
    stages: new Set(),
    paths: new Set(),
    // Known labs, tasks and lessons only: the saved records also keep what a newer build saved, and
    // the activity facts made from these must be this build's own ids (see activity.ts, Privacy)
    tasks: new Set(modules.flatMap(m => m.objectives.filter(o => (progress[m.id] ?? []).includes(o.id)).map(o => `${m.id}/${o.id}`))),
    lessons: new Set(paths.flatMap(p => allSteps(p).filter(st => st.kind === 'lesson').map(st => stepKey(p.id, st.id))).filter(k => journey.read.includes(k))),
  };
  for (const m of modules) if (src.labComplete(m.id)) s.labs.add(m.id);
  for (const p of paths) {
    for (const step of allSteps(p)) {
      if (step.kind === 'quiz' && quizPassed(journey.quiz[stepKey(p.id, step.id)], step.passMark)) s.quizzes.add(stepKey(p.id, step.id));
    }
    const done = p.stages.filter(st => stageComplete(p.id, st, src));
    for (const st of done) s.stages.add(`${p.id}/${st.id}`);
    if (p.stages.length > 0 && done.length === p.stages.length) s.paths.add(p.id);
  }
  return s;
}

interface ProviderProps {
  /** The activity record and its setter (App keeps it with useSyncedStorage under ACTIVITY_KEY) */
  activity: Activity;
  setActivity: React.Dispatch<React.SetStateAction<Activity>>;
  paths: LearningPath[];
  modules: ExamModule[];
  progress: Record<string, string[]>;
  journey: Journey;
  /** useSyncedStorage's "latest change came from another tab" flags for the records above */
  fromOtherTab?: React.MutableRefObject<boolean>[];
  /**
   * Changes when the records were replaced or filled from elsewhere (an account switch, a sync
   * download). What changed with it is caught up quietly: no celebration, no practice day today.
   */
  quietKey?: string | number;
  children: React.ReactNode;
}

export const GameLayerProvider: React.FC<ProviderProps> = ({ activity, setActivity, paths, modules, progress, journey, fromOtherTab, quietKey, children }) => {
  const prefs = prefsOf(activity);
  const badges = useMemo(() => allBadges(paths), [paths]);
  const modulesById = useMemo(() => new Map(modules.map(m => [m.id, m])), [modules]);
  const weekStart = useMemo(() => localeWeekStart(), []);
  const current = useMemo(() => snapshot(paths, modules, progress, journey), [paths, modules, progress, journey]);
  // Earned by progress now, or by a badge kept from before a reset: a cosmetic once earned stays
  const earned = activity.badges;
  const unlocksHost = current.labs.size > 0 || 'first-lab' in earned;
  const unlocksPrompt = current.stages.size > 0 || 'stage-clear' in earned;
  const unlocksBanner = current.paths.size > 0 || Object.keys(earned).some(id => id.startsWith('path:'));
  const unlocks = useMemo<Unlocks>(
    () => ({ hostname: unlocksHost, prompt: unlocksPrompt, banner: unlocksBanner }),
    [unlocksHost, unlocksPrompt, unlocksBanner],
  );

  // ---- Announcements, batched ----
  const queue = useRef<Announcement[]>([]);
  const timer = useRef<number | null>(null);
  const [note, setNote] = useState<(Batch & { id: number }) | null>(null);
  const [confettiKey, setConfettiKey] = useState(0);
  const prefsRef = useRef(prefs);
  prefsRef.current = prefs;
  // What the note on screen says, so it can be rebuilt when preferences change
  const shown = useRef<Announcement[]>([]);

  const flush = useCallback(() => {
    timer.current = null;
    // Preferences may have changed since these were queued
    const items = queue.current.filter(a => allowed(a, prefsRef.current));
    queue.current = [];
    const batch = batchMessage(items);
    if (!batch) return;
    shown.current = items;
    setNote({ ...batch, id: Date.now() });
    if (batch.confetti && prefsRef.current.celebrations === 'lively' && !prefersReducedMotion()) setConfettiKey(k => k + 1);
  }, []);

  const announce = useCallback(
    (a: Announcement) => {
      if (!allowed(a, prefsRef.current)) return;
      queue.current.push(a);
      if (timer.current === null) timer.current = window.setTimeout(flush, BATCH_MS);
    },
    [flush],
  );

  useEffect(() => () => {
    if (timer.current !== null) window.clearTimeout(timer.current);
  }, []);

  // Turning celebrations off or hiding badges also applies to what is queued and to the note showing
  useEffect(() => {
    queue.current = queue.current.filter(a => allowed(a, prefs));
    const kept = shown.current.filter(a => allowed(a, prefs));
    if (kept.length === shown.current.length) return;
    shown.current = kept;
    const batch = batchMessage(kept);
    setNote(n => (n && batch ? { ...batch, id: n.id } : null));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [prefs.celebrations, prefs.showBadges]);

  const dismiss = useCallback(() => {
    shown.current = [];
    setNote(null);
  }, []);

  // ---- Activity updates ----
  const record = useCallback((facts: string[]) => setActivity(a => addFacts(a, facts)), [setActivity]);
  const sandboxCommand = useCallback(() => setActivity(a => countSandboxCommand(a)), [setActivity]);
  const setPrefs = useCallback((p: ActivityPrefs) => setActivity(a => withPrefs(a, p)), [setActivity]);
  // After a clear, badges that progress still earns come back quietly
  const silent = useRef(true);
  const clear = useCallback(() => {
    silent.current = true;
    setActivity(a => clearActivity(a));
  }, [setActivity]);

  // ---- Badges: evaluated on any change; a new one is stored once ----
  const badgeQuietKey = useRef(quietKey);
  useEffect(() => {
    const ids = newlyEarned(badges, { activity, progress, journey, paths, modules });
    const quiet = silent.current || badgeQuietKey.current !== quietKey;
    silent.current = false;
    badgeQuietKey.current = quietKey;
    // Only this tab's own actions are announced here: what another tab did (earning a badge, or
    // "Clear badges and activity" there) is said in that tab, and caught up with quietly in this one
    const elsewhere = fromOtherTab?.some(r => r.current) ?? false;
    fromOtherTab?.forEach(r => (r.current = false));
    if (ids.length === 0) return;
    setActivity(a => earnBadges(a, ids));
    // The first evaluation in a tab only catches up with what was already true: no note
    if (quiet || elsewhere) return;
    for (const id of ids) {
      const b = badges.find(x => x.id === id);
      if (b) announce({ kind: 'badge', name: b.name, description: b.description });
    }
  }, [activity, progress, journey, badges, paths, modules, setActivity, announce, quietKey]);

  // ---- Milestones: a lab, checkpoint, stage or path that became complete while the app is open ----
  const prev = useRef<Snapshot | null>(null);
  const milestoneQuietKey = useRef(quietKey);
  useEffect(() => {
    const now = current;
    const before = prev.current;
    prev.current = now;
    const quiet = milestoneQuietKey.current !== quietKey;
    milestoneQuietKey.current = quietKey;
    if (!before || quiet) return;
    // New tasks, labs, lessons and checkpoints: facts for "Today: ...", and a day toward the weekly goal
    const practice: string[] = [];
    for (const t of now.tasks) if (!before.tasks.has(t)) practice.push(taskFact(t.slice(0, t.indexOf('/')), t.slice(t.indexOf('/') + 1)));
    for (const id of now.labs) if (!before.labs.has(id)) practice.push(labFact(id));
    for (const k of now.lessons) if (!before.lessons.has(k)) practice.push(lessonFact(k.slice(0, k.indexOf('/')), k.slice(k.indexOf('/') + 1)));
    for (const k of now.quizzes) if (!before.quizzes.has(k)) practice.push(passFact(k.slice(0, k.indexOf('/')), k.slice(k.indexOf('/') + 1)));
    if (practice.length) setActivity(a => addPractice(a, practice));
    for (const id of now.labs) {
      if (!before.labs.has(id)) announce({ kind: 'milestone', text: `Lab done: ${modulesById.get(id)?.title ?? 'lab'}` });
    }
    for (const p of paths) {
      for (const step of allSteps(p)) {
        const key = stepKey(p.id, step.id);
        if (now.quizzes.has(key) && !before.quizzes.has(key)) {
          announce({ kind: 'milestone', text: `Checkpoint passed: ${stepTitle(step, modulesById)}` });
        }
      }
      for (const st of p.stages) {
        const key = `${p.id}/${st.id}`;
        if (now.stages.has(key) && !before.stages.has(key)) {
          announce({ kind: 'milestone', text: `Stage clear: ${st.title}`, confetti: !now.paths.has(p.id) || before.paths.has(p.id) });
        }
      }
      if (now.paths.has(p.id) && !before.paths.has(p.id)) {
        announce({ kind: 'milestone', text: `Path done: ${p.title}`, confetti: true });
      }
    }
  }, [current, paths, modulesById, announce, setActivity, quietKey]);

  // ---- Weekly goal: a week that meets it is counted once, and stays counted ----
  const week = weekGoal(activity, dayKey(), weekStart);
  const metWeek = week?.met && !activity.goalWeeks?.includes(week.days[0]) ? week.days[0] : null;
  useEffect(() => {
    if (metWeek) setActivity(a => markGoalWeek(a, metWeek));
  }, [metWeek, setActivity]);

  const value = useMemo<GameLayer>(
    () => ({
      activity,
      prefs,
      badges,
      record,
      setPrefs,
      clear,
      announce,
      sandboxCommand,
      progress,
      journey,
      paths,
      modules,
      unlocks,
      weekStart,
    }),
    // prefs is derived from activity
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [activity, badges, record, setPrefs, clear, announce, sandboxCommand, progress, journey, paths, modules, unlocks, weekStart],
  );

  return (
    <GameLayerContext.Provider value={value}>
      {children}
      <Celebration note={note} onDismiss={dismiss} />
      {confettiKey > 0 && <Confetti key={confettiKey} />}
    </GameLayerContext.Provider>
  );
};
