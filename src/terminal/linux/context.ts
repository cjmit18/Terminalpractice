import { FileNode, SystemState } from '../../types/terminal';
import { StageResult } from '../chain';
import { CommandRegistry } from '../registry';
import { getNodeAtPath, normalizePath, getUserGroups } from '../filesystem';

export type LinuxResult = StageResult;

/**
 * Everything a Linux command handler needs. The fs and state are the pipeline's private
 * working copies, so handlers may mutate them freely; the caller's objects are never touched.
 */
export class LinuxContext {
  readonly isRoot: boolean;
  readonly user: string;
  readonly group: string;
  readonly groups: string[];

  constructor(
    public name: string,
    public args: string[],
    public stdin: string,
    public cwd: string,
    public fs: FileNode,
    public state: SystemState,
    public readonly isSudo: boolean
  ) {
    this.isRoot = isSudo || state.isRootOrAdmin || state.currentUser === 'root';
    this.user = this.isRoot ? 'root' : state.currentUser;
    this.group = this.isRoot ? 'root' : state.currentGroup;
    this.groups = getUserGroups(fs, this.user, this.group);
  }

  /** Resolves a path argument against the current directory. */
  resolve(path: string): string {
    return normalizePath(path, this.cwd, false);
  }

  /** Looks up a node by (absolute) path. */
  node(absPath: string): FileNode | null {
    return getNodeAtPath(this.fs, absPath, false);
  }

  result(stdout: string, stderr: string, exitCode: number, explanation?: string): LinuxResult {
    const res: LinuxResult = {
      stdout,
      stderr,
      exitCode,
      newCwd: this.cwd,
      newFs: this.fs,
      newState: this.state,
    };
    if (explanation) res.explanation = explanation;
    return res;
  }

  ok(stdout = ''): LinuxResult {
    return this.result(stdout, '', 0);
  }

  fail(stderr: string, exitCode = 1, explanation?: string): LinuxResult {
    return this.result('', stderr, exitCode, explanation);
  }
}

export type LinuxHandler = (ctx: LinuxContext) => LinuxResult;

export const linuxCommands = new CommandRegistry<LinuxContext, LinuxResult>();
