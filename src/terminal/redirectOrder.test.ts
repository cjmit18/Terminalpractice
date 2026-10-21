import test from 'node:test';
import assert from 'node:assert/strict';
import { linuxSession, windowsSession } from './testUtils.ts';

// Redirections apply left to right: 2>&1 copies wherever stdout points at that moment.

test('bash: "> file 2>&1" sends stdout and stderr to the file', () => {
  const run = linuxSession();
  const res = run('cat missing > /tmp/order-check 2>&1');
  assert.equal(res.stdout, '');
  assert.equal(res.stderr, '');
  assert.match(run('cat /tmp/order-check').stdout, /cat: missing: No such file or directory/);
});

test('bash: "2>&1 > file" leaves stderr on the terminal and the file empty', () => {
  const run = linuxSession();
  const res = run('cat missing 2>&1 > /tmp/order-check');
  assert.match(res.stdout, /cat: missing: No such file or directory/);
  assert.equal(run('cat /tmp/order-check').stdout, '');
  // stdout still goes to the file
  run('echo hello 2>&1 > /tmp/order-check');
  assert.equal(run('cat /tmp/order-check').stdout, 'hello');
});

test('bash: "2>&1 > file | cmd" sends only stderr down the pipe', () => {
  const run = linuxSession();
  const res = run('cat /etc/hostname-missing /etc/passwd 2>&1 > /tmp/out | wc -l');
  assert.equal(res.stdout.trim(), '1');
  assert.match(run('cat /tmp/out').stdout, /^root:/);
});

test('cmd: redirection order works the same way', () => {
  const run = windowsSession('cmd');
  run('type missing.txt > C:\\Users\\Student\\a.txt 2>&1');
  assert.match(run('type C:\\Users\\Student\\a.txt').stdout, /cannot find the file/i);
  const res = run('type missing.txt 2>&1 > C:\\Users\\Student\\b.txt');
  assert.match(res.stdout, /cannot find the file/i);
  assert.equal(run('type C:\\Users\\Student\\b.txt').stdout.trim(), '');
});
