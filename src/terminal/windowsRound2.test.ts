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
  void STUDENT;
});
