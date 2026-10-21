import { FileNode } from '../../../types/terminal';
import { createNode, applyChmod, octalToSymbolic, toOctalField, describeIdentity, writeFileContent } from '../../filesystem';
import { parseOptions, optionValue } from '../../textUtils';
import { LinuxContext, LinuxResult, linuxCommands } from '../context';

// Identity, ownership and permissions: su, exit, whoami, id, chmod, chown, chgrp, umask,
// useradd, usermod, groupadd

function su(ctx: LinuxContext): LinuxResult {
  ctx.state.currentUser = 'root';
  ctx.state.currentGroup = 'root';
  ctx.state.isRootOrAdmin = true;
  return ctx.ok();
}

function exit(ctx: LinuxContext): LinuxResult {
  if (ctx.state.currentUser === 'root' || ctx.state.isRootOrAdmin) {
    ctx.state.currentUser = 'student';
    ctx.state.currentGroup = 'student';
    ctx.state.isRootOrAdmin = false;
    ctx.cwd = '/home/student';
  }
  return ctx.ok('exit');
}

function whoami(ctx: LinuxContext): LinuxResult {
  return ctx.ok(ctx.user);
}

/** Parsed /etc/passwd and /etc/group lookups. */
function accounts(ctx: LinuxContext) {
  const rows = (path: string) => (ctx.node(path)?.content ?? '').split('\n').filter(Boolean).map(l => l.split(':'));
  const passwd = rows('/etc/passwd');
  const group = rows('/etc/group');
  return {
    user: (name: string) => passwd.find(r => r[0] === name),
    group: (name: string) => group.find(r => r[0] === name),
    groupByGid: (gid: string) => group.find(r => r[2] === gid),
    passwd,
    groupRows: group,
  };
}

function id(ctx: LinuxContext): LinuxResult {
  const db = accounts(ctx);
  const name = ctx.args.find(a => !a.startsWith('-')) ?? ctx.user;
  const entry = db.user(name);
  if (!entry && name !== ctx.user) return ctx.fail(`id: '${name}': no such user`);
  const uid = entry?.[2] ?? (name === 'root' ? '0' : '1000');
  const primary = entry ? db.groupByGid(entry[3])?.[0] ?? name : name === ctx.user ? ctx.group : name;
  const groups = name === ctx.user ? ctx.groups : [primary, ...db.groupRows.filter(r => (r[3] ?? '').split(',').includes(name)).map(r => r[0])];
  const gidOf = (g: string) => db.group(g)?.[2] ?? (g === 'student' ? '1000' : '1001');
  const uniq = Array.from(new Set(groups));
  return ctx.ok(`uid=${uid}(${name}) gid=${gidOf(primary)}(${primary}) groups=${uniq.map(g => `${gidOf(g)}(${g})`).join(',')}`);
}

/** Applies fn to the node and, with -R, to everything below it. */
function walkTree(node: FileNode, label: string, recursive: boolean, fn: (n: FileNode, label: string) => void): void {
  fn(node, label);
  if (recursive && node.children) {
    for (const [name, child] of Object.entries(node.children)) walkTree(child, `${label}/${name}`, true, fn);
  }
}

/**
 * Shared by chown and chgrp. Non-root users may only change the group of files they own,
 * and only to a group they belong to; changing the owner is root-only.
 */
function changeOwnership(ctx: LinuxContext, cmd: 'chown' | 'chgrp', owner: string | undefined, group: string | undefined, targets: string[], recursive: boolean): LinuxResult {
  const errors: string[] = [];
  const verb = cmd === 'chown' ? 'changing ownership of' : 'changing group of';
  for (const t of targets) {
    const abs = ctx.resolve(t);
    if (!ctx.traverse(abs).ok) { errors.push(`${cmd}: cannot access '${t}': Permission denied`); continue; }
    const node = ctx.node(abs);
    if (!node) { errors.push(`${cmd}: cannot access '${t}': No such file or directory`); continue; }
    walkTree(node, t, recursive, (n, label) => {
      if (!ctx.isRoot) {
        if (owner !== undefined && owner !== n.owner) {
          errors.push(`${cmd}: ${verb} '${label}': Operation not permitted`);
          ctx.deny(`${describeIdentity(ctx.user, ctx.groups)} Only root can give a file to another owner (otherwise users could dodge disk quotas or plant files on others), so run ${cmd} with sudo.`);
          return;
        }
        if (n.owner !== ctx.user) {
          errors.push(`${cmd}: ${verb} '${label}': Operation not permitted`);
          ctx.deny(`${describeIdentity(ctx.user, ctx.groups)} Only the owner of ${label} (${n.owner}) or root can change its group.`);
          return;
        }
        if (group !== undefined && !ctx.groups.includes(group)) {
          errors.push(`${cmd}: ${verb} '${label}': Operation not permitted`);
          ctx.deny(`${describeIdentity(ctx.user, ctx.groups)} You own ${label}, but a regular user can only give a file to a group they belong to, and you are not in '${group}'.`);
          return;
        }
      }
      if (owner !== undefined) n.owner = owner;
      if (group !== undefined) n.group = group;
    });
  }
  return ctx.result('', errors.join('\n'), errors.length ? 1 : 0);
}

function chown(ctx: LinuxContext): LinuxResult {
  const opts = parseOptions(ctx.args, '', { recursive: 'R', verbose: 'v', changes: 'c', silent: 'f', quiet: 'f' });
  const [spec, ...targets] = opts.operands;
  if (spec === undefined) return ctx.fail("chown: missing operand\nTry 'chown --help' for more information.");
  if (targets.length === 0) return ctx.fail(`chown: missing operand after '${spec}'\nTry 'chown --help' for more information.`);
  const db = accounts(ctx);
  const m = spec.match(/^([^:.]*)(?:[:.](.*))?$/)!;
  let owner: string | undefined = m[1] || undefined;
  let group: string | undefined = m[2] || undefined;
  if (owner !== undefined && !db.user(owner)) return ctx.fail(`chown: invalid user: '${spec}'`);
  // "chown user:" means the user's login group
  if (m[2] === '' && owner) group = db.groupByGid(db.user(owner)![3])?.[0];
  if (group !== undefined && !db.group(group)) return ctx.fail(`chown: invalid group: '${spec}'`);
  if (owner === undefined && group === undefined) owner = undefined;
  return changeOwnership(ctx, 'chown', owner, group, targets, opts.flags.has('R'));
}

function chgrp(ctx: LinuxContext): LinuxResult {
  const opts = parseOptions(ctx.args, '', { recursive: 'R', verbose: 'v', changes: 'c', silent: 'f', quiet: 'f' });
  const [group, ...targets] = opts.operands;
  if (group === undefined) return ctx.fail("chgrp: missing operand\nTry 'chgrp --help' for more information.");
  if (targets.length === 0) return ctx.fail(`chgrp: missing operand after '${group}'\nTry 'chgrp --help' for more information.`);
  if (!accounts(ctx).group(group)) return ctx.fail(`chgrp: invalid group: '${group}'`);
  return changeOwnership(ctx, 'chgrp', undefined, group, targets, opts.flags.has('R'));
}

function chmod(ctx: LinuxContext): LinuxResult {
  const OPTIONS = new Set(['-R', '-v', '-c', '-f', '--recursive', '--verbose']);
  const recursive = ctx.args.includes('-R') || ctx.args.includes('--recursive');
  const rest = ctx.args.filter(a => !OPTIONS.has(a));
  if (rest.length === 0) return ctx.fail('chmod: missing operand');
  const modeArg = rest[0];
  const targetPaths = rest.slice(1);
  if (targetPaths.length === 0) return ctx.fail(`chmod: missing operand after '${modeArg}'`);

  const denied: string[] = [];
  for (const p of targetPaths) {
    const abs = ctx.resolve(p);
    const node = ctx.node(abs);
    if (!ctx.traverse(abs).ok) return ctx.fail(`chmod: cannot access '${p}': Permission denied`);
    if (!node) return ctx.fail(`chmod: cannot access '${p}': No such file or directory`);
    if (!applyChmod(node.permissions, modeArg)) return ctx.fail(`chmod: invalid mode: '${modeArg}'`);

    const applyTree = (n: FileNode, path: string) => {
      if (!ctx.isRoot && ctx.user !== n.owner) {
        denied.push(`chmod: changing permissions of '${path}': Operation not permitted`);
        ctx.deny(`${describeIdentity(ctx.user, ctx.groups)} Only a file's owner or root can change its mode, and ${path} is owned by ${n.owner}; read or write permission on it does not count.`);
        return;
      }
      const result = applyChmod(n.permissions, modeArg)!;
      n.permissions = result.sym;
      n.octal = result.octal;
      if (recursive && n.children) {
        for (const [name, child] of Object.entries(n.children)) applyTree(child, `${path}/${name}`);
      }
    };
    applyTree(node, p);
  }
  return denied.length ? ctx.fail(denied.join('\n')) : ctx.ok();
}

/** u=rwx,g=rx,o=rx style rendering of the permissions a umask still allows. */
function umaskSymbolic(mask: number): string {
  const allowed = 0o777 & ~mask;
  return ['u', 'g', 'o'].map((who, i) => {
    const bits = (allowed >> (6 - 3 * i)) & 7;
    return `${who}=${bits & 4 ? 'r' : ''}${bits & 2 ? 'w' : ''}${bits & 1 ? 'x' : ''}`;
  }).join(',');
}

function umask(ctx: LinuxContext): LinuxResult {
  const symbolic = ctx.args.includes('-S');
  const value = ctx.args.find(a => a !== '-S' && a !== '-p');
  if (value === undefined) {
    return ctx.ok(symbolic ? umaskSymbolic(ctx.state.umask) : ctx.state.umask.toString(8).padStart(4, '0'));
  }
  if (/^[0-7]{1,4}$/.test(value)) {
    ctx.state.umask = parseInt(value, 8) & 0o777;
    return ctx.ok();
  }
  if (/^[0-9]+$/.test(value)) return ctx.fail(`bash: umask: ${value}: octal number out of range`);
  // Symbolic form (u=rwx,g=rx,o=) describes the permissions to keep
  const allowed = applyChmod(octalToSymbolic(toOctalField(0o777 & ~ctx.state.umask)), value);
  if (!allowed) return ctx.fail(`bash: umask: \`${value[0]}': invalid symbolic mode operator`);
  ctx.state.umask = 0o777 & ~parseInt(String(allowed.octal % 1000).padStart(3, '0'), 8);
  return ctx.ok();
}

function useradd(ctx: LinuxContext): LinuxResult {
  if (!ctx.isRoot) return ctx.fail('useradd: Permission denied.\nuseradd: cannot lock /etc/passwd; try again later.', 1, ctx.needsRoot('useradd writes /etc/passwd, /etc/shadow and /etc/group, which only root may modify, so it'));
  const opts = parseOptions(ctx.args, 'sGgdcuk', {
    shell: 's', groups: 'G', gid: 'g', home: 'd', comment: 'c', uid: 'u', 'create-home': 'm', 'no-create-home': 'M', system: 'r',
  });
  const username = opts.operands[0];
  if (!username) return ctx.fail('Usage: useradd [options] LOGIN', 2);
  if (!/^[a-z_][a-z0-9_-]*\$?$/.test(username)) return ctx.fail(`useradd: invalid user name '${username}'`, 3);
  const db = accounts(ctx);
  if (db.user(username)) return ctx.fail(`useradd: user '${username}' already exists`, 9);
  const extraGroups = (optionValue(opts, 'G') ?? '').split(',').filter(Boolean);
  const missing = extraGroups.find(g => !db.group(g));
  if (missing) return ctx.fail(`useradd: group '${missing}' does not exist`, 6);

  const usedUids = db.passwd.map(r => Number(r[2]));
  const usedGids = db.groupRows.map(r => Number(r[2]));
  let uid = Number(optionValue(opts, 'u') ?? NaN);
  if (isNaN(uid)) { uid = 1000; while (usedUids.includes(uid) || usedGids.includes(uid)) uid++; }
  const primaryName = optionValue(opts, 'g');
  let gid: number;
  if (primaryName) {
    const g = db.group(primaryName) ?? db.groupByGid(primaryName);
    if (!g) return ctx.fail(`useradd: group '${primaryName}' does not exist`, 6);
    gid = Number(g[2]);
  } else {
    gid = usedGids.includes(uid) ? Math.max(...usedGids) + 1 : uid;
  }
  const home = optionValue(opts, 'd') ?? `/home/${username}`;
  const shell = optionValue(opts, 's') ?? '/bin/sh';
  const comment = optionValue(opts, 'c') ?? '';

  const append = (path: string, line: string) => {
    const node = ctx.node(path);
    if (node) writeFileContent(node, line, true);
  };
  append('/etc/passwd', `${username}:x:${uid}:${gid}:${comment}:${home}:${shell}`);
  append('/etc/shadow', `${username}:!:20015:0:99999:7:::`);
  const groupFile = ctx.node('/etc/group');
  if (groupFile) {
    let lines = (groupFile.content ?? '').split('\n');
    lines = lines.map(l => {
      const parts = l.split(':');
      if (!extraGroups.includes(parts[0])) return l;
      const members = (parts[3] ?? '').split(',').filter(Boolean);
      parts[3] = [...members, username].join(',');
      return parts.join(':');
    });
    if (!primaryName) lines.push(`${username}:x:${gid}:`);
    writeFileContent(groupFile, lines.join('\n'));
  }
  // Ubuntu's useradd only creates the home directory with -m (CREATE_HOME is off by default)
  if (opts.flags.has('m') && !ctx.node(home)) {
    createNode(ctx.fs, home, 'directory', '', false, username, primaryName ?? username, 750);
  }
  return ctx.ok();
}

function groupadd(ctx: LinuxContext): LinuxResult {
  if (!ctx.isRoot) return ctx.fail('groupadd: Permission denied.\ngroupadd: cannot lock /etc/group; try again later.', 10, ctx.needsRoot('groupadd writes /etc/group, which only root may modify, so it'));
  const opts = parseOptions(ctx.args, 'g', { gid: 'g', system: 'r' });
  const name = opts.operands[0];
  if (!name) return ctx.fail('Usage: groupadd [options] GROUP', 2);
  const db = accounts(ctx);
  if (db.group(name)) return ctx.fail(`groupadd: group '${name}' already exists`, 9);
  const used = db.groupRows.map(r => Number(r[2]));
  let gid = Number(optionValue(opts, 'g') ?? NaN);
  if (isNaN(gid)) { gid = 1000; while (used.includes(gid)) gid++; }
  const groupFile = ctx.node('/etc/group');
  if (groupFile) writeFileContent(groupFile, `${name}:x:${gid}:`, true);
  return ctx.ok();
}

function usermod(ctx: LinuxContext): LinuxResult {
  const { args } = ctx;
  if (!ctx.isRoot) return ctx.fail('usermod: Permission denied.\nusermod: cannot lock /etc/passwd; try again later.', 1, ctx.needsRoot('usermod edits /etc/passwd and /etc/group, which only root may modify, so it'));
  const gi = args.findIndex(a => a === '-aG' || a === '-G');
  const user = args[args.length - 1];
  if (gi === -1 || !args[gi + 1] || user === args[gi + 1]) {
    return ctx.fail('Usage: usermod [-a] -G GROUP[,GROUP] LOGIN', 2);
  }
  const passwd = ctx.node('/etc/passwd')?.content ?? '';
  if (!passwd.split('\n').some(l => l.startsWith(user + ':'))) {
    return ctx.fail(`usermod: user '${user}' does not exist`, 6);
  }
  const append = args[gi] === '-aG' || args.includes('-a');
  const wanted = args[gi + 1].split(',').filter(Boolean);
  const groupFile = ctx.node('/etc/group');
  if (!groupFile) return ctx.fail('usermod: /etc/group not found');
  const lines = (groupFile.content ?? '').split('\n');
  const missing = wanted.find(g => !lines.some(l => l.startsWith(g + ':')));
  if (missing) return ctx.fail(`usermod: group '${missing}' does not exist`, 6);
  groupFile.content = lines.map(line => {
    const parts = line.split(':');
    if (parts.length < 4) return line;
    let members = parts[3] ? parts[3].split(',').filter(Boolean) : [];
    if (wanted.includes(parts[0])) {
      if (!members.includes(user)) members.push(user);
    } else if (!append) {
      members = members.filter(m => m !== user);
    }
    parts[3] = members.join(',');
    return parts.join(':');
  }).join('\n');
  return ctx.ok();
}

linuxCommands.registerAll({ su, exit, whoami, id, chmod, chown, chgrp, umask, useradd, usermod, groupadd });
