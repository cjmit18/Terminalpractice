import React from 'react';
import { SystemState } from '../types/terminal';
import { HardDrive, Layers, CheckCircle2, Disc } from 'lucide-react';

interface DiskpartSimProps {
  systemState: SystemState;
  onUpdateState?: (newState: SystemState) => void;
}

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

  return (
    <div className="flex flex-col h-full bg-slate-900/90 border border-slate-800 rounded-xl overflow-hidden shadow-xl text-xs font-sans">
      {/* Title Bar */}
      <div className="flex items-center justify-between px-4 py-2.5 bg-slate-950 border-b border-slate-800">
        <div className="flex items-center gap-2">
          <HardDrive className="w-4 h-4 text-emerald-400" />
          <span className="font-semibold text-slate-200">Disk Management & Partition Table Visualizer (diskmgmt.msc)</span>
        </div>
        <div className="text-[11px] text-slate-400 font-mono">
          Focus: {systemState.diskpartSelectedDisk !== null ? `Disk ${systemState.diskpartSelectedDisk} Selected` : 'No disk selected'}
        </div>
      </div>

      {/* Main Visualizer Container */}
      <div className="flex-1 p-4 overflow-y-auto space-y-4">
        {systemState.disks.map((disk) => {
          const isSelected = systemState.diskpartSelectedDisk === disk.diskNumber;
          const hasUnallocated = disk.partitions.some(p => p.fsType === 'Unallocated');
          const hasUnformattedPrimary = disk.partitions.some(p => p.isPrimary && p.fsType === 'Unallocated');
          const hasUnassignedNTFS = disk.partitions.some(p => p.fsType === 'NTFS' && !p.driveLetter);

          return (
            <div
              key={disk.diskNumber}
              onClick={() => handleSelectDisk(disk.diskNumber)}
              className={`p-3.5 rounded-xl border transition-all cursor-pointer ${
                isSelected
                  ? 'border-emerald-500/50 bg-slate-950/90 ring-1 ring-emerald-500/30'
                  : 'border-slate-800 bg-slate-950/40 hover:border-slate-700'
              }`}
            >
              <div className="flex items-center justify-between mb-2">
                <div className="flex items-center gap-2">
                  <Disc className="w-4 h-4 text-emerald-400" />
                  <span className="font-bold text-slate-200">Disk {disk.diskNumber}</span>
                  <span className="text-[11px] text-slate-400 font-mono">
                    ({disk.model} - {(disk.totalSizeMB / 1024).toFixed(0)} GB)
                  </span>
                  <span className="px-2 py-0.5 rounded text-[10px] font-mono bg-slate-800 text-slate-300">
                    {disk.partitionTable}
                  </span>
                  <span className="px-2 py-0.5 rounded text-[10px] font-mono bg-emerald-500/15 text-emerald-300">
                    {disk.status}
                  </span>
                </div>

                {/* Quick actions for simulator mode */}
                <div className="flex items-center gap-1.5" onClick={(e) => e.stopPropagation()}>
                  {hasUnallocated && !hasUnformattedPrimary && (
                    <button
                      onClick={() => handleCreatePartition(disk.diskNumber)}
                      className="px-2 py-1 rounded bg-blue-600 hover:bg-blue-500 text-white text-[11px] font-medium"
                    >
                      + Create Partition
                    </button>
                  )}
                  {hasUnformattedPrimary && (
                    <button
                      onClick={() => handleFormatNTFS(disk.diskNumber)}
                      className="px-2 py-1 rounded bg-amber-600 hover:bg-amber-500 text-white text-[11px] font-medium"
                    >
                      Format NTFS Quick
                    </button>
                  )}
                  {hasUnassignedNTFS && (
                    <button
                      onClick={() => handleAssignDriveLetter(disk.diskNumber, 'E:')}
                      className="px-2 py-1 rounded bg-emerald-600 hover:bg-emerald-500 text-white text-[11px] font-medium"
                    >
                      Assign E:
                    </button>
                  )}
                </div>
              </div>

              {/* Graphical Partition Strip */}
              <div className="flex w-full h-20 rounded-lg overflow-hidden border border-slate-700/80 bg-slate-900 mt-2">
                {disk.partitions.length === 0 ? (
                  <div className="flex-1 flex flex-col items-center justify-center bg-slate-900 text-slate-400 border border-dashed border-slate-700">
                    <span className="font-semibold text-xs">Unallocated Space</span>
                    <span className="text-[11px] font-mono">{(disk.totalSizeMB / 1024).toFixed(0)} GB Unallocated</span>
                  </div>
                ) : (
                  disk.partitions.map((part) => {
                    const pct = Math.max(15, Math.min(100, (part.sizeMB / disk.totalSizeMB) * 100));
                    const isUnallocated = part.fsType === 'Unallocated';
                    const isSystem = part.driveLetter === 'C:' || part.mountPoint === '/';

                    return (
                      <div
                        key={part.id}
                        style={{ width: `${pct}%` }}
                        className={`h-full border-r border-slate-700/80 p-2 flex flex-col justify-between transition-colors ${
                          isUnallocated
                            ? 'bg-slate-900/90 text-slate-400 border-dashed'
                            : isSystem
                            ? 'bg-blue-950/60 text-blue-200 border-blue-500/30'
                            : 'bg-emerald-950/60 text-emerald-200 border-emerald-500/30'
                        }`}
                      >
                        <div className="flex items-center justify-between">
                          <span className="font-bold text-xs truncate">
                            {part.driveLetter ? `${part.driveLetter} (${part.label || 'Volume'})` : part.label || `Partition ${part.id}`}
                          </span>
                          <span className="text-[10px] font-mono px-1.5 py-0.2 rounded bg-black/40">
                            {part.fsType}
                          </span>
                        </div>
                        <div className="flex items-center justify-between text-[11px] font-mono text-slate-400">
                          <span>{(part.sizeMB >= 1024 ? `${(part.sizeMB / 1024).toFixed(1)} GB` : `${part.sizeMB} MB`)}</span>
                          <span className="text-[10px] text-slate-400">
                            {part.isPrimary ? 'Primary' : 'System'}
                          </span>
                        </div>
                      </div>
                    );
                  })
                )}
              </div>
            </div>
          );
        })}

        {/* Informational Guidance Box */}
        <div className="p-3.5 rounded-lg bg-slate-950 border border-slate-800 text-[11px] text-slate-400 space-y-1.5">
          <div className="font-semibold text-slate-200 flex items-center gap-1.5">
            <Layers className="w-3.5 h-3.5 text-cyan-400" />
            <span>Interactive Terminal & Graphic Synchronization</span>
          </div>
          <p className="leading-relaxed">
            Running commands in the terminal (e.g. <code className="text-cyan-300">diskpart</code> &rarr; <code className="text-cyan-300">select disk 1</code> &rarr; <code className="text-cyan-300">create partition primary</code> &rarr; <code className="text-cyan-300">format fs=ntfs quick</code> &rarr; <code className="text-cyan-300">assign letter=E</code> or Linux <code className="text-cyan-300">fdisk -l</code>) directly updates this physical disk representation in real time.
          </p>
        </div>
      </div>
    </div>
  );
};
