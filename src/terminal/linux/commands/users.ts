import { FileNode } from '../../../types/terminal';
import { applyChmod, getSpecialBits, applySpecialBits, octalToSymbolic, toOctalField, describeIdentity, writeFileContent, removeNode } from '../../filesystem';
import { parseOptions, optionValue } from '../../textUtils';
import { LinuxContext, LinuxResult, linuxCommands, createInDir } from '../context';

import { LAB_DAY as LAB_TODAY, MS_PER_DAY } from '../../labClock';

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
  // -u, -g, -G print just that part (numbers, or names with -n)
  const flags = ctx.args.filter(a => /^-[ugGnr]+$/.test(a)).join('').replace(/-/g, '');
  const bad = ctx.args.find(a => a.startsWith('-') && !/^-[ugGnr]+$/.test(a));
  if (bad) return ctx.fail(`id: invalid option -- '${bad.replace(/^-+/, '')[0] ?? '-'}'\nTry 'id --help' for more information.`);
  const which = ['u', 'g', 'G'].filter(f => flags.includes(f));
  if (which.length > 1) return ctx.fail('id: cannot print "only" of more than one choice');
  if (flags.includes('n') && !which.length) return ctx.fail('id: cannot print only names or real IDs in default format');
  if (which.length) {
    const names = flags.includes('n');
    if (which[0] === 'u') return ctx.ok(names ? name : uid);
    if (which[0] === 'g') return ctx.ok(names ? primary : gidOf(primary));
    return ctx.ok(uniq.map(g => (names ? g : gidOf(g))).join(' '));
  }
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
  let modeArg = rest[0];
  const targetPaths = rest.slice(1);
  // GNU chmod: a numeric mode never clears a directory's setuid/setgid bits unless written
  // with an extra leading zero (00755); `chmod 755 dir` keeps drwxr-sr-x
  const numeric = /^[0-7]{1,5}$/.test(modeArg);
  const clearsDirSpecial = numeric && /^00[0-7]{3}$/.test(modeArg);
  if (numeric) {
    if (modeArg.length === 5 && !clearsDirSpecial) return ctx.fail(`chmod: invalid mode: '${modeArg}'`);
    modeArg = modeArg.slice(-4).padStart(3, '0');
  }
  if (targetPaths.length === 0) return ctx.fail(`chmod: missing operand after '${modeArg}'`);

  // X means x, but only for directories and files that already have x for someone
  const forNode = (n: FileNode) => modeArg.replace(/X/g, n.type === 'directory' || /x|s|t/.test(n.permissions.slice(-9)) ? 'x' : '');
  const denied: string[] = [];
  for (const p of targetPaths) {
    const abs = ctx.resolve(p);
    const node = ctx.node(abs);
    if (!ctx.traverse(abs).ok) return ctx.fail(`chmod: cannot access '${p}': Permission denied`);
    if (!node) return ctx.fail(`chmod: cannot access '${p}': No such file or directory`);
    if (!applyChmod(node.permissions, forNode(node))) return ctx.fail(`chmod: invalid mode: '${modeArg}'`);

    const applyTree = (n: FileNode, path: string) => {
      if (!ctx.isRoot && ctx.user !== n.owner) {
        denied.push(`chmod: changing permissions of '${path}': Operation not permitted`);
        ctx.deny(`${describeIdentity(ctx.user, ctx.groups)} Only a file's owner or root can change its mode, and ${path} is owned by ${n.owner}; read or write permission on it does not count.`);
        return;
      }
      const result = applyChmod(n.permissions, forNode(n))!;
      let { sym, octal } = result;
      if (numeric && !clearsDirSpecial && n.type === 'directory') {
        const kept = getSpecialBits(n.permissions.slice(-9)) & 6;
        const special = Math.floor(octal / 1000) | kept;
        sym = applySpecialBits(octalToSymbolic(octal % 1000), special);
        octal = special * 1000 + (octal % 1000);
      }
      n.permissions = sym;
      n.octal = octal;
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
  // Anything that starts with a digit is read as octal (0o27, 8 and 9a are all out of range)
  if (/^[0-9]/.test(value)) return ctx.fail(`bash: umask: ${value}: octal number out of range`);
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
  append('/etc/shadow', `${username}:!:${LAB_TODAY}:0:99999:7:::`);
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
    const group = primaryName ? db.group(primaryName)?.[0] ?? db.groupByGid(primaryName)?.[0] ?? primaryName : username;
    // HOME_MODE 0750 in /etc/login.defs
    createInDir(ctx.fs, home, 'directory', '', username, group, 750);
    // ...then the skeleton files, owned by the new user (-k picks another skeleton directory)
    const skelPath = optionValue(opts, 'k') ?? '/etc/skel';
    const skel = ctx.node(ctx.resolve(skelPath));
    const copyInto = (src: FileNode, dest: string) => {
      for (const [name, child] of Object.entries(src.children ?? {})) {
        const path = `${dest}/${name}`;
        createInDir(ctx.fs, path, child.type, child.content ?? '', username, group, child.octal);
        if (child.type === 'directory') copyInto(child, path);
      }
    };
    if (skel?.type === 'directory') copyInto(skel, home);
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

const USERMOD_USAGE = `Usage: usermod [options] LOGIN

Options:
  -a, --append                  append the user to the supplemental GROUPS
                                mentioned by the -G option without removing
                                the user from other groups
  -c, --comment COMMENT         new value of the GECOS field
  -d, --home HOME_DIR           new home directory for the user account
  -e, --expiredate EXPIRE_DATE  set account expiration date to EXPIRE_DATE
  -g, --gid GROUP               force use GROUP as new primary group
  -G, --groups GROUPS           new list of supplementary GROUPS
  -l, --login NEW_LOGIN         new value of the login name
  -L, --lock                    lock the user account
  -m, --move-home               move contents of the home directory to the
                                new location (use only with -d)
  -s, --shell SHELL             new login shell for the user account
  -u, --uid UID                 new UID for the user account
  -U, --unlock                  unlock the user account`;

function usermod(ctx: LinuxContext): LinuxResult {
  if (!ctx.isRoot) return ctx.fail('usermod: Permission denied.\nusermod: cannot lock /etc/passwd; try again later.', 1, ctx.needsRoot('usermod edits /etc/passwd, /etc/shadow and /etc/group, which only root may modify, so it'));
  const opts = parseOptions(ctx.args, 'cdegGlsu', {
    append: 'a', comment: 'c', home: 'd', expiredate: 'e', gid: 'g', groups: 'G', login: 'l', lock: 'L',
    'move-home': 'm', shell: 's', uid: 'u', unlock: 'U',
  });
  const f = opts.flags;
  const user = opts.operands[0];
  const valueKeys = ['c', 'd', 'e', 'g', 'G', 'l', 's', 'u'].filter(k => optionValue(opts, k) !== undefined);
  const known = new Set(['a', 'L', 'm', 'U']);
  const unknown = [...f].find(k => !known.has(k) && k.length === 1);
  if (unknown) return ctx.fail(`usermod: invalid option -- '${unknown}'\n${USERMOD_USAGE}`, 2);
  if (!user || opts.operands.length > 1) return ctx.fail(USERMOD_USAGE, 2);
  if (!valueKeys.length && !f.has('L') && !f.has('U')) return ctx.fail(USERMOD_USAGE, 2);
  if (f.has('a') && optionValue(opts, 'G') === undefined) return ctx.fail(`usermod: -a flag is ONLY allowed with the -G flag\n${USERMOD_USAGE}`, 2);
  if (f.has('m') && optionValue(opts, 'd') === undefined) return ctx.fail(`usermod: -m flag is ONLY allowed with the -d flag\n${USERMOD_USAGE}`, 2);
  if (f.has('L') && f.has('U')) return ctx.fail(`usermod: the -L and -U flags are exclusive\n${USERMOD_USAGE}`, 2);

  const db = accounts(ctx);
  const entry = db.user(user);
  if (!entry) return ctx.fail(`usermod: user '${user}' does not exist`, 6);
  const row = [...entry];
  while (row.length < 7) row.push('');

  const newLogin = optionValue(opts, 'l');
  if (newLogin !== undefined && newLogin !== user) {
    if (!/^[a-z_][a-z0-9_-]*\$?$/.test(newLogin)) return ctx.fail(`usermod: invalid user name '${newLogin}'`, 3);
    if (db.user(newLogin)) return ctx.fail(`usermod: user '${newLogin}' already exists`, 9);
  }
  const primary = optionValue(opts, 'g');
  let primaryGid: string | undefined;
  if (primary !== undefined) {
    const g = db.group(primary) ?? db.groupByGid(primary);
    if (!g) return ctx.fail(`usermod: group '${primary}' does not exist`, 6);
    primaryGid = g[2];
  }
  const wanted = optionValue(opts, 'G')?.split(',').filter(Boolean);
  const missing = wanted?.find(g => !db.group(g));
  if (missing) return ctx.fail(`usermod: group '${missing}' does not exist`, 6);
  const uid = optionValue(opts, 'u');
  if (uid !== undefined) {
    if (!/^\d+$/.test(uid)) return ctx.fail(`usermod: invalid user ID '${uid}'`, 3);
    if (db.passwd.some(r => r[2] === uid && r[0] !== user)) return ctx.fail(`usermod: UID '${uid}' already exists`, 4);
  }
  const expire = optionValue(opts, 'e');
  let expireDays: string | undefined;
  if (expire !== undefined) {
    if (expire === '' || expire === '-1') expireDays = '';
    else if (/^\d+$/.test(expire)) expireDays = expire;
    else {
      const t = Date.parse(`${expire}T00:00:00Z`);
      if (isNaN(t)) return ctx.fail(`usermod: invalid date '${expire}'`, 3);
      expireDays = String(Math.floor(t / MS_PER_DAY));
    }
  }

  // Home directory move (-d NEW -m) happens before the files are rewritten
  const newHome = optionValue(opts, 'd');
  if (newHome !== undefined && f.has('m') && newHome !== row[5]) {
    const oldNode = ctx.node(row[5]);
    if (ctx.node(newHome)) return ctx.fail(`usermod: directory ${newHome} exists`, 12);
    if (oldNode) {
      const parentPath = newHome.slice(0, newHome.lastIndexOf('/')) || '/';
      const parent = ctx.node(parentPath);
      if (!parent || parent.type !== 'directory') return ctx.fail(`usermod: cannot rename directory ${row[5]} to ${newHome}`, 12);
      const name = newHome.slice(newHome.lastIndexOf('/') + 1);
      removeNode(ctx.fs, row[5], false);
      parent.children = { ...(parent.children ?? {}), [name]: { ...oldNode, name } };
    }
  }

  const login = newLogin ?? user;
  if (newLogin !== undefined) row[0] = newLogin;
  if (uid !== undefined) row[2] = uid;
  if (primaryGid !== undefined) row[3] = primaryGid;
  const comment = optionValue(opts, 'c');
  if (comment !== undefined) row[4] = comment;
  if (newHome !== undefined) row[5] = newHome;
  const shell = optionValue(opts, 's');
  if (shell !== undefined) row[6] = shell;
  const rewrite = (path: string, fn: (fields: string[]) => string[]) => {
    const node = ctx.node(path);
    if (!node) return;
    writeFileContent(node, (node.content ?? '').split('\n').map(l => (l ? fn(l.split(':')).join(':') : l)).join('\n'));
  };
  rewrite('/etc/passwd', r => (r[0] === user ? row : r));
  // Files belong to the UID, so after a rename (same UID) ls shows the new name everywhere
  if (login !== user && uid === undefined) walkTree(ctx.fs, '/', true, n => { if (n.owner === user) n.owner = login; });

  // /etc/shadow: rename, lock (! before the hash), unlock, expiry date
  const shadowNode = ctx.node('/etc/shadow');
  if (shadowNode && !(shadowNode.content ?? '').split('\n').some(l => l.startsWith(`${user}:`))) {
    writeFileContent(shadowNode, `${user}:!:${LAB_TODAY}:0:99999:7:::`, true);
  }
  rewrite('/etc/shadow', r => {
    if (r[0] !== user) return r;
    const s = [...r];
    while (s.length < 9) s.push('');
    s[0] = login;
    if (f.has('L') && !s[1].startsWith('!')) s[1] = `!${s[1]}`;
    if (f.has('U')) s[1] = s[1].replace(/^!/, '');
    if (expireDays !== undefined) s[7] = expireDays;
    return s;
  });

  // /etc/group: supplementary groups (-G replaces the list, -aG adds) and the rename
  rewrite('/etc/group', r => {
    if (r.length < 4) return r;
    let members = r[3] ? r[3].split(',').filter(Boolean) : [];
    if (wanted) {
      if (wanted.includes(r[0])) { if (!members.includes(user)) members.push(user); }
      else if (!f.has('a')) members = members.filter(m => m !== user);
    }
    if (login !== user) members = members.map(m => (m === user ? login : m));
    return [r[0], r[1], r[2], members.join(','), ...r.slice(4)];
  });
  return ctx.ok();
}

linuxCommands.registerAll({ su, exit, whoami, id, chmod, chown, chgrp, umask, useradd, usermod, groupadd });
