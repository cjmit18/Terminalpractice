import test from 'node:test';
import assert from 'node:assert/strict';
import { windowsSession } from './testUtils.ts';

// Active Directory objects in the Windows simulator: identities (#28, 11).

const field = (out: string, name: string) => out.match(new RegExp(`^${name} +: (.*)$`, 'm'))?.[1];

test('two AD accounts never share a SID or GUID, so a SID names exactly one account (#28, 11)', () => {
  // The issue's case: ab and ba used to get the same RID from the sum of their letters
  const run = windowsSession('powershell');
  run('New-ADUser -SamAccountName ab -Name "A B" -AccountPassword (ConvertTo-SecureString "P@ssw0rd!" -AsPlainText -Force) -Enabled $true');
  run('New-ADUser -SamAccountName ba -Name "B A" -AccountPassword (ConvertTo-SecureString "P@ssw0rd!" -AsPlainText -Force) -Enabled $true');
  const ab = run('Get-ADUser ab').stdout;
  const ba = run('Get-ADUser ba').stdout;
  assert.notEqual(field(ab, 'SID'), field(ba, 'SID'));
  assert.notEqual(field(ab, 'ObjectGUID'), field(ba, 'ObjectGUID'));

  // A command given ba's SID changes ba, not ab
  assert.equal(run(`Disable-ADAccount -Identity ${field(ba, 'SID')}`).exitCode, 0);
  assert.equal(field(run('Get-ADUser ba').stdout, 'Enabled'), 'False');
  assert.equal(field(run('Get-ADUser ab').stdout, 'Enabled'), 'True');
  assert.equal(field(run(`Get-ADUser ${field(ab, 'ObjectGUID')}`).stdout, 'SamAccountName'), 'ab');

  // Every object in the directory has its own SID
  const sids = [...run.state().adUsers, ...run.state().adGroups].map(o => o.rid);
  assert.equal(new Set(sids).size, sids.length);
});

test('built-in accounts have the RIDs Windows gives them, and a deleted account’s RID is not handed out again', () => {
  const run = windowsSession('powershell');
  assert.match(field(run('Get-ADUser administrator').stdout, 'SID')!, /-500$/);
  assert.match(field(run('Get-ADUser jdoe').stdout, 'SID')!, /-1105$/, 'the SID the AD lesson shows');
  assert.match(run('Get-ADGroupMember "Domain Users"').stdout, /SamAccountName +: mscott\nSID +: S-1-5-21-[\d-]+-1106/);

  const cmd = windowsSession('cmd', { currentUser: 'Administrator', currentGroup: 'Administrators', isRootOrAdmin: true });
  assert.equal(cmd('net user carol P@ssw0rd1! /add /domain').exitCode, 0);
  const carol = cmd.state().adUsers.find(u => u.sAMAccountName === 'carol')!.rid;
  cmd('net user carol /delete /domain');
  cmd('net user dave P@ssw0rd1! /add /domain');
  const dave = cmd.state().adUsers.find(u => u.sAMAccountName === 'dave')!.rid;
  assert.ok(carol! > 1106 && dave! > carol!, `carol ${carol}, then dave ${dave}`);
});

test('whoami shows the same SIDs as the directory', () => {
  const run = windowsSession('cmd', { currentUser: 'Administrator', currentGroup: 'Administrators', isRootOrAdmin: true });
  const out = run('whoami /all').stdout;
  assert.match(out, /corp\\administrator +S-1-5-21-3623811015-3361044348-30300820-500/);
  assert.match(out, /CORP\\Domain Admins +Group +S-1-5-21-3623811015-3361044348-30300820-512 /);
  assert.match(out, /CORP\\Enterprise Admins +Group +S-1-5-21-3623811015-3361044348-30300820-519 /);
});
