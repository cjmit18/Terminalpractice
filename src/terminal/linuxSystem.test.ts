import test from 'node:test';
import assert from 'node:assert/strict';
import { linuxSession } from './testUtils.ts';

// ps, kill -l, ip addr, lspci and grep context, compared with real procps, bash, iproute2, pciutils and GNU grep
// (fact-check E-15, L-6, L-14, E-26)

test('ps -ef uses the System V columns; ps aux | grep shows the grep itself', () => {
  const run = linuxSession();
  const ef = run('ps -ef').stdout.split('\n');
  assert.equal(ef[0], 'UID          PID    PPID  C STIME TTY          TIME CMD');
  assert.match(ef[1], /^root {11}1 {7}0 {2}0 \d\d:\d\d \? {8}\d\d:\d\d:\d\d \/sbin\/init splash$/);
  assert.match(run('ps -ef').stdout, /^student +\d+ +2100 .* ps -ef$/m);
  assert.match(run('ps aux').stdout, /^USER +PID %CPU %MEM +VSZ +RSS TTY +STAT START +TIME COMMAND$/m);
  const grep = run('ps aux | grep sshd').stdout.split('\n');
  assert.equal(grep.length, 2);
  assert.match(grep[0], /\/usr\/sbin\/sshd -D$/);
  assert.match(grep[1], /^student .* grep sshd$/);
  assert.deepEqual(run('ps').stdout.split('\n').map(l => l.trim().split(/ +/).pop()), ['CMD', 'bash', 'ps']);
});

test('kill -l lists the signals the way bash does', () => {
  const run = linuxSession();
  const lines = run('kill -l').stdout.split('\n');
  assert.equal(lines[0], ' 1) SIGHUP\t 2) SIGINT\t 3) SIGQUIT\t 4) SIGILL\t 5) SIGTRAP');
  assert.equal(lines[1], ' 6) SIGABRT\t 7) SIGBUS\t 8) SIGFPE\t 9) SIGKILL\t10) SIGUSR1');
  assert.equal(lines[2], '11) SIGSEGV\t12) SIGUSR2\t13) SIGPIPE\t14) SIGALRM\t15) SIGTERM');
  assert.equal(lines.length, 13);
  assert.equal(run('kill -l 9 TERM 137').stdout, 'KILL\n15\nKILL');
  assert.equal(run('kill -BOGUS 1').stderr, 'bash: kill: BOGUS: invalid signal specification');
  assert.equal(run('kill -s TERM 99999').stderr, 'bash: kill: (99999) - No such process');
});

test('ip addr numbers lo 1 and eth0 2', () => {
  const run = linuxSession();
  const out = run('ip addr').stdout;
  assert.match(out, /^1: lo: <LOOPBACK,UP,LOWER_UP> mtu 65536 qdisc noqueue state UNKNOWN group default qlen 1000$/m);
  assert.match(out, /^2: eth0: <BROADCAST,MULTICAST,UP,LOWER_UP> mtu 1500 qdisc fq_codel state UP group default qlen 1000$/m);
  assert.match(out, /^ {7}valid_lft forever preferred_lft forever$/m);
  assert.match(run('ip link show eth0').stdout, /^2: eth0: .* mode DEFAULT group default qlen 1000$/m);
});

test('lspci is sorted by address and supports -k, -s and -v', () => {
  const run = linuxSession();
  const addrs = run('lspci').stdout.split('\n').map(l => l.slice(0, 7));
  assert.deepEqual(addrs, [...addrs].sort());
  assert.equal(run('lspci -k -s 00:19.0').stdout, [
    '00:19.0 Ethernet controller: Intel Corporation 82574L Gigabit Network Connection',
    '\tKernel driver in use: e1000e',
    '\tKernel modules: e1000e',
  ].join('\n'));
  assert.match(run('lspci -k').stdout, /00:1f\.2 SATA controller: .*\n\tKernel driver in use: ahci\n\tKernel modules: ahci/);
  assert.equal(run('lspci -s 1f.2').stdout.split('\n').length, 1);
  assert.match(run('lspci -v -s 00:19.0').stdout, /\tSubsystem: .*\n\tFlags: bus master, .*IRQ \d+\n\tKernel driver in use: e1000e/);
  assert.match(run('lspci -nn -s 00:19.0').stdout, /\[0200\]: .* \[8086:10d3\]$/);
  assert.match(run('dmesg').stdout, /\] ahci 0000:00:1f\.2: AHCI 0001\.0000 32 slots 6 ports 1\.5 Gbps 0x3f impl SATA mode$/m);
});

test('grep -A, -B, -C and -m print context like GNU grep', () => {
  const run = linuxSession();
  run("printf 'a\\nx1\\nb\\nc\\nd\\nx2\\nx3\\ne\\nf\\ng\\nh\\nx4\\n' > g.txt");
  assert.equal(run('grep -n -C1 x g.txt').stdout, '1-a\n2:x1\n3-b\n--\n5-d\n6:x2\n7:x3\n8-e\n--\n11-h\n12:x4');
  assert.equal(run('grep -A1 x g.txt').stdout, 'x1\nb\n--\nx2\nx3\ne\n--\nx4');
  assert.equal(run('grep -B2 -m2 x g.txt').stdout, 'a\nx1\n--\nc\nd\nx2');
  assert.equal(run('grep -m1 -c x g.txt').stdout, '1');
  assert.equal(run('grep -A z x g.txt').stderr, 'grep: z: invalid context length argument');
});

test('smaller utilities: rmdir, du, pgrep/pkill, nice, xargs, nl, mount, swapon, blkid, modinfo', () => {
  const run = linuxSession();
  run('mkdir -p a/b/c');
  assert.equal(run('rmdir -p a/b/c').exitCode, 0);
  assert.equal(run('ls a').exitCode, 2);
  assert.equal(run('rmdir scripts').stderr, "rmdir: failed to remove 'scripts': Directory not empty");
  assert.match(run('du -sh scripts').stdout, /^8\.0K\tscripts$/);
  assert.match(run('du -c notes.txt scripts').stdout, /\n12\ttotal$/);
  assert.equal(run('pgrep sshd').stdout, '1420');
  assert.equal(run('pgrep nothing').exitCode, 1);
  assert.match(run('pkill cron').stderr, /Operation not permitted/);
  run('sudo pkill cron');
  assert.equal(run('pgrep cron').exitCode, 1);
  assert.equal(run("nice -n 5 echo '$HOME'").stdout, '$HOME');
  assert.equal(run('echo a b c d | xargs -n 2 echo').stdout, 'a b\nc d');
  assert.equal(run('printf "root\\nstudent\\n" | xargs -I {} id -u {}').stdout, '0\n1000');
  assert.match(run('nl notes.txt').stdout, /^ {5}1\tLPIC-1 Study Notes:$/m);
  assert.match(run('mount').stdout, /^\/dev\/sda3 on \/ type ext4 \(rw,relatime,errors=remount-ro\)$/m);
  assert.match(run('swapon --show').stdout, /^\/dev\/sda2 partition +4G +0B +-2$/m);
  assert.match(run('blkid /dev/sda2').stdout, /TYPE="swap"/);
  assert.equal(run('modinfo -F depends ahci').stdout, 'libahci');
  assert.equal(run('modinfo nope').stderr, 'modinfo: ERROR: Module nope not found.');
});

test('wc prints a total line for several files', () => {
  const run = linuxSession();
  assert.match(run('wc -l /etc/passwd /etc/hosts').stdout, /^ +6 \/etc\/passwd\n +4 \/etc\/hosts\n +10 total$/);
});
