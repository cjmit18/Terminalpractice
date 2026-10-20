import React from 'react';
import { SystemState, VirtualDisk, VirtualDiskPartition } from '../types/terminal';
import { HardDrive } from 'lucide-react';
import { Button, SimPanel, SimToolbar, cx, thClass } from './sims/ui';

interface DiskpartSimProps {
  systemState: SystemState;
  onUpdateState?: (newState: SystemState) => void;
}

const formatSize = (mb: number) => {
  if (mb >= 1024) {
    const gb = mb / 1024;
    return `${gb >= 100 ? gb.toFixed(0) : gb.toFixed(1)} GB`;
  }
  return `${mb} MB`;
};

/** A partition entry with no filesystem and no primary flag is free space, not a partition. */
const isFreeEntry = (p: VirtualDiskPartition) => p.fsType === 'Unallocated' && !p.isPrimary;
/** Created with `create partition primary` but not formatted yet. */
const isRaw = (p: VirtualDiskPartition) => p.fsType === 'Unallocated' && !!p.isPrimary;

type Segment =
  | { kind: 'partition'; part: VirtualDiskPartition; sizeMB: number }
  | { kind: 'free'; sizeMB: number };

/** Turn the disk's partition list into what you'd see on screen: partitions plus whatever is left. */
const segmentsFor = (disk: VirtualDisk): { segments: Segment[]; scale: number } => {
  const parts = disk.partitions.filter(p => !isFreeEntry(p));
  const used = parts.reduce((sum, p) => sum + p.sizeMB, 0);
  const free = Math.max(0, disk.totalSizeMB - used);
  const segments: Segment[] = parts.map(part => ({ kind: 'partition', part, sizeMB: part.sizeMB }));
  if (free > 0) segments.push({ kind: 'free', sizeMB: free });
  return { segments, scale: Math.max(disk.totalSizeMB, used) };
};

const partName = (p: VirtualDiskPartition) => {
  const letter = p.driveLetter || '';
  if (letter && p.label) return `${p.label} (${letter})`;
  return letter || p.label || `Partition ${p.id}`;
};

const partDetail = (p: VirtualDiskPartition) => {
  if (isRaw(p)) return 'RAW, not formatted';
  if (p.label === 'EFI System') return 'EFI system partition';
  if (p.driveLetter === 'C:') return 'Boot, primary partition';
  return 'Primary partition';
};

const hatch: React.CSSProperties = {
  backgroundImage: 'repeating-linear-gradient(135deg, var(--line-strong) 0 1px, transparent 1px 7px)',
};

export const DiskpartSim: React.FC<DiskpartSimProps> = ({
  systemState,
  onUpdateState,
}) => {
  const handleSelectDisk = (diskNum: number) => {
    if (!onUpdateState) return;
    onUpdateState({
      ...systemState,
      diskpartSelectedDisk: diskNum,
      diskpartSelectedPartition: null,
    });
  };

  const handleCreatePartition = (diskNum: number) => {
    if (!onUpdateState) return;
    const updatedDisks = systemState.disks.map(d => {
      if (d.diskNumber === diskNum) {
        const nextId = d.partitions.length + 1;
        return {
          ...d,
          partitions: [
            ...d.partitions.filter(p => p.fsType !== 'Unallocated'),
            {
              id: nextId,
              sizeMB: 250000,
              fsType: 'Unallocated' as const,
              isPrimary: true,
            }
          ]
        };
      }
      return d;
    });
    onUpdateState({
      ...systemState,
      disks: updatedDisks,
      diskpartSelectedDisk: diskNum,
      diskpartSelectedPartition: 1,
    });
  };

  const handleFormatNTFS = (diskNum: number) => {
    if (!onUpdateState) return;
    const updatedDisks = systemState.disks.map(d => {
      if (d.diskNumber === diskNum) {
        const parts = d.partitions.map(p => {
          if (p.isPrimary && p.fsType === 'Unallocated') {
            return {
              ...p,
              fsType: 'NTFS' as const,
              label: 'DataDrive',
            };
          }
          return p;
        });
        return { ...d, partitions: parts };
      }
      return d;
    });
    onUpdateState({
      ...systemState,
      disks: updatedDisks,
    });
  };

  const handleAssignDriveLetter = (diskNum: number, letter = 'E:') => {
    if (!onUpdateState) return;
    const updatedDisks = systemState.disks.map(d => {
      if (d.diskNumber === diskNum) {
        const parts = d.partitions.map(p => {
          if (p.fsType === 'NTFS' && !p.driveLetter) {
            return { ...p, driveLetter: letter };
          }
          return p;
        });
        return { ...d, partitions: parts };
      }
      return d;
    });
    onUpdateState({
      ...systemState,
      disks: updatedDisks,
    });
  };

  const selected = systemState.disks.find(d => d.diskNumber === systemState.diskpartSelectedDisk) ?? null;
  const volumes = systemState.disks.flatMap(d =>
    d.partitions.filter(p => !isFreeEntry(p)).map(p => ({ disk: d, part: p })),
  );

  // What the selected disk is ready for next: create, then format, then assign a letter
  let nextAction: { label: string; command: string; run: () => void } | null = null;
  if (selected && onUpdateState) {
    const n = selected.diskNumber;
    const hasRaw = selected.partitions.some(isRaw);
    const hasUnassigned = selected.partitions.some(p => p.fsType === 'NTFS' && !p.driveLetter);
    const hasFree = segmentsFor(selected).segments.some(s => s.kind === 'free');
    if (hasRaw) nextAction = { label: 'Format as NTFS', command: 'format fs=ntfs quick', run: () => handleFormatNTFS(n) };
    else if (hasUnassigned) nextAction = { label: 'Assign letter E:', command: 'assign letter=E', run: () => handleAssignDriveLetter(n, 'E:') };
    else if (hasFree && selected.partitions.some(isFreeEntry))
      nextAction = { label: 'Create partition', command: 'create partition primary', run: () => handleCreatePartition(n) };
  }

  return (
    <SimPanel label="Disk Management">
      <SimToolbar
        title="Disk Management"
        context={selected ? `Disk ${selected.diskNumber} selected` : 'Select a disk to work on it'}
      >
        {nextAction && (
          <>
            <span className="hidden font-mono text-sm text-muted @xl:inline">{nextAction.command}</span>
            <Button variant="primary" onClick={nextAction.run}>{nextAction.label}</Button>
          </>
        )}
      </SimToolbar>

      <div className="min-h-0 flex-1 overflow-y-auto">
        {/* Volume list, as in the top half of the real console */}
        <div className="overflow-x-auto border-b border-line">
          <table className="w-full border-collapse text-sm">
            <caption className="sr-only">Volumes</caption>
            <thead>
              <tr className="border-b border-line">
                <th scope="col" className={thClass}>Volume</th>
                <th scope="col" className={thClass}>File system</th>
                <th scope="col" className={cx(thClass, 'hidden @lg:table-cell')}>Status</th>
                <th scope="col" className={cx(thClass, 'text-right')}>Capacity</th>
              </tr>
            </thead>
            <tbody>
              {volumes.map(({ disk, part }) => (
                <tr key={`${disk.diskNumber}-${part.id}`} className="border-b border-line last:border-b-0">
                  <th scope="row" className="px-3 py-1.5 text-left font-normal">
                    {partName(part)}
                    <span className="text-muted"> · Disk {disk.diskNumber}</span>
                  </th>
                  <td className="px-3 py-1.5">{isRaw(part) ? 'RAW' : part.fsType}</td>
                  <td className="hidden px-3 py-1.5 text-muted @lg:table-cell">
                    {isRaw(part) ? 'Not formatted' : `Healthy (${partDetail(part)})`}
                  </td>
                  <td className="px-3 py-1.5 text-right tabular-nums">{formatSize(part.sizeMB)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {/* Graphical view: one row per disk */}
        <ul className="space-y-3 p-4">
          {systemState.disks.map(disk => {
            const isSelected = systemState.diskpartSelectedDisk === disk.diskNumber;
            const { segments, scale } = segmentsFor(disk);
            return (
              <li key={disk.diskNumber} className="flex flex-col gap-2 @xl:flex-row @xl:items-stretch">
                <button
                  type="button"
                  onClick={() => handleSelectDisk(disk.diskNumber)}
                  aria-pressed={isSelected}
                  disabled={!onUpdateState}
                  className={cx(
                    'flex shrink-0 items-start gap-2 rounded-md border px-3 py-2 text-left text-sm @xl:w-40 @xl:flex-col @xl:gap-0',
                    isSelected ? 'border-accent bg-accent-soft' : 'border-line hover:bg-surface-2',
                    'disabled:cursor-default',
                  )}
                >
                  <span className="flex items-center gap-1.5 font-semibold">
                    <HardDrive className="h-4 w-4 text-muted" aria-hidden />
                    Disk {disk.diskNumber}
                  </span>
                  <span className="text-muted">
                    <span className="@xl:block">Basic, {disk.partitionTable}</span>
                    <span className="@xl:hidden"> · </span>
                    <span className="@xl:block">{formatSize(disk.totalSizeMB)}, {disk.status}</span>
                  </span>
                  <span className="hidden truncate text-xs text-muted @xl:block">{disk.model}</span>
                </button>

                <div
                  className="flex min-h-20 min-w-0 flex-1 overflow-hidden rounded-md border border-line"
                  role="img"
                  aria-label={`Disk ${disk.diskNumber} layout: ${segments
                    .map(s => (s.kind === 'free' ? `${formatSize(s.sizeMB)} unallocated` : `${partName(s.part)} ${formatSize(s.sizeMB)} ${isRaw(s.part) ? 'RAW' : s.part.fsType}`))
                    .join(', ')}`}
                >
                  {segments.map((s, i) => {
                    const grow = (s.sizeMB / scale) * 100;
                    // Proportional, but never so thin that the label can't be read
                    const style: React.CSSProperties = { flex: `${grow} 1 0%`, minWidth: '7rem' };
                    if (s.kind === 'free') {
                      // A leftover sliver (alignment gaps and the like) gets a thin strip, not a full label
                      const sliver = s.sizeMB / scale < 0.02;
                      return (
                        <div
                          key={`free-${i}`}
                          style={{ ...style, ...hatch, minWidth: sliver ? '1.25rem' : style.minWidth }}
                          title={sliver ? `${formatSize(s.sizeMB)} unallocated` : undefined}
                          className="flex flex-col justify-end border-l border-line px-2 py-1.5 text-sm first:border-l-0"
                        >
                          {!sliver && (
                            <>
                              <span className="w-fit bg-surface px-0.5 tabular-nums">{formatSize(s.sizeMB)}</span>
                              <span className="w-fit bg-surface px-0.5 text-muted">Unallocated</span>
                            </>
                          )}
                        </div>
                      );
                    }
                    const raw = isRaw(s.part);
                    return (
                      <div
                        key={s.part.id}
                        style={style}
                        className={cx(
                          'flex min-w-0 flex-col border-l border-t-4 border-l-line px-2 py-1.5 text-sm first:border-l-0',
                          raw ? 'border-t-warn' : 'border-t-accent',
                        )}
                      >
                        <span className="truncate font-medium">{partName(s.part)}</span>
                        <span className="truncate text-muted">
                          {formatSize(s.sizeMB)} {raw ? 'RAW' : s.part.fsType}
                        </span>
                        <span className="hidden truncate text-xs text-muted @lg:block">{partDetail(s.part)}</span>
                      </div>
                    );
                  })}
                </div>
              </li>
            );
          })}
        </ul>

        <div className="flex flex-wrap gap-x-5 gap-y-1 px-4 text-xs text-muted">
          <span className="inline-flex items-center gap-1.5">
            <span className="h-1 w-4 bg-accent" aria-hidden /> Primary partition
          </span>
          <span className="inline-flex items-center gap-1.5">
            <span className="h-1 w-4 bg-warn" aria-hidden /> Not formatted
          </span>
          <span className="inline-flex items-center gap-1.5">
            <span className="h-3 w-4 border border-line" style={hatch} aria-hidden /> Unallocated
          </span>
        </div>

        <p className="max-w-prose px-4 py-4 text-sm text-muted">
          The terminal and this view share the same disks. In a lab, run{' '}
          <code className="rounded-sm bg-surface-2 px-1">diskpart</code>, then{' '}
          <code className="rounded-sm bg-surface-2 px-1">select disk 1</code>,{' '}
          <code className="rounded-sm bg-surface-2 px-1">create partition primary</code>,{' '}
          <code className="rounded-sm bg-surface-2 px-1">format fs=ntfs quick</code> and{' '}
          <code className="rounded-sm bg-surface-2 px-1">assign letter=E</code>, and watch Disk 1 change here.
        </p>
      </div>
    </SimPanel>
  );
};
