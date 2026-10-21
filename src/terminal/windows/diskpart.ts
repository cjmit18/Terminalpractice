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
  '',
  'Copyright (C) Microsoft Corporation.',
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

/**
 * Parses DiskPart's KEY=value and flag arguments. Returns null (the "not valid" error) for an
 * unknown word, a value that does not match its pattern, or a key written without "=".
 */
function parseOptions(text: string, values: Record<string, RegExp>, flags: string[]): Record<string, string> | null {
  const words = text.replace(/\s*=\s*/g, '=').match(/(?:[^\s"]+|"[^"]*")+/g) ?? [];
  const out: Record<string, string> = {};
  for (const w of words) {
    const eq = w.indexOf('=');
    if (eq < 0) {
      if (!flags.includes(w.toLowerCase())) return null;
      out[w.toLowerCase()] = 'true';
      continue;
    }
    const key = w.slice(0, eq).toLowerCase();
    const value = w.slice(eq + 1).replace(/^"(.*)"$/, '$1');
    if (!values[key] || !values[key].test(value.toLowerCase())) return null;
    out[key] = value;
  }
  return out;
}

const invalidArgs = (command: string) => ({
  stdout: `The arguments specified for this command are not valid.\nFor more information on the command type: HELP ${command}`,
  exitCode: 1,
});

/** True when the partition holds the running system (C:) or is the EFI/MSR partition. */
const isProtected = (p: VirtualDiskPartition) => p.driveLetter === 'C:' || isEfi(p) || isReserved(p);

const DISKPART_COMMANDS: [RegExp, DiskpartHandler][] = [
  [/^clean(?:\s+all)?$/, state => {
    const disk = selectedDisk(state);
    if (!disk) return { stdout: NO_DISK, exitCode: 1 };
    if (partitionsOf(disk).some(p => p.driveLetter === 'C:')) {
      return { stdout: 'Virtual Disk Service error:\nClean is not allowed on the disk containing the current boot,\nsystem, pagefile, crashdump or hibernation volume.', exitCode: 1 };
    }
    // The partition table is wiped: the disk is uninitialized (shown as MBR) and all free
    disk.partitions = [{ id: 1, sizeMB: disk.totalSizeMB, fsType: 'Unallocated' }];
    disk.partitionTable = 'MBR';
    state.diskpartSelectedPartition = null;
    return { stdout: 'DiskPart succeeded in cleaning the disk.' };
  }],

  [/^conv(?:ert)?\s+(gpt|mbr|dynamic|basic)(?:\s+noerr)?$/, (state, m) => {
    const disk = selectedDisk(state);
    if (!disk) return { stdout: NO_DISK, exitCode: 1 };
    const style = m[1];
    if (style === 'dynamic' || style === 'basic') return { stdout: 'Dynamic disks are not simulated here.', exitCode: 1 };
    // Only an empty disk can change partition style (CLEAN it first)
    if (partitionsOf(disk).length) {
      return { stdout: 'Virtual Disk Service error:\nThe specified disk is not convertible. CDROMs and DVDs\nare examples of disks that are not convertible.', exitCode: 1 };
    }
    disk.partitionTable = style === 'gpt' ? 'GPT' : 'MBR';
    return { stdout: `DiskPart successfully converted the selected disk to ${style.toUpperCase()} format.` };
  }],

  [/^active$/, state => {
    const disk = selectedDisk(state);
    if (!disk) return { stdout: NO_DISK, exitCode: 1 };
    const part = selectedPartition(state);
    if (!part) return { stdout: 'There is no partition selected.\nPlease select a partition and try again.', exitCode: 1 };
    if (disk.partitionTable === 'GPT') {
      return { stdout: 'The selected disk is not a fixed MBR disk.\nThe ACTIVE command can only be used on fixed MBR disks.', exitCode: 1 };
    }
    for (const p of disk.partitions) p.isActive = p === part;
    return { stdout: 'DiskPart marked the current partition as active.' };
  }],

  [/^del(?:ete)?\s+(par(?:tition)?|vol(?:ume)?)(?:\s+(override|noerr))*$/, (state, m) => {
    const disk = selectedDisk(state);
    const part = selectedPartition(state);
    const isVolume = m[1].startsWith('vol');
    if (!disk || !part) return { stdout: isVolume ? NO_VOLUME : 'There is no partition selected.\nPlease select a partition and try again.', exitCode: 1 };
    if (isProtected(part)) {
      return { stdout: 'Virtual Disk Service error:\nCannot delete a protected partition without the force protected parameter set.', exitCode: 1 };
    }
    disk.partitions = disk.partitions.filter(p => p !== part);
    state.diskpartSelectedPartition = null;
    return { stdout: isVolume ? 'DiskPart successfully deleted the volume.' : 'DiskPart successfully deleted the selected partition.' };
  }],

  [/^ext(?:end)?(?:\s+(.*))?$/, (state, m) => {
    const opts = parseOptions(m[1] ?? '', { size: /^\d+$/, disk: /^\d+$/ }, ['noerr', 'filesystem']);
    if (!opts) return invalidArgs('EXTEND');
    const disk = selectedDisk(state);
    const part = selectedPartition(state);
    if (!disk || !part) return { stdout: NO_VOLUME, exitCode: 1 };
    const free = freeMB(disk);
    const grow = opts.size !== undefined ? Number(opts.size) : free;
    if (free < 1 || grow > free) return { stdout: 'Virtual Disk Service error:\nThere is not enough usable space for this operation.', exitCode: 1 };
    part.sizeMB += grow;
    return { stdout: 'DiskPart successfully extended the volume.' };
  }],

  [/^(offline|online|remove|rescan|shrink|attributes|automount|break|compact|expand|filesystems|gpt|import|inactive|merge|recover|repair|retain|san|setid|uniqueid|attach|detach)\b/, (_, m) =>
    ({ stdout: `The ${m[1].toUpperCase()} command exists in DiskPart but is not simulated here.`, exitCode: 1 })],

  [/^exit$/, () => ({ stdout: 'Leaving DiskPart...', active: false })],

  // REM starts a comment (used in diskpart /s scripts)
  [/^rem\b/, () => ({ stdout: '' })],

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
    // SIZE is a plain number of megabytes: SIZE=50GB is rejected, not read as 50
    const opts = parseOptions(m[1] ?? '', { size: /^\d+$/, offset: /^\d+$/, id: /^\S+$/, align: /^\d+$/ }, ['noerr']);
    if (!opts) return invalidArgs('CREATE PARTITION PRIMARY');
    const disk = selectedDisk(state);
    if (!disk) return { stdout: NO_DISK, exitCode: 1 };
    const free = freeMB(disk);
    const wanted = opts.size !== undefined ? Number(opts.size) : free;
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

  [/^cre(?:ate)?\s+(par(?:tition)?\s+(?:ext|log|efi|msr)\w*|vol\w*|vdisk)\b/, () =>
    ({ stdout: 'Only CREATE PARTITION PRIMARY is simulated here; this CREATE command exists in DiskPart but is not simulated.', exitCode: 1 })],

  [/^sel(?:ect)?\s+par(?:tition)?\s*=?\s*(\d+)$/,(state, m) => {
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

  [/^format(?:\s+(.*))?$/, (state, m, original) => {
    const opts = parseOptions(original.replace(/^\s*format\s*/i, ''), { fs: /^\w+$/, label: /^.*$/, unit: /^\S+$/, revision: /^[\d.]+$/ },
      ['quick', 'compress', 'override', 'duplicate', 'nowait', 'noerr', 'recommended']);
    if (!opts) return invalidArgs('FORMAT');
    const part = selectedPartition(state);
    if (!part) return { stdout: NO_VOLUME, exitCode: 1 };
    const fs = (opts.fs ?? 'ntfs').toUpperCase();
    if (fs !== 'NTFS' && fs !== 'FAT32') return { stdout: `The file system "${fs}" is not supported here (use fs=ntfs or fs=fat32).`, exitCode: 1 };
    part.fsType = fs as 'NTFS' | 'FAT32';
    // Without LABEL= the volume has no label
    part.label = opts.label ?? '';
    return { stdout: ['  100 percent completed', '', 'DiskPart successfully formatted the volume.'].join('\n') };
  }],

  [/^assign(?:\s+(.*))?$/, (state, m) => {
    // Only LETTER=E (or MOUNT=path) is valid; "assign letter E" is not
    const opts = parseOptions(m[1] ?? '', { letter: /^[a-z]:?$/, mount: /^\S+$/ }, ['noerr']);
    if (!opts) return invalidArgs('ASSIGN');
    const part = selectedPartition(state);
    if (!part) return { stdout: NO_VOLUME, exitCode: 1 };
    if (opts.mount) return { stdout: 'Mount points are not simulated here; use LETTER=<D>.', exitCode: 1 };
    const used = new Set(state.disks.flatMap(d => d.partitions).map(p => (p.driveLetter ?? '').toUpperCase()).filter(Boolean));
    let letter = opts.letter ? `${opts.letter[0].toUpperCase()}:` : '';
    if (!letter) for (const c of 'DEFGHIJKLMNOPQRSTUVWXYZ') { if (!used.has(`${c}:`)) { letter = `${c}:`; break; } }
    if (used.has(letter) && (part.driveLetter ?? '').toUpperCase() !== letter) {
      return { stdout: 'Virtual Disk Service error:\nThe specified drive letter is not free to be assigned.', exitCode: 1 };
    }
    part.driveLetter = letter;
    return { stdout: 'DiskPart successfully assigned the drive letter or mount point.' };
  }],
];

// DiskPart accepts any keyword shortened to three or more letters (sel dis 1, create part pri,
// form fs=ntfs quick). Where a prefix fits several verbs, the more common one comes first.
const VERBS = ['list', 'select', 'create', 'delete', 'detail', 'format', 'assign', 'clean', 'convert', 'active', 'extend', 'exit', 'help',
  'rem', 'offline', 'online', 'remove', 'rescan', 'shrink', 'attributes', 'automount', 'break', 'compact', 'expand', 'filesystems',
  'gpt', 'import', 'inactive', 'merge', 'recover', 'repair', 'retain', 'san', 'setid', 'uniqueid', 'attach', 'detach', 'add'];
const OBJECTS = ['disk', 'partition', 'volume', 'vdisk'];
const PARTITION_TYPES = ['primary', 'extended', 'logical', 'efi', 'msr'];
const STYLES = ['gpt', 'mbr', 'dynamic', 'basic'];

function keyword(word: string, list: string[]): string {
  const w = word.toLowerCase();
  if (list.includes(w)) return w;
  return (w.length >= 3 && list.find(k => k.startsWith(w))) || word;
}

/** The line with its keywords spelled out in full; values (label=..., size=...) keep their case. */
export function expandDiskpartKeywords(line: string): string {
  const words = line.trim().split(/\s+/);
  if (!words[0]) return '';
  words[0] = keyword(words[0], VERBS);
  const verb = words[0].toLowerCase();
  if (words[1] !== undefined) {
    if (verb === 'help') words[1] = keyword(words[1], VERBS);
    else if (verb === 'convert') words[1] = keyword(words[1], STYLES);
    else if (['list', 'select', 'create', 'delete', 'detail', 'offline', 'online', 'attributes', 'attach', 'detach', 'compact', 'expand', 'merge', 'uniqueid', 'inactive'].includes(verb)) {
      // select disk=1 is the same as select disk 1
      const [obj, ...rest] = words[1].split('=');
      words[1] = [keyword(obj, OBJECTS), ...rest].join('=');
    }
  }
  if (verb === 'create' && words[1]?.toLowerCase() === 'partition' && words[2] !== undefined) words[2] = keyword(words[2], PARTITION_TYPES);
  return words.join(' ');
}

export function handleDiskpartCommand(rawLine: string, cwd: string, fs: FileNode, state: SystemState): WindowsResult {
  const line = expandDiskpartKeywords(rawLine);
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
