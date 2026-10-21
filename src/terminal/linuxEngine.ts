import { FileNode, SystemState } from '../types/terminal';
import {
  cloneFileSystem, getNodeAtPath, normalizePath, canWriteNode, canReadNode, getUserGroups, writeFileContent,
  describeIdentity, findTraversalDenial,
} from './filesystem';
import { ParsedCommand } from './parser';
import {
  splitBashChain, parseBashPipeline, expandWord, expandToString, assignmentOf, Expander, ExpansionError, Field,
} from './linux/shell';
import { shellVariable, homeOf } from './linux/env';
import { runChain, StageResult } from './chain';
import { cloneState } from './state';
import { LinuxContext, linuxCommands, newFileMode, createInDir } from './linux/context';
import { runScriptFile, isScriptPath, setLineRunner } from './linux/scripts';
import './linux/commands/files';
import './linux/commands/copymove';
import './linux/commands/find';
import './linux/commands/text';
import './linux/commands/users';
import './linux/commands/system';
import './linux/commands/network';
import './linux/commands/accounts';
import './linux/commands/printf';
import './linux/commands/lookup';
import { helpOptionOutput } from './linux/commands/help';
import { syncKernelFiles } from './linux/virtualFs';
import { expandArgs } from './linux/glob';
import { isNotSimulatedLinux } from './notSimulated';

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
  return runChain(splitBashChain(line), cwd, fs, state, (stage, c, f, s) => {
    const res = executeLinuxPipeline(stage, c, f, s, depth);
    // $? reads the status of the last pipeline
    return { ...res, newState: { ...res.newState, lastExitCode: res.exitCode } };
  });
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
  if (target === '') return { error: 'bash: : No such file or directory' };
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
    createInDir(fs, path, 'file', '', id.user, id.group, newFileMode(state));
  }
  return { opened: { path, append: true } };
}

/** Opens `< file` for reading as the shell user. */
function openInput(target: string, cwd: string, fs: FileNode, state: SystemState): { text?: string; isDir?: boolean; error?: string; explanation?: string } {
  const path = normalizePath(target, cwd, false);
  if (path === DEV_NULL) return { text: '' };
  const id = shellIdentity(fs, state);
  const node = getNodeAtPath(fs, path, false);
  if (id.user !== 'root' && findTraversalDenial(fs, path, id.user, id.groups)) {
    return { error: `bash: ${target}: Permission denied` };
  }
  if (!node) return { error: `bash: ${target}: No such file or directory` };
  if (node.type === 'directory') return { isDir: true };
  const check = canReadNode(fs, path, id.user, id.groups, false);
  if (!check.ok) return { error: `bash: ${target}: ${check.error || 'Permission denied'}`, explanation: check.explanation };
  return { text: node.content ?? '' };
}

function writeRedirect(fs: FileNode, target: OpenedRedirect, content: string): void {
  if (!target.path) return;
  const node = getNodeAtPath(fs, target.path, false);
  if (node && node.type === 'file') writeFileContent(node, content, target.append);
}

/** Where a file descriptor points: the stage's stdout (pipe or terminal), the terminal's stderr, or a file. */
type Sink = { kind: 'out' } | { kind: 'err' } | { kind: 'file'; file: OpenedRedirect };

/** The expander bash uses for one command: variables, ~, and $(...) / `...` run in a subshell. */
function makeExpander(
  env: { cwd: string; fs: FileNode; state: SystemState; depth: number },
  errors: string[]
): Expander {
  return {
    lookup: name => shellVariable(name, env.cwd, env.fs, env.state),
    assign: (name, value) => { env.state = { ...env.state, envVars: { ...env.state.envVars, [name]: value } }; },
    home: user => (user === '' ? shellVariable('HOME', env.cwd, env.fs, env.state) : homeOf(env.fs, user)),
    substitute: src => {
      if (env.depth >= 8) throw new ExpansionError('bash: maximum nesting level exceeded');
      // A subshell: file changes are real, but its variables and directory do not come back
      const res = runLinuxLine(src, env.cwd, env.fs, env.state, env.depth + 1);
      env.fs = res.newFs;
      if (res.stderr) errors.push(res.stderr);
      return res.stdout;
    },
  };
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
  const stages = parseBashPipeline(pipelineStr);
  let input = '';
  let activeFs = cloneFileSystem(fs);
  let activeState = cloneState(state);
  syncKernelFiles(activeFs, activeState);
  let currentCwd = cwd;
  let exitCode = 0;
  const errors: string[] = [];
  const notes: string[] = [];

  for (const stage of stages) {
    let fd1: Sink = { kind: 'out' };
    let fd2: Sink = { kind: 'err' };
    let stdin = input;
    const expandErrors: string[] = [];
    const envRef = { cwd: currentCwd, fs: activeFs, state: activeState, depth };
    const ex = makeExpander(envRef, expandErrors);
    const fail = (stderr: string, code: number, explanation?: string): StageResult => {
      const r: StageResult = { stdout: '', stderr, exitCode: code, newCwd: currentCwd, newFs: activeFs, newState: activeState };
      if (explanation) r.explanation = explanation;
      return r;
    };
    /** Expands a word, keeping the file system and variables a substitution or ${X:=y} changed. */
    const expanding = <T>(fn: () => T): T | StageResult => {
      try {
        return fn();
      } catch (e) {
        if (e instanceof ExpansionError) return fail(e.message, 1);
        throw e;
      } finally {
        activeFs = envRef.fs;
        activeState = envRef.state;
      }
    };
    const isResult = (v: unknown): v is StageResult => typeof v === 'object' && v !== null && 'exitCode' in v;

    const res = ((): StageResult => {
      // Expansion: leading NAME=value words, then the command words, then redirect targets
      const assignments: { name: string; value: string }[] = [];
      const fields: Field[] = [];
      const words = expanding(() => {
        let i = 0;
        for (; i < stage.words.length; i++) {
          const a = assignmentOf(stage.words[i]);
          if (!a) break;
          assignments.push({ name: a.name, value: expandToString(a.value, ex) });
        }
        for (; i < stage.words.length; i++) fields.push(...expandWord(stage.words[i], ex));
        return true;
      });
      if (isResult(words)) return words;

      for (const r of stage.redirs) {
        let target = '';
        if (r.op !== '>&') {
          if (!r.target) return fail("bash: syntax error near unexpected token `newline'", 2);
          const word = r.target;
          const t = expanding(() => expandToString(word, ex));
          if (isResult(t)) return t;
          target = t;
        }
        if (r.op === '<') {
          const o = openInput(target, currentCwd, activeFs, activeState);
          if (o.error) return fail(o.error, 1, o.explanation);
          if (o.isDir) return fail(`${fields[0]?.text ?? 'bash'}: -: Is a directory`, 1);
          if (r.fd === 0) stdin = o.text ?? '';
        } else if (r.op === '<<<') {
          if (r.fd === 0) stdin = target;
        } else if (r.op === '>&') {
          const from: Sink | null = r.dupFrom === 1 ? fd1 : r.dupFrom === 2 ? fd2 : null;
          if (!from) return fail(`bash: ${r.dupFrom}: Bad file descriptor`, 1);
          if (r.fd === 1) fd1 = from;
          else if (r.fd === 2) fd2 = from;
        } else {
          const o = openRedirect(target, r.op === '>>' || r.op === '&>>' ? '>>' : '>', currentCwd, activeFs, activeState);
          if (!o.opened) return fail(o.error!, 1, o.explanation);
          const sink: Sink = { kind: 'file', file: o.opened };
          if (r.op === '&>' || r.op === '&>>') { fd1 = sink; fd2 = sink; }
          else if (r.fd === 1) fd1 = sink;
          else if (r.fd === 2) fd2 = sink;
        }
      }
      if (stage.pipeStderr) fd2 = fd1;

      if (fields.length === 0) {
        // Only assignments (or a bare redirect such as "> file"): set the variables in this shell
        if (assignments.length) {
          activeState = { ...activeState, envVars: { ...activeState.envVars } };
          for (const a of assignments) activeState.envVars[a.name] = a.value;
        }
        return { stdout: '', stderr: '', exitCode: 0, newCwd: currentCwd, newFs: activeFs, newState: activeState };
      }
      const rest = fields.slice(1);
      const cmd: ParsedCommand = {
        raw: pipelineStr,
        name: fields[0].text,
        args: rest.map(f => f.text),
        argGlobs: rest.some(f => f.glob) ? rest.map(f => f.glob) : undefined,
      };
      if (!assignments.length) return runLinuxCommand(cmd, currentCwd, activeFs, activeState, stdin, depth);
      // NAME=value cmd: the variables are set for this command only
      const saved = activeState.envVars;
      const runState = { ...activeState, envVars: { ...saved, ...Object.fromEntries(assignments.map(a => [a.name, a.value])) } };
      const out = runLinuxCommand(cmd, currentCwd, activeFs, runState, stdin, depth);
      return { ...out, newState: { ...out.newState, envVars: saved } };
    })();

    currentCwd = res.newCwd;
    activeFs = res.newFs;
    activeState = res.newState;
    exitCode = res.exitCode;
    errors.push(...expandErrors);

    // Route the command's output to where its descriptors point
    const toOut: string[] = [];
    const toErr: string[] = [];
    const toFile = new Map<OpenedRedirect, string[]>();
    const send = (sink: Sink, text: string) => {
      if (!text) return;
      if (sink.kind === 'out') toOut.push(text);
      else if (sink.kind === 'err') toErr.push(text);
      else toFile.set(sink.file, [...(toFile.get(sink.file) ?? []), text]);
    };
    send(fd1, res.stdout);
    send(fd2, res.stderr);
    for (const [file, texts] of toFile) writeRedirect(activeFs, file, texts.join('\n'));
    // A message that went to a file is never seen, so there is nothing to explain
    const note = fd2.kind === 'file' ? undefined : res.explanation;
    if (toErr.length) errors.push(toErr.join('\n'));
    if (note && !notes.includes(note)) notes.push(note);
    input = toOut.join('\n');
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
  if (!name) return ctx.fail('bash: : command not found', 127);

  let res: StageResult;
  const binHelp = /^\/(usr\/)?s?bin\/[^/]+$/.test(name) ? helpOptionOutput(name.slice(name.lastIndexOf('/') + 1), args) : null;
  if (binHelp) {
    res = ctx.result(binHelp.stdout, binHelp.stderr, binHelp.exitCode);
  } else if (isScriptPath(name)) {
    res = runScriptFile(ctx, name, true);
  } else {
    const handler = linuxCommands.get(name);
    if (!handler) {
      if (isNotSimulatedLinux(name)) return ctx.fail(`bash: ${name}: this command exists on real systems but is not simulated here`, 127);
      return ctx.fail(`bash: ${name}: command not found`, 127);
    }
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
