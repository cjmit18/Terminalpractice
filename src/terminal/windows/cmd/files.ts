import { FileNode } from '../../../types/terminal';
import { fileSize, createNode, removeNode, writeFileContent, getNodeAtPath } from '../../filesystem';
import { globToRegex } from '../../textUtils';
import { WindowsContext, WindowsResult, cmdCommands } from '../context';

// CMD navigation and file commands: cd/chdir, dir, type, more, mkdir/md, copy, del/erase

const ACCESS_DENIED = 'Access is denied.';
const parentOf = (p: string) => p.slice(0, p.lastIndexOf('\\')) || 'C:\\';
const leaf = (p: string) => p.slice(p.lastIndexOf('\\') + 1);
const join = (dir: string, name: string) => (dir.endsWith('\\') ? dir + name : `${dir}\\${name}`);
const switches = (args: string[]) => new Set(args.filter(a => a.startsWith('/')).map(a => a.toLowerCase()));
const operands = (args: string[]) => args.filter(a => !a.startsWith('/'));

/** Expands a path whose last part may hold * or ? into matching file paths. */
function expandWildcard(ctx: WindowsContext, arg: string): { dir: string; matches: string[] } {
  const abs = ctx.resolve(arg);
  if (!/[*?]/.test(leaf(abs))) return { dir: parentOf(abs), matches: ctx.node(abs) ? [abs] : [] };
  const dir = parentOf(abs);
  const re = globToRegex(leaf(abs), true);
  const node = ctx.node(dir);
  const names = Object.keys(node?.children ?? {}).filter(n => node!.children![n].type === 'file' && re.test(n));
  return { dir, matches: names.sort().map(n => join(dir, ctx.node(dir) ? n : n)) };
}

function cd(ctx: WindowsContext): WindowsResult {
  const target = operands(ctx.args).join(' ');
  if (!target) return ctx.ok(ctx.cwd);
  const resolved = ctx.resolve(target);
  const node = ctx.node(resolved);
  if (!node) return ctx.fail('The system cannot find the path specified.');
  if (node.type !== 'directory') return ctx.fail('The directory name is invalid.');
  const why = ctx.protectedReason(resolved, 'read');
  if (why) return ctx.fail(ACCESS_DENIED, 1, why);
  ctx.cwd = resolved;
  return ctx.ok();
}

const stamp = (n: FileNode) => (n.type === 'directory' ? '10/19/2026  09:30 AM    <DIR>         ' : '10/19/2026  09:45 AM');

function dir(ctx: WindowsContext): WindowsResult {
  const sw = switches(ctx.args);
  const target = operands(ctx.args)[0] ?? '.';
  const { dir: base, matches } = expandWildcard(ctx, target);
  const abs = ctx.resolve(target);
  const node = ctx.node(abs);
  const wildcard = /[*?]/.test(leaf(abs));
  if (!node && !(wildcard && matches.length)) return ctx.fail('File Not Found');
  const listDir = node?.type === 'directory' ? abs : base;
  const why = ctx.protectedReason(listDir, 'read');
  if (why) return ctx.fail(ACCESS_DENIED, 1, why);

  let entries: [string, FileNode][];
  if (node?.type === 'directory') entries = Object.entries(node.children ?? {});
  else if (node) entries = [[node.name, node]];
  else entries = matches.map(m => [leaf(m), ctx.node(m)!] as [string, FileNode]);

  if (sw.has('/b')) return ctx.ok(entries.map(([k]) => k).join('\n'));

  const lines = [
    ' Volume in drive C has no label.',
    ' Volume Serial Number is 4C19-A3F2',
    '',
    ` Directory of ${listDir}`,
    '',
  ];
  let fileCount = 0;
  let totalBytes = 0;
  let dirCount = 0;
  if (node?.type === 'directory') {
    lines.push('10/19/2026  09:00 AM    <DIR>          .', '10/19/2026  09:00 AM    <DIR>          ..');
    dirCount = 2;
  }
  for (const [key, child] of entries) {
    if (child.type === 'directory') {
      dirCount++;
      lines.push(`${stamp(child)} ${key}`);
    } else {
      fileCount++;
      const sz = fileSize(child);
      totalBytes += sz;
      lines.push(`${stamp(child)}            ${sz.toLocaleString('en-US').padStart(8, ' ')} ${key}`);
    }
  }
  lines.push(`               ${fileCount} File(s)     ${totalBytes.toLocaleString('en-US')} bytes`);
  lines.push(`               ${dirCount} Dir(s)  120,412,891,136 bytes free`);
  return ctx.ok(lines.join('\n'));
}

function type(ctx: WindowsContext): WindowsResult {
  const files = operands(ctx.args);
  if (files.length === 0) return ctx.fail('The syntax of the command is incorrect.');
  const out: string[] = [];
  const errors: string[] = [];
  let note: string | undefined;
  for (const f of files) {
    const abs = ctx.resolve(f);
    const node = ctx.node(abs);
    const why = ctx.protectedReason(abs, 'read');
    if (why) { errors.push(ACCESS_DENIED); note = why; continue; }
    if (!node) { errors.push('The system cannot find the file specified.'); continue; }
    if (node.type === 'directory') { errors.push(ACCESS_DENIED); continue; }
    out.push(node.content || '');
  }
  return ctx.result(out.join('\n'), errors.join('\n'), errors.length ? 1 : 0, note);
}

function mkdir(ctx: WindowsContext): WindowsResult {
  const dirs = operands(ctx.args);
  if (dirs.length === 0) return ctx.fail('The syntax of the command is incorrect.');
  const errors: string[] = [];
  let note: string | undefined;
  for (const d of dirs) {
    const abs = ctx.resolve(d);
    if (ctx.node(abs)) { errors.push(`A subdirectory or file ${d} already exists.`); continue; }
    const why = ctx.protectedReason(abs, 'write');
    if (why) { errors.push(ACCESS_DENIED); note = why; continue; }
    // With command extensions on (the default), intermediate directories are created too
    const parts = abs.split('\\').filter(Boolean);
    for (let i = 2; i <= parts.length; i++) {
      const p = parts.slice(0, i).join('\\');
      const existing = ctx.node(p);
      if (existing && existing.type !== 'directory') { errors.push('The system cannot find the path specified.'); break; }
      if (!existing) createNode(ctx.fs, p, 'directory', '', true, ctx.state.currentUser, ctx.isAdmin ? 'Administrators' : 'Users', 755);
    }
  }
  return ctx.result('', errors.join('\n'), errors.length ? 1 : 0, note);
}

function copy(ctx: WindowsContext): WindowsResult {
  const [src, destArg] = operands(ctx.args);
  if (!src) return ctx.fail('The syntax of the command is incorrect.');
  const srcAbs = ctx.resolve(src);
  const srcNode = ctx.node(srcAbs);
  // copy DIR copies the files inside it
  const sources = srcNode?.type === 'directory'
    ? Object.keys(srcNode.children ?? {}).filter(n => srcNode.children![n].type === 'file').sort().map(n => join(srcAbs, n))
    : expandWildcard(ctx, src).matches;
  const done = (n: number) => `        ${n} file(s) copied.`;
  if (sources.length === 0) return ctx.result(done(0), 'The system cannot find the file specified.', 1);

  const destAbs = ctx.resolve(destArg ?? '.');
  const destNode = ctx.node(destAbs);
  const intoDir = destNode?.type === 'directory';
  if (!intoDir && !ctx.node(parentOf(destAbs))) return ctx.result(done(0), 'The system cannot find the path specified.', 1);
  const why = ctx.protectedReason(intoDir ? join(destAbs, 'x') : destAbs, 'write') ?? ctx.protectedReason(srcAbs, 'read');
  if (why) return ctx.result(done(0), ACCESS_DENIED, 1, why);

  const listed: string[] = [];
  let content = '';
  for (const s of sources) {
    const node = getNodeAtPath(ctx.fs, s, true)!;
    if (intoDir || sources.length === 1) {
      const target = intoDir ? join(destAbs, leaf(s)) : destAbs;
      if (target.toLowerCase() === s.toLowerCase()) {
        return ctx.result(done(0), 'The file cannot be copied onto itself.', 1);
      }
      const existing = ctx.node(target);
      if (existing) writeFileContent(existing, node.content || '');
      else createNode(ctx.fs, target, 'file', node.content || '', true, ctx.state.currentUser, ctx.isAdmin ? 'Administrators' : 'Users', 644);
    } else {
      // Several sources onto one file name concatenate, as in copy a.txt+b.txt c.txt
      content += (content ? '\r\n' : '') + (node.content || '');
    }
    if (/[*?]/.test(src) || srcNode?.type === 'directory') listed.push(leaf(s));
  }
  if (!intoDir && sources.length > 1) {
    const existing = ctx.node(destAbs);
    if (existing) writeFileContent(existing, content);
    else createNode(ctx.fs, destAbs, 'file', content, true, ctx.state.currentUser, 'Users', 644);
  }
  return ctx.ok([...listed, done(intoDir || sources.length === 1 ? sources.length : 1)].join('\n'));
}

function del(ctx: WindowsContext): WindowsResult {
  const targets = operands(ctx.args);
  if (targets.length === 0) return ctx.fail('The syntax of the command is incorrect.');
  const errors: string[] = [];
  let note: string | undefined;
  for (const t of targets) {
    const abs = ctx.resolve(t);
    const node = ctx.node(abs);
    // del DIR removes the files inside it (CMD would first ask "Are you sure (Y/N)?")
    const files = node?.type === 'directory'
      ? Object.keys(node.children ?? {}).filter(n => node.children![n].type === 'file').map(n => join(abs, n))
      : expandWildcard(ctx, t).matches;
    if (files.length === 0) { errors.push(`Could Not Find ${abs}`); continue; }
    const why = ctx.protectedReason(files[0], 'write');
    if (why) { errors.push(`${files[0]}\n${ACCESS_DENIED}`); note = why; continue; }
    for (const f of files) removeNode(ctx.fs, f, true);
  }
  return ctx.result('', errors.join('\n'), errors.length ? 1 : 0, note);
}

cmdCommands.register(['cd', 'chdir'], cd);
cmdCommands.register(['mkdir', 'md'], mkdir);
cmdCommands.register(['del', 'erase'], del);
cmdCommands.registerAll({ dir, type, copy, more: ctx => ctx.ok(ctx.stdin) });
