import { StageResult } from '../chain';
import { LinuxContext, linuxCommands } from './context';

// Running files: ./script.sh, /usr/bin/ls, bash script.sh, bash -c "...", source / .

const MAX_DEPTH = 8;
const BIN_DIRS = ['/bin', '/usr/bin', '/sbin', '/usr/sbin', '/usr/local/bin'];

/** A command name with a slash is run as a file instead of being looked up. */
export function isScriptPath(name: string): boolean {
  return name.includes('/');
}

// Imported lazily to avoid a module cycle with linuxEngine.ts (which imports this file).
type LineRunner = (line: string, cwd: string, fs: import('../../types/terminal').FileNode,
  state: import('../../types/terminal').SystemState, depth: number, tty?: boolean) => StageResult;
let lineRunner: LineRunner | null = null;
export function setLineRunner(fn: LineRunner): void {
  lineRunner = fn;
}

/**
 * Runs one command line as a child process of the current command (find -exec, xargs):
 * filesystem changes persist, the caller's cwd and identity do not change.
 */
export function runChildLine(ctx: LinuxContext, line: string): StageResult {
  if (!lineRunner || ctx.depth >= MAX_DEPTH) return ctx.fail('bash: maximum nesting level exceeded', 1);
  const state = ctx.isSudo ? { ...ctx.state, currentUser: 'root', currentGroup: 'root', isRootOrAdmin: true } : ctx.state;
  const res = lineRunner(line, ctx.cwd, ctx.fs, state, ctx.depth + 1, ctx.tty);
  ctx.fs = res.newFs;
  ctx.state = {
    ...res.newState,
    currentUser: ctx.state.currentUser,
    currentGroup: ctx.state.currentGroup,
    isRootOrAdmin: ctx.state.isRootOrAdmin,
  };
  return res;
}

/** Runs a script's lines one by one, collecting output like a child shell would. */
function runLines(ctx: LinuxContext, text: string, subshell: boolean, args: string[] = []): StageResult {
  const depth = ctx.depth;
  if (depth >= MAX_DEPTH) return ctx.fail('bash: maximum nesting level exceeded', 1);
  if (!lineRunner) return ctx.fail('bash: script execution unavailable', 1);
  const saved = { cwd: ctx.cwd, state: ctx.state };
  // Inside sudo, the child shell runs as root
  let state = ctx.isSudo ? { ...ctx.state, currentUser: 'root', currentGroup: 'root', isRootOrAdmin: true } : ctx.state;
  let fs = ctx.fs;
  let cwd = ctx.cwd;
  const out: string[] = [];
  const err: string[] = [];
  const notes: string[] = [];
  let code = 0;
  for (const raw of text.split('\n')) {
    let line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    line = line.replace(/\$(\d)/g, (_, n) => (n === '0' ? ctx.name : args[Number(n) - 1] ?? ''));
    const res = lineRunner(line, cwd, fs, state, depth + 1, ctx.tty);
    ({ newFs: fs, newState: state, newCwd: cwd } = res);
    if (res.stdout) out.push(res.stdout);
    if (res.stderr) err.push(res.stderr);
    if (res.explanation) notes.push(res.explanation);
    code = res.exitCode;
  }
  ctx.fs = fs;
  if (subshell) {
    // A child process cannot change its parent's directory, user or umask
    ctx.cwd = saved.cwd;
    ctx.state = {
      ...state,
      currentUser: saved.state.currentUser,
      currentGroup: saved.state.currentGroup,
      isRootOrAdmin: saved.state.isRootOrAdmin,
      umask: saved.state.umask,
      envVars: saved.state.envVars,
    };
  } else {
    ctx.cwd = cwd;
    ctx.state = state;
  }
  return ctx.result(out.join('\n'), err.join('\n'), code, notes.join('\n') || undefined);
}

/**
 * Executes a file named with a path. Binaries in the standard bin directories run the
 * registered command of the same name; anything else is treated as a shell script.
 * `needsExec` is false for `bash file` / `source file`, which only need read permission.
 */
export function runScriptFile(ctx: LinuxContext, name: string, needsExec: boolean, args = ctx.args): StageResult {
  const path = ctx.resolve(name);
  const node = ctx.node(path);
  const missingCode = needsExec || ctx.name === 'bash' || ctx.name === 'sh' ? 127 : 1;
  if (!node) return ctx.fail(`bash: ${name}: No such file or directory`, missingCode);
  if (!ctx.traverse(path).ok) return ctx.fail(`bash: ${name}: Permission denied`, needsExec ? 126 : 1);
  if (node.type === 'directory') return ctx.fail(`bash: ${name}: Is a directory`, 126);

  if (needsExec) {
    if (!ctx.access(node, path, 'x').ok) return ctx.fail(`bash: ${name}: Permission denied`, 126);
    const dir = path.slice(0, path.lastIndexOf('/')) || '/';
    const base = path.slice(path.lastIndexOf('/') + 1);
    const builtin = linuxCommands.get(base);
    if (BIN_DIRS.includes(dir) && builtin) {
      ctx.name = base;
      return builtin(ctx);
    }
  }
  if (!ctx.access(node, path, 'r').ok) return ctx.fail(`bash: ${name}: Permission denied`, needsExec ? 126 : 1);
  const subshell = !(ctx.name === 'source' || ctx.name === '.');
  return runLines(ctx, node.content || '', subshell, args);
}

// bash [-c CMD | FILE [ARGS]], sh, source FILE, . FILE
linuxCommands.register(['bash', 'sh'], ctx => {
  if (ctx.args[0] === '-c') return runLines(ctx, ctx.args[1] ?? '', true);
  const file = ctx.args.find(a => !a.startsWith('-'));
  if (!file) return ctx.ok(); // an interactive child shell has nothing to do here
  return runScriptFile(ctx, file, false, ctx.args.slice(ctx.args.indexOf(file) + 1));
});
linuxCommands.register(['source', '.'], ctx => {
  if (!ctx.args[0]) return ctx.fail(`bash: ${ctx.name}: filename argument required`, 2);
  return runScriptFile(ctx, ctx.args[0], false, ctx.args.slice(1));
});
