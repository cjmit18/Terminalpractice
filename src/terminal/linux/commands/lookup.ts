import { FileNode } from '../../../types/terminal';
import { fileSize, modeBits } from '../../filesystem';
import { parseOptions, optionValue } from '../../textUtils';
import { LinuxContext, LinuxResult, linuxCommands } from '../context';

// stat and getent: looking up files and the account and host databases.

const CHAR_DEVICES: Record<string, [number, number]> = {
  null: [1, 3], zero: [1, 5], full: [1, 7], random: [1, 8], urandom: [1, 9], tty: [5, 0], console: [5, 1],
};

/** Major and minor numbers of a device node in /dev (sda 8,0, sda1 8,1, sdb 8,16, null 1,3 ...). */
export function deviceNumbers(node: FileNode): [number, number] | null {
  if (!node.device) return null;
  if (node.device === 'char') return CHAR_DEVICES[node.name] ?? [1, 0];
  const m = node.name.match(/^sd([a-z])(\d*)$/);
  if (!m) return [8, 0];
  return [8, (m[1].charCodeAt(0) - 97) * 16 + (m[2] ? Number(m[2]) : 0)];
}

/** A stable fake inode number for a path. */
export function inode(path: string): number {
  let h = 2166136261;
  for (const c of path) h = Math.imul(h ^ c.charCodeAt(0), 16777619) >>> 0;
  return path === '/' ? 2 : 131072 + (h % 3000000);
}

function fileType(node: FileNode): string {
  if (node.type === 'directory') return 'directory';
  if (node.device === 'block') return 'block special file';
  if (node.device === 'char') return 'character special file';
  return fileSize(node) === 0 ? 'regular empty file' : 'regular file';
}

/** Ten-character mode as ls -l prints it. */
function modeString(node: FileNode): string {
  const t = node.type === 'directory' ? 'd' : node.device === 'block' ? 'b' : node.device === 'char' ? 'c' : '-';
  return t + node.permissions.slice(-9);
}

function ids(ctx: LinuxContext) {
  const rows = (path: string) => (ctx.node(path)?.content ?? '').split('\n').filter(Boolean).map(l => l.split(':'));
  const passwd = rows('/etc/passwd');
  const group = rows('/etc/group');
  return {
    uid: (name: string) => passwd.find(r => r[0] === name)?.[2] ?? (name === 'root' ? '0' : '1000'),
    gid: (name: string) => group.find(r => r[0] === name)?.[2] ?? (name === 'root' ? '0' : '1000'),
  };
}

/** "2026-10-19 10:00:00.000000000 +0000" from an ISO timestamp. */
function statTime(iso: string): string {
  const d = new Date(iso);
  const t = isNaN(d.getTime()) ? new Date('2026-10-19T10:00:00Z') : d;
  return `${t.toISOString().replace('T', ' ').replace(/\.(\d{3})Z$/, (_, ms) => `.${ms}000000`)} +0000`;
}

function links(node: FileNode): number {
  if (node.type !== 'directory') return 1;
  return 2 + Object.values(node.children ?? {}).filter(c => c.type === 'directory').length;
}

function stat(ctx: LinuxContext): LinuxResult {
  const opts = parseOptions(ctx.args, 'c', { format: 'c', dereference: 'L', 'file-system': 'f', terse: 't' });
  const format = optionValue(opts, 'c');
  if (opts.operands.length === 0) return ctx.fail("stat: missing operand\nTry 'stat --help' for more information.");
  const db = ids(ctx);
  const out: string[] = [];
  const errors: string[] = [];
  for (const name of opts.operands) {
    const path = ctx.resolve(name);
    if (!ctx.traverse(path).ok) { errors.push(`stat: cannot statx '${name}': Permission denied`); continue; }
    const node = ctx.node(path);
    if (!node) { errors.push(`stat: cannot statx '${name}': No such file or directory`); continue; }
    const mode = modeString(node);
    const octal = (modeBits(node) & 0o7777).toString(8).padStart(4, '0');
    const size = fileSize(node);
    const blocks = node.type === 'directory' ? 8 : Math.ceil(size / 4096) * 8;
    const dev = deviceNumbers(node);
    if (format !== undefined) {
      const fields: Record<string, () => string> = {
        n: () => name, N: () => `'${name}'`, a: () => String(parseInt(octal, 8).toString(8)), A: () => mode,
        U: () => node.owner, G: () => node.group, u: () => db.uid(node.owner), g: () => db.gid(node.group),
        s: () => String(size), F: () => fileType(node), i: () => String(inode(path)), h: () => String(links(node)),
        b: () => String(blocks), B: () => '512', o: () => '4096', y: () => statTime(node.updatedAt), x: () => statTime(node.updatedAt),
        z: () => statTime(node.updatedAt), Y: () => String(Math.floor(new Date(node.updatedAt).getTime() / 1000) || 0),
        t: () => (dev ? dev[0].toString(16) : '0'), T: () => (dev ? dev[1].toString(16) : '0'), '%': () => '%',
      };
      out.push(format.replace(/%(.)/g, (m, c) => (fields[c] ? fields[c]() : m)).replace(/\\n/g, '\n').replace(/\\t/g, '\t'));
      continue;
    }
    const when = statTime(node.updatedAt);
    out.push([
      `  File: ${name}`,
      `  Size: ${String(size).padEnd(10)}\tBlocks: ${String(blocks).padEnd(10)} IO Block: ${'4096'.padEnd(6)} ${fileType(node)}`,
      `Device: ${path.startsWith('/dev/') ? '5h/5d' : '803h/2051d'}\tInode: ${String(inode(path)).padEnd(11)} Links: ${links(node)}${dev ? `     Device type: ${dev[0]},${dev[1]}` : ''}`,
      `Access: (${octal}/${mode})  Uid: (${db.uid(node.owner).padStart(5)}/${node.owner.padStart(8)})   Gid: (${db.gid(node.group).padStart(5)}/${node.group.padStart(8)})`,
      `Access: ${when}`,
      `Modify: ${when}`,
      `Change: ${when}`,
      ' Birth: -',
    ].join('\n'));
  }
  return ctx.result(out.join('\n'), errors.join('\n'), errors.length ? 1 : 0);
}

/** getent DATABASE [KEY...]: passwd, group, shadow, hosts and services, read from /etc. */
function getent(ctx: LinuxContext): LinuxResult {
  const [db, ...keys] = ctx.args.filter(a => !a.startsWith('-'));
  if (!db) return ctx.fail("getent: wrong number of arguments\nTry 'getent --help' or 'getent --usage' for more information.", 1);
  const lines = (path: string) => (ctx.node(path)?.content ?? '').split('\n');
  switch (db) {
    case 'passwd': case 'group': case 'shadow': case 'gshadow': {
      if ((db === 'shadow' || db === 'gshadow') && !ctx.isRoot) return keys.length ? ctx.result('', '', 2) : ctx.ok();
      const rows = lines(`/etc/${db}`).filter(l => l && !l.startsWith('#'));
      if (keys.length === 0) return ctx.ok(rows.join('\n'));
      // A key is a name, or a numeric UID/GID for passwd and group
      const found = keys.map(k => rows.find(r => {
        const f = r.split(':');
        return f[0] === k || (/^\d+$/.test(k) && (db === 'passwd' || db === 'group') && f[2] === k);
      }));
      return ctx.result(found.filter(Boolean).join('\n'), '', found.every(Boolean) ? 0 : 2);
    }
    case 'hosts': case 'ahosts': {
      const entries = lines('/etc/hosts').map(l => l.replace(/#.*/, '').trim()).filter(Boolean).map(l => l.split(/\s+/));
      const fmt = (e: string[]) => `${e[0].padEnd(15)} ${e.slice(1).join(' ')}`;
      if (keys.length === 0) return ctx.ok(entries.map(fmt).join('\n'));
      const found = keys.map(k => entries.find(e => e[0] === k || e.slice(1).includes(k)));
      return ctx.result(found.filter((e): e is string[] => !!e).map(fmt).join('\n'), '', found.every(Boolean) ? 0 : 2);
    }
    case 'services': {
      const rows = lines('/etc/services').filter(l => l && !l.startsWith('#'));
      if (keys.length === 0) return ctx.ok(rows.join('\n'));
      const found = keys.map(k => rows.find(r => r.split(/\s+/)[0] === k || r.split(/\s+/)[1]?.split('/')[0] === k));
      return ctx.result(found.filter(Boolean).join('\n'), '', found.every(Boolean) ? 0 : 2);
    }
    default:
      return ctx.fail(`Unknown database: ${db}\nTry 'getent --help' or 'getent --usage' for more information.`, 1);
  }
}

/** groups [USER...]: the groups a user is in, primary first. */
function groups(ctx: LinuxContext): LinuxResult {
  const users = ctx.args.filter(a => !a.startsWith('-'));
  const rows = (path: string) => (ctx.node(path)?.content ?? '').split('\n').filter(Boolean).map(l => l.split(':'));
  const passwd = rows('/etc/passwd');
  const group = rows('/etc/group');
  if (users.length === 0) return ctx.ok(Array.from(new Set(ctx.groups)).join(' '));
  const out: string[] = [];
  const errors: string[] = [];
  for (const u of users) {
    const entry = passwd.find(r => r[0] === u);
    if (!entry) { errors.push(`groups: '${u}': no such user`); continue; }
    const primary = group.find(r => r[2] === entry[3])?.[0] ?? entry[3];
    const extra = group.filter(r => (r[3] ?? '').split(',').includes(u)).map(r => r[0]);
    out.push(`${u} : ${Array.from(new Set([primary, ...extra])).join(' ')}`);
  }
  return ctx.result(out.join('\n'), errors.join('\n'), errors.length ? 1 : 0);
}

linuxCommands.registerAll({ stat, getent, groups });
