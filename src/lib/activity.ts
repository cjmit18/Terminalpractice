import type { TerminalShell } from '../types/terminal';
import { ShellSyntax, parsePipelinedLine, splitChainedCommandLine } from '../terminal/parser';
import type { SyncedCodec } from './syncedStorage';

/**
 * The activity log: short facts about learning moments (a manual page opened, an error fixed),
 * the days anything was practised, and the badges earned. Learners never see the log itself;
 * it feeds the badges and celebrations (src/data/badges.ts).
 *
 * Privacy: a fact is a short id such as `help:linux:chmod` or `recover:retry`. Command arguments,
 * file contents and anything else typed are never stored. Command names are only recorded when the
 * command ran successfully, so a mistyped or private word never ends up here.
 *
 * Merging (useSyncedStorage): facts and days are a set union, the earliest time of each badge wins
 * and the newest prefs win. "Clear badges and activity" writes a tombstone (`clearedAt`), the same
 * idea as ProgressRecord.resetAt: a copy older than the newest clear has not seen it, and its facts,
 * days and badges are dropped in the merge. Lab and path resets never touch this record.
 */

export const ACTIVITY_KEY = 'certsim:activity:v1';

export type CelebrationMode = 'quiet' | 'off' | 'lively';

export interface ActivityPrefs {
  celebrations?: CelebrationMode;
  showBadges?: boolean;
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
}

export const EMPTY_ACTIVITY: Activity = { facts: [], days: [], badges: {} };

/** Defaults when no preference is saved */
export const DEFAULT_PREFS: Required<ActivityPrefs> = { celebrations: 'quiet', showBadges: true };

export const prefsOf = (a: Activity): Required<ActivityPrefs> => ({ ...DEFAULT_PREFS, ...a.prefs });

const DAYS_KEPT = 112; // about 16 weeks
const MAX_FACTS = 4000;
const FACT = /^[a-z0-9][A-Za-z0-9:/._-]{0,159}$/;
const BADGE_ID = /^[a-z0-9][a-z0-9:._-]{0,79}$/;
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const MODES: CelebrationMode[] = ['quiet', 'off', 'lively'];

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

function sanitizePrefs(raw: unknown): ActivityPrefs | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const r = raw as Record<string, unknown>;
  const prefs: ActivityPrefs = {};
  if (MODES.includes(r.celebrations as CelebrationMode)) prefs.celebrations = r.celebrations as CelebrationMode;
  if (typeof r.showBadges === 'boolean') prefs.showBadges = r.showBadges;
  return Object.keys(prefs).length ? prefs : undefined;
}

/** Canonical, well-formed copy of untrusted data. Anything malformed is dropped. */
export function sanitizeActivity(raw: unknown): Activity {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return EMPTY_ACTIVITY;
  const r = raw as Record<string, unknown>;
  const facts = Array.isArray(r.facts)
    ? [...new Set(r.facts.filter((f): f is string => typeof f === 'string' && FACT.test(f)))].sort().slice(0, MAX_FACTS)
    : [];
  const days = Array.isArray(r.days)
    ? pruneDays(r.days.filter((d): d is string => typeof d === 'string' && DAY.test(d) && !Number.isNaN(Date.parse(d))))
    : [];
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
  const empty = a.facts.length === 0 && a.days.length === 0 && Object.keys(a.badges).length === 0 && !a.prefs && !a.clearedAt;
  return empty ? null : JSON.stringify(a);
}

/** See the merge rule at the top of this file. Idempotent, and the order of the two copies does not matter. */
export function mergeActivity(a: Activity, b: Activity): Activity {
  const cleared = Math.max(a.clearedAt ?? 0, b.clearedAt ?? 0);
  const live = [a, b].filter(x => (x.clearedAt ?? 0) >= cleared);
  const badges: Record<string, number> = {};
  for (const x of live) for (const [id, t] of Object.entries(x.badges)) badges[id] = Math.min(badges[id] ?? Infinity, t);

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
  });
}

/** How useSyncedStorage reads, merges and writes the activity record. */
export function activityCodec(): SyncedCodec<Activity> {
  return { parse: parseActivity, merge: mergeActivity, serialize: serializeActivity };
}

// ---------- Updates (return the same object when nothing changes) ----------

/** Adds facts, and today to the days practised. */
export function addFacts(a: Activity, facts: string[], day: string = dayKey()): Activity {
  const fresh = facts.filter(f => FACT.test(f) && !a.facts.includes(f));
  const newDay = DAY.test(day) && !a.days.includes(day);
  if (fresh.length === 0 && !newDay) return a;
  const next = sanitizeActivity({ ...a, facts: [...a.facts, ...fresh], days: newDay ? [...a.days, day] : a.days });
  return next;
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

/** Every simple command of the line, stage by stage, with `sudo` stripped from the name. */
function parseLine(line: string, shell: TerminalShell): { stages: Parsed[][] } {
  const syntax: ShellSyntax = shell;
  const stages = splitChainedCommandLine(line, syntax).map(stage =>
    parsePipelinedLine(stage.commandLine, syntax).map(cmd => {
      let { name, args } = cmd;
      if (shell === 'bash' && name === 'sudo') {
        const i = args.findIndex(x => !x.startsWith('-'));
        name = i >= 0 ? args[i] : '';
        args = i >= 0 ? args.slice(i + 1) : [];
      }
      return { name, args, redirect: !!cmd.redirect };
    }),
  );
  return { stages };
}

const norm = (name: string, shell: TerminalShell) => (shell === 'bash' ? name : name.toLowerCase().replace(/\.exe$/, ''));

/** First command name of a line (sudo stripped), normalized for the shell; '' when there is none. */
export function firstCommandName(line: string, shell: TerminalShell): string {
  const first = parseLine(line, shell).stages[0]?.[0];
  return first ? norm(first.name, shell) : '';
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
    stages = parseLine(line, shell).stages;
  } catch {
    return [...facts];
  }
  const all = stages.flat();
  const helpTopic = (topic: string | undefined) => {
    if (topic && NAME.test(topic)) facts.add(`help:${os}:${norm(topic, shell)}`);
  };

  if (NOT_SIMULATED.test(outcome.stderr)) facts.add('notsim');

  if (ok) {
    for (const c of all) if (NAME.test(c.name)) facts.add(`cmd:${SHELL_KEY[shell]}:${norm(c.name, shell)}`);
    if (stages.some(s => s.length >= 2)) facts.add('pipe');
    if (all.some(c => c.redirect)) facts.add('redirect');

    for (const c of all) {
      const name = norm(c.name, shell);
      const words = c.args.filter(a => !a.startsWith('-') || shell !== 'bash');
      if (shell === 'bash') {
        if (IDENTITY.test(name) || (name === 'echo' && c.args.some(a => /\$\{?(USER|LOGNAME)\b/.test(a)))) facts.add('whoami');
        if (name === 'apropos' || (name === 'man' && c.args.some(a => a === '-k' || a === '--apropos'))) facts.add('search');
        else if (HELP_LINUX.has(name)) helpTopic(words.find(w => !/^\d/.test(w)) ?? (name === 'help' ? 'help' : undefined));
        if (c.args.includes('--help')) {
          facts.add('flaghelp');
          helpTopic(c.name);
        }
        if (name === 'history') facts.add('history');
      } else if (shell === 'cmd') {
        if (name === 'whoami' || (name === 'echo' && /%USERNAME%/i.test(c.args.join(' ')))) facts.add('whoami');
        if (name === 'help') helpTopic(words[0] ?? 'help');
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
          else helpTopic(topic ?? 'get-help');
        }
        if (c.args.includes('-?')) {
          facts.add('flaghelp');
          helpTopic(c.name);
        }
        if (name === 'get-history' || name === 'history' || name === 'h') facts.add('history');
      }
    }
  }

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
