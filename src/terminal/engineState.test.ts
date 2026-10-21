import test from 'node:test';
import assert from 'node:assert/strict';
import { executeLinuxLine } from './linuxEngine.ts';
import { executeWindowsLine } from './windowsEngine.ts';
import { getNodeAtPath } from './filesystem.ts';
import { LPI_MODULES } from '../data/lpiModules.ts';
import { WINDOWS_PBQS } from '../data/windowsPbqs.ts';
import { linuxSession } from './testUtils.ts';

test('Engines never mutate the fs or state objects they are given', () => {
  const pbq = WINDOWS_PBQS[0];
  const before = JSON.stringify([pbq.initialFs, pbq.initialState]);
  const cwd = 'C:\\Users\\Student';
  executeWindowsLine('Start-Service W32Time', cwd, pbq.initialFs, pbq.initialState, 'powershell');
  executeWindowsLine('New-ADUser -SamAccountName zed -Name "Zed Z"', cwd, pbq.initialFs, pbq.initialState, 'powershell');
  executeWindowsLine('Add-ADGroupMember -Identity "Domain Admins" -Members jdoe', cwd, pbq.initialFs, pbq.initialState, 'powershell');
  executeWindowsLine('net user bob P@ss1 /add', cwd, pbq.initialFs, pbq.initialState, 'cmd');
  executeWindowsLine('echo x > C:\\Logs\\CBS.log', cwd, pbq.initialFs, pbq.initialState, 'cmd');
  const sel = executeWindowsLine('select disk 1', cwd, pbq.initialFs, pbq.initialState, 'cmd', true);
  executeWindowsLine('create partition primary', cwd, pbq.initialFs, sel.newState, 'cmd', true);
  executeWindowsLine('format fs=ntfs quick', cwd, pbq.initialFs, sel.newState, 'cmd', true);
  assert.equal(JSON.stringify([pbq.initialFs, pbq.initialState]), before);
  assert.equal(sel.newState.disks[1].partitions.length, 1, 'a later command must not edit an earlier result');

  const lab = LPI_MODULES[0];
  const lBefore = JSON.stringify([lab.initialFs, lab.initialState]);
  const home = '/home/student';
  for (const line of ['kill 2100', 'umask 077', 'sudo usermod -aG finance student', 'echo x >> notes.txt', 'sudo chmod 700 /etc', 'su']) {
    executeLinuxLine(line, home, lab.initialFs, lab.initialState);
  }
  assert.equal(JSON.stringify([lab.initialFs, lab.initialState]), lBefore);
});

test('umask prints in octal, accepts -S and symbolic modes, and applies to new files', () => {
  const run = linuxSession();
  assert.equal(run('umask').stdout, '0022');
  assert.equal(run('umask -S').stdout, 'u=rwx,g=rx,o=rx');
  assert.equal(run('umask 027').exitCode, 0);
  assert.equal(run('umask').stdout, '0027');
  assert.equal(run.state().umask, 0o027);
  assert.equal(run('umask -S').stdout, 'u=rwx,g=rx,o=');

  run('mkdir newdir');
  run('touch newfile');
  run('echo hi > redirected');
  run('echo hi | tee teed');
  const mode = (p: string) => getNodeAtPath(run.fs(), `/home/student/${p}`, false)?.permissions;
  assert.equal(mode('newdir'), 'rwxr-x---');
  assert.equal(mode('newfile'), 'rw-r-----');
  assert.equal(mode('redirected'), 'rw-r-----');
  assert.equal(mode('teed'), 'rw-r-----');

  const bad = run('umask 999');
  assert.equal(bad.exitCode, 1);
  assert.match(bad.stderr, /octal number out of range/);
  assert.equal(run('umask u=rwx,g=rx,o=').exitCode, 0);
  assert.equal(run('umask').stdout, '0027');
  assert.equal(run('umask 0077').exitCode, 0);
  assert.equal(run('umask').stdout, '0077');
});

test('ls -l and dir report sizes that follow the content', () => {
  const run = linuxSession();
  run('echo hello > s.txt');
  assert.match(run('ls -l s.txt').stdout, / 5 Oct/);
  run('echo world >> s.txt');
  assert.match(run('ls -l s.txt').stdout, / 11 Oct/);

  const pbq = WINDOWS_PBQS[0];
  const res = executeWindowsLine('dir Desktop', 'C:\\Users\\Student', pbq.initialFs, pbq.initialState, 'cmd');
  const size = pbq.initialFs.children!.Users.children!.Student.children!.Desktop.children!['TroubleTicket.txt'].content!.length;
  assert.ok(res.stdout.includes(`${size.toLocaleString()} TroubleTicket.txt`));
});

test('/etc/resolv.conf exists at its real path', () => {
  const run = linuxSession();
  const res = run('cat /etc/resolv.conf');
  assert.equal(res.exitCode, 0);
  assert.match(res.stdout, /nameserver 192\.168\.1\.1/);
  assert.ok(run('ls /etc').stdout.includes('resolv.conf'));
});
