import React, { useRef, useState } from 'react';
import { SystemState } from '../types/terminal';
import { ActiveDirectorySim } from './ActiveDirectorySim';
import { GroupPolicySim } from './GroupPolicySim';
import { DiskpartSim } from './DiskpartSim';
import { NetworkTopologySim } from './NetworkTopologySim';
import { PermissionMatrixSim } from './PermissionMatrixSim';
import { cx } from './sims/ui';

interface SimulatorsHubProps {
  systemState: SystemState;
  onUpdateState: (newState: SystemState) => void;
}

type SimId = 'ad' | 'gpo' | 'disk' | 'network' | 'chmod';

const SIMS: { id: SimId; label: string; short?: string }[] = [
  { id: 'ad', label: 'Active Directory', short: 'AD' },
  { id: 'gpo', label: 'Group Policy', short: 'GPO' },
  { id: 'disk', label: 'Disk Management', short: 'Disks' },
  { id: 'network', label: 'Network' },
  { id: 'chmod', label: 'File permissions', short: 'Permissions' },
];

export const SimulatorsHub: React.FC<SimulatorsHubProps> = ({
  systemState,
  onUpdateState,
}) => {
  const [activeSim, setActiveSim] = useState<SimId>('ad');
  const tabRefs = useRef<Record<string, HTMLButtonElement | null>>({});

  // Left/right arrows move between tabs, as in any tab list
  const onTabKeyDown = (e: React.KeyboardEvent, index: number) => {
    let next = -1;
    if (e.key === 'ArrowRight') next = (index + 1) % SIMS.length;
    else if (e.key === 'ArrowLeft') next = (index - 1 + SIMS.length) % SIMS.length;
    else if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = SIMS.length - 1;
    if (next < 0) return;
    e.preventDefault();
    setActiveSim(SIMS[next].id);
    tabRefs.current[SIMS[next].id]?.focus();
  };

  return (
    <div className="flex min-h-full flex-col bg-bg text-text md:h-full">
      <div className="shrink-0 border-b border-line px-4 pt-5 sm:px-6">
        <h1 className="text-2xl font-semibold">Simulators</h1>
        <p className="mt-1 max-w-prose text-sm text-muted">
          Simplified versions of the admin tools the exams ask about. Try the actions here, then do the same thing from
          the command line in a lab. Changes last until you reload the page.
        </p>

        <div role="tablist" aria-label="Simulator" className="-mb-px mt-4 flex gap-1 overflow-x-auto">
          {SIMS.map((s, i) => {
            const selected = s.id === activeSim;
            return (
              <button
                key={s.id}
                aria-label={s.label}
                ref={el => {
                  tabRefs.current[s.id] = el;
                }}
                type="button"
                role="tab"
                id={`sim-tab-${s.id}`}
                aria-selected={selected}
                aria-controls="sim-panel"
                tabIndex={selected ? 0 : -1}
                onClick={() => setActiveSim(s.id)}
                onKeyDown={e => onTabKeyDown(e, i)}
                className={cx(
                  'min-h-10 shrink-0 whitespace-nowrap border-b-2 px-3 text-sm font-medium transition-colors',
                  selected ? 'border-accent text-text' : 'border-transparent text-muted hover:text-text',
                )}
              >
                {s.short ? (
                  <>
                    <span className="sm:hidden">{s.short}</span>
                    <span className="hidden sm:inline">{s.label}</span>
                  </>
                ) : (
                  s.label
                )}
              </button>
            );
          })}
        </div>
      </div>

      <div
        role="tabpanel"
        id="sim-panel"
        aria-labelledby={`sim-tab-${activeSim}`}
        className="flex-1 p-4 sm:p-6 md:min-h-0"
      >
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
                netmask: '255.255.255.0',
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
