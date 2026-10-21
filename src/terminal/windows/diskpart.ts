import { FileNode, SystemState } from '../../types/terminal';
import { cloneFileSystem } from '../filesystem';
import { cloneState } from '../state';
import { WindowsResult } from './context';

// DiskPart interactive sub-shell. Each entry matches one DISKPART> command.

export const DISKPART_BANNER = [
  'Microsoft DiskPart version 10.0.22621.1',
  'Copyright (C) 1999-2026 Microsoft Corporation.',
  'On computer: WIN-CLIENT01',
  '',
  'DISKPART> ',
].join('\n');

type DiskpartHandler = (state: SystemState, match: RegExpMatchArray, original: string) => { stdout: string; exitCode?: number; active?: boolean };

const selectedDisk = (state: SystemState) => state.disks.find(d => d.diskNumber === state.diskpartSelectedDisk);
const selectedPartition = (state: SystemState) =>
  state.diskpartSelectedPartition === null ? undefined : selectedDisk(state)?.partitions.find(p => p.id === state.diskpartSelectedPartition);

const DISKPART_COMMANDS: [RegExp, DiskpartHandler][] = [
  [/^exit$/, () => ({ stdout: 'Leaving DiskPart...', active: false })],

  [/^list disk$/, state => {
    const lines = [
      '  Disk ###  Status         Size     Free     Dyn  Gpt',
      '  --------  -------------  -------  -------  ---  ---',
    ];
    for (const d of state.disks) {
      const isSel = state.diskpartSelectedDisk === d.diskNumber ? '*' : ' ';
      const gpt = d.partitionTable === 'GPT' ? '*' : ' ';
      const sizeGB = `${(d.totalSizeMB / 1024).toFixed(0)} GB`;
      lines.push(`${isSel} Disk ${d.diskNumber}    ${d.status.padEnd(13, ' ')}  ${sizeGB.padEnd(7, ' ')}  ${'0 B'.padEnd(7, ' ')}   ${' '}    ${gpt}`);
    }
    return { stdout: lines.join('\n') };
  }],

  [/^select\s+disk\s+(\d+)$/, (state, m) => {
    const dNum = parseInt(m[1], 10);
    if (!state.disks.find(d => d.diskNumber === dNum)) return { stdout: 'The disk you specified is not valid.', exitCode: 1 };
    state.diskpartSelectedDisk = dNum;
    state.diskpartSelectedPartition = null;
    return { stdout: `Disk ${dNum} is now the selected disk.` };
  }],

  [/^list partition$/, state => {
    if (state.diskpartSelectedDisk === null) {
      return { stdout: 'There is no disk selected to list partitions.\nSelect a disk and try again.', exitCode: 1 };
    }
    const lines = [
      '  Partition ###  Type              Size     Offset',
      '  -------------  ----------------  -------  -------',
    ];
    for (const p of selectedDisk(state)?.partitions ?? []) {
      const isSel = state.diskpartSelectedPartition === p.id ? '*' : ' ';
      lines.push(`${isSel} Partition ${p.id}   ${p.fsType.padEnd(16, ' ')}  ${p.sizeMB} MB   1024 KB`);
    }
    return { stdout: lines.join('\n') };
  }],

  [/^create partition primary/, state => {
    if (state.diskpartSelectedDisk === null) return { stdout: 'There is no disk selected.', exitCode: 1 };
    const disk = selectedDisk(state);
    if (disk) {
      const newPartId = disk.partitions.length + 1;
      disk.partitions.push({ id: newPartId, sizeMB: 250000, fsType: 'Unallocated', isPrimary: true });
      state.diskpartSelectedPartition = newPartId;
    }
    return { stdout: 'DiskPart succeeded in creating the specified partition.' };
  }],

  [/^select\s+partition\s+(\d+)$/, (state, m) => {
    if (state.diskpartSelectedDisk === null) return { stdout: 'There is no disk selected.\nPlease select a disk and try again.', exitCode: 1 };
    const id = parseInt(m[1], 10);
    if (!selectedDisk(state)?.partitions.some(p => p.id === id)) return { stdout: 'The specified partition is not valid.\nPlease select a valid partition.', exitCode: 1 };
    state.diskpartSelectedPartition = id;
    return { stdout: `Partition ${id} is now the selected partition.` };
  }],

  [/^format\b/, (state, m, original) => {
    const part = selectedPartition(state);
    if (!part) return { stdout: 'There is no volume selected.\nPlease select a volume and try again.', exitCode: 1 };
    const fsMatch = m.input!.match(/fs=(\w+)/);
    const fs = (fsMatch?.[1] ?? 'ntfs').toUpperCase();
    if (fs !== 'NTFS' && fs !== 'FAT32') return { stdout: `The file system "${fs}" is not supported here (use fs=ntfs or fs=fat32).`, exitCode: 1 };
    part.fsType = fs as 'NTFS' | 'FAT32';
    const lm = original.match(/label=(?:"([^"]+)"|(\S+))/i);
    const label = lm ? lm[1] ?? lm[2] : undefined;
    part.label = label ?? 'DataDrive';
    return { stdout: ['  100 percent completed', '', 'DiskPart successfully formatted the volume.'].join('\n') };
  }],

  [/^assign\b/, (state, m) => {
    const part = selectedPartition(state);
    if (!part) return { stdout: 'There is no volume selected.\nPlease select a volume and try again.', exitCode: 1 };
    const letterMatch = m.input!.match(/letter=([a-z])/);
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

const DISKPART_HELP = 'Microsoft DiskPart command interpreter\nCommands available: active, assign, clean, convert, create, delete, exit, format, list, select';

export function handleDiskpartCommand(line: string, cwd: string, fs: FileNode, state: SystemState): WindowsResult {
  const lower = line.toLowerCase().trim();
  const activeState = cloneState(state);
  const activeFs = cloneFileSystem(fs);
  for (const [pattern, handler] of DISKPART_COMMANDS) {
    const m = lower.match(pattern);
    if (!m) continue;
    const out = handler(activeState, m, line.trim());
    return {
      stdout: out.stdout,
      stderr: '',
      exitCode: out.exitCode ?? 0,
      newCwd: cwd,
      newFs: activeFs,
      newState: activeState,
      diskpartActive: out.active ?? true,
    };
  }
  return { stdout: DISKPART_HELP, stderr: '', exitCode: 0, newCwd: cwd, newFs: activeFs, newState: activeState, diskpartActive: true };
}
