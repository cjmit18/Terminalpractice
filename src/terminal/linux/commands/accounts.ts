import { removeNode, writeFileContent } from '../../filesystem';
import { parseOptions, optionValue } from '../../textUtils';
import { LinuxContext, LinuxResult, linuxCommands } from '../context';

// Password and account management: passwd, userdel, chage. They edit /etc/passwd,
// /etc/shadow and /etc/group directly (the real programs run as root: passwd is SUID).

/** The lab clock: 2026-10-19, as days since 1970-01-01 (the unit /etc/shadow uses). */
const TODAY = Math.floor(Date.UTC(2026, 9, 19) / 86400000);
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** "Oct 19, 2026" for a shadow day count. */
function chageDate(days: number): string {
  const d = new Date(days * 86400000);
  return `${MONTHS[d.getUTCMonth()]} ${String(d.getUTCDate()).padStart(2, '0')}, ${d.getUTCFullYear()}`;
}
/** "10/19/2026" as passwd -S prints dates. */
function slashDate(days: number): string {
  const d = new Date(days * 86400000);
  return `${String(d.getUTCMonth() + 1).padStart(2, '0')}/${String(d.getUTCDate()).padStart(2, '0')}/${d.getUTCFullYear()}`;
}

type Rows = string[][];
const read = (ctx: LinuxContext, path: string): Rows =>
  (ctx.node(path)?.content ?? '').split('\n').filter(Boolean).map(l => l.split(':'));
function write(ctx: LinuxContext, path: string, rows: Rows): void {
  const node = ctx.node(path);
  if (node) writeFileContent(node, rows.map(r => r.join(':')).join('\n'));
}

/** The shadow row for a user, creating a locked one if the file has none (accounts made outside useradd). */
function shadowRow(rows: Rows, user: string): string[] {
  let row = rows.find(r => r[0] === user);
  if (!row) {
    row = [user, '!', String(TODAY), '0', '99999', '7', '', '', ''];
    rows.push(row);
  }
  while (row.length < 9) row.push('');
  return row;
}

/** A yescrypt-looking hash ($y$ is Ubuntu 22.04's default); only its shape matters here. */
function fakeHash(user: string): string {
  const chars = './0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
  let seed = [...`${user}${Date.now()}`].reduce((n, c) => (n * 31 + c.charCodeAt(0)) >>> 0, 7);
  const pick = (n: number) => Array.from({ length: n }, () => { seed = (seed * 1103515245 + 12345) >>> 0; return chars[seed % 64]; }).join('');
  return `$y$j9T$${pick(22)}$${pick(43)}`;
}

function passwd(ctx: LinuxContext): LinuxResult {
  const opts = parseOptions(ctx.args, 'nxwi', { lock: 'l', unlock: 'u', delete: 'd', expire: 'e', status: 'S', all: 'a' });
  const target = opts.operands[0] ?? ctx.user;
  const self = target === ctx.user;
  const f = opts.flags;
  if (!read(ctx, '/etc/passwd').some(r => r[0] === target)) return ctx.fail(`passwd: user '${target}' does not exist`, 1);
  const admin = f.has('l') || f.has('u') || f.has('d') || f.has('e');
  if (!ctx.isRoot && (!self || admin)) {
    return ctx.fail(`passwd: You may not view or modify password information for ${target}.`, 1,
      ctx.needsRoot(self ? `passwd -${[...f].join('')}` : `Changing another user's password`));
  }
  const shadow = read(ctx, '/etc/shadow');
  const row = shadowRow(shadow, target);
  if (f.has('S')) {
    const state = row[1].startsWith('!') || row[1] === '*' ? 'L' : row[1] === '' ? 'NP' : 'P';
    return ctx.ok(`${target} ${state} ${slashDate(Number(row[2]) || TODAY)} ${row[3] || 0} ${row[4] || 99999} ${row[5] || 7} ${row[6] || -1}`);
  }
  if (f.has('l') || f.has('u') || f.has('d') || f.has('e')) {
    if (f.has('l') && !row[1].startsWith('!')) row[1] = `!${row[1]}`;
    if (f.has('u')) {
      if (row[1] === '!' ) return ctx.fail('passwd: unlocking the password would result in a passwordless account.\nYou should set a password with usermod -p to unlock the password of this account.', 3);
      row[1] = row[1].replace(/^!+/, '');
    }
    if (f.has('d')) row[1] = '';
    if (f.has('e')) row[2] = '0';
    write(ctx, '/etc/shadow', shadow);
    return ctx.ok('passwd: password changed.');
  }
  // The real program asks for the passwords on the terminal; the simulator accepts them as typed
  row[1] = fakeHash(target);
  row[2] = String(TODAY);
  write(ctx, '/etc/shadow', shadow);
  const prompts = self && !ctx.isRoot
    ? [`Changing password for ${target}.`, 'Current password: ', 'New password: ', 'Retype new password: ']
    : ['New password: ', 'Retype new password: '];
  return ctx.ok([...prompts, 'passwd: password updated successfully'].join('\n'));
}

function userdel(ctx: LinuxContext): LinuxResult {
  if (!ctx.isRoot) {
    return ctx.fail('userdel: Permission denied.\nuserdel: cannot lock /etc/passwd; try again later.', 1,
      ctx.needsRoot('userdel edits /etc/passwd, /etc/shadow and /etc/group, which only root may modify, so it'));
  }
  const opts = parseOptions(ctx.args, '', { remove: 'r', force: 'f' });
  const user = opts.operands[0];
  if (!user) return ctx.fail('Usage: userdel [options] LOGIN', 2);
  const passwdRows = read(ctx, '/etc/passwd');
  const entry = passwdRows.find(r => r[0] === user);
  if (!entry) return ctx.fail(`userdel: user '${user}' does not exist`, 6);
  if (!opts.flags.has('f') && (ctx.state.currentUser === user || ctx.state.processes.some(p => p.user === user))) {
    const pid = ctx.state.processes.find(p => p.user === user)?.pid ?? 1;
    return ctx.fail(`userdel: user ${user} is currently used by process ${pid}`, 8);
  }
  write(ctx, '/etc/passwd', passwdRows.filter(r => r[0] !== user));
  write(ctx, '/etc/shadow', read(ctx, '/etc/shadow').filter(r => r[0] !== user));
  const groups = read(ctx, '/etc/group')
    .map(r => { const members = (r[3] ?? '').split(',').filter(m => m && m !== user); return [r[0], r[1], r[2], members.join(',')]; })
    // the user's private group goes too, if nobody else is in it
    .filter(r => !(r[0] === user && r[2] === entry[3] && !r[3]));
  write(ctx, '/etc/group', groups);
  const errors: string[] = [];
  if (opts.flags.has('r')) {
    errors.push(`userdel: ${user} mail spool (/var/mail/${user}) not found`);
    const home = entry[5];
    if (home && ctx.node(home)) removeNode(ctx.fs, home, false);
  }
  return ctx.result('', errors.join('\n'), 0);
}

function chage(ctx: LinuxContext): LinuxResult {
  const opts = parseOptions(ctx.args, 'dEImMW', {
    list: 'l', lastday: 'd', expiredate: 'E', inactive: 'I', mindays: 'm', maxdays: 'M', warndays: 'W',
  });
  const user = opts.operands[0];
  if (!user) return ctx.fail('Usage: chage [options] LOGIN', 2);
  if (!read(ctx, '/etc/passwd').some(r => r[0] === user)) return ctx.fail(`chage: user '${user}' does not exist in /etc/passwd`, 1);
  const listing = opts.flags.has('l');
  const changes = (['d', 'E', 'I', 'm', 'M', 'W'] as const).filter(k => optionValue(opts, k) !== undefined);
  if (!ctx.isRoot && (!listing || user !== ctx.user || changes.length)) {
    return ctx.fail('chage: Permission denied.', 1, ctx.needsRoot(listing ? `Reading another user's password ageing from /etc/shadow` : 'Changing password ageing'));
  }
  const shadow = read(ctx, '/etc/shadow');
  const row = shadowRow(shadow, user);
  if (changes.length) {
    const toDays = (v: string) => (/^-?\d+$/.test(v) ? v : String(Math.floor(Date.parse(`${v}T00:00:00Z`) / 86400000)));
    const index: Record<string, number> = { d: 2, m: 3, M: 4, W: 5, I: 6, E: 7 };
    for (const k of changes) {
      const v = optionValue(opts, k)!;
      const days = k === 'd' || k === 'E' ? toDays(v) : v;
      if (days === 'NaN' || !/^-?\d+$/.test(days)) return ctx.fail(`chage: invalid date '${v}'`, 2);
      row[index[k]] = days === '-1' ? '' : days;
    }
    write(ctx, '/etc/shadow', shadow);
    if (!listing) return ctx.ok();
  }
  if (!listing) return ctx.fail('Usage: chage [options] LOGIN', 2);
  const last = Number(row[2]);
  const max = row[4] === '' ? 99999 : Number(row[4]);
  const inactive = row[6] === '' ? -1 : Number(row[6]);
  const expires = last && max < 99999 ? last + max : null;
  const line = (label: string, value: string) => `${label.padEnd(56)}: ${value}`;
  return ctx.ok([
    line('Last password change', last === 0 ? 'password must be changed' : chageDate(last)),
    line('Password expires', expires === null ? 'never' : chageDate(expires)),
    line('Password inactive', expires === null || inactive < 0 ? 'never' : chageDate(expires + inactive)),
    line('Account expires', row[7] ? chageDate(Number(row[7])) : 'never'),
    line('Minimum number of days between password change', row[3] || '0'),
    line('Maximum number of days between password change', String(max)),
    line('Number of days of warning before password expires', row[5] || '7'),
  ].join('\n'));
}

linuxCommands.registerAll({ passwd, userdel, chage });
