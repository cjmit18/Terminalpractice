import { FileNode } from '../../../types/terminal';
import { removeNode, fileSize, writeFileContent } from '../../filesystem';
import { parseOptions } from '../../textUtils';
import { LinuxContext, LinuxResult, linuxCommands, createInDir } from '../context';
import { deviceNumbers, inode } from './lookup';
import { MAX_PATH_DEPTH, pathDepth } from '../../limits';
import { labNowIso } from '../../labClock';

// Navigation and file management: pwd, cd, ls, mkdir, touch, rm, tee (cat lives with the text filters)

function pwd(ctx: LinuxContext): LinuxResult {
  return ctx.ok(ctx.cwd);
}

function cd(ctx: LinuxContext): LinuxResult {
  const args = ctx.args.filter(a => a !== '-L' && a !== '-P' && a !== '--');
  if (args.length > 1) return ctx.fail('bash: cd: too many arguments');
  const back = args[0] === '-';
  const oldpwd = ctx.state.envVars?.OLDPWD;
  if (back && !oldpwd) return ctx.fail('bash: cd: OLDPWD not set');
  const target = back ? oldpwd! : args[0] || '~';
  const resolved = ctx.resolve(target);
  const node = ctx.node(resolved);
  if (!node) return ctx.fail(`bash: cd: ${target}: No such file or directory`);
  if (node.type !== 'directory') return ctx.fail(`bash: cd: ${target}: Not a directory`);
  if (!ctx.traverse(resolved).ok || !ctx.access(node, resolved, 'x', `To enter ${resolved} you need execute (x) on it, but it`).ok) {
    return ctx.fail(`bash: cd: ${target}: Permission denied`);
  }
  ctx.state.envVars = { ...ctx.state.envVars, OLDPWD: ctx.cwd };
  ctx.cwd = resolved;
  // cd - prints the directory it switched to
  return ctx.ok(back ? resolved : '');
}

/** First column of ls -l: d directory, b/c device, - regular file. */
const typeChar = (n: FileNode) => (n.type === 'directory' ? 'd' : n.device === 'block' ? 'b' : n.device === 'char' ? 'c' : '-');

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** "Oct 19 10:00" as ls -l prints a recent modification time (UTC, the lab machines' zone). */
function lsDate(iso: string): string {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return 'Oct 19 10:00';
  const p2 = (n: number) => String(n).padStart(2, '0');
  return `${MONTHS[d.getUTCMonth()]} ${String(d.getUTCDate()).padStart(2)} ${p2(d.getUTCHours())}:${p2(d.getUTCMinutes())}`;
}

/** ls -h sizes: 512, 4.0K, 1.5M (rounded up, one decimal below 10). */
function humanSize(n: number): string {
  if (n < 1024) return String(n);
  const units = ['K', 'M', 'G', 'T'];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return v < 10 ? `${(Math.ceil(v * 10) / 10).toFixed(1)}${units[i]}` : `${Math.ceil(v)}${units[i]}`;
}

/** Disk usage in 1K blocks, as the "total" line and -s count it. */
const blocksOf = (n: FileNode) => (n.type === 'directory' ? 4 : n.device ? 0 : Math.ceil(fileSize(n) / 4096) * 4);

const linkCount = (n: FileNode) => (n.type === 'directory' ? 2 + Object.values(n.children ?? {}).filter(c => c.type === 'directory').length : 1);

interface LsEntry { name: string; node: FileNode; path: string }

interface LsOptions {
  long: boolean; human: boolean; classify: boolean; inode: boolean; numeric: boolean; one: boolean;
  sortTime: boolean; sortSize: boolean; reverse: boolean;
}

function lsSort(entries: LsEntry[], o: LsOptions): LsEntry[] {
  const sorted = [...entries].sort((a, b) => {
    if (o.sortTime) { const d = Date.parse(b.node.updatedAt) - Date.parse(a.node.updatedAt); if (d) return d; }
    if (o.sortSize) { const d = fileSize(b.node) - fileSize(a.node); if (d) return d; }
    return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
  });
  return o.reverse ? sorted.reverse() : sorted;
}

/** Formats entries the way ls does: names only, or long lines with every column aligned. */
function lsFormat(ctx: LinuxContext, entries: LsEntry[], o: LsOptions): string[] {
  const suffix = (e: LsEntry) => {
    if (!o.classify) return '';
    if (e.node.type === 'directory') return '/';
    return !e.node.device && /x/.test(e.node.permissions.slice(-9)) ? '*' : '';
  };
  const ino = (e: LsEntry) => (o.inode ? `${inode(e.path)} ` : '');
  if (!o.long) {
    const names = entries.map(e => `${ino(e)}${e.name}${suffix(e)}`);
    return o.one ? names : names.length ? [names.join('  ')] : [];
  }
  const ids = (path: string, field: number) => new Map((ctx.node(path)?.content ?? '').split('\n').map(l => l.split(':')).map(r => [r[0], r[field]]));
  const uids = o.numeric ? ids('/etc/passwd', 2) : null;
  const gids = o.numeric ? ids('/etc/group', 2) : null;
  const rows = entries.map(e => {
    const dev = deviceNumbers(e.node);
    return {
      ino: o.inode ? String(inode(e.path)) : '',
      mode: typeChar(e.node) + e.node.permissions.slice(-9),
      links: String(linkCount(e.node)),
      owner: uids?.get(e.node.owner) ?? e.node.owner,
      group: gids?.get(e.node.group) ?? e.node.group,
      major: dev ? `${dev[0]},` : '',
      size: dev ? String(dev[1]) : o.human ? humanSize(fileSize(e.node)) : String(fileSize(e.node)),
      date: lsDate(e.node.updatedAt),
      name: e.name + suffix(e),
    };
  });
  const w = (k: keyof (typeof rows)[number]) => Math.max(0, ...rows.map(r => r[k].length));
  const wIno = w('ino'), wLinks = w('links'), wOwner = w('owner'), wGroup = w('group'), wMajor = w('major');
  // With device files, the size column holds "major, minor"
  const wSize = Math.max(w('size'), wMajor ? wMajor + 1 + Math.max(...rows.map(r => (r.major ? r.size.length : 0))) : 0);
  return rows.map(r => {
    const size = r.major ? `${r.major.padStart(wMajor)} ${r.size.padStart(wSize - wMajor - 1)}` : r.size.padStart(wSize);
    return `${o.inode ? r.ino.padStart(wIno) + ' ' : ''}${r.mode} ${r.links.padStart(wLinks)} ${r.owner.padEnd(wOwner)} ${r.group.padEnd(wGroup)} ${size} ${r.date} ${r.name}`;
  });
}

function ls(ctx: LinuxContext): LinuxResult {
  const opts = parseOptions(ctx.args, '', {
    all: 'a', 'almost-all': 'A', directory: 'd', 'human-readable': 'h', recursive: 'R', classify: 'F', inode: 'i',
    'numeric-uid-gid': 'n', reverse: 'r',
  });
  const f = opts.flags;
  const o: LsOptions = {
    long: f.has('l') || f.has('n') || f.has('g'), human: f.has('h'), classify: f.has('F'), inode: f.has('i'), numeric: f.has('n'),
    // Like GNU ls, one name per line unless stdout is a terminal (or -C / -x ask for columns)
    one: f.has('1') || (!ctx.tty && !f.has('C') && !f.has('x')), sortTime: f.has('t'), sortSize: f.has('S'), reverse: f.has('r'),
  };
  const all = f.has('a');
  const almostAll = f.has('A') && !all;
  const dirSelf = f.has('d');
  const recursive = f.has('R') && !dirSelf;
  const operands = opts.operands.length ? opts.operands : ['.'];
  const errors: string[] = [];
  let code = 0;
  const files: LsEntry[] = [];
  const dirs: LsEntry[] = [];

  for (const op of operands) {
    const path = ctx.resolve(op);
    if (!ctx.traverse(path).ok) { errors.push(`ls: cannot access '${op}': Permission denied`); code = 2; continue; }
    const node = ctx.node(path);
    if (!node) { errors.push(`ls: cannot access '${op}': No such file or directory`); code = 2; continue; }
    (node.type === 'directory' && !dirSelf ? dirs : files).push({ name: op, node, path });
  }

  const blocks: string[] = [];
  if (files.length) blocks.push(lsFormat(ctx, lsSort(files, o), o).join('\n'));
  const showHeaders = operands.length > 1 || recursive;
  const listDir = (e: LsEntry) => {
    // Opening a folder needs search (x) on every folder above it as well as read (r) on it: with -R a folder
    // whose names can be read but not searched lists its names and stops there (#28, 6)
    if (!ctx.traverse(e.path).ok || !ctx.access(e.node, e.path, 'r', `Listing ${e.path} needs read (r) on it, but it`).ok) {
      errors.push(`ls: cannot open directory '${e.name}': Permission denied`);
      code = 2;
      return;
    }
    const children = e.node.children ?? {};
    let entries: LsEntry[] = Object.entries(children)
      .filter(([k]) => all || almostAll || !k.startsWith('.'))
      .map(([k, n]) => ({ name: k, node: n, path: e.path === '/' ? `/${k}` : `${e.path}/${k}` }));
    entries = lsSort(entries, o);
    if (all) {
      const parentPath = e.path === '/' ? '/' : e.path.slice(0, e.path.lastIndexOf('/')) || '/';
      const dots: LsEntry[] = [{ name: '.', node: e.node, path: e.path }, { name: '..', node: ctx.node(parentPath) ?? e.node, path: parentPath }];
      entries = o.reverse ? [...entries, ...dots.reverse()] : [...dots, ...entries];
    }
    const lines = lsFormat(ctx, entries, o);
    if (o.long) {
      const total = entries.reduce((sum, x) => sum + blocksOf(x.node), 0);
      lines.unshift(`total ${o.human ? humanSize(total * 1024) : total}`);
    }
    blocks.push([...(showHeaders ? [`${e.name}:`] : []), ...lines].join('\n'));
    if (recursive) {
      for (const sub of entries) {
        if (sub.name === '.' || sub.name === '..' || sub.node.type !== 'directory') continue;
        listDir({ ...sub, name: e.name === '/' ? `/${sub.name}` : `${e.name}/${sub.name}` });
      }
    }
  };
  for (const d of lsSort(dirs, o)) listDir(d);
  return ctx.result(blocks.join('\n\n'), errors.join('\n'), code);
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
    if (pathDepth(targetPath) > MAX_PATH_DEPTH) return ctx.fail(`mkdir: cannot create directory '${d}': File name too long`);
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
      existing.updatedAt = labNowIso();
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
  // Long forms arrive already expanded (--rec → --recursive) by the option check
  const recursive = args.some(a => /^-[a-zA-Z]*[rR]/.test(a) || a === '--recursive');
  const force = args.some(a => /^-[a-zA-Z]*f/.test(a) || a === '--force');

  if (targets.length === 0) {
    if (force) return ctx.ok();
    return ctx.fail('rm: missing operand');
  }
  // rm -r empties a directory from the bottom up, and each entry is a removal of its own: it needs
  // write and search (x) on the directory holding it, and a directory with entries must be readable
  // to list them. What cannot be removed stays, with every directory above it. -f does not change this.
  const errors: string[] = [];
  const removeTree = (abs: string, label: string, node: FileNode): boolean => {
    const names = node.type === 'directory' ? Object.keys(node.children ?? {}) : [];
    if (names.length) {
      if (!ctx.access(node, abs, 'r').ok || !ctx.access(node, abs, 'x').ok) {
        errors.push(`rm: cannot remove '${label}': Permission denied`);
        return false;
      }
      let emptied = true;
      for (const name of names) {
        if (!removeTree(abs === '/' ? `/${name}` : `${abs}/${name}`, `${label.replace(/\/$/, '')}/${name}`, node.children![name])) emptied = false;
      }
      if (!emptied) return false;
    }
    const check = ctx.canDelete(abs);
    if (!check.ok) {
      errors.push(`rm: cannot remove '${label}': ${check.error || 'Permission denied'}`);
      return false;
    }
    removeNode(ctx.fs, abs, false);
    return true;
  };
  for (const t of targets) {
    const targetPath = ctx.resolve(t);
    const node = ctx.node(targetPath);
    if (!node) {
      if (force) continue;
      return ctx.fail(`rm: cannot remove '${t}': No such file or directory`);
    }
    if (node.type === 'directory' && !recursive) return ctx.fail(`rm: cannot remove '${t}': Is a directory`);
    if (node.type === 'directory') {
      removeTree(targetPath, t, node);
      continue;
    }
    const check = ctx.canDelete(targetPath);
    if (!check.ok) return ctx.fail(`rm: cannot remove '${t}': ${check.error || 'Permission denied'}`);
    removeNode(ctx.fs, targetPath, false);
  }
  return errors.length ? ctx.fail(errors.join('\n')) : ctx.ok();
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
