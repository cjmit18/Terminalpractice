import { FileNode, SystemState, VirtualDisk, VirtualDiskPartition } from '../../types/terminal';
import { cloneFileSystem } from '../filesystem';
import { cloneState } from '../state';
import { WindowsResult } from './context';
import { DISKPART_VERSION, diskpartCommandList, diskpartHelp } from './help';

// DiskPart interactive sub-shell. Each entry matches one DISKPART> command.
//
// Partition model (shared with the DiskpartSim view): an entry with fsType 'Unallocated'
// and no isPrimary flag or label is a placeholder for free space, not a partition; a
// partition made by `create partition primary` is fsType 'Unallocated' with isPrimary
// set (RAW, no file system) until `format` gives it one.

export const DISKPART_BANNER = [
  DISKPART_VERSION,
  'Copyright (C) 1999-2026 Microsoft Corporation.',
  'On computer: WIN-CLIENT01',
  '',
  'DISKPART> ',
].join('\n');

type DiskpartHandler = (state: SystemState, match: RegExpMatchArray, original: string) => { stdout: string; exitCode?: number; active?: boolean };

const isFreeSpace = (p: VirtualDiskPartition) => p.fsType === 'Unallocated' && !p.isPrimary && !p.label;
const isRaw = (p: VirtualDiskPartition) => p.fsType === 'Unallocated' && !!p.isPrimary;
const isReserved = (p: VirtualDiskPartition) => p.fsType === 'Unallocated' && !p.isPrimary && !!p.label;
const isEfi = (p: VirtualDiskPartition) => p.label === 'EFI System';

/** Real partitions of a disk, free-space placeholders left out. */
export const partitionsOf = (d: VirtualDisk) => d.partitions.filter(p => !isFreeSpace(p));
/** Space not used by any partition. */
export const freeMB = (d: VirtualDisk) => Math.max(0, d.totalSizeMB - partitionsOf(d).reduce((n, p) => n + p.sizeMB, 0));

const selectedDisk = (state: SystemState) => state.disks.find(d => d.diskNumber === state.diskpartSelectedDisk);
const selectedPartition = (state: SystemState) =>
  state.diskpartSelectedPartition === null ? undefined : selectedDisk(state) && partitionsOf(selectedDisk(state)!).find(p => p.id === state.diskpartSelectedPartition);

/** Sizes as DiskPart prints them: 0 B, 128 MB, 250 GB. */
function size(mb: number): string {
  if (mb <= 0) return '0 B';
  if (mb < 1) return `${Math.round(mb * 1024)} KB`;
  if (mb < 1024) return `${Math.round(mb)} MB`;
  return `${Math.round(mb / 1024)} GB`;
}

const fsName = (p: VirtualDiskPartition) => (isRaw(p) ? 'RAW' : p.fsType);
const partType = (p: VirtualDiskPartition) => (isEfi(p) ? 'System' : isReserved(p) ? 'Reserved' : 'Primary');
const NO_DISK = 'There is no disk selected.\nPlease select a disk and try again.';
const NO_VOLUME = 'There is no volume selected.\nPlease select a volume and try again.';

interface Volume { number: number; disk: VirtualDisk; part: VirtualDiskPartition }

/** Volumes: every partition that holds (or is waiting for) a file system. */
function volumes(state: SystemState): Volume[] {
  const parts = state.disks.flatMap(disk => partitionsOf(disk).filter(p => !isReserved(p)).map(part => ({ disk, part })));
  // Like Windows, the system volume (C:) is found first
  parts.sort((a, b) => Number(b.part.driveLetter === 'C:') - Number(a.part.driveLetter === 'C:'));
  return parts.map((v, number) => ({ ...v, number }));
}

function volumeTable(state: SystemState, list: Volume[]): string {
  if (!list.length) return 'There are no volumes.';
  const sel = selectedPartition(state);
  const rows = list.map(v => {
    const info = v.part.driveLetter === 'C:' ? 'Boot' : isEfi(v.part) ? 'System' : '';
    const mark = v.part === sel ? '*' : ' ';
    return `${mark} Volume ${String(v.number).padEnd(3)}  ${(v.part.driveLetter ?? '').replace(':', '').padStart(2).padEnd(3)}  ${(v.part.label ?? '').slice(0, 11).padEnd(11)}  ${fsName(v.part).padEnd(5)}  ${'Partition'.padEnd(10)}  ${size(v.part.sizeMB).padStart(7)}  ${'Healthy'.padEnd(9)}  ${info}`.trimEnd();
  });
  return [
    '  Volume ###  Ltr  Label        Fs     Type        Size     Status     Info',
    '  ----------  ---  -----------  -----  ----------  -------  ---------  --------',
    ...rows,
  ].join('\n');
}

/** A stable made-up GUID per disk for DETAIL DISK. */
const diskGuid = (d: VirtualDisk) => `{${(0x4f1c2a00 + d.diskNumber).toString(16).toUpperCase()}-8A3B-4C2D-9E1F-${String(d.diskNumber).padStart(12, '0')}}`;

const DISKPART_COMMANDS: [RegExp, DiskpartHandler][] = [
  [/^exit$/, () => ({ stdout: 'Leaving DiskPart...', active: false })],

  [/^lis(?:t)?\s+dis(?:k)?$/, state => {
    const lines = [
      '  Disk ###  Status         Size     Free     Dyn  Gpt',
      '  --------  -------------  -------  -------  ---  ---',
    ];
    for (const d of state.disks) {
      const mark = state.diskpartSelectedDisk === d.diskNumber ? '*' : ' ';
      const gpt = d.partitionTable === 'GPT' ? '*' : ' ';
      lines.push(`${mark} Disk ${String(d.diskNumber).padEnd(3)}  ${d.status.padEnd(13)}  ${size(d.totalSizeMB).padStart(7)}  ${size(freeMB(d)).padStart(7)}        ${gpt}`.trimEnd());
    }
    return { stdout: lines.join('\n') };
  }],

  [/^sel(?:ect)?\s+dis(?:k)?\s*=?\s*(\d+)$/, (state, m) => {
    const dNum = parseInt(m[1], 10);
    if (!state.disks.find(d => d.diskNumber === dNum)) return { stdout: 'The disk you specified is not valid.', exitCode: 1 };
    state.diskpartSelectedDisk = dNum;
    state.diskpartSelectedPartition = null;
    return { stdout: `Disk ${dNum} is now the selected disk.` };
  }],

  [/^lis(?:t)?\s+par(?:t|ti|tit|titi|titio|tition)?$/, state => {
    const disk = selectedDisk(state);
    if (!disk) return { stdout: 'There is no disk selected to list partitions.\nSelect a disk and try again.', exitCode: 1 };
    const parts = partitionsOf(disk);
    if (!parts.length) return { stdout: 'There are no partitions on this disk to show.' };
    const lines = [
      '  Partition ###  Type              Size     Offset',
      '  -------------  ----------------  -------  -------',
    ];
    let offset = 1; // the first partition starts 1 MB into the disk
    for (const p of parts) {
      const mark = state.diskpartSelectedPartition === p.id ? '*' : ' ';
      lines.push(`${mark} Partition ${String(p.id).padEnd(3)}  ${partType(p).padEnd(16)}  ${size(p.sizeMB).padStart(7)}  ${(offset === 1 ? '1024 KB' : size(offset)).padStart(7)}`);
      offset += p.sizeMB;
    }
    return { stdout: lines.join('\n') };
  }],

  [/^lis(?:t)?\s+vol(?:u|um|ume)?$/, state => ({ stdout: volumeTable(state, volumes(state)) })],

  [/^cre(?:ate)?\s+par(?:tition)?\s+pri(?:mary)?(?:\s+(.*))?$/, (state, m) => {
    const disk = selectedDisk(state);
    if (!disk) return { stdout: NO_DISK, exitCode: 1 };
    const free = freeMB(disk);
    const sizeArg = (m[1] ?? '').match(/size\s*=\s*(\d+)/);
    const wanted = sizeArg ? Number(sizeArg[1]) : free;
    if (free < 1 || wanted > free) {
      return { stdout: 'Virtual Disk Service error:\nThere is not enough usable space for this operation.', exitCode: 1 };
    }
    const parts = partitionsOf(disk);
    const id = parts.reduce((n, p) => Math.max(n, p.id), 0) + 1;
    // the new partition takes the free space; DiskPart shows the rest as free again
    disk.partitions = [...parts, { id, sizeMB: wanted, fsType: 'Unallocated', isPrimary: true }];
    state.diskpartSelectedPartition = id;
    return { stdout: 'DiskPart succeeded in creating the specified partition.' };
  }],

  [/^sel(?:ect)?\s+par(?:tition)?\s*=?\s*(\d+)$/, (state, m) => {
    const disk = selectedDisk(state);
    if (!disk) return { stdout: NO_DISK, exitCode: 1 };
    const id = parseInt(m[1], 10);
    if (!partitionsOf(disk).some(p => p.id === id)) return { stdout: 'The specified partition is not valid.\nPlease select a valid partition.', exitCode: 1 };
    state.diskpartSelectedPartition = id;
    return { stdout: `Partition ${id} is now the selected partition.` };
  }],

  [/^sel(?:ect)?\s+vol(?:ume)?\s*=?\s*([a-z]:?|\d+)$/, (state, m) => {
    const key = m[1];
    const v = volumes(state).find(x => (/^\d+$/.test(key) ? x.number === Number(key) : (x.part.driveLetter ?? '').toLowerCase() === `${key[0]}:`));
    if (!v) return { stdout: 'The volume you selected is not valid or does not exist.', exitCode: 1 };
    state.diskpartSelectedDisk = v.disk.diskNumber;
    state.diskpartSelectedPartition = v.part.id;
    return { stdout: `Volume ${v.number} is the selected volume.` };
  }],

  [/^det(?:ail)?\s+dis(?:k)?$/, state => {
    const d = selectedDisk(state);
    if (!d) return { stdout: NO_DISK, exitCode: 1 };
    const system = partitionsOf(d).some(p => p.driveLetter === 'C:');
    const yn = (b: boolean) => (b ? 'Yes' : 'No');
    const vols = volumes(state).filter(v => v.disk === d);
    return {
      stdout: [
        d.model,
        `Disk ID: ${diskGuid(d)}`,
        `Type   : ${/nvme/i.test(d.model) ? 'NVMe' : 'SATA'}`,
        `Status : ${d.status}`,
        `Path   : 0`,
        `Target : ${d.diskNumber}`,
        'LUN ID : 0',
        `Current Read-only State : No`,
        'Read-only  : No',
        `Boot Disk  : ${yn(system)}`,
        `Pagefile Disk  : ${yn(system)}`,
        `Hibernation File Disk  : No`,
        `Crashdump Disk  : ${yn(system)}`,
        'Clustered Disk  : No',
        '',
        volumeTable(state, vols),
      ].join('\n'),
    };
  }],

  [/^det(?:ail)?\s+par(?:tition)?$/, state => {
    const p = selectedPartition(state);
    if (!p) return { stdout: 'There is no partition selected.\nPlease select a partition and try again.', exitCode: 1 };
    const type = isEfi(p) ? 'c12a7328-f81f-11d2-ba4b-00a0c93ec93b' : isReserved(p) ? 'e3c9e316-0b5c-4db8-817d-f92df00215ae' : 'ebd0a0a2-b9e5-4433-87c0-68b6b72699c7';
    const vol = volumes(state).filter(v => v.part === p);
    return {
      stdout: [
        `Partition ${p.id}`,
        `Type    : ${type}`,
        `Hidden  : ${isEfi(p) || isReserved(p) ? 'Yes' : 'No'}`,
        `Required: ${isEfi(p) ? 'Yes' : 'No'}`,
        'Attrib  : 0000000000000000',
        `Offset in Bytes: ${(1 + partitionsOf(selectedDisk(state)!).filter(x => x.id < p.id).reduce((n, x) => n + x.sizeMB, 0)) * 1048576}`,
        '',
        vol.length ? volumeTable(state, vol) : 'There is no volume associated with this partition.',
      ].join('\n'),
    };
  }],

  [/^format\b/, (state, m, original) => {
    const part = selectedPartition(state);
    if (!part) return { stdout: NO_VOLUME, exitCode: 1 };
    const fsMatch = m.input!.match(/fs\s*=\s*(\w+)/);
    const fs = (fsMatch?.[1] ?? 'ntfs').toUpperCase();
    if (fs !== 'NTFS' && fs !== 'FAT32') return { stdout: `The file system "${fs}" is not supported here (use fs=ntfs or fs=fat32).`, exitCode: 1 };
    part.fsType = fs as 'NTFS' | 'FAT32';
    const lm = original.match(/label\s*=\s*(?:"([^"]+)"|(\S+))/i);
    const label = lm ? lm[1] ?? lm[2] : undefined;
    part.label = label ?? 'DataDrive';
    return { stdout: ['  100 percent completed', '', 'DiskPart successfully formatted the volume.'].join('\n') };
  }],

  [/^assign\b/, (state, m) => {
    const part = selectedPartition(state);
    if (!part) return { stdout: NO_VOLUME, exitCode: 1 };
    const letterMatch = m.input!.match(/letter\s*=\s*([a-z])/);
    const used = new Set(state.disks.flatMap(d => d.partitions).map(p => (p.driveLetter ?? '').toUpperCase()).filter(Boolean));
    let letter = letterMatch ? `${letterMatch[1].toUpperCase()}:` : '';
    if (!letter) for (const c of 'DEFGHIJKLMNOPQRSTUVWXYZ') { if (!used.has(`${c}:`)) { letter = `${c}:`; break; } }
    if (used.has(letter) && (part.driveLetter ?? '').toUpperCase() !== letter) {
      return { stdout: 'Virtual Disk Service error:\nThe specified drive letter is not free to be assigned.', exitCode: 1 };
    }
    part.driveLetter = letter;
    return { stdout: 'DiskPart successfully assigned the drive letter or mount point.' };
  }],
];

export function handleDiskpartCommand(line: string, cwd: string, fs: FileNode, state: SystemState): WindowsResult {
  const lower = line.toLowerCase().trim().replace(/\s+/g, ' ');
  const activeState = cloneState(state);
  const activeFs = cloneFileSystem(fs);
  const result = (stdout: string, exitCode = 0, active = true): WindowsResult =>
    ({ stdout, stderr: '', exitCode, newCwd: cwd, newFs: activeFs, newState: activeState, diskpartActive: active });
  const help = diskpartHelp(line);
  if (help !== null) return result(help);
  for (const [pattern, handler] of DISKPART_COMMANDS) {
    const m = lower.match(pattern);
    if (!m) continue;
    const out = handler(activeState, m, line.trim());
    return result(out.stdout, out.exitCode ?? 0, out.active ?? true);
  }
  return result(diskpartCommandList());
}
