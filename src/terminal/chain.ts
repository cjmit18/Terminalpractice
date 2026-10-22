import { FileNode, SystemState } from '../types/terminal';
import { ChainedStage } from './parser';

/** Fields every engine result carries; engines extend this with their own extras. */
export interface StageResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  newCwd: string;
  newFs: FileNode;
  newState: SystemState;
  /** Plain-language note on why a permission check failed (see permissions in filesystem.ts). */
  explanation?: string;
  /** For a chained line: each stage's exit code in order, null for a stage skipped by && or || */
  stageExits?: (number | null)[];
}

/**
 * Runs chained stages (&&, ||, ;) in order, threading cwd/fs/state through them.
 * Shared by bash and CMD: the operators behave the same once the line is split.
 */
export function runChain(
  stages: ChainedStage[],
  cwd: string,
  fs: FileNode,
  state: SystemState,
  runStage: (commandLine: string, cwd: string, fs: FileNode, state: SystemState) => StageResult
): StageResult {
  let currentCwd = cwd;
  let currentFs = fs;
  let currentState = state;
  let stdout = '';
  let lastExitCode = 0;
  const errors: string[] = [];
  const notes: string[] = [];
  const stageExits: (number | null)[] = [];

  for (let i = 0; i < stages.length; i++) {
    const prevOp = i > 0 ? stages[i - 1].nextOp : undefined;
    if ((prevOp === '&&' && lastExitCode !== 0) || (prevOp === '||' && lastExitCode === 0)) {
      stageExits.push(null);
      continue;
    }

    const res = runStage(stages[i].commandLine, currentCwd, currentFs, currentState);
    currentCwd = res.newCwd;
    currentFs = res.newFs;
    currentState = res.newState;
    lastExitCode = res.exitCode;
    stageExits.push(res.exitCode);
    if (res.stderr) errors.push(res.stderr);
    if (res.explanation && !notes.includes(res.explanation)) notes.push(res.explanation);
    if (res.stdout) stdout += (stdout ? '\n' : '') + res.stdout;
  }

  const result: StageResult = {
    stdout,
    stderr: errors.join('\n'),
    exitCode: lastExitCode,
    newCwd: currentCwd,
    newFs: currentFs,
    newState: currentState,
    stageExits,
  };
  if (notes.length) result.explanation = notes.join('\n');
  return result;
}
