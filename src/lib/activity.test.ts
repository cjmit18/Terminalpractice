import test from 'node:test';
import assert from 'node:assert/strict';
import type { TerminalShell } from '../types/terminal.ts';
import { linuxSession, windowsSession } from '../terminal/testUtils.ts';
import {
  Activity,
  CommandOutcome,
  EMPTY_ACTIVITY,
  addFacts,
  classifyCommand,
  clearActivity,
  earnBadges,
  editDistance,
  mergeActivity,
  parseActivity,
  sandboxFacts,
  serializeActivity,
  setPrefs,
} from './activity.ts';

/** Runs lines in a real simulated shell and classifies each, the way useShellSession does. */
function classifier(shell: TerminalShell) {
  const run = shell === 'bash' ? linuxSession() : windowsSession(shell);
  let prev: CommandOutcome | undefined;
  return (line: string) => {
    const res = run(line);
    const outcome: CommandOutcome = {
      line, exitCode: res.exitCode, stdout: res.stdout, stderr: res.stderr, explanation: res.explanation, stageExits: res.stageExits,
    };
    const facts = classifyCommand(outcome, shell, prev);
    prev = outcome;
    return facts;
  };
}

test('Activity merge: union of facts and days, earliest badge, newest prefs; idempotent and order-free', () => {
  const a: Activity = { facts: ['help:linux:ls', 'shell:bash'], days: ['2026-10-01'], badges: { 'man-man': 200, whoami: 50 } };
  const b: Activity = {
    facts: ['shell:cmd', 'help:linux:ls'],
    days: ['2026-10-02', '2026-10-01'],
    badges: { 'man-man': 100 },
    prefs: { celebrations: 'lively' },
    prefsAt: 10,
  };
  const m = mergeActivity(a, b);
  assert.deepEqual(m, {
    facts: ['help:linux:ls', 'shell:bash', 'shell:cmd'],
    days: ['2026-10-01', '2026-10-02'],
    badges: { 'man-man': 100, whoami: 50 },
    prefs: { celebrations: 'lively' },
    prefsAt: 10,
  });
  assert.deepEqual(mergeActivity(b, a), m);
  assert.deepEqual(mergeActivity(m, m), m);
  assert.deepEqual(mergeActivity(m, a), m);
  assert.deepEqual(mergeActivity(EMPTY_ACTIVITY, EMPTY_ACTIVITY), EMPTY_ACTIVITY);

  const newer = setPrefs(m, { celebrations: 'off' }, 20);
  assert.equal(mergeActivity(m, newer).prefs?.celebrations, 'off');
  assert.equal(mergeActivity(newer, m).prefs?.celebrations, 'off');
});

test('Activity clear: reaches every tab and is not undone by a stale copy; prefs stay', () => {
  const stale: Activity = { facts: ['shell:bash'], days: ['2026-10-01'], badges: { 'hello-world': 5 }, prefs: { showBadges: false }, prefsAt: 3 };
  const cleared = clearActivity(stale, 1000);
  assert.deepEqual(cleared, { facts: [], days: [], badges: {}, prefs: { showBadges: false }, prefsAt: 3, clearedAt: 1000 });
  assert.deepEqual(mergeActivity(stale, cleared), cleared);
  assert.deepEqual(mergeActivity(cleared, stale), cleared);
  // New activity after the clear counts again
  const after = addFacts(mergeActivity(cleared, stale), ['shell:ps'], '2026-10-03');
  assert.deepEqual(mergeActivity(cleared, after).facts, ['shell:ps']);
  assert.equal(clearActivity(cleared, 10).clearedAt, 1001);
});

test('Activity text: round trip, bad data dropped, empty removes the key, old days pruned', () => {
  const a = earnBadges(addFacts(EMPTY_ACTIVITY, ['shell:bash', 'help:linux:ls'], '2026-10-01'), ['hello-world'], 99);
  const text = serializeActivity(a);
  assert.ok(text);
  assert.deepEqual(parseActivity(text), a);
  assert.equal(serializeActivity(EMPTY_ACTIVITY), null);
  assert.deepEqual(parseActivity('not json'), EMPTY_ACTIVITY);
  assert.deepEqual(
    parseActivity('{"facts":["ok:1","Bad Fact",3],"days":["2026-13-99x","2026-10-01"],"badges":{"x":"soon","y":-1,"z":4},"prefs":{"celebrations":"loud"}}'),
    { facts: ['ok:1'], days: ['2026-10-01'], badges: { z: 4 } },
  );
  const days = parseActivity(JSON.stringify({ facts: [], days: ['2025-01-01', '2026-10-01', '2026-09-30'], badges: {} })).days;
  assert.deepEqual(days, ['2026-09-30', '2026-10-01']);
  // Nothing new: the same object comes back, so React state does not change
  assert.equal(addFacts(a, ['shell:bash'], '2026-10-01'), a);
  assert.equal(earnBadges(a, ['hello-world'], 500), a);
});

test('classifyCommand: help pages, --help, /?, Get-Help and apropos', () => {
  const bash = classifier('bash');
  assert.ok(bash('man ls').includes('help:linux:ls'));
  const help = bash('ls --help');
  assert.ok(help.includes('flaghelp') && help.includes('help:linux:ls'));
  assert.ok(bash('apropos copy').includes('search'));
  assert.ok(!bash('apropos copy').some(f => f.includes('copy')), 'the keyword is never stored');
  assert.ok(!bash('man nosuchcommand').some(f => f.startsWith('help:')), 'a page that does not exist is not a fact');

  const cmd = classifier('cmd');
  const slash = cmd('dir /?');
  assert.ok(slash.includes('flaghelp') && slash.includes('help:windows:dir'), slash.join());

  const ps = classifier('powershell');
  assert.ok(ps('Get-Help Get-Service').includes('help:windows:get-service'));
  assert.ok(ps('Get-Service').includes('shell:ps'));
});

test('classifyCommand: pipe and redirect, only when they worked; no arguments stored', () => {
  const bash = classifier('bash');
  const piped = bash('cat /etc/passwd | grep student');
  assert.ok(piped.includes('pipe'));
  assert.ok(piped.includes('cmd:bash:cat') && piped.includes('cmd:bash:grep'));
  assert.ok(!piped.some(f => f.includes('passwd') || f.includes('student')));
  assert.ok(bash('echo hi > note.txt').includes('redirect'));
  assert.ok(!bash('echo hi > /root/nope.txt').includes('redirect'));
  assert.ok(bash('whoami').includes('whoami'));
});

test('classifyCommand: error then success with the same command is a retry', () => {
  const bash = classifier('bash');
  assert.ok(!bash('ls /nope').includes('recover:retry'));
  assert.ok(bash('ls /etc').includes('recover:retry'));
  // Success after success is not a recovery
  assert.ok(!bash('ls /etc').includes('recover:retry'));
});

test('classifyCommand: command not found then a closely spelled success is a fixed typo', () => {
  const bash = classifier('bash');
  const miss = bash('lss -l');
  assert.ok(!miss.some(f => f.startsWith('cmd:')), 'a mistyped name is never stored');
  assert.ok(bash('ls -l').includes('recover:typo'));
  // A different command, not a near spelling, is not a typo fix
  bash('xyzzy');
  assert.ok(!bash('pwd').includes('recover:typo'));

  const cmd = classifier('cmd');
  cmd('ipconfgi');
  assert.ok(cmd('ipconfig').includes('recover:typo'));
});

test('classifyCommand: a permission error and then a success gets past it', () => {
  const bash = classifier('bash');
  const denied = bash('cat /etc/shadow');
  assert.ok(!denied.includes('recover:permission'));
  assert.ok(bash('sudo cat /etc/shadow').includes('recover:permission'));
});

test('classifyCommand: not simulated, and sandbox tagging', () => {
  const bash = classifier('bash');
  assert.ok(bash('vim notes.txt').includes('notsim'));
  assert.deepEqual(sandboxFacts(['shell:bash', 'cmd:bash:ls']), ['shell:bash', 'cmd:bash:ls', 'sandbox:bash:ls']);
});

test('classifyCommand: only the simulator\'s own names, from commands that themselves ran, are stored', () => {
  const typed = (facts: string[]) => facts.filter(f => /^(cmd|help|sandbox):/.test(f));
  const bash = classifier('bash');
  // A private word never becomes a fact, whatever the rest of the line did
  for (const line of ['private-token || echo ok', 'MyPassw0rd ; true', 'hunter2 | cat', 'x || true', 'x 2>/dev/null; echo']) {
    const facts = sandboxFacts(bash(line));
    assert.ok(!facts.some(f => /private|passw0rd|hunter2|:x$/i.test(f)), `${line}: ${facts.join()}`);
  }
  assert.deepEqual(typed(bash('private-token || echo ok')), ['cmd:bash:echo']);
  assert.deepEqual(typed(bash('hunter2 | cat')), ['cmd:bash:cat']);
  assert.ok(!bash('hunter2 | cat').includes('pipe'), 'a pipe through an unknown name is not a pipe fact');
  assert.ok(!bash('x 2>/dev/null; echo').includes('redirect'));
  // A help command skipped by || never ran
  assert.deepEqual(typed(bash('echo ok || man ls')), ['cmd:bash:echo']);
  assert.deepEqual(typed(bash('false && man ls')), []);
  // The engine's own bash parser: assignments and groups are not command names
  assert.deepEqual(typed(bash('FOO=1 ls')), ['cmd:bash:ls']);
  assert.ok(!bash('{ ls; }').some(f => f.includes('{')));

  const ps = classifier('powershell');
  const literal = ps("'private-token'");
  assert.equal(literal.length, 1, literal.join());
  assert.deepEqual(typed(ps("'Get-Service'")), [], 'a quoted string is output, not a command');
  assert.ok(ps('Get-Service').includes('cmd:ps:get-service'));

  const cmd = classifier('cmd');
  assert.deepEqual(typed(cmd('x & ver')), ['cmd:cmd:ver']);
  assert.deepEqual(typed(cmd('echo ok || help dir')), ['cmd:cmd:echo']);
  // Free play cannot be earned with nonsense names
  const sandbox = classifier('bash');
  const names = new Set(['aa', 'bb', 'cc', 'dd', 'ee'].flatMap(n => sandboxFacts(sandbox(`${n} || true`))).filter(f => f.startsWith('sandbox:')));
  assert.deepEqual([...names], ['sandbox:bash:true']);
});

test('editDistance', () => {
  assert.equal(editDistance('ls', 'lss'), 1);
  assert.equal(editDistance('ipconfgi', 'ipconfig'), 2);
  assert.ok(editDistance('pwd', 'xyzzy') > 2);
});
