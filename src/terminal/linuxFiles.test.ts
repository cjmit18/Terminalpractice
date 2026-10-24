import test from 'node:test';
import assert from 'node:assert/strict';
import { linuxSession } from './testUtils.ts';
import { getNodeAtPath } from './filesystem.ts';

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

test('rm -rf checks permission for every entry inside the tree, as real rm does (#28, 5)', () => {
  // The issue's case: protected is r-x, so protected/data cannot be unlinked from it
  const run = linuxSession();
  run('mkdir protected; touch protected/data; chmod 500 protected');
  const res = run('rm -rf protected');
  assert.equal(res.exitCode, 1);
  assert.equal(res.stderr, "rm: cannot remove 'protected/data': Permission denied");
  assert.ok(getNodeAtPath(run.fs(), '/home/student/protected/data', false), 'the protected file must stay');
  assert.ok(getNodeAtPath(run.fs(), '/home/student/protected', false), 'and so must the folder holding it');

  // What can be removed is, even when something deeper cannot
  run('mkdir -p tree/open tree/locked; touch tree/open/a tree/locked/b tree/c; chmod 555 tree/locked');
  assert.equal(run('rm -r tree').stderr, "rm: cannot remove 'tree/locked/b': Permission denied");
  assert.equal(getNodeAtPath(run.fs(), '/home/student/tree/open', false), null);
  assert.equal(getNodeAtPath(run.fs(), '/home/student/tree/c', false), null);
  assert.ok(getNodeAtPath(run.fs(), '/home/student/tree/locked/b', false));

  // A folder that cannot be read cannot be emptied; an empty one goes, since only its parent matters
  run('mkdir -p sealed/x empty; chmod 300 sealed; chmod 000 empty');
  assert.equal(run('rm -rf sealed').stderr, "rm: cannot remove 'sealed': Permission denied");
  assert.ok(getNodeAtPath(run.fs(), '/home/student/sealed/x', false));
  assert.equal(run('rm -rf empty').exitCode, 0);

  // Once the folder is writable again it all goes, and root is never stopped
  run('chmod 700 protected');
  assert.equal(run('rm -rf protected').exitCode, 0);
  assert.equal(getNodeAtPath(run.fs(), '/home/student/protected', false), null);
  const root = linuxSession({ currentUser: 'root', currentGroup: 'root', isRootOrAdmin: true });
  root('mkdir /tmp/p; touch /tmp/p/d; chmod 500 /tmp/p');
  assert.equal(root('rm -rf /tmp/p').exitCode, 0);
});
