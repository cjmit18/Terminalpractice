import { FileNode } from '../../../types/terminal';
import { fileSize, removeNode, describeIdentity } from '../../filesystem';
import { parseOptions, optionValue, toLines, padNum } from '../../textUtils';
import { LinuxContext, LinuxResult, linuxCommands } from '../context';
import { readInputs } from '../input';
import { runChildLine } from '../scripts';
import { blockDevices, MODULES, KERNEL_RELEASE } from '../virtualFs';
import { labNow } from '../../labClock';

// Smaller utilities the lessons use: rmdir, du, who, uptime, pgrep/pkill, nice/renice, xargs, nl,
// mount, swapon, blkid, lsusb, modinfo, timedatectl.

/** Quotes a word so a child shell sees it literally. */
const quote = (s: string) => (/^[\w@%+=:,./-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`);

function rmdir(ctx: LinuxContext): LinuxResult {
  const opts = parseOptions(ctx.args, '', { parents: 'p', verbose: 'v', 'ignore-fail-on-non-empty': 'I' });
  if (opts.operands.length === 0) return ctx.fail("rmdir: missing operand\nTry 'rmdir --help' for more information.");
  const errors: string[] = [];
  const remove = (label: string, path: string): boolean => {
    const node = ctx.node(path);
    if (!ctx.traverse(path).ok) { errors.push(`rmdir: failed to remove '${label}': Permission denied`); return false; }
    if (!node) { errors.push(`rmdir: failed to remove '${label}': No such file or directory`); return false; }
    if (node.type !== 'directory') { errors.push(`rmdir: failed to remove '${label}': Not a directory`); return false; }
    if (Object.keys(node.children ?? {}).length) {
      if (!opts.long.has('ignore-fail-on-non-empty')) errors.push(`rmdir: failed to remove '${label}': Directory not empty`);
      return false;
    }
    const check = ctx.canDelete(path);
    if (!check.ok) { errors.push(`rmdir: failed to remove '${label}': ${check.error || 'Permission denied'}`); return false; }
    removeNode(ctx.fs, path, false);
    return true;
  };
  for (const d of opts.operands) {
    if (!remove(d, ctx.resolve(d)) || !opts.flags.has('p')) continue;
    // -p: then each parent named in the operand (a/b/c, then a/b, then a)
    let label = d.replace(/\/+$/, '');
    while (label.includes('/')) {
      label = label.slice(0, label.lastIndexOf('/'));
      if (!label || !remove(label, ctx.resolve(label))) break;
    }
  }
  return ctx.result('', errors.join('\n'), errors.length ? 1 : 0);
}

/** Disk usage of a node in 1K blocks (4K per started block, like ext4). */
function usage(n: FileNode): number {
  if (n.type !== 'directory') return n.device ? 0 : Math.ceil(fileSize(n) / 4096) * 4;
  return 4 + Object.values(n.children ?? {}).reduce((s, c) => s + usage(c), 0);
}

function du(ctx: LinuxContext): LinuxResult {
  const opts = parseOptions(ctx.args, 'd', { summarize: 's', 'human-readable': 'h', all: 'a', total: 'c', 'max-depth': 'd' });
  const f = opts.flags;
  const maxDepth = f.has('s') ? 0 : optionValue(opts, 'd') !== undefined ? Number(optionValue(opts, 'd')) : Infinity;
  const fmt = (k: number) => {
    if (!f.has('h')) return String(k);
    if (k < 1024) return k === 0 ? '0' : k < 10 ? `${k.toFixed(1)}K` : `${k}K`;
    const v = k / 1024;
    return v < 10 ? `${(Math.ceil(v * 10) / 10).toFixed(1)}M` : v < 1024 ? `${Math.ceil(v)}M` : `${(Math.ceil(v / 102.4) / 10).toFixed(1)}G`;
  };
  const out: string[] = [];
  const errors: string[] = [];
  let total = 0;
  const walk = (n: FileNode, abs: string, label: string, depth: number): number => {
    if (n.type !== 'directory') {
      const k = usage(n);
      if (f.has('a') && depth <= maxDepth) out.push(`${fmt(k)}\t${label}`);
      return k;
    }
    let k = 4;
    const readable = ctx.access(n, abs, 'r').ok && ctx.access(n, abs, 'x').ok;
    if (!readable) errors.push(`du: cannot read directory '${label}': Permission denied`);
    else {
      for (const name of Object.keys(n.children ?? {}).sort()) {
        k += walk(n.children![name], abs === '/' ? `/${name}` : `${abs}/${name}`, label.endsWith('/') ? label + name : `${label}/${name}`, depth + 1);
      }
    }
    if (depth <= maxDepth) out.push(`${fmt(k)}\t${label}`);
    return k;
  };
  for (const op of opts.operands.length ? opts.operands : ['.']) {
    const abs = ctx.resolve(op);
    const node = ctx.node(abs);
    if (!node || !ctx.traverse(abs).ok) { errors.push(`du: cannot access '${op}': ${node ? 'Permission denied' : 'No such file or directory'}`); continue; }
    if (node.type !== 'directory') { const k = usage(node); total += k; out.push(`${fmt(k)}\t${op}`); continue; }
    total += walk(node, abs, op, 0);
  }
  if (f.has('c')) out.push(`${fmt(total)}\ttotal`);
  return ctx.result(out.join('\n'), errors.join('\n'), errors.length ? 1 : 0);
}

function who(ctx: LinuxContext): LinuxResult {
  const user = ctx.state.currentUser === 'root' ? 'student' : ctx.state.currentUser;
  if (ctx.args.includes('-b')) return ctx.ok('         system boot  2026-10-19 08:00');
  if (ctx.args.includes('-q')) return ctx.ok(`${user}\n# users=1`);
  const line = `${user.padEnd(8)} pts/0        2026-10-19 10:00 (192.168.1.100)`;
  return ctx.ok(ctx.args.includes('-H') ? `NAME     LINE         TIME             COMMENT\n${line}` : line);
}

function uptime(ctx: LinuxContext): LinuxResult {
  if (ctx.args.includes('-p')) return ctx.ok('up 2 hours, 25 minutes');
  if (ctx.args.includes('-s')) return ctx.ok('2026-10-19 08:00:00');
  return ctx.ok(' 10:25:00 up  2:25,  1 user,  load average: 0.08, 0.03, 0.01');
}

const procName = (cmd: string) => cmd.split(' ')[0].split('/').pop() ?? cmd;

/** pgrep and pkill share process selection: PATTERN (an extended regex) against the name, or with -f the whole command line. */
function selectProcesses(ctx: LinuxContext, cmd: 'pgrep' | 'pkill') {
  const args = [...ctx.args];
  let signal: string | undefined;
  if (cmd === 'pkill' && /^-[A-Z0-9]+$/.test(args[0] ?? '') && !/^-[lfaxnoc]$/.test(args[0])) signal = args.shift()!.slice(1);
  const opts = parseOptions(args, 'uUgs', { full: 'f', exact: 'x', list: 'l', 'list-full': 'a', count: 'c', newest: 'n', oldest: 'o' });
  const pattern = opts.operands[0];
  if (pattern === undefined) return { error: `${cmd}: no matching criteria specified\nTry \`${cmd} --help' for more information.` };
  let re: RegExp;
  try { re = new RegExp(opts.flags.has('x') ? `^(?:${pattern})$` : pattern); } catch { return { error: `${cmd}: invalid regular expression` }; }
  const users = optionValue(opts, 'u')?.split(',');
  const procs = ctx.state.processes.filter(p =>
    re.test(opts.flags.has('f') ? p.command : procName(p.command)) && (!users || users.includes(p.user)));
  return { procs, opts, signal };
}

function pgrep(ctx: LinuxContext): LinuxResult {
  const sel = selectProcesses(ctx, 'pgrep');
  if ('error' in sel) return ctx.fail(sel.error!, 2);
  const { procs, opts } = sel;
  if (opts.flags.has('c')) return ctx.result(String(procs.length), '', procs.length ? 0 : 1);
  const lines = procs.map(p => (opts.flags.has('a') ? `${p.pid} ${p.command}` : opts.flags.has('l') ? `${p.pid} ${procName(p.command)}` : String(p.pid)));
  return ctx.result(lines.join('\n'), '', procs.length ? 0 : 1);
}

function pkill(ctx: LinuxContext): LinuxResult {
  const sel = selectProcesses(ctx, 'pkill');
  if ('error' in sel) return ctx.fail(sel.error!, 2);
  const errors: string[] = [];
  let killed = 0;
  for (const p of sel.procs) {
    if (!ctx.isRoot && p.user !== ctx.user) {
      errors.push(`pkill: killing pid ${p.pid} failed: Operation not permitted`);
      ctx.deny(`${describeIdentity(ctx.user, ctx.groups)} Process ${p.pid} belongs to '${p.user}', and only its owner or root may send it signals; use sudo pkill.`);
      continue;
    }
    ctx.state.processes = ctx.state.processes.filter(x => x.pid !== p.pid);
    killed++;
  }
  return ctx.result('', errors.join('\n'), killed ? 0 : errors.length ? 3 : 1);
}

function nice(ctx: LinuxContext): LinuxResult {
  const args = [...ctx.args];
  let n = 10;
  if (args[0] === '-n') { n = Number(args[1]); args.splice(0, 2); }
  else if (/^-n-?\d+$/.test(args[0] ?? '')) { n = Number(args.shift()!.slice(2)); }
  else if (/^--?\d+$/.test(args[0] ?? '')) { n = Number(args.shift()!.replace(/^-/, '')); }
  if (isNaN(n)) return ctx.fail(`nice: invalid adjustment '${ctx.args[1]}'`, 125);
  if (args.length === 0) return ctx.ok('0');
  const warn = n < 0 && !ctx.isRoot ? 'nice: cannot set niceness: Permission denied' : '';
  const res = runChildLine(ctx, args.map(quote).join(' '));
  return ctx.result(res.stdout, [warn, res.stderr].filter(Boolean).join('\n'), res.exitCode, res.explanation);
}

function renice(ctx: LinuxContext): LinuxResult {
  const args = ctx.args.filter(a => a !== '-p');
  const nArg = args[0] === '-n' ? args[1] : args[0];
  const pids = (args[0] === '-n' ? args.slice(2) : args.slice(1));
  const n = Number(nArg);
  if (nArg === undefined || isNaN(n) || pids.length === 0) return ctx.fail(' renice [-n] <priority> [-p|--pid] <pid>...', 1);
  const out: string[] = [];
  const errors: string[] = [];
  for (const id of pids) {
    const p = ctx.state.processes.find(x => String(x.pid) === id);
    if (!p) { errors.push(`renice: failed to get priority for ${id} (process ID): No such process`); continue; }
    if (!ctx.isRoot && (p.user !== ctx.user || n < 0)) {
      errors.push(`renice: failed to set priority for ${id} (process ID): Permission denied`);
      continue;
    }
    out.push(`${id} (process ID) old priority 0, new priority ${n}`);
  }
  return ctx.result(out.join('\n'), errors.join('\n'), errors.length ? 1 : 0);
}

function xargs(ctx: LinuxContext): LinuxResult {
  // xargs options come before the command; everything from the command on belongs to it
  let i = 0;
  let replace: string | undefined;
  let per = 0;
  while (i < ctx.args.length && ctx.args[i].startsWith('-')) {
    const a = ctx.args[i];
    if (a === '-I' || a === '-n' || a === '-L' || a === '-d') {
      const v = ctx.args[i + 1];
      if (v === undefined) return ctx.fail(`xargs: option requires an argument -- '${a[1]}'`, 1);
      if (a === '-I') replace = v; else if (a !== '-d') per = Number(v);
      i += 2;
    } else if (/^-[nL]\d+$/.test(a)) { per = Number(a.slice(2)); i++; }
    else if (a.startsWith('-I')) { replace = a.slice(2); i++; }
    else i++;
  }
  const cmd = i < ctx.args.length ? ctx.args.slice(i) : ['echo'];
  const items = replace !== undefined ? toLines(ctx.stdin).filter(Boolean) : ctx.stdin.split(/\s+/).filter(Boolean);
  if (items.length === 0 && replace === undefined && cmd[0] !== 'echo') return ctx.ok();
  const batches: string[][] = replace !== undefined ? items.map(i => [i]) : per > 0
    ? Array.from({ length: Math.ceil(items.length / per) }, (_, i) => items.slice(i * per, i * per + per))
    : [items];
  const out: string[] = [];
  const errors: string[] = [];
  let code = 0;
  for (const batch of batches) {
    const line = replace !== undefined
      ? cmd.map(c => quote(c.split(replace).join(batch[0]))).join(' ')
      : [...cmd, ...batch].map(quote).join(' ');
    const res = runChildLine(ctx, line);
    if (res.stdout) out.push(res.stdout);
    if (res.stderr) errors.push(res.stderr);
    if (res.exitCode !== 0) code = res.exitCode === 127 ? 127 : 123;
  }
  return ctx.result(out.join('\n'), errors.join('\n'), code);
}

function nl(ctx: LinuxContext): LinuxResult {
  const opts = parseOptions(ctx.args, 'bsw', { 'body-numbering': 'b' });
  const all = optionValue(opts, 'b') === 'a';
  const { inputs, errors } = readInputs(ctx, opts.operands, (f, r) => `nl: ${f}: ${r}`);
  let n = 0;
  const lines = inputs.flatMap(i => toLines(i.text)).map(l => (l === '' && !all ? '' : `${padNum(++n, 6)}\t${l}`));
  return ctx.result(lines.join('\n'), errors.join('\n'), errors.length ? 1 : 0);
}

const UUIDS: Record<string, string> = {
  '/': '8d6a8f1e-3a9b-4c22-b5e1-8f432176b912', '/boot': '4a7b9c1d-2e3f-4a5b-6c7d-8e9f0a1b2c3d', swap: '12345678-90ab-cdef-1234-567890abcdef',
};

function mount(ctx: LinuxContext): LinuxResult {
  const opts = parseOptions(ctx.args, 'tTo', { types: 't', all: 'a' });
  if (opts.flags.has('a') || opts.operands.length) {
    if (!ctx.isRoot) return ctx.fail(`mount: ${opts.operands[opts.operands.length - 1] ?? '/'}: must be superuser to use mount.`, 1, ctx.needsRoot('Mounting a file system'));
    if (opts.flags.has('a')) return ctx.ok(); // everything in /etc/fstab is already mounted
    return ctx.fail('mount: mounting new file systems is not simulated here; the lab disks are already mounted (see mount or findmnt).', 32);
  }
  const type = optionValue(opts, 't');
  const rows = (ctx.node('/proc/mounts')?.content ?? '').split('\n').filter(Boolean).map(l => l.split(' '))
    .filter(r => !type || type.split(',').includes(r[2]));
  return ctx.ok(rows.map(r => `${r[0]} on ${r[1]} type ${r[2]} (${r[3]})`).join('\n'));
}

function swapon(ctx: LinuxContext): LinuxResult {
  const swaps = blockDevices(ctx.state).flatMap(d => d.parts.filter(p => p.fsType === 'swap'));
  if (ctx.args.includes('--show')) {
    if (!swaps.length) return ctx.ok();
    return ctx.ok(['NAME      TYPE      SIZE USED PRIO', ...swaps.map(p => `/dev/${p.name} partition ${`${Math.round(p.sizeMB / 1024)}G`.padStart(4)}   0B   -2`)].join('\n'));
  }
  if (ctx.args.includes('-s') || ctx.args.includes('--summary')) return ctx.ok(ctx.node('/proc/swaps')?.content ?? '');
  if (!ctx.isRoot) return ctx.fail('swapon: cannot open /dev/sda2: Permission denied', 1, ctx.needsRoot('swapon'));
  const dev = ctx.args.find(a => !a.startsWith('-'));
  if (dev && swaps.some(p => `/dev/${p.name}` === dev)) return ctx.fail(`swapon: ${dev}: swapon failed: Device or resource busy`, 255);
  return ctx.ok();
}

/** Unique partition GUIDs of /dev/sda1..3 (GPT PARTUUIDs, lower case as blkid prints them). */
const PART_GUIDS = ['2f8a6c41-9d3e-4b57-a1c0-6e5d4b3a2f19', '7b1e9f02-3c4d-4e8a-b6f1-0a9c8d7e6f53', 'c4d2a7e8-15b9-4f60-8e3a-d1f0b2c3a4e7'];

function blkid(ctx: LinuxContext): LinuxResult {
  const rows = blockDevices(ctx.state).flatMap(d => d.parts.map(p => {
    const key = p.fsType === 'swap' ? 'swap' : p.mount ?? '';
    const uuid = UUIDS[key] ?? `0000${p.minor}-0000-4000-8000-00000000000${p.minor}`;
    // The disk is GPT, so each partition has its own GUID (an MBR disk would show DISKID-NN)
    const partuuid = PART_GUIDS[p.minor - 1] ?? `5c0e8d2a-7f31-4b6e-9a4d-0c1b2e3f4a${String(p.minor).padStart(2, '0')}`;
    return p.fsType === 'swap'
      ? `/dev/${p.name}: UUID="${uuid}" TYPE="swap" PARTUUID="${partuuid}"`
      : `/dev/${p.name}: UUID="${uuid}" BLOCK_SIZE="4096" TYPE="${p.fsType}" PARTUUID="${partuuid}"`;
  }));
  const wanted = ctx.args.filter(a => !a.startsWith('-'));
  const shown = wanted.length ? rows.filter(r => wanted.some(w => r.startsWith(`${w}:`))) : rows;
  return ctx.result(shown.join('\n'), '', shown.length ? 0 : 2);
}

function lsusb(ctx: LinuxContext): LinuxResult {
  return ctx.ok([
    'Bus 001 Device 002: ID 0627:0001 Adomax Technology Co., Ltd QEMU USB Tablet',
    'Bus 001 Device 001: ID 1d6b:0001 Linux Foundation 1.1 root hub',
  ].join('\n'));
}

const MODULE_INFO: Record<string, { file: string; desc: string; author: string; license: string; alias?: string }> = {
  e1000e: { file: 'kernel/drivers/net/ethernet/intel/e1000e/e1000e.ko', desc: 'Intel(R) PRO/1000 Network Driver', author: 'Intel Corporation, <linux.nics@intel.com>', license: 'GPL v2', alias: 'pci:v00008086d000010D3sv*sd*bc*sc*i*' },
  ahci: { file: 'kernel/drivers/ata/ahci.ko', desc: 'AHCI SATA low-level driver', author: 'Jeff Garzik', license: 'GPL', alias: 'pci:v*d*sv*sd*bc01sc06i01*' },
  libahci: { file: 'kernel/drivers/ata/libahci.ko', desc: 'Common AHCI SATA low-level routines', author: 'Jeff Garzik', license: 'GPL' },
  ext4: { file: 'kernel/fs/ext4/ext4.ko', desc: 'Fourth Extended Filesystem', author: 'Remy Card, Stephen Tweedie, Andrew Morton, Andreas Dilger, Theodore Ts\'o and others', license: 'GPL' },
  jbd2: { file: 'kernel/fs/jbd2/jbd2.ko', desc: 'Generic filesystem journal-writing module', author: '', license: 'GPL' },
  mbcache: { file: 'kernel/fs/mbcache.ko', desc: 'Meta block cache (for extended attributes)', author: 'Andreas Gruenbacher <a.gruenbacher@computer.org>', license: 'GPL' },
  crc16: { file: 'kernel/lib/crc16.ko', desc: 'CRC16 calculations', author: '', license: 'GPL' },
};

function modinfo(ctx: LinuxContext): LinuxResult {
  const names = ctx.args.filter(a => !a.startsWith('-'));
  if (!names.length) return ctx.fail('modinfo: ERROR: missing module or filename.', 1);
  const field = ctx.args.includes('-F') ? ctx.args[ctx.args.indexOf('-F') + 1] : undefined;
  const out: string[] = [];
  const errors: string[] = [];
  for (const name of names.filter(n => n !== field)) {
    const info = MODULE_INFO[name];
    if (!info) { errors.push(`modinfo: ERROR: Module ${name} not found.`); continue; }
    const fields: [string, string][] = [
      ['filename', `/lib/modules/${KERNEL_RELEASE}/${info.file}`],
      ['license', info.license],
      ['description', info.desc],
      ...(info.author ? [['author', info.author] as [string, string]] : []),
      ...(info.alias ? [['alias', info.alias] as [string, string]] : []),
      // The modules this one needs: the reverse of lsmod's "Used by" column
      ['depends', MODULES.filter(([, , , users]) => users.includes(name)).map(([n]) => n).join(',')],
      ['retpoline', 'Y'],
      ['intree', 'Y'],
      ['name', name],
      ['vermagic', `${KERNEL_RELEASE} SMP mod_unload modversions `],
    ];
    out.push(...(field ? fields.filter(([k]) => k === field).map(([, v]) => v) : fields.map(([k, v]) => `${`${k}:`.padEnd(16)}${v}`)));
  }
  return ctx.result(out.join('\n'), errors.join('\n'), errors.length ? 1 : 0);
}

function timedatectl(ctx: LinuxContext): LinuxResult {
  const sub = ctx.args[0] ?? 'status';
  if (sub === 'status') {
    const now = labNow();
    const stamp = now.toISOString().replace('T', ' ').slice(0, 19);
    const day = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][now.getUTCDay()];
    return ctx.ok([
      `               Local time: ${day} ${stamp} UTC`,
      `           Universal time: ${day} ${stamp} UTC`,
      `                 RTC time: ${day} ${stamp}`,
      `                Time zone: ${ctx.state.envVars?.TZ ?? 'Etc/UTC'} (UTC, +0000)`,
      'System clock synchronized: yes',
      '              NTP service: active',
      '          RTC in local TZ: no',
    ].join('\n'));
  }
  if (sub === 'list-timezones') return ctx.ok(['America/New_York', 'Asia/Tokyo', 'Etc/UTC', 'Europe/Berlin', 'Europe/London', 'UTC'].join('\n'));
  if (['set-timezone', 'set-time', 'set-ntp', 'set-local-rtc'].includes(sub)) {
    if (!ctx.isRoot) return ctx.fail('Failed to set time zone: Interactive authentication required.', 1, ctx.needsRoot(`timedatectl ${sub}`));
    if (sub === 'set-timezone') {
      if (!ctx.args[1]) return ctx.fail('Too few arguments.');
      ctx.state.envVars = { ...ctx.state.envVars, TZ: ctx.args[1] };
    }
    return ctx.ok();
  }
  return ctx.fail(`Unknown command verb ${sub}.`);
}

linuxCommands.registerAll({ rmdir, du, who, uptime, pgrep, pkill, nice, renice, xargs, nl, mount, swapon, blkid, lsusb, modinfo, timedatectl });
