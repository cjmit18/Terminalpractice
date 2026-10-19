import React, { useState } from 'react';
import { COMMAND_REFERENCE, CommandRefEntry } from '../data/commandReference';
import { Search, BookOpen, Terminal, Copy, Check, AlertTriangle, Layers, Filter } from 'lucide-react';

interface CommandEncyclopediaProps {
  onSelectCommand?: (cmd: string) => void;
}

export const CommandEncyclopedia: React.FC<CommandEncyclopediaProps> = ({
  onSelectCommand,
}) => {
  const [search, setSearch] = useState('');
  const [platformFilter, setPlatformFilter] = useState<'all' | 'linux' | 'windows'>('all');
  const [copiedCmd, setCopiedCmd] = useState<string | null>(null);

  const filteredCommands = COMMAND_REFERENCE.filter(cmd => {
    const matchesPlatform = platformFilter === 'all' || cmd.platform === platformFilter || cmd.platform === 'both';
    const q = search.toLowerCase();
    const matchesSearch = 
      cmd.name.toLowerCase().includes(q) ||
      cmd.summary.toLowerCase().includes(q) ||
      cmd.exam.toLowerCase().includes(q) ||
      cmd.category.toLowerCase().includes(q) ||
      cmd.switches.some(s => s.flag.toLowerCase().includes(q) || s.description.toLowerCase().includes(q));
    return matchesPlatform && matchesSearch;
  });

  const handleCopy = (text: string) => {
    navigator.clipboard.writeText(text);
    setCopiedCmd(text);
    setTimeout(() => setCopiedCmd(null), 2000);
  };

  return (
    <div className="flex flex-col h-[calc(100vh-65px)] bg-slate-950 overflow-hidden font-sans">
      {/* Search & Filter Header */}
      <div className="p-6 bg-slate-900/60 border-b border-slate-800 shrink-0 space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div>
            <h1 className="text-xl font-bold text-white tracking-tight flex items-center gap-2">
              <BookOpen className="w-5 h-5 text-cyan-400" />
              <span>Command Reference & Exam Syntax Explorer</span>
            </h1>
            <p className="text-xs text-slate-400 mt-1">
              Searchable database of essential LPI Linux and CompTIA Windows command-line utilities, flags, and exam traps.
            </p>
          </div>

          {/* Interactive filter tabs / segmented controls compliant with frontend-design */}
          <div className="flex items-center gap-1 p-1 bg-slate-900 rounded-lg border border-slate-800 text-xs font-medium">
            <button
              onClick={() => setPlatformFilter('all')}
              className={`px-3 py-1.5 rounded-md transition-colors whitespace-nowrap ${
                platformFilter === 'all'
                  ? 'bg-slate-800 text-white shadow-sm font-semibold'
                  : 'text-slate-400 hover:text-slate-200'
              }`}
            >
              All Standards
            </button>
            <button
              onClick={() => setPlatformFilter('linux')}
              className={`px-3 py-1.5 rounded-md transition-colors whitespace-nowrap ${
                platformFilter === 'linux'
                  ? 'bg-amber-500/20 text-amber-300 font-semibold'
                  : 'text-slate-400 hover:text-slate-200'
              }`}
            >
              LPI Linux
            </button>
            <button
              onClick={() => setPlatformFilter('windows')}
              className={`px-3 py-1.5 rounded-md transition-colors whitespace-nowrap ${
                platformFilter === 'windows'
                  ? 'bg-blue-500/20 text-blue-300 font-semibold'
                  : 'text-slate-400 hover:text-slate-200'
              }`}
            >
              CompTIA Windows
            </button>
          </div>
        </div>

        {/* Search Input Box */}
        <div className="relative">
          <Search className="w-4 h-4 text-slate-500 absolute left-3.5 top-1/2 -translate-y-1/2" />
          <input
            type="text"
            placeholder="Search commands, switches (e.g. -ano, chmod 750, /flushdns, diskpart)..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="w-full bg-slate-950 border border-slate-800 rounded-xl pl-10 pr-4 py-2 text-xs text-white placeholder-slate-500 focus:outline-none focus:border-cyan-500/50"
          />
        </div>
      </div>

      {/* Commands Card Grid */}
      <div className="flex-1 p-6 overflow-y-auto">
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          {filteredCommands.map((cmd) => (
            <div
              key={cmd.name}
              className="p-5 rounded-xl bg-slate-900/60 border border-slate-800 space-y-3.5 hover:border-slate-700 transition-colors"
            >
              <div className="flex items-start justify-between gap-3">
                <div>
                  <div className="flex items-center gap-2">
                    <span className="text-base font-bold text-white font-mono">{cmd.name}</span>
                    <span className={`px-2 py-0.5 rounded text-[10px] font-mono font-semibold uppercase ${
                      cmd.platform === 'linux'
                        ? 'bg-amber-500/15 text-amber-300'
                        : cmd.platform === 'windows'
                        ? 'bg-blue-500/15 text-blue-300'
                        : 'bg-emerald-500/15 text-emerald-300'
                    }`}>
                      {cmd.platform}
                    </span>
                    <span className="text-slate-400 text-xs font-medium">· {cmd.category}</span>
                  </div>
                  <div className="text-[11px] text-slate-400 mt-1 font-mono">{cmd.exam}</div>
                </div>

                <button
                  onClick={() => handleCopy(cmd.syntax)}
                  className="p-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-400 hover:text-slate-200 transition-colors"
                  title="Copy Syntax"
                >
                  {copiedCmd === cmd.syntax ? <Check className="w-3.5 h-3.5 text-emerald-400" /> : <Copy className="w-3.5 h-3.5" />}
                </button>
              </div>

              <p className="text-xs text-slate-300 leading-relaxed">
                {cmd.summary}
              </p>

              {/* Syntax Box */}
              <div className="p-2.5 rounded-lg bg-slate-950 border border-slate-800/80 font-mono text-cyan-300 text-xs">
                {cmd.syntax}
              </div>

              {/* Switches Table */}
              <div className="space-y-1.5">
                <div className="text-[11px] font-semibold text-slate-400 uppercase tracking-wider">
                  Exam-Tested Switches & Flags
                </div>
                <div className="space-y-1">
                  {cmd.switches.slice(0, 4).map((sw, i) => (
                    <div key={i} className="flex items-start gap-2 text-xs">
                      <span className="font-mono text-amber-300 font-semibold shrink-0 min-w-[70px]">
                        {sw.flag}
                      </span>
                      <span className="text-slate-400 text-[11px] leading-relaxed">
                        {sw.description}
                      </span>
                    </div>
                  ))}
                </div>
              </div>

              {/* Exam Trap Advice */}
              <div className="p-3 rounded-lg bg-amber-500/10 border border-amber-500/20 text-[11px] text-amber-200/90 leading-relaxed flex items-start gap-2">
                <AlertTriangle className="w-3.5 h-3.5 text-amber-400 shrink-0 mt-0.5" />
                <div>
                  <strong className="text-amber-300">Exam Note: </strong>
                  {cmd.examNotes}
                </div>
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
};
