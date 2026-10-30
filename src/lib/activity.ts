import type { TerminalShell } from '../types/terminal';
import { parsePipelinedLine, splitChainedCommandLine } from '../terminal/parser';
import { assignmentOf, parseBashPipeline, splitBashChain, wordText } from '../terminal/linux/shell';
import { psExtractRedirects, psSplitPipeline, psStage } from '../terminal/windows/psUtil';
import { NATIVE_TOOLS } from '../terminal/windows/help';
import { linuxCommands } from '../terminal/linux/context';
import { cmdCommands, psCommands } from '../terminal/windows/context';
import { cmdDoc, linuxDocsFor, psDoc } from '../terminal/docs';
// The engines register every command on load; their registries are the trusted names below
import '../terminal/linuxEngine';
import '../terminal/windowsEngine';
import type { SyncedCodec } from './syncedStorage';

/**
 * The activity log: short facts about learning moments (a manual page opened, an error fixed),
 * the days anything was practised, and the badges earned. Learners never see the log itself;
 * it feeds the badges and celebrations (src/data/badges.ts).
 *
 * Privacy: a fact is a short id such as `help:linux:chmod` or `recover:retry`. Command arguments,
 * file contents and anything else typed are never stored. Command and help-topic names are only
 * recorded when they are the simulator's own identifiers (a registered command or a doc page) and
 * that command itself ran successfully, so a mistyped or private word never ends up here.
 *
 * Merging (useSyncedStorage): facts and days are a set union, the earliest time of each badge wins
 * and the newest prefs win. "Clear badges and activity" writes a tombstone (`clearedAt`), the same
 * idea as ProgressRecord.resetAt: a copy older than the newest clear has not seen it, and its facts,
 * days and badges are dropped in the merge. Lab and path resets never touch this record.
 *
 * The weekly goal and "Today: ..." use the same rules: the day each fact was first seen keeps the
 * earliest day, practice days and goal weeks are a set union, and a day's Sandbox command count
 * keeps the larger number. All of these are idempotent and order-free, like the rest.
 */

export const ACTIVITY_KEY = 'certsim:activity:v1';

export type CelebrationMode = 'quiet' | 'off' | 'lively';

/** Sandbox bash prompt formats (cosmetic, unlocked by finishing a stage) */
export type PromptStyle = 'standard' | 'bracket' | 'short' | 'host-first';
export const PROMPT_STYLES: PromptStyle[] = ['standard', 'bracket', 'short', 'host-first'];

/** Sandbox login banner lines (cosmetic, unlocked by finishing a path) */
export type BannerLine = 'none' | 'calm' | 'tip' | 'loopback';
export const BANNER_LINES: BannerLine[] = ['none', 'calm', 'tip', 'loopback'];

/** Text size in the terminals (labs, Sandbox, simulators) */
export type TerminalText = 'small' | 'medium' | 'large';
export const TERMINAL_TEXT_SIZES: TerminalText[] = ['small', 'medium', 'large'];

export interface ActivityPrefs {
  celebrations?: CelebrationMode;
  showBadges?: boolean;
  /** Days a week the learner would like to practise, 1-7; 0 (or missing) is off, the default */
  weeklyGoal?: number;
  /** Sandbox machine name, chosen after the first lab; '' is the default name */
  sandboxHost?: string;
  promptStyle?: PromptStyle;
  bannerLine?: BannerLine;
  /** Story framing on labs (help-desk tickets); anything but false is on */
  storyNotes?: boolean;
  /** Terminal text size; medium is the default */
  terminalText?: TerminalText;
}

export interface Activity {
  /** Grow-only, sorted: 'help:linux:chmod', 'cmd:ps:get-service', 'recover:permission', 'shell:cmd', 'hint:mod/obj' */
  facts: string[];
  /** Local YYYY-MM-DD of each day with a learning action, sorted, the last DAYS_KEPT days only */
  days: string[];
  /** badgeId -> first earned (ms since epoch) */
  badges: Record<string, number>;
  prefs?: ActivityPrefs;
  /** When prefs last changed (ms) */
  prefsAt?: number;
  /** Time of the last "Clear badges and activity" (ms) */
  clearedAt?: number;
  /** fact -> local day it was first recorded (for "Today: ..."); the earliest day wins in a merge */
  firstSeen?: Record<string, string>;
  /**
   * Days that count toward the weekly goal: a task, a lesson, a quiz attempt, or three Sandbox
   * commands on that day. Sorted, the last DAYS_KEPT days only.
   */
  practice?: string[];
  /** day -> Sandbox commands run that day, capped at SANDBOX_DAY_COMMANDS; the larger count wins */
  sandbox?: Record<string, number>;
  /** Start day (YYYY-MM-DD) of each week the goal was met. Grow-only: never pruned by age */
  goalWeeks?: string[];
}

export const EMPTY_ACTIVITY: Activity = { facts: [], days: [], badges: {} };

/** Defaults when no preference is saved */
export const DEFAULT_PREFS: Required<ActivityPrefs> = {
  celebrations: 'quiet',
  showBadges: true,
  weeklyGoal: 0,
  sandboxHost: '',
  promptStyle: 'standard',
  bannerLine: 'none',
  storyNotes: true,
  terminalText: 'medium',
};

export const prefsOf = (a: Activity): Required<ActivityPrefs> => ({ ...DEFAULT_PREFS, ...a.prefs });

const DAYS_KEPT = 112; // about 16 weeks
const MAX_FACTS = 4000;
const FACT = /^[a-z0-9][A-Za-z0-9:/._-]{0,159}$/;
const BADGE_ID = /^[a-z0-9][a-z0-9:._-]{0,79}$/;
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const MODES: CelebrationMode[] = ['quiet', 'off', 'lively'];
/** Sandbox commands in a day that make it a practice day */
export const SANDBOX_DAY_COMMANDS = 3;
const SANDBOX_DAYS_KEPT = 14;
const MAX_GOAL_WEEKS = 2000;
/** A machine name: lower-case letters, digits and inner hyphens, up to 24 characters */
export const HOSTNAME = /^[a-z0-9](?:[a-z0-9-]{0,22}[a-z0-9])?$/;

const isTime = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v > 0;

/** Local calendar day, YYYY-MM-DD */
export function dayKey(d: Date = new Date()): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** Keep the days within DAYS_KEPT of the newest one (by the record itself, so merging stays idempotent). */
function pruneDays(days: string[]): string[] {
  const sorted = [...new Set(days)].sort();
  if (sorted.length === 0) return sorted;
  const newest = Date.parse(`${sorted[sorted.length - 1]}T00:00:00Z`);
  const cutoff = newest - DAYS_KEPT * 86_400_000;
  return sorted.filter(d => Date.parse(`${d}T00:00:00Z`) > cutoff);
}

/** Keys within `keep` days of the newest one (by the record itself, so merging stays idempotent). */
function recentKeys(keys: string[], keep: number): string[] {
  const sorted = [...new Set(keys)].sort();
  if (sorted.length === 0) return sorted;
  const cutoff = Date.parse(`${sorted[sorted.length - 1]}T00:00:00Z`) - keep * 86_400_000;
  return sorted.filter(d => Date.parse(`${d}T00:00:00Z`) > cutoff);
}

const isDay = (d: unknown): d is string => typeof d === 'string' && DAY.test(d) && !Number.isNaN(Date.parse(d));

function sanitizePrefs(raw: unknown): ActivityPrefs | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const r = raw as Record<string, unknown>;
  const prefs: ActivityPrefs = {};
  if (MODES.includes(r.celebrations as CelebrationMode)) prefs.celebrations = r.celebrations as CelebrationMode;
  if (typeof r.showBadges === 'boolean') prefs.showBadges = r.showBadges;
  if (typeof r.weeklyGoal === 'number' && Number.isInteger(r.weeklyGoal) && r.weeklyGoal >= 0 && r.weeklyGoal <= 7)
    prefs.weeklyGoal = r.weeklyGoal;
  if (typeof r.sandboxHost === 'string' && (r.sandboxHost === '' || HOSTNAME.test(r.sandboxHost))) prefs.sandboxHost = r.sandboxHost;
  if (PROMPT_STYLES.includes(r.promptStyle as PromptStyle)) prefs.promptStyle = r.promptStyle as PromptStyle;
  if (BANNER_LINES.includes(r.bannerLine as BannerLine)) prefs.bannerLine = r.bannerLine as BannerLine;
  if (typeof r.storyNotes === 'boolean') prefs.storyNotes = r.storyNotes;
  if (TERMINAL_TEXT_SIZES.includes(r.terminalText as TerminalText)) prefs.terminalText = r.terminalText as TerminalText;
  return Object.keys(prefs).length ? prefs : undefined;
}

/** Canonical, well-formed copy of untrusted data. Anything malformed is dropped. */
export function sanitizeActivity(raw: unknown): Activity {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return EMPTY_ACTIVITY;
  const r = raw as Record<string, unknown>;
  const facts = Array.isArray(r.facts)
    ? [...new Set(r.facts.filter((f): f is string => typeof f === 'string' && FACT.test(f)))].sort().slice(0, MAX_FACTS)
    : [];
  const days = Array.isArray(r.days) ? pruneDays(r.days.filter(isDay)) : [];
  const badges: Record<string, number> = {};
  if (r.badges && typeof r.badges === 'object' && !Array.isArray(r.badges)) {
    for (const id of Object.keys(r.badges).sort()) {
      const t = (r.badges as Record<string, unknown>)[id];
      if (BADGE_ID.test(id) && isTime(t)) badges[id] = t;
    }
  }
  const out: Activity = { facts, days, badges };
  const prefs = sanitizePrefs(r.prefs);
  if (prefs) {
    out.prefs = prefs;
    if (isTime(r.prefsAt)) out.prefsAt = r.prefsAt;
  }
  if (isTime(r.clearedAt)) out.clearedAt = r.clearedAt;

  // The optional parts are left out when empty, so older records read and write unchanged
  if (r.firstSeen && typeof r.firstSeen === 'object' && !Array.isArray(r.firstSeen)) {
    const raw = r.firstSeen as Record<string, unknown>;
    const firstSeen: Record<string, string> = {};
    for (const f of facts) if (isDay(raw[f])) firstSeen[f] = raw[f] as string;
    if (Object.keys(firstSeen).length) out.firstSeen = firstSeen;
  }
  if (Array.isArray(r.practice)) {
    const practice = pruneDays(r.practice.filter(isDay));
    if (practice.length) out.practice = practice;
  }
  if (r.sandbox && typeof r.sandbox === 'object' && !Array.isArray(r.sandbox)) {
    const raw = r.sandbox as Record<string, unknown>;
    const valid = Object.keys(raw).filter(d => {
      const n = raw[d];
      return isDay(d) && typeof n === 'number' && Number.isInteger(n) && n > 0;
    });
    const sandbox: Record<string, number> = {};
    for (const d of recentKeys(valid, SANDBOX_DAYS_KEPT)) sandbox[d] = Math.min(raw[d] as number, SANDBOX_DAY_COMMANDS);
    if (Object.keys(sandbox).length) out.sandbox = sandbox;
  }
  if (Array.isArray(r.goalWeeks)) {
    const weeks = [...new Set(r.goalWeeks.filter(isDay))].sort().slice(-MAX_GOAL_WEEKS);
    if (weeks.length) out.goalWeeks = weeks;
  }
  return out;
}

export function parseActivity(text: string | null): Activity {
  if (!text) return EMPTY_ACTIVITY;
  try {
    return sanitizeActivity(JSON.parse(text));
  } catch {
    return EMPTY_ACTIVITY;
  }
}

export function serializeActivity(a: Activity): string | null {
  const empty =
    a.facts.length === 0 &&
    a.days.length === 0 &&
    Object.keys(a.badges).length === 0 &&
    !a.prefs &&
    !a.clearedAt &&
    !a.practice?.length &&
    !a.goalWeeks?.length &&
    Object.keys(a.sandbox ?? {}).length === 0;
  return empty ? null : JSON.stringify(a);
}

/** See the merge rule at the top of this file. Idempotent, and the order of the two copies does not matter. */
export function mergeActivity(a: Activity, b: Activity): Activity {
  const cleared = Math.max(a.clearedAt ?? 0, b.clearedAt ?? 0);
  const live = [a, b].filter(x => (x.clearedAt ?? 0) >= cleared);
  const badges: Record<string, number> = {};
  for (const x of live) for (const [id, t] of Object.entries(x.badges)) badges[id] = Math.min(badges[id] ?? Infinity, t);
  const firstSeen: Record<string, string> = {};
  for (const x of live)
    for (const [f, d] of Object.entries(x.firstSeen ?? {})) if (!firstSeen[f] || d < firstSeen[f]) firstSeen[f] = d;
  const sandbox: Record<string, number> = {};
  for (const x of live) for (const [d, n] of Object.entries(x.sandbox ?? {})) sandbox[d] = Math.max(sandbox[d] ?? 0, n);

  // Newest prefs win; on a tie, the larger text, so both orders agree
  let prefsFrom: Activity | null = null;
  for (const x of [a, b]) {
    if (!x.prefs) continue;
    if (
      !prefsFrom ||
      (x.prefsAt ?? 0) > (prefsFrom.prefsAt ?? 0) ||
      ((x.prefsAt ?? 0) === (prefsFrom.prefsAt ?? 0) && JSON.stringify(x.prefs) > JSON.stringify(prefsFrom.prefs))
    )
      prefsFrom = x;
  }
  return sanitizeActivity({
    facts: live.flatMap(x => x.facts),
    days: live.flatMap(x => x.days),
    badges,
    prefs: prefsFrom?.prefs,
    prefsAt: prefsFrom?.prefsAt,
    clearedAt: cleared || undefined,
    firstSeen,
    practice: live.flatMap(x => x.practice ?? []),
    sandbox,
    goalWeeks: live.flatMap(x => x.goalWeeks ?? []),
  });
}

/** How useSyncedStorage reads, merges and writes the activity record. */
export function activityCodec(): SyncedCodec<Activity> {
  return { parse: parseActivity, merge: mergeActivity, serialize: serializeActivity };
}

// ---------- Updates (return the same object when nothing changes) ----------

/** Adds facts (noting the day each was first seen), and today to the days practised. */
export function addFacts(a: Activity, facts: string[], day: string = dayKey()): Activity {
  const fresh = [...new Set(facts.filter(f => FACT.test(f) && !a.facts.includes(f)))];
  const newDay = DAY.test(day) && !a.days.includes(day);
  if (fresh.length === 0 && !newDay) return a;
  const firstSeen = { ...a.firstSeen };
  if (DAY.test(day)) for (const f of fresh) firstSeen[f] = day;
  return sanitizeActivity({ ...a, facts: [...a.facts, ...fresh], days: newDay ? [...a.days, day] : a.days, firstSeen });
}

/** Facts from a task, a lesson or a quiz attempt: the day also counts toward the weekly goal. */
export function addPractice(a: Activity, facts: string[], day: string = dayKey()): Activity {
  const next = addFacts(a, facts, day);
  if (!DAY.test(day) || next.practice?.includes(day)) return next;
  return sanitizeActivity({ ...next, practice: [...(next.practice ?? []), day] });
}

/** One command run in the Sandbox; the third one in a day makes it a practice day. */
export function countSandboxCommand(a: Activity, day: string = dayKey()): Activity {
  if (!DAY.test(day)) return a;
  const n = a.sandbox?.[day] ?? 0;
  if (n >= SANDBOX_DAY_COMMANDS) return a;
  const next = sanitizeActivity({ ...a, sandbox: { ...a.sandbox, [day]: n + 1 } });
  return n + 1 >= SANDBOX_DAY_COMMANDS ? addPractice(next, [], day) : next;
}

/** Notes that the week starting `weekStart` met the goal. The count of such weeks never goes down. */
export function markGoalWeek(a: Activity, weekStart: string): Activity {
  if (!DAY.test(weekStart) || a.goalWeeks?.includes(weekStart)) return a;
  return sanitizeActivity({ ...a, goalWeeks: [...(a.goalWeeks ?? []), weekStart] });
}

export function earnBadges(a: Activity, ids: string[], now: number = Date.now()): Activity {
  const fresh = ids.filter(id => BADGE_ID.test(id) && !(id in a.badges));
  if (fresh.length === 0) return a;
  const badges = { ...a.badges };
  for (const id of fresh) badges[id] = now;
  return sanitizeActivity({ ...a, badges });
}

export function setPrefs(a: Activity, prefs: ActivityPrefs, now: number = Date.now()): Activity {
  const merged = sanitizePrefs({ ...a.prefs, ...prefs });
  return { ...a, prefs: merged, prefsAt: Math.max(now, (a.prefsAt ?? 0) + 1) };
}

/** Forget facts, days and badges in every tab (writes a tombstone). Preferences stay. */
export function clearActivity(a: Activity, now: number = Date.now()): Activity {
  const out: Activity = { facts: [], days: [], badges: {}, clearedAt: Math.max(now, (a.clearedAt ?? 0) + 1) };
  if (a.prefs) {
    out.prefs = a.prefs;
    if (a.prefsAt) out.prefsAt = a.prefsAt;
  }
  return out;
}

// ---------- Classifying commands ----------

/** What a command produced, as far as the classifier needs to know. Held in memory only. */
export interface CommandOutcome {
  line: string;
  exitCode: number;
  stdout: string;
  stderr: string;
  explanation?: string;
  /** Exit code of each chained stage (null: skipped by && or ||), when the engine reports them */
  stageExits?: (number | null)[];
}

const SHELL_KEY: Record<TerminalShell, string> = { bash: 'bash', cmd: 'cmd', powershell: 'ps' };
const NAME = /^[A-Za-z][A-Za-z0-9._-]{0,39}$/;

const NOT_SIMULATED = /is not simulated here/;
const DENIED = /Permission denied|Operation not permitted|Access is denied|access denied|requires elevation|UnauthorizedAccess/i;

/** "command not found" (bash 127), "is not recognized" (CMD 9009, PowerShell), but not "not simulated here". */
export function isNotFound(o: CommandOutcome, shell: TerminalShell): boolean {
  if (o.exitCode === 0 || NOT_SIMULATED.test(o.stderr)) return false;
  if (shell === 'bash') return o.exitCode === 127 && /command not found/.test(o.stderr);
  return /is not recognized/.test(o.stderr);
}

/** Levenshtein distance, capped: returns max + 1 as soon as it is certainly larger. */
export function editDistance(a: string, b: string, max = 2): number {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    let rowMin = i;
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      rowMin = Math.min(rowMin, cur[j]);
    }
    if (rowMin > max) return max + 1;
    prev = cur;
  }
  return prev[b.length];
}

interface Parsed {
  name: string;
  args: string[];
  redirect: boolean;
}

const OUT_REDIR = new Set(['>', '>>', '&>', '&>>']);

/** One simple command of bash with sudo stripped from the name. */
function bashCommand(words: string[], redirect: boolean): Parsed {
  let [name = '', ...args] = words;
  if (name === 'sudo') {
    const i = args.findIndex(x => !x.startsWith('-'));
    name = i >= 0 ? args[i] : '';
    args = i >= 0 ? args.slice(i + 1) : [];
  }
  return { name, args, redirect };
}

/**
 * Every simple command of the line, chain stage by chain stage, split the way the engine splits it
 * (bash: linux/shell.ts, NAME=value words skipped; CMD: parser.ts; PowerShell: one pipeline, no chaining).
 */
function parseLine(line: string, shell: TerminalShell): Parsed[][] {
  if (shell === 'bash') {
    return splitBashChain(line).map(stage =>
      parseBashPipeline(stage.commandLine).map(cmd => {
        let i = 0;
        while (i < cmd.words.length && assignmentOf(cmd.words[i])) i++;
        const redirect = cmd.redirs.some(r => OUT_REDIR.has(r.op) && (r.op.startsWith('&') || r.fd === 1));
        return bashCommand(cmd.words.slice(i).map(wordText), redirect);
      }),
    );
  }
  if (shell === 'cmd') {
    return splitChainedCommandLine(line, 'cmd').map(stage =>
      parsePipelinedLine(stage.commandLine, 'cmd').map(cmd => ({ name: cmd.name, args: cmd.args, redirect: !!cmd.redirect })),
    );
  }
  const { body, redirect } = psExtractRedirects(line);
  const cmds = psSplitPipeline(body).map(psStage).map(st => ({
    // A quoted value on its own ('text') is output, not a command
    name: !st.tokens.length && /^(["']).*\1$/.test(st.raw) ? '' : st.name,
    args: st.args,
    redirect: false,
  }));
  if (cmds.length && redirect.stdout) cmds[cmds.length - 1].redirect = true;
  return [cmds];
}

const norm = (name: string, shell: TerminalShell) => (shell === 'bash' ? name : name.toLowerCase().replace(/\.exe$/, ''));

/** First command name of a line (sudo stripped), normalized for the shell; '' when there is none. */
export function firstCommandName(line: string, shell: TerminalShell): string {
  const first = parseLine(line, shell)[0]?.[0];
  return first ? norm(first.name, shell) : '';
}

/** A command the simulator itself provides (never just any word that was typed). */
function isKnownCommand(name: string, shell: TerminalShell): boolean {
  if (!NAME.test(name)) return false;
  if (shell === 'bash') return linuxCommands.has(name);
  if (shell === 'cmd') return cmdCommands.has(name);
  return psCommands.has(name) || NATIVE_TOOLS.includes(name);
}

/** A help topic the simulator has a page or a command for. */
function isKnownTopic(topic: string, shell: TerminalShell): boolean {
  if (!NAME.test(topic)) return false;
  if (shell === 'bash') return linuxDocsFor(topic).length > 0 || linuxCommands.has(topic);
  return !!cmdDoc(topic) || !!psDoc(topic) || cmdCommands.has(topic) || psCommands.has(topic);
}

const HELP_LINUX = new Set(['man', 'info', 'whatis', 'help']);
const HELP_PS = new Set(['get-help', 'help', 'man']);
const IDENTITY = /^(whoami|id)$/;

/**
 * The facts one command line is evidence of. Pure: depends only on its arguments.
 * `prev` is the outcome of the command before it in the same terminal, to notice recovery.
 *
 * Facts:
 * - `shell:<bash|cmd|ps>`: a command was run in that shell
 * - `cmd:<shell>:<name>`: that command ran successfully (name only, lower case outside bash)
 * - `help:<linux|windows>:<topic>`: a manual or help page opened (only topics that exist)
 * - `manual`: that page was opened with man, info, help or Get-Help, not with a command's own --help
 * - `flaghelp`: `--help`, `/?` or `-?`; `search`: apropos, `man -k`, `Get-Help *word*`
 * - `whoami`, `pipe`, `redirect`, `notsim`, `history`
 * - `recover:retry`, `recover:permission`, `recover:typo`
 */
export function classifyCommand(outcome: CommandOutcome, shell: TerminalShell, prev?: CommandOutcome): string[] {
  const line = outcome.line.trim();
  if (!line) return [];
  const facts = new Set<string>([`shell:${SHELL_KEY[shell]}`]);
  const ok = outcome.exitCode === 0;
  const os = shell === 'bash' ? 'linux' : 'windows';
  let stages: Parsed[][];
  try {
    stages = parseLine(line, shell);
  } catch {
    return [...facts];
  }
  // Whether each chain stage itself ran and succeeded. Without the engine's per-stage codes, only the
  // last stage can be judged (by the line's exit code); earlier ones count as not run.
  const exits = outcome.stageExits?.length === stages.length ? outcome.stageExits : undefined;
  const stageOk = (i: number) => (exits ? exits[i] === 0 : i === stages.length - 1 && ok);
  const helpTopic = (topic: string | undefined) => {
    if (!topic || !isKnownTopic(norm(topic, shell), shell)) return false;
    facts.add(`help:${os}:${norm(topic, shell)}`);
    return true;
  };
  // A manual or help page opened with man, info, help or Get-Help (not a command's own --help)
  const helpPage = (topic: string | undefined) => {
    if (helpTopic(topic)) facts.add('manual');
  };

  if (NOT_SIMULATED.test(outcome.stderr)) facts.add('notsim');

  stages.forEach((stage, i) => {
    if (!stageOk(i)) return;
    // Only the simulator's own command names are ever recorded; anything else typed is dropped
    const known = stage.filter(c => isKnownCommand(norm(c.name, shell), shell));
    for (const c of known) facts.add(`cmd:${SHELL_KEY[shell]}:${norm(c.name, shell)}`);
    if (stage.length >= 2 && known.length === stage.length) facts.add('pipe');
    if (known.some(c => c.redirect)) facts.add('redirect');

    for (const c of known) {
      const name = norm(c.name, shell);
      const words = c.args.filter(a => !a.startsWith('-') || shell !== 'bash');
      if (shell === 'bash') {
        if (IDENTITY.test(name) || (name === 'echo' && c.args.some(a => /\$\{?(USER|LOGNAME)\b/.test(a)))) facts.add('whoami');
        if (name === 'apropos' || (name === 'man' && c.args.some(a => a === '-k' || a === '--apropos'))) facts.add('search');
        else if (HELP_LINUX.has(name)) helpPage(words.find(w => !/^\d/.test(w)) ?? (name === 'help' ? 'help' : undefined));
        if (c.args.includes('--help')) {
          facts.add('flaghelp');
          helpTopic(c.name);
        }
        if (name === 'history') facts.add('history');
      } else if (shell === 'cmd') {
        if (name === 'whoami' || (name === 'echo' && /%USERNAME%/i.test(c.args.join(' ')))) facts.add('whoami');
        if (name === 'help') helpPage(words[0] ?? 'help');
        if (c.args.includes('/?')) {
          facts.add('flaghelp');
          helpTopic(c.name);
        }
        if (name === 'doskey' && c.args.some(a => a.toLowerCase() === '/history')) facts.add('history');
      } else {
        if (name === 'whoami' || /\$env:USERNAME/i.test(c.name + ' ' + c.args.join(' '))) facts.add('whoami');
        if (HELP_PS.has(name)) {
          const topic = c.args.find(a => !a.startsWith('-'));
          if (topic && topic.includes('*')) facts.add('search');
          else helpPage(topic ?? 'get-help');
        }
        if (c.args.includes('-?')) {
          facts.add('flaghelp');
          helpTopic(c.name);
        }
        if (name === 'get-history' || name === 'history' || name === 'h') facts.add('history');
      }
    }
  });

  // Recovery: the command before this one failed, and this one worked
  if (ok && prev && prev.exitCode !== 0 && prev.line.trim()) {
    const now = firstCommandName(line, shell);
    const before = firstCommandName(prev.line, shell);
    const fixers = new Set(['sudo', 'su', 'chmod', 'chown', 'chgrp', 'usermod', 'newgrp', 'runas']);
    const typedFirst = norm(line.split(/\s+/)[0], shell);
    if (isNotFound(prev, shell)) {
      if (now && before && now !== before && editDistance(now.toLowerCase(), before.toLowerCase()) <= 2) facts.add('recover:typo');
    } else if (!NOT_SIMULATED.test(prev.stderr)) {
      if (now && now === before) facts.add('recover:retry');
      if ((DENIED.test(prev.stderr) || DENIED.test(prev.stdout)) && (now === before || fixers.has(typedFirst) || fixers.has(now)))
        facts.add('recover:permission');
    }
  }
  return [...facts];
}

/** The same command facts, tagged as done in the Sandbox (outside any lab). */
export function sandboxFacts(facts: string[]): string[] {
  return [...facts, ...facts.filter(f => f.startsWith('cmd:')).map(f => `sandbox:${f.slice(4)}`)];
}

export const hintFact = (moduleId: string, objectiveId: string) => `hint:${moduleId}/${objectiveId}`;
export const resetFact = (moduleId: string) => `reset:${moduleId}`;
export const quizMissFact = (pathId: string, stepId: string) => `quizmiss:${pathId}/${stepId}`;
export const taskFact = (moduleId: string, objectiveId: string) => `task:${moduleId}/${objectiveId}`;
export const labFact = (moduleId: string) => `lab:${moduleId}`;
export const lessonFact = (pathId: string, stepId: string) => `read:${pathId}/${stepId}`;
export const passFact = (pathId: string, stepId: string) => `pass:${pathId}/${stepId}`;

// ---------- Weeks and the weekly goal ----------

/** YYYY-MM-DD plus n days (calendar arithmetic, no time zone involved) */
export function addDays(day: string, n: number): string {
  const t = Date.parse(`${day}T00:00:00Z`) + n * 86_400_000;
  return new Date(t).toISOString().slice(0, 10);
}

/** 0 Sunday ... 6 Saturday */
const weekday = (day: string) => new Date(`${day}T00:00:00Z`).getUTCDay();

/**
 * First day of the week for a locale, 0 Sunday ... 6 Saturday. Monday when the browser does not
 * say (Intl.Locale week info is not in every browser yet).
 */
export function localeWeekStart(locale?: string): number {
  try {
    const tag = locale ?? (typeof navigator !== 'undefined' ? navigator.language : undefined);
    if (!tag) return 1;
    const loc = new Intl.Locale(tag) as Intl.Locale & {
      getWeekInfo?: () => { firstDay: number };
      weekInfo?: { firstDay: number };
    };
    const first = loc.getWeekInfo?.().firstDay ?? loc.weekInfo?.firstDay;
    return typeof first === 'number' && first >= 1 && first <= 7 ? first % 7 : 1;
  } catch {
    return 1;
  }
}

/** The seven days of the week that holds `day`, starting on `firstDay` (0 Sunday ... 6 Saturday) */
export function weekDays(day: string, firstDay = 1): string[] {
  const start = addDays(day, -((weekday(day) - firstDay + 7) % 7));
  return Array.from({ length: 7 }, (_, i) => addDays(start, i));
}

export interface WeekGoal {
  /** 1-7 */
  goal: number;
  /** The seven days of this week, in order */
  days: string[];
  /** Which of them were practice days */
  practised: boolean[];
  count: number;
  met: boolean;
  /** Weeks the goal was met, this one included once it is. Never goes down */
  weeksMet: number;
}

/** This week against the goal, or null when the goal is off. */
export function weekGoal(a: Activity, today: string = dayKey(), firstDay = 1): WeekGoal | null {
  const goal = prefsOf(a).weeklyGoal;
  if (!goal) return null;
  const days = weekDays(today, firstDay);
  const practice = new Set(a.practice ?? []);
  const practised = days.map(d => practice.has(d));
  const count = practised.filter(Boolean).length;
  const met = count >= goal;
  const weeks = new Set(a.goalWeeks ?? []);
  if (met) weeks.add(days[0]);
  return { goal, days, practised, count, met, weeksMet: weeks.size };
}

// ---------- Today ----------

export interface DayRecap {
  tasks: number;
  labs: number;
  lessons: number;
  checkpoints: number;
  /** Command names first run successfully on that day, sorted */
  commands: string[];
}

/** What was new on one day, from the day each fact was first seen. */
export function dayRecap(a: Activity, day: string = dayKey()): DayRecap {
  const seen = a.firstSeen ?? {};
  const out: DayRecap = { tasks: 0, labs: 0, lessons: 0, checkpoints: 0, commands: [] };
  const cmdDays = new Map<string, string[]>();
  for (const f of a.facts) {
    const d = seen[f];
    if (f.startsWith('cmd:')) {
      const name = f.split(':').slice(2).join(':');
      cmdDays.set(name, [...(cmdDays.get(name) ?? []), d ?? '']);
      continue;
    }
    if (d !== day) continue;
    if (f.startsWith('task:')) out.tasks++;
    else if (f.startsWith('lab:')) out.labs++;
    else if (f.startsWith('read:')) out.lessons++;
    else if (f.startsWith('pass:')) out.checkpoints++;
  }
  // New that day in every shell it ran in (ping in bash last week and in CMD today is not new)
  for (const [name, ds] of cmdDays) if (ds.every(d => d === day)) out.commands.push(name);
  out.commands.sort();
  return out;
}

export const recapIsEmpty = (r: DayRecap) => r.tasks + r.labs + r.lessons + r.checkpoints + r.commands.length === 0;
