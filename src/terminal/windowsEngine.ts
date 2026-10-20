import { FileNode, SystemState, TerminalShell } from '../types/terminal';
import { cloneFileSystem, getNodeAtPath, normalizePath, createNode, writeFileContent } from './filesystem';
import { splitChainedCommandLine, parsePipelinedLine, ParsedCommand } from './parser';
import { runChain } from './chain';
import { cloneState } from './state';
import { WindowsContext, WindowsResult, cmdCommands, psCommands } from './windows/context';
import { DISKPART_BANNER, handleDiskpartCommand } from './windows/diskpart';
import { runPowerShellPipeline } from './windows/powershell';
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

  const stages = splitChainedCommandLine(line, 'cmd');
  if (stages.length > 1) return runChain(stages, cwd, fs, state, executeCmdPipeline);
  return executeCmdPipeline(line, cwd, fs, state);
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
    : ctx.fail(`'${parsed.name.toLowerCase()}' is not recognized as an internal or external command,\noperable program or batch file.`, 9009);

  const er = parsed.stderrRedirect;
  if (er) {
    if (er.type === 'merge') {
      res = { ...res, stdout: [res.stdout, res.stderr].filter(Boolean).join('\r\n'), stderr: '' };
    } else if (er.target.toLowerCase() === 'nul') {
      res = { ...res, stderr: '' };
    } else {
      writeWindowsFile(res.newFs, normalizePath(er.target, res.newCwd, true), res.stderr, er.type === '>>');
      res = { ...res, stderr: '' };
    }
  }
  return res;
}

function writeWindowsFile(fs: FileNode, targetPath: string, content: string, append: boolean) {
  const norm = targetPath.toLowerCase();
  if (norm === 'nul' || norm.endsWith('\\nul') || norm.endsWith('/nul')) return;
  const existing = getNodeAtPath(fs, targetPath, true);
  if (existing && existing.type === 'file') {
    writeFileContent(existing, content, append, '\r\n');
  } else {
    createNode(fs, targetPath, 'file', content, true, 'Administrator', 'Administrators', 644);
  }
}

function executeCmdPipeline(
  pipelineStr: string,
  cwd: string,
  fs: FileNode,
  state: SystemState
): WindowsExecutionResult {
  const stages = parsePipelinedLine(pipelineStr, 'cmd');
  let currentInput = '';
  let activeFs = cloneFileSystem(fs);
  let activeState = cloneState(state);
  let currentCwd = cwd;
  let exitCode = 0;
  let stderr = '';

  const result = (stdout: string, err: string, code: number): WindowsExecutionResult => ({
    stdout, stderr: err, exitCode: code, newCwd: currentCwd, newFs: activeFs, newState: activeState,
  });

  for (let i = 0; i < stages.length; i++) {
    const stage = stages[i];
    const isLast = i === stages.length - 1;
    const res = executeSingleCmdCommand(stage, currentCwd, activeFs, activeState, currentInput);
    currentCwd = res.newCwd;
    activeFs = res.newFs;
    activeState = res.newState;
    exitCode = res.exitCode;
    stderr = res.stderr;

    if (exitCode !== 0 && res.stderr) return result('', res.stderr, exitCode);

    currentInput = res.stdout;

    if (isLast && stage.redirect && exitCode === 0) {
      if (stage.redirect.target.toLowerCase() !== 'nul') {
        writeWindowsFile(activeFs, normalizePath(stage.redirect.target, currentCwd, true), currentInput, stage.redirect.type === '>>');
      }
      return result('', stderr, 0);
    }
  }
  return result(currentInput, stderr, exitCode);
}

export function executeCmdCommand(
  rawInput: string,
  cwd: string,
  fs: FileNode,
  state: SystemState
): WindowsExecutionResult {
  return executeCmdPipeline(rawInput, cwd, fs, state);
}

function executePowerShellCommand(
  line: string,
  cwd: string,
  fs: FileNode,
  state: SystemState
): WindowsExecutionResult {
  const stages = parsePipelinedLine(line, 'powershell');
  const first = stages[0];
  const ctx = new WindowsContext(first?.name ?? '', first?.args ?? [], '', line, cwd, cloneFileSystem(fs), cloneState(state));

  const piped = runPowerShellPipeline(ctx, stages);
  if (piped) return piped;

  const handler = first ? psCommands.get(first.name) : undefined;
  const res = handler ? handler(ctx) : null;
  if (res) return res;

  // Native tools (ipconfig, ping, ...) run the same inside PowerShell
  return executeCmdCommand(line, cwd, fs, state);
}
