import { SystemState, WindowsService } from '../../../types/terminal';
import { createNode, describeIdentity } from '../../filesystem';
import { parseOptions, optionValue, padNum } from '../../textUtils';
import { LinuxContext, LinuxResult, linuxCommands } from '../context';

// System, hardware, processes, services, packages and archives

const DMESG = [
  '[    0.000000] Linux version 5.15.0-101-generic (buildd@lcy02-amd64-072) (gcc version 11.4.0)',
  '[    0.000000] Command line: BOOT_IMAGE=/vmlinuz-5.15.0-101-generic root=UUID=8d6a8f1e ro quiet splash',
  '[    0.412891] ACPI: Core revision 20210604',
  '[    1.120542] pci 0000:00:1f.2: [8086:2922] SATA AHCI controller',
  '[    2.341209] e1000e: Intel(R) PRO/1000 Network Driver',
  '[    2.341512] e1000e 0000:00:19.0 eth0: (PCI Express:2.5GT/s:Width x1) 52:54:00:12:34:56',
  '[    3.150221] systemd[1]: Inserted module \'autofs4\'',
  '[    4.201944] EXT4-fs (sda3): mounted filesystem with ordered data mode. Opts: (null)',
].join('\n');

const LSPCI = [
  '00:00.0 Host bridge: Intel Corporation 440FX - 82441FX PMC [Natoma]',
  '00:01.0 ISA bridge: Intel Corporation 82371SB PIIX3 ISA [Natoma/Triton II]',
  '00:01.1 IDE interface: Intel Corporation 82371SB PIIX3 IDE [Natoma/Triton II]',
  '00:02.0 VGA compatible controller: Red Hat, Inc. QXL paravirtual graphic card',
  '00:19.0 Ethernet controller: Intel Corporation 82574L Gigabit Network Connection',
  '00:1f.2 SATA controller: Intel Corporation 82801IR/IO/IH (ICH9R/DO/DH) 6 port SATA Controller [AHCI mode] (rev 02)',
  '00:04.0 USB controller: Intel Corporation 82801I (ICH9 Family) USB UHCI Controller #1',
].join('\n');

const LSMOD = [
  'Module                  Size  Used by',
  'e1000e                286720  0',
  'ext4                  962560  1',
  'crc16                  16384  1 ext4',
  'mbcache                16384  1 ext4',
  'jbd2                  163840  1 ext4',
  'ahci                   45056  2',
  'libahci                49152  1 ahci',
].join('\n');

const JOURNAL = [
  '-- Journal begins at Sun 2026-10-19 08:00:00 UTC, ends at Sun 2026-10-19 10:25:00 UTC. --',
  'Oct 19 09:30:12 lpi-lab systemd[1]: Starting Network Time Synchronization...',
  'Oct 19 09:30:13 lpi-lab systemd[1]: Started Network Time Synchronization.',
  'Oct 19 09:45:00 lpi-lab kernel: [ 120.40] EXT4-fs (sda3): re-mounted. Opts: errors=remount-ro',
  'Oct 19 10:00:22 lpi-lab sshd[1450]: Accepted publickey for student from 192.168.1.100 port 51220 ssh2',
  'Oct 19 10:15:30 lpi-lab nginx[2100]: [notice] configuration file /etc/nginx/nginx.conf test is successful',
].join('\n');

function ps(ctx: LinuxContext): LinuxResult {
  const header = 'USER       PID %CPU %MEM    VSZ   RSS TTY      STAT START   TIME COMMAND';
  const rows = ctx.state.processes.map(p =>
    `${p.user.padEnd(8, ' ')} ${p.pid.toString().padStart(5, ' ')}  ${p.cpu.toFixed(1)}  ${p.mem.toFixed(1)}  24500  4210 ?        Ss   10:00   0:01 ${p.command}`);
  return ctx.ok(`${header}\n${rows.join('\n')}`);
}

function kill(ctx: LinuxContext): LinuxResult {
  const targets = ctx.args.filter(a => !a.startsWith('-') && a !== 'KILL' && a !== 'TERM');
  if (targets.length === 0) return ctx.fail('kill: usage: kill [-s sigspec | -n signum | -sigspec] pid | jobspec ... or kill -l [sigspec]', 2);
  const errors: string[] = [];
  for (const t of targets) {
    const pid = parseInt(t, 10);
    const proc = ctx.state.processes.find(p => p.pid === pid);
    if (isNaN(pid)) { errors.push(`bash: kill: ${t}: arguments must be process or job IDs`); continue; }
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
    createNode(ctx.fs, ctx.resolve(archiveName), 'file', nonFlags.join('\n'), false, ctx.user, ctx.group, ctx.fileMode());
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
            ? `     Active: active (running) since Sun 2026-10-19 10:14:00 UTC; 20min ago`
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

interface Part { dev: string; sizeMB: number; fsType: string; mount?: string; typeName: string }

function linuxDisks(ctx: LinuxContext) {
  const disks = ctx.state.disks.length ? ctx.state.disks : DEFAULT_DISKS;
  return disks.map(d => {
    const name = `sd${String.fromCharCode(97 + d.diskNumber)}`;
    const parts: Part[] = d.partitions.filter(p => p.fsType !== 'Unallocated').map(p => ({
      dev: `/dev/${name}${p.id}`,
      sizeMB: p.sizeMB,
      fsType: p.fsType === 'swap' ? 'swap' : p.fsType.toLowerCase(),
      mount: p.fsType === 'swap' ? '[SWAP]' : p.mountPoint,
      typeName: p.fsType === 'swap' ? 'Linux swap' : p.fsType === 'FAT32' || p.mountPoint === '/boot/efi' ? 'EFI System' : 'Linux filesystem',
    }));
    return { name, dev: `/dev/${name}`, sizeMB: d.totalSizeMB, model: d.model, gpt: d.partitionTable === 'GPT', parts };
  });
}

const DEFAULT_DISKS: SystemState['disks'] = [{
  diskNumber: 0, totalSizeMB: 51200, model: 'QEMU HARDDISK', status: 'Online', partitionTable: 'GPT',
  partitions: [
    { id: 1, sizeMB: 512, fsType: 'ext4', mountPoint: '/boot' },
    { id: 2, sizeMB: 4096, fsType: 'swap' },
    { id: 3, sizeMB: 46592, fsType: 'ext4', mountPoint: '/' },
  ],
}];

/** Human-readable size like df -h / lsblk (1024-based, one decimal under 10). */
function human(mb: number, suffix = ''): string {
  const units = ['M', 'G', 'T'];
  let v = mb;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  const s = v < 10 && !Number.isInteger(v) ? v.toFixed(1) : String(Math.round(v));
  return `${s}${units[i]}${suffix}`;
}

function fdisk(ctx: LinuxContext): LinuxResult {
  const opts = parseOptions(ctx.args);
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
    let start = 2048;
    const rows = d.parts.map(p => {
      const sectors = p.sizeMB * 2048;
      const row = `${p.dev.padEnd(10)} ${String(start).padStart(9)} ${String(start + sectors - 1).padStart(9)} ${String(sectors).padStart(9)} ${human(p.sizeMB).padStart(5)} ${p.typeName}`;
      start += sectors;
      return row;
    });
    return [
      `Disk ${d.dev}: ${human(d.sizeMB).replace(/([MGT])$/, ' $1iB')}, ${bytes} bytes, ${bytes / 512} sectors`,
      `Disk model: ${d.model}`,
      'Units: sectors of 1 * 512 = 512 bytes',
      'Sector size (logical/physical): 512 bytes / 512 bytes',
      `Disklabel type: ${d.gpt ? 'gpt' : 'dos'}`,
      'Disk identifier: B7413988-E29B-4D14-884E-512E098F03C1',
      ...(rows.length ? ['', 'Device         Start       End   Sectors  Size Type', ...rows] : []),
    ].join('\n');
  });
  return ctx.ok(blocks.join('\n\n'));
}

function df(ctx: LinuxContext): LinuxResult {
  const opts = parseOptions(ctx.args, 't', { 'human-readable': 'h', 'print-type': 'T' });
  const h = opts.flags.has('h');
  const showType = opts.flags.has('T') || h;
  const rows: string[][] = [];
  for (const d of linuxDisks(ctx)) {
    for (const p of d.parts) {
      if (!p.mount || p.mount === '[SWAP]') continue;
      const used = Math.round(p.sizeMB * (p.mount === '/' ? 0.31 : 0.24));
      const avail = Math.round(p.sizeMB * 0.95) - used;
      rows.push([p.dev, p.fsType, p.sizeMB, used, avail, p.mount] as unknown as string[]);
    }
  }
  rows.push(['tmpfs', 'tmpfs', 3994, 0, 3994, '/dev/shm'] as unknown as string[]);
  const fmt = (mb: unknown) => (h ? (Number(mb) === 0 ? '0' : human(Number(mb))) : String(Number(mb) * 1024));
  const header = `${'Filesystem'.padEnd(14)} ${showType ? 'Type  ' : ''}${h ? ' Size  Used Avail' : '1K-blocks     Used Available'} Use% Mounted on`;
  const lines = rows.map(([dev, type, size, used, avail, mount]) => {
    const pct = Number(size) ? Math.ceil((Number(used) / (Number(used) + Number(avail))) * 100) : 0;
    const cols = h
      ? `${fmt(size).padStart(5)} ${fmt(used).padStart(5)} ${fmt(avail).padStart(5)}`
      : `${fmt(size).padStart(9)} ${fmt(used).padStart(8)} ${fmt(avail).padStart(9)}`;
    return `${String(dev).padEnd(14)} ${showType ? String(type).padEnd(6) : ''}${cols} ${`${pct}%`.padStart(4)} ${mount}`;
  });
  return ctx.ok([header, ...lines].join('\n'));
}

function lsblk(ctx: LinuxContext): LinuxResult {
  const lines = ['NAME   MAJ:MIN RM  SIZE RO TYPE MOUNTPOINTS'];
  linuxDisks(ctx).forEach((d, i) => {
    lines.push(`${d.name.padEnd(6)}   8:${i * 16}    0 ${human(d.sizeMB).padStart(4)}  0 disk `);
    d.parts.forEach((p, j) => {
      const branch = j === d.parts.length - 1 ? '└─' : '├─';
      lines.push(`${(branch + p.dev.slice(5)).padEnd(6)}   8:${i * 16 + j + 1}    0 ${human(p.sizeMB).padStart(4)}  0 part ${p.mount ?? ''}`);
    });
  });
  return ctx.ok(lines.join('\n'));
}

// ---------- memory, time, lookup, history, environment ----------

function free(ctx: LinuxContext): LinuxResult {
  const opts = parseOptions(ctx.args, '', { human: 'h', mega: 'm', giga: 'g', kilo: 'k' });
  const kib = { total: 8148236, used: 1934520, free: 4120384, shared: 45872, cache: 2093332, avail: 5912500, swap: 4194300 };
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
    return ctx.ok(formatDate(new Date(), '%a %b %e %H:%M:%S %Z %Y'));
  }
  let when = new Date();
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
  uname: ctx => ctx.ok(ctx.args.includes('-a')
    ? `Linux ${ctx.state.hostname} 5.15.0-101-generic #111-Ubuntu SMP x86_64 GNU/Linux`
    : 'Linux'),
  dmesg: ctx => ctx.ok(DMESG),
  lspci: ctx => ctx.ok(LSPCI),
  lsmod: ctx => ctx.ok(LSMOD),
  journalctl: ctx => ctx.ok(JOURNAL),
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
