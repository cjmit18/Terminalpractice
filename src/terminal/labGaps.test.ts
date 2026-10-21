import test from 'node:test';
import assert from 'node:assert/strict';
import { linuxSession, windowsSession } from './testUtils.ts';

// Engine gaps found while writing lessons (DiskPart, AD, counts, filters, accounts ...)

test('DiskPart: free space, RAW partitions, list volume and detail disk', () => {
  const run = windowsSession('cmd');
  run('diskpart');
  const before = run('list disk').stdout;
  assert.match(before, /\n {2}Disk 1 +Online +250 GB +250 GB/);
  assert.match(before, /\n {2}Disk 0 +Online +500 GB +0 B/);
  const vols = run('list volume').stdout;
  assert.match(vols, /^ {2}Volume ### {2}Ltr {2}Label/);
  assert.match(vols, /Volume 0 +C +Windows +NTFS +Partition +499 GB +Healthy +Boot/);

  run('select disk 1');
  assert.equal(run('list partition').stdout, 'There are no partitions on this disk to show.');
  assert.match(run('detail disk').stdout, /^Crucial CT250MX500SSD1\nDisk ID: [\s\S]*Boot Disk {2}: No[\s\S]*There are no volumes\.$/);

  run('create partition primary');
  const disk1 = run.state().disks.find(d => d.diskNumber === 1)!;
  assert.equal(disk1.partitions.length, 1, 'the free-space entry is replaced by the new partition');
  assert.deepEqual([disk1.partitions[0].sizeMB, disk1.partitions[0].fsType, disk1.partitions[0].isPrimary], [256000, 'Unallocated', true]);
  assert.match(run('list disk').stdout, /\* Disk 1 +Online +250 GB +0 B/);
  assert.match(run('list partition').stdout, /\* Partition 1 +Primary +250 GB +1024 KB/);
  assert.match(run('list volume').stdout, /\* Volume 2 +RAW +Partition +250 GB/);
  assert.match(run('create partition primary').stdout, /not enough usable space/);

  run('format fs=ntfs quick label=Data');
  run('assign letter=E');
  assert.match(run('list volume').stdout, /\* Volume 2 +E +Data +NTFS +Partition +250 GB +Healthy/);
  assert.match(run('detail disk').stdout, /Volume 2 +E +Data +NTFS/);
  assert.match(run('select volume c').stdout, /Volume 0 is the selected volume/);
  assert.equal(run.state().diskpartSelectedDisk, 0);
  assert.match(run('detail disk').stdout, /Boot Disk {2}: Yes/);
});

test('DiskPart: create partition primary size= leaves the rest free', () => {
  const run = windowsSession('cmd');
  run('diskpart');
  run('select disk 1');
  run('create partition primary size=102400');
  assert.match(run('list disk').stdout, /\* Disk 1 +Online +250 GB +150 GB/);
  run('create partition primary');
  assert.match(run('list partition').stdout, /Partition 2 +Primary +150 GB +100 GB/);
});

test('Get-ADUser honours -Identity, -Filter and -Properties', () => {
  const run = windowsSession('powershell');
  const one = run('Get-ADUser jdoe');
  assert.equal(one.exitCode, 0);
  assert.match(one.stdout, /SamAccountName +: jdoe/);
  assert.equal((one.stdout.match(/SamAccountName/g) ?? []).length, 1, 'only the requested user');
  assert.doesNotMatch(one.stdout, /LockedOut/, 'extended properties need -Properties');
  assert.equal(run('Get-ADUser -Identity jdoe').stdout, one.stdout);
  const props = run('Get-ADUser -Identity jdoe -Properties LockedOut,MemberOf').stdout;
  assert.match(props, /LockedOut +: (True|False)/);
  assert.match(props, /MemberOf +: \{CN=/);
  assert.match(run('Get-ADUser jdoe -Properties *').stdout, /EmailAddress +: jdoe@corp\.local/);
  const missing = run('Get-ADUser nobody');
  assert.equal(missing.exitCode, 1);
  assert.match(missing.stderr, /Cannot find an object with identity: 'nobody' under: 'DC=corp,DC=local'\./);
  const all = run('Get-ADUser -Filter *').stdout;
  assert.equal((all.match(/SamAccountName/g) ?? []).length, run.state().adUsers.length);
  assert.match(run("Get-ADUser -Filter 'SamAccountName -eq \"jdoe\"'").stdout, /SamAccountName +: jdoe/);
});

test('ping counts: Linux -c and Windows -n', () => {
  const linux = linuxSession();
  const l = linux('ping -c 3 8.8.8.8');
  assert.match(l.stdout, /^PING 8\.8\.8\.8 \(8\.8\.8\.8\) 56\(84\) bytes of data\./);
  assert.equal((l.stdout.match(/icmp_seq=/g) ?? []).length, 3);
  assert.match(l.stdout, /3 packets transmitted, 3 received/);
  assert.match(linux('ping -c 1 localhost').stdout, /1 packets transmitted/);
  assert.match(linux('ping').stderr, /Destination address required/);

  const win = windowsSession('cmd');
  win('ipconfig /renew');
  const w = win('ping -n 2 8.8.8.8');
  assert.equal((w.stdout.match(/Reply from/g) ?? []).length, 2);
  assert.match(w.stdout, /Sent = 2, Received = 2, Lost = 0/);
  assert.match(win('ping /n 1 -l 64 8.8.8.8').stdout, /with 64 bytes of data:\nReply from 8\.8\.8\.8: bytes=64/);
  assert.equal((win('ping 8.8.8.8').stdout.match(/Reply from/g) ?? []).length, 4);
});

test('tasklist /FI filters and /FO formats', () => {
  const run = windowsSession('cmd');
  const pid = run('tasklist /FI "PID eq 3892"').stdout;
  assert.match(pid, /svchost_update\.exe +3892/);
  assert.equal(pid.split('\n').filter(l => /\.exe/.test(l)).length, 1);
  const image = run('tasklist /FI "IMAGENAME eq svchost.exe"').stdout;
  assert.match(image, /^svchost\.exe +844/m);
  assert.doesNotMatch(image, /svchost_update/);
  assert.match(run('tasklist /FI "IMAGENAME eq svchost*"').stdout, /svchost_update/);
  assert.equal(run('tasklist /FI "PID eq 99999"').stdout, 'INFO: No tasks are running which match the specified criteria.');
  assert.equal(run('tasklist /FI "NOPE eq 1"').stderr, 'ERROR: The search filter cannot be recognized.');
  assert.match(run('tasklist /FI "PID eq 3892" /FO CSV /NH').stdout, /^"svchost_update\.exe","3892","Console","1","[\d,]+ K"$/);
  assert.match(run('tasklist /FO LIST /FI "PID eq 4"').stdout, /Image Name: +System\nPID: +4/);
});

test('net user, net localgroup, net start and net stop', () => {
  const run = windowsSession('cmd');
  assert.match(run('net user').stdout, /^User accounts for \\\\WIN-CLIENT01\n\n-+\nAdministrator +DefaultAccount +Guest\nStudent/);
  const local = run('net user Student').stdout;
  assert.match(local, /^User name +Student\n/);
  assert.match(local, /Account active +Yes/);
  assert.match(local, /Local Group Memberships +\*Administrators/);
  const domainOnly = run('net user jdoe');
  assert.equal(domainOnly.exitCode, 2);
  assert.match(domainOnly.stderr, /^The user name could not be found\./);
  assert.match(domainOnly.explanation ?? '', /\/domain/);
  const jdoe = run('net user jdoe /domain').stdout;
  assert.match(jdoe, /^The request will be processed at a domain controller/);
  assert.match(jdoe, /Full Name +John Doe/);
  assert.match(jdoe, /Global Group memberships +\*Domain Users/);

  assert.match(run('net localgroup').stdout, /\*Administrators\n\*Backup Operators/);
  assert.match(run('net localgroup administrators').stdout, /^Alias name +administrators\nComment +Administrators have complete[\s\S]*Members\n\n-+\nAdministrator\n/);
  assert.match(run('net localgroup nosuch').stderr, /The specified local group does not exist/);
  run('net user bob P@ss1 /add');
  assert.match(run('net user').stdout, /bob/);
  assert.equal(run('net localgroup administrators bob /add').exitCode, 0);
  assert.match(run('net localgroup administrators').stdout, /\nbob\n/);
  assert.match(run('net localgroup administrators bob /add').stderr, /already a member/);
  assert.match(run('net user bob').stdout, /Local Group Memberships +\*Administrators \*Users/);

  const started = run('net start').stdout;
  assert.match(started, /^These Windows services are started:\n\n {3}/);
  assert.match(started, / {3}Print Spooler\n/);
  assert.match(run('net stop spooler').stdout, /^The Print Spooler service is stopping\.\nThe Print Spooler service was stopped successfully\./);
  assert.equal(run.state().services.find(s => s.name === 'Spooler')!.status, 'Stopped');
  assert.doesNotMatch(run('net start').stdout, /Print Spooler/);
  assert.match(run('net stop spooler').stderr, /is not started/);
  assert.match(run('net start "Print Spooler"').stdout, /was started successfully/);
  assert.match(run('net start spooler').stderr, /already been started/);
  assert.match(run('net start nosuch').stderr, /The service name is invalid/);

  const user = windowsSession('cmd', { isRootOrAdmin: false });
  const denied = user('net stop spooler');
  assert.match(denied.stderr, /System error 5 has occurred\.\n\nAccess is denied\./);
});

test('uname options, ip filtering by device, journalctl -u', () => {
  const run = linuxSession();
  assert.equal(run('uname -r').stdout, '5.15.0-101-generic');
  assert.equal(run('uname').stdout, 'Linux');
  assert.match(run('uname -a').stdout, /^Linux \S+ 5\.15\.0-101-generic #111-Ubuntu SMP .* x86_64 GNU\/Linux$/);
  assert.equal(run('uname -m').stdout, 'x86_64');
  const eth0 = run('ip a show eth0').stdout;
  assert.match(eth0, /eth0:/);
  assert.doesNotMatch(eth0, /\blo:/);
  assert.equal(run('ip addr show dev eth0').stdout, eth0);
  assert.match(run('ip a show nosuch').stderr, /Device "nosuch" does not exist\./);
  assert.match(run('ip a').stdout, /lo:[\s\S]*eth0:|eth0:[\s\S]*lo:/);
  const ssh = run('journalctl -u ssh').stdout.split('\n').slice(1);
  assert.ok(ssh.length >= 2);
  assert.ok(ssh.every(l => /sshd|Secure Shell/.test(l)), ssh.join('\n'));
  assert.doesNotMatch(run('journalctl -u ssh.service').stdout, /nginx/);
  assert.match(run('journalctl -u nosuch').stdout, /-- No entries --/);
});
