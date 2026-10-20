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

type DiskpartHandler = (state: SystemState, match: RegExpMatchArray) => { stdout: string; exitCode?: number; active?: boolean };

const selectedDisk = (state: SystemState) => state.disks.find(d => d.diskNumber === state.diskpartSelectedDisk);

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

  [/^format/, state => {
    if (state.diskpartSelectedDisk === null) return { stdout: 'There is no volume/partition selected.', exitCode: 1 };
    const disk = selectedDisk(state);
    if (disk && disk.partitions.length > 0) {
      const p = disk.partitions[disk.partitions.length - 1];
      p.fsType = 'NTFS';
      p.label = 'DataDrive';
    }
    return { stdout: ['  100 percent completed', '', 'DiskPart successfully formatted the volume.'].join('\n') };
  }],

  [/^assign/, (state, m) => {
    const letterMatch = m.input!.match(/letter=([a-z])/);
    const letter = letterMatch ? letterMatch[1].toUpperCase() : 'E';
    const disk = selectedDisk(state);
    if (disk && disk.partitions.length > 0) disk.partitions[disk.partitions.length - 1].driveLetter = `${letter}:`;
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
    const out = handler(activeState, m);
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
