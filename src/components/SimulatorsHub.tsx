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
    <div className="flex flex-col h-full min-h-0 bg-bg overflow-hidden font-sans">
      {/* Simulators Navigation Header */}
      <div className="px-4 sm:px-6 py-4 bg-surface border-b border-line shrink-0 flex flex-wrap items-center justify-between gap-4">
        <div className="min-w-0">
          <h1 className="text-xl sm:text-2xl font-semibold text-text flex items-center gap-2">
            <Layers className="w-5 h-5 text-accent shrink-0" aria-hidden="true" />
            <span>System simulators</span>
          </h1>
          <p className="text-sm text-muted mt-1 max-w-prose">
            Explore system settings and see how your changes affect a practice machine.
          </p>
        </div>

        <div className="flex max-w-full items-center gap-1 p-1 bg-bg rounded-md border border-line text-sm overflow-x-auto" role="group" aria-label="Choose a simulator">
          <button
            type="button"
            aria-pressed={activeSim === 'ad'}
            onClick={() => setActiveSim('ad')}
            className={`flex items-center gap-1.5 px-3 min-h-10 rounded-sm transition-colors whitespace-nowrap ${
              activeSim === 'ad'
                ? 'bg-accent-soft text-accent font-medium'
                : 'text-muted hover:text-text'
            }`}
          >
            <Users className="w-4 h-4" aria-hidden="true" />
            <span>Active Directory</span>
          </button>

          <button
            type="button"
            aria-pressed={activeSim === 'gpo'}
            onClick={() => setActiveSim('gpo')}
            className={`flex items-center gap-1.5 px-3 min-h-10 rounded-sm transition-colors whitespace-nowrap ${
              activeSim === 'gpo'
                ? 'bg-accent-soft text-accent font-medium'
                : 'text-muted hover:text-text'
            }`}
          >
            <Settings className="w-4 h-4" aria-hidden="true" />
            <span>Group Policy</span>
          </button>

          <button
            type="button"
            aria-pressed={activeSim === 'disk'}
            onClick={() => setActiveSim('disk')}
            className={`flex items-center gap-1.5 px-3 min-h-10 rounded-sm transition-colors whitespace-nowrap ${
              activeSim === 'disk'
                ? 'bg-accent-soft text-accent font-medium'
                : 'text-muted hover:text-text'
            }`}
          >
            <HardDrive className="w-4 h-4" aria-hidden="true" />
            <span>Disk Management</span>
          </button>

          <button
            type="button"
            aria-pressed={activeSim === 'network'}
            onClick={() => setActiveSim('network')}
            className={`flex items-center gap-1.5 px-3 min-h-10 rounded-sm transition-colors whitespace-nowrap ${
              activeSim === 'network'
                ? 'bg-accent-soft text-accent font-medium'
                : 'text-muted hover:text-text'
            }`}
          >
            <Radio className="w-4 h-4" aria-hidden="true" />
            <span>Network</span>
          </button>

          <button
            type="button"
            aria-pressed={activeSim === 'chmod'}
            onClick={() => setActiveSim('chmod')}
            className={`flex items-center gap-1.5 px-3 min-h-10 rounded-sm transition-colors whitespace-nowrap ${
              activeSim === 'chmod'
                ? 'bg-accent-soft text-accent font-medium'
                : 'text-muted hover:text-text'
            }`}
          >
            <Key className="w-4 h-4" aria-hidden="true" />
            <span>Linux permissions</span>
          </button>
        </div>
      </div>

      <div className="flex-1 min-h-0 p-3 sm:p-4 overflow-hidden">
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
