// Limits that keep a simulated command from freezing the page. A real system would run a ping for hours
// or print a gigabyte of padding; the simulator stops early and says so, instead of locking up the tab.

/** Most ping / Test-Connection replies shown for one command. */
export const MAX_REPLIES = 100;

/** Largest printf field width or precision the simulator builds. */
export const MAX_FORMAT_WIDTH = 10000;

/** The note shown when a ping is cut short. */
export const repliesNote = (count: number, option: string) =>
  `The simulator shows the first ${MAX_REPLIES} replies; a real ${option} ${count} keeps pinging once a second.`;

/**
 * Deepest path the simulator creates, in components. Real Linux stops at PATH_MAX (4096 bytes),
 * which a lab never needs; a lower cap keeps a runaway `mkdir -p a/a/a/...` from freezing the tab.
 */
export const MAX_PATH_DEPTH = 256;

/** Most nested levels of $(( ... )) parentheses and unary operators evaluated. */
export const MAX_ARITH_DEPTH = 256;

/** Number of components in an absolute path ("/" is 0). */
export const pathDepth = (abs: string) => abs.split('/').filter(Boolean).length;

/** Levels in a subtree, counting the node itself (a file or an empty directory is 1). Iterative. */
export function treeHeight(node: { children?: Record<string, unknown> }): number {
  let max = 0;
  const stack: [{ children?: Record<string, unknown> }, number][] = [[node, 1]];
  while (stack.length) {
    const [n, d] = stack.pop()!;
    if (d > max) max = d;
    for (const c of Object.values(n.children ?? {})) stack.push([c as { children?: Record<string, unknown> }, d + 1]);
  }
  return max;
}

// --- Work budget for one typed command line ------------------------------------------------------------

/** Most command lines one typed line may run, counting every line of every script it starts. */
export const MAX_LINES_PER_COMMAND = 5000;

/** Largest value a shell variable may hold, in characters. */
export const MAX_VALUE_LENGTH = 1_000_000;

/** Most words brace expansion ({1..N}, {a,b}{c,d}) may produce. */
export const MAX_BRACE_WORDS = 10000;

/**
 * Thrown when a command line goes over its budget. The message is the full line to show ("bash: simulator
 * limit: ..."); the terminal prints it and leaves the machine as it was.
 */
export class BudgetExceeded extends Error {}

let linesRun = 0;

/** Starts a fresh budget: call once per line the learner types. */
export function startBudget(): void {
  linesRun = 0;
}

/** Counts one command line (typed, from a script, or from $(...)), and stops runaway fan-out. */
export function chargeLine(): void {
  if (++linesRun > MAX_LINES_PER_COMMAND) {
    throw new BudgetExceeded(
      `bash: simulator limit: this command ran more than ${MAX_LINES_PER_COMMAND} command lines (for example a script that starts itself), so the simulator stopped it. A real shell would keep going until it ran out of processes or memory.`,
    );
  }
}

/** Stops a variable from growing without bound (x=$x$x in a loop). */
export function checkValueLength(name: string, value: string): void {
  if (value.length > MAX_VALUE_LENGTH) {
    throw new BudgetExceeded(`bash: simulator limit: the value of ${name} is longer than this simulator allows (${MAX_VALUE_LENGTH} characters).`);
  }
}
