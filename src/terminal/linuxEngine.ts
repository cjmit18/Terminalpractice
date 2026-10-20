import { FileNode, SystemState } from '../types/terminal';
import { cloneFileSystem, getNodeAtPath, normalizePath, createNode, canWriteNode, getUserGroups, writeFileContent } from './filesystem';
import { parsePipelinedLine, splitChainedCommandLine, ParsedCommand } from './parser';
import { runChain, StageResult } from './chain';
import { cloneState } from './state';
import { LinuxContext, linuxCommands, newFileMode } from './linux/context';
import './linux/commands/files';
import './linux/commands/text';
import './linux/commands/users';
import './linux/commands/system';
import './linux/commands/network';

export interface LinuxExecutionResult extends StageResult {}

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
  return runChain(splitChainedCommandLine(line, 'bash'), cwd, fs, state, executeLinuxPipeline);
}

/** Shell-level (non-sudo) identity used for redirects: the shell opens files, not the command. */
function shellIdentity(fs: FileNode, state: SystemState) {
  const isRoot = state.isRootOrAdmin || state.currentUser === 'root';
  const user = isRoot ? 'root' : state.currentUser;
  const group = isRoot ? 'root' : state.currentGroup;
  return { user, group, groups: getUserGroups(fs, user, group) };
}

function executeLinuxPipeline(
  pipelineStr: string,
  cwd: string,
  fs: FileNode,
  state: SystemState
): LinuxExecutionResult {
  const stages = parsePipelinedLine(pipelineStr);
  let currentInput = '';
  let activeFs = cloneFileSystem(fs);
  let activeState = cloneState(state);
  let currentCwd = cwd;
  let exitCode = 0;
  let stderr = '';

  const result = (stdout: string, err: string, code: number): LinuxExecutionResult => ({
    stdout, stderr: err, exitCode: code, newCwd: currentCwd, newFs: activeFs, newState: activeState,
  });

  for (let i = 0; i < stages.length; i++) {
    const stage = stages[i];
    const isLast = i === stages.length - 1;

    const res = runLinuxCommand(stage, currentCwd, activeFs, activeState, currentInput);
    currentCwd = res.newCwd;
    activeFs = res.newFs;
    activeState = res.newState;
    exitCode = res.exitCode;
    stderr = res.stderr;

    // Stage stderr redirection (2>, 2>>, 2>&1, 2>/dev/null)
    if (stage.stderrRedirect) {
      if (stage.stderrRedirect.type === 'merge') {
        if (res.stderr) res.stdout = (res.stdout ? res.stdout + '\n' : '') + res.stderr;
      } else if (stage.stderrRedirect.target !== '/dev/null') {
        const id = shellIdentity(activeFs, activeState);
        const errTargetPath = normalizePath(stage.stderrRedirect.target, currentCwd, false);
        const checkErr = canWriteNode(activeFs, errTargetPath, id.user, id.groups, false);
        if (!checkErr.ok) {
          return result('', `bash: ${stage.stderrRedirect.target}: ${checkErr.error || 'Permission denied'}`, 1);
        }
        const existingErr = getNodeAtPath(activeFs, errTargetPath, false);
        if (existingErr && existingErr.type === 'file') {
          writeFileContent(existingErr, res.stderr, stage.stderrRedirect.type === '>>');
        } else {
          createNode(activeFs, errTargetPath, 'file', res.stderr, false, id.user, id.group, newFileMode(activeState));
        }
      }
      res.stderr = '';
      stderr = '';
    }

    // An intermediate command that failed with an error message aborts the pipeline
    if (exitCode !== 0 && res.stderr) return result('', res.stderr, exitCode);

    currentInput = res.stdout;

    if (isLast && stage.redirect) {
      const targetPath = normalizePath(stage.redirect.target, currentCwd, false);
      const id = shellIdentity(activeFs, activeState);
      const check = canWriteNode(activeFs, targetPath, id.user, id.groups, false);
      if (!check.ok) return result('', `bash: ${stage.redirect.target}: ${check.error || 'Permission denied'}`, 1);

      const existing = getNodeAtPath(activeFs, targetPath, false);
      if (existing && existing.type === 'file') {
        writeFileContent(existing, currentInput, stage.redirect.type === '>>');
      } else {
        createNode(activeFs, targetPath, 'file', currentInput, false, id.user, id.group, newFileMode(activeState));
      }
      return result('', stderr, 0);
    }
  }

  return result(currentInput, stderr, exitCode);
}

const SUDO_USAGE = 'usage: sudo -h | -K | -k | -V\nusage: sudo -v [-AknS] [-g group] [-h host] [-p prompt] [-u user]\nusage: sudo -l [-AknS] [-g group] [-h host] [-p prompt] [-U user] [-u user] [command]';

/** Resolves sudo, then dispatches one parsed command to its registered handler. */
function runLinuxCommand(
  cmd: ParsedCommand,
  cwd: string,
  fs: FileNode,
  state: SystemState,
  stdin: string
): StageResult {
  let { name, args } = cmd;
  let isSudo = false;
  if (name === 'sudo') {
    if (args.length === 0) {
      return { stdout: SUDO_USAGE, stderr: '', exitCode: 1, newCwd: cwd, newFs: fs, newState: state };
    }
    isSudo = true;
    name = args[0];
    args = args.slice(1);
  }

  const ctx = new LinuxContext(name, args, stdin, cwd, fs, cloneState(state), isSudo);
  const handler = linuxCommands.get(name);
  if (!handler) return ctx.fail(`bash: ${name}: command not found`, 127);
  return handler(ctx);
}
