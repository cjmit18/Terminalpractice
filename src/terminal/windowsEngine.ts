import { FileNode, SystemState, TerminalShell } from '../types/terminal';
import { cloneFileSystem, getNodeAtPath, normalizePath, createNode, writeFileContent } from './filesystem';
import { splitChainedCommandLine, parsePipelinedLine, ParsedCommand } from './parser';
import { runChain } from './chain';
import { cloneState } from './state';
import { WindowsContext, WindowsResult, cmdCommands, psCommands } from './windows/context';
import { DISKPART_BANNER, handleDiskpartCommand } from './windows/diskpart';
import { runPowerShellPipeline } from './windows/powershell';
import { expandCmdVariables, expandPowerShellEnv } from './windows/env';
import { psNotRecognized } from './windows/psUtil';
import './windows/psFiles';
import './windows/cmd/files';
import './windows/cmd/text';
import './windows/cmd/system';
import './windows/cmd/network';

export interface WindowsExecutionResult extends WindowsResult {}

export function executeWindowsLine(
  rawInput: string,
  cwd: string,
  fs: FileNode,
  state: SystemState,
  shell: TerminalShell = 'cmd',
  isDiskpartSession = false
): WindowsExecutionResult {
  const line = rawInput.trim();
  if (!line) {
    return { stdout: '', stderr: '', exitCode: 0, newCwd: cwd, newFs: fs, newState: state, diskpartActive: isDiskpartSession };
  }

  if (isDiskpartSession) return handleDiskpartCommand(line, cwd, fs, state);

  if (line.toLowerCase() === 'diskpart') {
    return { stdout: DISKPART_BANNER, stderr: '', exitCode: 0, newCwd: cwd, newFs: fs, newState: state, diskpartActive: true };
  }

  if (shell === 'powershell') return executePowerShellCommand(line, cwd, fs, state);

  // CMD expands %VAR% once for the whole line, before splitting on & and |
  const expanded = expandCmdVariables(line, state, cwd);
  const stages = splitChainedCommandLine(expanded, 'cmd');
  if (stages.length > 1) return runChain(stages, cwd, fs, state, executeCmdPipeline);
  return executeCmdPipeline(expanded, cwd, fs, state);
}

/** Runs one CMD command against the pipeline's working copies, then applies its 2> redirect. */
function executeSingleCmdCommand(
  parsed: ParsedCommand,
  cwd: string,
  fs: FileNode,
  state: SystemState,
  stdin = ''
): WindowsExecutionResult {
  const ctx = new WindowsContext(parsed.name, parsed.args, stdin, parsed.raw, cwd, fs, cloneState(state));
  const handler = cmdCommands.get(parsed.name);
  let res: WindowsResult = handler
    ? handler(ctx)
    : ctx.fail(`'${parsed.name}' is not recognized as an internal or external command,\noperable program or batch file.`, 9009);

  const er = parsed.stderrRedirect;
  if (er) {
    if (er.type === 'merge') {
      res = { ...res, stdout: [res.stdout, res.stderr].filter(Boolean).join('\r\n'), stderr: '' };
    } else {
      const write = writeWindowsFile(res.newFs, res.newState, normalizePath(er.target, res.newCwd, true), res.stderr, er.type === '>>');
      res = write ? { ...res, stderr: write.error, exitCode: 1, explanation: write.explanation } : { ...res, stderr: '', explanation: undefined };
    }
  }
  return res;
}

/**
 * Writes redirected output. Returns an error when a standard user targets a protected folder.
 * NUL discards output.
 */
function writeWindowsFile(fs: FileNode, state: SystemState, targetPath: string, content: string, append: boolean): { error: string; explanation?: string } | null {
  const norm = targetPath.toLowerCase();
  if (norm === 'nul' || norm.endsWith('\\nul') || norm.endsWith('/nul')) return null;
  const probe = new WindowsContext('', [], '', '', 'C:\\', fs, state);
  const why = probe.protectedReason(targetPath, 'write');
  if (why) return { error: 'Access is denied.', explanation: why };
  const existing = getNodeAtPath(fs, targetPath, true);
  if (existing && existing.type === 'directory') return { error: 'Access is denied.' };
  if (existing) {
    writeFileContent(existing, content, append, '\r\n');
  } else if (!getNodeAtPath(fs, targetPath.slice(0, targetPath.lastIndexOf('\\')) || 'C:\\', true)) {
    return { error: 'The system cannot find the path specified.' };
  } else {
    createNode(fs, targetPath, 'file', content, true, state.currentUser, state.isRootOrAdmin ? 'Administrators' : 'Users', 644);
  }
  return null;
}

/**
 * Runs a CMD pipeline. Every stage runs (as in CMD), errors are collected, and the exit code
 * is the last stage's.
 */
function executeCmdPipeline(
  pipelineStr: string,
  cwd: string,
  fs: FileNode,
  state: SystemState
): WindowsExecutionResult {
  const stages = parsePipelinedLine(pipelineStr, 'cmd');
  let input = '';
  let activeFs = cloneFileSystem(fs);
  let activeState = cloneState(state);
  let currentCwd = cwd;
  let exitCode = 0;
  const errors: string[] = [];
  const notes: string[] = [];

  for (const stage of stages) {
    const res = executeSingleCmdCommand(stage, currentCwd, activeFs, activeState, input);
    currentCwd = res.newCwd;
    activeFs = res.newFs;
    activeState = res.newState;
    exitCode = res.exitCode;
    let out = res.stdout;
    if (res.stderr) errors.push(res.stderr);
    if (res.explanation && !notes.includes(res.explanation)) notes.push(res.explanation);
    if (stage.redirect) {
      const write = writeWindowsFile(activeFs, activeState, normalizePath(stage.redirect.target, currentCwd, true), out, stage.redirect.type === '>>');
      if (write) {
        errors.push(write.error);
        if (write.explanation) notes.push(write.explanation);
        exitCode = 1;
      }
      out = '';
    }
    input = out;
  }
  const result: WindowsExecutionResult = {
    stdout: input, stderr: errors.join('\n'), exitCode, newCwd: currentCwd, newFs: activeFs, newState: activeState,
  };
  if (notes.length) result.explanation = notes.join('\n');
  return result;
}

export function executeCmdCommand(
  rawInput: string,
  cwd: string,
  fs: FileNode,
  state: SystemState
): WindowsExecutionResult {
  return executeCmdPipeline(rawInput, cwd, fs, state);
}

/** Programs (not CMD built-ins) that PowerShell can run directly. */
const NATIVE_TOOLS = new Set([
  'ipconfig', 'ping', 'tracert', 'nslookup', 'netstat', 'route', 'tasklist', 'taskkill', 'sfc', 'dism', 'gpupdate',
  'gpresult', 'net', 'whoami', 'hostname', 'systeminfo', 'chkdsk', 'findstr', 'more', 'bootrec',
]);

function executePowerShellCommand(
  rawLine: string,
  cwd: string,
  fs: FileNode,
  state: SystemState
): WindowsExecutionResult {
  const line = expandPowerShellEnv(rawLine, state);
  const stages = parsePipelinedLine(line, 'powershell');
  const first = stages[0];
  const ctx = new WindowsContext(first?.name ?? '', first?.args ?? [], '', line, cwd, cloneFileSystem(fs), cloneState(state));

  const piped = runPowerShellPipeline(ctx, stages);
  if (piped) return piped;

  const handler = first ? psCommands.get(first.name) : undefined;
  const res = handler ? handler(ctx) : null;
  if (res) return res;

  // Native programs (ipconfig.exe, ping.exe, ...) run the same inside PowerShell
  const exe = (first?.name ?? '').toLowerCase().replace(/\.exe$/, '');
  if (NATIVE_TOOLS.has(exe)) return executeCmdCommand(line.replace(/^(\S+?)\.exe\b/i, '$1'), cwd, fs, state);

  return ctx.fail(psNotRecognized(line, first?.name ?? ''), 1);
}
