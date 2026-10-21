import { FileNode } from '../../../types/terminal';
import { writeFileContent } from '../../filesystem';
import { parseOptions, optionValue, toLines, posixToJsRegex, escapeRegex, padNum } from '../../textUtils';
import { LinuxContext, LinuxResult, linuxCommands, createInDir } from '../context';
import { readInputs, InputSource } from '../input';
import { runAwk, AwkError } from '../awk';

// Text processing: echo, cat, head, tail, grep, awk, sed, sort, uniq, wc, cut, tr

/** Ends a command that read inputs: stdout plus any per-file errors, exit code `errCode` on error. */
function finish(ctx: LinuxContext, stdout: string, errors: string[], errCode: number, okCode = 0): LinuxResult {
  return ctx.result(stdout, errors.join('\n'), errors.length ? errCode : okCode);
}

function echo(ctx: LinuxContext): LinuxResult {
  const args = [...ctx.args];
  let interpret = false;
  while (args[0] && /^-[neE]+$/.test(args[0])) {
    if (args[0].includes('e')) interpret = true;
    args.shift();
  }
  let text = args.join(' ');
  if (interpret) text = text.replace(/\\n/g, '\n').replace(/\\t/g, '\t').replace(/\\\\/g, '\\');
  return ctx.ok(text);
}

/** cat -v: control characters as ^X, DEL as ^?, bytes above 127 as M-x (tabs and newlines stay). */
function showNonprinting(line: string, tabs: boolean): string {
  let out = '';
  for (const ch of line) {
    let code = ch.codePointAt(0)!;
    let pre = '';
    if (code > 255) { out += ch; continue; }
    if (code >= 128) { pre = 'M-'; code -= 128; }
    if (code === 9 && !pre) out += tabs ? '^I' : '\t';
    else if (code < 32) out += `${pre}^${String.fromCharCode(code + 64)}`;
    else if (code === 127) out += `${pre}^?`;
    else out += pre + String.fromCharCode(code);
  }
  return out;
}

function cat(ctx: LinuxContext): LinuxResult {
  const opts = parseOptions(ctx.args, '', {
    'show-all': 'A', 'number-nonblank': 'b', 'show-ends': 'E', number: 'n', 'squeeze-blank': 's', 'show-tabs': 'T', 'show-nonprinting': 'v',
  });
  const f = opts.flags;
  // -A is -vET, -e is -vE, -t is -vT
  const nonprinting = f.has('v') || f.has('A') || f.has('e') || f.has('t');
  const ends = f.has('E') || f.has('A') || f.has('e');
  const tabs = f.has('T') || f.has('A') || f.has('t');
  const { inputs, errors } = readInputs(ctx, opts.operands);
  let out = inputs.map(i => i.text).join('\n');
  if (f.has('s') || f.has('b') || f.has('n') || nonprinting || ends || tabs) {
    let lines = toLines(out);
    if (f.has('s')) lines = lines.filter((l, i) => !(l === '' && i > 0 && lines[i - 1] === ''));
    let n = 0;
    lines = lines.map(l => {
      let text = nonprinting ? showNonprinting(l, tabs) : tabs ? l.replace(/\t/g, '^I') : l;
      if (ends) text += '$';
      if (f.has('b')) return l === '' ? text : `${padNum(++n, 6)}\t${text}`;
      if (f.has('n')) return `${padNum(++n, 6)}\t${text}`;
      return text;
    });
    out = lines.join('\n');
  }
  return finish(ctx, out, errors, 1);
}

/** head and tail share option parsing: -n N, -N, -c N, tail -n +N, head -n -N, -q/-v. */
function headOrTail(which: 'head' | 'tail') {
  return (ctx: LinuxContext): LinuxResult => {
    const args = ctx.args.map(a => (/^-\d+$/.test(a) ? `-n${a.slice(1)}` : a));
    const opts = parseOptions(args, 'nc', { lines: 'n', bytes: 'c', quiet: 'q', silent: 'q', verbose: 'v' });
    const spec = optionValue(opts, 'n') ?? '10';
    const bytes = optionValue(opts, 'c');
    const num = parseInt(spec, 10);
    if (isNaN(num) || (bytes !== undefined && isNaN(parseInt(bytes, 10)))) {
      return ctx.fail(`${which}: invalid number of ${bytes !== undefined ? 'bytes' : 'lines'}: '${bytes ?? spec}'`);
    }
    const { inputs, errors } = readInputs(ctx, opts.operands);
    const pick = (text: string): string => {
      if (bytes !== undefined) {
        const b = parseInt(bytes, 10);
        return which === 'head' ? text.slice(0, b) : text.slice(-b);
      }
      const lines = toLines(text);
      if (which === 'head') return (num < 0 ? lines.slice(0, num) : lines.slice(0, num)).join('\n');
      if (spec.startsWith('+')) return lines.slice(Math.max(0, num - 1)).join('\n');
      return lines.slice(Math.max(0, lines.length - Math.abs(num))).join('\n');
    };
    const headers = (inputs.length + errors.length > 1 && !opts.flags.has('q')) || opts.flags.has('v');
    const blocks = inputs.map(i => {
      const body = pick(i.text);
      const name = i.name === '-' ? 'standard input' : i.name;
      return headers ? `==> ${name} <==${body ? '\n' + body : ''}` : body;
    });
    return finish(ctx, blocks.join(headers ? '\n\n' : '\n'), errors, 1);
  };
}

// ---------- grep ----------

interface GrepOptions {
  regex: RegExp;
  invert: boolean;
  count: boolean;
  filesWith: boolean;
  filesWithout: boolean;
  lineNumbers: boolean;
  onlyMatching: boolean;
  quiet: boolean;
  showNames: boolean;
  /** Lines of context before and after each match (-B, -A, -C) */
  before: number;
  after: number;
  /** Stop after this many matching lines (-m) */
  max: number;
}

function grepLines(text: string, name: string | null, o: GrepOptions, out: string[]): { matched: boolean } {
  // Matching lines use ':' after the file name and line number, context lines use '-'
  const prefix = (n: number, sep = ':') => `${name !== null ? name + sep : ''}${o.lineNumbers ? n + sep : ''}`;
  const lines = toLines(text);
  const matches: number[] = [];
  for (let idx = 0; idx < lines.length && matches.length < o.max; idx++) {
    o.regex.lastIndex = 0;
    if (o.regex.test(lines[idx]) !== o.invert) matches.push(idx);
  }
  const count = matches.length;
  if (o.quiet) return { matched: count > 0 };
  if (o.filesWith) { if (count) out.push(name ?? '(standard input)'); return { matched: count > 0 }; }
  if (o.filesWithout) { if (!count) out.push(name ?? '(standard input)'); return { matched: count > 0 }; }
  if (o.count) { out.push(`${name !== null ? name + ':' : ''}${count}`); return { matched: count > 0 }; }

  if (o.onlyMatching && !o.invert) {
    for (const idx of matches) {
      for (const m of lines[idx].matchAll(new RegExp(o.regex.source, o.regex.flags.includes('g') ? o.regex.flags : o.regex.flags + 'g'))) {
        if (m[0]) out.push(prefix(idx + 1) + m[0]);
      }
    }
    return { matched: count > 0 };
  }
  if (!o.before && !o.after) {
    for (const idx of matches) out.push(prefix(idx + 1) + lines[idx]);
    return { matched: count > 0 };
  }
  // With context: print each match with its neighbours; groups that do not touch are separated by --
  const isMatch = new Set(matches);
  let last = -1;
  for (const idx of matches) {
    const from = Math.max(0, idx - o.before, last + 1);
    const to = Math.min(lines.length - 1, idx + o.after);
    if (last >= 0 && from > last + 1) out.push('--');
    for (let i = from; i <= to; i++) {
      if (i <= last) continue;
      // After the last allowed match (-m), trailing context still prints but stops at the next match
      if (i > idx && isMatch.has(i)) break;
      out.push(prefix(i + 1, isMatch.has(i) ? ':' : '-') + lines[i]);
      last = i;
    }
  }
  return { matched: count > 0 };
}

function grep(ctx: LinuxContext): LinuxResult {
  const opts = parseOptions(ctx.args, 'efmABCd', {
    'ignore-case': 'i', 'invert-match': 'v', count: 'c', 'files-with-matches': 'l', 'files-without-match': 'L',
    'line-number': 'n', recursive: 'r', 'dereference-recursive': 'R', 'extended-regexp': 'E', 'fixed-strings': 'F',
    'word-regexp': 'w', 'line-regexp': 'x', 'only-matching': 'o', quiet: 'q', silent: 'q', 'no-messages': 's',
    'with-filename': 'H', 'no-filename': 'h', regexp: 'e', file: 'f', 'basic-regexp': 'G',
    'after-context': 'A', 'before-context': 'B', context: 'C', 'max-count': 'm',
  });
  const num = (k: string): number | null => {
    const v = optionValue(opts, k);
    if (v === undefined) return 0;
    return /^\d+$/.test(v) ? Number(v) : null;
  };
  const ctxA = num('A'), ctxB = num('B'), ctxC = num('C');
  if (ctxA === null || ctxB === null || ctxC === null) {
    const bad = [optionValue(opts, 'A'), optionValue(opts, 'B'), optionValue(opts, 'C')].find(v => v !== undefined && !/^\d+$/.test(v));
    return ctx.fail(`grep: ${bad}: invalid context length argument`, 2);
  }
  const maxArg = optionValue(opts, 'm');
  if (maxArg !== undefined && !/^-?\d+$/.test(maxArg)) return ctx.fail(`grep: invalid max count`, 2);
  const f = opts.flags;
  const operands = [...opts.operands];
  const patterns = opts.values.get('e') ?? (operands.length ? [operands.shift()!] : null);
  if (!patterns) {
    return ctx.fail("Usage: grep [OPTION]... PATTERNS [FILE]...\nTry 'grep --help' for more information.", 2);
  }
  const extended = f.has('E') || ctx.name === 'egrep';
  const fixed = f.has('F') || ctx.name === 'fgrep';
  let source = patterns.flatMap(p => p.split('\n')).map(p => (fixed ? escapeRegex(p) : posixToJsRegex(p, extended))).join('|');
  if (f.has('w')) source = `(?<![A-Za-z0-9_])(?:${source})(?![A-Za-z0-9_])`;
  if (f.has('x')) source = `^(?:${source})$`;
  let regex: RegExp;
  try {
    regex = new RegExp(source, f.has('i') ? 'i' : '');
  } catch {
    return ctx.fail(`grep: Unmatched ( or \\(`, 2);
  }

  const recursive = f.has('r') || f.has('R');
  const implicitDot = recursive && operands.length === 0;
  const targets = implicitDot ? ['.'] : operands;
  const o: GrepOptions = {
    regex,
    invert: f.has('v'),
    count: f.has('c'),
    filesWith: f.has('l'),
    filesWithout: f.has('L'),
    lineNumbers: f.has('n'),
    onlyMatching: f.has('o'),
    quiet: f.has('q'),
    showNames: (f.has('H') || recursive || targets.length > 1) && !f.has('h'),
    before: optionValue(opts, 'B') !== undefined ? ctxB : ctxC,
    after: optionValue(opts, 'A') !== undefined ? ctxA : ctxC,
    max: maxArg === undefined || Number(maxArg) < 0 ? Infinity : Number(maxArg),
  };

  const out: string[] = [];
  const errors: string[] = [];
  let matched = false;
  const err = (m: string) => { if (!f.has('s')) errors.push(m); };
  const search = (text: string, name: string | null) => {
    if (grepLines(text, o.showNames ? name : null, o, out).matched) matched = true;
  };

  if (targets.length === 0) {
    search(ctx.stdin, '(standard input)');
  }

  const walk = (dirNode: FileNode, absDir: string, shown: string) => {
    const why = `Searching inside ${absDir} needs read (r) and execute (x) on it, but it`;
    if (!ctx.access(dirNode, absDir, 'r', why).ok || !ctx.access(dirNode, absDir, 'x', why).ok) {
      err(`grep: ${shown}: Permission denied`);
      return;
    }
    for (const name of Object.keys(dirNode.children ?? {}).sort()) {
      const child = dirNode.children![name];
      const abs = absDir === '/' ? `/${name}` : `${absDir}/${name}`;
      const label = shown === '' ? name : shown.endsWith('/') ? shown + name : `${shown}/${name}`;
      if (child.type === 'directory') walk(child, abs, label);
      else if (!ctx.access(child, abs, 'r').ok) err(`grep: ${label}: Permission denied`);
      else search(child.content || '', label);
    }
  };

  for (const t of targets) {
    if (t === '-') { search(ctx.stdin, '(standard input)'); continue; }
    const abs = ctx.resolve(t);
    const node = ctx.node(abs);
    if (node?.type === 'directory') {
      if (!recursive) { err(`grep: ${t}: Is a directory`); continue; }
      if (!ctx.traverse(abs).ok) { err(`grep: ${t}: Permission denied`); continue; }
      walk(node, abs, implicitDot ? '' : t);
      continue;
    }
    const { inputs, errors: readErrors } = readInputs(ctx, [t]);
    readErrors.forEach(err);
    for (const i of inputs) search(i.text, i.name);
  }

  const hadError = errors.length > 0 || (f.has('s') && out.length === 0 && targets.some(t => !ctx.node(ctx.resolve(t))));
  const code = o.quiet && matched ? 0 : hadError ? 2 : matched ? 0 : 1;
  return ctx.result(o.quiet ? '' : out.join('\n'), errors.join('\n'), code);
}

// ---------- awk ----------

function awk(ctx: LinuxContext): LinuxResult {
  const opts = parseOptions(ctx.args, 'Fvf');
  const operands = [...opts.operands];
  const program = operands.shift();
  if (program === undefined) return ctx.fail('Usage: awk [-F value] [-v var=value] [--] \'program text\' [file ...]', 2);
  let fs = optionValue(opts, 'F') ?? ' ';
  if (fs === '\\t' || fs === 't') fs = '\t';
  const assigns = (opts.values.get('v') ?? []).map(a => a.split(/=(.*)/s, 2) as [string, string]);
  const { inputs, errors } = readInputs(ctx, operands);
  if (errors.length) return ctx.fail(errors[0], 2);
  try {
    return ctx.ok(runAwk(program, inputs.map(i => toLines(i.text)), fs, assigns));
  } catch (e) {
    if (e instanceof AwkError) {
      return ctx.fail(/never defined|division|simulator allows/.test(e.message) ? `awk: ${e.message}` : `awk: line 1: syntax error at or near ${e.message}`, 2);
    }
    throw e;
  }
}

// ---------- sed ----------

type SedAddr = { line: number } | { last: true } | { re: RegExp };
interface SedCmd {
  from?: SedAddr;
  to?: SedAddr;
  negate: boolean;
  op: 's' | 'd' | 'p' | 'q' | 'y' | '=';
  re?: RegExp;
  replacement?: string;
  global?: boolean;
  nth?: number;
  print?: boolean;
  ySrc?: string;
  yDst?: string;
}

class SedError extends Error {}

function sedRegex(src: string, extended: boolean, flags = ''): RegExp {
  try {
    return new RegExp(posixToJsRegex(src, extended), flags);
  } catch {
    throw new SedError(`-e expression #1, char ${src.length}: Invalid preceding regular expression`);
  }
}

/** Converts a sed replacement (\1, &, \&, \n) to JavaScript's String.replace syntax. */
function sedReplacement(r: string): string {
  let out = '';
  for (let i = 0; i < r.length; i++) {
    const c = r[i];
    if (c === '\\' && i + 1 < r.length) {
      const n = r[++i];
      out += /\d/.test(n) ? `$${n}` : n === 'n' ? '\n' : n === 't' ? '\t' : n === '$' ? '$$' : n;
    } else if (c === '&') out += '$&';
    else if (c === '$') out += '$$';
    else out += c;
  }
  return out;
}

function parseSed(script: string, extended: boolean): SedCmd[] {
  const cmds: SedCmd[] = [];
  let i = 0;
  const unknown = (c: string) => new SedError(`-e expression #1, char ${i + 1}: unknown command: \`${c}'`);
  const readDelimited = (delim: string): string => {
    let s = '';
    while (i < script.length && script[i] !== delim) {
      if (script[i] === '\\' && script[i + 1] === delim) { s += delim; i += 2; continue; }
      if (script[i] === '\\') { s += script[i] + (script[i + 1] ?? ''); i += 2; continue; }
      s += script[i++];
    }
    if (i >= script.length) throw new SedError(`-e expression #1, char ${script.length}: unterminated \`s' command`);
    i++;
    return s;
  };
  const readAddr = (): SedAddr | undefined => {
    const m = script.slice(i).match(/^\d+/);
    if (m) { i += m[0].length; return { line: Number(m[0]) }; }
    if (script[i] === '$') { i++; return { last: true }; }
    if (script[i] === '/' || (script[i] === '\\' && script[i + 1])) {
      const d = script[i] === '/' ? '/' : script[++i];
      i++;
      const re = readDelimited(d);
      let flags = '';
      if (script[i] === 'I') { flags = 'i'; i++; }
      return { re: sedRegex(re, extended, flags) };
    }
    return undefined;
  };
  while (i < script.length) {
    while (/[\s;]/.test(script[i] ?? '')) i++;
    if (i >= script.length) break;
    const cmd: SedCmd = { negate: false, op: 'p' };
    cmd.from = readAddr();
    if (cmd.from && script[i] === ',') { i++; cmd.to = readAddr(); }
    while (script[i] === ' ') i++;
    if (script[i] === '!') { cmd.negate = true; i++; }
    const c = script[i++];
    if (c === 's') {
      const d = script[i++];
      if (!d) throw new SedError(`-e expression #1, char ${i}: unterminated \`s' command`);
      const pat = readDelimited(d);
      const rep = readDelimited(d);
      let flags = '';
      const fm = script.slice(i).match(/^[gpiI0-9]*/)![0];
      i += fm.length;
      cmd.global = fm.includes('g');
      cmd.print = fm.includes('p');
      const nth = fm.match(/\d+/);
      if (nth) cmd.nth = Number(nth[0]);
      if (/[iI]/.test(fm)) flags = 'i';
      Object.assign(cmd, { op: 's', re: sedRegex(pat, extended, flags + 'g'), replacement: sedReplacement(rep) });
    } else if (c === 'y') {
      const d = script[i++];
      const src = readDelimited(d);
      const dst = readDelimited(d);
      if (src.length !== dst.length) throw new SedError(`-e expression #1, char ${i}: strings for \`y' command are different lengths`);
      Object.assign(cmd, { op: 'y', ySrc: src, yDst: dst });
    } else if (c === 'd' || c === 'p' || c === 'q' || c === '=') {
      cmd.op = c;
    } else {
      throw unknown(c ?? '');
    }
    cmds.push(cmd);
  }
  return cmds;
}

function runSed(cmds: SedCmd[], lines: string[], quiet: boolean): string[] {
  const out: string[] = [];
  const active = new Map<SedCmd, boolean>();
  const hit = (a: SedAddr, line: string, n: number, last: boolean) =>
    'line' in a ? a.line === n : 'last' in a ? last : a.re.test(line);
  for (let n = 1; n <= lines.length; n++) {
    let line = lines[n - 1];
    const last = n === lines.length;
    let deleted = false;
    let quit = false;
    for (const c of cmds) {
      let sel = true;
      if (c.from && c.to) {
        if (active.get(c)) {
          sel = true;
          if (hit(c.to, line, n, last) || ('line' in c.to && n >= c.to.line)) active.set(c, false);
        } else if (hit(c.from, line, n, last)) {
          sel = true;
          if (!('line' in c.to && c.to.line <= n)) active.set(c, true);
        } else sel = false;
      } else if (c.from) sel = hit(c.from, line, n, last);
      if (c.negate) sel = !sel;
      if (!sel) continue;
      if (c.op === 'd') { deleted = true; break; }
      if (c.op === 'p') out.push(line);
      if (c.op === '=') out.push(String(n));
      if (c.op === 'q') { quit = true; break; }
      if (c.op === 'y') line = [...line].map(ch => { const k = c.ySrc!.indexOf(ch); return k >= 0 ? c.yDst![k] : ch; }).join('');
      if (c.op === 's') {
        let count = 0;
        let changed = false;
        const target = c.nth ?? 1;
        const next = line.replace(c.re!, (...m) => {
          count++;
          if (c.global ? count >= target : count === target) {
            changed = true;
            return m[0].replace(new RegExp(c.re!.source, c.re!.flags.replace('g', '')), c.replacement!);
          }
          return m[0];
        });
        line = next;
        if (changed && c.print) out.push(line);
      }
    }
    if (!deleted && !quiet) out.push(line);
    if (quit) break;
  }
  return out;
}

function sed(ctx: LinuxContext): LinuxResult {
  // -i may carry a backup suffix (-i.bak); it is accepted and ignored
  const args = ctx.args.map(a => (/^-i.+/.test(a) && !a.startsWith('-in') ? '-i' : a));
  const opts = parseOptions(args, 'ef', { quiet: 'n', silent: 'n', 'in-place': 'i', 'regexp-extended': 'E', expression: 'e' });
  const operands = [...opts.operands];
  const scripts = opts.values.get('e') ?? (operands.length ? [operands.shift()!] : null);
  if (!scripts) return ctx.fail('Usage: sed [OPTION]... {script-only-if-no-other-script} [input-file]...', 1);
  let cmds: SedCmd[];
  try {
    cmds = parseSed(scripts.join('\n'), opts.flags.has('E') || opts.flags.has('r'));
  } catch (e) {
    if (e instanceof SedError) return ctx.fail(`sed: ${e.message}`, 1);
    throw e;
  }
  const quiet = opts.flags.has('n');

  if (opts.flags.has('i')) {
    if (operands.length === 0) return ctx.fail('sed: no input files', 1);
    const errors: string[] = [];
    for (const f of operands) {
      const { inputs, errors: e } = readInputs(ctx, [f]);
      if (e.length) { errors.push(...e); continue; }
      const path = ctx.resolve(f);
      const dir = path.slice(0, path.lastIndexOf('/')) || '/';
      // sed -i writes a temporary file next to the original and renames it over
      if (!ctx.canWrite(`${dir === '/' ? '' : dir}/sedXXXXXX`).ok) {
        errors.push(`sed: couldn't open temporary file ${dir === '/' ? '' : dir}/sedXXXXXX: Permission denied`);
        continue;
      }
      writeFileContent(ctx.node(path)!, runSed(cmds, toLines(inputs[0].text), quiet).join('\n'));
    }
    return finish(ctx, '', errors, errors.some(e => e.includes('temporary')) ? 4 : 2);
  }

  const { inputs, errors } = readInputs(ctx, operands);
  const lines = inputs.flatMap(i => toLines(i.text));
  return finish(ctx, runSed(cmds, lines, quiet).join('\n'), errors, 2);
}

// ---------- sort / uniq / wc ----------

function sort(ctx: LinuxContext): LinuxResult {
  const opts = parseOptions(ctx.args, 'ktoT', {
    reverse: 'r', numeric: 'n', 'numeric-sort': 'n', unique: 'u', 'ignore-case': 'f', key: 'k', 'field-separator': 't',
    output: 'o', stable: 's', 'human-numeric-sort': 'h',
  });
  const f = opts.flags;
  const sep = optionValue(opts, 't');
  if (sep !== undefined && sep.length !== 1) return ctx.fail(`sort: multi-character tab '${sep}'`, 2);
  const keySpec = optionValue(opts, 'k');
  const keyMatch = keySpec?.match(/^(\d+)(?:\.\d+)?([a-z]*)(?:,(\d+)(?:\.\d+)?([a-z]*))?$/);
  if (keySpec && !keyMatch) return ctx.fail(`sort: invalid number at field start: invalid count at start of '${keySpec}'`, 2);
  const keyMods = (keyMatch?.[2] ?? '') + (keyMatch?.[4] ?? '');
  const keyNumeric = keyMods.includes('n');
  const keyReverse = keyMods.includes('r');

  const { inputs, errors } = readInputs(ctx, opts.operands);
  if (errors.length) return ctx.fail(errors[0], 2);
  const lines = inputs.flatMap(i => toLines(i.text));

  const key = (line: string): string => {
    if (!keyMatch) return line;
    const fields = sep !== undefined ? line.split(sep) : line.trim().split(/\s+/);
    const from = Number(keyMatch[1]) - 1;
    const to = keyMatch[3] ? Number(keyMatch[3]) : fields.length;
    return fields.slice(from, to).join(sep ?? ' ');
  };
  const HUMAN: Record<string, number> = { K: 1e3, M: 1e6, G: 1e9, T: 1e12 };
  const num = (s: string) => {
    const m = s.trim().match(/^-?\d*\.?\d+([KMGT])?/i);
    if (!m) return 0;
    return parseFloat(m[0]) * (f.has('h') && m[1] ? HUMAN[m[1].toUpperCase()] : 1);
  };
  const numeric = f.has('n') || f.has('h') || keyNumeric;
  const cmpKey = (a: string, b: string): number => {
    if (numeric) return num(a) - num(b);
    const x = f.has('f') ? a.toUpperCase() : a;
    const y = f.has('f') ? b.toUpperCase() : b;
    return x.localeCompare(y);
  };
  const reverse = f.has('r') !== keyReverse ? -1 : 1;
  const sorted = [...lines].sort((a, b) => {
    const c = cmpKey(key(a), key(b));
    if (c !== 0 || f.has('s') || f.has('u')) return c * reverse;
    return a.localeCompare(b) * reverse; // last-resort whole-line comparison
  });
  const result = f.has('u') ? sorted.filter((l, i) => i === 0 || cmpKey(key(l), key(sorted[i - 1])) !== 0) : sorted;

  const outFile = optionValue(opts, 'o');
  if (outFile) {
    const path = ctx.resolve(outFile);
    const check = ctx.canWrite(path);
    if (!check.ok) return ctx.fail(`sort: open failed: ${outFile}: ${check.error}`, 2);
    const node = ctx.node(path);
    if (node) writeFileContent(node, result.join('\n'));
    else createInDir(ctx.fs, path, 'file', result.join('\n'), ctx.user, ctx.group, ctx.fileMode());
    return ctx.ok();
  }
  return ctx.ok(result.join('\n'));
}

function uniq(ctx: LinuxContext): LinuxResult {
  const opts = parseOptions(ctx.args, 'fs', { count: 'c', repeated: 'd', unique: 'u', 'ignore-case': 'i' });
  const f = opts.flags;
  const [input, output] = opts.operands;
  const { inputs, errors } = readInputs(ctx, input === undefined ? [] : [input]);
  if (errors.length) return ctx.fail(errors[0], 1);
  const lines = inputs.flatMap(i => toLines(i.text));
  const same = (a: string, b: string) => (f.has('i') ? a.toLowerCase() === b.toLowerCase() : a === b);

  // Only ADJACENT duplicates collapse: that is why input is normally sorted first
  const groups: { line: string; count: number }[] = [];
  for (const line of lines) {
    const last = groups[groups.length - 1];
    if (last && same(last.line, line)) last.count++;
    else groups.push({ line, count: 1 });
  }
  const out = groups
    .filter(g => (f.has('d') ? g.count > 1 : f.has('u') ? g.count === 1 : true))
    .map(g => (f.has('c') ? `${padNum(g.count, 7)} ${g.line}` : g.line))
    .join('\n');

  if (output !== undefined) {
    const path = ctx.resolve(output);
    const check = ctx.canWrite(path);
    if (!check.ok) return ctx.fail(`uniq: ${output}: ${check.error}`, 1);
    const node = ctx.node(path);
    if (node) writeFileContent(node, out);
    else createInDir(ctx.fs, path, 'file', out, ctx.user, ctx.group, ctx.fileMode());
    return ctx.ok();
  }
  return ctx.ok(out);
}

function wc(ctx: LinuxContext): LinuxResult {
  const opts = parseOptions(ctx.args, '', { lines: 'l', words: 'w', bytes: 'c', chars: 'm', 'max-line-length': 'L' });
  let want = ['l', 'w', 'c', 'm', 'L'].filter(k => opts.flags.has(k));
  if (want.length === 0) want = ['l', 'w', 'c'];
  const { inputs, errors } = readInputs(ctx, opts.operands);

  const count = (src: InputSource) => {
    const t = src.text;
    // Stored contents omit the final newline that a real file or pipe would carry
    const withNl = t === '' || t.endsWith('\n') ? t : t + '\n';
    const lines = toLines(t);
    return {
      l: (withNl.match(/\n/g) ?? []).length,
      w: t.split(/\s+/).filter(Boolean).length,
      c: new TextEncoder().encode(withNl).length,
      m: withNl.length,
      L: Math.max(0, ...lines.map(l => l.length)),
    } as Record<string, number>;
  };
  const rows = inputs.map(i => ({ name: i.name === '-' && opts.operands.length === 0 ? '' : i.name, n: count(i) }));
  if (rows.length > 1) {
    const total: Record<string, number> = { l: 0, w: 0, c: 0, m: 0, L: 0 };
    for (const r of rows) for (const k of Object.keys(total)) total[k] = k === 'L' ? Math.max(total[k], r.n[k]) : total[k] + r.n[k];
    rows.push({ name: 'total', n: total });
  }
  const fromStdin = inputs.some(i => i.name === '-');
  const width = want.length === 1 && rows.length === 1 ? 1
    : fromStdin ? 7 : Math.max(1, ...rows.map(r => String(r.n.c).length));
  const out = rows.map(r => [...want.map(k => padNum(r.n[k], width)), r.name].filter(Boolean).join(' ')).join('\n');
  return finish(ctx, out, errors, 1);
}

// ---------- cut / tr ----------

/** Parses a cut LIST such as "1,3-5,7-" into a membership test (1-based). */
function parseList(list: string): ((n: number) => boolean) | string {
  const ranges: [number, number][] = [];
  for (const part of list.split(',')) {
    const m = part.match(/^(\d*)(-?)(\d*)$/);
    if (!m || (m[1] === '' && m[3] === '') ) return `invalid field range`;
    const lo = m[1] === '' ? 1 : Number(m[1]);
    const hi = m[2] ? (m[3] === '' ? Infinity : Number(m[3])) : lo;
    if (lo === 0 || hi === 0) return 'fields and positions are numbered from 1';
    if (hi < lo) return 'invalid decreasing range';
    ranges.push([lo, hi]);
  }
  return n => ranges.some(([lo, hi]) => n >= lo && n <= hi);
}

function cut(ctx: LinuxContext): LinuxResult {
  const opts = parseOptions(ctx.args, 'dfcb', {
    delimiter: 'd', fields: 'f', characters: 'c', bytes: 'b', 'only-delimited': 's',
  });
  const fields = optionValue(opts, 'f');
  const chars = optionValue(opts, 'c') ?? optionValue(opts, 'b');
  const help = "\nTry 'cut --help' for more information.";
  if ((fields === undefined) === (chars === undefined)) {
    return ctx.fail(fields === undefined
      ? `cut: you must specify a list of bytes, characters, or fields${help}`
      : `cut: only one type of list may be specified${help}`);
  }
  const delim = optionValue(opts, 'd') ?? '\t';
  if (delim.length !== 1) return ctx.fail(`cut: the delimiter must be a single character${help}`);
  if (opts.values.has('d') && chars !== undefined) {
    return ctx.fail(`cut: an input delimiter may be specified only when operating on fields${help}`);
  }
  const sel = parseList((fields ?? chars)!);
  if (typeof sel === 'string') return ctx.fail(`cut: ${sel}${help}`);
  const complement = opts.long.has('complement');
  const pick = (n: number) => sel(n) !== complement;

  const { inputs, errors } = readInputs(ctx, opts.operands);
  const out: string[] = [];
  for (const line of inputs.flatMap(i => toLines(i.text))) {
    if (chars !== undefined) {
      out.push([...line].filter((_, i) => pick(i + 1)).join(''));
    } else if (!line.includes(delim)) {
      if (!opts.flags.has('s')) out.push(line);
    } else {
      out.push(line.split(delim).filter((_, i) => pick(i + 1)).join(delim));
    }
  }
  return finish(ctx, out.join('\n'), errors, 1);
}

const TR_CLASSES: Record<string, string> = {
  lower: 'abcdefghijklmnopqrstuvwxyz',
  upper: 'ABCDEFGHIJKLMNOPQRSTUVWXYZ',
  digit: '0123456789',
  space: ' \t\n\r\f\v',
  blank: ' \t',
  punct: '!"#$%&\'()*+,-./:;<=>?@[\\]^_`{|}~',
};
TR_CLASSES.alpha = TR_CLASSES.lower + TR_CLASSES.upper;
TR_CLASSES.alnum = TR_CLASSES.alpha + TR_CLASSES.digit;

/** Expands a tr SET: ranges (a-z), [:classes:], escapes (\n, \t, \\). */
function expandSet(set: string): string {
  let out = '';
  for (let i = 0; i < set.length; i++) {
    const cls = set.slice(i).match(/^\[:(\w+):\]/);
    if (cls && TR_CLASSES[cls[1]] !== undefined) {
      out += TR_CLASSES[cls[1]];
      i += cls[0].length - 1;
      continue;
    }
    let c = set[i];
    if (c === '\\' && i + 1 < set.length) {
      const n = set[++i];
      c = n === 'n' ? '\n' : n === 't' ? '\t' : n === 'r' ? '\r' : n;
    }
    if (set[i + 1] === '-' && i + 2 < set.length) {
      const end = set[i + 2];
      for (let code = c.charCodeAt(0); code <= end.charCodeAt(0); code++) out += String.fromCharCode(code);
      i += 2;
      continue;
    }
    out += c;
  }
  return out;
}

function tr(ctx: LinuxContext): LinuxResult {
  const opts = parseOptions(ctx.args, '', { delete: 'd', 'squeeze-repeats': 's', complement: 'c' });
  const f = opts.flags;
  const sets = opts.operands;
  const help = "\nTry 'tr --help' for more information.";
  const deleting = f.has('d');
  const squeezeOnly = f.has('s') && !deleting && sets.length === 1;
  const maxSets = deleting && !f.has('s') ? 1 : 2;
  if (sets.length === 0) return ctx.fail(`tr: missing operand${help}`);
  if (sets.length > maxSets) {
    // tr never reads files: a file name here is an extra operand
    const extra = deleting && !f.has('s') ? '\nOnly one string may be given when deleting without squeezing repeats.' : '';
    return ctx.fail(`tr: extra operand '${sets[maxSets]}'${extra}${help}`);
  }
  if (!deleting && !squeezeOnly && sets.length < 2) {
    return ctx.fail(`tr: missing operand after '${sets[0]}'\nTwo strings must be given when translating.${help}`);
  }
  const s1 = expandSet(sets[0]);
  const s2 = sets[1] !== undefined ? expandSet(sets[1]) : '';
  const inS1 = (c: string) => s1.includes(c) !== f.has('c');

  let text = ctx.stdin;
  if (deleting) {
    text = [...text].filter(c => !inS1(c) || (c === '\n' && f.has('c'))).join('');
  } else if (!squeezeOnly) {
    text = [...text].map(c => {
      const k = s1.indexOf(c);
      return k < 0 ? c : s2[Math.min(k, s2.length - 1)] ?? c;
    }).join('');
  }
  if (f.has('s')) {
    const squeezeSet = deleting || !squeezeOnly ? (deleting ? s2 : s2) : s1;
    text = text.replace(/(.)\1+/gs, (run, c) => (squeezeSet.includes(c) ? c : run));
  }
  return ctx.ok(text);
}

linuxCommands.registerAll({
  echo, cat, head: headOrTail('head'), tail: headOrTail('tail'),
  grep, egrep: grep, fgrep: grep, awk, gawk: awk, mawk: awk, sed, sort, uniq, wc, cut, tr,
});
