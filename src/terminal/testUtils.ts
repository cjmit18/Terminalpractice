// Helpers shared by the engine test files (not used by the app).
import { FileNode, SystemState, TerminalShell } from '../types/terminal';
import { executeLinuxLine, LinuxExecutionResult } from './linuxEngine';
import { executeWindowsLine, WindowsExecutionResult } from './windowsEngine';
import { LPI_MODULES } from '../data/lpiModules';
import { WINDOWS_PBQS } from '../data/windowsPbqs';

export interface LinuxSession {
  (line: string): LinuxExecutionResult;
  fs: () => FileNode;
  state: () => SystemState;
  cwd: () => string;
}

/** A bash session on a copy of the first LPI lab, logged in as student (sudo member). */
export function linuxSession(overrides: Partial<SystemState> = {}, cwd = '/home/student'): LinuxSession {
  let fs = structuredClone(LPI_MODULES[0].initialFs);
  let state: SystemState = {
    ...structuredClone(LPI_MODULES[0].initialState),
    currentUser: 'student', currentGroup: 'student', isRootOrAdmin: false,
    ...overrides,
  };
  let dir = cwd;
  const run = ((line: string) => {
    const res = executeLinuxLine(line, dir, fs, state);
    fs = res.newFs;
    state = res.newState;
    dir = res.newCwd;
    return res;
  }) as LinuxSession;
  run.fs = () => fs;
  run.state = () => state;
  run.cwd = () => dir;
  return run;
}

export interface WindowsSession {
  (line: string): WindowsExecutionResult;
  fs: () => FileNode;
  state: () => SystemState;
  cwd: () => string;
}

/** A CMD or PowerShell session on a copy of the first Windows PBQ (Administrator by default). */
export function windowsSession(shell: TerminalShell = 'cmd', overrides: Partial<SystemState> = {}): WindowsSession {
  let fs = structuredClone(WINDOWS_PBQS[0].initialFs);
  let state: SystemState = { ...structuredClone(WINDOWS_PBQS[0].initialState), ...overrides };
  let dir = 'C:\\Users\\Student';
  let diskpart = false;
  const run = ((line: string) => {
    const res = executeWindowsLine(line, dir, fs, state, shell, diskpart);
    fs = res.newFs;
    state = res.newState;
    dir = res.newCwd;
    diskpart = !!res.diskpartActive;
    return res;
  }) as WindowsSession;
  run.fs = () => fs;
  run.state = () => state;
  run.cwd = () => dir;
  return run;
}
