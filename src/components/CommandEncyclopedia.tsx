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

  const handleCopy = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopiedCmd(text);
      setTimeout(() => setCopiedCmd(null), 2000);
    } catch {
      setCopiedCmd(null);
    }
  };

  return (
    <div className="flex flex-col h-full min-h-0 bg-bg overflow-hidden font-sans">
      {/* Search & Filter Header */}
      <div className="p-4 sm:p-6 bg-surface border-b border-line shrink-0 space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div>
            <h1 className="text-xl sm:text-2xl font-semibold text-text flex items-center gap-2">
              <BookOpen className="w-5 h-5 text-accent" aria-hidden="true" />
              <span>Command reference</span>
            </h1>
            <p className="text-sm text-muted mt-1 max-w-prose">
              Look up commands, common flags, and exam notes for Linux and Windows.
            </p>
          </div>

          <div className="flex items-center gap-1 p-1 bg-bg rounded-md border border-line text-sm" role="group" aria-label="Filter by platform">
            <button
              type="button"
              aria-pressed={platformFilter === 'all'}
              onClick={() => setPlatformFilter('all')}
              className={`px-3 min-h-10 rounded-sm transition-colors whitespace-nowrap ${
                platformFilter === 'all'
                  ? 'bg-accent-soft text-accent font-medium'
                  : 'text-muted hover:text-text'
              }`}
            >
              All
            </button>
            <button
              type="button"
              aria-pressed={platformFilter === 'linux'}
              onClick={() => setPlatformFilter('linux')}
              className={`px-3 min-h-10 rounded-sm transition-colors whitespace-nowrap ${
                platformFilter === 'linux'
                  ? 'bg-accent-soft text-accent font-medium'
                  : 'text-muted hover:text-text'
              }`}
            >
              Linux
            </button>
            <button
              type="button"
              aria-pressed={platformFilter === 'windows'}
              onClick={() => setPlatformFilter('windows')}
              className={`px-3 min-h-10 rounded-sm transition-colors whitespace-nowrap ${
                platformFilter === 'windows'
                  ? 'bg-accent-soft text-accent font-medium'
                  : 'text-muted hover:text-text'
              }`}
            >
              Windows
            </button>
          </div>
        </div>

        <div className="relative">
          <Search className="w-4 h-4 text-subtle absolute left-3.5 top-1/2 -translate-y-1/2" aria-hidden="true" />
          <input
            type="text"
            aria-label="Search commands"
            placeholder="Search commands, flags, or exam topics"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="w-full min-h-11 bg-bg border border-line-strong rounded-md pl-10 pr-4 py-2 text-[15px] text-text placeholder:text-muted"
          />
        </div>
      </div>

      <div className="flex-1 p-4 sm:p-6 overflow-y-auto">
        {filteredCommands.length === 0 ? (
          <p role="status" className="py-8 text-sm text-muted">
            No commands match that search. Try a different command, flag, or topic.
          </p>
        ) : (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-x-8">
          {filteredCommands.map((cmd) => (
            <div
              key={cmd.name}
              className="py-5 border-b border-line space-y-3.5"
            >
              <div className="flex items-start justify-between gap-3">
                <div>
                  <div className="flex items-center gap-2">
                    <span className="text-base font-semibold text-text font-mono">{cmd.name}</span>
                    <span className="text-xs text-accent">
                      {cmd.platform}
                    </span>
                    <span className="text-sm text-muted">· {cmd.category}</span>
                  </div>
                  <div className="text-xs text-muted mt-1">{cmd.exam}</div>
                </div>

                <button
                  type="button"
                  onClick={() => handleCopy(cmd.syntax)}
                  aria-label={copiedCmd === cmd.syntax ? `Copied ${cmd.name} syntax` : `Copy ${cmd.name} syntax`}
                  title="Copy syntax"
                  className="inline-flex items-center justify-center size-10 shrink-0 rounded-md border border-line text-muted hover:text-text hover:bg-surface-2 transition-colors"
                >
                  {copiedCmd === cmd.syntax ? <Check className="w-4 h-4 text-ok" aria-hidden="true" /> : <Copy className="w-4 h-4" aria-hidden="true" />}
                </button>
              </div>

              <p className="text-sm text-muted leading-relaxed">
                {cmd.summary}
              </p>

              <div className="px-3 py-2 rounded-md bg-surface-2 border border-line font-mono text-accent text-sm">
                {cmd.syntax}
              </div>

              <div className="space-y-1.5">
                <div className="text-xs font-medium text-muted">
                  Common flags
                </div>
                <div className="space-y-1">
                  {cmd.switches.slice(0, 4).map((sw, i) => (
                    <div key={i} className="flex items-start gap-3 text-sm">
                      <span className="font-mono text-text font-medium shrink-0 min-w-[70px]">
                        {sw.flag}
                      </span>
                      <span className="text-muted leading-relaxed">
                        {sw.description}
                      </span>
                    </div>
                  ))}
                </div>
              </div>

              <div className="p-3 rounded-md bg-warn-soft text-sm text-text leading-relaxed flex items-start gap-2">
                <AlertTriangle className="w-4 h-4 text-warn shrink-0 mt-0.5" aria-hidden="true" />
                <div>
                  <strong className="font-medium">Exam note: </strong>
                  {cmd.examNotes}
                </div>
              </div>
            </div>
          ))}
        </div>
        )}
      </div>
    </div>
  );
};
