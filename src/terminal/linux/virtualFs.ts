import { FileNode, SystemState } from '../../types/terminal';

// Kernel-provided files: /proc and the device nodes in /dev. The kernel builds them from
// the running system, so they are regenerated from the lab state before each command and
// always agree with free, lsmod, df, lsblk and fdisk.

const STAMP = '2026-10-19T00:00:00Z';

/** Disk layout used when a lab state lists no disks (matches fdisk, df and lsblk). */
export const DEFAULT_LINUX_DISKS: SystemState['disks'] = [{
  diskNumber: 0, totalSizeMB: 51200, model: 'QEMU HARDDISK', status: 'Online', partitionTable: 'GPT',
  partitions: [
    { id: 1, sizeMB: 512, fsType: 'ext4', mountPoint: '/boot' },
    { id: 2, sizeMB: 4096, fsType: 'swap' },
    { id: 3, sizeMB: 46592, fsType: 'ext4', mountPoint: '/' },
  ],
}];

export const KERNEL_RELEASE = '5.15.0-101-generic';
export const KERNEL_VERSION = '#111-Ubuntu SMP Tue Mar 5 20:16:58 UTC 2024';

/** Memory figures in KiB, shared by free and /proc/meminfo. */
export const MEMORY_KIB = { total: 8148236, used: 1934520, free: 4120384, shared: 45872, buffers: 180212, cached: 1913120, avail: 5912500, swap: 4194300 };

/** Loaded modules: name, size, use count, modules using it (shared by lsmod and /proc/modules). */
export const MODULES: [string, number, number, string[]][] = [
  ['e1000e', 286720, 0, []],
  ['ext4', 962560, 1, []],
  ['crc16', 16384, 1, ['ext4']],
  ['mbcache', 16384, 1, ['ext4']],
  ['jbd2', 163840, 1, ['ext4']],
  ['ahci', 45056, 2, []],
  ['libahci', 49152, 1, ['ahci']],
];

/**
 * Sector layout of a disk's partitions, as fdisk lays them out: the first starts at sector 2048,
 * each follows the previous one, and none may run past the last usable sector. On GPT that is
 * total - 34, because the backup partition table fills the disk's last 33 sectors.
 */
export function partitionLayout(disk: SystemState['disks'][number]) {
  const total = disk.totalSizeMB * 2048;
  const lastUsable = disk.partitionTable === 'GPT' ? total - 34 : total - 1;
  let start = 2048;
  return disk.partitions.filter(p => p.fsType !== 'Unallocated').map(p => {
    const end = Math.min(start + p.sizeMB * 2048 - 1, lastUsable);
    const row = { id: p.id, start, end, sectors: end - start + 1 };
    start = end + 1;
    return row;
  });
}

/** Block devices for the lab's disks: sda, sda1 ... (sizes in MiB follow the sector layout) */
export function blockDevices(state: SystemState) {
  const disks = state.disks.length ? state.disks : DEFAULT_LINUX_DISKS;
  return disks.map(d => {
    const name = `sd${String.fromCharCode(97 + d.diskNumber)}`;
    const layout = partitionLayout(d);
    return {
      name,
      major: 8,
      minor: d.diskNumber * 16,
      sizeMB: d.totalSizeMB,
      parts: d.partitions.filter(p => p.fsType !== 'Unallocated').map((p, i) => ({
        name: `${name}${p.id}`, minor: d.diskNumber * 16 + p.id, sizeMB: layout[i].sectors / 2048, sectors: layout[i].sectors,
        fsType: p.fsType.toLowerCase(), mount: p.mountPoint,
      })),
    };
  });
}

const kernelFile = (name: string, content: string): FileNode =>
  ({ name, type: 'file', content, permissions: 'r--r--r--', octal: 444, owner: 'root', group: 'root', updatedAt: STAMP });

function cpuinfo(): string {
  return [0, 1].map(n => [
    `processor\t: ${n}`,
    'vendor_id\t: GenuineIntel',
    'cpu family\t: 6',
    'model\t\t: 79',
    'model name\t: Intel(R) Xeon(R) CPU E5-2680 v4 @ 2.40GHz',
    'stepping\t: 1',
    'cpu MHz\t\t: 2399.998',
    'cache size\t: 35840 KB',
    'physical id\t: 0',
    'siblings\t: 2',
    `core id\t\t: ${n}`,
    'cpu cores\t: 2',
    'flags\t\t: fpu vme de pse tsc msr pae mce cx8 apic sep mtrr pge mca cmov pat pse36 clflush mmx fxsr sse sse2 ht syscall nx lm constant_tsc rep_good nopl cpuid pni vmx ssse3 cx16 sse4_1 sse4_2 x2apic popcnt aes xsave avx f16c rdrand hypervisor lahf_lm abm avx2',
    'bogomips\t: 4799.99',
    'address sizes\t: 46 bits physical, 48 bits virtual',
    '',
  ].join('\n')).join('\n');
}

function meminfo(): string {
  const m = MEMORY_KIB;
  const rows: [string, number][] = [
    ['MemTotal', m.total], ['MemFree', m.free], ['MemAvailable', m.avail], ['Buffers', m.buffers], ['Cached', m.cached],
    ['SwapCached', 0], ['Active', 2210448], ['Inactive', 1324012], ['SwapTotal', m.swap], ['SwapFree', m.swap],
    ['Dirty', 112], ['Shmem', m.shared], ['Slab', 214800], ['PageTables', 9940], ['VmallocTotal', 34359738367],
    ['HugePages_Total', 0], ['Hugepagesize', 2048],
  ];
  return rows.map(([k, v]) => `${`${k}:`.padEnd(16)}${String(v).padStart(8)}${k.startsWith('HugePages_') ? '' : ' kB'}`).join('\n');
}

function partitions(state: SystemState): string {
  const rows = blockDevices(state).flatMap(d => [
    [d.major, d.minor, d.sizeMB * 1024, d.name] as const,
    ...d.parts.map(p => [d.major, p.minor, Math.floor(p.sectors / 2), p.name] as const),
  ]);
  return ['major minor  #blocks  name', '', ...rows.map(([ma, mi, b, n]) => `${String(ma).padStart(4)} ${String(mi).padStart(7)} ${String(b).padStart(10)} ${n}`)].join('\n');
}

function mounts(state: SystemState): string {
  const fsMounts = blockDevices(state).flatMap(d => d.parts.filter(p => p.mount).map(p =>
    `/dev/${p.name} ${p.mount} ${p.fsType} rw,relatime${p.mount === '/' ? ',errors=remount-ro' : ''} 0 0`));
  return [
    'sysfs /sys sysfs rw,nosuid,nodev,noexec,relatime 0 0',
    'proc /proc proc rw,nosuid,nodev,noexec,relatime 0 0',
    'udev /dev devtmpfs rw,nosuid,relatime,size=4027096k,nr_inodes=1006774,mode=755 0 0',
    ...fsMounts,
    'tmpfs /dev/shm tmpfs rw,nosuid,nodev 0 0',
    'tmpfs /run tmpfs rw,nosuid,nodev,noexec,relatime,size=814824k,mode=755 0 0',
  ].join('\n');
}

const modules = () => MODULES.map(([n, size, count, users]) =>
  `${n} ${size} ${count} ${users.map(u => `${u},`).join('') || '-'} Live 0x0000000000000000`).join('\n');

function device(name: string, kind: 'block' | 'char', group: string, octal: number): FileNode {
  const perms = octal === 666 ? 'rw-rw-rw-' : 'rw-rw----';
  return { name, type: 'file', device: kind, content: '', permissions: perms, octal, owner: 'root', group, updatedAt: STAMP };
}

function dir(name: string, octal: number, children: Record<string, FileNode>): FileNode {
  const perms = octal === 555 ? 'r-xr-xr-x' : 'rwxr-xr-x';
  return { name, type: 'directory', permissions: perms, octal, owner: 'root', group: 'root', updatedAt: STAMP, children };
}

/** Rebuilds /proc and the device nodes of /dev in a (working copy of a) Linux filesystem. */
export function syncKernelFiles(fs: FileNode, state: SystemState): void {
  const root = fs.children;
  if (!root) return;
  const proc: Record<string, FileNode> = {
    cpuinfo: kernelFile('cpuinfo', cpuinfo()),
    meminfo: kernelFile('meminfo', meminfo()),
    version: kernelFile('version', `Linux version ${KERNEL_RELEASE} (buildd@lcy02-amd64-072) (x86_64-linux-gnu-gcc (Ubuntu 11.4.0-1ubuntu1~22.04) 11.4.0, GNU ld (GNU Binutils for Ubuntu) 2.38) ${KERNEL_VERSION}`),
    partitions: kernelFile('partitions', partitions(state)),
    mounts: kernelFile('mounts', mounts(state)),
    modules: kernelFile('modules', modules()),
    cmdline: kernelFile('cmdline', `BOOT_IMAGE=/vmlinuz-${KERNEL_RELEASE} root=UUID=8d6a8f1e-3a9b-4c22-b5e1-8f432176b912 ro quiet splash`),
    swaps: kernelFile('swaps', ['Filename\t\t\t\tType\t\tSize\t\tUsed\t\tPriority',
      ...blockDevices(state).flatMap(d => d.parts.filter(p => p.fsType === 'swap').map(p => `/dev/${p.name}                               partition\t${Math.floor(p.sectors / 2)}\t\t0\t\t-2`))].join('\n')),
  };
  root.proc = dir('proc', 555, proc);

  const dev = root.dev?.type === 'directory' ? root.dev : dir('dev', 755, {});
  const kept = Object.fromEntries(Object.entries(dev.children ?? {}).filter(([n]) => !/^sd[a-z]\d*$/.test(n)));
  const blocks = Object.fromEntries(blockDevices(state).flatMap(d => [d.name, ...d.parts.map(p => p.name)]).map(n => [n, device(n, 'block', 'disk', 660)]));
  dev.children = {
    null: device('null', 'char', 'root', 666),
    zero: device('zero', 'char', 'root', 666),
    random: device('random', 'char', 'root', 666),
    urandom: device('urandom', 'char', 'root', 666),
    tty: device('tty', 'char', 'tty', 666),
    ...kept,
    ...blocks,
  };
  root.dev = dev;
}
