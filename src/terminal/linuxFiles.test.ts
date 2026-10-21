import test from 'node:test';
import assert from 'node:assert/strict';
import { linuxSession } from './testUtils.ts';

// ls and cd behave like GNU ls and bash (fact-check L-7/E-12, E-26)

test('ls lists every operand, files first, with paths as typed', () => {
  const run = linuxSession();
  const dev = run('ls -l /dev/sda /dev/sda1').stdout.split('\n');
  assert.equal(dev.length, 2);
  assert.match(dev[0], /^brw-rw---- 1 root disk 8, 0 \w{3} [ \d]\d \d\d:\d\d \/dev\/sda$/);
  assert.match(dev[1], /^brw-rw---- 1 root disk 8, 1 .* \/dev\/sda1$/);
  assert.match(run('ls -l /dev/null').stdout, /^crw-rw-rw- 1 root root 1, 3 /);
  assert.equal(run('ls -l /etc/passwd /etc/group').stdout.split('\n').length, 2);
  const dirs = run('ls -ld /etc /tmp').stdout.split('\n');
  assert.match(dirs[0], /^drwxr-xr-x .* \/etc$/);
  assert.match(dirs[1], /^drwxrwxrwt .* \/tmp$/);
  assert.equal(run('ls -dl /home/student/finance').stdout, run('ls -l -d /home/student/finance').stdout);

  // Directories get a header when there are several operands
  assert.equal(run('ls notes.txt scripts').stdout, 'notes.txt\n\nscripts:\nbackup.sh');
  const mixed = run('ls nosuch notes.txt');
  assert.equal(mixed.stdout, 'notes.txt');
  assert.equal(mixed.stderr, "ls: cannot access 'nosuch': No such file or directory");
  assert.equal(mixed.exitCode, 2);
});

test('ls -la shows . and .. with their real owners, aligned, after a total line', () => {
  const run = linuxSession();
  const lines = run('ls -la ~').stdout.split('\n');
  assert.match(lines[0], /^total \d+$/);
  assert.match(lines[1], /^drwxr-xr-x \d+ student student +4096 .* \.$/);
  assert.match(lines[2], /^drwxr-xr-x \d+ root +root +4096 .* \.\.$/);
  assert.match(run('ls -la ~').stdout, / notes\.txt$/m);
  assert.doesNotMatch(run('ls -A').stdout, /(^| )\.\.?( |$)/);
  assert.match(run('ls -R scripts').stdout, /^scripts:\nbackup\.sh$/);
  assert.match(run('ls -lh /etc').stdout, /^total \d+(\.\d)?K$/m);
  assert.equal(run('ls -1 scripts').stdout, 'backup.sh');
  assert.equal(run('ls -F').stdout, 'finance/  notes.txt  scripts/');
});

test('cd - returns to the previous directory and prints it', () => {
  const run = linuxSession();
  assert.equal(run('cd -').stderr, 'bash: cd: OLDPWD not set');
  run('cd /etc');
  const back = run('cd -');
  assert.equal(back.stdout, '/home/student');
  assert.equal(run.cwd(), '/home/student');
  run('cd -');
  assert.equal(run.cwd(), '/etc');
  assert.equal(run('cd a b').stderr, 'bash: cd: too many arguments');
});

test('chmod X adds execute only to directories and already-executable files', () => {
  const run = linuxSession();
  run('touch plain run.sh; chmod 744 run.sh; chmod 600 plain; mkdir d; chmod 700 d');
  run('chmod go+X plain run.sh d');
  assert.match(run('ls -l plain').stdout, /^-rw------- /);
  assert.match(run('ls -l run.sh').stdout, /^-rwxr-xr-x /);
  assert.match(run('ls -ld d').stdout, /^drwx--x--x /);
});

test('/boot exists as the mount point df and lsblk name', () => {
  const run = linuxSession();
  assert.match(run('ls /boot').stdout, /vmlinuz-5\.15\.0-101-generic/);
});
