import { useCallback, useRef, useState } from 'react';
import { CommandContext } from '../../types/modules';
import { FileNode, SystemState, TerminalShell } from '../../types/terminal';
import { executeLinuxLine } from '../../terminal/linuxEngine';
import { executeWindowsLine } from '../../terminal/windowsEngine';
import { TerminalLine } from '../TerminalView';

/** Everything one simulated machine needs between commands */
export interface ShellSession {
  fs: FileNode;
  state: SystemState;
  cwd: string;
  history: TerminalLine[];
  diskpartActive: boolean;
  lastResult?: CommandContext;
}

export function createSession(fs: FileNode, state: SystemState, cwd: string): ShellSession {
  return { fs, state, cwd, history: [], diskpartActive: false, lastResult: undefined };
}

// `clear` and `cls` answer with the ANSI "erase display" sequence
const CLEAR_SCREEN = '\x1b[2J';

let lineCounter = 0;

/** Runs one command line against a session and returns the next session. Pure apart from the id counter. */
export function runLine(session: ShellSession, line: string, shell: TerminalShell): ShellSession {
  const promptCwd = session.cwd;
  const promptUser = session.state.currentUser;
  const inDiskpart = session.diskpartActive;

  let stdout: string;
  let stderr: string;
  let exitCode: number;
  let explanation: string | undefined;
  let next: Omit<ShellSession, 'history' | 'lastResult'>;

  if (shell === 'bash') {
    const res = executeLinuxLine(line, session.cwd, session.fs, session.state);
    ({ stdout, stderr, exitCode, explanation } = res);
    next = { fs: res.newFs, state: res.newState, cwd: res.newCwd, diskpartActive: false };
  } else {
    const res = executeWindowsLine(line, session.cwd, session.fs, session.state, shell, session.diskpartActive);
    ({ stdout, stderr, exitCode, explanation } = res);
    next = { fs: res.newFs, state: res.newState, cwd: res.newCwd, diskpartActive: !!res.diskpartActive };
    // The engine ends the DiskPart banner with its own prompt; the terminal draws the live one
    if (next.diskpartActive) stdout = stdout.replace(/\s*DISKPART>\s*$/, '');
  }

  const lastResult: CommandContext = { command: line, exitCode, stdout };

  if (stdout.includes(CLEAR_SCREEN)) {
    return { ...next, history: [], lastResult };
  }

  const entry: TerminalLine = {
    id: `cmd-${++lineCounter}`,
    command: line,
    output: [stdout, stderr].filter(Boolean).join(shell === 'bash' ? '\n' : '\r\n'),
    errorOutput: stderr || undefined,
    isError: exitCode !== 0,
    explanation,
    timestamp: new Date().toLocaleTimeString(),
    // The prompt the command was typed at, not the directory it left us in
    cwd: promptCwd,
    shell,
    user: promptUser,
    inDiskpart,
  };

  return { ...next, history: [...session.history, entry], lastResult };
}

/**
 * Holds a session in a ref so several commands in the same tick (a multi-line walkthrough step,
 * a simulator button) each see the result of the previous one, then mirrors it into React state.
 * `onChange` is called synchronously with every new session.
 */
export function useShellSession(initial: () => ShellSession, onChange?: (s: ShellSession) => void) {
  const [session, setSession] = useState<ShellSession>(initial);
  const ref = useRef<ShellSession>(session);
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;

  const commit = useCallback((next: ShellSession) => {
    ref.current = next;
    setSession(next);
    onChangeRef.current?.(next);
  }, []);

  /** Run lines in order; each one starts from the session the previous one produced */
  const run = useCallback(
    (lines: string | string[], shell: TerminalShell) => {
      const list = (Array.isArray(lines) ? lines : [lines]).map(l => l.trim()).filter(Boolean);
      for (const line of list) {
        commit(runLine(ref.current, line, shell));
      }
    },
    [commit]
  );

  /** Replace the system state directly (used by simulator panels that edit state without a command) */
  const setSystemState = useCallback(
    (state: SystemState) => commit({ ...ref.current, state }),
    [commit]
  );

  const clearHistory = useCallback(() => {
    ref.current = { ...ref.current, history: [] };
    setSession(ref.current);
  }, []);

  const reset = useCallback((next: ShellSession) => commit(next), [commit]);

  return { session, run, setSystemState, clearHistory, reset };
}
