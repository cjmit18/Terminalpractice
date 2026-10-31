import test from 'node:test';
import assert from 'node:assert/strict';
import { getNodeAtPath } from './filesystem.ts';
import { linuxSession } from './testUtils.ts';

// stat, getent, groups, usermod and chage as lab verifiers and lessons use them (fact-check E-7, N-2, N-6, L-14)

const shadowLine = (run: ReturnType<typeof linuxSession>, user: string) =>
  (getNodeAtPath(run.fs(), '/etc/shadow', false)?.content ?? '').split('\n').find(l => l.startsWith(`${user}:`));

test('stat prints the GNU layout', () => {
  const run = linuxSession();
  const res = run('stat /home/student/finance');
  assert.equal(res.exitCode, 0);
  const lines = res.stdout.split('\n');
  assert.equal(lines[0], '  File: /home/student/finance');
  assert.match(lines[1], /^ {2}Size: 4096 {6}\tBlocks: 8 {10}IO Block: 4096 {3}directory$/);
  assert.match(lines[2], /^Device: \S+\tInode: \d+ +Links: \d+$/);
  assert.match(lines[3], /^Access: \(0777\/drwxrwxrwx\) {2}Uid: \( 1000\/ student\) {3}Gid: \( 1000\/ student\)$/);
  assert.match(lines[4], /^Access: 2026-\d\d-\d\d \d\d:\d\d:\d\d\.\d{9} \+0000$/);
  assert.equal(lines[7], ' Birth: -');
  assert.match(run('stat /home/student').stdout, /Access: \(0755\/drwxr-xr-x\) {2}Uid: \( 1000\/ student\) {3}Gid: \( 1000\/ student\)/);
  assert.match(run('stat /etc/passwd').stdout, /regular file\n/);
  assert.match(run('stat /dev/sda').stdout, /block special file\nDevice: .*Device type: 8,0\nAccess: \(0660\/brw-rw----\)  Uid: \( {4}0\/ {4}root\)   Gid: \( {4}6\/ {4}disk\)/);
  assert.equal(run("stat -c '%a %A %U:%G %n' /etc/shadow").stdout, '640 -rw-r----- root:shadow /etc/shadow');
  const missing = run('stat nosuch');
  assert.equal(missing.stderr, "stat: cannot statx 'nosuch': No such file or directory");
  assert.equal(missing.exitCode, 1);
});

test('getent passwd, group and hosts', () => {
  const run = linuxSession();
  assert.equal(run('getent passwd student').stdout, 'student:x:1000:1000:Student User,,,:/home/student:/bin/bash');
  assert.equal(run('getent passwd 0').stdout, 'root:x:0:0:root:/root:/bin/bash');
  assert.equal(run('getent group sudo').stdout, 'sudo:x:27:student');
  assert.equal(run('getent hosts localhost').stdout, '127.0.0.1       localhost');
  assert.equal(run('getent passwd nobody_here').exitCode, 2);
  assert.equal(run('getent passwd').stdout.split('\n').length, 6);
  assert.equal(run('getent shadow student').exitCode, 2, 'shadow needs root');
  assert.match(run('sudo getent shadow student').stdout, /^student:/);
  assert.equal(run('getent nope').exitCode, 1);
  assert.equal(run('groups').stdout, 'student adm sudo');
  assert.equal(run('groups root').stdout, 'root : root');
});

test('/etc/shadow is 640 root:shadow and the docker group exists', () => {
  const run = linuxSession();
  assert.match(run('ls -l /etc/shadow').stdout, /^-rw-r----- 1 root +shadow /);
  assert.equal(run('cat /etc/shadow').stderr, 'cat: /etc/shadow: Permission denied');
  assert.equal(run('cat /etc/hostname').stdout, 'lpi-lab01');
  assert.equal(run('sudo usermod -aG docker student').exitCode, 0);
  assert.match(run('getent group docker').stdout, /^docker:x:\d+:student$/);
});

test('usermod -s -L -U -e -l -d -m and the group options', () => {
  const run = linuxSession();
  run('sudo useradd -m -s /bin/bash sarah');
  assert.match(shadowLine(run, 'sarah') ?? '', /^sarah:!:20745:/, 'last change is the lab day');
  run('sudo passwd sarah');
  assert.equal(run('sudo usermod -s /bin/zsh sarah').exitCode, 0);
  assert.match(run('getent passwd sarah').stdout, /:\/bin\/zsh$/);
  run('sudo usermod -L sarah');
  assert.match(shadowLine(run, 'sarah') ?? '', /^sarah:!\$y\$/);
  run('sudo usermod -U sarah');
  assert.match(shadowLine(run, 'sarah') ?? '', /^sarah:\$y\$/);
  run('sudo usermod -e 1 sarah');
  assert.match(run('sudo chage -l sarah').stdout, /Account expires\s+: Jan 02, 1970/);
  run('sudo usermod -e "" sarah');
  assert.match(run('sudo chage -l sarah').stdout, /Account expires\s+: never/);
  run('sudo usermod -aG developers sarah');
  assert.match(run('getent group developers').stdout, /:sarah$/);
  run('sudo usermod -G finance sarah');
  assert.doesNotMatch(run('getent group developers').stdout, /sarah/, '-G without -a replaces the list');
  assert.match(run('getent group finance').stdout, /:sarah$/);
  run('sudo usermod -g developers sarah');
  assert.match(run('getent passwd sarah').stdout, /^sarah:x:\d+:1003:/);

  assert.equal(run('sudo usermod -l sara -d /home/sara -m sarah').exitCode, 0);
  assert.match(run('getent passwd sara').stdout, /^sara:x:\d+:1003::\/home\/sara:\/bin\/zsh$/);
  assert.equal(run('getent passwd sarah').exitCode, 2);
  assert.match(shadowLine(run, 'sara') ?? '', /^sara:/);
  assert.match(run('getent group finance').stdout, /:sara$/);
  assert.match(run('ls -ld /home/sara').stdout, /^drwxr-x--- \d+ sara /);
  assert.equal(getNodeAtPath(run.fs(), '/home/sarah', false), null);

  assert.equal(run('sudo usermod -s /bin/bash ghost').exitCode, 6);
  assert.equal(run('sudo usermod -l root sara').stderr, "usermod: user 'root' already exists");
  assert.equal(run('sudo usermod -G nogroup sara').stderr, "usermod: group 'nogroup' does not exist");
  assert.match(run('sudo usermod sara').stderr, /^Usage: usermod \[options\] LOGIN/);
  assert.equal(run('usermod -s /bin/sh student').exitCode, 1, 'needs root');
});

test('chage -l after chage -d 0 says the password must be changed', () => {
  const run = linuxSession();
  run('sudo chage -d 0 student');
  const out = run('sudo chage -l student').stdout.split('\n');
  assert.match(out[0], /^Last password change\s+: password must be changed$/);
  assert.match(out[1], /^Password expires\s+: password must be changed$/);
  assert.match(out[2], /^Password inactive\s+: password must be changed$/);
});

test('su becomes the user it names, not always root (#28, 8)', () => {
  const run = linuxSession();
  run('sudo useradd -m alice');
  // The issue's case: su to a user who is not root
  run('su alice');
  assert.equal(run('whoami').stdout, 'alice');
  assert.equal(run('id -gn').stdout, 'alice');
  assert.equal(run('pwd').stdout, '/home/student', 'without - the directory stays');
  run('exit');
  assert.equal(run('whoami').stdout, 'student');

  // su - moves to the user's home; plain su is still root
  run('su - alice');
  assert.equal(run('pwd').stdout, '/home/alice');
  run('exit');
  run('su');
  assert.equal(run('whoami').stdout, 'root');
  run('exit');

  // -c runs one command as the user and comes back
  assert.equal(run('su alice -c whoami').stdout, 'alice');
  assert.equal(run('whoami').stdout, 'student');

  // An unknown user is refused, and nothing changes
  const bad = run('su nobody-here');
  assert.equal(bad.exitCode, 1);
  assert.equal(bad.stderr, 'su: user nobody-here does not exist or the user entry does not contain all the required fields');
  assert.equal(run('whoami').stdout, 'student');
});

test('#74 review: su -c runs in a child shell; its umask and variables stay there, machine changes do not', () => {
  const run = linuxSession();
  run('su root -c "umask 077"');
  assert.equal(run('umask').stdout, '0022');
  run('su root -c "export CHILD_ONLY=yes"');
  assert.equal(run('echo "[$CHILD_ONLY]"').stdout, '[]');
  // Files and machine settings change for real
  run('su root -c "touch /tmp/made-by-root; systemctl set-default graphical.target"');
  assert.match(run('ls -l /tmp/made-by-root').stdout, / root root /);
  assert.equal(run('systemctl get-default').stdout, 'graphical.target');
  assert.equal(run('whoami').stdout, 'student');
});
