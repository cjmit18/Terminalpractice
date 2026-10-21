import { LINUX_DOCS, linuxCommandDoc, linuxDocsFor, linuxNames } from '../../docs';
import { LinuxDoc } from '../../docs/types';
import {
  builtinShort, hasManPage, renderBuiltinHelp, renderCoreutilsTop, renderInfoDir, renderInfoFromMan, renderInfoNode,
  renderManPage, renderUsage, whatisLine,
} from '../../docs/linuxRender';
import { LinuxContext, LinuxResult, linuxCommands } from '../context';

// Getting help (LPIC-1 103.1): man, info, apropos, whatis, --help, and the bash builtins
// help and type, plus which and whereis, all answering from src/terminal/docs.

const BASH_KEYWORDS = new Set(['if', 'then', 'else', 'elif', 'fi', 'case', 'esac', 'for', 'select', 'while', 'until', 'do', 'done', 'in', 'function', 'time', '{', '}', '!', '[[', ']]']);
const NOT_FOUND = 16;

/** Programs outside the registry that the engine still runs. */
const EXTRA_PROGRAMS = new Set(['sudo']);

/** True when NAME runs a shell builtin rather than a program. */
export function isBuiltin(name: string): boolean {
  return !!linuxCommandDoc(name)?.builtin && linuxCommands.has(name);
}

/** Path of the program NAME on disk, or null (bash-only builtins, unknown names). */
export function programPath(name: string): string | null {
  if (!linuxCommands.has(name) && !EXTRA_PROGRAMS.has(name)) return null;
  const doc = linuxCommandDoc(name);
  if (doc?.builtin && !doc.builtin.file) return null;
  return `${doc?.sbin ? '/usr/sbin' : '/usr/bin'}/${name}`;
}

/** Every place $PATH holds NAME: /usr/bin and /bin are the same directory on a merged-/usr system. */
const allPaths = (path: string) => [path, path.replace(/^\/usr/, '')];

const manPath = (d: LinuxDoc, name: string) => `/usr/share/man/man${d.section}/${name}.${d.section}.gz`;

// ---------------------------------------------------------------- --help in the dispatcher

/**
 * What a command prints for --help (or -h where the real tool takes it), or null when the
 * command should run normally. Only arguments before `--` count, as with getopt.
 */
export function helpOptionOutput(name: string, args: string[]): { stdout: string; stderr: string; exitCode: number } | null {
  const end = args.indexOf('--');
  const opts = end === -1 ? args : args.slice(0, end);
  const doc = linuxCommandDoc(name);
  if (!doc) return null;
  const wantsHelp = opts.includes('--help') || (!!doc.dashH && opts.includes('-h'));
  if (!wantsHelp || doc.noHelpOption) {
    if (wantsHelp && (name === 'sh' || name === 'dash')) return { stdout: '', stderr: `${name}: 0: Illegal option --`, exitCode: 2 };
    return null;
  }
  return { stdout: doc.builtin ? renderBuiltinHelp(doc, name) : renderUsage(doc, name), stderr: '', exitCode: 0 };
}

// ---------------------------------------------------------------- man, apropos, whatis

/** Docs with a man page, one entry per name they answer to. */
function manIndex(): { name: string; doc: LinuxDoc }[] {
  return LINUX_DOCS.filter(hasManPage).flatMap(doc => linuxNames(doc).filter(n => n !== '.').map(name => ({ name, doc })));
}

function parseSections(value: string | undefined): number[] | null {
  return value ? value.split(/[:,]/).map(Number).filter(n => !isNaN(n)) : null;
}

function apropos(ctx: LinuxContext, keywords: string[], sections: number[] | null, exact = false, all = false): LinuxResult {
  if (keywords.length === 0) return ctx.fail('apropos what?', 1);
  const tests = keywords.map(k => {
    if (exact) return (name: string, d: LinuxDoc) => name.toLowerCase() === k.toLowerCase() || new RegExp(`\\b${k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i').test(d.summary);
    let re: RegExp;
    try { re = new RegExp(k, 'i'); } catch { re = new RegExp(k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i'); }
    return (name: string, d: LinuxDoc) => re.test(name) || re.test(d.summary);
  });
  const hits = manIndex()
    .filter(({ doc }) => !sections || sections.includes(doc.section))
    .filter(({ name, doc }) => (all ? tests.every(t => t(name, doc)) : tests.some(t => t(name, doc))))
    .sort((a, b) => a.name.localeCompare(b.name) || a.doc.section - b.doc.section);
  if (hits.length === 0) return ctx.fail(keywords.map(k => `${k}: nothing appropriate.`).join('\n'), NOT_FOUND);
  return ctx.ok(hits.map(h => whatisLine(h.name, h.doc)).join('\n'));
}

function whatis(ctx: LinuxContext, names: string[], sections: number[] | null): LinuxResult {
  if (names.length === 0) return ctx.fail('whatis what?', 1);
  const out: string[] = [];
  const errors: string[] = [];
  for (const n of names) {
    const hits = manIndex().filter(h => h.name.toLowerCase() === n.toLowerCase() && (!sections || sections.includes(h.doc.section)))
      .sort((a, b) => a.doc.section - b.doc.section);
    if (hits.length) out.push(...hits.map(h => whatisLine(h.name, h.doc)));
    else errors.push(`${n}: nothing appropriate.`);
  }
  return ctx.result(out.join('\n'), errors.join('\n'), errors.length ? NOT_FOUND : 0);
}

/** Options that take a value, for apropos/whatis/man. */
function splitArgs(args: string[], withValue: string[]): { flags: Set<string>; values: Map<string, string>; operands: string[] } {
  const flags = new Set<string>();
  const values = new Map<string, string>();
  const operands: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--') { operands.push(...args.slice(i + 1)); break; }
    const long = a.match(/^--([\w-]+)(?:=(.*))?$/);
    if (long) {
      if (long[2] !== undefined) values.set(long[1], long[2]);
      else if (withValue.includes(long[1])) values.set(long[1], args[++i] ?? '');
      else flags.add(long[1]);
      continue;
    }
    if (/^-[A-Za-z?]+$/.test(a)) {
      for (let j = 1; j < a.length; j++) {
        const c = a[j];
        if (withValue.includes(c)) { values.set(c, a.slice(j + 1) || args[++i] || ''); break; }
        flags.add(c);
      }
      continue;
    }
    operands.push(a);
  }
  return { flags, values, operands };
}

function aproposCmd(ctx: LinuxContext): LinuxResult {
  const o = splitArgs(ctx.args, ['s', 'sections']);
  return apropos(ctx, o.operands, parseSections(o.values.get('s') ?? o.values.get('sections')),
    o.flags.has('e') || o.flags.has('exact'), o.flags.has('a') || o.flags.has('and'));
}

function whatisCmd(ctx: LinuxContext): LinuxResult {
  const o = splitArgs(ctx.args, ['s', 'sections']);
  return whatis(ctx, o.operands, parseSections(o.values.get('s') ?? o.values.get('sections')));
}

function man(ctx: LinuxContext): LinuxResult {
  const o = splitArgs(ctx.args, ['s', 'S', 'sections']);
  let sections = parseSections(o.values.get('s') ?? o.values.get('S') ?? o.values.get('sections'));
  if (o.flags.has('k') || o.flags.has('apropos')) return apropos(ctx, o.operands, sections);
  if (o.flags.has('f') || o.flags.has('whatis')) return whatis(ctx, o.operands, sections);

  let pages = o.operands;
  if (pages.length > 1 && /^[1-9]$/.test(pages[0])) {
    sections = [Number(pages[0])];
    pages = pages.slice(1);
  }
  if (pages.length === 0) {
    return ctx.fail(sections ? `No manual entry for section ${sections.join(',')}\nWhat manual page do you want from section ${sections.join(',')}?` : "What manual page do you want?\nFor example, try 'man man'.", 1);
  }
  const all = o.flags.has('a') || o.flags.has('all');
  const where = o.flags.has('w') || o.flags.has('where') || o.flags.has('path') || o.flags.has('location');
  const out: string[] = [];
  const errors: string[] = [];
  const notes: string[] = [];
  for (const page of pages) {
    const found = linuxDocsFor(page).filter(d => hasManPage(d) && (!sections || sections.includes(d.section)));
    if (found.length === 0) {
      errors.push(`No manual entry for ${page}${sections ? ` in section ${sections.join(',')}` : ''}`);
      const doc = linuxCommandDoc(page);
      if (doc?.builtin && !sections) notes.push(`${page} is built into bash, so it has no manual page of its own. Run help ${page} to read its documentation.`);
      continue;
    }
    for (const d of all ? found : found.slice(0, 1)) out.push(where ? manPath(d, page) : renderManPage(d));
  }
  return ctx.result(out.join(where ? '\n' : '\n\n'), errors.join('\n'), errors.length ? NOT_FOUND : 0, notes.join('\n') || undefined);
}

// ---------------------------------------------------------------- info

function info(ctx: LinuxContext): LinuxResult {
  const o = splitArgs(ctx.args, ['f', 'file', 'n', 'node', 'k', 'apropos', 'o', 'output']);
  const keyword = o.values.get('k') ?? o.values.get('apropos');
  if (keyword !== undefined) {
    const hits = LINUX_DOCS.filter(d => d.info && (d.name.includes(keyword) || d.summary.includes(keyword) || d.info.title.includes(keyword)));
    if (!hits.length) return ctx.fail(`info: No available info files have '${keyword}' in their indices`, 1);
    return ctx.ok(hits.map(d => `"(${d.info!.file.replace(/\.info$/, '')})${d.info!.node}" -- ${d.name}`).join('\n'));
  }
  const topic = o.values.get('f') ?? o.values.get('file') ?? o.operands[0];
  if (!topic || topic === 'dir') return ctx.ok(renderInfoDir());
  if (topic === 'coreutils') return ctx.ok(renderCoreutilsTop());
  const docs = linuxDocsFor(topic);
  const withNode = docs.find(d => d.info);
  if (withNode) return ctx.ok(renderInfoNode(withNode));
  const withMan = docs.find(hasManPage);
  if (withMan) return ctx.ok(renderInfoFromMan(withMan, topic));
  return ctx.fail(`info: No menu item '${topic}' in node '(dir)Top'`, 1);
}

// ---------------------------------------------------------------- help, type, which, whereis

const builtinDocs = () => LINUX_DOCS.filter(d => d.builtin && linuxNames(d).some(n => linuxCommands.has(n)));

function help(ctx: LinuxContext): LinuxResult {
  const o = splitArgs(ctx.args, []);
  if (o.operands.length === 0) {
    const entries = builtinDocs().flatMap(d => linuxNames(d).map(n => builtinShort(d, n))).sort((a, b) => a.localeCompare(b));
    const half = Math.ceil(entries.length / 2);
    const cell = (s: string) => (s.length > 39 ? `${s.slice(0, 38)}>` : s.padEnd(39));
    const rows = entries.slice(0, half).map((e, i) => ` ${cell(e)} ${entries[half + i] ? cell(entries[half + i]).trimEnd() : ''}`.trimEnd());
    return ctx.ok([
      'GNU bash, version 5.1.16(1)-release (x86_64-pc-linux-gnu)',
      "These commands are built into the shell.  Type `help' to see this list.",
      "Type `help name' for details about the builtin `name'.",
      "For programs that are not builtins, use `man -k' or `info'.",
      '',
      ...rows,
    ].join('\n'));
  }
  const out: string[] = [];
  const errors: string[] = [];
  for (const pattern of o.operands) {
    const re = /[*?[]/.test(pattern)
      ? new RegExp(`^${pattern.replace(/[.+^${}()|\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.')}$`)
      : null;
    const matches = builtinDocs().flatMap(d => linuxNames(d).map(n => ({ n, d })))
      .filter(({ n }) => (re ? re.test(n) : n.startsWith(pattern)))
      .sort((a, b) => a.n.localeCompare(b.n));
    if (matches.length === 0) {
      errors.push(`bash: help: no help topics match \`${pattern}'.  Try \`help help' or \`man -k ${pattern}' or \`info ${pattern}'.`);
      continue;
    }
    for (const { n, d } of matches) {
      if (o.flags.has('d')) out.push(`${n} - ${(d.builtin!.help ?? d.description)[0]}`);
      else if (o.flags.has('s')) out.push(`${n}: ${builtinShort(d, n)}`);
      else out.push(renderBuiltinHelp(d, n));
    }
  }
  return ctx.result(out.join('\n'), errors.join('\n'), errors.length ? 1 : 0);
}

function type(ctx: LinuxContext): LinuxResult {
  const o = splitArgs(ctx.args, []);
  const f = o.flags;
  const out: string[] = [];
  const errors: string[] = [];
  let missing = false;
  for (const name of o.operands) {
    const keyword = BASH_KEYWORDS.has(name);
    const builtin = isBuiltin(name);
    const path = programPath(name) ?? (name.includes('/') && ctx.node(ctx.resolve(name))?.type === 'file' ? name : null);
    const kinds: { word: string; text: string; path?: string }[] = [];
    if (keyword) kinds.push({ word: 'keyword', text: `${name} is a shell keyword` });
    if (builtin) kinds.push({ word: 'builtin', text: `${name} is a shell builtin` });
    if (path) for (const p of name.includes('/') ? [path] : allPaths(path)) kinds.push({ word: 'file', text: `${name} is ${p}`, path: p });

    if (kinds.length === 0) {
      missing = true;
      if (!f.has('t') && !f.has('p') && !f.has('P')) errors.push(`bash: type: ${name}: not found`);
      continue;
    }
    if (f.has('P')) {
      if (path) out.push(path); else missing = true;
      continue;
    }
    const shown = f.has('a') ? kinds : [kinds[0]];
    for (const k of shown) {
      if (f.has('t')) out.push(k.word);
      else if (f.has('p')) { if (k.path) out.push(k.path); }
      else out.push(k.text);
    }
  }
  if (o.operands.length === 0) return ctx.ok();
  return ctx.result(out.join('\n'), errors.join('\n'), missing ? 1 : 0);
}

function which(ctx: LinuxContext): LinuxResult {
  const o = splitArgs(ctx.args, []);
  const out: string[] = [];
  let missing = false;
  for (const name of o.operands) {
    const path = programPath(name);
    if (!path) { missing = true; continue; }
    out.push(...(o.flags.has('a') ? allPaths(path) : [path]));
  }
  return ctx.result(o.flags.has('s') ? '' : out.join('\n'), '', missing || o.operands.length === 0 ? 1 : 0);
}

function whereis(ctx: LinuxContext): LinuxResult {
  const o = splitArgs(ctx.args, []);
  const onlyBin = o.flags.has('b');
  const onlyMan = o.flags.has('m');
  const lines = o.operands.map(arg => {
    const name = arg.slice(arg.lastIndexOf('/') + 1);
    const found: string[] = [];
    if (!onlyMan && !o.flags.has('s')) {
      const path = programPath(name);
      if (path) found.push(path);
      const etc = ctx.node(`/etc/${name}`);
      if (etc) found.push(`/etc/${name}`);
    }
    if (!onlyBin && !o.flags.has('s')) {
      found.push(...linuxDocsFor(name).filter(hasManPage).sort((a, b) => a.section - b.section).map(d => manPath(d, name)));
    }
    return `${name}:${found.map(p => ` ${p}`).join('')}`;
  });
  return ctx.ok(lines.join('\n'));
}

linuxCommands.registerAll({ man, apropos: aproposCmd, whatis: whatisCmd, info, help, type, which, whereis });
