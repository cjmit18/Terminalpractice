// Guards for regular expressions the learner types (grep, sed, awk, Select-String). JavaScript's regex
// engine backtracks, so some patterns take exponential time ((a*)*b, (.*)*x) or polynomial time with many
// .* on long lines, and the page cannot interrupt a running match: one command would freeze the tab for
// good. Real grep uses an automaton and answers at once. The simulator refuses those patterns with a clear
// note instead of hanging.

import { BudgetExceeded } from './limits';

/** A pattern the simulator refuses; the message names the tool ("grep: simulator limit: ..."). */
export class PatternTooComplex extends BudgetExceeded {}

/** Work a match may do before the simulator refuses it (roughly backtracking steps; a few per microsecond). */
const MAX_WORK = 3e8;

interface Shape {
  /** A repeated group itself contains repetition, e.g. (a*)* or (x+y?)+ */
  nested: boolean;
  /** Unbounded repetitions of "almost anything" (., [^...], \S, \W, \D): each adds a factor of the line length */
  wide: number;
}

/**
 * Reads a JavaScript regex source and reports the shapes that make backtracking blow up. A group repeated
 * without limit is only dangerous when its body has no required fixed piece: ([a-z]+\.)+ is fine (each round
 * must match a dot), (a*)* and (\w+\s?)+ are not (one input splits into rounds in exponentially many ways). Known gap: overlapping alternatives such as
 * (a|aa)* are not caught; learners rarely type them.
 */
export function regexShape(source: string): Shape {
  // Per open group: does it repeat anything inside; does the current alternative, and did every earlier
  // alternative, contain a required piece that is not "almost anything"
  type Group = { repeats: boolean; fixed: boolean; allAltsFixed: boolean };
  const groups: Group[] = [{ repeats: false, fixed: false, allAltsFixed: true }];
  const top = () => groups[groups.length - 1];
  let nested = false;
  let wide = 0;
  // What the next quantifier would apply to: a closed group, or a single atom
  let last: { kind: 'group'; repeats: boolean; fixed: boolean } | { kind: 'atom'; wide: boolean } | null = null;
  // The previous atom or group turned out to have no quantifier: it is required exactly once
  const settle = () => {
    if (last && (last.kind === 'atom' ? !last.wide : last.fixed)) top().fixed = true;
    last = null;
  };

  const quantifierAt = (i: number): { len: number; repeating: boolean; unbounded: boolean; exact: boolean } | null => {
    const c = source[i];
    if (c === '*' || c === '+') return { len: 1, repeating: true, unbounded: true, exact: false };
    if (c === '?') return { len: 1, repeating: false, unbounded: false, exact: false };
    if (c === '{') {
      const m = /^\{(\d+)(,(\d*))?\}/.exec(source.slice(i));
      if (!m) return null;
      const min = Number(m[1]);
      const max = m[2] === undefined ? min : m[3] === '' ? Infinity : Number(m[3]);
      return { len: m[0].length, repeating: max > 1, unbounded: max === Infinity, exact: min === max && min > 0 };
    }
    return null;
  };

  for (let i = 0; i < source.length; i++) {
    const c = source[i];
    const q = last ? quantifierAt(i) : null;
    if (q && last) {
      if (last.kind === 'group' && last.repeats && !last.fixed && q.unbounded) nested = true;
      if (last.kind === 'atom' && last.wide && q.unbounded) wide++;
      if (q.repeating) top().repeats = true;
      if (q.exact) settle();
      last = null;
      i += q.len - 1;
      if (source[i + 1] === '?') i++; // lazy quantifier
      continue;
    }
    settle();
    if (c === '\\') {
      const next = source[i + 1] ?? '';
      last = { kind: 'atom', wide: next === 'S' || next === 'W' || next === 'D' };
      i++;
    } else if (c === '[') {
      const negated = source[i + 1] === '^';
      let j = i + (negated ? 2 : 1);
      if (source[j] === ']') j++;
      for (; j < source.length && source[j] !== ']'; j++) if (source[j] === '\\') j++;
      last = { kind: 'atom', wide: negated || source.slice(i, j + 1) === '[\\s\\S]' };
      i = j;
    } else if (c === '(') {
      groups.push({ repeats: false, fixed: false, allAltsFixed: true });
      // Skip the group's prefix: (?: (?= (?! (?<= (?<! (?<name>
      const prefix = /^\(\?(?::|=|!|<=|<!|<[A-Za-z_]\w*>)/.exec(source.slice(i));
      if (prefix) i += prefix[0].length - 1;
    } else if (c === ')') {
      const g = groups.length > 1 ? groups.pop()! : { repeats: false, fixed: false, allAltsFixed: true };
      // Repetition inside a group counts for the groups around it too
      if (g.repeats) top().repeats = true;
      last = { kind: 'group', repeats: g.repeats, fixed: g.allAltsFixed && g.fixed };
    } else if (c === '|') {
      top().allAltsFixed &&= top().fixed;
      top().fixed = false;
    } else if (c !== '^' && c !== '$') {
      last = { kind: 'atom', wide: c === '.' };
    }
  }
  return { nested, wide };
}

/** A RegExp from a learner's pattern, or PatternTooComplex for repetition nested inside repetition. */
export function userRegex(tool: string, source: string, flags = ''): RegExp {
  if (regexShape(source).nested) {
    throw new PatternTooComplex(
      `${tool}: simulator limit: this pattern repeats a group that itself repeats, such as (a*)* or (.*)*; it would take this simulator far too long. A real system handles it, but the result is the same as without the outer repetition.`,
    );
  }
  return new RegExp(source, flags);
}

/**
 * Refuses a match that would take far too long: each wide unbounded repetition (.*, [^x]*) multiplies the
 * work by the line length. Cheap to call once per command with all of its input.
 */
export function checkRegexWork(tool: string, re: RegExp, text: string): void {
  const { wide } = regexShape(re.source);
  if (wide === 0) return;
  const lines = text.split('\n');
  const longest = lines.reduce((m, l) => Math.max(m, l.length), 0);
  if (lines.length * longest ** (wide + 1) > MAX_WORK) {
    throw new PatternTooComplex(
      `${tool}: simulator limit: this pattern has ${wide} parts like .* and a line ${longest} characters long; matching it would take this simulator far too long. Use fewer .* or shorter input.`,
    );
  }
}
