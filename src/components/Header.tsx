import React from 'react';
import { Terminal, Shield, Cpu, BookOpen, Layers } from 'lucide-react';

export type AppTab = 'lpi' | 'comptia' | 'simulators' | 'sandbox' | 'reference';

interface HeaderProps {
  activeTab: AppTab;
  setActiveTab: (tab: AppTab) => void;
  completedObjectivesCount: number;
  totalObjectivesCount: number;
}

export const Header: React.FC<HeaderProps> = ({
  activeTab,
  setActiveTab,
  completedObjectivesCount,
  totalObjectivesCount,
}) => {
  return (
    <header className="flex items-center justify-between gap-8 px-6 py-3.5 bg-slate-900/90 border-b border-slate-800 backdrop-blur-md sticky top-0 z-50">
      {/* Zone 1: Single clean brand mark */}
      <div className="flex items-center gap-3 shrink-0">
        <div className="w-8 h-8 rounded-lg bg-cyan-500/10 border border-cyan-500/30 flex items-center justify-center text-cyan-400">
          <Terminal className="w-4 h-4" />
        </div>
        <div className="flex flex-col">
          <span className="text-base font-bold tracking-tight text-white whitespace-nowrap">
            Terminus CertSim
          </span>
          <span className="text-[11px] text-slate-400 font-mono">
            LPI Linux & CompTIA Windows PBQs
          </span>
        </div>
      </div>

      {/* Zone 2: 5 clean navigation tabs */}
      <nav className="hidden md:flex items-center gap-1.5 text-xs font-medium">
        <button
          onClick={() => setActiveTab('lpi')}
          className={`flex items-center gap-2 px-3 py-1.5 rounded-md transition-colors whitespace-nowrap ${
            activeTab === 'lpi'
              ? 'bg-amber-500/15 text-amber-300 border border-amber-500/30 font-semibold'
              : 'text-slate-400 hover:text-slate-200 hover:bg-slate-800/60'
          }`}
        >
          <Cpu className="w-3.5 h-3.5" />
          <span>LPI Linux Modules</span>
        </button>

        <button
          onClick={() => setActiveTab('comptia')}
          className={`flex items-center gap-2 px-3 py-1.5 rounded-md transition-colors whitespace-nowrap ${
            activeTab === 'comptia'
              ? 'bg-blue-500/15 text-blue-300 border border-blue-500/30 font-semibold'
              : 'text-slate-400 hover:text-slate-200 hover:bg-slate-800/60'
          }`}
        >
          <Shield className="w-3.5 h-3.5" />
          <span>CompTIA Windows PBQs</span>
        </button>

        <button
          onClick={() => setActiveTab('simulators')}
          className={`flex items-center gap-2 px-3 py-1.5 rounded-md transition-colors whitespace-nowrap ${
            activeTab === 'simulators'
              ? 'bg-emerald-500/15 text-emerald-300 border border-emerald-500/30 font-semibold'
              : 'text-slate-400 hover:text-slate-200 hover:bg-slate-800/60'
          }`}
        >
          <Layers className="w-3.5 h-3.5" />
          <span>System Simulators</span>
        </button>

        <button
          onClick={() => setActiveTab('sandbox')}
          className={`flex items-center gap-2 px-3 py-1.5 rounded-md transition-colors whitespace-nowrap ${
            activeTab === 'sandbox'
              ? 'bg-purple-500/15 text-purple-300 border border-purple-500/30 font-semibold'
              : 'text-slate-400 hover:text-slate-200 hover:bg-slate-800/60'
          }`}
        >
          <Terminal className="w-3.5 h-3.5" />
          <span>Terminal Sandbox</span>
        </button>

        <button
          onClick={() => setActiveTab('reference')}
          className={`flex items-center gap-2 px-3 py-1.5 rounded-md transition-colors whitespace-nowrap ${
            activeTab === 'reference'
              ? 'bg-cyan-500/15 text-cyan-300 border border-cyan-500/30 font-semibold'
              : 'text-slate-400 hover:text-slate-200 hover:bg-slate-800/60'
          }`}
        >
          <BookOpen className="w-3.5 h-3.5" />
          <span>Command Reference</span>
        </button>
      </nav>

      {/* Zone 3: 1 primary action / progress indicator */}
      <div className="flex items-center gap-2 sm:gap-3 shrink-0">
        <div className="hidden sm:flex items-center gap-2 px-2.5 py-1 rounded bg-slate-950/60 border border-slate-800 text-[11px] font-mono text-slate-300">
          <span className="text-slate-400">Mastery:</span>
          <span className="text-cyan-400 font-semibold tabular-nums">
            {completedObjectivesCount}/{totalObjectivesCount}
          </span>
          <span className="text-slate-500">Objectives</span>
        </div>
        <button
          onClick={() => setActiveTab('sandbox')}
          className="px-2.5 sm:px-3.5 py-1.5 text-xs font-semibold text-slate-950 bg-cyan-400 hover:bg-cyan-300 rounded-lg transition-colors whitespace-nowrap shadow-sm"
        >
          <span className="hidden sm:inline">Launch </span>Terminal
        </button>
      </div>
    </header>
  );
};
