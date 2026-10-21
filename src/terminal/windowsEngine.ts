import { FileNode, SystemState, TerminalShell } from '../types/terminal';
import { cloneFileSystem, getNodeAtPath, normalizePath, createNode, writeFileContent } from './filesystem';
import { splitChainedCommandLine, parsePipelinedLine, ParsedCommand } from './parser';
import { runChain } from './chain';
import { cloneState } from './state';
import { WindowsContext, WindowsResult, cmdCommands, psCommands } from './windows/context';
import { DISKPART_BANNER, handleDiskpartCommand } from './windows/diskpart';
import './windows/powershell';
import './windows/psSystem';
import { runPowerShellPipeline } from './windows/psPipeline';
import { expandCmdVariables, expandPowerShellEnv, setErrorLevel } from './windows/env';
import { psExtractRedirects, psNotRecognized, psNotSimulated, psSplitPipeline, psStage } from './windows/psUtil';
import { psSplitStatements, psSyntaxError } from './windows/psParse';
import { cmdSyntaxError } from './windows/cmd/syntax';
import { isNotSimulatedWindows } from './notSimulated';
import { suggestCmd, suggestPowerShell } from './suggest';
import './windows/psFiles';
import './windows/cmd/files';
import './windows/cmd/text';
import './windows/cmd/system';
import './windows/cmd/network';
import { NATIVE_TOOLS, cmdSlashHelp, diskpartUsage, psDashQuestion, registerDocAliases } from './windows/help';

export interface WindowsExecutionResult extends WindowsResult {}

registerDocAliases();

export function executeWindowsLine(
  rawInput: string,
  cwd: string,
  fs: FileNode,
  state: SystemState,
  shell: TerminalShell = 'cmd',
  isDiskpartSession = false
): WindowsExecutionResult {
  try {
    return runWindowsLine(rawInput, cwd, fs, state, shell, isDiskpartSession);
  } catch (err) {
    // A simulator bug must not take the session with it: report it and leave everything as it was
    const why = err instanceof Error ? err.message : String(err);
    return {
      stdout: '', stderr: `The simulator hit an internal error and did not run this command (${why}).`, exitCode: 1,
      newCwd: cwd, newFs: fs, newState: state, diskpartActive: isDiskpartSession,
      explanation: 'This is a bug in the simulator, not in your command. Nothing was changed; you can carry on.',
    };
  }
}

function runWindowsLine(
  rawInput: string,
  cwd: string,
  fs: FileNode,
  state: SystemState,
  shell: TerminalShell,
  isDiskpartSession: boolean
): WindowsExecutionResult {
  const line = rawInput.trim();
  if (!line) {
    return { stdout: '', stderr: '', exitCode: 0, newCwd: cwd, newFs: fs, newState: state, diskpartActive: isDiskpartSession };
  }

  if (isDiskpartSession) return handleDiskpartCommand(line, cwd, fs, state);

  if (/^diskpart(\.exe)?\s+\/\?$/i.test(line)) {
    return { stdout: diskpartUsage(), stderr: '', exitCode: 0, newCwd: cwd, newFs: fs, newState: state, diskpartActive: false };
  }

  if (line.toLowerCase() === 'diskpart') {
    return { stdout: DISKPART_BANNER, stderr: '', exitCode: 0, newCwd: cwd, newFs: fs, newState: state, diskpartActive: true };
  }

  if (shell === 'powershell') return executePowerShellCommand(line, cwd, fs, state);

  const syntax = cmdSyntaxError(line);
  if (syntax) return { stdout: '', stderr: syntax, exitCode: 1, newCwd: cwd, newFs: fs, newState: state };

  // CMD expands %VAR% once for the whole line, before splitting on & and |
  const expanded = expandCmdVariables(line, state, cwd);
  const stages = splitChainedCommandLine(expanded, 'cmd');
  // %ERRORLEVEL% reports the exit code of the last command that sets one, updated as each
  // command of the chain actually runs (ones skipped by && or || leave it alone)
  const runStage = (pipeline: string, dir: string, f: FileNode, s: SystemState) => {
    const res = executeCmdPipeline(pipeline, dir, f, s);
    setErrorLevel(res.newState, parsePipelinedLine(pipeline, 'cmd').pop()?.name ?? '', res.exitCode);
    return res;
  };
  return stages.length > 1 ? runChain(stages, cwd, fs, state, runStage) : runStage(expanded, cwd, fs, state);
}

/** Runs one CMD command against the pipeline's working copies, then applies its 2> redirect. */
function executeSingleCmdCommand(
  parsed: ParsedCommand,
  cwd: string,
  fs: FileNode,
  state: SystemState,
  stdin = ''
): WindowsExecutionResult {
  // CMD ends an internal command's name at . \ or /, so cd.. cd\ cd/d and dir/w work without a space
  const glued = cmdCommands.has(parsed.name) ? null : parsed.name.match(/^(cd|chdir|dir|md|mkdir|rd|rmdir)([.\\/].*)$/i);
  if (glued && cmdCommands.has(glued[1])) parsed = { ...parsed, name: glued[1], args: [glued[2], ...parsed.args] };
  // < file: the command reads the file as its standard input
  const lt = /</.test(parsed.raw.replace(/"[^"]*"?|\^./g, '')) ? parsed.args.findIndex(a => a.startsWith('<')) : -1;
  if (lt >= 0) {
    const target = parsed.args[lt] === '<' ? parsed.args[lt + 1] : parsed.args[lt].slice(1);
    if (!target) return { stdout: '', stderr: 'The syntax of the command is incorrect.', exitCode: 1, newCwd: cwd, newFs: fs, newState: state };
    const probe = new WindowsContext('', [], '', '', cwd, fs, state);
    const abs = probe.resolve(target);
    const why = probe.protectedReason(abs, 'read');
    if (why) return { stdout: '', stderr: 'Access is denied.', exitCode: 1, newCwd: cwd, newFs: fs, newState: state, explanation: why };
    const node = probe.node(abs);
    if (!node || node.type !== 'file') {
      return { stdout: '', stderr: node ? 'Access is denied.' : 'The system cannot find the file specified.', exitCode: 1, newCwd: cwd, newFs: fs, newState: state };
    }
    stdin = node.content ?? '';
    const args = [...parsed.args];
    args.splice(lt, parsed.args[lt] === '<' ? 2 : 1);
    parsed = { ...parsed, args, raw: parsed.raw.replace(/\s*<\s*("[^"]*"|[^\s|&>]+)/, '') };
  }
  const ctx = new WindowsContext(parsed.name, parsed.args, stdin, parsed.raw, cwd, fs, cloneState(state));
  const handler = cmdCommands.get(parsed.name);
  // <command> /? prints the command's usage instead of running it
  const usage = cmdSlashHelp(parsed.name, parsed.args);
  let res: WindowsResult = usage !== null
    ? ctx.ok(usage)
    : handler
    ? handler(ctx)
    : isNotSimulatedWindows(parsed.name)
    ? ctx.fail(`'${parsed.name}' exists on real Windows but is not simulated here.`, 9009)
    : ctx.fail(`'${parsed.name}' is not recognized as an internal or external command,\noperable program or batch file.`, 9009, suggestCmd(parsed.name));

  const er = parsed.stderrRedirect;
  if (er) {
    if (er.type === 'merge') {
      // "2>&1 > file" is handled by the pipeline: stderr keeps stdout's original target, the console or pipe
      if (er.afterStdoutRedirect || !parsed.redirect) {
        res = { ...res, stdout: [res.stdout, res.stderr].filter(Boolean).join('\r\n'), stderr: '' };
      }
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
    const er = stage.stderrRedirect;
    // 2>&1 before > file: stderr went to stdout's original target before stdout moved to the file
    const stderrToOldStdout = er?.type === 'merge' && !er.afterStdoutRedirect && !!stage.redirect;
    if (res.stderr && !stderrToOldStdout) errors.push(res.stderr);
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
    input = stderrToOldStdout ? res.stderr : out;
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

function executePowerShellCommand(
  rawLine: string,
  cwd: string,
  fs: FileNode,
  state: SystemState
): WindowsExecutionResult {
  const syntax = psSyntaxError(rawLine);
  if (syntax) return { stdout: '', stderr: syntax, exitCode: 1, newCwd: cwd, newFs: fs, newState: state };
  const statements = psSplitStatements(rawLine);
  if (statements.length <= 1) return executePowerShellStatement(statements[0] ?? '', cwd, fs, state);
  // a; b runs each statement in turn, whether or not the one before it failed
  const out: string[] = [];
  const errors: string[] = [];
  const notes: string[] = [];
  let res: WindowsExecutionResult = { stdout: '', stderr: '', exitCode: 0, newCwd: cwd, newFs: fs, newState: state };
  let exitCode = 0;
  for (const statement of statements) {
    res = executePowerShellStatement(statement, res.newCwd, res.newFs, res.newState);
    if (res.stdout) out.push(res.stdout);
    if (res.stderr) errors.push(res.stderr);
    if (res.explanation && !notes.includes(res.explanation)) notes.push(res.explanation);
    if (res.exitCode !== 0) exitCode = res.exitCode;
  }
  const result: WindowsExecutionResult = { ...res, stdout: out.join('\n'), stderr: errors.join('\n'), exitCode };
  delete result.explanation;
  if (notes.length) result.explanation = notes.join('\n');
  return result;
}

/** Runs one PowerShell statement (one pipeline with its redirections). */
function executePowerShellStatement(
  statement: string,
  cwd: string,
  fs: FileNode,
  state: SystemState
): WindowsExecutionResult {
  if (!statement) return { stdout: '', stderr: '', exitCode: 0, newCwd: cwd, newFs: fs, newState: state };
  const { body, redirect } = psExtractRedirects(expandPowerShellEnv(statement, state));
  let res = runPowerShellLine(body, cwd, fs, state);
  if (redirect.stderr === 'null') res = { ...res, stderr: '' };
  if (redirect.stderr === 'merge') res = { ...res, stdout: [res.stdout, res.stderr].filter(Boolean).join('\n'), stderr: '' };
  for (const [stream, target] of [['stdout', redirect.stdout], ['stderr', typeof redirect.stderr === 'object' ? redirect.stderr : undefined]] as const) {
    if (!target) continue;
    const write = writeWindowsFile(res.newFs, res.newState, normalizePath(target.target, res.newCwd, true), res[stream], target.append);
    res = write ? { ...res, [stream]: '', stderr: write.error, exitCode: 1, explanation: write.explanation } : { ...res, [stream]: '' };
  }
  return res;
}

function runPowerShellLine(
  line: string,
  cwd: string,
  fs: FileNode,
  state: SystemState
): WindowsExecutionResult {
  const stages = psSplitPipeline(line).map(psStage);
  const first = stages[0];
  const ctx = new WindowsContext(first?.name ?? '', first?.args ?? [], '', line, cwd, cloneFileSystem(fs), cloneState(state));
  ctx.tokens = first?.tokens ?? [];
  // A native program's changes (ipconfig /renew, taskkill ...) stick even when its output is piped on
  const runNative = (cmdLine: string) => {
    const res = executeCmdCommand(cmdLine, cwd, ctx.fs, ctx.state);
    ctx.fs = res.newFs;
    ctx.state = res.newState;
    return res;
  };

  if (stages.length > 1) return runPowerShellPipeline(ctx, stages, runNative);
  // A value on its own is output, as in PowerShell
  if (first && !first.tokens.length && /^(["']).*\1$/.test(first.raw)) return ctx.ok(first.name);
  if (/^-?\d+(\.\d+)?$/.test(line.trim())) return ctx.ok(line.trim());
  if (/^\$\w+(\s*=|$)/.test(line.trim())) {
    return ctx.fail('Variables and script expressions are not supported in this simulator; run the cmdlet directly instead.', 1);
  }

  const asked = first ? psDashQuestion(ctx, first.name, first.args) : null;
  if (asked) return asked;

  const handler = first ? psCommands.get(first.name) : undefined;
  const res = handler ? handler(ctx) : null;
  if (res) return res;

  // Native programs (ipconfig.exe, ping.exe, ...) run the same inside PowerShell
  const exe = (first?.name ?? '').toLowerCase().replace(/\.exe$/, '');
  if (NATIVE_TOOLS.includes(exe)) return runNative(line.replace(/^(\S+?)\.exe\b/i, '$1'));
  if (first && isNotSimulatedWindows(first.name)) return ctx.fail(psNotSimulated(first.name), 1);

  return ctx.fail(psNotRecognized(line, first?.name ?? ''), 1, suggestPowerShell(first?.name ?? ''));
}
