import { LinuxContext } from './context';

// One input reader for every filter command (cat, head, tail, grep, sort, uniq, wc, sed, awk, cut).

export interface InputSource {
  /** Name as the user typed it ("-" for standard input). */
  name: string;
  text: string;
}

/** Formats a read error for a command, e.g. sort: "cannot read: x: No such file or directory". */
export type InputErrorFormat = (file: string, reason: string) => string;

export interface InputResult {
  inputs: InputSource[];
  errors: string[];
}

/** Real GNU coreutils/grep/sed/mawk wording for "could not read FILE: REASON". */
export const INPUT_ERRORS: Record<string, InputErrorFormat> = {
  cat: (f, r) => `cat: ${f}: ${r}`,
  head: (f, r) => r === 'Is a directory' ? `head: error reading '${f}': Is a directory` : `head: cannot open '${f}' for reading: ${r}`,
  tail: (f, r) => r === 'Is a directory' ? `tail: error reading '${f}': Is a directory` : `tail: cannot open '${f}' for reading: ${r}`,
  grep: (f, r) => `grep: ${f}: ${r}`,
  sort: (f, r) => r === 'No such file or directory' ? `sort: cannot read: ${f}: ${r}`
    : r === 'Is a directory' ? `sort: read failed: ${f}: ${r}` : `sort: open failed: ${f}: ${r}`,
  uniq: (f, r) => `uniq: ${f}: ${r}`,
  wc: (f, r) => `wc: ${f}: ${r}`,
  sed: (f, r) => r === 'Is a directory' ? `sed: read error on ${f}: ${r}` : `sed: can't read ${f}: ${r}`,
  awk: (f, r) => `awk: cannot open ${f} (${r})`,
  cut: (f, r) => `cut: ${f}: ${r}`,
};

/**
 * Reads the named files (or stdin when none are given; "-" also means stdin), checking
 * traversal and read permission exactly like `cat`. Unreadable files produce an error line
 * and are skipped, so the command still processes the others, as the real tools do.
 */
/**
 * Bytes read from an endless device: /dev/zero gives NUL bytes, /dev/random and /dev/urandom random
 * ones. Only a command that stops after a byte count (head -c) can read them; others get nothing.
 */
function deviceBytes(path: string, count: number): string | null {
  if (path === '/dev/zero') return '\0'.repeat(count);
  if (path === '/dev/urandom' || path === '/dev/random') {
    // 7-bit values: the simulator's text is UTF-16, where a value above 127 would count as two bytes
    return Array.from({ length: count }, () => String.fromCharCode(Math.floor(Math.random() * 128))).join('');
  }
  return null;
}

export function readInputs(ctx: LinuxContext, files: string[], format?: InputErrorFormat, byteCount?: number): InputResult {
  const fmt = format ?? INPUT_ERRORS[ctx.name] ?? ((f: string, r: string) => `${ctx.name}: ${f}: ${r}`);
  if (files.length === 0) return { inputs: [{ name: '-', text: ctx.stdin }], errors: [] };
  const inputs: InputSource[] = [];
  const errors: string[] = [];
  for (const f of files) {
    if (f === '-') {
      inputs.push({ name: '-', text: ctx.stdin });
      continue;
    }
    const path = ctx.resolve(f);
    const node = ctx.node(path);
    if (!ctx.traverse(path).ok) {
      errors.push(fmt(f, 'Permission denied'));
    } else if (!node) {
      errors.push(fmt(f, 'No such file or directory'));
    } else if (node.type === 'directory') {
      errors.push(fmt(f, 'Is a directory'));
    } else {
      const check = ctx.canRead(path);
      const endless = node.device === 'char' && byteCount !== undefined ? deviceBytes(path, Math.min(byteCount, 1 << 20)) : null;
      if (check.ok) inputs.push({ name: f, text: endless ?? node.content ?? '' });
      else errors.push(fmt(f, check.error || 'Permission denied'));
    }
  }
  return { inputs, errors };
}
