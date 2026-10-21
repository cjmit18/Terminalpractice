import { DocOption, LinuxDoc } from './types';
import { LINUX_DOCS } from './linuxDocs';

// Turns LinuxDoc records into the text man, info, --help, help and whatis print.

const WIDTH = 80;

/** Word-wraps text to `width` columns, prefixing every line with `indent`. */
export function wrap(text: string, width: number, indent = ''): string[] {
  const out: string[] = [];
  let line = '';
  for (const word of text.split(/\s+/).filter(Boolean)) {
    if (line && indent.length + line.length + 1 + word.length > width) {
      out.push(indent + line);
      line = word;
    } else {
      line = line ? `${line} ${word}` : word;
    }
  }
  if (line) out.push(indent + line);
  return out;
}

const SECTION_TITLES: Record<number, string> = { 1: 'User Commands', 5: 'File Formats and Conversions', 8: 'System Administration' };

/** True when `man` has a page for this doc (bash-only builtins have none on Ubuntu). */
export const hasManPage = (d: LinuxDoc): boolean => !d.builtin || !!d.builtin.file;

/** "LS(1)" */
export const pageId = (d: LinuxDoc): string => `${d.name.toUpperCase()}(${d.section})`;

function headerLine(left: string, centre: string, right: string): string {
  const gap = WIDTH - left.length - right.length;
  const leftPad = Math.max(1, Math.floor((gap - centre.length) / 2));
  const rightPad = Math.max(1, gap - centre.length - leftPad);
  return left + ' '.repeat(leftPad) + centre + ' '.repeat(rightPad) + right;
}

function optionBlock(options: DocOption[], indent: string, descIndent: string): string[] {
  return options.flatMap(opt => [indent + opt.flags, ...wrap(opt.desc, WIDTH - 2, descIndent)]);
}

/** Where the full Info manual lives, for pages whose program is documented in Info. */
export const infoRef = (d: LinuxDoc): string | undefined =>
  d.info ? `info '(${d.info.file.replace(/\.info$/, '')}) ${d.info.node}'` : undefined;

/** A whole man page, formatted as man prints it when its output is not a terminal. */
export function renderManPage(d: LinuxDoc): string {
  const id = pageId(d);
  const body = '       ';
  const lines: string[] = [headerLine(id, d.manual ?? SECTION_TITLES[d.section], id), ''];
  const section = (title: string, content: string[]) => { lines.push(title, ...content, ''); };

  section('NAME', wrap(`${[d.name, ...(d.aliases ?? []).filter(a => a !== '.')].join(', ')} - ${d.summary}`, WIDTH, body));
  section('SYNOPSIS', d.synopsis.flatMap(s => wrap(s, WIDTH, body)));
  section('DESCRIPTION', d.description.flatMap((p, i) => [...(i ? [''] : []), ...wrap(p, WIDTH, body)]));
  if (d.options?.length) section('OPTIONS', optionBlock(d.options, body, '              '));
  if (d.exitStatus) section('EXIT STATUS', wrap(d.exitStatus, WIDTH, body));
  if (d.examples?.length) {
    section('EXAMPLES', d.examples.flatMap((e, i) => [...(i ? [''] : []), body + e.cmd, ...wrap(e.desc, WIDTH, '              ')]));
  }
  const ref = infoRef(d);
  if (d.seeAlso?.length || ref) {
    section('SEE ALSO', [
      ...(d.seeAlso?.length ? wrap(d.seeAlso.join(', '), WIDTH, body) : []),
      ...(ref ? [...(d.seeAlso?.length ? [''] : []), `${body}The complete manual is in Info: ${ref}`] : []),
    ]);
  }
  lines.push(headerLine(d.source ?? '', '', id));
  return lines.join('\n');
}

/** GNU-style --help output: usage lines, a lead sentence, then the options table. */
export function renderUsage(d: LinuxDoc, name = d.name): string {
  const syn = d.synopsis.map(s => (s.startsWith(d.name) ? name + s.slice(d.name.length) : s));
  const lines = [`Usage: ${syn[0]}`, ...syn.slice(1).map(s => `  or:  ${s}`), ...wrap(d.description[0], WIDTH)];
  if (d.options?.length) {
    lines.push('');
    for (const opt of d.options) {
      const flags = (opt.flags.startsWith('--') ? '      ' : '  ') + opt.flags;
      const desc = wrap(opt.desc, WIDTH, ' '.repeat(30));
      if (flags.length < 29) lines.push(flags.padEnd(30) + desc[0].trimStart(), ...desc.slice(1));
      else lines.push(flags, ...desc);
    }
  }
  if (d.exitStatus) lines.push('', 'Exit status:', ...wrap(d.exitStatus, WIDTH, '  '));
  const ref = infoRef(d);
  if (ref) lines.push('', `Full manual: ${ref}`);
  return lines.join('\n');
}

/** Short usage of a builtin as `help -s` and the help list print it. */
export function builtinShort(d: LinuxDoc, name = d.name): string {
  const short = d.builtin!.short;
  return short.startsWith(d.name) ? name + short.slice(d.name.length) : short;
}

/** `help NAME` (and NAME --help) for a bash builtin. */
export function renderBuiltinHelp(d: LinuxDoc, name = d.name): string {
  const b = d.builtin!;
  const paragraphs = b.help ?? d.description;
  const options = b.options ?? d.options ?? [];
  const lines = [`${name}: ${builtinShort(d, name)}`];
  paragraphs.forEach((p, i) => { if (i) lines.push('    '); lines.push(...wrap(p, WIDTH, '    ')); });
  if (options.length) {
    lines.push('    ', '    Options:');
    for (const opt of options) {
      const desc = wrap(opt.desc, WIDTH, ' '.repeat(16));
      if (opt.flags.length <= 9) lines.push(`      ${opt.flags.padEnd(10)}${desc[0].trimStart()}`, ...desc.slice(1));
      else lines.push(`      ${opt.flags}`, ...desc);
    }
  }
  if (d.exitStatus) lines.push('    ', '    Exit Status:', ...wrap(d.exitStatus, WIDTH, '    '));
  return lines.join('\n');
}

/** One apropos/whatis line: "ls (1)               - list directory contents". */
export const whatisLine = (name: string, d: LinuxDoc): string => `${`${name} (${d.section})`.padEnd(20)} - ${d.summary}`;

// ---------------------------------------------------------------- Info

function underline(title: string, ch: string): string[] {
  return [title, ch.repeat(title.length)];
}

/** An Info node for a doc that has one. */
export function renderInfoNode(d: LinuxDoc): string {
  const n = d.info!;
  const header = [`File: ${n.file}`, `Node: ${n.node}`, ...(n.next ? [`Next: ${n.next}`] : []), ...(n.prev ? [`Prev: ${n.prev}`] : []), `Up: ${n.up}`].join(',  ');
  const lines = [header, '', ...underline(n.title, '='), ''];
  d.description.forEach(p => lines.push(...wrap(p, 72), ''));
  lines.push(...wrap(`Synopsis: ${d.synopsis.join('; ')}`, 72), '');
  for (const opt of d.options ?? []) {
    lines.push(...opt.flags.split(', ').map(f => `'${f}'`), ...wrap(opt.desc.charAt(0).toUpperCase() + opt.desc.slice(1) + (opt.desc.endsWith('.') ? '' : '.'), 72, '     '), '');
  }
  if (d.examples?.length) {
    lines.push('Examples:', '');
    for (const e of d.examples) lines.push(`     ${e.cmd}`, ...wrap(e.desc, 72, '          '), '');
  }
  if (d.exitStatus) lines.push(...wrap(`Exit status: ${d.exitStatus}`, 72), '');
  while (lines[lines.length - 1] === '') lines.pop();
  return lines.join('\n');
}

/** The man page shown through info when there is no Info manual for it. */
export function renderInfoFromMan(d: LinuxDoc, name: string): string {
  return `File: *manpages*,  Node: ${name},  Up: (dir)\n\n${renderManPage(d)}`;
}

const infoDocs = () => LINUX_DOCS.filter(d => d.info);

/** The coreutils manual's Top node: a menu of the program nodes. */
export function renderCoreutilsTop(): string {
  const lines = ['File: coreutils.info,  Node: Top,  Next: Introduction,  Up: (dir)', '', ...underline('GNU Coreutils', '*'), '',
    ...wrap('This manual documents the GNU core utilities: the basic file, text and shell programs found on every GNU/Linux system. Each program has an "invocation" node with all of its options.', 72), '', '* Menu:', ''];
  for (const d of infoDocs().filter(x => x.info!.file === 'coreutils.info').sort((a, b) => a.name.localeCompare(b.name))) {
    lines.push(`* ${d.info!.node}::`.padEnd(32) + d.info!.title.replace(/^'[^']+': /, ''));
  }
  return lines.join('\n');
}

/** `info` with no arguments: the directory node. */
export function renderInfoDir(): string {
  const lines = [
    'File: dir,\tNode: Top,\tThis is the top of the INFO tree.',
    '',
    ...wrap('This is the directory of Info manuals installed on this system. Choose a manual with info NAME (for example info coreutils or info ls); man pages without an Info manual are shown as well.', 72),
    '',
    '* Menu:',
    '',
    'Basics',
    '* Coreutils: (coreutils).       The GNU file, text and shell utilities.',
    '* Finding files: (find).        Searching for files by name, owner, size ...',
    '',
    'Individual utilities',
  ];
  for (const d of infoDocs().sort((a, b) => a.name.localeCompare(b.name))) {
    const entry = `* ${d.name}: (${d.info!.file.replace(/\.info$/, '')})${d.info!.node}.`;
    lines.push(entry.padEnd(48) + d.info!.title.replace(/^'[^']+': /, ''));
  }
  return lines.join('\n');
}
