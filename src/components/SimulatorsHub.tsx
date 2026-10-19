import React, { useState } from 'react';
import { SystemState } from '../types/terminal';
import { ActiveDirectorySim } from './ActiveDirectorySim';
import { GroupPolicySim } from './GroupPolicySim';
import { DiskpartSim } from './DiskpartSim';
import { NetworkTopologySim } from './NetworkTopologySim';
import { PermissionMatrixSim } from './PermissionMatrixSim';
import { Users, Settings, HardDrive, Radio, Key, Layers } from 'lucide-react';

interface SimulatorsHubProps {
  systemState: SystemState;
  onUpdateState: (newState: SystemState) => void;
}

export const SimulatorsHub: React.FC<SimulatorsHubProps> = ({
  systemState,
  onUpdateState,
}) => {
  const [activeSim, setActiveSim] = useState<'ad' | 'gpo' | 'disk' | 'network' | 'chmod'>('ad');

  return (
    <div className="flex flex-col h-[calc(100vh-65px)] bg-slate-950 overflow-hidden font-sans">
      {/* Simulators Navigation Header */}
      <div className="px-6 py-3.5 bg-slate-900/60 border-b border-slate-800 shrink-0 flex flex-wrap items-center justify-between gap-4">
        <div>
          <h1 className="text-base font-bold text-white tracking-tight flex items-center gap-2">
            <Layers className="w-4 h-4 text-emerald-400" />
            <span>Interactive System Configuration Simulators</span>
          </h1>
          <p className="text-[11px] text-slate-400 mt-0.5">
            Hands-on visual tools modeled after real enterprise administrative consoles and operating system kernel models.
          </p>
        </div>

        {/* 5 Simulator Selectors */}
        <div className="flex items-center gap-1.5 p-1 bg-slate-900 rounded-lg border border-slate-800 text-xs font-medium overflow-x-auto">
          <button
            onClick={() => setActiveSim('ad')}
            className={`flex items-center gap-1.5 px-3 py-1.5 rounded-md transition-colors whitespace-nowrap ${
              activeSim === 'ad'
                ? 'bg-blue-600 text-white font-semibold shadow-sm'
                : 'text-slate-400 hover:text-slate-200'
            }`}
          >
            <Users className="w-3.5 h-3.5" />
            <span>Active Directory (ADUC)</span>
          </button>

          <button
            onClick={() => setActiveSim('gpo')}
            className={`flex items-center gap-1.5 px-3 py-1.5 rounded-md transition-colors whitespace-nowrap ${
              activeSim === 'gpo'
                ? 'bg-cyan-600 text-white font-semibold shadow-sm'
                : 'text-slate-400 hover:text-slate-200'
            }`}
          >
            <Settings className="w-3.5 h-3.5" />
            <span>Group Policy (GPMC)</span>
          </button>

          <button
            onClick={() => setActiveSim('disk')}
            className={`flex items-center gap-1.5 px-3 py-1.5 rounded-md transition-colors whitespace-nowrap ${
              activeSim === 'disk'
                ? 'bg-emerald-600 text-white font-semibold shadow-sm'
                : 'text-slate-400 hover:text-slate-200'
            }`}
          >
            <HardDrive className="w-3.5 h-3.5" />
            <span>Disk Management</span>
          </button>

          <button
            onClick={() => setActiveSim('network')}
            className={`flex items-center gap-1.5 px-3 py-1.5 rounded-md transition-colors whitespace-nowrap ${
              activeSim === 'network'
                ? 'bg-purple-600 text-white font-semibold shadow-sm'
                : 'text-slate-400 hover:text-slate-200'
            }`}
          >
            <Radio className="w-3.5 h-3.5" />
            <span>Network Topology</span>
          </button>

          <button
            onClick={() => setActiveSim('chmod')}
            className={`flex items-center gap-1.5 px-3 py-1.5 rounded-md transition-colors whitespace-nowrap ${
              activeSim === 'chmod'
                ? 'bg-amber-600 text-white font-semibold shadow-sm'
                : 'text-slate-400 hover:text-slate-200'
            }`}
          >
            <Key className="w-3.5 h-3.5" />
            <span>Linux Permissions Matrix</span>
          </button>
        </div>
      </div>

      {/* Main Visualizer Area */}
      <div className="flex-1 p-4 overflow-hidden">
        {activeSim === 'ad' && (
          <ActiveDirectorySim systemState={systemState} onUpdateState={onUpdateState} />
        )}
        {activeSim === 'gpo' && (
          <GroupPolicySim systemState={systemState} />
        )}
        {activeSim === 'disk' && (
          <DiskpartSim systemState={systemState} onUpdateState={onUpdateState} />
        )}
        {activeSim === 'network' && (
          <NetworkTopologySim
            systemState={systemState}
            onRenewDhcp={() => {
              const updatedIfaces = systemState.interfaces.map(i => ({
                ...i,
                ip: '192.168.1.145',
                gateway: '192.168.1.1',
              }));
              onUpdateState({
                ...systemState,
                interfaces: updatedIfaces,
                gatewayWorking: true,
              });
            }}
            onFlushDns={() => {
              onUpdateState({
                ...systemState,
                dnsWorking: true,
              });
            }}
          />
        )}
        {activeSim === 'chmod' && (
          <PermissionMatrixSim />
        )}
      </div>
    </div>
  );
};
