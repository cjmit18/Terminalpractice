import test from 'node:test';
import assert from 'node:assert/strict';
import { linuxSession } from './testUtils.ts';
import { linuxCommands } from './linux/context.ts';
import { getNodeAtPath } from './filesystem.ts';

// Round-2 fact-check, package A: the Linux engine compared with real bash 5 / coreutils

// ---------- A2: depth caps and the internal-error guard ----------

test('A2: a 2000-deep $(( )) fails with bash\'s recursion message instead of throwing', () => {
  const run = linuxSession();
  const expr = '('.repeat(2000) + '1' + ')'.repeat(2000);
  const res = run(`echo $((${expr}))`);
  assert.equal(res.exitCode, 1);
  assert.equal(res.stdout, '');
  assert.match(res.stderr, /^bash: .*: expression recursion level exceeded \(error token is ".*"\)$/);
  // A long unary chain is capped the same way
  assert.match(run(`echo $((${'- '.repeat(2000)}1))`).stderr, /expression recursion level exceeded/);
  // Ordinary nesting still works
  assert.equal(run('echo $(( ((1+2)) * (3) ))').stdout, '9');
});

test('A2: mkdir -p 3000 deep is refused quickly and the session survives', () => {
  const run = linuxSession();
  const t0 = Date.now();
  const res = run('mkdir -p ' + Array(3000).fill('d').join('/'));
  assert.ok(Date.now() - t0 < 200, `took ${Date.now() - t0} ms`);
  assert.equal(res.exitCode, 1);
  assert.match(res.stderr, /^mkdir: cannot create directory 'd\/d\/.*': File name too long$/);
  assert.equal(getNodeAtPath(run.fs(), '/home/student/d', false), null);
  assert.equal(run('pwd').stdout, '/home/student');
  assert.equal(run('ls -d scripts').stdout, 'scripts');
  // Up to the cap is fine
  assert.equal(run('mkdir -p ' + Array(200).fill('d').join('/')).exitCode, 0);
  // cp -r / mv that would go past the cap are refused too
  run('mkdir -p ' + Array(100).fill('e').join('/'));
  const cp = run('cp -r d ' + Array(100).fill('e').join('/'));
  assert.equal(cp.exitCode, 1);
  assert.match(cp.stderr, /File name too long/);
  const mv = run('mv d ' + Array(100).fill('e').join('/'));
  assert.equal(mv.exitCode, 1);
  assert.match(mv.stderr, /^mv: cannot move 'd' to .*: File name too long$/);
  assert.ok(getNodeAtPath(run.fs(), '/home/student/d', false));
});

test('A2: an exception inside a command becomes "internal error" and changes nothing', () => {
  linuxCommands.register('__boom', ctx => {
    ctx.fs.children = {};
    throw new Error('kaboom');
  });
  const run = linuxSession();
  run('cd scripts');
  const before = run.fs();
  const res = run('touch made.txt; __boom');
  assert.equal(res.exitCode, 1);
  assert.equal(res.stderr, 'bash: internal error: kaboom');
  assert.equal(res.newFs, before);
  assert.equal(run.cwd(), '/home/student/scripts');
  assert.equal(run('pwd').stdout, '/home/student/scripts');
  assert.match(run('ls /home/student').stdout, /scripts/);
});

// ---------- A1: ls when stdout is not the terminal ----------

test('A1: ls prints one name per line into a pipe, a file or $(...), columns at the terminal', () => {
  const run = linuxSession();
  assert.equal(run('ls').stdout, 'finance  notes.txt  scripts');
  assert.equal(run('ls | wc -l').stdout, '3');
  assert.equal(run('ls /etc | grep pass').stdout, 'passwd');
  run('ls > o.txt');
  assert.equal(run('cat o.txt').stdout, 'finance\nnotes.txt\no.txt\nscripts');
  assert.equal(run('echo "$(ls)"').stdout, 'finance\nnotes.txt\no.txt\nscripts');
  // -C forces columns; ls in a script run at the prompt still writes to the terminal
  assert.equal(run('ls -C | cat').stdout, 'finance  notes.txt  o.txt  scripts');
  run('echo ls > l.sh; chmod +x l.sh');
  assert.equal(run('./l.sh').stdout, 'finance  l.sh  notes.txt  o.txt  scripts');
  assert.equal(run('./l.sh | head -1').stdout, 'finance');
});
