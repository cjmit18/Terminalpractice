import { FileNode, SystemState } from '../types/terminal';
import {
  cloneFileSystem, getNodeAtPath, normalizePath, createNode, canWriteNode, getUserGroups, writeFileContent,
  describeIdentity,
} from './filesystem';
import { parsePipelinedLine, splitChainedCommandLine, ParsedCommand } from './parser';
import { runChain, StageResult } from './chain';
import { cloneState } from './state';
import { LinuxContext, linuxCommands, newFileMode } from './linux/context';
import { runScriptFile, isScriptPath, setLineRunner } from './linux/scripts';
import './linux/commands/files';
import './linux/commands/copymove';
import './linux/commands/find';
import './linux/commands/text';
import './linux/commands/users';
import './linux/commands/system';
import './linux/commands/network';
import './linux/commands/accounts';
import { helpOptionOutput } from './linux/commands/help';
import { syncKernelFiles } from './linux/virtualFs';
import { expandArgs } from './linux/glob';

export interface LinuxExecutionResult extends StageResult {}

/** Most commands a session remembers for `history` (bash's default HISTSIZE). */
const HISTORY_LIMIT = 500;

export function executeLinuxLine(
  rawInput: string,
  cwd: string,
  fs: FileNode,
  state: SystemState
): LinuxExecutionResult {
  const line = rawInput.trim();
  if (!line) {
    return { stdout: '', stderr: '', exitCode: 0, newCwd: cwd, newFs: fs, newState: state };
  }
  // Like bash, the line enters history before it runs, so `history` lists itself
  const recorded: SystemState = {
    ...state,
    commandHistory: [...(state.commandHistory ?? []), line].slice(-HISTORY_LIMIT),
  };
  return runLinuxLine(line, cwd, fs, recorded, 0);
}

/** Runs a line without recording it in history (used for scripts and `bash -c`). */
export function runLinuxLine(line: string, cwd: string, fs: FileNode, state: SystemState, depth: number): LinuxExecutionResult {
  return runChain(splitChainedCommandLine(line, 'bash'), cwd, fs, state,
    (stage, c, f, s) => executeLinuxPipeline(stage, c, f, s, depth));
}

/** Shell-level (non-sudo) identity used for redirects: the shell opens files, not the command. */
function shellIdentity(fs: FileNode, state: SystemState) {
  const isRoot = state.isRootOrAdmin || state.currentUser === 'root';
  const user = isRoot ? 'root' : state.currentUser;
  const group = isRoot ? 'root' : state.currentGroup;
  return { user, group, groups: getUserGroups(fs, user, group) };
}

const DEV_NULL = '/dev/null';

interface OpenedRedirect {
  path: string | null; // null: discard (/dev/null)
  append: boolean;
}

/**
 * Opens a redirect target the way bash does before running the command: checks write
 * permission, creates the file if needed and truncates it for `>`.
 */
function openRedirect(
  target: string,
  type: '>' | '>>',
  cwd: string,
  fs: FileNode,
  state: SystemState
): { opened?: OpenedRedirect; error?: string; explanation?: string } {
  const path = normalizePath(target, cwd, false);
  if (path === DEV_NULL) return { opened: { path: null, append: false } };
  const id = shellIdentity(fs, state);
  const existing = getNodeAtPath(fs, path, false);
  if (existing && existing.type === 'directory') return { error: `bash: ${target}: Is a directory` };
  const check = canWriteNode(fs, path, id.user, id.groups, false);
  if (!check.ok) return { error: `bash: ${target}: ${check.error || 'Permission denied'}`, explanation: check.explanation };
  if (existing) {
    if (type === '>') writeFileContent(existing, '');
  } else {
    createNode(fs, path, 'file', '', false, id.user, id.group, newFileMode(state));
  }
  return { opened: { path, append: true } };
}

function writeRedirect(fs: FileNode, target: OpenedRedirect, content: string): void {
  if (!target.path) return;
  const node = getNodeAtPath(fs, target.path, false);
  if (node && node.type === 'file') writeFileContent(node, content, target.append);
}

/**
 * Runs a pipeline. As in bash, every stage runs even if an earlier one failed; each stage's
 * stderr goes to the terminal (unless redirected) and the exit code is the last stage's.
 */
function executeLinuxPipeline(
  pipelineStr: string,
  cwd: string,
  fs: FileNode,
  state: SystemState,
  depth: number
): LinuxExecutionResult {
  const stages = parsePipelinedLine(pipelineStr);
  let input = '';
  let activeFs = cloneFileSystem(fs);
  let activeState = cloneState(state);
  syncKernelFiles(activeFs, activeState);
  let currentCwd = cwd;
  let exitCode = 0;
  const errors: string[] = [];
  const notes: string[] = [];

  for (const stage of stages) {
    let stdoutTarget: OpenedRedirect | undefined;
    let stderrTarget: OpenedRedirect | undefined;
    let res: StageResult;

    const redirectError = (() => {
      const er = stage.stderrRedirect;
      if (er && er.type !== 'merge') {
        const o = openRedirect(er.target, er.type, currentCwd, activeFs, activeState);
        if (!o.opened) return o;
        stderrTarget = o.opened;
      }
      if (stage.redirect) {
        const o = openRedirect(stage.redirect.target, stage.redirect.type, currentCwd, activeFs, activeState);
        if (!o.opened) return o;
        stdoutTarget = o.opened;
      }
      return null;
    })();

    if (redirectError) {
      // The shell could not open a redirect, so the command never runs
      res = { stdout: '', stderr: redirectError.error!, exitCode: 1, newCwd: currentCwd, newFs: activeFs, newState: activeState };
      if (redirectError.explanation) res.explanation = redirectError.explanation;
    } else {
      res = runLinuxCommand(stage, currentCwd, activeFs, activeState, input, depth);
    }
    currentCwd = res.newCwd;
    activeFs = res.newFs;
    activeState = res.newState;
    exitCode = res.exitCode;

    let out = res.stdout;
    let err = res.stderr;
    let note = res.explanation;
    if (stage.stderrRedirect?.type === 'merge') {
      // 2>&1: stderr follows stdout (to the terminal, the pipe, or a > file)
      out = [out, err].filter(Boolean).join('\n');
      err = '';
    } else if (stderrTarget) {
      writeRedirect(activeFs, stderrTarget, err);
      err = '';
      note = undefined; // the learner never sees the message, so no note either
    }
    if (stdoutTarget) {
      writeRedirect(activeFs, stdoutTarget, out);
      out = '';
    }
    if (err) errors.push(err);
    if (note && !notes.includes(note)) notes.push(note);
    input = out;
  }

  const result: LinuxExecutionResult = {
    stdout: input,
    stderr: errors.join('\n'),
    exitCode,
    newCwd: currentCwd,
    newFs: activeFs,
    newState: activeState,
  };
  if (notes.length) result.explanation = notes.join('\n');
  return result;
}

setLineRunner(runLinuxLine);

const SUDO_USAGE = 'usage: sudo -h | -K | -k | -V\nusage: sudo -v [-AknS] [-g group] [-h host] [-p prompt] [-u user]\nusage: sudo -l [-AknS] [-g group] [-h host] [-p prompt] [-U user] [-u user] [command]';
const SUDO_GROUPS = ['sudo', 'wheel', 'admin'];
const DENIAL = /Permission denied|Operation not permitted/;

/** Resolves sudo, then dispatches one parsed command to its registered handler. */
function runLinuxCommand(
  cmd: ParsedCommand,
  cwd: string,
  fs: FileNode,
  state: SystemState,
  stdin: string,
  depth: number
): StageResult {
  let { name, args } = cmd;
  // Pathname expansion happens in the calling shell, as the calling user, before sudo or the command runs
  if (cmd.argGlobs) {
    const isRoot = state.isRootOrAdmin || state.currentUser === 'root';
    const user = isRoot ? 'root' : state.currentUser;
    args = expandArgs(args, cmd.argGlobs, cwd, fs, { user, groups: getUserGroups(fs, user, isRoot ? 'root' : state.currentGroup), isRoot });
  }
  let runState = cloneState(state);
  let isSudo = false;
  let asUserState = false;

  if (name === 'sudo') {
    const plain = new LinuxContext('sudo', args, stdin, cwd, fs, runState, false);
    const allowed = plain.isRoot || plain.groups.some(g => SUDO_GROUPS.includes(g));
    if (args[0] === '-h' || args[0] === '--help') return plain.ok(helpOptionOutput('sudo', ['--help'])!.stdout);
    if (args[0] === '-l' || args[0] === '--list') {
      const host = runState.hostname;
      if (!allowed) return plain.fail(`Sorry, user ${plain.user} may not run sudo on ${host}.`, 1);
      return plain.ok([
        `Matching Defaults entries for ${plain.user} on ${host}:`,
        '    env_reset, mail_badpass, secure_path=/usr/local/sbin\\:/usr/local/bin\\:/usr/sbin\\:/usr/bin\\:/sbin\\:/bin\\:/snap/bin, use_pty',
        '',
        `User ${plain.user} may run the following commands on ${host}:`,
        '    (ALL : ALL) ALL',
      ].join('\n'));
    }
    if (!allowed) {
      return plain.fail(
        `${plain.user} is not in the sudoers file.  This incident will be reported.`, 1,
        `${describeIdentity(plain.user, plain.groups)} sudo only lets members of the 'sudo' group (configured in /etc/sudoers) run commands as root.`
      );
    }
    // sudo -u USER runs as that user instead of root
    let asUser: string | null = null;
    while (args[0]?.startsWith('-')) {
      if (args[0] === '-u' && args[1]) {
        asUser = args[1];
        args = args.slice(2);
      } else if (args[0] === '-i' || args[0] === '-s') {
        args = ['su', ...args.slice(1)];
      } else {
        args = args.slice(1);
      }
    }
    if (args.length === 0) return plain.result(SUDO_USAGE, '', 1);
    name = args[0];
    args = args.slice(1);
    if (asUser && asUser !== 'root') {
      runState = { ...runState, currentUser: asUser, currentGroup: asUser, isRootOrAdmin: false };
      asUserState = true;
    } else {
      isSudo = true;
    }
  }

  const ctx = new LinuxContext(name, args, stdin, cwd, fs, runState, isSudo);
  ctx.depth = depth;
  if (!name) return ctx.ok(); // a bare redirect such as "> file"
  const assignment = name.match(/^([A-Za-z_]\w*)=(.*)$/s);
  if (assignment && args.length === 0) {
    // NAME=value sets a shell variable (kept with the environment so echo $NAME sees it)
    ctx.state.envVars = { ...ctx.state.envVars, [assignment[1]]: assignment[2] };
    return ctx.ok();
  }

  let res: StageResult;
  const binHelp = /^\/(usr\/)?s?bin\/[^/]+$/.test(name) ? helpOptionOutput(name.slice(name.lastIndexOf('/') + 1), args) : null;
  if (binHelp) {
    res = ctx.result(binHelp.stdout, binHelp.stderr, binHelp.exitCode);
  } else if (isScriptPath(name)) {
    res = runScriptFile(ctx, name, true);
  } else {
    const handler = linuxCommands.get(name);
    if (!handler) return ctx.fail(`bash: ${name}: command not found`, 127);
    // --help is answered here, from the docs, so the command itself never runs
    const help = helpOptionOutput(name, args);
    res = help ? ctx.result(help.stdout, help.stderr, help.exitCode) : handler(ctx);
  }

  if (asUserState) {
    // sudo -u only changes who runs this one command
    res = { ...res, newState: { ...res.newState, currentUser: state.currentUser, currentGroup: state.currentGroup, isRootOrAdmin: state.isRootOrAdmin } };
  }
  if (!res.explanation && !ctx.isRoot && ctx.denials.length && DENIAL.test(res.stderr)) {
    res = { ...res, explanation: ctx.denials.join('\n') };
  }
  return res;
}
