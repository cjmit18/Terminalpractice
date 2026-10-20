import { FileNode, SystemState } from '../../types/terminal';
import { StageResult } from '../chain';
import { CommandRegistry } from '../registry';
import {
  getNodeAtPath, normalizePath, getUserGroups, toOctalField, AccessCheck, canReadNode, canWriteNode,
  canDeleteNode, checkAccess, findTraversalDenial, describeIdentity,
} from '../filesystem';

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

  /**
   * Explanations recorded by the permission helpers below. When a handler's stderr reports
   * "Permission denied" / "Operation not permitted", the engine attaches them to the result.
   */
  readonly denials: string[] = [];

  /** Script nesting level (0 for a line typed at the prompt). */
  depth = 0;

  private record(check: AccessCheck): AccessCheck {
    if (!check.ok && check.explanation && !this.denials.includes(check.explanation)) {
      this.denials.push(check.explanation);
    }
    return check;
  }

  /** Records an explanation for a denial the handler detected itself. */
  deny(explanation: string): void {
    if (!this.isRoot && !this.denials.includes(explanation)) this.denials.push(explanation);
  }

  canRead(absPath: string): AccessCheck {
    return this.record(canReadNode(this.fs, absPath, this.user, this.groups, false));
  }

  canWrite(absPath: string): AccessCheck {
    return this.record(canWriteNode(this.fs, absPath, this.user, this.groups, false));
  }

  canDelete(absPath: string): AccessCheck {
    return this.record(canDeleteNode(this.fs, absPath, this.user, this.groups, false));
  }

  /** r/w/x on a node already looked up (e.g. x to enter a directory, r to list it). */
  access(node: FileNode, absPath: string, mode: 'r' | 'w' | 'x', purpose?: string): AccessCheck {
    return this.record(checkAccess(node, absPath, this.user, this.groups, mode, purpose));
  }

  /** x on every directory leading to absPath (not the last component). */
  traverse(absPath: string): AccessCheck {
    const blocked = findTraversalDenial(this.fs, absPath, this.user, this.groups);
    if (!blocked) return { ok: true };
    return this.access(blocked.node, blocked.path, 'x',
      `To reach ${absPath} you need execute (x) on every directory along the path, but ${blocked.path}`);
  }

  /** Explanation for commands that only root may run at all. */
  needsRoot(what: string): string {
    return `${describeIdentity(this.user, this.groups)} ${what} requires root privileges; run it with sudo.`;
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
