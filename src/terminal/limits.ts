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
