import { FileNode, SystemState } from '../../types/terminal';
import { StageResult } from '../chain';
import { CommandRegistry } from '../registry';
import { getNodeAtPath, normalizePath, getUserGroups, toOctalField } from '../filesystem';

export type LinuxResult = StageResult;

/** File creation mode after the umask, as a FileNode octal field. Also used for redirects. */
export function newFileMode(state: SystemState): number {
  return toOctalField(0o666 & ~state.umask);
}

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

  /** Mode for a newly created regular file: 666 minus the umask (e.g. 644 with umask 022). */
  fileMode(): number {
    return newFileMode(this.state);
  }

  /** Mode for a newly created directory: 777 minus the umask (e.g. 755 with umask 022). */
  dirMode(): number {
    return toOctalField(0o777 & ~this.state.umask);
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
