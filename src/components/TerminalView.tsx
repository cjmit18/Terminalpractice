import React, { useState, useRef, useEffect, useLayoutEffect } from 'react';
import { TerminalShell, HistoryItem, FileNode } from '../types/terminal';
import { Copy, Check, Eraser, ArrowUp, ArrowDown } from 'lucide-react';
import { completeFileAt, wordBefore } from '../terminal/complete';
import { useGameLayer } from './celebrate/GameLayer';
import type { TerminalText } from '../lib/activity';

/** The terminal's text size, from Settings */
const TEXT_SIZE: Record<TerminalText, string> = {
  small: 'text-xs',
  medium: 'text-[13px] sm:text-sm',
  large: 'text-[15px] sm:text-base',
};

/** A history entry, plus what the prompt looked like when it was typed */
export interface TerminalLine extends HistoryItem {
  /** User shown in the prompt (bash) */
  user?: string;
  /** Typed at the DISKPART> prompt */
  inDiskpart?: boolean;
}

interface TerminalViewProps {
  shell: TerminalShell;
  cwd: string;
  history: TerminalLine[];
  onExecuteCommand: (command: string) => void;
  onClearHistory: () => void;
  /** Example commands shown as a quiet "Try:" row. Leave empty in labs. */
  suggestedCommands?: string[];
  isDiskpartActive?: boolean;
  currentUser?: string;
  hostname?: string;
  readOnly?: boolean;
  /** Change it when the session is reset (a fresh machine): the login banner shows again. */
  resetKey?: number;
  /** Learning facts noticed at the prompt: 'tab' (Tab completed a name), 'history' (an earlier command recalled) */
  onActivity?: (facts: string[]) => void;
  /** bash prompt layout (the Sandbox lets learners pick one); 'standard' is user@host:~$ */
  promptStyle?: 'standard' | 'bracket' | 'short' | 'host-first';
  /** An extra line under the login banner (the Sandbox lets learners pick one) */
  bannerLine?: string;
  /** The machine's files, so Tab can complete file and folder names as well as commands */
  fs?: FileNode;
}

const SHELL_NAMES: Record<TerminalShell, string> = {
  bash: 'bash',
  cmd: 'Command Prompt',
  powershell: 'PowerShell',
};

const BANNERS: Record<TerminalShell, string> = {
  bash: 'Welcome to Ubuntu 22.04.3 LTS (GNU/Linux 5.15.0-101-generic x86_64)',
  cmd: 'Microsoft Windows [Version 10.0.22621.1]',
  powershell: 'Windows PowerShell',
};

const COMPLETIONS: Record<'linux' | 'windows', string[]> = {
  linux: ['cat', 'cd', 'chmod', 'chown', 'df', 'dmesg', 'echo', 'fdisk', 'grep', 'id', 'ip', 'journalctl', 'ls', 'lsmod', 'lspci', 'man', 'mkdir', 'ping', 'pwd', 'sort', 'sudo', 'systemctl', 'tar', 'umask', 'uniq', 'useradd', 'usermod', 'whoami'],
  windows: ['cd', 'chkdsk', 'cls', 'dir', 'diskpart', 'dism', 'gpresult', 'gpupdate', 'help', 'ipconfig', 'netstat', 'nslookup', 'ping', 'sfc', 'taskkill', 'tasklist', 'tracert', 'type', 'Add-ADGroupMember', 'Get-ADUser', 'Get-Process', 'Get-Service', 'New-ADUser', 'Start-Service', 'Stop-Process', 'Test-NetConnection', 'Unlock-ADAccount'],
};

const SYMBOL_KEYS = ['|', '>', '<', '&', '/', '~', '-', '_', '.', '$', '*', '"', "'", '\\', ':'];

/**
 * True when the new history is what is left after a clear: the lines that were on screen are gone.
 * Only the clear sequence empties the history (or restarts it with the output that followed it,
 * as in `clear; echo hi`) without a reset.
 */
function screenCleared(before: TerminalLine[], after: TerminalLine[]): boolean {
  if (after.length === 0) return true;
  if (before.length > 0) return !after.some(h => h.id === before[before.length - 1].id);
  // From an empty screen, `clear; echo hi` leaves one new line
  return after.length === 1 && /(^|[;&|]\s*)(clear|cls)(\s|;|&|\||$)/i.test(after[0].command);
}

/** /home/student -> ~, the way bash shows it */
function tildePath(cwd: string, user: string) {
  const home = user === 'root' ? '/root' : `/home/${user}`;
  if (cwd === home) return '~';
  if (cwd.startsWith(home + '/')) return '~' + cwd.slice(home.length);
  return cwd;
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
  resetKey = 0,
  onActivity,
  promptStyle = 'standard',
  bannerLine,
  fs,
}) => {
  const terminalText = useGameLayer().prefs.terminalText;
  const [input, setInputValue] = useState('');
  // Names Tab could not choose between, shown under the line until the next change (bash lists them on a second Tab)
  const [tabNames, setTabNames] = useState<string[]>([]);
  const setInput = (value: string) => {
    setInputValue(value);
    setTabNames([]);
  };
  const [copied, setCopied] = useState(false);
  const [historyIndex, setHistoryIndex] = useState<number | null>(null);
  const [showBanner, setShowBanner] = useState(true);
  // Commands for ArrowUp recall, kept apart from the screen so `clear` does not forget them
  const [recall, setRecall] = useState<string[]>([]);
  const seenIds = useRef(new Set<string>());

  useEffect(() => {
    const fresh = history.filter(h => !seenIds.current.has(h.id));
    if (fresh.length === 0) return;
    fresh.forEach(h => seenIds.current.add(h.id));
    setRecall(prev => [...prev, ...fresh.map(h => h.command)]);
  }, [history]);

  const inputRef = useRef<HTMLInputElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  // Keep the newest output in view without scrolling the page itself
  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [history, showBanner]);

  // The login banner: a new shell or a reset machine shows it; `clear`/`cls` (typed, or run from a
  // walkthrough step) wipes it with the rest of the screen, as the Clear button does
  const seen = useRef({ history, shell, resetKey });
  useEffect(() => {
    const before = seen.current;
    seen.current = { history, shell, resetKey };
    if (before.shell !== shell || before.resetKey !== resetKey) {
      setShowBanner(true);
      setHistoryIndex(null);
    } else if (before.history !== history && screenCleared(before.history, history)) {
      setShowBanner(false);
    }
  }, [history, shell, resetKey]);

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
    } else if (e.key === 'Tab' && !e.shiftKey && !e.ctrlKey && !e.altKey && !e.metaKey && input.trim() !== '') {
      // Tab completes the word being typed (a command, or a file or folder name); on an empty line it moves focus as usual
      e.preventDefault();
      complete();
    } else if (e.ctrlKey && e.key.toLowerCase() === 'c') {
      // Let a real selection copy; otherwise Ctrl+C abandons the line like a shell does
      const el = inputRef.current;
      if (el && el.selectionStart !== el.selectionEnd) return;
      e.preventDefault();
      cancelLine();
    } else if (e.ctrlKey && e.key.toLowerCase() === 'l') {
      e.preventDefault();
      clearScreen();
    }
  };

  const historyPrev = () => {
    if (recall.length === 0) return;
    const newIndex = historyIndex === null ? recall.length - 1 : Math.max(0, historyIndex - 1);
    setHistoryIndex(newIndex);
    setInput(recall[newIndex]);
    onActivity?.(['history']);
  };

  const historyNext = () => {
    if (historyIndex === null) return;
    const newIndex = historyIndex + 1;
    if (newIndex >= recall.length) {
      setHistoryIndex(null);
      setInput('');
    } else {
      setHistoryIndex(newIndex);
      setInput(recall[newIndex]);
    }
  };

  // Where Tab works: the caret, or the start of a selection (which the completion replaces, as typing would)
  const caretRange = () => {
    const el = inputRef.current;
    const start = el?.selectionStart ?? input.length;
    return { start, end: el?.selectionEnd ?? start };
  };
  // A completed line; the caret goes just after the completed word, with any text after it kept
  const applyCompletion = (line: string, caret: number) => {
    pendingCaret.current = caret;
    setInput(line);
    onActivity?.(['tab']);
  };

  // Completes the command name (first word) from a short list of commands the labs use. True when it found a match.
  const completeCommand = (word: string, before: string, after: string): boolean => {
    const pool = shell === 'bash' ? COMPLETIONS.linux : COMPLETIONS.windows;
    const matches = pool.filter(c => c.toLowerCase().startsWith(word.toLowerCase()));
    if (matches.length === 1) {
      applyCompletion(before + matches[0] + ' ' + after, before.length + matches[0].length + 1);
    } else if (matches.length > 1) {
      // Extend to the longest shared prefix, like bash does on the first Tab
      let prefix = matches[0];
      for (const m of matches) {
        while (!m.toLowerCase().startsWith(prefix.toLowerCase())) prefix = prefix.slice(0, -1);
      }
      if (prefix.length > word.length) applyCompletion(before + prefix + after, before.length + prefix.length);
      else setTabNames(matches);
    }
    return matches.length > 0;
  };

  // Completes the word at the caret: the first word is a command (unless it looks like a path, such as
  // ./script.sh), later words are file or folder names on this machine
  const complete = () => {
    const { start, end } = caretRange();
    const line = input.slice(0, start) + input.slice(end);
    const word = wordBefore(line, start, shell);
    const raw = line.slice(word.start, start);
    const first = line.slice(0, word.start).trim() === '';
    if (first && raw && !/[/\\~.'"]/.test(raw) && completeCommand(raw, line.slice(0, word.start), line.slice(start))) return;
    if (!fs) return;
    const result = completeFileAt(fs, cwd, line, start, shell);
    if (!result) return;
    if (result.line !== input) applyCompletion(result.line, result.caret);
    else if (result.names.length > 1) setTabNames(result.names);
  };

  const cancelLine = () => {
    setInput('');
    setHistoryIndex(null);
  };

  const clearScreen = () => {
    setShowBanner(false);
    onClearHistory();
  };

  // Insert text at the caret so the toolbar works mid-line, then restore focus and caret.
  // The caret is placed in a layout effect, in the same commit as the new text: placing it a frame
  // later let fast typing land first, and the late caret move then sent later keys to the wrong spot.
  const pendingCaret = useRef<number | null>(null);
  useLayoutEffect(() => {
    const el = inputRef.current;
    if (pendingCaret.current === null || !el) return;
    el.setSelectionRange(pendingCaret.current, pendingCaret.current);
    pendingCaret.current = null;
  }, [input]);
  const insertAtCaret = (text: string) => {
    const el = inputRef.current;
    const start = el?.selectionStart ?? input.length;
    const end = el?.selectionEnd ?? input.length;
    pendingCaret.current = start + text.length;
    setInput(input.slice(0, start) + text + input.slice(end));
    el?.focus();
  };

  const renderPrompt = (promptShell: TerminalShell, promptCwd: string, user: string, diskpart: boolean) => {
    if (diskpart) {
      return <span className="select-none text-term-text">DISKPART&gt; </span>;
    }
    if (promptShell === 'bash' && promptStyle !== 'standard') {
      const path = tildePath(promptCwd, user);
      const end = user === 'root' ? '# ' : '$ ';
      if (promptStyle === 'bracket') {
        return (
          <span className="select-none">
            <span className="text-term-muted">[</span>
            <span className="text-term-user">{user}@{hostname}</span>{' '}
            <span className="text-term-path">{path === '~' || path === '/' ? path : path.split('/').pop()}</span>
            <span className="text-term-muted">]{end}</span>
          </span>
        );
      }
      if (promptStyle === 'short') {
        return (
          <span className="select-none">
            <span className="text-term-path">{path}</span>
            <span className="text-term-muted"> {end}</span>
          </span>
        );
      }
      return (
        <span className="select-none">
          <span className="text-term-user">{hostname}</span>
          <span className="text-term-muted">:</span>
          <span className="text-term-path">{path}</span>{' '}
          <span className="text-term-user">{user}</span>
          <span className="text-term-muted">{end}</span>
        </span>
      );
    }
    if (promptShell === 'bash') {
      return (
        <span className="select-none">
          <span className="text-term-user">{user}@{hostname}</span>
          <span className="text-term-muted">:</span>
          <span className="text-term-path">{tildePath(promptCwd, user)}</span>
          <span className="text-term-muted">{user === 'root' ? '# ' : '$ '}</span>
        </span>
      );
    }
    if (promptShell === 'powershell') {
      return (
        <span className="select-none">
          <span className="text-term-muted">PS </span>
          <span className="text-term-path">{promptCwd}</span>
          <span className="text-term-muted">&gt; </span>
        </span>
      );
    }
    return (
      <span className="select-none">
        <span className="text-term-path">{promptCwd}</span>
        <span className="text-term-muted">&gt;</span>
      </span>
    );
  };

  // The history only changes with a command, not with each keystroke at the prompt
  const historyView = React.useMemo(
    () =>
      history.map((item) => {
        const stdoutText = item.errorOutput ? item.output.replace(item.errorOutput, '').trim() : item.output;
        return (
          <div key={item.id} className="mb-1.5">
            <div className="break-all">
              {renderPrompt(item.shell, item.cwd, item.user ?? currentUser, !!item.inDiskpart)}
              <span>{item.command}</span>
            </div>
            {stdoutText && (
              <pre className={`whitespace-pre-wrap break-words font-mono ${item.isError && !item.errorOutput ? 'text-term-error' : ''}`}>
                {stdoutText}
              </pre>
            )}
            {item.errorOutput && (
              <pre className="whitespace-pre-wrap break-words font-mono text-term-error">{item.errorOutput}</pre>
            )}
            {/* A learning note, not shell output: set apart in the UI font so it never reads as part of the terminal */}
            {item.explanation && (
              <p className="mt-1 mb-2 border-l-2 border-term-line pl-3 font-sans text-[13px] leading-relaxed text-term-muted whitespace-pre-line">
                <span className="font-medium text-term-text">Why: </span>
                {item.explanation}
              </p>
            )}
          </div>
        );
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [history, currentUser, hostname],
  );

  const copyTerminalOutput = async () => {
    const text = history.map(h => `${h.command}\n${h.output}`).join('\n\n');
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard can be blocked (insecure context, permissions); nothing useful to show
    }
  };

  const iconButton =
    'inline-flex items-center justify-center size-10 sm:size-8 rounded-sm text-term-muted hover:text-term-text hover:bg-term-line transition-colors';
  const keyButton =
    'h-9 min-w-9 px-2.5 inline-flex items-center justify-center rounded-sm bg-term-bg border border-term-line text-term-text text-[13px] font-mono active:bg-term-line shrink-0';

  return (
    <div className="flex flex-col h-full min-h-0 w-full rounded-md overflow-hidden bg-term-bg border border-term-line text-term-text focus-within:outline-2 focus-within:outline-offset-2 focus-within:outline-accent">
      {/* Tab bar: which shell, on which machine */}
      <div className="flex items-center justify-between gap-3 h-11 sm:h-10 pl-3 pr-1 bg-term-bar border-b border-term-line shrink-0">
        <div className="flex items-baseline gap-2 min-w-0 text-sm">
          <span className="font-medium text-term-text whitespace-nowrap">
            {SHELL_NAMES[shell]}
            {isDiskpartActive && <span className="text-term-muted"> · DiskPart</span>}
          </span>
          <span className="font-mono text-[13px] text-term-muted truncate">
            {currentUser}@{hostname}
          </span>
        </div>
        <div className="flex items-center shrink-0">
          <button type="button" onClick={copyTerminalOutput} aria-label={copied ? 'Copied' : 'Copy output'} title="Copy output" className={iconButton}>
            {copied ? <Check className="size-4 text-term-user" aria-hidden="true" /> : <Copy className="size-4" aria-hidden="true" />}
          </button>
          <button type="button" onClick={clearScreen} aria-label="Clear terminal" title="Clear terminal" className={iconButton}>
            <Eraser className="size-4" aria-hidden="true" />
          </button>
        </div>
      </div>

      {/* Output and the active input line */}
      <div
        ref={scrollRef}
        className={`flex-1 min-h-0 overflow-y-auto terminal-scrollbar px-3 sm:px-4 py-3 font-mono ${TEXT_SIZE[terminalText]} leading-relaxed`}
        data-text-size={terminalText}
        onClick={() => {
          // Clicking anywhere focuses the prompt, unless the user is selecting output to copy
          if (!window.getSelection()?.toString()) inputRef.current?.focus();
        }}
      >
        <div role="log" aria-live="polite" aria-label="Terminal output">
          {showBanner && (
            <div className="mb-2">
              <p className="text-term-muted">{BANNERS[shell]}</p>
              {bannerLine && <p className="text-term-text">{bannerLine}</p>}
            </div>
          )}

          {historyView}
        </div>

        {!readOnly && (
          <div className="flex items-baseline">
            {/* pre-wrap keeps the space after "$ " that a flex item would otherwise drop */}
            <span className="shrink-0 max-w-[70%] break-all whitespace-pre-wrap">
              {renderPrompt(shell, cwd, currentUser, isDiskpartActive)}
            </span>
            <input
              ref={inputRef}
              type="text"
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={handleKeyDown}
              aria-label="Command"
              autoFocus
              className="flex-1 min-w-0 bg-transparent text-term-text caret-term-text outline-none font-mono"
              spellCheck={false}
              autoComplete="off"
              autoCorrect="off"
              autoCapitalize="none"
              enterKeyHint="send"
              inputMode="text"
            />
          </div>
        )}
        {!readOnly && tabNames.length > 0 && (
          <p className="text-term-muted break-words" aria-live="polite">
            {tabNames.join('  ')}
          </p>
        )}
      </div>

      {/* Keys that phone keyboards bury or lack. Hidden for mouse users. pointerdown keeps the keyboard open */}
      {!readOnly && (
        <div
          className="flex pointer-fine:hidden items-center gap-1 px-2 py-1.5 bg-term-bar border-t border-term-line overflow-x-auto shrink-0 terminal-scrollbar"
          role="toolbar"
          aria-label="Terminal keys"
        >
          {[
            { label: 'Tab', aria: 'Tab, complete the command or file name', run: complete },
            { label: 'Ctrl+C', aria: 'Control C, cancel line', run: cancelLine },
          ].map(k => (
            <button
              key={k.label}
              type="button"
              aria-label={k.aria}
              onPointerDown={(e) => e.preventDefault()}
              onClick={() => { k.run(); inputRef.current?.focus(); }}
              className={keyButton}
            >
              {k.label}
            </button>
          ))}
          <button type="button" aria-label="Previous command" onPointerDown={(e) => e.preventDefault()} onClick={() => { historyPrev(); inputRef.current?.focus(); }} className={keyButton}>
            <ArrowUp className="size-4" aria-hidden="true" />
          </button>
          <button type="button" aria-label="Next command" onPointerDown={(e) => e.preventDefault()} onClick={() => { historyNext(); inputRef.current?.focus(); }} className={keyButton}>
            <ArrowDown className="size-4" aria-hidden="true" />
          </button>
          <span className="w-px h-5 bg-term-line mx-1 shrink-0" aria-hidden="true" />
          {SYMBOL_KEYS.map(ch => (
            <button
              key={ch}
              type="button"
              aria-label={`Insert ${ch}`}
              onPointerDown={(e) => e.preventDefault()}
              onClick={() => insertAtCaret(ch)}
              className={keyButton}
            >
              {ch}
            </button>
          ))}
        </div>
      )}

      {/* Example commands, for the sandbox. Clicking one fills the prompt; it does not run it */}
      {suggestedCommands.length > 0 && !readOnly && (
        <div className="flex items-center gap-1 px-3 py-1.5 bg-term-bar border-t border-term-line overflow-x-auto shrink-0 text-[13px] terminal-scrollbar">
          <span className="text-term-muted shrink-0 pr-1">Try:</span>
          {suggestedCommands.map((cmd) => (
            <button
              key={cmd}
              type="button"
              onClick={() => {
                setInput(cmd);
                inputRef.current?.focus();
              }}
              className="px-2 py-1 rounded-sm font-mono text-term-muted hover:text-term-text hover:bg-term-line whitespace-nowrap transition-colors"
            >
              {cmd}
            </button>
          ))}
        </div>
      )}
    </div>
  );
};
