import React from 'react';
import { ExamModule, ExamTrack } from '../types/modules';
import { Cpu, Shield, Clock, ChevronRight, CheckCircle2, ArrowUpRight, Terminal, Layers } from 'lucide-react';

interface ModuleSelectorProps {
  track: ExamTrack;
  modules: ExamModule[];
  completedModuleIds: string[];
  onSelectModule: (module: ExamModule) => void;
}

export const ModuleSelector: React.FC<ModuleSelectorProps> = ({
  track,
  modules,
  completedModuleIds,
  onSelectModule,
}) => {
  const isLpi = track === 'lpi';

  return (
    <div className="flex flex-col h-full bg-slate-950 overflow-y-auto font-sans p-6 sm:p-8">
      <div className="max-w-6xl mx-auto w-full space-y-6">
        {/* Banner Section */}
        <div className="p-6 rounded-2xl bg-gradient-to-br from-slate-900 to-slate-950 border border-slate-800 space-y-3">
          <div className="flex items-center gap-2">
            {isLpi ? (
              <span className="flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-semibold bg-amber-500/15 text-amber-300 border border-amber-500/30">
                <Cpu className="w-3.5 h-3.5" />
                <span>Linux Professional Institute (LPI) Certification Track</span>
              </span>
            ) : (
              <span className="flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-semibold bg-blue-500/15 text-blue-300 border border-blue-500/30">
                <Shield className="w-3.5 h-3.5" />
                <span>CompTIA Windows Performance-Based Questions (PBQs) Track</span>
              </span>
            )}
          </div>

          <h2 className="text-2xl sm:text-3xl font-extrabold text-white tracking-tight">
            {isLpi
              ? 'LPI Exam Practice Labs & Objectives'
              : 'CompTIA Windows PBQs & Interactive System Labs'}
          </h2>

          <p className="text-sm text-slate-400 max-w-3xl leading-relaxed">
            {isLpi
              ? 'Structured practice modules aligned directly with LPIC-1 (101-500 & 102-500) and Linux Essentials objectives. Practice real terminal commands, pipe chaining, text filtering, permission management, disk layout, and system administration with live validation.'
              : 'Interactive simulation environments modeled after real CompTIA A+, Network+, Security+, and CySA+ Performance-Based Questions. Troubleshoot APIPA network issues, manage Active Directory users/groups, enforce Group Policy, partition with diskpart, and terminate malware.'}
          </p>

          <div className="flex flex-wrap items-center gap-4 text-xs text-slate-400 pt-2 border-t border-slate-800/80">
            <span>{modules.length} Available Modules</span>
            <span>·</span>
            <span>
              {completedModuleIds.filter(id => modules.some(m => m.id === id)).length} Completed
            </span>
            <span>·</span>
            <span>Live Command & State Verification</span>
          </div>
        </div>

        {/* Modules Grid */}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {modules.map((mod) => {
            const isCompleted = completedModuleIds.includes(mod.id);

            return (
              <div
                key={mod.id}
                onClick={() => onSelectModule(mod)}
                className={`p-5 rounded-xl border transition-all cursor-pointer flex flex-col justify-between space-y-4 hover:border-slate-700 hover:shadow-lg ${
                  isCompleted
                    ? 'bg-slate-900/50 border-emerald-500/40'
                    : 'bg-slate-900/60 border-slate-800'
                }`}
              >
                <div className="space-y-2.5">
                  <div className="flex items-center justify-between gap-2">
                    <span className={`px-2.5 py-0.5 rounded text-[11px] font-mono font-bold uppercase tracking-wider ${
                      isLpi
                        ? 'bg-amber-500/15 text-amber-300 border border-amber-500/30'
                        : 'bg-blue-500/15 text-blue-300 border border-blue-500/30'
                    }`}>
                      {mod.topicNumber}
                    </span>

                    <div className="flex items-center gap-2">
                      <span className="text-[11px] text-slate-400 font-medium">
                        {mod.difficulty}
                      </span>
                      {isCompleted && (
                        <span className="flex items-center gap-1 text-[11px] text-emerald-400 font-semibold">
                          <CheckCircle2 className="w-3.5 h-3.5" /> Passed
                        </span>
                      )}
                    </div>
                  </div>

                  <h3 className="text-base font-bold text-white group-hover:text-cyan-300 transition-colors">
                    {mod.title}
                  </h3>

                  <p className="text-xs text-slate-400 line-clamp-2 leading-relaxed">
                    {mod.scenarioDescription}
                  </p>
                </div>

                {/* Card Footer with clean unboxed metadata */}
                <div className="flex items-center justify-between pt-3 border-t border-slate-800/80 text-xs">
                  <div className="flex items-center gap-2 text-[11px] text-slate-400">
                    <span className="font-mono">{mod.examCode}</span>
                    <span>·</span>
                    <span>~{mod.estimatedMinutes} mins</span>
                    <span>·</span>
                    <span className="capitalize">{mod.simType.replace('-', ' ')}</span>
                  </div>

                  <button className="flex items-center gap-1 text-cyan-400 hover:text-cyan-300 font-semibold text-xs transition-colors">
                    <span>Start Lab</span>
                    <ArrowUpRight className="w-3.5 h-3.5" />
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
};
