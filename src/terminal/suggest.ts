// "Did you mean ...?" for a mistyped command name. The suggestion only ever goes in a result's
// explanation note: stdout and stderr stay exactly what the real shell prints.

import { CMD_DOCS, LINUX_DOCS, PS_DOCS } from './docs';
import { linuxCommands } from './linux/context';
import { cmdCommands, psCommands } from './windows/context';
import { NATIVE_TOOLS } from './windows/help';

/**
 * Optimal string alignment distance: insertions, deletions, substitutions and swaps of two
 * neighbouring letters each cost 1, so "sl" is one edit from "ls".
 */
export function editDistance(a: string, b: string): number {
  const d: number[][] = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array<number>(b.length).fill(0)]);
  for (let j = 0; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
      }
    }
  }
  return d[a.length][b.length];
}

function compare(a: number[], aName: string, b: number[], bName: string): number {
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return a[i] - b[i];
  return aName < bName ? -1 : aName > bName ? 1 : 0;
}

const sortedLetters =(s: string) => [...s].sort().join('');

/**
 * The closest known name within edit distance 2 (1 for names of three letters or fewer, and
 * only a swap or a case change for one or two letters, where almost anything is one edit away).
 * Distance is measured ignoring case; returns undefined when nothing is close enough.
 */
export function closestName(typed: string, candidates: Iterable<string>, caseSensitive = true): string | undefined {
  if (!typed || /[\\/=$]/.test(typed) || typed.startsWith('.')) return undefined;
  const t = typed.toLowerCase();
  const max = t.length <= 3 ? 1 : 2;
  let best: { name: string; score: number[] } | undefined;
  for (const name of new Set(candidates)) {
    const n = name.toLowerCase();
    if (caseSensitive ? name === typed : n === t) continue;
    if (t.length <= 2 && sortedLetters(t) !== sortedLetters(n)) continue;
    if (Math.abs(n.length - t.length) > max) continue;
    const dist = editDistance(t, n);
    if (dist > max) continue;
    // Closest first, then same first letter, then nearest length, then alphabetical
    const score = [dist, n[0] === t[0] ? 0 : 1, Math.abs(n.length - t.length)];
    if (!best || compare(score, name, best.score, best.name) < 0) best = { name, score };
  }
  return best?.name;
}

const PLAIN_NAME = /^[A-Za-z][\w.-]*$/;

function linuxCandidates(): string[] {
  const docs = LINUX_DOCS.filter(d => d.section !== 5 && !d.pageOnly).flatMap(d => [d.name, ...(d.aliases ?? [])]);
  return [...linuxCommands.names(), ...docs].filter(n => PLAIN_NAME.test(n));
}

function cmdCandidates(): string[] {
  return [...cmdCommands.names(), ...CMD_DOCS.flatMap(d => [d.name, ...(d.aliases ?? [])])].filter(n => PLAIN_NAME.test(n));
}

/** PowerShell names in their documented spelling (Get-ChildItem, not get-childitem). */
function psCandidates(): string[] {
  const display = new Map<string, string>();
  for (const d of PS_DOCS) {
    display.set(d.name.toLowerCase(), d.name);
    for (const a of d.aliases) display.set(a.toLowerCase(), a);
  }
  const names = [...display.values(), ...NATIVE_TOOLS];
  // Registered names with no doc: keep plain aliases, skip lower-cased cmdlet names
  for (const n of psCommands.names()) if (!display.has(n) && !n.includes('-')) names.push(n);
  return names.filter(n => PLAIN_NAME.test(n));
}

const note = (typed: string, suggestion: string | undefined, caseSensitive: boolean) => {
  if (!suggestion) return undefined;
  const caseOnly = caseSensitive && typed.toLowerCase() === suggestion.toLowerCase();
  return `There is no command named ${typed}. Did you mean ${suggestion}?${caseOnly ? ' Command names in bash are case-sensitive.' : ''}`;
};

/** The explanation note for "bash: x: command not found", or undefined. */
export const suggestLinux = (name: string) => note(name, closestName(name, linuxCandidates()), true);

/** The explanation note for CMD's "'x' is not recognized ...", or undefined. */
export const suggestCmd = (name: string) => note(name, closestName(name.replace(/\.exe$/i, ''), cmdCandidates(), false), false);

/** The explanation note for PowerShell's "The term 'x' is not recognized ...", or undefined. */
export const suggestPowerShell = (name: string) => note(name, closestName(name, psCandidates(), false), false);
