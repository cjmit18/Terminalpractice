import test from 'node:test';
import assert from 'node:assert/strict';
import { 
  octalToSymbolic, 
  symbolicToOctal, 
  normalizePath, 
  createDefaultLinuxFs, 
  createDefaultWindowsFs, 
  getNodeAtPath, 
  createNode 
} from './filesystem.ts';
import { parsePipelinedLine, tokenizeArgs } from './parser.ts';
import { executeLinuxLine } from './linuxEngine.ts';
import { executeWindowsLine } from './windowsEngine.ts';
import { LPI_MODULES } from '../data/lpiModules.ts';
import { WINDOWS_PBQS } from '../data/windowsPbqs.ts';

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
