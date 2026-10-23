import test from 'node:test';
import assert from 'node:assert/strict';
import { FileNode, SystemState, TerminalShell } from '../types/terminal.ts';
import { CommandContext, ExamModule } from '../types/modules.ts';
import { executeLinuxLine } from '../terminal/linuxEngine.ts';
import { executeWindowsLine } from '../terminal/windowsEngine.ts';
import { getNodeAtPath } from '../terminal/filesystem.ts';
import { LPI_MODULES } from './lpiModules.ts';
import { WINDOWS_PBQS } from './windowsPbqs.ts';
import {
  alexInDomainAdmins, alexInItAdmins, commandStages, connectivityVerified, countedSourceIps, diskpartStarted,
  extractedSourceIps, financeDirShown, ipconfigAllRun, jdoeUnlocked, maliciousConnectionFound, maliciousProcessKilled,
  maliciousProcessNamed, modulesListed, passwdEntryShown, sarahCreated, sarahHomeChecked, sarahHomeOwned, sataInDmesg,
  servicesListed, sfcRan, sfcRepairedAfterDism, failedLinesFound, pciListed, partitionTableListed, mountsShown,
} from './verifiers.ts';

// ---------------------------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------------------------

const ALL: ExamModule[] = [...LPI_MODULES, ...WINDOWS_PBQS];
const lab = (id: string) => {
  const m = ALL.find(x => x.id === id);
  if (!m) throw new Error(`no lab ${id}`);
  return m;
};

const ctx = (command: string, stdout: string, exitCode = 0): CommandContext => ({ command, stdout, exitCode });

interface LabRun {
  (line: string): CommandContext;
  fs: () => FileNode;
  state: () => SystemState;
  /** Objectives that have passed at least once, as in the lab UI. */
  done: Set<string>;
  /** Objectives the most recent command passes on its own. */
  now: () => string[];
}

/** Runs commands in a fresh copy of a lab and tracks which objectives complete. */
function labRun(id: string, shell?: TerminalShell, setup?: (s: SystemState) => void): LabRun {
  const m = lab(id);
  const sh = shell ?? m.defaultShell;
  let fs = structuredClone(m.initialFs);
  let state = structuredClone(m.initialState);
  setup?.(state);
  let cwd = m.track === 'lpi' ? '/home/student' : 'C:\\Users\\Student';
  let last: CommandContext | undefined;
  const run = ((line: string) => {
    const res = sh === 'bash'
      ? executeLinuxLine(line, cwd, fs, state)
      : executeWindowsLine(line, cwd, fs, state, sh, false);
    ({ newFs: fs, newState: state, newCwd: cwd } = res);
    last = { command: line, exitCode: res.exitCode, stdout: res.stdout };
    for (const id of run.now()) run.done.add(id);
    return last;
  }) as LabRun;
  run.fs = () => fs;
  run.state = () => state;
  run.done = new Set();
  run.now = () => m.objectives.filter(o => { try { return o.verifier(fs, state, last); } catch { return false; } }).map(o => o.id);
  return run;
}

const objective = (labId: string, objId: string) => {
  const o = lab(labId).objectives.find(x => x.id === objId);
  if (!o) throw new Error(`no objective ${objId}`);
  return o;
};

// ---------------------------------------------------------------------------------------------
// lpi-103-2: text processing
// ---------------------------------------------------------------------------------------------

const IP3 = '198.51.100.44\n198.51.100.44\n198.51.100.44';

test('obj-pipe-awk: passes only when the output is nothing but the source IP', () => {
  assert.ok(extractedSourceIps(ctx(`grep "Failed password" /var/log/auth.log | awk '{print $(NF-3)}'`, IP3)));
  assert.ok(extractedSourceIps(ctx(`awk '/Failed password/ {print $(NF-3)}' /var/log/auth.log`, IP3)));
  assert.ok(extractedSourceIps(ctx(`grep "Failed password" /var/log/auth.log | grep -oE '([0-9]{1,3}\\.){3}[0-9]{1,3}'`, IP3 + '\n')));
  // A fixed field number prints "admin" for the invalid-user lines
  assert.ok(!extractedSourceIps(ctx(`grep "Failed password" /var/log/auth.log | awk '{print $11}'`, 'admin\nadmin\n198.51.100.44')));
  assert.ok(!extractedSourceIps(ctx(`grep "Failed password" /var/log/auth.log | cut -d' ' -f11`, 'admin\nadmin\n198.51.100.44')));
  assert.ok(!extractedSourceIps(ctx(`echo 198.51.100.44`, '198.51.100.44')), 'must come from the log');
  assert.ok(!extractedSourceIps(ctx(`awk '{print $(NF-3)}' /var/log/auth.log`, '', 0)));
  assert.ok(!extractedSourceIps(undefined));
});

test('obj-sort-uniq: needs sort, then uniq -c, and a count of 3 for the attacker', () => {
  const awk = `grep "Failed password" /var/log/auth.log | awk '{print $(NF-3)}'`;
  assert.ok(countedSourceIps(ctx(`${awk} | sort | uniq -c`, '      3 198.51.100.44')));
  assert.ok(countedSourceIps(ctx(`${awk} | sort | uniq -c | sort -nr`, '      3 198.51.100.44')));
  assert.ok(countedSourceIps(ctx(`${awk} | sort -n | uniq --count`, '      3 198.51.100.44')));
  assert.ok(!countedSourceIps(ctx(`${awk} | sort | uniq`, '198.51.100.44')), 'no -c, no count');
  assert.ok(!countedSourceIps(ctx(`${awk} | uniq -c`, '      3 198.51.100.44')), 'uniq without sort only works when duplicates happen to be together');
  assert.ok(!countedSourceIps(ctx(`${awk} | uniq -c | sort`, '      3 198.51.100.44')), 'sort after uniq is too late');
  assert.ok(!countedSourceIps(ctx(`${awk} | uniq -c # sort`, '      3 198.51.100.44')), 'a sort in a comment does not count');
  assert.ok(!countedSourceIps(ctx(`grep Failed /var/log/auth.log | sort | uniq -c`,
    '      1 Oct 19 09:12:33 lpi-lab sshd[1902]: Failed password for invalid user admin from 198.51.100.44 port 54122 ssh2')), 'whole lines are all unique');
});

test('lpi-103-2 in the engine: right answers pass and wrong ones do not', () => {
  const pass = [
    `grep "Failed password" /var/log/auth.log | awk '{print $(NF-3)}'`,
    `awk '/Failed password/ {print $(NF-3)}' /var/log/auth.log`,
    `grep "Failed password" /var/log/auth.log | grep -oE '([0-9]{1,3}\\.){3}[0-9]{1,3}'`,
  ];
  for (const line of pass) {
    const run = labRun('lpi-103-2-text-processing');
    run(line);
    assert.ok(run.now().includes('obj-pipe-awk'), line);
  }
  for (const line of [`grep "Failed password" /var/log/auth.log | awk '{print $11}'`, `grep "Failed password" /var/log/auth.log | cut -d' ' -f11`]) {
    const run = labRun('lpi-103-2-text-processing');
    run(line);
    assert.ok(!run.now().includes('obj-pipe-awk'), line);
  }
  const run = labRun('lpi-103-2-text-processing');
  run(`grep "Failed password" /var/log/auth.log | awk '{print $(NF-3)}' | sort | uniq`);
  assert.ok(!run.now().includes('obj-sort-uniq'));
  run('grep Failed /var/log/auth.log | sort | uniq -c');
  assert.ok(!run.now().includes('obj-sort-uniq'));
  run(`grep "Failed password" /var/log/auth.log | awk '{print $(NF-3)}' | uniq -c`);
  assert.ok(!run.now().includes('obj-sort-uniq'), 'no sort stage');
  run(`grep "Failed password" /var/log/auth.log | awk '{print $(NF-3)}' | sort | uniq -c | sort -nr`);
  assert.ok(run.now().includes('obj-sort-uniq'));
});

// ---------------------------------------------------------------------------------------------
// lpi-107-1: users
// ---------------------------------------------------------------------------------------------

function fsWith(files: Record<string, string>, home?: { owner: string }): FileNode {
  const fs = structuredClone(lab('lpi-107-1-user-administration').initialFs);
  for (const [path, content] of Object.entries(files)) {
    const node = getNodeAtPath(fs, path, false);
    if (node) node.content = content;
  }
  if (home) {
    const parent = getNodeAtPath(fs, '/home', false)!;
    parent.children!['sarah'] = { name: 'sarah', type: 'directory', permissions: 'rwxr-x---', octal: 750, owner: home.owner, group: home.owner, updatedAt: '', children: {} };
  }
  return fs;
}

const GROUP = 'root:x:0:\nstudent:x:1000:\nfinance:x:1002:\ndevelopers:x:1003:';

test('usr-create: bash shell, developers as a supplementary group, not as the primary group', () => {
  const good = fsWith({
    '/etc/passwd': 'root:x:0:0:root:/root:/bin/bash\nsarah:x:1004:1004::/home/sarah:/bin/bash',
    '/etc/group': GROUP.replace('developers:x:1003:', 'developers:x:1003:sarah') + '\nsarah:x:1004:',
  });
  assert.ok(sarahCreated(good));
  const primary = fsWith({
    '/etc/passwd': 'sarah:x:1004:1003::/home/sarah:/bin/bash',
    '/etc/group': GROUP.replace('developers:x:1003:', 'developers:x:1003:sarah'),
  });
  assert.ok(!sarahCreated(primary), '-g developers sets the primary group');
  const noGroup = fsWith({ '/etc/passwd': 'sarah:x:1004:1004::/home/sarah:/bin/bash', '/etc/group': GROUP });
  assert.ok(!sarahCreated(noGroup));
  const sh = fsWith({ '/etc/passwd': 'sarah:x:1004:1004::/home/sarah:/bin/sh', '/etc/group': GROUP.replace('developers:x:1003:', 'developers:x:1003:student,sarah') });
  assert.ok(!sarahCreated(sh), 'login shell must be /bin/bash');
  const lookalike = fsWith({ '/etc/passwd': 'sarahk:x:1004:1004::/home/sarahk:/bin/bash', '/etc/group': GROUP.replace('developers:x:1003:', 'developers:x:1003:sarahk') });
  assert.ok(!sarahCreated(lookalike));
});

test('usr-verify-home: /home/sarah must belong to sarah', () => {
  assert.ok(sarahHomeOwned(fsWith({}, { owner: 'sarah' })));
  assert.ok(!sarahHomeOwned(fsWith({}, { owner: 'root' })));
  assert.ok(!sarahHomeOwned(fsWith({})));
});

test('usr-verify-home: a command has to look at /home/sarah', () => {
  const home = fsWith({}, { owner: 'sarah' });
  const line = 'drwxr-x--- 2 sarah sarah 4096 Oct 19 00:00 /home/sarah';
  for (const cmd of ['ls -ld /home/sarah', 'ls -ld /home/sarah/', 'ls -l /home', 'sudo ls -la /home/sarah', 'stat /home/sarah', 'ls -ld ~sarah']) {
    assert.ok(sarahHomeChecked(home, ctx(cmd, line)), cmd);
  }
  assert.ok(!sarahHomeChecked(home, ctx('sudo useradd -m -s /bin/bash -G developers sarah', '')), 'creating is not checking');
  assert.ok(!sarahHomeChecked(home, ctx('echo ls -ld /home/sarah', 'ls -ld /home/sarah')));
  assert.ok(!sarahHomeChecked(home, ctx('ls -ld /tmp # /home/sarah', 'drwxrwxrwt 2 root root 4096 Oct 19 00:00 /tmp')));
  assert.ok(!sarahHomeChecked(fsWith({}, { owner: 'root' }), ctx('ls -ld /home/sarah', line.replace(/sarah sarah/, 'root root'))));
});

test('lpi-107-1 in the engine: ls and stat on the home directory tick the check', () => {
  for (const line of ['ls -ld /home/sarah', 'stat /home/sarah', 'ls -l /home']) {
    const run = labRun('lpi-107-1-user-administration');
    run('sudo useradd -m -s /bin/bash -G developers sarah');
    run(line);
    assert.ok(run.done.has('usr-verify-home'), line);
  }
});

test('usr-verify-passwd: the command must read /etc/passwd and show the entry', () => {
  const entry = 'sarah:x:1004:1004::/home/sarah:/bin/bash';
  assert.ok(passwdEntryShown(ctx('grep sarah /etc/passwd', entry)));
  assert.ok(passwdEntryShown(ctx('cat /etc/passwd', `root:x:0:0:root:/root:/bin/bash\n${entry}`)));
  assert.ok(passwdEntryShown(ctx('getent passwd sarah', entry)));
  assert.ok(passwdEntryShown(ctx('grep -n sarah /etc/passwd', `35:${entry}`)));
  assert.ok(!passwdEntryShown(ctx('sudo grep sarah /etc/shadow', 'sarah:!:20380:0:99999:7:::')));
  assert.ok(!passwdEntryShown(ctx('grep sarah /etc/passwd', '', 1)));
});

test('lpi-107-1 in the engine: -G passes, -g and a bare useradd do not', () => {
  const ok = labRun('lpi-107-1-user-administration');
  ok('sudo useradd -m -s /bin/bash -G developers sarah');
  assert.ok(ok.done.has('usr-create'));
  assert.ok(!ok.done.has('usr-verify-home'), 'creating the account is not checking it');
  ok('ls -ld /home/sarah');
  assert.ok(ok.done.has('usr-verify-home'));
  ok('sudo grep sarah /etc/shadow');
  assert.ok(!ok.done.has('usr-verify-passwd'));
  ok('grep sarah /etc/passwd');
  assert.ok(ok.done.has('usr-verify-passwd'));

  const twoStep = labRun('lpi-107-1-user-administration');
  twoStep('sudo useradd -m -s /bin/bash sarah');
  assert.ok(!twoStep.done.has('usr-create'));
  twoStep('sudo usermod -aG developers sarah');
  assert.ok(twoStep.done.has('usr-create'));

  for (const line of ['sudo useradd -m -s /bin/bash -g developers sarah', 'sudo useradd -m sarah']) {
    const run = labRun('lpi-107-1-user-administration');
    run(line);
    assert.ok(!run.done.has('usr-create'), line);
  }
});

test('lpi-107-1 in the engine: getent passwd sarah shows the entry', () => {
  const run = labRun('lpi-107-1-user-administration');
  run('sudo useradd -m -s /bin/bash -G developers sarah');
  run('getent passwd sarah');
  assert.ok(run.now().includes('usr-verify-passwd'));
});

// ---------------------------------------------------------------------------------------------
// lpi-104-5: permissions
// ---------------------------------------------------------------------------------------------

const FIN = 'drwxrwxrwx 2 student student 4096 Oct 19 00:00 finance';

test('perm-check: an ls -l line or stat output for the finance directory itself', () => {
  for (const cmd of ['ls -ld /home/student/finance', 'ls -dl finance', 'ls -l -d finance', 'sudo ls -ld finance/']) {
    assert.ok(financeDirShown(ctx(cmd, FIN.replace(/finance$/, cmd.split(' ').pop()!))), cmd);
  }
  for (const cmd of ['ls -la', 'ls -al /home/student', 'ls -alh', 'ls -lah ~', 'ls -l | grep finance']) {
    assert.ok(financeDirShown(ctx(cmd, `total 8\ndrwxr-xr-x 3 student student 4096 Oct 19 00:00 .\n${FIN}`)), cmd);
  }
  const stat = `  File: /home/student/finance\n  Size: 4096\t\tBlocks: 8          IO Block: 4096   directory\nAccess: (0777/drwxrwxrwx)  Uid: ( 1000/ student)   Gid: ( 1000/ student)`;
  assert.ok(financeDirShown(ctx('stat /home/student/finance', stat)));

  assert.ok(!financeDirShown(ctx('ls -l /etc/passwd; echo finance', '-rw-r--r-- 1 root root 1820 Oct 19 00:00 /etc/passwd\nfinance')));
  assert.ok(!financeDirShown(ctx('ls -ld proj', 'drwxr-xr-x 2 student finance 4096 Oct 19 00:00 proj')), 'group finance is not the directory');
  assert.ok(!financeDirShown(ctx('ls -l finance', 'total 4\n-rw-rw-rw- 1 student student 64 Oct 19 00:00 q3_payroll.csv')), 'contents, not the directory');
  assert.ok(!financeDirShown(ctx('echo ' + FIN, FIN)));
});

test('lpi-104-5 in the engine: flag order does not matter', () => {
  for (const line of ['ls -ld /home/student/finance', 'ls -dl /home/student/finance', 'ls -l -d finance', 'ls -la', 'ls -al', 'ls -alh', 'ls -lah /home/student']) {
    const run = labRun('lpi-104-5-permissions');
    run(line);
    assert.ok(run.done.has('perm-check'), line);
  }
  const run = labRun('lpi-104-5-permissions');
  run('ls -l /etc/passwd; echo finance');
  run('mkdir proj');
  run('sudo chgrp finance proj');
  run('ls -ld proj');
  run('ls -l finance');
  assert.ok(!run.done.has('perm-check'));
});

test('lpi-104-5 in the engine: stat shows the directory', () => {
  const run = labRun('lpi-104-5-permissions');
  run('stat /home/student/finance');
  assert.ok(run.done.has('perm-check'));
});

// ---------------------------------------------------------------------------------------------
// lpi-101-1: hardware
// ---------------------------------------------------------------------------------------------

test('hw-dmesg: needs the SATA/AHCI controller in the output', () => {
  assert.ok(sataInDmesg(ctx('dmesg | grep -i sata', '[    1.124510] ahci 0000:00:1f.2: AHCI 0001.0000 32 slots 6 ports 1.5 Gbps 0x3f impl SATA mode')));
  assert.ok(sataInDmesg(ctx('dmesg | grep ahci', '[    1.124510] ahci 0000:00:1f.2: AHCI 0001.0000 32 slots')));
  assert.ok(!sataInDmesg(ctx('dmesg | grep e1000e', '[    2.104512] e1000e 0000:00:19.0 eth0: Intel(R) PRO/1000 Network Connection')));
  assert.ok(!sataInDmesg(ctx('dmesg | head -1', '[    0.000000] Linux version 6.8.0-45-generic')));
  const run = labRun('lpi-101-1-system-architecture');
  run('dmesg');
  assert.ok(run.done.has('hw-dmesg'), 'bare dmesg prints the controller line');
  const sata = '[    1.124510] ahci 0000:00:1f.2: AHCI 0001.0000 32 slots 6 ports 1.5 Gbps 0x3f impl SATA mode';
  assert.ok(sataInDmesg(ctx('journalctl -k | grep -i sata', sata)), 'the journal holds the kernel messages too');
  assert.ok(sataInDmesg(ctx('sudo journalctl --dmesg | grep -i sata', sata)));
  assert.ok(!sataInDmesg(ctx('echo dmesg SATA', 'dmesg SATA')));
  assert.ok(!sataInDmesg(ctx('cat notes.txt # dmesg', 'SATA')));
});

test('hw-lsmod: lsmod or /proc/modules, and echo does not count', () => {
  const run = labRun('lpi-101-1-system-architecture');
  run('grep e1000e /proc/modules');
  assert.ok(run.done.has('hw-lsmod'), 'grep e1000e /proc/modules');
  for (const line of ['lsmod', 'lsmod | grep e1000e', 'cat /proc/modules', 'sudo lsmod | grep e1000']) {
    const r = labRun('lpi-101-1-system-architecture');
    r(line);
    assert.ok(r.done.has('hw-lsmod'), line);
  }
  assert.ok(!modulesListed(ctx('echo lsmod Module', 'lsmod Module')));
  assert.ok(!modulesListed(ctx('echo /proc/modules e1000e', '/proc/modules e1000e')));
  assert.ok(!modulesListed(ctx('cat notes # lsmod', 'e1000e')));
});

test('commandStages: pipes and chains split, quotes and comments respected', () => {
  assert.deepEqual(commandStages(`grep "a | b" f | sort | uniq -c`), ['grep "a | b" f', 'sort', 'uniq -c']);
  assert.deepEqual(commandStages('ls; pwd && id || true'), ['ls', 'pwd', 'id', 'true']);
  assert.deepEqual(commandStages('ls # a comment | sort'), ['ls']);
  assert.deepEqual(commandStages(`echo '# not a comment'`), [`echo '# not a comment'`]);
  assert.deepEqual(commandStages('echo $# x#y'), ['echo $# x#y']);
  assert.deepEqual(commandStages('dmesg 2>&1 | grep -i sata'), ['dmesg 2>&1', 'grep -i sata']);
  assert.deepEqual(commandStages('dir C:\\Users\\Student'), ['dir C:\\Users\\Student']);
});

test('master re-check round 2: echo, printf and comments never pass a command check', () => {
  const probes: [string, string, string, string][] = [
    ['win-pbq-group-policy-mgmt', 'gpo-gpupdate-force', 'echo gpupdate /force', 'gpupdate /force'],
    ['win-pbq-group-policy-mgmt', 'gpo-gpresult-r', 'echo gpresult /r', 'gpresult /r'],
    ['lpi-101-1-system-architecture', 'hw-lsmod', 'echo lsmod Module', 'lsmod Module'],
    ['lpi-101-1-system-architecture', 'hw-lspci', 'printf "lspci Ethernet"', 'lspci Ethernet'],
    ['lpi-101-1-system-architecture', 'hw-dmesg', 'echo dmesg SATA', 'dmesg SATA'],
    ['lpi-103-2-text-processing', 'obj-pipe-awk', 'echo 198.51.100.44 # auth.log', '198.51.100.44'],
    ['lpi-103-2-text-processing', 'obj-grep', 'echo grep 198.51.100.44', 'grep 198.51.100.44'],
    ['lpi-103-2-text-processing', 'obj-sort-uniq', 'printf "      3 198.51.100.44" | sort | uniq -c', '      3 198.51.100.44'],
    ['lpi-102-1-disk-partitioning', 'disk-fdisk', 'echo fdisk -l Disk /dev/sda', 'fdisk -l Disk /dev/sda'],
    ['lpi-102-1-disk-partitioning', 'disk-df', 'echo df /boot', 'df /boot'],
    ['lpi-107-1-user-administration', 'usr-verify-passwd', 'echo sarah:x:1004:1004::/home/sarah:/bin/bash /etc/passwd', 'sarah:x:1004:1004::/home/sarah:/bin/bash /etc/passwd'],
    ['win-pbq-incident-response-taskkill', 'sec-netstat-ano', 'echo netstat 4444 3892', 'netstat 4444 3892'],
    ['win-pbq-incident-response-taskkill', 'sec-tasklist', 'echo tasklist svchost_update', 'tasklist svchost_update'],
    ['win-pbq-powershell-automation', 'ps-get-service', 'Write-Output "Get-Service W32Time"', 'Get-Service W32Time'],
    ['win-pbq-network-troubleshoot', 'net-ipconfig-all', 'echo ipconfig /all Windows IP Configuration', 'ipconfig /all Windows IP Configuration'],
  ];
  for (const [labId, objId, command, stdout] of probes) {
    assert.ok(!objective(labId, objId).verifier({} as FileNode, {} as SystemState, ctx(command, stdout)), `${objId}: ${command}`);
  }
  // obj-grep stays lenient about the pattern: grep Failed prints the same lines
  assert.ok(objective('lpi-103-2-text-processing', 'obj-grep').verifier({} as FileNode, {} as SystemState, ctx('grep Failed /var/log/auth.log', 'Failed password for root from 198.51.100.44')));
});

test('master re-check round 2: the echo probes fail in the engine too', () => {
  const probes: [string, string, string][] = [
    ['win-pbq-group-policy-mgmt', 'gpo-gpupdate-force', 'echo gpupdate /force'],
    ['lpi-101-1-system-architecture', 'hw-lsmod', 'echo lsmod Module'],
    ['lpi-103-2-text-processing', 'obj-pipe-awk', 'echo 198.51.100.44 # auth.log'],
  ];
  for (const [labId, objId, line] of probes) {
    const run = labRun(labId);
    run(line);
    assert.ok(!run.done.has(objId), `${objId}: ${line}`);
  }
});

// ---------------------------------------------------------------------------------------------
// win-pbq-network-troubleshoot
// ---------------------------------------------------------------------------------------------

const REPLY = (ip: string) => `Pinging ${ip} with 32 bytes of data:\nReply from ${ip}: bytes=32 time<1ms TTL=64`;
const NET = 'win-pbq-network-troubleshoot';

function fixedState(): SystemState {
  const s = structuredClone(lab(NET).initialState);
  s.interfaces[0] = { ...s.interfaces[0], ip: '192.168.1.145', netmask: '255.255.255.0', gateway: '192.168.1.1' };
  s.gatewayWorking = true;
  return s;
}

test('net-verify-ping: loopback and APIPA do not count, real targets after the fix do', () => {
  const apipa = lab(NET).initialState;
  assert.ok(!connectivityVerified(apipa, ctx('ping 127.0.0.1', REPLY('127.0.0.1'))));
  assert.ok(!connectivityVerified(apipa, ctx('ping 8.8.8.8', REPLY('8.8.8.8'))), 'still APIPA');
  const fixed = fixedState();
  assert.ok(!connectivityVerified(fixed, ctx('ping 127.0.0.1', REPLY('127.0.0.1'))));
  assert.ok(!connectivityVerified(fixed, ctx('ping localhost', REPLY('::1'))));
  assert.ok(!connectivityVerified(fixed, ctx('ping 192.168.1.145', REPLY('192.168.1.145'))), 'own address');
  assert.ok(connectivityVerified(fixed, ctx('ping 192.168.1.1', REPLY('192.168.1.1'))));
  assert.ok(connectivityVerified(fixed, ctx('ping 8.8.8.8', REPLY('8.8.8.8'))));
  assert.ok(!connectivityVerified(fixed, ctx('ping 8.8.8.8', 'Reply from 192.168.1.145: Destination host unreachable.')));
  assert.ok(connectivityVerified(fixed, ctx('Test-NetConnection 8.8.8.8', 'ComputerName           : 8.8.8.8\nPingSucceeded          : True')));
  assert.ok(!connectivityVerified(fixed, ctx('Test-NetConnection 8.8.8.8', 'PingSucceeded          : False')));
  assert.ok(connectivityVerified(fixed, ctx('tnc 8.8.8.8 -Port 53', 'TcpTestSucceeded : True')));
  assert.ok(connectivityVerified(fixed, ctx('Test-Connection 8.8.8.8',
    'Source        Destination     IPV4Address      IPV6Address     Bytes    Time(ms)\n------        -----------     -----------      -----------     -----    --------\nWIN-CLIENT01  8.8.8.8         8.8.8.8                          32       12')));
  assert.ok(!connectivityVerified(fixed, ctx('ipconfig /all', 'bytes=32 TTL=64')));
});

test('net-verify-ping: destinations are read from parameter binding, not every word', () => {
  const fixed = fixedState();
  // -ComputerName:value names the target too, so loopback in that form does not count
  assert.ok(!connectivityVerified(fixed, ctx('Test-NetConnection -ComputerName:127.0.0.1 -InformationLevel Quiet', 'True')));
  assert.ok(!connectivityVerified(fixed, ctx('Test-NetConnection -ComputerName 127.0.0.1 -InformationLevel Quiet', 'True')));
  assert.ok(!connectivityVerified(fixed, ctx('tnc -cn localhost -InformationLevel Quiet', 'True')));
  assert.ok(connectivityVerified(fixed, ctx('Test-NetConnection -ComputerName:8.8.8.8 -InformationLevel Quiet', 'True')));
  assert.ok(connectivityVerified(fixed, ctx('Test-Connection -TargetName 8.8.8.8 -Quiet', 'True')));
  // -Source is the PC itself, not where the probe went
  assert.ok(connectivityVerified(fixed, ctx('Test-Connection 8.8.8.8 -Source WIN-CLIENT01',
    'Source        Destination     IPV4Address      IPV6Address     Bytes    Time(ms)\n------        -----------     -----------      -----------     -----    --------\nWIN-CLIENT01  8.8.8.8         8.8.8.8                          32       12')));
  // ping's own options: counts and the source address are not targets, slash or dash
  assert.ok(connectivityVerified(fixed, ctx('ping -n 2 8.8.8.8', REPLY('8.8.8.8'))));
  assert.ok(connectivityVerified(fixed, ctx('ping /n 2 -S 192.168.1.145 8.8.8.8', REPLY('8.8.8.8'))));
});

test('net-ipconfig-all: /all in any case, or -all', () => {
  const out = 'Windows IP Configuration\n\n   Host Name . . . : WIN-CLIENT01';
  for (const c of ['ipconfig /all', 'ipconfig -all', 'ipconfig /ALL', 'IPCONFIG /All']) assert.ok(ipconfigAllRun(ctx(c, out)), c);
  assert.ok(!ipconfigAllRun(ctx('ipconfig', out)));
  assert.ok(!ipconfigAllRun(ctx('ipconfig /allcompartments', out)));
});

test('network lab in the engine: ping 127.0.0.1 before the renew does not finish the lab', () => {
  const run = labRun(NET);
  run('ping 127.0.0.1');
  assert.ok(!run.done.has('net-verify-ping'));
  run('ipconfig /renew');
  run('ping 127.0.0.1');
  assert.ok(!run.done.has('net-verify-ping'));
  run('ping 192.168.1.1');
  assert.ok(run.done.has('net-verify-ping'));
});

test('network lab in the engine: the PC answers its own APIPA address, the gateway does not', () => {
  const run = labRun(NET);
  assert.match(run('ping 169.254.82.114').stdout, /Reply from 169\.254\.82\.114/);
  assert.match(run('ping 192.168.1.1').stdout, /PING: transmit failed\. General failure\./);
});

test('network lab in the engine: -all, Clear-DnsClientCache and Test-Connection', () => {
  const cmd = labRun(NET);
  cmd('ipconfig -all');
  assert.ok(cmd.done.has('net-ipconfig-all'));
  const ps = labRun(NET, 'powershell');
  ps('ipconfig /renew');
  ps('Clear-DnsClientCache');
  assert.ok(ps.done.has('net-flush-dns'));
  ps('Test-Connection 8.8.8.8');
  assert.ok(ps.done.has('net-verify-ping'));
});

test('network lab in the engine: quoted loopback, the PC\'s own name and -Quiet False do not count', () => {
  const run = labRun(NET);
  run('ipconfig /renew');
  for (const line of ['ping "127.0.0.1"', 'ping WIN-CLIENT01', 'ping win-client01', 'ping -n 2 localhost']) {
    assert.equal(run(line).exitCode, 0, line);
    assert.ok(!run.now().includes('net-verify-ping'), line);
  }
  const ps = labRun(NET, 'powershell');
  ps('ipconfig /renew');
  for (const line of ['Test-Connection WIN-CLIENT01', 'Test-Connection "127.0.0.1" -Quiet', 'Test-NetConnection WIN-CLIENT01']) {
    ps(line);
    assert.ok(!ps.now().includes('net-verify-ping'), line);
  }
  // DNS is still broken before the flush: -Quiet prints False with exit code 0
  const quiet = ps('Test-Connection example.com -Quiet');
  assert.equal(quiet.stdout, 'False');
  assert.equal(quiet.exitCode, 0);
  assert.ok(!ps.done.has('net-verify-ping'));
  ps('Clear-DnsClientCache');
  assert.equal(ps('Test-Connection example.com -Quiet').stdout, 'True');
  assert.ok(ps.done.has('net-verify-ping'));
});

test('net-verify-ping: the address in the output decides, and quiet output must be all True', () => {
  const fixed = fixedState();
  assert.ok(!connectivityVerified(fixed, ctx('ping "127.0.0.1"', REPLY('127.0.0.1'))));
  assert.ok(!connectivityVerified(fixed, ctx('ping WIN-CLIENT01', 'Pinging WIN-CLIENT01 [192.168.1.145] with 32 bytes of data:\nReply from 192.168.1.145: bytes=32 time<1ms TTL=128')));
  assert.ok(connectivityVerified(fixed, ctx('ping example.com', 'Pinging example.com [93.184.216.34] with 32 bytes of data:\nReply from 93.184.216.34: bytes=32 time=12ms TTL=118')));
  assert.ok(!connectivityVerified(fixed, ctx('Test-Connection 8.8.8.8 -Quiet', 'False')));
  assert.ok(!connectivityVerified(fixed, ctx('Test-Connection 8.8.8.8,1.1.1.1 -Quiet', 'True\nFalse')));
  assert.ok(connectivityVerified(fixed, ctx('Test-Connection 8.8.8.8 -Quiet', 'True')));
});

// ---------------------------------------------------------------------------------------------
// win-pbq-active-directory-mgmt
// ---------------------------------------------------------------------------------------------

const AD = 'win-pbq-active-directory-mgmt';

function adState(alex?: { sam?: string; ou: string; groups?: string[] }): SystemState {
  const s = structuredClone(lab(AD).initialState);
  if (alex) {
    s.adUsers.push({
      sAMAccountName: alex.sam ?? 'alex', givenName: '', surname: '', displayName: 'Alex Chen', email: '',
      department: '', ou: alex.ou, enabled: false, locked: false, passwordNeverExpires: false,
      memberOf: alex.groups ?? ['Domain Users'],
    });
  }
  return s;
}

test('ad-unlock: checks the lockout flag, not the command', () => {
  const s = adState();
  assert.ok(!jdoeUnlocked(s));
  s.adUsers.find(u => u.sAMAccountName === 'jdoe')!.locked = false;
  assert.ok(jdoeUnlocked(s));
});

test('ad-create: alex must be stored without quotes and live in IT_Admins', () => {
  assert.ok(alexInItAdmins(adState({ ou: 'OU=IT_Admins,DC=corp,DC=local' })));
  assert.ok(alexInItAdmins(adState({ ou: 'ou=it_admins, dc=corp, dc=local' })));
  assert.ok(!alexInItAdmins(adState({ ou: 'OU=Marketing,DC=corp,DC=local' })));
  assert.ok(!alexInItAdmins(adState({ sam: '"alex"', ou: 'OU=IT_Admins,DC=corp,DC=local' })));
  assert.ok(!alexInItAdmins(adState()));
});

test('ad-add-group: membership on either side of the link', () => {
  assert.ok(alexInDomainAdmins(adState({ ou: 'OU=IT_Admins,DC=corp,DC=local', groups: ['Domain Users', 'Domain Admins'] })));
  const viaGroup = adState({ ou: 'OU=IT_Admins,DC=corp,DC=local' });
  viaGroup.adGroups.find(g => g.name === 'Domain Admins')!.members.push('alex');
  assert.ok(alexInDomainAdmins(viaGroup));
  assert.ok(!alexInDomainAdmins(adState({ ou: 'OU=IT_Admins,DC=corp,DC=local' })));
});

test('ad-create: a New-ADUser line without -SamAccountName does not count', () => {
  const s = adState({ ou: 'OU=IT_Admins,DC=corp,DC=local' });
  assert.ok(!alexInItAdmins(s, ctx('New-ADUser -Name alex -Path "OU=IT_Admins,DC=corp,DC=local"', '')));
  assert.ok(!alexInItAdmins(s, ctx('New-ADUser alex -Path "OU=IT_Admins,DC=corp,DC=local"', '')));
  assert.ok(alexInItAdmins(s, ctx('New-ADUser -SamAccountName alex -Name "Alex Chen" -Path "OU=IT_Admins,DC=corp,DC=local"', '')));
  assert.ok(alexInItAdmins(s, ctx('New-ADUser -Name "Alex Chen" -Sam alex -Path "OU=IT_Admins,DC=corp,DC=local"', '')), 'a unique prefix of the parameter is fine');
  assert.ok(alexInItAdmins(s), 'made in the ADUC panel, with no command');
  const run = labRun(AD);
  run('New-ADUser -Name alex -Path "OU=IT_Admins,DC=corp,DC=local"');
  assert.ok(!run.done.has('ad-create-alex'));
  // The account it made is not alex, so a later command does not pass the step either
  run('Get-ADUser -Filter *');
  assert.ok(!run.done.has('ad-create-alex'));
});

test('AD lab in the engine: the walkthrough forms pass, the wrong OU does not', () => {
  const run = labRun(AD);
  run('New-ADUser -SamAccountName alex -Name "Alex Chen" -Path "OU=Marketing,DC=corp,DC=local"');
  assert.ok(!run.done.has('ad-create-alex'));
  const ok = labRun(AD);
  ok('Unlock-ADAccount -Identity jdoe');
  ok('New-ADUser -SamAccountName alex -Name "Alex Chen" -Path "OU=IT_Admins,DC=corp,DC=local"');
  ok('Add-ADGroupMember -Identity "Domain Admins" -Members alex');
  assert.deepEqual([...ok.done].sort(), ['ad-add-group', 'ad-create-alex', 'ad-unlock-jdoe']);
});

test('AD lab in the engine: positional, quoted, DN and piped identities', () => {
  for (const line of ['Unlock-ADAccount jdoe', 'Unlock-ADAccount -Identity "jdoe"', `Unlock-ADAccount -Identity 'jdoe'`,
    'Unlock-ADAccount -Identity "CN=John Doe,OU=Marketing,DC=corp,DC=local"', 'Get-ADUser jdoe | Unlock-ADAccount']) {
    const run = labRun(AD);
    run(line);
    assert.ok(run.done.has('ad-unlock-jdoe'), line);
  }
  const run = labRun(AD);
  run('New-ADUser -SamAccountName "alex" -Name "Alex Chen" -Path "OU=IT_Admins,DC=corp,DC=local"');
  assert.ok(run.done.has('ad-create-alex'));
  run('Add-ADGroupMember "Domain Admins" alex');
  assert.ok(run.done.has('ad-add-group'));
  const list = labRun(AD);
  list('New-ADUser -SamAccountName alex -Name "Alex Chen" -Path "OU=IT_Admins,DC=corp,DC=local"');
  list('Add-ADGroupMember -Identity "Domain Admins" -Members alex,mscott');
  assert.ok(list.done.has('ad-add-group'));
  const withAlex = adState({ ou: 'OU=IT_Admins,DC=corp,DC=local' });
  const net = labRun(AD, 'cmd', s => { s.adUsers = withAlex.adUsers; });
  net('net group "Domain Admins" alex /add /domain');
  assert.ok(net.done.has('ad-add-group'));
});

// ---------------------------------------------------------------------------------------------
// win-pbq-incident-response-taskkill
// ---------------------------------------------------------------------------------------------

const IR = 'win-pbq-incident-response-taskkill';

test('sec-netstat / sec-tasklist: output must show the connection, its PID and the program', () => {
  const line = '  TCP    192.168.1.145:49811    203.0.113.88:4444      ESTABLISHED     3892';
  assert.ok(maliciousConnectionFound(ctx('netstat -ano', line)));
  assert.ok(maliciousConnectionFound(ctx('netstat -nao | findstr 4444', line)));
  assert.ok(maliciousConnectionFound(ctx('Get-NetTCPConnection -RemotePort 4444',
    'LocalAddress  LocalPort RemoteAddress RemotePort State       AppliedSetting OwningProcess\n192.168.1.145 49811     203.0.113.88  4444       Established Internet       3892')));
  assert.ok(!maliciousConnectionFound(ctx('netstat -an', '  TCP    192.168.1.145:49811    203.0.113.88:4444      ESTABLISHED')), 'no PID column');
  assert.ok(!maliciousConnectionFound(ctx('echo 4444 3892', '4444 3892')));

  assert.ok(maliciousProcessNamed(ctx('tasklist', 'svchost_update.exe            3892 Console                    1     12,698 K')));
  assert.ok(maliciousProcessNamed(ctx('Get-Process -Id 3892', '     10     12.40      24.80       88.40    3892   1 svchost_update')));
  assert.ok(!maliciousProcessNamed(ctx('tasklist /fi "pid eq 1120"', 'svchost.exe                   1120 Services')));
});

test('sec-taskkill: PID 3892 must be gone from the process list', () => {
  const s = structuredClone(lab(IR).initialState);
  assert.ok(!maliciousProcessKilled(s));
  s.processes = s.processes.filter(p => p.pid !== 3892);
  assert.ok(maliciousProcessKilled(s));
});

test('incident lab in the engine: base state has a real LAN address and PID 1120', () => {
  const run = labRun(IR);
  assert.match(run('netstat -ano').stdout, /192\.168\.1\.145:49811\s+203\.0\.113\.88:4444\s+ESTABLISHED\s+3892/);
  assert.ok(run.done.has('sec-netstat-ano'));
  assert.match(run('tasklist /fi "pid eq 1120"').stdout, /svchost\.exe\s+1120/);
  run('tasklist');
  assert.ok(run.done.has('sec-tasklist'));
  run('taskkill /F /PID 3892');
  assert.ok(run.done.has('sec-taskkill'));
  for (const line of ['taskkill /PID 3892 /F', 'taskkill /F /IM svchost_update.exe']) {
    const r = labRun(IR);
    r(line);
    assert.ok(r.done.has('sec-taskkill'), line);
  }
  const ps = labRun(IR, 'powershell');
  ps('Stop-Process -Id 3892 -Force');
  assert.ok(ps.done.has('sec-taskkill'));
});

test('incident lab in the engine: PowerShell forms and taskkill without /F', () => {
  for (const line of ['Stop-Process -Name svchost_update -Force', 'Get-Process -Id 3892 | Stop-Process -Force']) {
    const run = labRun(IR, 'powershell');
    run(line);
    assert.ok(run.done.has('sec-taskkill'), line);
  }
  const ps = labRun(IR, 'powershell');
  ps('Get-NetTCPConnection -RemotePort 4444');
  assert.ok(ps.done.has('sec-netstat-ano'));
  ps('Get-Process');
  assert.ok(ps.done.has('sec-tasklist'));

  const run = labRun(IR);
  const res = run('taskkill /PID 3892');
  assert.notEqual(res.exitCode, 0);
  assert.ok(!run.done.has('sec-taskkill'), 'the process is still running');
});

test('GPO lab in the engine: the domain controller is reachable from the base state', () => {
  const run = labRun('win-pbq-group-policy-mgmt', 'powershell');
  assert.match(run('Test-NetConnection dc01 -Port 389').stdout, /TcpTestSucceeded\s*:\s*True/);
});

// ---------------------------------------------------------------------------------------------
// win-pbq-sfc-dism-recovery
// ---------------------------------------------------------------------------------------------

const SFC = 'win-pbq-sfc-dism-recovery';

test('SFC objectives as pure state checks', () => {
  const s = structuredClone(lab(SFC).initialState);
  assert.ok(!sfcRan(s));
  assert.ok(sfcRan({ ...s, sfcScanned: true }));
  // The engine contract: SFC before DISM scans but cannot repair
  const scannedOnly = { ...s, sfcScanned: true, sfcRepaired: false };
  assert.ok(!sfcRepairedAfterDism(scannedOnly));
  assert.ok(!sfcRepairedAfterDism({ ...scannedOnly, dismRepaired: true }), 'DISM alone does not repair the files');
  assert.ok(sfcRepairedAfterDism({ ...s, sfcScanned: true, dismRepaired: true, sfcRepaired: true, systemIntegrityCorrupted: false }));
});

test('SFC lab in the engine: SFC alone leaves the last objective open; both orders finish', () => {
  const alone = labRun(SFC);
  alone('sfc /scannow');
  assert.ok(alone.done.has('sfc-scan'));
  assert.ok(!alone.done.has('sfc-rescan'));
  alone('dism /online /cleanup-image /restorehealth');
  assert.ok(alone.done.has('dism-restore'));
  assert.ok(!alone.done.has('sfc-rescan'), 'SFC has to run again after DISM');
  alone('sfc /scannow');
  assert.ok(alone.done.has('sfc-rescan'));

  const dismFirst = labRun(SFC);
  dismFirst('dism /online /cleanup-image /restorehealth');
  dismFirst('sfc /scannow');
  assert.deepEqual([...dismFirst.done].sort(), ['dism-restore', 'sfc-rescan', 'sfc-scan']);
  assert.equal(objective(SFC, 'sfc-rescan').title, 'Run SFC again');
});

test('SFC lab in the engine: Repair-WindowsImage counts as DISM', () => {
  const run = labRun(SFC, 'powershell');
  run('Repair-WindowsImage -Online -RestoreHealth');
  assert.ok(run.done.has('dism-restore'));
  run('sfc /scannow');
  assert.ok(run.done.has('sfc-rescan'));
});

test('SFC lab in the engine: a scan before DISM records the scan but not a repair', () => {
  const run = labRun(SFC);
  run('sfc /scannow');
  assert.equal(run.state().sfcScanned, true);
  assert.equal(run.state().sfcRepaired, false);
  assert.equal(run.state().systemIntegrityCorrupted, true);
});

test('labs that run diskpart start in an elevated prompt, and the diskpart walkthrough finishes', () => {
  const usesDiskpart = WINDOWS_PBQS.filter(m => m.solutionWalkthrough.some(s => /^diskpart\b/i.test(s.command))
    || m.objectives.some(o => /diskpart/i.test(`${o.shape ?? ''} ${o.hint}`) && !/^fs-/.test(o.id)));
  assert.ok(usesDiskpart.some(m => m.id === 'win-pbq-diskpart-partitioning'));
  for (const m of usesDiskpart) assert.equal(m.initialState.isRootOrAdmin, true, `${m.id} must run elevated: diskpart needs it`);
  const m = lab('win-pbq-diskpart-partitioning');
  let fs = structuredClone(m.initialFs);
  let state = structuredClone(m.initialState);
  let cwd = 'C:\\Users\\Student';
  let diskpartActive = false;
  const done = new Set<string>();
  for (const line of m.solutionWalkthrough.flatMap(s => s.command.split('\n'))) {
    const res = executeWindowsLine(line, cwd, fs, state, 'cmd', diskpartActive);
    ({ newFs: fs, newState: state, newCwd: cwd } = res);
    diskpartActive = !!res.diskpartActive;
    for (const o of m.objectives) if (o.verifier(fs, state, { command: line, exitCode: res.exitCode, stdout: res.stdout })) done.add(o.id);
  }
  assert.deepEqual([...done].sort(), m.objectives.map(o => o.id).sort());
});

test('diskpart lab: a 500 MB partition or a full format does not pass', () => {
  const m = lab('win-pbq-diskpart-partitioning');
  const play = (lines: string[]) => {
    let fs = structuredClone(m.initialFs);
    let state = structuredClone(m.initialState);
    let diskpartActive = false;
    const done = new Set<string>();
    for (const line of lines) {
      const res = executeWindowsLine(line, 'C:\\Users\\Student', fs, state, 'cmd', diskpartActive);
      ({ newFs: fs, newState: state } = res);
      diskpartActive = !!res.diskpartActive;
      for (const o of m.objectives) if (o.verifier(fs, state, { command: line, exitCode: res.exitCode, stdout: res.stdout })) done.add(o.id);
    }
    return done;
  };
  const small = play(['diskpart', 'select disk 1', 'create partition primary size=500', 'format fs=ntfs quick', 'assign letter=E']);
  assert.ok(!small.has('dp-create-part') && !small.has('dp-format-assign'));
  const full = play(['diskpart', 'select disk 1', 'create partition primary', 'format fs=ntfs', 'assign letter=E']);
  assert.ok(full.has('dp-create-part') && !full.has('dp-format-assign'), 'the step asks for a quick format');
  const ok = play(['diskpart', 'sel dis 1', 'cre par pri', 'format fs=ntfs quick', 'assign letter=E']);
  assert.ok(ok.has('dp-create-part') && ok.has('dp-format-assign'));
});

test('SFC walkthrough runs sfc, dism, sfc', () => {
  assert.deepEqual(lab(SFC).solutionWalkthrough.map(s => s.command.split(' ')[0]), ['sfc', 'dism', 'sfc']);
});

// ---------------------------------------------------------------------------------------------
// Base state
// ---------------------------------------------------------------------------------------------

test('Windows labs start healthy unless the scenario breaks something', () => {
  for (const m of WINDOWS_PBQS) {
    const s = m.initialState;
    assert.equal(s.sfcScanned, false, m.id);
    if (m.id === NET) {
      assert.ok(s.interfaces[0].ip.startsWith('169.254.'));
      assert.equal(s.gatewayWorking, false);
      assert.equal(s.dnsWorking, false);
    } else {
      assert.equal(s.interfaces[0].ip, '192.168.1.145', m.id);
      assert.equal(s.interfaces[0].netmask, '255.255.255.0', m.id);
      assert.equal(s.interfaces[0].gateway, '192.168.1.1', m.id);
      assert.ok(s.gatewayWorking && s.dnsWorking, m.id);
    }
    assert.equal(s.systemIntegrityCorrupted, m.id === SFC, m.id);
    assert.ok(s.processes.some(p => p.pid === 1120 && p.command === 'svchost.exe'), m.id);
  }
});

test('master re-check: Invoke-GPUpdate -Force counts as a forced policy refresh, a plain refresh does not', () => {
  const run = labRun('win-pbq-group-policy-mgmt', 'powershell');
  run('Invoke-GPUpdate');
  assert.ok(!run.done.has('gpo-gpupdate-force'));
  run('Invoke-GPUpdate -Force');
  assert.ok(run.done.has('gpo-gpupdate-force'));
});

test('master re-check round 2: correct alternatives pass (gsv, diskpart.exe, /proc/modules)', () => {
  const ps = labRun('win-pbq-powershell-automation');
  ps('gsv w32time');
  assert.ok(ps.done.has('ps-get-service'), 'gsv is the alias of Get-Service');
  assert.ok(servicesListed(ctx('Get-Service | Where-Object Status -eq Stopped', 'Stopped  W32Time            Windows Time')));
  assert.ok(diskpartStarted(ctx('diskpart', '')));
  assert.ok(diskpartStarted(ctx('diskpart.exe', '')));
  assert.ok(diskpartStarted(ctx('DISKPART.EXE', '')));
  assert.ok(diskpartStarted(ctx('C:\\Windows\\System32\\diskpart.exe', '')));
  assert.ok(!diskpartStarted(ctx('echo diskpart', 'diskpart')));
  assert.ok(!diskpartStarted(ctx('diskpart /s script.txt', '')), 'script mode does not open the prompt');
});

test('master re-check: sudo in front of lspci and df still counts', () => {
  const hw = objective('lpi-101-1-system-architecture', 'hw-lspci');
  assert.ok(hw.verifier({} as FileNode, {} as SystemState, ctx('sudo lspci', '00:19.0 Ethernet controller: Intel')));
  assert.ok(!hw.verifier({} as FileNode, {} as SystemState, ctx('echo lspci', 'Ethernet')));
});

// ---------------------------------------------------------------------------------------------
// First steps (lpi-000-first-steps, win-000-first-steps)
// ---------------------------------------------------------------------------------------------

const FS_LINUX = 'lpi-000-first-steps';
const FS_WIN = 'win-000-first-steps';

/** Runs the commands in a fresh copy of the lab and returns the tasks they completed. */
const firstSteps = (id: string, shell: TerminalShell | undefined, ...lines: string[]) => {
  const run = labRun(id, shell);
  for (const line of lines) run(line);
  return [...run.done].sort();
};

test('first steps (bash): every reasonable way of doing each task counts', () => {
  const variants: Record<string, string[][]> = {
    'fs-where': [['pwd'], ['pwd -P'], ['echo $PWD'], ['cd notes', 'pwd']],
    'fs-list': [['ls'], ['ls -l'], ['ls -la'], ['ls -al ~'], ['ls .'], ['ls /home/student'], ['ls notes'], ['cd notes', 'ls']],
    'fs-read': [['cat welcome.txt'], ['cat ./welcome.txt'], ['cat ~/welcome.txt'], ['head welcome.txt'], ['tail -n 20 welcome.txt'], ['cat welcome.txt | head -n 3'], ['cd notes', 'cat ../welcome.txt']],
    'fs-cd': [['cd notes'], ['cd notes/'], ['cd ./notes'], ['cd ~/notes'], ['cd /home/student/notes'], ['cd "notes"'], ['cd notes && ls'], ['cd notes', 'cd ..', 'cd notes']],
    'fs-help': [['man ls'], ['man pwd'], ['ls --help'], ['help cd'], ['info ls'], ['whatis ls'], ['man ls | head'], ['help'], ['pwd --help']],
  };
  for (const [task, runs] of Object.entries(variants)) {
    for (const lines of runs) {
      assert.ok(firstSteps(FS_LINUX, undefined, ...lines).includes(task), `${task}: ${lines.join(' ; ')}`);
    }
  }
});

test('first steps (bash): mistakes and look-alikes do not tick a task', () => {
  const none = (lines: string[], task: string) =>
    assert.ok(!firstSteps(FS_LINUX, undefined, ...lines).includes(task), `${task} should not pass: ${lines.join(' ; ')}`);
  none(['PWD'], 'fs-where');
  none(['echo /home/student'], 'fs-where');
  none(['LS'], 'fs-list');
  none(['ls /etc'], 'fs-list');
  none(['cat welcom.txt'], 'fs-read');
  none(['echo welcome.txt'], 'fs-read');
  none(['cd note'], 'fs-cd');
  none(['cd /tmp'], 'fs-cd');
  none(['cd nowhere; ls'], 'fs-cd');
  none(['man'], 'fs-help');
  none(['man nosuchcommand'], 'fs-help');
});

test('first steps (Windows): every reasonable way counts in Command Prompt and in PowerShell', () => {
  const cmd: Record<string, string[][]> = {
    'fs-where': [['cd'], ['CD'], ['chdir'], ['echo %cd%'], ['cd notes', 'cd']],
    'fs-list': [['dir'], ['DIR'], ['dir /b'], ['dir /w'], ['dir C:\\Users\\Student'], ['dir notes'], ['cd notes', 'dir']],
    'fs-read': [['type welcome.txt'], ['TYPE WELCOME.TXT'], ['type .\\welcome.txt'], ['type C:\\Users\\Student\\welcome.txt'], ['cd notes', 'type ..\\welcome.txt']],
    'fs-cd': [['cd notes'], ['CD NOTES'], ['cd notes\\'], ['cd .\\notes'], ['chdir notes'], ['cd C:\\Users\\Student\\notes'], ['cd /d C:\\Users\\Student\\notes'], ['cd notes', 'cd']],
    'fs-help': [['help dir'], ['HELP DIR'], ['dir /?'], ['cd /?'], ['type /?'], ['help']],
  };
  const ps: Record<string, string[][]> = {
    'fs-where': [['pwd'], ['Get-Location'], ['gl']],
    'fs-list': [['dir'], ['ls'], ['gci'], ['Get-ChildItem'], ['get-childitem -Force']],
    'fs-read': [['cat welcome.txt'], ['type welcome.txt'], ['gc .\\welcome.txt'], ['Get-Content welcome.txt'], ['Get-Content -Path welcome.txt']],
    'fs-cd': [['cd notes'], ['Set-Location notes'], ['sl notes'], ['Set-Location -Path notes'], ['cd .\\notes\\'], ['Set-Location notes', 'pwd']],
    'fs-help': [['Get-Help dir'], ['help dir'], ['Get-Help Get-ChildItem'], ['man ls'], ['Get-ChildItem -?'], ['Get-Help']],
  };
  for (const [shell, table] of [['cmd', cmd], ['powershell', ps]] as const) {
    for (const [task, runs] of Object.entries(table)) {
      for (const lines of runs) {
        assert.ok(firstSteps(FS_WIN, shell, ...lines).includes(task), `${shell} ${task}: ${lines.join(' ; ')}`);
      }
    }
  }
});

test('first steps (Windows): mistakes and look-alikes do not tick a task', () => {
  const none = (shell: TerminalShell, lines: string[], task: string) =>
    assert.ok(!firstSteps(FS_WIN, shell, ...lines).includes(task), `${shell} ${task} should not pass: ${lines.join(' ; ')}`);
  none('cmd', ['ls'], 'fs-list');
  none('cmd', ['dir C:\\Windows'], 'fs-list');
  none('cmd', ['type welcom.txt'], 'fs-read');
  none('cmd', ['echo welcome.txt'], 'fs-read');
  none('cmd', ['cd note'], 'fs-cd');
  none('cmd', ['cd C:\\Windows'], 'fs-cd');
  none('cmd', ['help nosuchcommand'], 'fs-help');
  none('cmd', ['echo C:\\Users\\Student'], 'fs-where');
});

test('first steps: the files always say what to type next, and doing what they say finishes the lab', () => {
  for (const [id, list, read, help] of [[FS_LINUX, 'ls', 'cat', 'man ls'], [FS_WIN, 'dir', 'type', 'help dir']] as const) {
    const m = lab(id);
    const isWin = m.track !== 'lpi';
    const home = isWin ? 'C:\\Users\\Student' : '/home/student';
    const welcome = getNodeAtPath(m.initialFs, `${home}${isWin ? '\\' : '/'}welcome.txt`, isWin)?.content ?? '';
    const next = getNodeAtPath(m.initialFs, `${home}${isWin ? '\\notes\\' : '/notes/'}next.txt`, isWin)?.content ?? '';
    assert.match(welcome, /^ {4}cd notes$/m, `${id}: welcome.txt names the next command`);
    assert.match(next, new RegExp(`^ {4}${help}$`, 'm'), `${id}: next.txt names the last command`);
    assert.ok(!/!/.test(welcome + next), `${id}: no exclamation marks`);

    // Follow the task list for the first three, then only what the files say
    const run = labRun(id);
    run(isWin ? 'cd' : 'pwd');
    run(list);
    run(`${read} welcome.txt`);
    run('cd notes');
    run(list);
    run(`${read} next.txt`);
    run(help);
    assert.deepEqual([...run.done].sort(), m.objectives.map(o => o.id).sort(), id);
  }
});

test('network lab in the engine: Test-NetConnection to a real host passes after the renew (its SourceAddress line is the PC itself)', () => {
  for (const line of ['Test-NetConnection 8.8.8.8', 'tnc 8.8.8.8', 'Test-NetConnection 8.8.8.8 -Port 443', 'Test-NetConnection 192.168.1.1']) {
    const run = labRun(NET, 'powershell');
    run('ipconfig /renew');
    const res = run(line);
    assert.match(res.stdout, /SourceAddress\s*:\s*192\.168\./, line);
    assert.ok(run.done.has('net-verify-ping'), line);
  }
  const own = labRun(NET, 'powershell');
  own('ipconfig /renew');
  own('Test-NetConnection 127.0.0.1');
  assert.ok(!own.done.has('net-verify-ping'), 'loopback still does not count');
});

// ---------------------------------------------------------------------------------------------
// Typed answers are not evidence (issue #28, finding 3)
// ---------------------------------------------------------------------------------------------

test('a real command followed by an echoed answer does not pass any output check', () => {
  const linux = lab('lpi-101-1-system-architecture');
  // Each line is run in the engine, so the output is exactly what the learner would see
  const run = (line: string, m: ExamModule = linux) => {
    const res = executeLinuxLine(line, '/home/student', structuredClone(m.initialFs), structuredClone(m.initialState));
    return ctx(line, res.stdout, res.exitCode);
  };
  const text = lab('lpi-103-2-text-processing');
  const cases: [string, (c: CommandContext) => boolean, ExamModule?][] = [
    ['grep NEVER /var/log/auth.log; echo 198.51.100.44', failedLinesFound, text],
    ['grep NEVER /var/log/auth.log; echo 198.51.100.44', extractedSourceIps, text],
    ['sort /dev/null | uniq -c; echo "3 198.51.100.44"', countedSourceIps, text],
    ['lspci > /dev/null; echo Ethernet', pciListed],
    ['lsmod > /dev/null; echo e1000e', modulesListed],
    ['dmesg > /dev/null; echo ahci', sataInDmesg],
    ['df > /dev/null; echo /boot', mountsShown],
    ['grep nobody /etc/passwd; echo "sarah:x:1001:1001::/home/sarah:/bin/bash"', passwdEntryShown],
  ];
  for (const [line, check, m] of cases) {
    const c = run(line, m);
    assert.equal(c.exitCode, 0, `${line}: the line itself succeeds`);
    assert.equal(check(c), false, `${line}: passes ${check.name}`);
  }
  // The real commands on their own still pass
  assert.ok(failedLinesFound(run('grep "Failed password" /var/log/auth.log', text)));
  assert.ok(pciListed(run('lspci')));
  assert.ok(modulesListed(run('lsmod')));
  // Windows output checks follow the same rule
  assert.equal(servicesListed(ctx('Get-Service | Out-Null; Write-Output W32Time', 'W32Time')), false);
  assert.equal(maliciousConnectionFound(ctx('netstat -ano > nul & echo 4444 3892', '4444 3892')), false);
  assert.equal(maliciousProcessNamed(ctx('tasklist > nul & echo svchost_update', 'svchost_update')), false);
  assert.equal(ipconfigAllRun(ctx('ipconfig /all > nul & echo Windows IP Configuration', 'Windows IP Configuration')), false);
  assert.equal(partitionTableListed(ctx('fdisk -l > /dev/null; echo Disk /dev/sda', 'Disk /dev/sda')), false);
});
