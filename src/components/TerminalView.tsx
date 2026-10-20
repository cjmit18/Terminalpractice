import React, { useState, useRef, useEffect } from 'react';
import { TerminalShell, TerminalTheme, HistoryItem } from '../types/terminal';
import { Terminal, Copy, Trash2, Sliders, Check, Sparkles } from 'lucide-react';

interface TerminalViewProps {
  shell: TerminalShell;
  cwd: string;
  history: HistoryItem[];
  onExecuteCommand: (command: string) => void;
  onClearHistory: () => void;
  suggestedCommands?: string[];
  isDiskpartActive?: boolean;
  currentUser?: string;
  hostname?: string;
  readOnly?: boolean;
}

export const TerminalView: React.FC<TerminalViewProps> = ({
  shell,
  cwd,
  history,
  onExecuteCommand,
  onClearHistory,
  suggestedCommands = [],
  isDiskpartActive = false,
  currentUser = 'student',
  hostname = 'lpi-lab01',
  readOnly = false,
}) => {
  const [input, setInput] = useState('');
  const [theme, setTheme] = useState<TerminalTheme>(
    shell === 'bash' ? 'ubuntu' : shell === 'powershell' ? 'powershell' : 'cmd-classic'
  );
  const [crtEffect, setCrtEffect] = useState(false);
  const [copied, setCopied] = useState(false);
  const [historyIndex, setHistoryIndex] = useState<number | null>(null);

  const inputRef = useRef<HTMLInputElement>(null);
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [history]);

  // Adjust default theme when shell changes
  useEffect(() => {
    if (shell === 'bash' && theme === 'powershell') setTheme('ubuntu');
    if (shell === 'powershell' && theme === 'ubuntu') setTheme('powershell');
    if (shell === 'cmd' && theme === 'powershell') setTheme('cmd-classic');
  }, [shell]);

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      const trimmed = input.trim();
      if (trimmed) {
        onExecuteCommand(trimmed);
        setInput('');
        setHistoryIndex(null);
      }
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      historyPrev();
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      historyNext();
    } else if (e.key === 'Tab') {
      e.preventDefault();
      completeCommand();
    } else if (e.ctrlKey && e.key.toLowerCase() === 'c') {
      e.preventDefault();
      cancelLine();
    }
  };

  const historyPrev = () => {
    if (history.length === 0) return;
    const newIndex = historyIndex === null ? history.length - 1 : Math.max(0, historyIndex - 1);
    setHistoryIndex(newIndex);
    setInput(history[newIndex].command);
  };

  const historyNext = () => {
    if (historyIndex === null) return;
    const newIndex = historyIndex + 1;
    if (newIndex >= history.length) {
      setHistoryIndex(null);
      setInput('');
    } else {
      setHistoryIndex(newIndex);
      setInput(history[newIndex].command);
    }
  };

  // Simple tab autocomplete for common commands
  const completeCommand = () => {
    const commonLinux = ['chmod', 'chown', 'ls', 'cat', 'grep', 'awk', 'tar', 'useradd', 'usermod', 'systemctl', 'journalctl', 'fdisk', 'df', 'ifconfig', 'ip', 'ping'];
    const commonWin = ['ipconfig', 'ping', 'tracert', 'nslookup', 'netstat', 'sfc', 'dism', 'chkdsk', 'diskpart', 'gpupdate', 'gpresult', 'tasklist', 'taskkill', 'Get-Service', 'Start-Service', 'Get-Process', 'Test-NetConnection', 'Unlock-ADAccount'];
    const pool = shell === 'bash' ? commonLinux : commonWin;
    const match = pool.find(c => c.toLowerCase().startsWith(input.toLowerCase()));
    if (match) {
      setInput(match + ' ');
    }
  };

  const cancelLine = () => {
    setInput('');
    setHistoryIndex(null);
  };

  // Insert text at the caret so the toolbar works mid-line, then restore focus and caret
  const insertAtCaret = (text: string) => {
    const el = inputRef.current;
    const start = el?.selectionStart ?? input.length;
    const end = el?.selectionEnd ?? input.length;
    setInput(input.slice(0, start) + text + input.slice(end));
    requestAnimationFrame(() => {
      el?.focus();
      el?.setSelectionRange(start + text.length, start + text.length);
    });
  };

  const getThemeStyles = () => {
    switch (theme) {
      case 'ubuntu':
        return {
          bg: 'bg-[#300a24]',
          text: 'text-slate-100',
          promptUser: 'text-[#87ff5f]',
          promptPath: 'text-[#5fd7ff]',
          headerBg: 'bg-[#210718]',
        };
      case 'crt-green':
        return {
          bg: 'bg-[#051109]',
          text: 'text-[#33ff33]',
          promptUser: 'text-[#33ff33]',
          promptPath: 'text-[#22cc22]',
          headerBg: 'bg-[#020a05]',
        };
      case 'crt-amber':
        return {
          bg: 'bg-[#140b02]',
          text: 'text-[#ffb000]',
          promptUser: 'text-[#ffb000]',
          promptPath: 'text-[#dd9900]',
          headerBg: 'bg-[#0a0501]',
        };
      case 'powershell':
        return {
          bg: 'bg-[#012456]',
          text: 'text-slate-100',
          promptUser: 'text-cyan-300',
          promptPath: 'text-yellow-300',
          headerBg: 'bg-[#001737]',
        };
      case 'cmd-classic':
      default:
        return {
          bg: 'bg-[#0c0c0c]',
          text: 'text-[#cccccc]',
          promptUser: 'text-slate-400',
          promptPath: 'text-slate-300',
          headerBg: 'bg-[#181818]',
        };
    }
  };

  const styles = getThemeStyles();

  const renderPrompt = () => {
    if (isDiskpartActive) {
      return <span className="text-amber-400 font-bold select-none mr-2">DISKPART&gt;</span>;
    }

    if (shell === 'bash') {
      const isRoot = currentUser === 'root';
      return (
        <span className="select-none mr-2">
          <span className={`${styles.promptUser} font-semibold`}>
            {currentUser}@{hostname}
          </span>
          <span className="text-slate-400">:</span>
          <span className={`${styles.promptPath} font-semibold`}>{cwd}</span>
          <span className="text-slate-400">{isRoot ? '# ' : '$ '}</span>
        </span>
      );
    }

    if (shell === 'powershell') {
      return (
        <span className="select-none mr-2">
          <span className="text-blue-300 font-bold">PS </span>
          <span className={`${styles.promptPath}`}>{cwd}</span>
          <span className="text-slate-400">&gt; </span>
        </span>
      );
    }

    // cmd
    return (
      <span className="select-none mr-2">
        <span className={`${styles.promptPath}`}>{cwd}</span>
        <span className="text-slate-400">&gt;</span>
      </span>
    );
  };

  const copyTerminalOutput = () => {
    const text = history.map(h => `${h.command}\n${h.output}`).join('\n\n');
    navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div
      className={`flex flex-col h-full rounded-xl overflow-hidden border border-slate-800 shadow-2xl font-mono text-xs sm:text-sm ${styles.bg} ${
        crtEffect ? 'crt-effect' : ''
      }`}
      onClick={() => inputRef.current?.focus()}
    >
      {/* Terminal Title Bar */}
      <div className={`flex items-center justify-between px-3 sm:px-4 py-2 sm:py-2.5 border-b border-slate-800/80 ${styles.headerBg}`}>
        <div className="flex items-center gap-2.5">
          <div className="flex items-center gap-1.5">
            <div className="w-3 h-3 rounded-full bg-rose-500/80"></div>
            <div className="w-3 h-3 rounded-full bg-amber-500/80"></div>
            <div className="w-3 h-3 rounded-full bg-emerald-500/80"></div>
          </div>
          <div className="flex items-center gap-2 text-xs text-slate-300 font-medium ml-2">
            <Terminal className="w-3.5 h-3.5 text-slate-400" />
            <span>
              {shell === 'bash' ? 'GNU bash, version 5.1.16' : shell === 'powershell' ? 'Windows PowerShell 7.4.1' : 'Command Prompt - cmd.exe'}
            </span>
          </div>
        </div>

        <div className="flex items-center gap-2">
          {/* CRT Scanline Toggle */}
          <button
            onClick={(e) => {
              e.stopPropagation();
              setCrtEffect(!crtEffect);
            }}
            title="Toggle Vintage CRT Phosphor Scanline Filter"
            className={`hidden sm:block px-2 py-1 rounded text-[11px] font-sans transition-colors ${
              crtEffect ? 'bg-emerald-500/20 text-emerald-300 border border-emerald-500/30' : 'text-slate-400 hover:text-slate-200'
            }`}
          >
            CRT Scan
          </button>

          {/* Theme selector */}
          <select
            value={theme}
            onChange={(e) => {
              e.stopPropagation();
              setTheme(e.target.value as TerminalTheme);
            }}
            onClick={(e) => e.stopPropagation()}
            aria-label="Terminal Color Theme"
            className="hidden sm:block bg-slate-900 border border-slate-700 text-slate-300 text-[11px] font-sans rounded px-2 py-1 focus:outline-none"
          >
            <option value="ubuntu">Ubuntu Purple</option>
            <option value="powershell">PowerShell Blue</option>
            <option value="cmd-classic">CMD Retro Dark</option>
            <option value="crt-green">Green Phosphor</option>
            <option value="crt-amber">Amber Phosphor</option>
          </select>

          {/* Copy Button */}
          <button
            onClick={(e) => {
              e.stopPropagation();
              copyTerminalOutput();
            }}
            title="Copy Output"
            className="p-1 text-slate-400 hover:text-slate-200 rounded transition-colors"
          >
            {copied ? <Check className="w-3.5 h-3.5 text-emerald-400" /> : <Copy className="w-3.5 h-3.5" />}
          </button>

          {/* Clear Button */}
          <button
            onClick={(e) => {
              e.stopPropagation();
              onClearHistory();
            }}
            title="Clear Terminal Buffer"
            className="p-1 text-slate-400 hover:text-rose-400 rounded transition-colors"
          >
            <Trash2 className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>

      {/* Terminal Output Area */}
      <div className="flex-1 p-4 overflow-y-auto terminal-scrollbar space-y-3">
        {history.length === 0 && (
          <div className="text-slate-400/80 leading-relaxed space-y-1 mb-4 select-none">
            <p>
              {shell === 'bash'
                ? 'Welcome to Ubuntu 22.04.3 LTS (GNU/Linux 5.15.0-101-generic x86_64)'
                : shell === 'powershell'
                ? 'Windows PowerShell\nCopyright (C) Microsoft Corporation. All rights reserved.'
                : 'Microsoft Windows [Version 10.0.22621.1]\n(c) Microsoft Corporation. All rights reserved.'}
            </p>
            <p className="text-xs opacity-75">
              Type your commands below. Supports pipes (<code className="text-cyan-400">|</code>), redirects (<code className="text-cyan-400">&gt;</code>), and flags. Tab for autocomplete.
            </p>
          </div>
        )}

        {history.map((item) => (
          <div key={item.id} className="space-y-1">
            <div className="flex items-start">
              <span className="opacity-90">{renderPrompt()}</span>
              <span className="text-white font-medium break-all">{item.command}</span>
            </div>
            {item.output && (
              <div className="pl-2 font-mono leading-relaxed space-y-0.5">
                {item.errorOutput ? (
                  <>
                    {item.output !== item.errorOutput && item.output.replace(item.errorOutput, '').trim() && (
                      <pre className={`whitespace-pre-wrap break-all ${styles.text}`}>
                        {item.output.replace(item.errorOutput, '').trimEnd()}
                      </pre>
                    )}
                    <pre className="whitespace-pre-wrap break-all text-rose-400">
                      {item.errorOutput}
                    </pre>
                  </>
                ) : (
                  <pre
                    className={`whitespace-pre-wrap break-all ${
                      item.isError ? 'text-rose-400' : styles.text
                    }`}
                  >
                    {item.output}
                  </pre>
                )}
              </div>
            )}
          </div>
        ))}

        {/* Active Input Line */}
        {!readOnly && (
          <div className="flex items-center pt-1">
            {renderPrompt()}
            <input
              ref={inputRef}
              type="text"
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={handleKeyDown}
              aria-label="Terminal Command Input"
              autoFocus
              className="flex-1 bg-transparent text-white focus:outline-none font-mono caret-cyan-400"
              spellCheck={false}
              autoComplete="off"
              autoCorrect="off"
              autoCapitalize="none"
              enterKeyHint="send"
              inputMode="text"
            />
          </div>
        )}

        <div ref={bottomRef} />
      </div>

      {/* Key toolbar: keys phone keyboards bury or lack. pointerdown keeps the keyboard open */}
      {!readOnly && (
        <div
          className="flex items-center gap-1.5 px-2 py-1.5 bg-slate-950/80 border-t border-slate-800 overflow-x-auto shrink-0"
          role="toolbar"
          aria-label="Terminal keys"
        >
          {[
            { label: 'Tab', run: completeCommand },
            { label: 'Ctrl+C', run: cancelLine },
            { label: '↑', aria: 'Previous command', run: historyPrev },
            { label: '↓', aria: 'Next command', run: historyNext },
          ].map(k => (
            <button
              key={k.label}
              type="button"
              aria-label={k.aria}
              onPointerDown={(e) => e.preventDefault()}
              onClick={() => { k.run(); inputRef.current?.focus(); }}
              className="min-w-10 h-9 px-2.5 rounded-md bg-slate-800 active:bg-slate-600 text-slate-200 text-xs font-mono border border-slate-700 shrink-0"
            >
              {k.label}
            </button>
          ))}
          <span className="w-px h-5 bg-slate-700 mx-0.5 shrink-0" aria-hidden="true" />
          {['|', '>', '<', '&', '/', '~', '-', '_', '.', '$', '*', '"', "'", '\\', ':'].map(ch => (
            <button
              key={ch}
              type="button"
              aria-label={`Insert ${ch}`}
              onPointerDown={(e) => e.preventDefault()}
              onClick={() => insertAtCaret(ch)}
              className="min-w-9 h-9 px-2 rounded-md bg-slate-800 active:bg-slate-600 text-cyan-300 text-sm font-mono border border-slate-700 shrink-0"
            >
              {ch}
            </button>
          ))}
        </div>
      )}

      {/* Suggested Fast-Execution Commands (Optional Help Bar) */}
      {suggestedCommands.length > 0 && !readOnly && (
        <div className="px-3 py-2 bg-slate-950/70 border-t border-slate-800 flex items-center gap-2 overflow-x-auto text-xs">
          <span className="text-slate-400 flex items-center gap-1 shrink-0 text-[11px]">
            <Sparkles className="w-3 h-3 text-cyan-400" /> Quick Commands:
          </span>
          {suggestedCommands.map((cmd, i) => (
            <button
              key={i}
              onClick={() => {
                setInput(cmd);
                inputRef.current?.focus();
              }}
              className="px-2 py-0.5 rounded bg-slate-800/80 hover:bg-slate-700 text-slate-300 font-mono text-[11px] whitespace-nowrap transition-colors border border-slate-700/50"
            >
              {cmd}
            </button>
          ))}
        </div>
      )}
    </div>
  );
};
