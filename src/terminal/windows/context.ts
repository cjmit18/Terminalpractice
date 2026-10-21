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

  result(stdout: string, stderr: string, exitCode: number, explanation?: string): WindowsResult {
    const res: WindowsResult = { stdout, stderr, exitCode, newCwd: this.cwd, newFs: this.fs, newState: this.state };
    if (explanation) res.explanation = explanation;
    return res;
  }

  ok(stdout = ''): WindowsResult {
    return this.result(stdout, '', 0);
  }

  fail(stderr: string, exitCode = 1, explanation?: string): WindowsResult {
    return this.result('', stderr, exitCode, explanation);
  }

  /**
   * Windows ACLs are not modelled per file; instead, like a default install, standard users
   * may not modify C:\Windows or C:\Program Files, nor open another user's profile.
   * Returns an explanation when `absPath` is off limits for this action, otherwise null.
   */
  protectedReason(absPath: string, action: 'read' | 'write'): string | null {
    if (this.isAdmin) return null;
    const p = absPath.toLowerCase();
    const who = `You are '${this.state.currentUser}', a standard user (not elevated).`;
    if (action === 'write' && (p === 'c:\\windows' || p.startsWith('c:\\windows\\') || p.startsWith('c:\\program files'))) {
      return `${who} ${absPath.split('\\').slice(0, 2).join('\\')} is protected: only Administrators and SYSTEM may change files there, so run the prompt as administrator.`;
    }
    const profile = p.match(/^c:\\users\\([^\\]+)/);
    if (profile && profile[1] !== this.state.currentUser.toLowerCase() && profile[1] !== 'public') {
      return `${who} The profile folder C:\\Users\\${absPath.split('\\')[2]} belongs to another account, and its ACL grants access only to that user, SYSTEM and Administrators.`;
    }
    return null;
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
