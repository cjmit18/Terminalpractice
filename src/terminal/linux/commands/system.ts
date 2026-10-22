import { WindowsService } from '../../../types/terminal';
import { describeIdentity } from '../../filesystem';
import { labNow } from '../../labClock';
import { parseOptions, optionValue, padNum } from '../../textUtils';
import { LinuxContext, LinuxResult, linuxCommands, createInDir } from '../context';
import { DEFAULT_LINUX_DISKS, partitionLayout, KERNEL_RELEASE, KERNEL_VERSION, MEMORY_KIB, MODULES } from '../virtualFs';

// System, hardware, processes, services, packages and archives

/** The machine booted at 08:00:00 UTC on Monday 19 October 2026 (uptime -s and who -b agree). */
const BOOT_MS = Date.UTC(2026, 9, 19, 8, 0, 0);

/** Kernel ring buffer: seconds since boot and message. journalctl -k reads the same messages. */
const KERNEL_LOG: [number, string][] = [
  [0, 'Linux version 5.15.0-101-generic (buildd@lcy02-amd64-072) (gcc version 11.4.0)'],
  [0, 'Command line: BOOT_IMAGE=/vmlinuz-5.15.0-101-generic root=UUID=8d6a8f1e ro quiet splash'],
  [0.412891, 'ACPI: Core revision 20210604'],
  [1.120542, 'ahci 0000:00:1f.2: AHCI 0001.0000 32 slots 6 ports 1.5 Gbps 0x3f impl SATA mode'],
  [2.341209, 'e1000e: Intel(R) PRO/1000 Network Driver'],
  [2.341512, 'e1000e 0000:00:19.0 eth0: (PCI Express:2.5GT/s:Width x1) 52:54:00:12:34:56'],
  [3.150221, 'systemd[1]: Inserted module \'autofs4\''],
  [4.201944, 'EXT4-fs (sda3): mounted filesystem with ordered data mode. Opts: (null)'],
  [6300.118204, 'EXT4-fs (sda3): re-mounted. Opts: errors=remount-ro'],
];

/** "Oct 19 08:00:01": a kernel message's time as the journal prints it (all on boot day). */
function syslogTime(t: number): string {
  const d = new Date(BOOT_MS + Math.floor(t) * 1000);
  const p2 = (n: number) => String(n).padStart(2, '0');
  return `Oct ${p2(d.getUTCDate())} ${p2(d.getUTCHours())}:${p2(d.getUTCMinutes())}:${p2(d.getUTCSeconds())}`;
}

const DMESG = KERNEL_LOG.map(([t, msg]) => `[${t.toFixed(6).padStart(12)}] ${msg}`).join('\n');

/** Wall-clock time of a kernel message, e.g. "Mon Oct 19 08:00:01 2026" (dmesg -T). */
const kernelTime = (t: number) => formatDate(new Date(BOOT_MS + Math.floor(t) * 1000), '%a %b %e %H:%M:%S %Y');

/** dmesg [-T] */
function dmesg(ctx: LinuxContext): LinuxResult {
  const opts = parseOptions(ctx.args, '', { ctime: 'T', kernel: 'k' });
  if (!opts.flags.has('T')) return ctx.ok(DMESG);
  return ctx.ok(KERNEL_LOG.map(([t, msg]) => `[${kernelTime(t)}] ${msg}`).join('\n'));
}

/** PCI devices, in bus order as lspci prints them, with the driver bound to each. */
const PCI: { addr: string; cls: string; desc: string; ids: string; sub: string; irq: number; driver?: string; modules?: string }[] = [
  { addr: '00:00.0', cls: 'Host bridge', desc: 'Intel Corporation 440FX - 82441FX PMC [Natoma]', ids: '[0600]: Intel Corporation 440FX - 82441FX PMC [Natoma] [8086:1237]', sub: 'Red Hat, Inc. Qemu virtual machine', irq: 0 },
  { addr: '00:01.0', cls: 'ISA bridge', desc: 'Intel Corporation 82371SB PIIX3 ISA [Natoma/Triton II]', ids: '[0601]: Intel Corporation 82371SB PIIX3 ISA [Natoma/Triton II] [8086:7000]', sub: 'Red Hat, Inc. Qemu virtual machine', irq: 0 },
  { addr: '00:01.1', cls: 'IDE interface', desc: 'Intel Corporation 82371SB PIIX3 IDE [Natoma/Triton II]', ids: '[0101]: Intel Corporation 82371SB PIIX3 IDE [Natoma/Triton II] [8086:7010]', sub: 'Red Hat, Inc. Qemu virtual machine', irq: 0, driver: 'ata_piix', modules: 'pata_acpi' },
  { addr: '00:02.0', cls: 'VGA compatible controller', desc: 'Red Hat, Inc. QXL paravirtual graphic card', ids: '[0300]: Red Hat, Inc. QXL paravirtual graphic card [1b36:0100] (rev 05)', sub: 'Red Hat, Inc. QEMU Virtual Machine', irq: 10, driver: 'qxl', modules: 'qxl' },
  { addr: '00:04.0', cls: 'USB controller', desc: 'Intel Corporation 82801I (ICH9 Family) USB UHCI Controller #1', ids: '[0c03]: Intel Corporation 82801I (ICH9 Family) USB UHCI Controller #1 [8086:2934] (rev 03)', sub: 'Red Hat, Inc. QEMU Virtual Machine', irq: 11, driver: 'uhci_hcd' },
  { addr: '00:19.0', cls: 'Ethernet controller', desc: 'Intel Corporation 82574L Gigabit Network Connection', ids: '[0200]: Intel Corporation 82574L Gigabit Network Connection [8086:10d3]', sub: 'Intel Corporation Gigabit CT Desktop Adapter', irq: 11, driver: 'e1000e', modules: 'e1000e' },
  { addr: '00:1f.2', cls: 'SATA controller', desc: 'Intel Corporation 82801IR/IO/IH (ICH9R/DO/DH) 6 port SATA Controller [AHCI mode] (rev 02)', ids: '[0106]: Intel Corporation 82801IR/IO/IH (ICH9R/DO/DH) 6 port SATA Controller [AHCI mode] [8086:2922] (rev 02)', sub: 'Red Hat, Inc. QEMU Virtual Machine', irq: 10, driver: 'ahci', modules: 'ahci' },
];

/** lspci [-k] [-v] [-nn] [-s [[bus]:][slot][.func]] */
function lspci(ctx: LinuxContext): LinuxResult {
  const nn = ctx.args.includes('-nn');
  const opts = parseOptions(ctx.args.filter(a => a !== '-nn'), 'sd');
  const f = opts.flags;
  const verbose = f.has('v');
  const kernel = f.has('k') || verbose;
  const numeric = nn || f.has('n');
  let devices = PCI;
  const slot = optionValue(opts, 's');
  if (slot !== undefined) {
    const m = slot.match(/^(?:([0-9a-f]{0,2}):)?([0-9a-f]{0,2})(?:\.([0-7]))?$/i);
    if (!m) return ctx.fail('lspci: -s: Invalid slot number', 1);
    const [, bus, dev, fn] = m;
    const hex = (x: string) => parseInt(x, 16);
    devices = devices.filter(d => {
      const [b, rest] = d.addr.split(':');
      const [dv, fu] = rest.split('.');
      return (!bus || hex(bus) === hex(b)) && (!dev || hex(dev) === hex(dv)) && (fn === undefined || fn === fu);
    });
  }
  const out = devices.map(d => {
    const lines = [`${d.addr} ${numeric ? `${d.cls} ${d.ids}` : `${d.cls}: ${d.desc}`}`];
    if (verbose) lines.push(`\tSubsystem: ${d.sub}`, `\tFlags: ${d.driver ? 'bus master, ' : ''}fast devsel, latency 0${d.irq ? `, IRQ ${d.irq}` : ''}`);
    if (kernel && d.driver) lines.push(`\tKernel driver in use: ${d.driver}`);
    if (kernel && d.modules) lines.push(`\tKernel modules: ${d.modules}`);
    return lines.join('\n');
  });
  // -v leaves a blank line after each device
  return ctx.ok(out.join(verbose ? '\n\n' : '\n'));
}


const LSMOD = ['Module                  Size  Used by',
  ...MODULES.map(([n, size, count, users]) => `${n.padEnd(19)}${String(size).padStart(9)}  ${count}${users.length ? ` ${users.join(',')}` : ''}`)].join('\n');

const JOURNAL_HEAD = '-- Journal begins at Mon 2026-10-19 08:00:00 UTC, ends at Mon 2026-10-19 10:25:00 UTC. --';

/** Journal entries with the systemd unit that logged them (kernel lines have none). */
const JOURNAL: { unit?: string; line: string }[] = [
  ...KERNEL_LOG.filter(([t]) => t < 3600).map(([t, msg]) => ({ line: `${syslogTime(t)} lpi-lab kernel: ${msg}` })),
  { unit: 'systemd-timesyncd', line: 'Oct 19 09:30:12 lpi-lab systemd[1]: Starting Network Time Synchronization...' },
  { unit: 'systemd-timesyncd', line: 'Oct 19 09:30:13 lpi-lab systemd[1]: Started Network Time Synchronization.' },
  { unit: 'ssh', line: 'Oct 19 09:30:14 lpi-lab systemd[1]: Starting OpenBSD Secure Shell server...' },
  { unit: 'ssh', line: 'Oct 19 09:30:14 lpi-lab sshd[1420]: Server listening on 0.0.0.0 port 22.' },
  { unit: 'ssh', line: 'Oct 19 09:30:14 lpi-lab systemd[1]: Started OpenBSD Secure Shell server.' },
  { line: `${syslogTime(6300.118204)} lpi-lab kernel: EXT4-fs (sda3): re-mounted. Opts: errors=remount-ro` },
  { unit: 'ssh', line: 'Oct 19 10:00:22 lpi-lab sshd[1450]: Accepted publickey for student from 192.168.1.100 port 51220 ssh2' },
  { unit: 'nginx', line: 'Oct 19 10:15:30 lpi-lab nginx[2100]: [notice] configuration file /etc/nginx/nginx.conf test is successful' },
];

function journalctl(ctx: LinuxContext): LinuxResult {
  // -b takes an optional boot ID or offset (-b, -b 0, -b -1); only a following offset is its value
  const args: string[] = [];
  let bootOffset = '';
  for (let i = 0; i < ctx.args.length; i++) {
    const a = ctx.args[i];
    const inline = a.match(/^(?:-b|--boot=)([+-]?\d+|[0-9a-f]{32})$/);
    if (inline) { args.push('-b'); bootOffset = inline[1]; continue; }
    args.push(a);
    if ((a === '-b' || a === '--boot') && /^([+-]?\d+|[0-9a-f]{32})$/.test(ctx.args[i + 1] ?? '')) bootOffset = ctx.args[++i];
  }
  if (bootOffset && !/^(\+?0|6c1f0a3e2b7d4e5f8a9b0c1d2e3f4a5b)$/.test(bootOffset)) {
    // The lab journal lives in /run/log/journal (volatile), so there is no earlier boot
    return ctx.fail('Specifying boot ID or boot offset has no effect, no persistent journal was found.', 1);
  }
  const opts = parseOptions(args, 'unpS', { unit: 'u', lines: 'n', priority: 'p', dmesg: 'k', boot: 'b', 'no-pager': 'P', follow: 'f', since: 'S' });
  const units = (opts.values.get('u') ?? []).map(u => u.replace(/\.service$/, ''));
  let entries = JOURNAL;
  if (opts.flags.has('k')) entries = entries.filter(e => !e.unit);
  if (units.length) entries = entries.filter(e => e.unit && units.includes(e.unit));
  const n = optionValue(opts, 'n');
  if (n !== undefined) entries = entries.slice(-Math.max(0, Number(n) || 0));
  const head = opts.flags.has('k') || opts.flags.has('b') ? '-- Boot 6c1f0a3e2b7d4e5f8a9b0c1d2e3f4a5b --' : JOURNAL_HEAD;
  return ctx.ok([head, ...(entries.length ? entries.map(e => e.line.replace(' lpi-lab ', ` ${ctx.state.hostname} `)) : ['-- No entries --'])].join('\n'));
}

const KERNEL = { r: KERNEL_RELEASE, v: KERNEL_VERSION };

function uname(ctx: LinuxContext): LinuxResult {
  const opts = parseOptions(ctx.args, '', {
    all: 'a', 'kernel-name': 's', nodename: 'n', 'kernel-release': 'r', 'kernel-version': 'v', machine: 'm',
    processor: 'p', 'hardware-platform': 'i', 'operating-system': 'o',
  });
  const bad = [...opts.flags].find(f => !'asnrvmpio'.includes(f));
  if (bad) return ctx.fail(`uname: invalid option -- '${bad}'\nTry 'uname --help' for more information.`);
  const fields: Record<string, string> = {
    s: 'Linux', n: ctx.state.hostname, r: KERNEL.r, v: KERNEL.v, m: 'x86_64', p: 'x86_64', i: 'x86_64', o: 'GNU/Linux',
  };
  const order = opts.flags.has('a') ? 'snrvmpio' : [...'snrvmpio'].filter(f => opts.flags.has(f)).join('') || 's';
  return ctx.ok([...order].map(f => fields[f]).join(' '));
}

const SIGNALS = [
  'HUP', 'INT', 'QUIT', 'ILL', 'TRAP', 'ABRT', 'BUS', 'FPE', 'KILL', 'USR1', 'SEGV', 'USR2', 'PIPE', 'ALRM', 'TERM', 'STKFLT',
  'CHLD', 'CONT', 'STOP', 'TSTP', 'TTIN', 'TTOU', 'URG', 'XCPU', 'XFSZ', 'VTALRM', 'PROF', 'WINCH', 'IO', 'PWR', 'SYS',
];
/** Signal numbers and names as bash's kill -l lists them (32 and 33 are reserved by glibc). */
const SIGNAL_TABLE: [number, string][] = [
  ...SIGNALS.map((n, i) => [i + 1, `SIG${n}`] as [number, string]),
  [34, 'SIGRTMIN'],
  ...Array.from({ length: 15 }, (_, i) => [35 + i, `SIGRTMIN+${i + 1}`] as [number, string]),
  ...Array.from({ length: 14 }, (_, i) => [50 + i, `SIGRTMAX-${14 - i}`] as [number, string]),
  [64, 'SIGRTMAX'],
];

function killList(ctx: LinuxContext, specs: string[]): LinuxResult {
  if (specs.length === 0) {
    const cells = SIGNAL_TABLE.map(([n, name]) => `${String(n).padStart(2)}) ${name}`);
    const rows: string[] = [];
    for (let i = 0; i < cells.length; i += 5) rows.push(cells.slice(i, i + 5).join('\t'));
    return ctx.ok(rows.join('\n'));
  }
  const out: string[] = [];
  for (const s of specs) {
    // A number gives the name; a name gives the number (an exit status above 128 means 128 + signal)
    const n = /^\d+$/.test(s) ? (Number(s) > 128 ? Number(s) - 128 : Number(s)) : null;
    const entry = n !== null ? SIGNAL_TABLE.find(([k]) => k === n) : SIGNAL_TABLE.find(([, name]) => name === s.toUpperCase() || name === `SIG${s.toUpperCase()}`);
    if (!entry) return ctx.fail(`bash: kill: ${s}: invalid signal specification`, 1);
    out.push(n !== null ? entry[1].replace(/^SIG/, '') : String(entry[0]));
  }
  return ctx.ok(out.join('\n'));
}

/** Process table plus the ps process itself and the other commands of its pipeline (ps aux | grep x shows the grep). */
function psRows(ctx: LinuxContext) {
  const tty = (cmd: string) => (cmd === 'bash' ? 'pts/0' : '?');
  const procs = ctx.state.processes.map(p => ({ ...p, ppid: p.pid === 1 ? 0 : p.command === 'bash' ? 1450 : 1, tty: tty(p.command) }));
  const shell = ctx.state.processes.find(p => p.command === 'bash')?.pid ?? 2100;
  const mine = (ctx.pipeline.length ? ctx.pipeline : [['ps', ...ctx.args].join(' ')]).map((cmd, i) => ({
    pid: 2400 + i, user: ctx.user, cpu: 0, mem: 0.1, command: cmd, ppid: shell, tty: 'pts/0',
  }));
  return [...procs, ...mine];
}

function ps(ctx: LinuxContext): LinuxResult {
  const raw = ctx.args.join(' ');
  const bsd = ctx.args.some(a => !a.startsWith('-') && /^[auxef]+$/.test(a));
  const opts = parseOptions(ctx.args.filter(a => a.startsWith('-')), 'upCo', { user: 'u', pid: 'p' });
  const f = opts.flags;
  let rows = psRows(ctx);
  const userFilter = optionValue(opts, 'u');
  const pidFilter = optionValue(opts, 'p');
  const cmdFilter = optionValue(opts, 'C');
  const all = bsd ? /a/.test(raw) || /x/.test(raw) : f.has('e') || f.has('A');
  if (userFilter) rows = rows.filter(p => userFilter.split(',').includes(p.user));
  else if (pidFilter) rows = rows.filter(p => pidFilter.split(',').map(Number).includes(p.pid));
  else if (cmdFilter) rows = rows.filter(p => p.command.split(' ')[0].split('/').pop() === cmdFilter);
  else if (!all) rows = rows.filter(p => p.tty === 'pts/0');

  const time = (p: { cpu: number }) => (p.cpu > 1 ? '00:00:12' : '00:00:00');
  if (bsd && /u/.test(raw)) {
    const header = 'USER         PID %CPU %MEM    VSZ   RSS TTY      STAT START   TIME COMMAND';
    return ctx.ok([header, ...rows.map(p =>
      `${p.user.padEnd(8)} ${String(p.pid).padStart(7)} ${p.cpu.toFixed(1).padStart(4)} ${p.mem.toFixed(1).padStart(4)} ${String(24500).padStart(6)} ${String(4210).padStart(5)} ${p.tty.padEnd(8)} ${(p.tty === '?' ? 'Ss' : p.pid >= 2400 ? 'R+' : 'Ss').padEnd(4)} 10:00   0:01 ${p.command}`)].join('\n'));
  }
  if (f.has('f') || (bsd && /f/.test(raw))) {
    const header = 'UID          PID    PPID  C STIME TTY          TIME CMD';
    return ctx.ok([header, ...rows.map(p =>
      `${p.user.padEnd(8)} ${String(p.pid).padStart(7)} ${String(p.ppid).padStart(7)} ${String(Math.round(p.cpu)).padStart(2)} 10:00 ${p.tty.padEnd(8)} ${time(p)} ${p.command}`)].join('\n'));
  }
  const header = '    PID TTY          TIME CMD';
  return ctx.ok([header, ...rows.map(p =>
    `${String(p.pid).padStart(7)} ${p.tty.padEnd(8)} ${time(p)} ${p.command.split(' ')[0].split('/').pop()}`)].join('\n'));
}

function kill(ctx: LinuxContext): LinuxResult {
  if (ctx.args[0] === '-l' || ctx.args[0] === '-L' || ctx.args[0] === '--list') return killList(ctx, ctx.args.slice(1));
  const args = [...ctx.args];
  // -9, -KILL, -SIGKILL, -s KILL, -n 9
  if (args[0] === '-s' || args[0] === '-n') args.splice(0, 2);
  else if (args[0]?.startsWith('-') && args[0] !== '--') {
    const spec = args[0].slice(1);
    const known = /^\d+$/.test(spec) ? SIGNAL_TABLE.some(([n]) => n === Number(spec)) || spec === '0'
      : SIGNAL_TABLE.some(([, name]) => name === spec.toUpperCase() || name === `SIG${spec.toUpperCase()}`);
    if (!known) return ctx.fail(`bash: kill: ${spec}: invalid signal specification`, 1);
    args.shift();
  }
  if (args[0] === '--') args.shift();
  const targets = args;
  if (targets.length === 0) return ctx.fail('kill: usage: kill [-s sigspec | -n signum | -sigspec] pid | jobspec ... or kill -l [sigspec]', 2);
  const errors: string[] = [];
  for (const t of targets) {
    const pid = parseInt(t, 10);
    const proc = ctx.state.processes.find(p => p.pid === pid);
    if (isNaN(pid) || !/^-?\d+$/.test(t)) { errors.push(`bash: kill: ${t}: arguments must be process or job IDs`); continue; }
    if (!proc) { errors.push(`bash: kill: (${pid}) - No such process`); continue; }
    if (!ctx.isRoot && proc.user !== ctx.user) {
      errors.push(`bash: kill: (${pid}) - Operation not permitted`);
      ctx.deny(`${describeIdentity(ctx.user, ctx.groups)} Process ${pid} belongs to '${proc.user}', and only its owner or root may send it signals; use sudo kill.`);
      continue;
    }
    ctx.state.processes = ctx.state.processes.filter(p => p.pid !== pid);
  }
  return ctx.result('', errors.join('\n'), errors.length ? 1 : 0);
}

function apt(ctx: LinuxContext): LinuxResult {
  const sub = ctx.args[0];
  if ((sub === 'update' || sub === 'install' || sub === 'upgrade' || sub === 'remove') && !ctx.isRoot) {
    return ctx.fail('E: Could not open lock file /var/lib/dpkg/lock-frontend - open (13: Permission denied)\nE: Unable to acquire the dpkg frontend lock, are you root?', 100,
      ctx.needsRoot(`apt ${sub} locks and writes /var/lib/dpkg (owned by root), so it`));
  }
  if (sub === 'update') {
    return ctx.ok([
      'Hit:1 http://archive.ubuntu.com/ubuntu jammy InRelease',
      'Hit:2 http://archive.ubuntu.com/ubuntu jammy-updates InRelease',
      'Hit:3 http://security.ubuntu.com/ubuntu jammy-security InRelease',
      'Reading package lists... Done',
      'Building dependency tree... Done',
      'All packages are up to date.',
    ].join('\n'));
  }
  if (sub === 'install') {
    const pkg = ctx.args[1] || 'package';
    if (!ctx.state.installedPackages.includes(pkg)) {
      ctx.state.installedPackages = [...ctx.state.installedPackages, pkg];
    }
    return ctx.ok([
      `Reading package lists... Done`,
      `Building dependency tree... Done`,
      `The following NEW packages will be installed: ${pkg}`,
      `0 upgraded, 1 newly installed, 0 to remove.`,
      `Setting up ${pkg} (2.4.52-1ubuntu4) ...`,
      `Processing triggers for man-db ...`,
    ].join('\n'));
  }
  return ctx.ok('apt 2.4.12 (amd64)');
}

function tar(ctx: LinuxContext): LinuxResult {
  const { args } = ctx;
  // Mode letters come only from the first argument (dashless style) or from dash flags
  const flags = args.filter((a, i) => i === 0 || a.startsWith('-')).map(a => a.replace(/^-+/, '')).join('');
  const hasC = flags.includes('c');
  const hasX = flags.includes('x');
  const hasT = flags.includes('t');
  const hasV = flags.includes('v');
  if (!hasC && !hasX && !hasT) return ctx.fail('tar: Must specify one of -c, -r, -t, -u, -x', 2);

  let fIndex = -1;
  let archiveName = '';
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '-f' || a === 'f' || ((a.startsWith('-') || i === 0) && a.includes('f'))) {
      fIndex = i;
      archiveName = args[i + 1] || '';
      break;
    }
  }

  if (hasC) {
    // the first argument is the mode letters (or a dash flag), never a file to add
    const nonFlags = args.filter((a, idx) => idx !== 0 && !a.startsWith('-') && idx !== fIndex + 1);
    if (!archiveName && nonFlags.length > 0) {
      archiveName = nonFlags[0];
      nonFlags.shift();
    }
    if (!archiveName) return ctx.fail('tar: Cowardly refusing to create an empty archive', 2);
    createInDir(ctx.fs, ctx.resolve(archiveName), 'file', nonFlags.join('\n'), ctx.user, ctx.group, ctx.fileMode());
    return ctx.ok(hasV ? nonFlags.map(f => `a ${f}`).join('\n') : '');
  }

  const target = archiveName || args.find((a, i) => i > 0 && !a.startsWith('-'));
  if (target) {
    const node = ctx.node(ctx.resolve(target));
    if (!node) return ctx.fail(`tar: ${target}: Cannot open: No such file or directory`, 2);
    return ctx.ok(node.content || 'notes.txt\nscripts/backup.sh');
  }
  return ctx.ok('notes.txt\nscripts/backup.sh');
}

// ---------- services ----------

const DEFAULT_TARGET = 'multi-user.target';
const unitName = (u: string) => u.replace(/\.service$/, '');

function systemctl(ctx: LinuxContext): LinuxResult {
  const opts = parseOptions(ctx.args, 't', { now: 'N', type: 't', all: 'a', quiet: 'q', 'no-pager': 'P' });
  const [sub = 'list-units', ...units] = opts.operands;
  const services = ctx.state.services;
  const find = (u: string) => services.find(s => s.name.toLowerCase() === unitName(u).toLowerCase());
  const missing = (u: string) => `Unit ${unitName(u)}.service could not be found.`;
  const enabled = (s: WindowsService) => s.startType === 'Automatic';
  const active = (s: WindowsService) => s.status === 'Running';

  switch (sub) {
    case 'get-default': return ctx.ok(ctx.state.envVars?.SYSTEMD_DEFAULT_TARGET ?? DEFAULT_TARGET);
    case 'set-default': {
      if (!ctx.isRoot) break;
      const target = units[0];
      if (!target) return ctx.fail('Too few arguments.');
      ctx.state.envVars = { ...ctx.state.envVars, SYSTEMD_DEFAULT_TARGET: target };
      return ctx.ok(`Removed /etc/systemd/system/default.target.\nCreated symlink /etc/systemd/system/default.target → /lib/systemd/system/${target}.`);
    }
    case 'list-units': case 'list-unit-files': {
      const rows = services.map(s => sub === 'list-units'
        ? `  ${(s.name + '.service').padEnd(28)} loaded ${active(s) ? 'active   running' : 'inactive dead   '} ${s.displayName}`
        : `${(s.name + '.service').padEnd(30)} ${enabled(s) ? 'enabled ' : 'disabled'} enabled`);
      const header = sub === 'list-units' ? '  UNIT                         LOAD   ACTIVE   SUB     DESCRIPTION' : 'UNIT FILE                      STATE    VENDOR PRESET';
      return ctx.ok([header, ...rows, '', `${rows.length} ${sub === 'list-units' ? 'loaded units listed.' : 'unit files listed.'}`].join('\n'));
    }
    case 'status': {
      if (units.length === 0) {
        return ctx.ok(`● ${ctx.state.hostname}\n    State: running\n     Jobs: 0 queued\n   Failed: 0 units`);
      }
      const out: string[] = [];
      let code = 0;
      for (const u of units) {
        const s = find(u);
        if (!s) return ctx.fail(missing(u), 4);
        if (!active(s)) code = 3;
        const name = unitName(u);
        out.push([
          `● ${name}.service - ${s.displayName}`,
          `     Loaded: loaded (/lib/systemd/system/${name}.service; ${enabled(s) ? 'enabled' : 'disabled'}; vendor preset: enabled)`,
          active(s)
            ? `     Active: active (running) since Mon 2026-10-19 10:14:00 UTC; 20min ago`
            : `     Active: inactive (dead)`,
        ].join('\n'));
      }
      return ctx.result(out.join('\n\n'), '', code);
    }
    case 'is-active': case 'is-enabled': {
      const out = units.map(u => {
        const s = find(u);
        if (!s) return sub === 'is-active' ? 'inactive' : 'not-found';
        return sub === 'is-active' ? (active(s) ? 'active' : 'inactive') : (enabled(s) ? 'enabled' : 'disabled');
      });
      const ok = units.every(u => { const s = find(u); return !!s && (sub === 'is-active' ? active(s) : enabled(s)); });
      return ctx.result(opts.flags.has('q') ? '' : out.join('\n'), '', ok ? 0 : sub === 'is-active' ? 3 : 1);
    }
    case 'daemon-reload':
      if (!ctx.isRoot) break;
      return ctx.ok();
    case 'start': case 'stop': case 'restart': case 'reload': case 'enable': case 'disable': {
      if (!ctx.isRoot) break;
      if (units.length === 0) return ctx.fail(`Too few arguments.`);
      const out: string[] = [];
      for (const u of units) {
        const s = find(u);
        if (!s) return ctx.fail(sub === 'enable' || sub === 'disable'
          ? `Failed to ${sub} unit: Unit file ${unitName(u)}.service does not exist.`
          : `Failed to ${sub} ${unitName(u)}.service: ${missing(u)}`, sub === 'enable' || sub === 'disable' ? 1 : 5);
        const name = unitName(u);
        if (sub === 'enable') {
          if (!enabled(s)) out.push(`Created symlink /etc/systemd/system/multi-user.target.wants/${name}.service → /lib/systemd/system/${name}.service.`);
          s.startType = 'Automatic';
        }
        if (sub === 'disable') {
          if (enabled(s)) out.push(`Removed /etc/systemd/system/multi-user.target.wants/${name}.service.`);
          s.startType = 'Manual';
        }
        const now = opts.flags.has('N');
        if (sub === 'start' || sub === 'restart' || sub === 'reload' || (sub === 'enable' && now)) s.status = 'Running';
        if (sub === 'stop' || (sub === 'disable' && now)) s.status = 'Stopped';
      }
      return ctx.ok(out.join('\n'));
    }
    default:
      return ctx.fail(`Unknown command verb ${sub}.`);
  }
  const unit = units[0] ? unitName(units[0]) : '';
  return ctx.fail(
    `Failed to ${sub} ${unit}${unit ? '.service' : ''}: Interactive authentication required or root privileges needed (try 'sudo systemctl ${[sub, ...units].join(' ')}')`.replace(`${sub} .service`, sub),
    1,
    ctx.needsRoot(`systemctl ${sub} changes system-wide service state, so it`)
  );
}

// ---------- disks (derived from state.disks so fdisk, df and lsblk agree) ----------

interface Part {
  dev: string; sizeMB: number; start: number; end: number; sectors: number;
  fsType: string; mount?: string; typeName: string;
}

function linuxDisks(ctx: LinuxContext) {
  const disks = ctx.state.disks.length ? ctx.state.disks : DEFAULT_DISKS;
  return disks.map(d => {
    const name = `sd${String.fromCharCode(97 + d.diskNumber)}`;
    const layout = partitionLayout(d);
    const parts: Part[] = d.partitions.filter(p => p.fsType !== 'Unallocated').map((p, i) => ({
      dev: `/dev/${name}${p.id}`,
      sizeMB: layout[i].sectors / 2048,
      start: layout[i].start,
      end: layout[i].end,
      sectors: layout[i].sectors,
      fsType: p.fsType === 'swap' ? 'swap' : p.fsType.toLowerCase(),
      mount: p.fsType === 'swap' ? '[SWAP]' : p.mountPoint,
      typeName: p.fsType === 'swap' ? 'Linux swap' : p.fsType === 'FAT32' || p.mountPoint === '/boot/efi' ? 'EFI System' : 'Linux filesystem',
    }));
    return { name, dev: `/dev/${name}`, sizeMB: d.totalSizeMB, model: d.model, gpt: d.partitionTable === 'GPT', parts };
  });
}

const DEFAULT_DISKS = DEFAULT_LINUX_DISKS;

/** Size as lsblk and fdisk print it: 1024-based, one decimal unless whole (512M, 4G, 45.5G). */
function human(mb: number, suffix = ''): string {
  const units = ['M', 'G', 'T'];
  let v = mb;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  const r = Math.round(v * 10) / 10;
  return `${Number.isInteger(r) ? String(r) : r.toFixed(1)}${units[i]}${suffix}`;
}

/** Size as df -h prints it: rounded up, one decimal below 10 (4.0K, 497M, 45G). */
function dfHuman(kib: number): string {
  if (kib === 0) return '0';
  const units = ['K', 'M', 'G', 'T'];
  let v = kib;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return v < 10 ? `${(Math.ceil(v * 10) / 10).toFixed(1)}${units[i]}` : `${Math.ceil(v)}${units[i]}`;
}

function fdisk(ctx: LinuxContext): LinuxResult {
  const opts = parseOptions(ctx.args, '', { list: 'l' });
  const disks = linuxDisks(ctx);
  const target = opts.operands[0];
  const known = target ? disks.find(d => d.dev === target) : undefined;
  if (target && !known && !disks.some(d => d.parts.some(p => p.dev === target))) {
    return ctx.fail(`fdisk: cannot open ${target}: No such file or directory`);
  }
  if (!ctx.isRoot) {
    const dev = target ?? disks[0].dev;
    const devices = target || !opts.flags.has('l') ? [dev] : disks.map(d => d.dev);
    return ctx.fail(devices.map(d => `fdisk: cannot open ${d}: Permission denied`).join('\n'), 1,
      `${describeIdentity(ctx.user, ctx.groups)} ${dev} is owned by root:disk with mode brw-rw---- (660); you are not its owner and not in group 'disk', so the 'other' bits (---) apply, and they do not include read (r).`);
  }
  if (!opts.flags.has('l')) {
    return ctx.ok([
      'Welcome to fdisk (util-linux 2.37.2).',
      'Changes will remain in memory only, until you decide to write them.',
      'Be careful before using the write command.',
      '',
      `(This simulator does not run fdisk's interactive menu; use 'fdisk -l ${target ?? disks[0].dev}' to view the partition table.)`,
    ].join('\n'));
  }
  const blocks = (known ? [known] : disks).map(d => {
    const bytes = d.sizeMB * 1024 * 1024;
    const rows = d.parts.map(p =>
      `${p.dev.padEnd(10)} ${String(p.start).padStart(9)} ${String(p.end).padStart(9)} ${String(p.sectors).padStart(9)} ${human(p.sizeMB).padStart(5)} ${p.typeName}`);
    return [
      `Disk ${d.dev}: ${human(d.sizeMB).replace(/([MGT])$/, ' $1iB')}, ${bytes} bytes, ${bytes / 512} sectors`,
      `Disk model: ${d.model}`,
      'Units: sectors of 1 * 512 = 512 bytes',
      'Sector size (logical/physical): 512 bytes / 512 bytes',
      'I/O size (minimum/optimal): 512 bytes / 512 bytes',
      `Disklabel type: ${d.gpt ? 'gpt' : 'dos'}`,
      'Disk identifier: B7413988-E29B-4D14-884E-512E098F03C1',
      ...(rows.length ? ['', 'Device         Start       End   Sectors  Size Type', ...rows] : []),
    ].join('\n');
  });
  return ctx.ok(blocks.join('\n\n'));
}

/** Pads a table like df: text columns left-aligned, numeric ones right-aligned, one space apart. */
function alignTable(rows: string[][], rightAligned: boolean[], minWidths: number[] = []): string[] {
  const widths = rows[0].map((_, c) => Math.max(minWidths[c] ?? 0, ...rows.map(r => r[c].length)));
  return rows.map(r => r.map((cell, c) => {
    if (c === r.length - 1) return cell;
    return rightAligned[c] ? cell.padStart(widths[c]) : cell.padEnd(widths[c]);
  }).join(' '));
}

function df(ctx: LinuxContext): LinuxResult {
  const opts = parseOptions(ctx.args, 't', { 'human-readable': 'h', 'print-type': 'T', inodes: 'i', type: 't', all: 'a' });
  const f = opts.flags;
  const h = f.has('h');
  const showType = f.has('T');
  const inodes = f.has('i');
  interface Fs { dev: string; type: string; kib: number; usedKib: number; inodes: number; iused: number; mount: string }
  const all: Fs[] = [];
  for (const d of linuxDisks(ctx)) {
    for (const p of d.parts) {
      if (!p.mount || p.mount === '[SWAP]') continue;
      // ext4 keeps part of the partition for its own tables and journal, so df shows a bit less
      const kib = Math.floor(p.sectors / 2 * 0.97);
      const usedKib = Math.round(kib * (p.mount === '/' ? 0.31 : 0.24));
      const total = Math.floor(p.sectors * 512 / 16384);
      all.push({ dev: p.dev, type: p.fsType, kib, usedKib, inodes: total, iused: p.mount === '/' ? 312455 : 320, mount: p.mount });
    }
  }
  all.push({ dev: 'tmpfs', type: 'tmpfs', kib: 4074116, usedKib: 0, inodes: 1018529, iused: 1, mount: '/dev/shm' });
  const typeFilter = opts.values.get('t');
  let shown = typeFilter ? all.filter(x => typeFilter.includes(x.type)) : all;

  // Operands: the file system each named file lives on (the longest matching mount point)
  const errors: string[] = [];
  if (opts.operands.length) {
    shown = [];
    for (const op of opts.operands) {
      const path = ctx.resolve(op);
      if (!ctx.node(path)) { errors.push(`df: ${op}: No such file or directory`); continue; }
      const dev = all.find(x => x.dev === path);
      const fsFor = dev ?? [...all].filter(x => path === x.mount || path.startsWith(x.mount === '/' ? '/' : `${x.mount}/`))
        .sort((a, b) => b.mount.length - a.mount.length)[0];
      if (fsFor) shown.push(fsFor);
    }
  }

  const header = ['Filesystem', ...(showType ? ['Type'] : []),
    ...(inodes ? ['Inodes', 'IUsed', 'IFree', 'IUse%'] : h ? ['Size', 'Used', 'Avail', 'Use%'] : ['1K-blocks', 'Used', 'Available', 'Use%']),
    'Mounted on'];
  const num = (n: number) => String(n);
  const rows = shown.map(x => {
    const cols: string[] = [x.dev, ...(showType ? [x.type] : [])];
    if (inodes) {
      const ifree = x.inodes - x.iused;
      const pct = x.inodes ? `${Math.ceil(x.iused / x.inodes * 100)}%` : '-';
      const fmt = (n: number) => (h ? (n < 1024 ? String(n) : dfHuman(n / 1024).replace(/[KMGT]$/, c => c)) : num(n));
      cols.push(fmt(x.inodes), fmt(x.iused), fmt(ifree), pct);
    } else {
      // ext4 reserves 5% of its blocks for root; tmpfs reserves nothing
      const avail = (x.type === 'tmpfs' ? x.kib : Math.round(x.kib * 0.95)) - x.usedKib;
      const pct = x.kib ? `${Math.ceil(x.usedKib / (x.usedKib + avail) * 100)}%` : '-';
      const fmt = (k: number) => (h ? dfHuman(k) : num(k));
      cols.push(fmt(x.kib), fmt(x.usedKib), fmt(Math.max(0, avail)), pct);
    }
    cols.push(x.mount);
    return cols;
  });
  const right = header.map((col, i) => i > (showType ? 1 : 0) && col !== 'Mounted on');
  // GNU df gives human-readable number columns at least 5 characters, and the device column 14 or more
  const mins = header.map((col, i) => (i === 0 ? 14 : h && right[i] && col !== 'Use%' && col !== 'IUse%' ? 5 : 0));
  const lines = alignTable([header, ...rows], right, mins);
  return ctx.result(rows.length || !errors.length ? lines.join('\n') : '', errors.join('\n'), errors.length ? 1 : 0);
}

function lsblk(ctx: LinuxContext): LinuxResult {
  const opts = parseOptions(ctx.args, '', { fs: 'f' });
  const withFs = opts.flags.has('f');
  const disks = linuxDisks(ctx);
  if (withFs) {
    const uuids: Record<string, string> = {
      '/': '8d6a8f1e-3a9b-4c22-b5e1-8f432176b912', '/boot': '4a7b9c1d-2e3f-4a5b-6c7d-8e9f0a1b2c3d', '[SWAP]': '12345678-90ab-cdef-1234-567890abcdef',
    };
    const rows: string[][] = [['NAME', 'FSTYPE', 'FSVER', 'LABEL', 'UUID', 'FSAVAIL', 'FSUSE%', 'MOUNTPOINTS']];
    for (const d of disks) {
      rows.push([d.name, '', '', '', '', '', '', '']);
      d.parts.forEach((p, j) => {
        const branch = j === d.parts.length - 1 ? '└─' : '├─';
        const isSwap = p.mount === '[SWAP]';
        const avail = p.mount && !isSwap ? dfHuman(Math.round(p.sectors / 2 * 0.97 * (p.mount === '/' ? 0.64 : 0.71))) : '';
        rows.push([branch + p.dev.slice(5), p.fsType, isSwap ? '1' : '1.0', '', uuids[p.mount ?? ''] ?? '', avail,
          p.mount && !isSwap ? (p.mount === '/' ? '31%' : '24%') : '', p.mount ?? '']);
      });
    }
    return ctx.ok(alignTable(rows, rows[0].map(() => false)).map(l => l.trimEnd()).join('\n'));
  }
  const lines = ['NAME   MAJ:MIN RM  SIZE RO TYPE MOUNTPOINTS'];
  disks.forEach((d, i) => {
    lines.push(`${d.name.padEnd(6)}   8:${i * 16}    0 ${human(d.sizeMB).padStart(5)}  0 disk `);
    d.parts.forEach((p, j) => {
      const branch = j === d.parts.length - 1 ? '└─' : '├─';
      lines.push(`${(branch + p.dev.slice(5)).padEnd(6)}   8:${i * 16 + j + 1}    0 ${human(p.sizeMB).padStart(5)}  0 part ${p.mount ?? ''}`);
    });
  });
  return ctx.ok(lines.join('\n'));
}

// ---------- memory, time, lookup, history, environment ----------

function free(ctx: LinuxContext): LinuxResult {
  const opts = parseOptions(ctx.args, '', { human: 'h', mega: 'm', giga: 'g', kilo: 'k' });
  const m = MEMORY_KIB;
  const kib = { ...m, cache: m.buffers + m.cached };
  const f = opts.flags;
  const fmt = (k: number): string => {
    if (f.has('h')) {
      if (k === 0) return '0B';
      const units = ['Ki', 'Mi', 'Gi'];
      let v = k;
      let i = 0;
      while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
      return `${v < 10 ? v.toFixed(1) : Math.round(v)}${units[i]}`;
    }
    if (f.has('g')) return String(Math.floor(k / 1024 / 1024));
    if (f.has('m')) return String(Math.floor(k / 1024));
    return String(k);
  };
  const col = (vals: number[]) => vals.map(v => fmt(v).padStart(11)).join(' ');
  return ctx.ok([
    '               total        used        free      shared  buff/cache   available',
    `Mem:   ${col([kib.total, kib.used, kib.free, kib.shared, kib.cache, kib.avail])}`,
    `Swap:  ${col([kib.swap, 0, kib.swap])}`,
  ].join('\n'));
}

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

/** strftime subset used by `date +FORMAT` (times are UTC, the lab machines' zone). */
export function formatDate(d: Date, fmt: string): string {
  const p2 = (n: number) => String(n).padStart(2, '0');
  const start = Date.UTC(d.getUTCFullYear(), 0, 1);
  const map: Record<string, () => string> = {
    Y: () => String(d.getUTCFullYear()), y: () => p2(d.getUTCFullYear() % 100), m: () => p2(d.getUTCMonth() + 1),
    d: () => p2(d.getUTCDate()), e: () => String(d.getUTCDate()).padStart(2, ' '), H: () => p2(d.getUTCHours()),
    I: () => p2(d.getUTCHours() % 12 || 12), M: () => p2(d.getUTCMinutes()), S: () => p2(d.getUTCSeconds()),
    p: () => (d.getUTCHours() < 12 ? 'AM' : 'PM'), a: () => DAYS[d.getUTCDay()], A: () => DAY_NAMES[d.getUTCDay()],
    b: () => MONTHS[d.getUTCMonth()], h: () => MONTHS[d.getUTCMonth()], B: () => MONTH_NAMES[d.getUTCMonth()],
    Z: () => 'UTC', z: () => '+0000', s: () => String(Math.floor(d.getTime() / 1000)), u: () => String(d.getUTCDay() || 7),
    w: () => String(d.getUTCDay()), j: () => String(Math.floor((d.getTime() - start) / 86400000) + 1).padStart(3, '0'),
    n: () => '\n', t: () => '\t', '%': () => '%',
  };
  map.F = () => `${map.Y()}-${map.m()}-${map.d()}`;
  map.T = () => `${map.H()}:${map.M()}:${map.S()}`;
  map.D = () => `${map.m()}/${map.d()}/${map.y()}`;
  map.R = () => `${map.H()}:${map.M()}`;
  map.c = () => `${map.a()} ${map.b()} ${map.e()} ${map.T()} ${map.Y()}`;
  return fmt.replace(/%(.)/g, (m, c) => (map[c] ? map[c]() : m));
}

function date(ctx: LinuxContext): LinuxResult {
  const opts = parseOptions(ctx.args, 'sd', { set: 's', date: 'd', utc: 'u', 'iso-8601': 'I' });
  if (opts.values.has('s')) {
    if (!ctx.isRoot) {
      return ctx.fail('date: cannot set date: Operation not permitted', 1,
        `${describeIdentity(ctx.user, ctx.groups)} Setting the system clock needs the CAP_SYS_TIME capability, which only root has; run it with sudo.`);
    }
    return ctx.ok(formatDate(labNow(), '%a %b %e %H:%M:%S %Z %Y'));
  }
  let when = labNow();
  const dArg = optionValue(opts, 'd');
  if (dArg) {
    const parsed = new Date(dArg);
    if (isNaN(parsed.getTime())) return ctx.fail(`date: invalid date '${dArg}'`);
    when = parsed;
  }
  const fmtArg = opts.operands.find(o => o.startsWith('+'));
  if (fmtArg) return ctx.ok(formatDate(when, fmtArg.slice(1)));
  if (opts.flags.has('I')) return ctx.ok(formatDate(when, '%F'));
  return ctx.ok(formatDate(when, '%a %b %e %H:%M:%S %Z %Y'));
}

function history(ctx: LinuxContext): LinuxResult {
  const opts = parseOptions(ctx.args, 'd');
  if (opts.flags.has('c')) {
    ctx.state.commandHistory = [];
    return ctx.ok();
  }
  const all = ctx.state.commandHistory ?? [];
  const n = opts.operands[0];
  if (n !== undefined && !/^\d+$/.test(n)) return ctx.fail(`bash: history: ${n}: numeric argument required`);
  const first = n === undefined ? 0 : Math.max(0, all.length - Number(n));
  return ctx.ok(all.slice(first).map((line, i) => `${padNum(first + i + 1, 5)}  ${line}`).join('\n'));
}

/** Variables every shell has even when the lab state does not list them. */
function environment(ctx: LinuxContext): Record<string, string> {
  const user = ctx.state.currentUser;
  return {
    SHELL: '/bin/bash',
    PWD: ctx.cwd,
    LOGNAME: user,
    HOME: user === 'root' ? '/root' : `/home/${user}`,
    LANG: 'C.UTF-8',
    TERM: 'xterm-256color',
    PATH: '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
    ...Object.fromEntries(Object.entries(ctx.state.envVars ?? {}).filter(([k]) => k !== 'SYSTEMD_DEFAULT_TARGET')),
    USER: user,
  };
}

function env(ctx: LinuxContext): LinuxResult {
  const vars = environment(ctx);
  if (ctx.name === 'printenv' && ctx.args.length) {
    const vals = ctx.args.map(a => vars[a]);
    return ctx.result(vals.filter(v => v !== undefined).join('\n'), '', vals.every(v => v !== undefined) ? 0 : 1);
  }
  return ctx.ok(Object.entries(vars).map(([k, v]) => `${k}=${v}`).join('\n'));
}

function exportVar(ctx: LinuxContext): LinuxResult {
  if (ctx.args.length === 0 || ctx.args[0] === '-p') {
    return ctx.ok(Object.entries(environment(ctx)).map(([k, v]) => `declare -x ${k}="${v}"`).join('\n'));
  }
  const vars = { ...(ctx.state.envVars ?? {}) };
  for (const a of ctx.args) {
    const m = a.match(/^([A-Za-z_]\w*)(?:=(.*))?$/s);
    if (!m) return ctx.fail(`bash: export: \`${a}': not a valid identifier`);
    if (m[2] !== undefined) vars[m[1]] = m[2];
  }
  ctx.state.envVars = vars;
  return ctx.ok();
}

linuxCommands.registerAll({
  true: ctx => ctx.ok(),
  false: ctx => ctx.fail('', 1),
  clear: ctx => ctx.ok('\x1b[2J\x1b[0;0H'),
  hostname: ctx => ctx.ok(ctx.state.hostname),
  uname,
  dmesg,
  lspci,
  lsmod: ctx => ctx.ok(LSMOD),
  journalctl,
  df,
  lsblk,
  free,
  date,
  history,
  env,
  printenv: env,
  export: exportVar,
  systemctl,
  ps,
  kill,
  fdisk,
  apt,
  'apt-get': apt,
  tar,
});
