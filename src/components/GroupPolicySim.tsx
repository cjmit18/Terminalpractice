import React, { useEffect, useRef, useState } from 'react';
import { SystemState } from '../types/terminal';
import { Ban, CheckCircle2, FileText, Folder, Network, RefreshCw, Trees } from 'lucide-react';
import { Button, ConsoleTree, SimPanel, SimToolbar, StatusText, TreeNode, thClass } from './sims/ui';

interface GroupPolicySimProps {
  systemState: SystemState;
  onRunGpUpdate?: () => void;
}

const DOMAIN = 'corp.local';

export const GroupPolicySim: React.FC<GroupPolicySimProps> = ({
  systemState,
  onRunGpUpdate,
}) => {
  const [selectedGpoId, setSelectedGpoId] = useState<string>(systemState.gpos[0]?.id || '');
  const [lastUpdated, setLastUpdated] = useState<string | null>(null);
  const [updating, setUpdating] = useState(false);
  const timer = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(timer.current), []);

  const selectedGpo = systemState.gpos.find(g => g.id === selectedGpoId) || systemState.gpos[0];

  const handleForceUpdate = () => {
    setUpdating(true);
    timer.current = window.setTimeout(() => {
      setUpdating(false);
      setLastUpdated(new Date().toLocaleTimeString());
      onRunGpUpdate?.();
    }, 600);
  };

  const tree: TreeNode[] = [
    { id: 'forest', label: `Forest: ${DOMAIN}`, depth: 0, icon: Trees, selectable: false },
    { id: 'domains', label: 'Domains', depth: 1, icon: Folder, selectable: false },
    { id: 'domain', label: DOMAIN, depth: 2, icon: Network, selectable: false },
    { id: 'gpos', label: 'Group Policy Objects', depth: 3, icon: Folder, selectable: false },
    ...systemState.gpos.map(g => ({ id: g.id, label: g.name, depth: 4, icon: FileText })),
  ];

  return (
    <SimPanel label="Group Policy Management">
      <SimToolbar title="Group Policy Management" context={`Domain ${DOMAIN}`}>
        <Button variant="secondary" onClick={handleForceUpdate} disabled={updating}>
          <RefreshCw className="h-4 w-4" aria-hidden />
          {updating ? 'Updating…' : <>Run <span className="font-mono">gpupdate /force</span></>}
        </Button>
      </SimToolbar>

      <div className="flex min-h-0 flex-1 flex-col @2xl:flex-row">
        {systemState.gpos.length > 0 && (
          <ConsoleTree
            id="gpmc-gpo"
            label="Group Policy Object"
            nodes={tree}
            selectedId={selectedGpo?.id ?? ''}
            onSelect={setSelectedGpoId}
          />
        )}

        <div className="min-h-0 min-w-0 flex-1 space-y-6 overflow-y-auto px-4 py-4">
          {selectedGpo ? (
            <>
              <div>
                <h3 className="text-base font-semibold">{selectedGpo.name}</h3>
                <dl className="mt-2 grid grid-cols-1 gap-x-6 gap-y-1.5 text-sm @xl:grid-cols-[auto_1fr]">
                  <dt className="text-muted">Status</dt>
                  <dd>
                    {selectedGpo.status === 'Enabled' ? (
                      <StatusText tone="ok" icon={CheckCircle2}>Enabled</StatusText>
                    ) : (
                      <StatusText tone="muted" icon={Ban}>Disabled</StatusText>
                    )}
                  </dd>
                  <dt className="text-muted">Linked to</dt>
                  <dd className="font-mono">{selectedGpo.linkedOUs.join(', ') || 'Not linked'}</dd>
                  <dt className="text-muted">Unique ID</dt>
                  <dd className="break-all font-mono text-muted">{selectedGpo.id}</dd>
                </dl>
              </div>

              <div>
                <h4 className="text-sm font-semibold">Settings</h4>
                <div className="mt-2 overflow-x-auto rounded-md border border-line">
                  <table className="w-full border-collapse text-sm">
                    <caption className="sr-only">Settings in {selectedGpo.name}</caption>
                    <thead>
                      <tr className="border-b border-line bg-surface-2">
                        <th scope="col" className={thClass}>Policy</th>
                        <th scope="col" className={thClass}>Setting</th>
                      </tr>
                    </thead>
                    <tbody>
                      {selectedGpo.settings.map((item, idx) => (
                        <tr key={idx} className="border-b border-line last:border-b-0">
                          <th scope="row" className="px-3 py-2 text-left font-normal">
                            <div>{item.setting}</div>
                            <div className="text-xs text-muted">{item.category.replace(/\//g, ' › ')}</div>
                          </th>
                          <td className="px-3 py-2 align-top font-medium">{item.value}</td>
                        </tr>
                      ))}
                      {selectedGpo.settings.length === 0 && (
                        <tr>
                          <td colSpan={2} className="px-3 py-4 text-center text-muted">
                            No settings are configured in this policy.
                          </td>
                        </tr>
                      )}
                    </tbody>
                  </table>
                </div>
              </div>
            </>
          ) : (
            <p className="text-muted">There are no Group Policy Objects in this domain.</p>
          )}

          <div role="status" aria-live="polite" className="text-sm">
            {lastUpdated ? (
              <StatusText tone="ok" icon={CheckCircle2}>
                Computer and user policy refreshed on {systemState.hostname} at {lastUpdated}.
              </StatusText>
            ) : (
              <span className="text-muted">
                Policy has not been refreshed in this session. Clients pick up changes every 90 minutes or so, or right
                away with <code className="rounded-sm bg-surface-2 px-1">gpupdate /force</code>.
              </span>
            )}
          </div>

          <div className="border-t border-line pt-4 text-sm">
            <div className="max-w-prose">
            <h4 className="font-semibold">Processing order</h4>
            <p className="mt-1 text-muted">
              Policies apply in this order, and when two set the same thing, the later one wins:
            </p>
            <ol className="mt-2 list-decimal space-y-0.5 pl-5">
              <li>Local policy on the computer</li>
              <li>Site</li>
              <li>Domain</li>
              <li>Organizational unit, parent first, then child</li>
            </ol>
            <p className="mt-2 text-muted">
              The exam calls this LSDOU. <span className="font-medium text-text">Enforced</span> on a link and{' '}
              <span className="font-medium text-text">Block Inheritance</span> on an OU change it.
            </p>
            </div>
          </div>
        </div>
      </div>
    </SimPanel>
  );
};
