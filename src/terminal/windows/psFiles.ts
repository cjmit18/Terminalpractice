import { FileNode } from '../../types/terminal';
import { fileSize, createNode, removeNode, writeFileContent } from '../filesystem';
import { globToRegex } from '../textUtils';
import { WindowsContext, WindowsResult, psCommands } from './context';
import { bindParams, psError, pathNotFound, accessDenied, badParameter } from './psUtil';

// PowerShell filesystem cmdlets and their aliases:
// Get-ChildItem (ls, dir, gci), Get-Content (cat, type, gc), Get-Location (pwd, gl),
// Set-Location (cd, chdir, sl), New-Item (ni, mkdir, md), Copy-Item (copy, cp, cpi),
// Remove-Item (del, erase, rm, rmdir, rd, ri), Write-Output (echo, write), Clear-Host (cls, clear)

const leaf = (p: string) => p.slice(p.lastIndexOf('\\') + 1);
const parentOf = (p: string) => p.slice(0, p.lastIndexOf('\\')) || 'C:\\';
const join = (dir: string, name: string) => (dir.endsWith('\\') ? dir + name : `${dir}\\${name}`);

const HEADER = ['Mode                 LastWriteTime         Length Name', '----                 -------------         ------ ----'];
function itemRow(n: FileNode, name: string): string {
  const dir = n.type === 'directory';
  return `${dir ? 'd-----' : '-a----'}        10/19/2026   ${dir ? '9:30' : '9:45'} AM ${(dir ? '' : String(fileSize(n))).padStart(14)} ${name}`;
}
function listing(dir: string, rows: string[]): string {
  return ['', `    Directory: ${dir}`, '', '', ...HEADER, ...rows, ''].join('\n');
}

function getChildItem(ctx: WindowsContext): WindowsResult {
  const name = 'Get-ChildItem';
  const p = bindParams(ctx.args, { Path: 'value', Filter: 'value', Recurse: 'switch', Force: 'switch', Name: 'switch', File: 'switch', Directory: 'switch' },
    { LiteralPath: 'Path', s: 'Recurse' });
  if (typeof p === 'string') return ctx.fail(badParameter(ctx.raw, name, p));
  const target = (p.named.get('Path') as string | undefined) ?? p.positional[0] ?? '.';
  const filterArg = (p.named.get('Filter') as string | undefined) ?? p.positional[1];
  const abs = ctx.resolve(target);
  const wildcard = /[*?]/.test(leaf(abs));
  const base = wildcard ? parentOf(abs) : abs;
  const node = ctx.node(base);
  if (!node) return ctx.fail(pathNotFound(ctx.raw, name, abs));
  const why = ctx.protectedReason(base, 'read');
  if (why) return ctx.fail(accessDenied(ctx.raw, name, base), 1, why);
  const pattern = wildcard ? globToRegex(leaf(abs), true) : filterArg ? globToRegex(filterArg, true) : null;
  const keep = (n: FileNode, key: string) =>
    (!pattern || pattern.test(key)) && (!p.named.has('File') || n.type === 'file') && (!p.named.has('Directory') || n.type === 'directory');

  if (node.type === 'file') {
    return ctx.ok(p.named.has('Name') ? node.name : listing(parentOf(abs), [itemRow(node, node.name)]));
  }
  const blocks: string[] = [];
  const names: string[] = [];
  const walk = (dirNode: FileNode, dirPath: string, rel: string) => {
    const entries = Object.entries(dirNode.children ?? {}).sort(([a], [b]) => a.toLowerCase().localeCompare(b.toLowerCase()));
    const rows = entries.filter(([k, n]) => keep(n, k));
    if (rows.length) {
      blocks.push(listing(dirPath, rows.map(([k, n]) => itemRow(n, k))));
      names.push(...rows.map(([k]) => (rel ? `${rel}\\${k}` : k)));
    }
    if (p.named.has('Recurse')) {
      for (const [k, n] of entries) if (n.type === 'directory') walk(n, join(dirPath, k), rel ? `${rel}\\${k}` : k);
    }
  };
  walk(node, base, '');
  return ctx.ok(p.named.has('Name') ? names.join('\n') : blocks.join('\n'));
}

function getContent(ctx: WindowsContext): WindowsResult {
  const name = 'Get-Content';
  const p = bindParams(ctx.args, { Path: 'value', TotalCount: 'value', Tail: 'value', Raw: 'switch', Encoding: 'value' },
    { Head: 'TotalCount', First: 'TotalCount', Last: 'Tail', LiteralPath: 'Path' });
  if (typeof p === 'string') return ctx.fail(badParameter(ctx.raw, name, p));
  const paths = p.named.has('Path') ? (p.named.get('Path') as string).split(',') : p.positional;
  if (paths.length === 0) return ctx.fail(psError(ctx.raw, name, 'Cannot process command because of one or more missing mandatory parameters: Path.', 'InvalidArgument', '', 'ParameterBindingException', 'MissingMandatoryParameter'));
  const out: string[] = [];
  const errors: string[] = [];
  let note: string | undefined;
  for (const raw of paths) {
    const abs = ctx.resolve(raw.trim());
    const node = ctx.node(abs);
    const why = ctx.protectedReason(abs, 'read');
    if (why) { errors.push(accessDenied(ctx.raw, name, abs)); note = why; continue; }
    if (!node) { errors.push(pathNotFound(ctx.raw, name, abs)); continue; }
    if (node.type === 'directory') { errors.push(accessDenied(ctx.raw, name, abs)); continue; }
    let lines = (node.content ?? '').split(/\r?\n/);
    const head = p.named.get('TotalCount');
    const tail = p.named.get('Tail');
    if (typeof head === 'string') lines = lines.slice(0, Math.max(0, parseInt(head, 10)));
    if (typeof tail === 'string') lines = lines.slice(Math.max(0, lines.length - parseInt(tail, 10)));
    out.push(lines.join('\n'));
  }
  return ctx.result(out.join('\n'), errors.join('\n'), errors.length ? 1 : 0, note);
}

function getLocation(ctx: WindowsContext): WindowsResult {
  return ctx.ok(['', 'Path', '----', ctx.cwd, ''].join('\n'));
}

function setLocation(ctx: WindowsContext): WindowsResult {
  const name = 'Set-Location';
  const p = bindParams(ctx.args, { Path: 'value' }, { LiteralPath: 'Path' });
  if (typeof p === 'string') return ctx.fail(badParameter(ctx.raw, name, p));
  const target = (p.named.get('Path') as string | undefined) ?? p.positional.join(' ');
  if (!target) {
    ctx.cwd = `C:\\Users\\${ctx.state.currentUser}`;
    return ctx.ok();
  }
  const abs = ctx.resolve(target === '~' ? `C:\\Users\\${ctx.state.currentUser}` : target);
  const node = ctx.node(abs);
  if (!node) return ctx.fail(pathNotFound(ctx.raw, name, abs));
  if (node.type !== 'directory') {
    return ctx.fail(psError(ctx.raw, name, `Cannot find path '${abs}' because it does not exist.`, 'ObjectNotFound', abs, 'ItemNotFoundException', 'PathNotFound'));
  }
  const why = ctx.protectedReason(abs, 'read');
  if (why) return ctx.fail(accessDenied(ctx.raw, name, abs), 1, why);
  ctx.cwd = abs;
  return ctx.ok();
}

function newItem(ctx: WindowsContext): WindowsResult {
  const name = 'New-Item';
  const p = bindParams(ctx.args, { Path: 'value', Name: 'value', ItemType: 'value', Value: 'value', Force: 'switch' }, { Type: 'ItemType' });
  if (typeof p === 'string') return ctx.fail(badParameter(ctx.raw, name, p));
  const isMkdir = ['mkdir', 'md'].includes(ctx.name.toLowerCase());
  const type = isMkdir ? 'directory' : String(p.named.get('ItemType') ?? 'file').toLowerCase();
  if (type !== 'file' && type !== 'directory') {
    return ctx.fail(psError(ctx.raw, name, `The type is not a known type for the file system. Only "file" and "directory" can be specified.`, 'InvalidArgument', type, 'ArgumentException', 'Argument'));
  }
  const base = (p.named.get('Path') as string | undefined) ?? p.positional[0] ?? '.';
  const leafName = p.named.get('Name') as string | undefined;
  const abs = ctx.resolve(leafName ? join(base, leafName) : base);
  if (ctx.node(abs) && !p.named.has('Force')) {
    return ctx.fail(psError(ctx.raw, name, `An item with the specified name ${abs} already exists.`, 'ResourceExists', abs, 'IOException',
      type === 'directory' ? 'DirectoryExist' : 'NewItemIOError'));
  }
  const why = ctx.protectedReason(abs, 'write');
  if (why) return ctx.fail(accessDenied(ctx.raw, name, abs), 1, why);
  const parts = abs.split('\\').filter(Boolean);
  for (let i = 2; i < parts.length; i++) {
    const dir = parts.slice(0, i).join('\\');
    if (!ctx.node(dir)) {
      if (type === 'file' || !isMkdir) return ctx.fail(psError(ctx.raw, name, `Could not find a part of the path '${abs}'.`, 'WriteError', abs, 'DirectoryNotFoundException', 'NewItemIOError'));
      createNode(ctx.fs, dir, 'directory', '', true, ctx.state.currentUser, 'Users', 755);
    }
  }
  if (!ctx.node(abs)) createNode(ctx.fs, abs, type as 'file' | 'directory', String(p.named.get('Value') ?? ''), true, ctx.state.currentUser, 'Users', type === 'directory' ? 755 : 644);
  return ctx.ok(listing(parentOf(abs), [itemRow(ctx.node(abs)!, leaf(abs))]));
}

function copyItem(ctx: WindowsContext): WindowsResult {
  const name = 'Copy-Item';
  const p = bindParams(ctx.args, { Path: 'value', Destination: 'value', Recurse: 'switch', Force: 'switch' });
  if (typeof p === 'string') return ctx.fail(badParameter(ctx.raw, name, p));
  const src = (p.named.get('Path') as string | undefined) ?? p.positional[0];
  const dest = (p.named.get('Destination') as string | undefined) ?? p.positional[p.named.has('Path') ? 0 : 1] ?? '.';
  if (!src) return ctx.fail(psError(ctx.raw, name, 'Cannot process command because of one or more missing mandatory parameters: Path.', 'InvalidArgument', '', 'ParameterBindingException', 'MissingMandatoryParameter'));
  const srcAbs = ctx.resolve(src);
  const node = ctx.node(srcAbs);
  if (!node) return ctx.fail(pathNotFound(ctx.raw, name, srcAbs));
  let destAbs = ctx.resolve(dest);
  if (ctx.node(destAbs)?.type === 'directory') destAbs = join(destAbs, leaf(srcAbs));
  if (!ctx.node(parentOf(destAbs))) return ctx.fail(psError(ctx.raw, name, `Could not find a part of the path '${destAbs}'.`, 'WriteError', destAbs, 'DirectoryNotFoundException', 'CopyItemIOError'));
  const why = ctx.protectedReason(destAbs, 'write') ?? ctx.protectedReason(srcAbs, 'read');
  if (why) return ctx.fail(accessDenied(ctx.raw, name, destAbs), 1, why);
  const copy = (n: FileNode, to: string, top: boolean) => {
    const existing = ctx.node(to);
    if (n.type === 'file') {
      if (existing) writeFileContent(existing, n.content || '');
      else createNode(ctx.fs, to, 'file', n.content || '', true, ctx.state.currentUser, 'Users', 644);
      return;
    }
    if (!existing) createNode(ctx.fs, to, 'directory', '', true, ctx.state.currentUser, 'Users', 755);
    // Without -Recurse, Copy-Item copies only the empty folder
    if (top && !p.named.has('Recurse')) return;
    for (const [k, child] of Object.entries(n.children ?? {})) copy(child, join(to, k), false);
  };
  copy(node, destAbs, true);
  return ctx.ok();
}

function removeItem(ctx: WindowsContext): WindowsResult {
  const name = 'Remove-Item';
  const p = bindParams(ctx.args, { Path: 'value', Recurse: 'switch', Force: 'switch' });
  if (typeof p === 'string') return ctx.fail(badParameter(ctx.raw, name, p));
  const targets = p.named.has('Path') ? [p.named.get('Path') as string] : p.positional;
  const errors: string[] = [];
  const out: string[] = [];
  let note: string | undefined;
  for (const t of targets) {
    const abs = ctx.resolve(t);
    const wildcard = /[*?]/.test(leaf(abs));
    const dir = ctx.node(parentOf(abs));
    const matches = wildcard
      ? Object.keys(dir?.children ?? {}).filter(k => globToRegex(leaf(abs), true).test(k)).map(k => join(parentOf(abs), k))
      : ctx.node(abs) ? [abs] : [];
    if (matches.length === 0) { errors.push(pathNotFound(ctx.raw, name, abs)); continue; }
    for (const m of matches) {
      const why = ctx.protectedReason(m, 'write');
      if (why) { errors.push(accessDenied(ctx.raw, name, m)); note = why; continue; }
      const n = ctx.node(m)!;
      if (n.type === 'directory' && Object.keys(n.children ?? {}).length && !p.named.has('Recurse')) {
        out.push(`\nConfirm\nThe item at ${m} has children and the Recurse parameter was not specified. If you continue,\nall children will be removed with the item. Are you sure you want to continue?\n[Y] Yes  [A] Yes to All  [N] No  [L] No to All  [S] Suspend  [?] Help (default is "Y"): N`);
        continue;
      }
      removeNode(ctx.fs, m, true);
    }
  }
  return ctx.result(out.join('\n'), errors.join('\n'), errors.length ? 1 : 0, note);
}

psCommands.register(['Get-ChildItem', 'gci', 'ls', 'dir'], getChildItem);
psCommands.register(['Get-Content', 'gc', 'cat', 'type'], getContent);
psCommands.register(['Get-Location', 'gl', 'pwd'], getLocation);
psCommands.register(['Set-Location', 'sl', 'cd', 'chdir'], setLocation);
psCommands.register(['New-Item', 'ni', 'mkdir', 'md'], newItem);
psCommands.register(['Copy-Item', 'copy', 'cp', 'cpi'], copyItem);
psCommands.register(['Remove-Item', 'ri', 'del', 'erase', 'rm', 'rmdir', 'rd'], removeItem);
psCommands.register(['Write-Output', 'echo', 'write'], ctx => ctx.ok(ctx.args.join('\n')));
psCommands.register(['Clear-Host', 'cls', 'clear'], ctx => ctx.ok('\x1b[2J\x1b[0;0H'));
