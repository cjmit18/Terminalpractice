import test from 'node:test';
import assert from 'node:assert/strict';
import { windowsSession } from './testUtils.ts';
import { executeWindowsLine } from './windowsEngine.ts';
import { WINDOWS_PBQS } from '../data/windowsPbqs.ts';

// Regression tests for the round-2 fact-check of the Windows engine (Package B, L2-* and N-* IDs).

const STUDENT = { currentUser: 'Student', currentGroup: 'Users', isRootOrAdmin: false };

test('B1 (L2-4): PowerShell parse errors stop the line, with the 5.1 ParserError block', () => {
  const run = windowsSession('powershell');
  const cases: [string, RegExp, string][] = [
    ['"unclosed', /The string is missing the terminator: "\./, 'TerminatorExpectedAtEndOfString'],
    ['{', /Missing closing '\}' in statement block or type definition\./, 'MissingEndCurlyBrace'],
    ['Get-Process |', /An empty pipe element is not allowed\./, 'EmptyPipeElement'],
    ['| Get-Process', /An empty pipe element is not allowed\./, 'EmptyPipeElement'],
    ['(Get-Service', /Missing closing '\)' in expression\./, 'MissingEndParenthesisInExpression'],
    ['Get-Service && Get-Process', /The token '&&' is not a valid statement separator in this version\./, 'InvalidEndOfLine'],
  ];
  for (const [line, message, id] of cases) {
    const res = run(line);
    assert.equal(res.exitCode, 1, line);
    assert.equal(res.stdout, '', line);
    assert.match(res.stderr, message, line);
    assert.match(res.stderr, /CategoryInfo {10}: ParserError: \(:\) \[\], ParentContainsErrorRecordException/, line);
    assert.match(res.stderr, new RegExp(`FullyQualifiedErrorId : ${id}$`), line);
  }
  // The ~ marks the place the parser stopped: after the pipe
  assert.match(run('Get-Process |').stderr, /^At line:1 char:14\n\+ Get-Process \|\n\+ {14}~\n/);
  // A parse error runs nothing, not even the part before it
  run('Start-Service W32Time; Get-Service |');
  assert.equal(run.state().services.find(s => s.name === 'W32Time')?.status, 'Stopped');
});

test('B1 (L2-4): CMD rejects operators with no command on one side', () => {
  const run = windowsSession('cmd');
  assert.deepEqual([run('|').stderr, run('|').exitCode], ['| was unexpected at this time.', 1]);
  assert.equal(run('| dir').stderr, '| was unexpected at this time.');
  assert.equal(run('dir && && ver').stderr, '&& was unexpected at this time.');
  assert.equal(run('dir |').stderr, 'The syntax of the command is incorrect.');
  assert.equal(run('dir >').stderr, 'The syntax of the command is incorrect.');
  // Quoted and escaped operators are text
  assert.equal(run('echo "a|b"').stdout, '"a|b"');
  assert.equal(run('echo a ^| b').stdout, 'a | b');
  assert.equal(run('dir 2>&1 | findstr Desktop').exitCode, 0);
});

test('B1: an internal error is reported and leaves fs, state and cwd unchanged', () => {
  const lab = WINDOWS_PBQS[0];
  const fs = structuredClone(lab.initialFs);
  // A state the engine cannot work with (no services list) makes Get-Service throw
  const state = { ...structuredClone(lab.initialState), services: undefined } as unknown as typeof lab.initialState;
  const res = executeWindowsLine('Get-Service', 'C:\\Users\\Student', fs, state, 'powershell');
  assert.equal(res.exitCode, 1);
  assert.match(res.stderr, /internal error/);
  assert.equal(res.newFs, fs);
  assert.equal(res.newState, state);
  assert.equal(res.newCwd, 'C:\\Users\\Student');
});

test('B2 (L2-12): PowerShell runs statements separated by ; in order', () => {
  const lab = WINDOWS_PBQS.find(m => m.id === 'win-pbq-powershell-automation')!;
  const run = windowsSession('powershell');
  const res = run('Start-Service W32Time; Get-Service W32Time');
  assert.equal(res.exitCode, 0);
  assert.match(res.stdout, /Running +W32Time +Windows Time/);
  const objective = lab.objectives.find(o => o.id === 'ps-start-service')!;
  assert.ok(objective.verifier(run.fs(), run.state(), { command: 'Start-Service W32Time; Get-Service W32Time', exitCode: 0, stdout: res.stdout }));

  const both = windowsSession('powershell')('Get-Location; Get-Service W32Time');
  assert.match(both.stdout, /^\nPath\n----\nC:\\Users\\Student\n/);
  assert.match(both.stdout, /Stopped +W32Time/);
  // A ; inside quotes is text, a failing statement does not stop the next, and # starts a comment
  assert.equal(windowsSession('powershell')('Write-Output "a;b"; Write-Output c').stdout, 'a;b\nc');
  const failed = windowsSession('powershell')('Get-Service nosuch; Write-Output after');
  assert.equal(failed.stdout, 'after');
  assert.match(failed.stderr, /Cannot find any service with service name 'nosuch'/);
  assert.equal(failed.exitCode, 1);
  assert.equal(windowsSession('powershell')('Get-Service W32Time # the time service').exitCode, 0);
  // cd in one statement moves the next one
  assert.match(windowsSession('powershell')('cd C:\\; Get-Location').stdout, /\nC:\\\n/);
});

test('B3 (L2-11): CMD cd.. cd\\ cd. cd/d and chdir.., PowerShell cd.. and cd\\', () => {
  const cmd = windowsSession('cmd');
  assert.equal(cmd('cd..').exitCode, 0);
  assert.equal(cmd.cwd(), 'C:\\Users');
  cmd('cd.');
  assert.equal(cmd.cwd(), 'C:\\Users');
  cmd('cd\\');
  assert.equal(cmd.cwd(), 'C:\\');
  cmd('cd/d C:\\Users\\Student');
  assert.equal(cmd.cwd(), 'C:\\Users\\Student');
  cmd('chdir..');
  assert.equal(cmd.cwd(), 'C:\\Users');
  cmd('cd\\Windows');
  assert.equal(cmd.cwd(), 'C:\\Windows');
  assert.match(cmd('cd/?').stdout, /CHDIR \[\/D\]/);

  const ps = windowsSession('powershell');
  assert.equal(ps('cd..').exitCode, 0);
  assert.equal(ps.cwd(), 'C:\\Users');
  ps('cd\\');
  assert.equal(ps.cwd(), 'C:\\');
});
