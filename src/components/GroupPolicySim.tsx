import React, { useState } from 'react';
import { SystemState } from '../types/terminal';
import { Shield, RefreshCw, FileText, CheckCircle2, ChevronRight, Settings } from 'lucide-react';

interface GroupPolicySimProps {
  systemState: SystemState;
  onRunGpUpdate?: () => void;
}

export const GroupPolicySim: React.FC<GroupPolicySimProps> = ({
  systemState,
  onRunGpUpdate,
}) => {
  const [selectedGpoId, setSelectedGpoId] = useState<string>(systemState.gpos[0]?.id || '');
  const [lastUpdated, setLastUpdated] = useState<string>('10:28:44 AM');
  const [updating, setUpdating] = useState(false);

  const selectedGpo = systemState.gpos.find(g => g.id === selectedGpoId) || systemState.gpos[0];

  const handleForceUpdate = () => {
    setUpdating(true);
    setTimeout(() => {
      setUpdating(false);
      const now = new Date();
      setLastUpdated(now.toLocaleTimeString());
      onRunGpUpdate?.();
    }, 600);
  };

  return (
    <div className="flex flex-col h-full bg-slate-900/90 border border-slate-800 rounded-xl overflow-hidden shadow-xl text-xs font-sans">
      {/* GPMC Title Bar */}
      <div className="flex items-center justify-between px-4 py-2.5 bg-slate-950 border-b border-slate-800">
        <div className="flex items-center gap-2">
          <Settings className="w-4 h-4 text-cyan-400" />
          <span className="font-semibold text-slate-200">Group Policy Management Console (GPMC) - [CORP.LOCAL]</span>
        </div>
        <button
          onClick={handleForceUpdate}
          disabled={updating}
          className="flex items-center gap-1.5 px-3 py-1 rounded bg-slate-800 hover:bg-slate-700 text-cyan-300 font-medium border border-slate-700 transition-colors text-xs"
        >
          <RefreshCw className={`w-3.5 h-3.5 ${updating ? 'animate-spin text-cyan-400' : ''}`} />
          <span>gpupdate /force</span>
        </button>
      </div>

      <div className="flex flex-1 overflow-hidden">
        {/* Left GPO Tree */}
        <div className="w-60 border-r border-slate-800 bg-slate-950/60 p-3 overflow-y-auto space-y-1">
          <div className="text-[11px] font-semibold text-slate-400 uppercase tracking-wider mb-2">
            Group Policy Objects
          </div>
          {systemState.gpos.map((gpo) => (
            <button
              key={gpo.id}
              onClick={() => setSelectedGpoId(gpo.id)}
              className={`w-full flex items-center justify-between px-2.5 py-2 rounded-lg text-left transition-colors ${
                selectedGpoId === gpo.id
                  ? 'bg-cyan-500/15 text-cyan-300 border border-cyan-500/30 font-medium'
                  : 'text-slate-400 hover:text-slate-200 hover:bg-slate-800/40'
              }`}
            >
              <div className="flex items-center gap-2 truncate">
                <FileText className="w-3.5 h-3.5 shrink-0 text-cyan-400" />
                <span className="truncate">{gpo.name}</span>
              </div>
              <ChevronRight className="w-3 h-3 text-slate-500 shrink-0" />
            </button>
          ))}

          <div className="pt-4 border-t border-slate-800 mt-4">
            <div className="text-[11px] font-semibold text-slate-400 uppercase tracking-wider mb-2">
              LSDOU Inheritance
            </div>
            <div className="p-2.5 rounded bg-slate-900 border border-slate-800 space-y-1.5 text-[11px] text-slate-400">
              <div className="flex items-center justify-between">
                <span>1. Local GPO</span>
                <span className="text-slate-400">Lowest</span>
              </div>
              <div className="flex items-center justify-between">
                <span>2. Site Level</span>
                <span className="text-slate-400">Normal</span>
              </div>
              <div className="flex items-center justify-between font-semibold text-cyan-400">
                <span>3. Domain Level</span>
                <span>Inherited</span>
              </div>
              <div className="flex items-center justify-between font-bold text-emerald-400">
                <span>4. Org Unit (OU)</span>
                <span>Highest</span>
              </div>
            </div>
          </div>
        </div>

        {/* Right Policy Settings Inspector */}
        <div className="flex-1 flex flex-col overflow-hidden bg-slate-900/40 p-4">
          {selectedGpo && (
            <div className="space-y-4 overflow-y-auto">
              <div>
                <div className="flex items-center justify-between mb-1">
                  <h3 className="text-sm font-bold text-slate-100 flex items-center gap-2">
                    <Shield className="w-4 h-4 text-cyan-400" />
                    <span>{selectedGpo.name}</span>
                  </h3>
                  <span className="px-2 py-0.5 rounded text-[11px] font-mono bg-emerald-500/15 text-emerald-300 border border-emerald-500/30">
                    Status: {selectedGpo.status}
                  </span>
                </div>
                <p className="text-slate-400 text-[11px] font-mono">
                  GPO GUID: {selectedGpo.id} | Linked OUs: {selectedGpo.linkedOUs.join(', ')}
                </p>
              </div>

              {/* Table of GPO Settings */}
              <div className="rounded-lg border border-slate-800 overflow-hidden bg-slate-950/50">
                <div className="px-3 py-2 bg-slate-900/80 border-b border-slate-800 font-semibold text-slate-300 text-xs">
                  Computer Configuration Policies & Security Options
                </div>
                <table className="w-full text-left text-xs">
                  <thead>
                    <tr className="border-b border-slate-800 text-slate-400 text-[11px]">
                      <th className="py-2 px-3">Policy Area</th>
                      <th className="py-2 px-3">Setting Name</th>
                      <th className="py-2 px-3">Enforced Value</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-800/40 text-slate-300">
                    {selectedGpo.settings.map((item, idx) => (
                      <tr key={idx} className="hover:bg-slate-900/40">
                        <td className="py-2 px-3 text-slate-400 font-mono text-[11px]">{item.category}</td>
                        <td className="py-2 px-3 font-medium text-slate-200">{item.setting}</td>
                        <td className="py-2 px-3">
                          <span className="px-2 py-0.5 rounded bg-blue-500/10 text-blue-300 border border-blue-500/20 font-mono text-[11px]">
                            {item.value}
                          </span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              {/* Resultant Set of Policy (RSoP) live state */}
              <div className="p-3 rounded-lg bg-slate-950 border border-slate-800 space-y-2">
                <div className="flex items-center justify-between text-xs font-semibold text-slate-200">
                  <span className="flex items-center gap-1.5">
                    <CheckCircle2 className="w-3.5 h-3.5 text-emerald-400" />
                    Resultant Set of Policy (RSoP) Status
                  </span>
                  <span className="text-[11px] font-mono text-slate-400">
                    Last sync: {lastUpdated}
                  </span>
                </div>
                <p className="text-[11px] text-slate-400 leading-relaxed">
                  Both computer and user policies were applied with zero GPO conflicts. Client WIN-CLIENT01 complies with the active security baseline.
                </p>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};
