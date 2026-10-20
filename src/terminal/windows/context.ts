import { FileNode, SystemState } from '../../types/terminal';
import { StageResult } from '../chain';
import { CommandRegistry } from '../registry';
import { getNodeAtPath, normalizePath } from '../filesystem';

export interface WindowsResult extends StageResult {
  diskpartActive?: boolean;
}

/**
 * Context handed to CMD and PowerShell handlers. As on Linux, fs and state are private
 * working copies owned by the running pipeline.
 */
export class WindowsContext {
  constructor(
    /** Command name as typed (CMD lookups are case-insensitive). */
    public name: string,
    public args: string[],
    public stdin: string,
    /** The full stage text, for commands that parse their own syntax (set, PowerShell cmdlets). */
    public raw: string,
    public cwd: string,
    public fs: FileNode,
    public state: SystemState
  ) {}

  get isAdmin(): boolean {
    return this.state.isRootOrAdmin;
  }

  resolve(path: string): string {
    return normalizePath(path, this.cwd, true);
  }

  node(absPath: string): FileNode | null {
    return getNodeAtPath(this.fs, absPath, true);
  }

  result(stdout: string, stderr: string, exitCode: number): WindowsResult {
    return { stdout, stderr, exitCode, newCwd: this.cwd, newFs: this.fs, newState: this.state };
  }

  ok(stdout = ''): WindowsResult {
    return this.result(stdout, '', 0);
  }

  fail(stderr: string, exitCode = 1): WindowsResult {
    return this.result('', stderr, exitCode);
  }
}

export type WindowsHandler = (ctx: WindowsContext) => WindowsResult;

/** CMD built-ins and external tools, keyed case-insensitively. */
export const cmdCommands = new CommandRegistry<WindowsContext, WindowsResult>(true);

/**
 * PowerShell cmdlets and aliases. A handler may return null to fall back to the CMD
 * registry, which is how native tools such as ipconfig keep working inside PowerShell.
 */
export const psCommands = new CommandRegistry<WindowsContext, WindowsResult | null>(true);
