import test from 'node:test';
import assert from 'node:assert/strict';
import { 
  octalToSymbolic, 
  symbolicToOctal, 
  normalizePath, 
  createDefaultLinuxFs, 
  createDefaultWindowsFs, 
  getNodeAtPath, 
  createNode,
  applyChmod,
  applySpecialBits,
  getSpecialBits,
  getUserGroups,
} from './filesystem.ts';
import { parsePipelinedLine, tokenizeArgs, extractStderrRedirect, splitChainedCommandLine } from './parser.ts';
import { executeLinuxLine } from './linuxEngine.ts';
import { executeWindowsLine } from './windowsEngine.ts';
import { LPI_MODULES } from '../data/lpiModules.ts';
import { WINDOWS_PBQS } from '../data/windowsPbqs.ts';
import type { CommandContext } from '../types/modules.ts';

test('Filesystem: octal and symbolic conversions work bidirectionally', () => {
  assert.equal(octalToSymbolic(755), 'rwxr-xr-x');
  assert.equal(octalToSymbolic(644), 'rw-r--r--');
  assert.equal(octalToSymbolic(700), 'rwx------');
  assert.equal(octalToSymbolic(750), 'rwxr-x---');
  assert.equal(octalToSymbolic(777), 'rwxrwxrwx');

  assert.equal(symbolicToOctal('rwxr-xr-x'), 755);
  assert.equal(symbolicToOctal('rw-r--r--'), 644);
  assert.equal(symbolicToOctal('rwxr-x---'), 750);
});

test('Filesystem: path normalization handles absolute, relative, and home tilde', () => {
  assert.equal(normalizePath('/etc/passwd', '/home/student', false), '/etc/passwd');
  assert.equal(normalizePath('notes.txt', '/home/student', false), '/home/student/notes.txt');
  assert.equal(normalizePath('../etc', '/home/student', false), '/home/etc');
  assert.equal(normalizePath('~', '/', false), '/home/student');
  assert.equal(normalizePath('~/scripts', '/', false), '/home/student/scripts');

  // Windows
  assert.equal(normalizePath('C:\\Windows\\System32', 'C:\\Users\\Student', true), 'C:\\Windows\\System32');
  assert.equal(normalizePath('Desktop', 'C:\\Users\\Student', true), 'C:\\Users\\Student\\Desktop');
  assert.equal(normalizePath('..\\Administrator', 'C:\\Users\\Student', true), 'C:\\Users\\Administrator');
});

test('Parser: tokenizeArgs handles spaces, single quotes, double quotes, and escapes', () => {
  const t1 = tokenizeArgs('chmod 750 /home/student/finance');
  assert.deepEqual(t1, ['chmod', '750', '/home/student/finance']);

  const t2 = tokenizeArgs('grep "Failed password" /var/log/auth.log');
  assert.deepEqual(t2, ['grep', 'Failed password', '/var/log/auth.log']);

  const t3 = tokenizeArgs('chown "root":"finance" \'my folder\'');
  assert.deepEqual(t3, ['chown', 'root:finance', 'my folder']);
});

test('Parser: parsePipelinedLine splits commands correctly', () => {
  const p1 = parsePipelinedLine('cat /var/log/syslog | grep error | wc -l');
  assert.equal(p1.length, 3);
  assert.equal(p1[0].name, 'cat');
  assert.equal(p1[1].name, 'grep');
  assert.equal(p1[2].name, 'wc');
});

test('Linux Engine: executes basic commands and pipelines', () => {
  const fs = createDefaultLinuxFs();
  const state = {
    hostname: 'lpi-lab01',
    currentUser: 'student',
    currentGroup: 'student',
    isRootOrAdmin: false,
    umask: 0o022,
    interfaces: [],
    processes: [],
    services: [],
    disks: [],
    adUsers: [],
    adGroups: [],
    gpos: [],
    installedPackages: [],
    systemIntegrityCorrupted: false,
    dismRepaired: false,
    sfcRepaired: false,
    dnsWorking: true,
    gatewayWorking: true,
    firewallBlockedPorts: [],
    diskpartSelectedDisk: null,
    diskpartSelectedPartition: null,
    envVars: {},
  };

  // pwd
  const r1 = executeLinuxLine('pwd', '/home/student', fs, state);
  assert.equal(r1.stdout, '/home/student');
  assert.equal(r1.exitCode, 0);

  // whoami
  const r2 = executeLinuxLine('whoami', '/home/student', fs, state);
  assert.equal(r2.stdout, 'student');

  // chmod 750 and chown
  const r3 = executeLinuxLine('chmod 750 /home/student/notes.txt', '/home/student', fs, state);
  assert.equal(r3.exitCode, 0);
  const noteNode = getNodeAtPath(r3.newFs, '/home/student/notes.txt', false);
  assert.equal(noteNode?.octal, 750);
  assert.equal(noteNode?.permissions, 'rwxr-x---');

  // pipeline: grep and wc
  const r4 = executeLinuxLine('cat /etc/passwd | grep student | wc -l', '/home/student', fs, state);
  assert.equal(r4.stdout.trim(), '1');
});

test('Windows Engine: executes CMD commands and diskpart interactive session', () => {
  const fs = createDefaultWindowsFs();
  const state = {
    hostname: 'WIN-CLIENT01',
    currentUser: 'Administrator',
    currentGroup: 'Administrators',
    isRootOrAdmin: true,
    umask: 0,
    interfaces: [
      {
        name: 'Ethernet0',
        ip: '169.254.82.114',
        netmask: '255.255.0.0',
        mac: '00-50-56-A1-2B-3C',
        gateway: '',
        dns: ['192.168.1.10'],
        dhcpEnabled: true,
        status: 'UP' as const,
      }
    ],
    processes: [
      { pid: 3892, user: 'Student', cpu: 85, mem: 12, command: 'svchost_update.exe', port: 4444, isMalicious: true }
    ],
    services: [
      { name: 'W32Time', displayName: 'Windows Time', status: 'Stopped' as const, startType: 'Automatic' as const }
    ],
    disks: [
      {
        diskNumber: 1,
        totalSizeMB: 256000,
        model: 'SSD',
        status: 'Online' as const,
        partitionTable: 'GPT' as const,
        partitions: [],
      }
    ],
    adUsers: [
      {
        sAMAccountName: 'jdoe',
        givenName: 'John',
        surname: 'Doe',
        displayName: 'John Doe',
        email: 'jdoe@corp.local',
        department: 'Marketing',
        ou: 'OU=Marketing,DC=corp,DC=local',
        enabled: true,
        locked: true,
        passwordNeverExpires: false,
        memberOf: ['Domain Users'],
      }
    ],
    adGroups: [
      {
        name: 'Domain Admins',
        scope: 'Global' as const,
        category: 'Security' as const,
        ou: 'OU=IT_Admins,DC=corp,DC=local',
        description: 'Admins',
        members: [],
      }
    ],
    gpos: [],
    installedPackages: [],
    systemIntegrityCorrupted: true,
    dismRepaired: false,
    sfcRepaired: false,
    dnsWorking: false,
    gatewayWorking: false,
    firewallBlockedPorts: [],
    diskpartSelectedDisk: null,
    diskpartSelectedPartition: null,
    envVars: {},
  };

  // ipconfig /renew
  const r1 = executeWindowsLine('ipconfig /renew', 'C:\\Users\\Student', fs, state, 'cmd');
  assert.ok(r1.newState.interfaces[0].ip.startsWith('192.168.1.'));
  assert.equal(r1.newState.gatewayWorking, true);

  // taskkill
  const r2 = executeWindowsLine('taskkill /F /PID 3892', 'C:\\Users\\Student', fs, state, 'cmd');
  assert.equal(r2.exitCode, 0);
  assert.equal(r2.newState.processes.some(p => p.pid === 3892), false);

  // diskpart sub-shell
  const dStart = executeWindowsLine('diskpart', 'C:\\Users\\Student', fs, state, 'cmd');
  assert.equal(dStart.diskpartActive, true);

  const dSel = executeWindowsLine('select disk 1', 'C:\\Users\\Student', fs, dStart.newState, 'cmd', true);
  assert.equal(dSel.newState.diskpartSelectedDisk, 1);

  const dPart = executeWindowsLine('create partition primary', 'C:\\Users\\Student', fs, dSel.newState, 'cmd', true);
  assert.equal(dPart.exitCode, 0);

  const dFmt = executeWindowsLine('format fs=ntfs quick', 'C:\\Users\\Student', fs, dPart.newState, 'cmd', true);
  assert.equal(dFmt.exitCode, 0);

  const dAssign = executeWindowsLine('assign letter=E', 'C:\\Users\\Student', fs, dFmt.newState, 'cmd', true);
  assert.equal(dAssign.exitCode, 0);
  const part = dAssign.newState.disks[0].partitions[0];
  assert.equal(part.fsType, 'NTFS');
  assert.equal(part.driveLetter, 'E:');

  // PowerShell Unlock-ADAccount
  const psUnlock = executeWindowsLine('Unlock-ADAccount -Identity jdoe', 'C:\\Users\\Student', fs, state, 'powershell');
  assert.equal(psUnlock.newState.adUsers[0].locked, false);
});

test('Exam Objectives: LPI and CompTIA modules have valid objectives and verifiers', () => {
  assert.ok(LPI_MODULES.length >= 5);
  assert.ok(WINDOWS_PBQS.length >= 5);

  for (const m of LPI_MODULES) {
    assert.ok(m.objectives.length >= 2, `Module ${m.id} should have at least 2 objectives`);
    assert.ok(m.solutionWalkthrough.length >= 2, `Module ${m.id} should have solution steps`);
  }

  for (const pbq of WINDOWS_PBQS) {
    assert.ok(pbq.objectives.length >= 2, `PBQ ${pbq.id} should have at least 2 objectives`);
    assert.ok(pbq.solutionWalkthrough.length >= 2, `PBQ ${pbq.id} should have solution steps`);
  }
});

test('Linux Engine: enforces POSIX permissions and sudo elevation', () => {
  const fs = createDefaultLinuxFs();
  const state = {
    hostname: 'lpi-lab01',
    currentUser: 'student',
    currentGroup: 'student',
    isRootOrAdmin: false,
    umask: 0o022,
    interfaces: [],
    processes: [],
    services: [],
    disks: [],
    adUsers: [],
    adGroups: [],
    gpos: [],
    installedPackages: [],
    systemIntegrityCorrupted: false,
    dismRepaired: false,
    sfcRepaired: false,
    dnsWorking: true,
    gatewayWorking: true,
    firewallBlockedPorts: [],
    diskpartSelectedDisk: null,
    diskpartSelectedPartition: null,
    envVars: {},
  };

  // Student cannot delete /etc
  const r1 = executeLinuxLine('rm -rf /etc', '/home/student', fs, state);
  assert.equal(r1.exitCode, 1);
  assert.match(r1.stderr, /Permission denied/);
  assert.ok(getNodeAtPath(r1.newFs, '/etc', false) !== null, '/etc should not have been deleted');

  // Student cannot write into /root
  const r2 = executeLinuxLine('touch /root/hacked.txt', '/home/student', fs, state);
  assert.equal(r2.exitCode, 1);
  assert.match(r2.stderr, /Permission denied/);

  // Student cannot cd into /root (mode 700 owned by root)
  const r3 = executeLinuxLine('cd /root', '/home/student', fs, state);
  assert.equal(r3.exitCode, 1);
  assert.match(r3.stderr, /Permission denied/);

  // Student cannot read /etc/shadow
  const r4 = executeLinuxLine('cat /etc/shadow', '/home/student', fs, state);
  assert.equal(r4.exitCode, 1);
  assert.match(r4.stderr, /Permission denied/);

  // Student cannot chmod root files
  const r5 = executeLinuxLine('chmod 777 /etc/passwd', '/home/student', fs, state);
  assert.equal(r5.exitCode, 1);
  assert.match(r5.stderr, /Operation not permitted/);

  // Student cannot chown
  const r6 = executeLinuxLine('chown root:root /home/student/notes.txt', '/home/student', fs, state);
  assert.equal(r6.exitCode, 1);
  assert.match(r6.stderr, /Operation not permitted/);

  // Student CAN chmod own files
  const r7 = executeLinuxLine('chmod 600 /home/student/notes.txt', '/home/student', fs, state);
  assert.equal(r7.exitCode, 0);
  const noteNode = getNodeAtPath(r7.newFs, '/home/student/notes.txt', false);
  assert.equal(noteNode?.permissions, 'rw-------');

  // sudo allows root operations
  const r8 = executeLinuxLine('sudo cat /etc/shadow', '/home/student', fs, state);
  assert.equal(r8.exitCode, 0);
  assert.match(r8.stdout, /root:\$6\$/);

  // sudo allows chown
  const r9 = executeLinuxLine('sudo chown root:finance /home/student/notes.txt', '/home/student', fs, state);
  assert.equal(r9.exitCode, 0);
  const chowned = getNodeAtPath(r9.newFs, '/home/student/notes.txt', false);
  assert.equal(chowned?.owner, 'root');
  assert.equal(chowned?.group, 'finance');

  // su switches to root and exit switches back
  const rSu = executeLinuxLine('su', '/home/student', fs, state);
  assert.equal(rSu.newState.currentUser, 'root');
  assert.equal(rSu.newState.isRootOrAdmin, true);

  const rExit = executeLinuxLine('exit', '/home/student', fs, rSu.newState);
  assert.equal(rExit.newState.currentUser, 'student');
  assert.equal(rExit.newState.isRootOrAdmin, false);
});

test('Shell Parser & Engine: handles quote safety, operators (&&, ||, ;), and grep pipeline', () => {
  const fs = createDefaultLinuxFs();
  const state = {
    hostname: 'lpi-lab01',
    currentUser: 'student',
    currentGroup: 'student',
    isRootOrAdmin: false,
    umask: 0o022,
    interfaces: [],
    processes: [],
    services: [],
    disks: [],
    adUsers: [],
    adGroups: [],
    gpos: [],
    installedPackages: [],
    systemIntegrityCorrupted: false,
    dismRepaired: false,
    sfcRepaired: false,
    dnsWorking: true,
    gatewayWorking: true,
    firewallBlockedPorts: [],
    diskpartSelectedDisk: null,
    diskpartSelectedPartition: null,
    envVars: {},
  };

  // echo "a > b" does not redirect
  const rQuoteRedirect = executeLinuxLine('echo "a > b"', '/home/student', fs, state);
  assert.equal(rQuoteRedirect.stdout, 'a > b');
  assert.equal(rQuoteRedirect.exitCode, 0);

  // echo "x && y" does not split
  const rQuoteAnd = executeLinuxLine('echo "x && y"', '/home/student', fs, state);
  assert.equal(rQuoteAnd.stdout, 'x && y');
  assert.equal(rQuoteAnd.exitCode, 0);

  // grep with no match returns empty output and exit code 1 without artificial failure message
  const rGrepMiss = executeLinuxLine('grep nonexisting /etc/passwd', '/home/student', fs, state);
  assert.equal(rGrepMiss.stdout, '');
  assert.equal(rGrepMiss.stderr, '');
  assert.equal(rGrepMiss.exitCode, 1);

  // grep with no match piped to wc -l produces 0
  const rGrepPipe = executeLinuxLine('grep nonexisting /etc/passwd | wc -l', '/home/student', fs, state);
  assert.equal(rGrepPipe.stdout.trim(), '0');

  // Chained operators: && and ||
  const rChainSuccess = executeLinuxLine('echo first && echo second', '/home/student', fs, state);
  assert.equal(rChainSuccess.stdout, 'first\nsecond');

  const rChainOr = executeLinuxLine('grep nonexisting /etc/passwd || echo "fallback message"', '/home/student', fs, state);
  assert.equal(rChainOr.stdout, 'fallback message');

  const rSemicolon = executeLinuxLine('echo step1 ; echo step2', '/home/student', fs, state);
  assert.equal(rSemicolon.stdout, 'step1\nstep2');
});

test('Findings 1 & 2: chmod special bits and symbolic mode resolution', () => {
  // SUID, SGID, Sticky in octal
  const suid = applyChmod('rwxr-xr-x', '4755');
  assert.equal(suid?.sym, 'rwsr-xr-x');
  assert.equal(suid?.octal, 4755);

  const sgid = applyChmod('rwxr-xr-x', '2755');
  assert.equal(sgid?.sym, 'rwxr-sr-x');
  assert.equal(sgid?.octal, 2755);

  const sticky = applyChmod('rwxrwxrwx', '1777');
  assert.equal(sticky?.sym, 'rwxrwxrwt');
  assert.equal(sticky?.octal, 1777);

  const stickyNoExec = applyChmod('rw-rw-rw-', '1666');
  assert.equal(stickyNoExec?.sym, 'rw-rw-rwT');
  assert.equal(stickyNoExec?.octal, 1666);

  // Symbolic modes
  assert.equal(applyChmod('rw-r--r--', 'u+x')?.sym, 'rwxr--r--');
  assert.equal(applyChmod('rwxrwxrwx', 'g-w')?.sym, 'rwxr-xrwx');
  assert.equal(applyChmod('rwxrwxrwx', 'o=r')?.sym, 'rwxrwxr--');
  assert.equal(applyChmod('rwxr-xr-x', 'u+s')?.sym, 'rwsr-xr-x');
  assert.equal(applyChmod('rwsr-xr-x', 'u-s')?.sym, 'rwxr-xr-x');
  assert.equal(applyChmod('rwxrwxrwx', '+t')?.sym, 'rwxrwxrwt');
  assert.equal(applyChmod('rw-rw-rw-', 'a+x')?.sym, 'rwxrwxrwx');
  assert.equal(applyChmod('rw-r--r--', 'u+x,g-r,o-rx')?.sym, 'rwx------');

  // Verify inside Linux engine
  const fs = createDefaultLinuxFs();
  const state = {
    hostname: 'lpi-lab01',
    currentUser: 'student',
    currentGroup: 'student',
    isRootOrAdmin: false,
    umask: 0o022,
    interfaces: [],
    processes: [],
    services: [],
    disks: [],
    adUsers: [],
    adGroups: [],
    gpos: [],
    installedPackages: [],
    systemIntegrityCorrupted: false,
    dismRepaired: false,
    sfcRepaired: false,
    dnsWorking: true,
    gatewayWorking: true,
    firewallBlockedPorts: [],
    diskpartSelectedDisk: null,
    diskpartSelectedPartition: null,
    envVars: {},
  };

  createNode(fs, '/home/student/myscript.sh', 'file', '#!/bin/bash', false, 'student', 'student', 755);
  const rChmod = executeLinuxLine('chmod 4755 myscript.sh', '/home/student', fs, state);
  assert.equal(rChmod.exitCode, 0);
  const node = getNodeAtPath(rChmod.newFs, '/home/student/myscript.sh', false);
  assert.equal(node?.permissions, 'rwsr-xr-x');
  assert.equal(node?.octal, 4755);
});

test('Finding 3: Sudo redirection trap vs sudo tee', () => {
  const fs = createDefaultLinuxFs();
  const state = {
    hostname: 'lpi-lab01',
    currentUser: 'student',
    currentGroup: 'student',
    isRootOrAdmin: false,
    umask: 0o022,
    interfaces: [],
    processes: [],
    services: [],
    disks: [],
    adUsers: [],
    adGroups: [],
    gpos: [],
    installedPackages: [],
    systemIntegrityCorrupted: false,
    dismRepaired: false,
    sfcRepaired: false,
    dnsWorking: true,
    gatewayWorking: true,
    firewallBlockedPorts: [],
    diskpartSelectedDisk: null,
    diskpartSelectedPartition: null,
    envVars: {},
  };

  // sudo echo hi > /root/test.txt should fail because shell opens redirect as student
  const rTrap = executeLinuxLine('sudo echo hi > /root/trap.txt', '/home/student', fs, state);
  assert.equal(rTrap.exitCode, 1);
  assert.match(rTrap.stderr, /Permission denied/);
  assert.equal(getNodeAtPath(rTrap.newFs, '/root/trap.txt', false), null);

  // echo hi | sudo tee /root/safe.txt succeeds and creates file as root
  const rTee = executeLinuxLine('echo hi | sudo tee /root/safe.txt', '/home/student', fs, state);
  assert.equal(rTee.exitCode, 0);
  assert.equal(rTee.stdout.trim(), 'hi');
  const safeNode = getNodeAtPath(rTee.newFs, '/root/safe.txt', false);
  assert.ok(safeNode);
  assert.equal(safeNode.content, 'hi');
  assert.equal(safeNode.owner, 'root');
});

test('Finding 4: Stderr redirection parsing and execution', () => {
  // Parser check: quoted 2> remains untouched
  const extQuoted = extractStderrRedirect('echo "2> x"');
  assert.equal(extQuoted.body, 'echo "2> x"');
  assert.equal(extQuoted.stderr, undefined);

  // Parser check: 2> err.txt extracted
  const extNormal = extractStderrRedirect('cat /nope 2> err.txt');
  assert.equal(extNormal.body, 'cat /nope');
  assert.deepEqual(extNormal.stderr, { type: '>', target: 'err.txt' });

  // Parser check: 2>&1 merge
  const extMerge = extractStderrRedirect('ls /nope 2>&1');
  assert.equal(extMerge.body, 'ls /nope');
  assert.deepEqual(extMerge.stderr, { type: 'merge' });

  const fs = createDefaultLinuxFs();
  const state = {
    hostname: 'lpi-lab01',
    currentUser: 'student',
    currentGroup: 'student',
    isRootOrAdmin: false,
    umask: 0o022,
    interfaces: [],
    processes: [],
    services: [],
    disks: [],
    adUsers: [],
    adGroups: [],
    gpos: [],
    installedPackages: [],
    systemIntegrityCorrupted: false,
    dismRepaired: false,
    sfcRepaired: false,
    dnsWorking: true,
    gatewayWorking: true,
    firewallBlockedPorts: [],
    diskpartSelectedDisk: null,
    diskpartSelectedPartition: null,
    envVars: {},
  };

  // cat nonexisting 2> /dev/null suppresses stderr
  const rDevNull = executeLinuxLine('cat nonexisting 2>/dev/null', '/home/student', fs, state);
  assert.equal(rDevNull.stderr, '');

  // cat nonexisting 2>&1 puts error in stdout
  const rMerged = executeLinuxLine('cat nonexisting 2>&1', '/home/student', fs, state);
  assert.match(rMerged.stdout, /cat: nonexisting: No such file or directory/);
  assert.equal(rMerged.stderr, '');

  // cat nonexisting 2> err.txt writes stderr to file
  const rErrFile = executeLinuxLine('cat nonexisting 2> err.txt', '/home/student', fs, state);
  assert.equal(rErrFile.stderr, '');
  const errNode = getNodeAtPath(rErrFile.newFs, '/home/student/err.txt', false);
  assert.ok(errNode);
  assert.match(errNode.content || '', /No such file or directory/);
});

test('Finding 5: mkdir -p and existing directories', () => {
  const fs = createDefaultLinuxFs();
  const state = {
    hostname: 'lpi-lab01',
    currentUser: 'student',
    currentGroup: 'student',
    isRootOrAdmin: false,
    umask: 0o022,
    interfaces: [],
    processes: [],
    services: [],
    disks: [],
    adUsers: [],
    adGroups: [],
    gpos: [],
    installedPackages: [],
    systemIntegrityCorrupted: false,
    dismRepaired: false,
    sfcRepaired: false,
    dnsWorking: true,
    gatewayWorking: true,
    firewallBlockedPorts: [],
    diskpartSelectedDisk: null,
    diskpartSelectedPartition: null,
    envVars: {},
  };

  // mkdir -p a/b/c creates deep path
  const rParents = executeLinuxLine('mkdir -p a/b/c', '/home/student', fs, state);
  assert.equal(rParents.exitCode, 0);
  assert.ok(getNodeAtPath(rParents.newFs, '/home/student/a/b/c', false));

  // mkdir single directory
  const rOnce = executeLinuxLine('mkdir single', '/home/student', rParents.newFs, state);
  assert.equal(rOnce.exitCode, 0);

  // mkdir again without -p fails with File exists
  const rTwice = executeLinuxLine('mkdir single', '/home/student', rOnce.newFs, state);
  assert.equal(rTwice.exitCode, 1);
  assert.match(rTwice.stderr, /File exists/);

  // mkdir with -p on existing directory succeeds silently
  const rExistP = executeLinuxLine('mkdir -p single', '/home/student', rOnce.newFs, state);
  assert.equal(rExistP.exitCode, 0);
  assert.equal(rExistP.stderr, '');
});

test('Finding 6: Chained command errors are preserved', () => {
  const fs = createDefaultLinuxFs();
  const state = {
    hostname: 'lpi-lab01',
    currentUser: 'student',
    currentGroup: 'student',
    isRootOrAdmin: false,
    umask: 0o022,
    interfaces: [],
    processes: [],
    services: [],
    disks: [],
    adUsers: [],
    adGroups: [],
    gpos: [],
    installedPackages: [],
    systemIntegrityCorrupted: false,
    dismRepaired: false,
    sfcRepaired: false,
    dnsWorking: true,
    gatewayWorking: true,
    firewallBlockedPorts: [],
    diskpartSelectedDisk: null,
    diskpartSelectedPartition: null,
    envVars: {},
  };

  const rChain = executeLinuxLine('cat /does_not_exist ; echo after', '/home/student', fs, state);
  assert.equal(rChain.stdout.trim(), 'after');
  assert.match(rChain.stderr, /No such file or directory/);
});

test('Finding 7: CMD chaining & and CMD pipes to findstr', () => {
  const fs = createDefaultWindowsFs();
  const state = {
    hostname: 'WIN-CLIENT01',
    currentUser: 'Student',
    currentGroup: 'Users',
    isRootOrAdmin: false,
    umask: 0o022,
    interfaces: [],
    processes: [],
    services: [],
    disks: [],
    adUsers: [],
    adGroups: [],
    gpos: [],
    installedPackages: [],
    systemIntegrityCorrupted: false,
    dismRepaired: false,
    sfcRepaired: false,
    dnsWorking: true,
    gatewayWorking: true,
    firewallBlockedPorts: [],
    diskpartSelectedDisk: null,
    diskpartSelectedPartition: null,
    envVars: {},
  };

  // CMD chaining with single &
  const rChain = executeWindowsLine('echo hello & echo world', 'C:\\Users\\Student', fs, state, 'cmd');
  assert.equal(rChain.stdout.trim(), 'hello\nworld');

  // CMD piping: ipconfig | findstr IPv4
  const rPipe = executeWindowsLine('ipconfig | findstr IPv4', 'C:\\Users\\Student', fs, state, 'cmd');
  assert.equal(rPipe.exitCode, 0);
  assert.match(rPipe.stdout, /IPv4 Address/);

  // findstr /i and /v
  const rFindstrI = executeWindowsLine('echo Hello World | findstr /i world', 'C:\\Users\\Student', fs, state, 'cmd');
  assert.equal(rFindstrI.exitCode, 0);
  assert.match(rFindstrI.stdout, /Hello World/);

  const rFindstrV = executeWindowsLine('echo Hello World | findstr /v Hello', 'C:\\Users\\Student', fs, state, 'cmd');
  assert.equal(rFindstrV.exitCode, 1);
  assert.equal(rFindstrV.stdout.trim(), '');
});

test('Finding 8: rm and directory safety checks', () => {
  const fs = createDefaultLinuxFs();
  const state = {
    hostname: 'lpi-lab01',
    currentUser: 'student',
    currentGroup: 'student',
    isRootOrAdmin: false,
    umask: 0o022,
    interfaces: [],
    processes: [],
    services: [],
    disks: [],
    adUsers: [],
    adGroups: [],
    gpos: [],
    installedPackages: [],
    systemIntegrityCorrupted: false,
    dismRepaired: false,
    sfcRepaired: false,
    dnsWorking: true,
    gatewayWorking: true,
    firewallBlockedPorts: [],
    diskpartSelectedDisk: null,
    diskpartSelectedPartition: null,
    envVars: {},
  };

  createNode(fs, '/home/student/myfolder', 'directory', '', false, 'student', 'student', 755);

  // rm on directory without -r fails with "Is a directory"
  const rNoRec = executeLinuxLine('rm myfolder', '/home/student', fs, state);
  assert.equal(rNoRec.exitCode, 1);
  assert.match(rNoRec.stderr, /Is a directory/);
  assert.ok(getNodeAtPath(rNoRec.newFs, '/home/student/myfolder', false));

  // rm -r on directory succeeds
  const rRec = executeLinuxLine('rm -r myfolder', '/home/student', fs, state);
  assert.equal(rRec.exitCode, 0);
  assert.equal(getNodeAtPath(rRec.newFs, '/home/student/myfolder', false), null);

  // rm -f on non-existent file exits 0 silently
  const rForce = executeLinuxLine('rm -f does_not_exist', '/home/student', fs, state);
  assert.equal(rForce.exitCode, 0);
  assert.equal(rForce.stderr, '');
});

test('Finding 9: Supplementary groups from /etc/group', () => {
  const fs = createDefaultLinuxFs();
  const groups = getUserGroups(fs, 'student', 'student');
  assert.ok(groups.includes('student'));
  assert.ok(groups.includes('sudo'));

  const state = {
    hostname: 'lpi-lab01',
    currentUser: 'student',
    currentGroup: 'student',
    isRootOrAdmin: false,
    umask: 0o022,
    interfaces: [],
    processes: [],
    services: [],
    disks: [],
    adUsers: [],
    adGroups: [],
    gpos: [],
    installedPackages: [],
    systemIntegrityCorrupted: false,
    dismRepaired: false,
    sfcRepaired: false,
    dnsWorking: true,
    gatewayWorking: true,
    firewallBlockedPorts: [],
    diskpartSelectedDisk: null,
    diskpartSelectedPartition: null,
    envVars: {},
  };

  // Add student to developers in /etc/group (e.g. simulated usermod -aG developers student)
  const grpNode = getNodeAtPath(fs, '/etc/group', false);
  if (grpNode && grpNode.content) {
    grpNode.content = grpNode.content.replace('developers:x:1003:', 'developers:x:1003:student');
  }

  const updatedGroups = getUserGroups(fs, 'student', 'student');
  assert.ok(updatedGroups.includes('developers'));

  // Create file owned by developers with mode 060 (only group can read/write)
  createNode(fs, '/home/student/dev.txt', 'file', 'developer secret', false, 'otheruser', 'developers', 0o060);
  const rRead = executeLinuxLine('cat dev.txt', '/home/student', fs, state);
  assert.equal(rRead.exitCode, 0);
  assert.equal(rRead.stdout.trim(), 'developer secret');
});

test('Finding 10: Windows redirect files mode', () => {
  const fs = createDefaultWindowsFs();
  const state = {
    hostname: 'WIN-CLIENT01',
    currentUser: 'Student',
    currentGroup: 'Users',
    isRootOrAdmin: false,
    umask: 0o022,
    interfaces: [],
    processes: [],
    services: [],
    disks: [],
    adUsers: [],
    adGroups: [],
    gpos: [],
    installedPackages: [],
    systemIntegrityCorrupted: false,
    dismRepaired: false,
    sfcRepaired: false,
    dnsWorking: true,
    gatewayWorking: true,
    firewallBlockedPorts: [],
    diskpartSelectedDisk: null,
    diskpartSelectedPartition: null,
    envVars: {},
  };

  const rRedirect = executeWindowsLine('echo test > out.txt', 'C:\\Users\\Student', fs, state, 'cmd');
  assert.equal(rRedirect.exitCode, 0);
  const node = getNodeAtPath(rRedirect.newFs, 'C:\\Users\\Student\\out.txt', true);
  assert.ok(node);
  assert.equal(node.octal, 644);
});


test('Walkthrough replay: every module can be completed by following its own solution steps', () => {
  for (const m of [...LPI_MODULES, ...WINDOWS_PBQS]) {
    let fs = m.initialFs;
    let state = m.initialState;
    let cwd = m.track === 'lpi' ? '/home/student' : 'C:\\Users\\Student';
    let diskpartActive = false;
    const done = new Set<string>();

    const lines = m.solutionWalkthrough.flatMap(step => step.command.split('\n'));
    for (const line of lines) {
      let ctx: CommandContext;
      if (m.defaultShell === 'bash') {
        const res = executeLinuxLine(line, cwd, fs, state);
        ({ newFs: fs, newState: state, newCwd: cwd } = res);
        ctx = { command: line, exitCode: res.exitCode, stdout: res.stdout };
      } else {
        const res = executeWindowsLine(line, cwd, fs, state, m.defaultShell, diskpartActive);
        ({ newFs: fs, newState: state, newCwd: cwd } = res);
        diskpartActive = !!res.diskpartActive;
        ctx = { command: line, exitCode: res.exitCode, stdout: res.stdout };
      }
      for (const o of m.objectives) {
        if (!done.has(o.id) && o.verifier(fs, state, ctx)) done.add(o.id);
      }
    }

    const missing = m.objectives.filter(o => !done.has(o.id)).map(o => o.id);
    assert.deepEqual(missing, [], `${m.id} cannot be completed by its walkthrough`);
  }
});

// Regression tests for the final review findings
function studentSession() {
  const fs = structuredClone(LPI_MODULES[0].initialFs);
  const state = { ...LPI_MODULES[0].initialState, currentUser: 'student', currentGroup: 'student', isRootOrAdmin: false };
  let cwd = '/home/student';
  let current = { fs, state };
  return (line: string) => {
    const res = executeLinuxLine(line, cwd, current.fs, current.state);
    current = { fs: res.newFs, state: res.newState };
    cwd = res.newCwd;
    return res;
  };
}

test('Review 1: ls -ld lists the directory itself', () => {
  const run = studentSession();
  const res = run('ls -ld /home/student/finance');
  assert.ok(res.stdout.includes('finance'));
  assert.ok(!res.stdout.includes('q3_payroll.csv'));
  assert.ok(res.stdout.startsWith('d'));
});

test('Review 2: chmod -R validates the mode first and skips files you do not own', () => {
  const run = studentSession();
  run('mkdir d');
  run('sudo touch d/rootfile');
  run('touch d/mine');
  const res = run('chmod -R 700 d');
  assert.ok(!res.stderr.includes('invalid mode'));
  assert.ok(res.stderr.includes("d/rootfile': Operation not permitted"));
  assert.equal(res.exitCode, 1);
  assert.ok(run('ls -l d').stdout.includes('rwx------'));
  assert.ok(run('chmod -R 9z9 d').stderr.includes('invalid mode'));
});

test('Review 3: tar reads mode letters from flags, not file names', () => {
  const run = studentSession();
  run('echo hi > notes.txt');
  assert.equal(run('tar -czf backup.tar.gz notes.txt').exitCode, 0);
  assert.ok(run('tar -tf backup.tar.gz').stdout.includes('notes.txt'));
  assert.ok(run('tar -tvf backup.tar.gz').stdout.includes('notes.txt'));
  assert.ok(run('cat backup.tar.gz').stdout.includes('notes.txt'));
  assert.equal(run('tar czvf b2.tgz notes.txt').exitCode, 0);
  assert.ok(run('tar tf b2.tgz').stdout.includes('notes.txt'));
  assert.ok(run('tar -c -f b3.tar notes.txt').exitCode === 0);
  assert.ok(run('tar -xzvf backup.tar.gz').exitCode === 0);
  assert.ok(run('cat backup.tar.gz').stdout.includes('notes.txt'));
});

test('Review 4: usermod rejects users that do not exist', () => {
  const run = studentSession();
  const res = run('sudo usermod -aG finance ghost');
  assert.equal(res.exitCode, 6);
  assert.ok(res.stderr.includes("user 'ghost' does not exist"));
  assert.ok(!run('cat /etc/group').stdout.includes('ghost'));
});

test('Review 5: id prints real group numbers', () => {
  const run = studentSession();
  run('sudo usermod -aG developers student');
  const out = run('id').stdout;
  assert.ok(out.includes('4(adm)'));
  assert.ok(out.includes('1003(developers)'));
  assert.ok(!out.includes('1001(adm)'));
});

test('Review 5: CMD does not split 2>&1 into a second command', () => {
  const stages = splitChainedCommandLine('dir nope 2>&1', 'cmd');
  assert.equal(stages.length, 1);
  assert.equal(splitChainedCommandLine('echo a & echo b', 'cmd').length, 2);
});

test('Review 8: ls -l on a file you cannot read shows its details', () => {
  const run = studentSession();
  const res = run('ls -l /etc/shadow');
  assert.equal(res.exitCode, 0);
  assert.ok(res.stdout.includes('shadow'));
  assert.ok(run('ls /root').stderr.includes('Permission denied'));
});

// Engine test suites split by area (run through this entry point, see package.json "test")
import './engineState.test.ts';
import './explanations.test.ts';
import './textTools.test.ts';
import './linuxCommands.test.ts';
import './windowsCommands.test.ts';
import '../data/paths.test.ts';
import '../lib/journey.test.ts';
