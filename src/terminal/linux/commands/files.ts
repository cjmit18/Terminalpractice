import { FileNode } from '../../../types/terminal';
import { removeNode, fileSize, writeFileContent } from '../../filesystem';
import { LinuxContext, LinuxResult, linuxCommands, createInDir } from '../context';

// Navigation and file management: pwd, cd, ls, mkdir, touch, rm, tee (cat lives with the text filters)

function pwd(ctx: LinuxContext): LinuxResult {
  return ctx.ok(ctx.cwd);
}

function cd(ctx: LinuxContext): LinuxResult {
  const target = ctx.args[0] || '~';
  const resolved = ctx.resolve(target);
  const node = ctx.node(resolved);
  if (!node) return ctx.fail(`bash: cd: ${target}: No such file or directory`);
  if (node.type !== 'directory') return ctx.fail(`bash: cd: ${target}: Not a directory`);
  if (!ctx.traverse(resolved).ok || !ctx.access(node, resolved, 'x', `To enter ${resolved} you need execute (x) on it, but it`).ok) {
    return ctx.fail(`bash: cd: ${target}: Permission denied`);
  }
  ctx.cwd = resolved;
  return ctx.ok();
}

/** First column of ls -l: d directory, b/c device, - regular file. */
const typeChar = (n: FileNode) => (n.type === 'directory' ? 'd' : n.device === 'block' ? 'b' : n.device === 'char' ? 'c' : '-');

function ls(ctx: LinuxContext): LinuxResult {
  const { args } = ctx;
  const showAll = args.some(a => a.startsWith('-') && a.includes('a'));
  const showLong = args.some(a => a.startsWith('-') && a.includes('l'));
  const showDirSelf = args.some(a => a.startsWith('-') && a.includes('d'));
  const targetPath = args.find(a => !a.startsWith('-')) || ctx.cwd;
  const resolved = ctx.resolve(targetPath);
  const node = ctx.node(resolved);

  if (!ctx.traverse(resolved).ok) return ctx.fail(`ls: cannot access '${targetPath}': Permission denied`, 2);
  if (!node) {
    return ctx.fail(`ls: cannot access '${targetPath}': No such file or directory`, 2);
  }

  if (node.type === 'directory' && showDirSelf) {
    const bits = node.permissions.length === 10 ? node.permissions.slice(1) : node.permissions;
    return ctx.ok(showLong ? `d${bits} 2 ${node.owner} ${node.group} 4096 Oct 19 10:00 ${targetPath}` : targetPath);
  }

  if (node.type === 'directory' && !ctx.access(node, resolved, 'r', `Listing ${resolved} needs read (r) on it, but it`).ok) {
    return ctx.fail(`ls: cannot open directory '${targetPath}': Permission denied`, 2);
  }

  if (node.type === 'file') {
    if (showLong) {
      const perm = typeChar(node) + node.permissions.replace(/^[d-]/, '');
      return ctx.ok(`${perm} 1 ${node.owner} ${node.group} ${fileSize(node)} Oct 19 10:00 ${node.name}`);
    }
    return ctx.ok(node.name);
  }

  const children = node.children || {};
  let keys = Object.keys(children);
  if (!showAll) {
    keys = keys.filter(k => !k.startsWith('.'));
  } else {
    keys = ['.', '..', ...keys];
  }
  keys.sort();

  if (!showLong) return ctx.ok(keys.join('  '));

  const lines = keys.map(k => {
    if (k === '.' || k === '..') return `drwxr-xr-x 2 root root 4096 Oct 19 10:00 ${k}`;
    const child = children[k];
    const perm = typeChar(child) + child.permissions.replace(/^[d-]/, '');
    const size = fileSize(child).toString().padStart(6, ' ');
    return `${perm} 1 ${child.owner.padEnd(8, ' ')} ${child.group.padEnd(8, ' ')} ${size} Oct 19 10:00 ${child.name}`;
  });
  return ctx.ok(lines.join('\n'));
}

function mkdir(ctx: LinuxContext): LinuxResult {
  const dirs = ctx.args.filter(a => !a.startsWith('-'));
  if (dirs.length === 0) return ctx.fail('mkdir: missing operand');
  const parents = ctx.args.includes('-p');
  for (const d of dirs) {
    const targetPath = ctx.resolve(d);
    if (ctx.node(targetPath)) {
      if (parents) continue;
      return ctx.fail(`mkdir: cannot create directory '${d}': File exists`);
    }
    const parts = targetPath.split('/').filter(Boolean);
    const chain = parents ? parts.map((_, i) => '/' + parts.slice(0, i + 1).join('/')) : [targetPath];
    for (const p of chain) {
      if (ctx.node(p)) continue;
      const check = ctx.canWrite(p);
      if (!check.ok) return ctx.fail(`mkdir: cannot create directory '${d}': ${check.error || 'Permission denied'}`);
      createInDir(ctx.fs, p, 'directory', '', ctx.user, ctx.group, ctx.dirMode());
    }
  }
  return ctx.ok();
}

function touch(ctx: LinuxContext): LinuxResult {
  const files = ctx.args.filter(a => !a.startsWith('-'));
  if (files.length === 0) return ctx.fail('touch: missing file operand');
  for (const f of files) {
    const targetPath = ctx.resolve(f);
    const check = ctx.canWrite(targetPath);
    if (!check.ok) return ctx.fail(`touch: cannot touch '${f}': ${check.error || 'Permission denied'}`);
    const existing = ctx.node(targetPath);
    if (existing) {
      existing.updatedAt = new Date().toISOString();
    } else {
      createInDir(ctx.fs, targetPath, 'file', '', ctx.user, ctx.group, ctx.fileMode());
    }
  }
  return ctx.ok();
}

function rm(ctx: LinuxContext): LinuxResult {
  const end = ctx.args.indexOf('--');
  const args = end === -1 ? ctx.args : ctx.args.slice(0, end);
  // after --, every argument is a file name, even one that starts with -
  const targets = [...args.filter(a => !a.startsWith('-')), ...(end === -1 ? [] : ctx.args.slice(end + 1))];
  const recursive = args.some(a => /^-[a-zA-Z]*[rR]/.test(a));
  const force = args.some(a => /^-[a-zA-Z]*f/.test(a));

  if (targets.length === 0) {
    if (force) return ctx.ok();
    return ctx.fail('rm: missing operand');
  }
  for (const t of targets) {
    const targetPath = ctx.resolve(t);
    const node = ctx.node(targetPath);
    if (!node) {
      if (force) continue;
      return ctx.fail(`rm: cannot remove '${t}': No such file or directory`);
    }
    if (node.type === 'directory' && !recursive) return ctx.fail(`rm: cannot remove '${t}': Is a directory`);
    const check = ctx.canDelete(targetPath);
    if (!check.ok) return ctx.fail(`rm: cannot remove '${t}': ${check.error || 'Permission denied'}`);
    removeNode(ctx.fs, targetPath, false);
  }
  return ctx.ok();
}

function tee(ctx: LinuxContext): LinuxResult {
  const { stdin } = ctx;
  const append = ctx.args.includes('-a');
  const files = ctx.args.filter(a => !a.startsWith('-'));
  for (const f of files) {
    const targetPath = ctx.resolve(f);
    const check = ctx.canWrite(targetPath);
    if (!check.ok) return ctx.result(stdin, `tee: ${f}: ${check.error || 'Permission denied'}`, 1);
    const existing = ctx.node(targetPath);
    if (existing && existing.type === 'file') {
      writeFileContent(existing, stdin, append);
    } else {
      createInDir(ctx.fs, targetPath, 'file', stdin, ctx.user, ctx.group, ctx.fileMode());
    }
  }
  return ctx.ok(stdin);
}

linuxCommands.registerAll({ pwd, cd, ls, mkdir, touch, rm, tee });
