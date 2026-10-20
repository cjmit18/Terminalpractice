import { createNode, describeIdentity } from '../../filesystem';
import { LinuxContext, LinuxResult, linuxCommands } from '../context';

// System, hardware, processes, services, packages, archives and help

const DMESG = [
  '[    0.000000] Linux version 5.15.0-101-generic (buildd@lcy02-amd64-072) (gcc version 11.4.0)',
  '[    0.000000] Command line: BOOT_IMAGE=/vmlinuz-5.15.0-101-generic root=UUID=8d6a8f1e ro quiet splash',
  '[    0.412891] ACPI: Core revision 20210604',
  '[    1.120542] pci 0000:00:1f.2: [8086:2922] SATA AHCI controller',
  '[    2.341209] e1000e: Intel(R) PRO/1000 Network Driver',
  '[    2.341512] e1000e 0000:00:19.0 eth0: (PCI Express:2.5GT/s:Width x1) 52:54:00:12:34:56',
  '[    3.150221] systemd[1]: Inserted module \'autofs4\'',
  '[    4.201944] EXT4-fs (sda1): mounted filesystem with ordered data mode. Opts: (null)',
].join('\n');

const LSPCI = [
  '00:00.0 Host bridge: Intel Corporation 440FX - 82441FX PMC [Natoma]',
  '00:01.0 ISA bridge: Intel Corporation 82371SB PIIX3 ISA [Natoma/Triton II]',
  '00:01.1 IDE interface: Intel Corporation 82371SB PIIX3 IDE [Natoma/Triton II]',
  '00:02.0 VGA compatible controller: Red Hat, Inc. QXL paravirtual graphic card',
  '00:03.0 Ethernet controller: Intel Corporation 82540EM Gigabit Ethernet Controller (rev 02)',
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
  'Oct 19 09:45:00 lpi-lab kernel: [ 120.40] EXT4-fs (sda1): re-mounted. Opts: errors=remount-ro',
  'Oct 19 10:00:22 lpi-lab sshd[1450]: Accepted publickey for student from 192.168.1.100 port 51220 ssh2',
  'Oct 19 10:15:30 lpi-lab nginx[2100]: [notice] configuration file /etc/nginx/nginx.conf test is successful',
].join('\n');

const DF = [
  'Filesystem     Type      Size  Used Avail Use% Mounted on',
  '/dev/sda1      ext4       40G   14G   24G  37% /',
  'tmpfs          tmpfs     3.9G     0  3.9G   0% /dev/shm',
  '/dev/sda2      ext4      488M  120M  333M  27% /boot',
  '/dev/sdb1      ext4      100G   22G   73G  24% /data',
].join('\n');

const FDISK_L = [
  'Disk /dev/sda: 50 GiB, 53687091200 bytes, 104857600 sectors',
  'Disk model: QEMU HARDDISK',
  'Units: sectors of 1 * 512 = 512 bytes',
  'Sector size (logical/physical): 512 bytes / 512 bytes',
  'Disklabel type: gpt',
  'Disk identifier: B7413988-E29B-4D14-884E-512E098F03C1',
  '',
  'Device        Start       End   Sectors  Size Type',
  '/dev/sda1      2048   1050623   1048576  512M EFI System',
  '/dev/sda2   1050624   9388031   8337408    4G Linux swap',
  '/dev/sda3   9388032 104855551  95467520 45.5G Linux filesystem',
].join('\n');

export const MAN_PAGES: { [key: string]: string } = {
  chmod: 'CHMOD(1)                 User Commands                CHMOD(1)\n\nNAME\n       chmod - change file mode bits\n\nSYNOPSIS\n       chmod [OPTION]... MODE[,MODE]... FILE...\n       chmod [OPTION]... OCTAL-MODE FILE...\n\nDESCRIPTION\n       chmod changes the file mode bits of each given file according to mode.\n       Mode can be octal (e.g. 755 = rwxr-xr-x) or symbolic (u+x, g-w).\n\nLPI EXAM NOTE:\n       Octal values: 4 = Read, 2 = Write, 1 = Execute.\n       SUID = 4000, SGID = 2000, Sticky Bit = 1000.',
  tar: 'TAR(1)                   User Commands                  TAR(1)\n\nNAME\n       tar - an archiving utility\n\nSYNOPSIS\n       tar [OPTION...] [FILE]...\n\nEXAMPLES\n       tar -czvf archive.tar.gz /path    Create gzipped archive\n       tar -xzvf archive.tar.gz          Extract gzipped archive\n       tar -tvf archive.tar              List archive contents',
  grep: 'GREP(1)                  User Commands                 GREP(1)\n\nNAME\n       grep - print lines matching a pattern\n\nSYNOPSIS\n       grep [OPTIONS] PATTERN [FILE...]\n\nOPTIONS\n       -i, --ignore-case\n       -v, --invert-match\n       -c, --count\n       -n, --line-number\n       -E, --extended-regexp',
  ps: 'PS(1)                    User Commands                   PS(1)\n\nNAME\n       ps - report a snapshot of the current processes.\n\nSYNOPSIS\n       ps [options]\n\nEXAMPLES\n       ps aux    Display all running processes with user, PID, CPU, MEM\n       ps -ef    Standard Unix syntax for all process list',
};

const NEEDS_ROOT = new Set(['restart', 'start', 'stop', 'reload', 'enable', 'disable']);

function systemctl(ctx: LinuxContext): LinuxResult {
  const sub = ctx.args[0] || 'status';
  const srvName = ctx.args[1] || '';
  if (sub === 'status') {
    if (!srvName) return ctx.ok('State: running\nJobs: 0 queued\nFailed: 0 units');
    if (srvName.includes('nginx')) {
      return ctx.ok(`● nginx.service - A high performance web server and a reverse proxy server\n   Loaded: loaded (/lib/systemd/system/nginx.service; enabled; vendor preset: enabled)\n   Active: active (running) since Sun 2026-10-19 10:14:00 UTC; 20min ago\n  Process: 1200 ExecStart=/usr/sbin/nginx (code=exited, status=0/SUCCESS)\n Main PID: 1201 (nginx)\n    Tasks: 2 (limit: 4614)\n   Memory: 4.8M\n   CGroup: /system.slice/nginx.service\n           ├─1201 nginx: master process /usr/sbin/nginx\n           └─1202 nginx: worker process`);
    }
    return ctx.ok(`● ${srvName}.service - Service\n   Active: active (running)`);
  }
  if (NEEDS_ROOT.has(sub) && !ctx.isRoot) {
    return ctx.fail(`Failed to ${sub} ${srvName}: Interactive authentication required or root privileges needed (try 'sudo systemctl ${sub} ${srvName}')`, 1,
      ctx.needsRoot(`systemctl ${sub} changes system-wide service state, so it`));
  }
  return ctx.ok();
}

function ps(ctx: LinuxContext): LinuxResult {
  const header = 'USER       PID %CPU %MEM    VSZ   RSS TTY      STAT START   TIME COMMAND';
  const rows = ctx.state.processes.map(p =>
    `${p.user.padEnd(8, ' ')} ${p.pid.toString().padStart(5, ' ')}  ${p.cpu.toFixed(1)}  ${p.mem.toFixed(1)}  24500  4210 ?        Ss   10:00   0:01 ${p.command}`);
  return ctx.ok(`${header}\n${rows.join('\n')}`);
}

function kill(ctx: LinuxContext): LinuxResult {
  const pid = parseInt(ctx.args[ctx.args.length - 1], 10);
  if (ctx.state.processes.some(p => p.pid === pid)) {
    ctx.state.processes = ctx.state.processes.filter(p => p.pid !== pid);
    return ctx.ok();
  }
  return ctx.fail(`kill: (${pid}) - No such process`);
}

function fdisk(ctx: LinuxContext): LinuxResult {
  const list = ctx.args.includes('-l');
  if (!list && !ctx.isRoot) {
    return ctx.fail('fdisk: cannot open /dev/sda: Permission denied', 1,
      `${describeIdentity(ctx.user, ctx.groups)} /dev/sda is owned by root:disk with mode brw-rw---- (660); you are not its owner and not in group 'disk', so the 'other' bits (---) apply, and they do not include read (r).`);
  }
  if (list) return ctx.ok(FDISK_L);
  return ctx.ok('Usage: fdisk [options] <disk>');
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

function man(ctx: LinuxContext): LinuxResult {
  const topic = ctx.args[0] || 'ls';
  return ctx.ok(MAN_PAGES[topic] || `MANUAL PAGE FOR '${topic}'\nNo manual entry for ${topic} in section 1`);
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
  df: ctx => ctx.ok(DF),
  systemctl,
  ps,
  kill,
  fdisk,
  apt,
  'apt-get': apt,
  tar,
  man,
});
