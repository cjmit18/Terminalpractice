import test from 'node:test';
import assert from 'node:assert/strict';
import { getNodeAtPath, createNode } from './filesystem.ts';
import { linuxSession } from './testUtils.ts';

const ME = "You are 'student' (groups: student, adm, sudo).";

test('Explanation: reading a file whose other bits deny read', () => {
  const run = linuxSession();
  const res = run('cat /etc/shadow');
  assert.equal(res.stderr, 'cat: /etc/shadow: Permission denied', 'stderr stays the real message');
  assert.equal(res.explanation,
    `${ME} /etc/shadow is owned by root:shadow with mode ---------- (000); you are not its owner and not in group 'shadow', so the 'other' bits (---) apply, and they do not include read (r).`);
});

test('Explanation: group bits apply when you are in the file group', () => {
  const run = linuxSession();
  run('sudo chmod 600 /var/log/syslog');
  const res = run('cat /var/log/syslog');
  assert.match(res.explanation ?? '', /you are not its owner but you are in group 'adm', so the group bits \(---\) apply/);
});

test('Explanation: owner bits apply even when group or other would allow it', () => {
  const run = linuxSession();
  run('echo secret > mine.txt');
  run('chmod 077 mine.txt');
  const res = run('cat mine.txt');
  assert.equal(res.exitCode, 1);
  assert.match(res.explanation ?? '', /you are its owner, so the owner bits \(---\) apply, and they do not include read/);
});

test('Explanation: a directory on the path blocks traversal', () => {
  const run = linuxSession();
  const res = run('cat /root/.bashrc');
  assert.equal(res.stderr, 'cat: /root/.bashrc: Permission denied');
  assert.equal(res.explanation,
    `${ME} To reach /root/.bashrc you need execute (x) on every directory along the path, but /root is owned by root:root with mode drwx------ (700); you are not its owner and not in group 'root', so the 'other' bits (---) apply, and they do not include execute (x).`);
  assert.match(run('ls /root/.bashrc').stderr, /cannot access '\/root\/.bashrc': Permission denied/);
});

test('Explanation: creating, deleting and entering directories', () => {
  const run = linuxSession();
  const touch = run('touch /root/hacked.txt');
  assert.match(touch.explanation ?? '', /To reach \/root\/hacked.txt/);
  const etc = run('touch /etc/new.conf');
  assert.match(etc.explanation ?? '', /To create \/etc\/new.conf you need write \(w\) on its directory, but \/etc is owned by root:root with mode drwxr-xr-x \(755\)/);
  const rm = run('rm /etc/passwd');
  assert.match(rm.explanation ?? '', /Removing \/etc\/passwd needs write \(w\) on the directory that contains it, but \/etc/);
  const cd = run('cd /root');
  assert.match(cd.explanation ?? '', /To enter \/root you need execute \(x\) on it, but it is owned by root:root/);
  const ls = run('ls /root');
  assert.match(ls.explanation ?? '', /Listing \/root needs read \(r\) on it/);
});

test('Explanation: sticky bit, chmod, chown and root-only tools', () => {
  const run = linuxSession();
  const fs = run.fs();
  createNode(fs, '/tmp/other.txt', 'file', 'x', false, 'nginx', 'nginx', 666);
  const rm = run('rm /tmp/other.txt');
  assert.equal(rm.stderr, "rm: cannot remove '/tmp/other.txt': Operation not permitted");
  assert.match(rm.explanation ?? '', /\/tmp has the sticky bit set \(drwxrwxrwt \(1777\)\), so even though you may write to it, only the file's owner \(nginx\), the directory's owner \(root\) or root may delete/);

  assert.match(run('chmod 777 /etc/passwd').explanation ?? '', /Only a file's owner or root can change its mode, and \/etc\/passwd is owned by root/);
  assert.match(run('chown root notes.txt').explanation ?? '', /Only root can give a file to another owner/);
  assert.match(run('apt install vim').explanation ?? '', /requires root privileges; run it with sudo/);
  assert.match(run('useradd bob').explanation ?? '', /requires root privileges/);
  assert.match(run('fdisk /dev/sda').explanation ?? '', /root:disk/);
  assert.match(run('systemctl restart nginx').explanation ?? '', /requires root privileges/);
});

test('Explanation: redirects explain the shell-side check, and quiet stderr drops the note', () => {
  const run = linuxSession();
  const res = run('sudo echo hi > /root/trap.txt');
  assert.equal(res.stderr, 'bash: /root/trap.txt: Permission denied');
  assert.match(res.explanation ?? '', /To reach \/root\/trap.txt/);
  assert.equal(run('cat /etc/shadow 2>/dev/null').explanation, undefined);
  assert.ok(run('cat /etc/shadow 2>&1').explanation, '2>&1 keeps the message visible, so the note stays');
});

test('Explanation: root and successful commands carry none', () => {
  const run = linuxSession();
  assert.equal(run('sudo cat /etc/shadow').explanation, undefined);
  assert.equal(run('cat /etc/passwd').explanation, undefined);
  assert.equal(run('cat nofile').explanation, undefined);
});

test('Pipelines run every stage like bash; redirects open before the command runs', () => {
  const run = linuxSession();
  const res = run('cat nofile | wc -l');
  assert.equal(res.stdout, '0');
  assert.equal(res.stderr, 'cat: nofile: No such file or directory');
  assert.equal(res.exitCode, 0, 'exit status is the last stage');

  // A failed redirect means the command never runs
  run('touch keep.txt');
  const blocked = run('rm keep.txt > /root/out');
  assert.equal(blocked.exitCode, 1);
  assert.ok(getNodeAtPath(run.fs(), '/home/student/keep.txt', false), 'rm must not have run');

  assert.equal(run('echo gone > /dev/null').stdout, '');
  assert.equal(run('echo gone > /dev/null').exitCode, 0);
  assert.equal(run('> empty.txt').exitCode, 0);
  assert.equal(getNodeAtPath(run.fs(), '/home/student/empty.txt', false)?.content, '');
  assert.equal(run('ls /nope > out.txt 2>&1').stdout, '');
  assert.match(getNodeAtPath(run.fs(), '/home/student/out.txt', false)?.content ?? '', /No such file/);
  assert.match(run('echo x > /tmp').stderr, /bash: \/tmp: Is a directory/);
});

test('sudo: sudoers membership, -u and -i', () => {
  const outsider = linuxSession();
  const group = getNodeAtPath(outsider.fs(), '/etc/group', false)!;
  group.content = group.content!.replace('sudo:x:27:student', 'sudo:x:27:');
  const res = outsider('sudo cat /etc/shadow');
  assert.equal(res.stderr, 'student is not in the sudoers file.  This incident will be reported.');
  assert.match(res.explanation ?? '', /members of the 'sudo' group/);

  const run = linuxSession();
  assert.equal(run('sudo -u nginx whoami').stdout, 'nginx');
  run('sudo -i');
  assert.equal(run('whoami').stdout, 'root');
});

test('Scripts: ./script needs x, bash script needs r, source keeps cwd', () => {
  const run = linuxSession();
  const ok = run('./scripts/backup.sh');
  assert.match(ok.stdout, /Running nightly backup/);
  run('echo "cd /tmp" > go.sh');
  run('echo pwd >> go.sh');
  const denied = run('./go.sh');
  assert.equal(denied.stderr, 'bash: ./go.sh: Permission denied');
  assert.equal(denied.exitCode, 126);
  assert.match(denied.explanation ?? '', /do not include execute \(x\)/);
  assert.equal(run('bash go.sh').stdout, '/tmp');
  assert.equal(run.cwd(), '/home/student', 'a child shell cannot change the parent cwd');
  run('source go.sh');
  assert.equal(run.cwd(), '/tmp');
  assert.equal(run('./missing.sh').exitCode, 127);
  assert.equal(run('/bin/ls /home').stdout, 'student');
  assert.equal(run('bash -c "echo inner"').stdout, 'inner');
});

test('cd errors carry the bash: prefix like real bash', () => {
  const run = linuxSession();
  assert.equal(run('cd nowhere').stderr, 'bash: cd: nowhere: No such file or directory');
  assert.equal(run('cd notes.txt').stderr, 'bash: cd: notes.txt: Not a directory');
});
