import { FileNode } from '../../../types/terminal';
import { createNode, applyChmod } from '../../filesystem';
import { LinuxContext, LinuxResult, linuxCommands } from '../context';

// Identity, ownership and permissions: su, exit, whoami, id, chmod, chown, umask, useradd, usermod

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

function id(ctx: LinuxContext): LinuxResult {
  const u = ctx.user;
  if (u === 'root') return ctx.ok('uid=0(root) gid=0(root) groups=0(root)');
  const groupStr = ctx.groups.map(g => {
    if (g === 'student') return '1000(student)';
    if (g === 'sudo') return '27(sudo)';
    if (g === 'finance') return '1002(finance)';
    if (g === 'adm') return '4(adm)';
    if (g === 'developers') return '1003(developers)';
    if (g === 'nginx') return '1001(nginx)';
    return `1001(${g})`;
  }).join(',');
  return ctx.ok(`uid=1000(${u}) gid=1000(${u}) groups=${groupStr}`);
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
    const node = ctx.node(ctx.resolve(p));
    if (!node) return ctx.fail(`chmod: cannot access '${p}': No such file or directory`);
    if (!applyChmod(node.permissions, modeArg)) return ctx.fail(`chmod: invalid mode: '${modeArg}'`);

    const applyTree = (n: FileNode, path: string) => {
      if (!ctx.isRoot && ctx.user !== n.owner) {
        denied.push(`chmod: changing permissions of '${path}': Operation not permitted`);
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

function chown(ctx: LinuxContext): LinuxResult {
  const { args } = ctx;
  if (args.length < 2) return ctx.fail('chown: missing operand');
  if (!ctx.isRoot) return ctx.fail(`chown: changing ownership of '${args[1]}': Operation not permitted`);
  const [newOwner, newGroup] = args[0].split(':');
  for (const p of args.slice(1)) {
    const node = ctx.node(ctx.resolve(p));
    if (!node) return ctx.fail(`chown: cannot access '${p}': No such file or directory`);
    if (newOwner) node.owner = newOwner;
    if (newGroup) node.group = newGroup;
  }
  return ctx.ok();
}

function umask(ctx: LinuxContext): LinuxResult {
  if (ctx.args.length === 0) return ctx.ok(ctx.state.umask.toString().padStart(4, '0'));
  const val = parseInt(ctx.args[0], 8);
  if (!isNaN(val)) ctx.state.umask = val;
  return ctx.ok();
}

function useradd(ctx: LinuxContext): LinuxResult {
  if (!ctx.isRoot) return ctx.fail('useradd: Permission denied.');
  const username = ctx.args[ctx.args.length - 1];
  if (!username || username.startsWith('-')) return ctx.fail('useradd: missing username');
  const passwdNode = ctx.node('/etc/passwd');
  if (passwdNode) {
    passwdNode.content = (passwdNode.content || '') + `\n${username}:x:1005:1005:${username}:/home/${username}:/bin/bash`;
  }
  createNode(ctx.fs, `/home/${username}`, 'directory', '', false, username, username, 755);
  return ctx.ok();
}

function usermod(ctx: LinuxContext): LinuxResult {
  const { args } = ctx;
  if (!ctx.isRoot) return ctx.fail('usermod: Permission denied.');
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

linuxCommands.registerAll({ su, exit, whoami, id, chmod, chown, umask, useradd, usermod });
