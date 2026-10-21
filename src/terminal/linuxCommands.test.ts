import test from 'node:test';
import assert from 'node:assert/strict';
import { getNodeAtPath, createNode } from './filesystem.ts';
import { formatDate } from './linux/commands/system.ts';
import { linuxSession } from './testUtils.ts';

const node = (run: ReturnType<typeof linuxSession>, p: string) => getNodeAtPath(run.fs(), p, false);

test('cp copies files and (with -r) directories, honoring permissions', () => {
  const run = linuxSession();
  assert.equal(run('cp notes.txt copy.txt').exitCode, 0);
  assert.equal(node(run, '/home/student/copy.txt')?.content, node(run, '/home/student/notes.txt')?.content);
  assert.equal(run('cp notes.txt scripts').exitCode, 0);
  assert.ok(node(run, '/home/student/scripts/notes.txt'));

  const dir = run('cp scripts s2');
  assert.equal(dir.stderr, "cp: -r not specified; omitting directory 'scripts'");
  assert.equal(dir.exitCode, 1);
  assert.equal(run('cp -r scripts s2').exitCode, 0);
  assert.ok(node(run, '/home/student/s2/backup.sh'));
  assert.equal(node(run, '/home/student/s2/backup.sh')?.owner, 'student');

  assert.equal(run('cp nope x').stderr, "cp: cannot stat 'nope': No such file or directory");
  assert.equal(run('cp /etc/shadow .').stderr, "cp: cannot open '/etc/shadow' for reading: Permission denied");
  const denied = run('cp notes.txt /etc/');
  assert.equal(denied.stderr, "cp: cannot create regular file '/etc/notes.txt': Permission denied");
  assert.match(denied.explanation ?? '', /To create \/etc\/notes.txt you need write \(w\)/);
  assert.equal(run('cp a b c').stderr, "cp: target 'c' is not a directory");
  assert.match(run('cp').stderr, /^cp: missing file operand/);
  assert.match(run('cp -r scripts scripts/inner').stderr, /cannot copy a directory, 'scripts', into itself/);
  assert.equal(run('sudo cp /etc/shadow /tmp/sh').exitCode, 0);
  assert.equal(node(run, '/tmp/sh')?.owner, 'root');
});

test('mv renames and moves, checking both directories', () => {
  const run = linuxSession();
  assert.equal(run('mv notes.txt renamed.txt').exitCode, 0);
  assert.equal(node(run, '/home/student/notes.txt'), null);
  assert.equal(node(run, '/home/student/renamed.txt')?.name, 'renamed.txt');
  assert.equal(run('mv renamed.txt scripts').exitCode, 0);
  assert.ok(node(run, '/home/student/scripts/renamed.txt'));
  assert.equal(run('mv scripts tools').exitCode, 0);
  assert.ok(node(run, '/home/student/tools/backup.sh'));

  assert.equal(run('mv /etc/hosts .').stderr, "mv: cannot move '/etc/hosts' to './hosts': Permission denied");
  assert.equal(run('mv tools/backup.sh /etc/').stderr, "mv: cannot move 'tools/backup.sh' to '/etc/backup.sh': Permission denied");
  assert.equal(run('mv ghost x').stderr, "mv: cannot stat 'ghost': No such file or directory");
  assert.match(run('mv tools tools/sub').stderr, /cannot move 'tools' to a subdirectory of itself/);
  createNode(run.fs(), '/tmp/theirs', 'file', 'x', false, 'nginx', 'nginx', 666);
  const sticky = run('mv /tmp/theirs /tmp/mine');
  assert.equal(sticky.stderr, "mv: cannot move '/tmp/theirs' to '/tmp/mine': Operation not permitted");
  assert.match(sticky.explanation ?? '', /sticky bit/);
});

test('find: -name -iname -type -perm -user -group -size -empty -maxdepth -exec -delete', () => {
  const run = linuxSession();
  assert.equal(run('find /home -name "*.sh"').stdout, '/home/student/scripts/backup.sh');
  assert.equal(run('find . -type d').stdout, '.\n./finance\n./scripts');
  assert.equal(run('find . -maxdepth 1 -type f').stdout, './notes.txt');
  assert.equal(run('find . -iname "NOTES*"').stdout, './notes.txt');
  assert.equal(run('find /etc -user root -name shadow').stdout, '/etc/shadow');
  assert.equal(run('find /etc -group shadow').stdout, '/etc/shadow');
  assert.equal(run('find . -perm 755 -type f').stdout, './scripts/backup.sh');
  assert.equal(run('find . -perm -o=w').stdout, './finance\n./finance/q3_payroll.csv');
  assert.equal(run('find . -type f ! -name "*.txt" ! -name "*.sh"').stdout, './finance/q3_payroll.csv');
  assert.equal(run('find . -name "*.sh" -o -name "*.csv"').stdout, './finance/q3_payroll.csv\n./scripts/backup.sh');
  assert.equal(run('find /tmp -empty').stdout, '/tmp');
  assert.equal(run('find . -type f -size +1k').stdout, '');
  assert.equal(run('find . -type f -size -1k').stdout, '', 'sizes round up to whole units, so -1k only matches empty files');

  run('sudo chmod 4755 scripts/backup.sh');
  const suid = run('find / -perm -4000 2>/dev/null');
  assert.equal(suid.stdout, '/home/student/scripts/backup.sh');
  assert.equal(suid.exitCode, 1, 'unreadable directories make find exit 1');
  const loud = run('find / -perm -4000');
  assert.equal(loud.stderr, "find: '/root': Permission denied");
  assert.match(loud.explanation ?? '', /Searching inside \/root needs read \(r\) and execute \(x\)/);

  assert.equal(run('find . -name "*.csv" -exec cat {} \\;').stdout.split('\n')[0], 'EmployeeID,Name,Salary');
  run('touch a.tmp b.tmp');
  assert.equal(run('find . -name "*.tmp" -delete').exitCode, 0);
  assert.equal(node(run, '/home/student/a.tmp'), null);
  assert.equal(run('find nowhere').stderr, "find: 'nowhere': No such file or directory");
  assert.equal(run('find . -bogus').stderr, "find: unknown predicate `-bogus'");
  assert.equal(run('find . -type x').stderr, 'find: Unknown argument to -type: x');
});

test('chown and chgrp: -R, validation, and non-root rules', () => {
  const run = linuxSession();
  run('mkdir -p proj/sub');
  run('touch proj/sub/f');
  assert.equal(run('sudo chown -R root:finance proj').exitCode, 0);
  assert.equal(node(run, '/home/student/proj/sub/f')?.owner, 'root');
  assert.equal(node(run, '/home/student/proj/sub/f')?.group, 'finance');
  assert.equal(run('sudo chown ghost notes.txt').stderr, "chown: invalid user: 'ghost'");
  assert.equal(run('sudo chown root:ghost notes.txt').stderr, "chown: invalid group: 'root:ghost'");
  assert.equal(run('sudo chown nginx: notes.txt').exitCode, 0);
  assert.equal(node(run, '/home/student/notes.txt')?.group, 'nginx');

  const own = linuxSession();
  assert.equal(own('chgrp sudo notes.txt').exitCode, 0, 'owner may switch to one of their groups');
  assert.equal(node(own, '/home/student/notes.txt')?.group, 'sudo');
  assert.equal(own('chown :adm notes.txt').exitCode, 0);
  const notMember = own('chgrp finance notes.txt');
  assert.equal(notMember.stderr, "chgrp: changing group of 'notes.txt': Operation not permitted");
  assert.match(notMember.explanation ?? '', /you are not in 'finance'/);
  const notOwner = own('chgrp sudo /etc/hosts');
  assert.match(notOwner.explanation ?? '', /Only the owner of \/etc\/hosts \(root\) or root can change its group/);
  assert.equal(own('chgrp nogroup notes.txt').stderr, "chgrp: invalid group: 'nogroup'");
  assert.equal(own('sudo chgrp -R finance finance').exitCode, 0);
  assert.equal(node(own, '/home/student/finance/q3_payroll.csv')?.group, 'finance');
});

test('useradd and groupadd update passwd, shadow and group files', () => {
  const run = linuxSession();
  assert.equal(run('sudo useradd -m -s /bin/bash -G developers sarah').exitCode, 0);
  assert.match(run('grep sarah /etc/passwd').stdout, /^sarah:x:\d+:\d+::\/home\/sarah:\/bin\/bash$/);
  assert.match(run('sudo grep sarah /etc/shadow').stdout, /^sarah:!:/);
  assert.match(run('grep developers /etc/group').stdout, /developers:x:1003:sarah/);
  assert.equal(node(run, '/home/sarah')?.owner, 'sarah');
  assert.equal(run('sudo useradd sarah').stderr, "useradd: user 'sarah' already exists");
  assert.equal(run('sudo useradd -G nogroup bob').stderr, "useradd: group 'nogroup' does not exist");
  run('sudo useradd tom');
  assert.equal(node(run, '/home/tom'), null, 'Ubuntu useradd does not create a home without -m');
  assert.match(run('id tom').stdout, /^uid=\d+\(tom\) gid=\d+\(tom\) groups=\d+\(tom\)$/);
  assert.equal(run('sudo groupadd ops').exitCode, 0);
  assert.match(run('tail -1 /etc/group').stdout, /^ops:x:\d+:$/);
  assert.match(run('groupadd x').explanation ?? '', /requires root privileges/);
});

test('id reads uid and gids from the account files', () => {
  const run = linuxSession();
  assert.equal(run('id').stdout, 'uid=1000(student) gid=1000(student) groups=1000(student),4(adm),27(sudo)');
  assert.equal(run('id nginx').stdout, 'uid=1001(nginx) gid=1001(nginx) groups=1001(nginx)');
  assert.equal(run('id ghost').stderr, "id: 'ghost': no such user");
});

test('which, date, free, history, env and export', () => {
  const run = linuxSession();
  assert.equal(run('which ls').stdout, '/usr/bin/ls');
  assert.equal(run('which useradd').stdout, '/usr/sbin/useradd');
  const builtin = run('which cd');
  assert.equal(builtin.stdout, '');
  assert.equal(builtin.exitCode, 1);
  assert.equal(run('which nosuch').exitCode, 1);

  assert.equal(formatDate(new Date(Date.UTC(2026, 9, 20, 14, 3, 9)), '%a %b %e %H:%M:%S %Z %Y'), 'Tue Oct 20 14:03:09 UTC 2026');
  assert.equal(formatDate(new Date(Date.UTC(2026, 0, 5)), '%F %j %D'), '2026-01-05 005 01/05/26');
  assert.match(run('date').stdout, /^\w{3} \w{3} [ \d]\d \d\d:\d\d:\d\d UTC \d{4}$/);
  assert.equal(run('date -d 2026-10-20 +%A').stdout, 'Tuesday');
  assert.match(run('date -s 2020-01-01').explanation ?? '', /CAP_SYS_TIME/);

  assert.match(run('free').stdout, /^ +total +used +free +shared +buff\/cache +available\nMem: +8148236/);
  assert.match(run('free -h').stdout, /Mem: +7\.8Gi/);
  assert.match(run('free -m').stdout, /Mem: +7957/);

  const hist = linuxSession();
  hist('ls');
  hist('pwd');
  assert.equal(hist('history').stdout, '    1  ls\n    2  pwd\n    3  history');
  assert.equal(hist('history 2').stdout, '    3  history\n    4  history 2');
  hist('history -c');
  assert.equal(hist('history').stdout, '    1  history');
  assert.deepEqual(hist.state().commandHistory, ['history']);

  run('export COLOR=blue');
  assert.equal(run('echo $COLOR').stdout, 'blue');
  run('GREETING=hi');
  assert.equal(run('echo $GREETING').stdout, 'hi');
  assert.match(run('env').stdout, /^SHELL=\/bin\/bash/m);
  assert.equal(run('printenv USER').stdout, 'student');
});

test('systemctl: status from state, get-default, enable --now, is-active', () => {
  const run = linuxSession();
  assert.equal(run('systemctl get-default').stdout, 'multi-user.target');
  assert.match(run('systemctl status nginx').stdout, /Active: active \(running\)/);
  assert.equal(run('systemctl status nosuch').stderr, 'Unit nosuch.service could not be found.');
  assert.equal(run('systemctl status nosuch').exitCode, 4);
  assert.equal(run('sudo systemctl stop nginx').exitCode, 0);
  assert.equal(run('systemctl is-active nginx').stdout, 'inactive');
  assert.equal(run('systemctl is-active nginx').exitCode, 3);
  assert.match(run('systemctl status nginx').stdout, /Active: inactive \(dead\)/);
  const en = run('sudo systemctl enable --now nginx');
  assert.equal(en.exitCode, 0);
  assert.match(en.stdout, /Created symlink .*nginx\.service/);
  assert.equal(run('systemctl is-active nginx').stdout, 'active');
  assert.equal(run('systemctl is-enabled nginx').stdout, 'enabled');
  const denied = run('systemctl restart nginx');
  assert.match(denied.stderr, /Interactive authentication required/);
  assert.ok(denied.explanation);
  run('sudo systemctl set-default graphical.target');
  assert.equal(run('systemctl get-default').stdout, 'graphical.target');
});

test('Storage and hardware listings agree with each other', () => {
  const run = linuxSession();
  const fdisk = run('sudo fdisk -l').stdout;
  const df = run('df -h').stdout;
  const lsblk = run('lsblk').stdout;
  assert.match(fdisk, /\/dev\/sda1 .* 512M Linux filesystem/);
  assert.match(fdisk, /\/dev\/sda2 .* 4G Linux swap/);
  assert.match(fdisk, /\/dev\/sda3 .* Linux filesystem/);
  assert.match(df, /^\/dev\/sda1 +ext4 +512M .* \/boot$/m);
  assert.match(df, /^\/dev\/sda3 +ext4 +46G .* \/$/m);
  assert.ok(!df.includes('sdb'), 'no disk that fdisk does not know about');
  assert.match(lsblk, /sda2 .* part \[SWAP\]/);
  assert.match(run('df').stdout, /^Filesystem +1K-blocks +Used Available Use% Mounted on/);

  const fdiskUser = run('fdisk -l');
  assert.equal(fdiskUser.stderr, 'fdisk: cannot open /dev/sda: Permission denied');
  assert.equal(run('sudo fdisk /dev/sdb').stderr, 'fdisk: cannot open /dev/sdb: No such file or directory');
  assert.match(run('sudo fdisk /dev/sda').stdout, /^Welcome to fdisk/);

  // NIC driver and SATA controller line up across lspci, lsmod and dmesg
  const lspci = run('lspci').stdout;
  assert.match(lspci, /00:19\.0 Ethernet controller: Intel Corporation 82574L/);
  assert.match(lspci, /00:1f\.2 SATA controller/);
  assert.match(run('lsmod').stdout, /^e1000e /m);
  assert.match(run('dmesg | grep 00:19.0').stdout, /e1000e/);
  assert.match(run('dmesg | grep 00:1f.2').stdout, /SATA AHCI/);
});

test('ss and netstat list sockets from the session state', () => {
  const run = linuxSession();
  const ss = run('ss -tuln').stdout;
  assert.match(ss, /^Netid State/);
  assert.match(ss, /tcp +LISTEN .*0\.0\.0\.0:22 /);
  assert.match(ss, /tcp +LISTEN .*0\.0\.0\.0:80 /, 'nginx is a running service');
  assert.match(ss, /udp +UNCONN .*127\.0\.0\.53%lo:53/);
  assert.ok(!ss.includes('users:'), 'process names need root');
  assert.match(run('sudo ss -tulpn').stdout, /users:\(\("sshd",pid=1420,fd=3\)\)/);
  assert.match(run('ss -tul').stdout, /0\.0\.0\.0:ssh/);

  const ns = run('netstat -tuln');
  assert.match(ns.stdout, /^Active Internet connections \(only servers\)\nProto Recv-Q Send-Q Local Address +Foreign Address +State/);
  assert.match(ns.stdout, /^tcp +0 +0 0\.0\.0\.0:22 +0\.0\.0\.0:\* +LISTEN$/m);
  const nsp = run('netstat -tulpn');
  assert.match(nsp.stderr, /you would have to be root to see it all/);
  assert.match(run('sudo netstat -tulpn').stdout, /1420\/sshd/);
  assert.match(run('netstat -rn').stdout, /^0\.0\.0\.0 +192\.168\.1\.1 +0\.0\.0\.0 +UG/m);

  run('sudo systemctl stop nginx');
  assert.ok(!run('ss -tln').stdout.includes(':80 '), 'stopping a service closes its port');
  assert.match(run('ip addr').stdout, /inet 127\.0\.0\.1\/8 scope host lo/);
});

test('kill respects process ownership', () => {
  const run = linuxSession();
  const denied = run('kill 1420');
  assert.equal(denied.stderr, 'bash: kill: (1420) - Operation not permitted');
  assert.match(denied.explanation ?? '', /Process 1420 belongs to 'root'/);
  assert.equal(run('kill -9 9999').stderr, 'bash: kill: (9999) - No such process');
  assert.equal(run('sudo kill -9 1420').exitCode, 0);
  assert.ok(!run.state().processes.some(p => p.pid === 1420));
  assert.equal(run('kill 2100').exitCode, 0);
});

test('Labs still complete with the stricter commands', () => {
  const run = linuxSession();
  assert.match(run('sudo fdisk -l').stdout, /Disk \/dev\/sda/);
  assert.match(run('df -h').stdout, /\/boot/);
});
