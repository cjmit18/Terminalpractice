import test from 'node:test';
import assert from 'node:assert/strict';
import { windowsSession } from './testUtils.ts';
import { psTokenize } from './windows/psUtil.ts';
import { NOT_SIMULATED_WINDOWS } from './notSimulated.ts';

// Regression tests for the fact-check findings on the Windows engine (W-*, E-*, D-* IDs).

const STUDENT = { currentUser: 'Student', currentGroup: 'Users', isRootOrAdmin: false };
const ONLINE = {
  interfaces: [{ name: 'Ethernet0', ip: '192.168.1.145', netmask: '255.255.255.0', mac: '00-50-56-A1-2B-3C', gateway: '192.168.1.1', dns: ['192.168.1.10'], dhcpEnabled: true, status: 'UP' as const }],
  gatewayWorking: true,
  dnsWorking: true,
};
const user = (run: ReturnType<typeof windowsSession>, sam: string) => run.state().adUsers.find(u => u.sAMAccountName === sam);
const pids = (run: ReturnType<typeof windowsSession>) => run.state().processes.map(p => p.pid);

test('psTokenize: quotes removed, (...) and {...} kept whole, spaced comma lists joined', () => {
  const t = psTokenize('-Identity "Domain Admins" -Members alex, mscott -P (ConvertTo-SecureString "a b" -AsPlainText) -Filter {LockedOut -eq $true}');
  assert.deepEqual(t.map(x => x.text), ['-Identity', 'Domain Admins', '-Members', 'alex,mscott', '-P', '(ConvertTo-SecureString "a b" -AsPlainText)', '-Filter', '{LockedOut -eq $true}']);
  assert.equal(psTokenize("'-x'")[0].quoted, true, 'a quoted dash word is a value');
});

test('E (W-2, E-9, N-7): New-ADUser binds positional and quoted values and creates disabled accounts', () => {
  const run = windowsSession('powershell');
  assert.equal(run('New-ADUser alex').exitCode, 0);
  const alex = run('Get-ADUser alex -Properties *').stdout;
  assert.match(alex, /DistinguishedName +: CN=alex,CN=Users,DC=corp,DC=local/);
  assert.match(alex, /Enabled +: False/);
  assert.match(alex, /GivenName +:\n/);
  assert.match(alex, /Surname +:\n/);
  assert.match(alex, /Department +:\n/);
  assert.match(alex, /EmailAddress +:\n/);

  run('New-ADUser -SamAccountName "achen" -Name "Alex Chen" -Path "OU=IT_Admins,DC=corp,DC=local"');
  assert.equal(user(run, 'achen')?.ou, 'OU=IT_Admins,DC=corp,DC=local', 'quotes are not stored');
  assert.equal(user(run, 'achen')?.enabled, false);

  run('New-ADUser bob -AccountPassword (ConvertTo-SecureString "P@ssw0rd!" -AsPlainText -Force) -Enabled $true');
  assert.equal(user(run, 'bob')?.enabled, true, 'a password and -Enabled $true enable it');
  const noPw = run('New-ADUser carl -Enabled $true');
  assert.equal(noPw.exitCode, 1);
  assert.equal(user(run, 'carl')?.enabled, false);
  assert.match(run('New-ADUser dan -AccountPassword P@ss').stderr, /Cannot convert the "P@ss" value of type "System.String" to type "System.Security.SecureString"/);
  assert.match(run('New-ADUser alex').stderr, /The specified account already exists/);
  assert.match(run('New-ADUser eve -Path "OU=Nowhere,DC=corp,DC=local"').stderr, /Directory object not found/);
  assert.match(run('New-ADUser -SamAccountName frank').stderr, /missing mandatory parameters: Name/);
});

test('E (E-8): Unlock-ADAccount takes positional, quoted, DN and piped identities; unknown ones fail', () => {
  for (const line of ['Unlock-ADAccount jdoe', 'Unlock-ADAccount -Identity "jdoe"', "Unlock-ADAccount -Identity 'jdoe'",
    'Unlock-ADAccount -Identity "CN=John Doe,OU=Marketing,DC=corp,DC=local"', 'Get-ADUser jdoe | Unlock-ADAccount', 'Search-ADAccount -LockedOut | Unlock-ADAccount']) {
    const run = windowsSession('powershell');
    const res = run(line);
    assert.equal(res.exitCode, 0, line);
    assert.equal(res.stdout, '', line);
    assert.equal(user(run, 'jdoe')?.locked, false, line);
  }
  const run = windowsSession('powershell');
  const missing = run('Unlock-ADAccount -Identity nosuch');
  assert.equal(missing.exitCode, 1);
  assert.match(missing.stderr, /^Unlock-ADAccount : Cannot find an object with identity: 'nosuch' under: 'DC=corp,DC=local'\./);
});

test('E (E-9): Add-ADGroupMember takes positional and comma lists and checks every object', () => {
  const run = windowsSession('powershell');
  assert.equal(run('Add-ADGroupMember "Domain Admins" jdoe').exitCode, 0);
  assert.ok(user(run, 'jdoe')?.memberOf.includes('Domain Admins'));
  run('Add-ADGroupMember -Identity "Sales Managers" -Members jdoe, administrator');
  assert.ok(run.state().adGroups.find(g => g.name === 'Sales Managers')?.members.includes('administrator'));
  const badGroup = run('Add-ADGroupMember -Identity Nope -Members jdoe');
  assert.equal(badGroup.exitCode, 1);
  assert.match(badGroup.stderr, /Cannot find an object with identity: 'Nope' under: 'DC=corp,DC=local'\./);
  const badMember = run('Add-ADGroupMember "Helpdesk Tier 1" mscott,nosuch');
  assert.equal(badMember.exitCode, 1);
  assert.match(badMember.stderr, /identity: 'nosuch'/);
  assert.ok(!user(run, 'mscott')?.memberOf.includes('Helpdesk Tier 1'), 'nothing is added when a member is missing');
  assert.match(run('Get-ADGroupMember "Domain Admins"').stdout, /SamAccountName +: jdoe/);
});

test('E (E-20): Get-ADUser -Filter script blocks and Search-ADAccount', () => {
  const run = windowsSession('powershell');
  const locked = run('Get-ADUser -Filter {LockedOut -eq $true}');
  assert.equal(locked.exitCode, 0);
  assert.equal((locked.stdout.match(/SamAccountName/g) ?? []).length, 1);
  assert.match(locked.stdout, /SamAccountName +: jdoe/);
  assert.match(run('Search-ADAccount -LockedOut').stdout, /LockedOut +: True[\s\S]*SamAccountName +: jdoe/);
  run('Disable-ADAccount mscott');
  assert.equal(user(run, 'mscott')?.enabled, false);
  assert.match(run('Search-ADAccount -AccountDisabled -UsersOnly').stdout, /mscott/);
  run('Enable-ADAccount -Identity mscott');
  assert.equal(user(run, 'mscott')?.enabled, true);
});

test('E (E-10): Stop-Process by name, by piped object, and errors for unknown IDs', () => {
  for (const line of ['Stop-Process -Name svchost_update -Force', 'Get-Process -Id 3892 | Stop-Process -Force', 'Stop-Process -Id 3892 -Force', 'Stop-Process 3892', 'kill 3892', 'spps -Id 3892']) {
    const run = windowsSession('powershell');
    const res = run(line);
    assert.equal(res.exitCode, 0, `${line}: ${res.stderr}`);
    assert.ok(!pids(run).includes(3892), line);
  }
  const run = windowsSession('powershell');
  const none = run('Stop-Process -Id 9999');
  assert.equal(none.exitCode, 1);
  assert.match(none.stderr, /^Stop-Process : Cannot find a process with the process identifier 9999\./);
  assert.match(run('Stop-Process -Name nope').stderr, /Cannot find a process with the name "nope"/);
  assert.match(run('Stop-Process -Name lsass -Force').stderr, /Cannot stop process "lsass \(704\)".*Access is denied/);
  assert.match(run('gps -Id 704').stdout, /lsass$/m);
});

test('E (E-20): Where-Object, Select-Object, Select-String, Measure-Object and piping into service cmdlets', () => {
  const run = windowsSession('powershell');
  const busy = run('Get-Process | Where-Object {$_.CPU -gt 50}').stdout;
  assert.match(busy, /svchost_update$/m);
  assert.equal(busy.split('\n').length, 3, 'only the busy process');
  assert.match(run("Get-Process | Where-Object {$_.CPU -lt 50 -and $_.Name -like 'ls*'}").stdout, /lsass$/m);
  assert.equal(run('Get-Service | Where-Object Status -eq Stopped').stdout.split('\n').length, 2 + run.state().services.filter(s => s.status === 'Stopped').length);
  const cols = run('Get-Service | Select-Object Name,Status').stdout;
  assert.match(cols, /^\nName +Status\n----/);
  assert.doesNotMatch(cols, /DisplayName/);
  assert.equal(run('Get-Service W32Time | Select-Object -ExpandProperty Status').stdout, 'Stopped');
  const hosts = run('Get-Content C:\\Windows\\System32\\drivers\\etc\\hosts | Select-String localhost').stdout;
  assert.ok(hosts.split('\n').every(l => /localhost/.test(l)), 'only matching lines');
  assert.match(run('Get-Service | Measure-Object').stdout, new RegExp(`Count +: ${run.state().services.length}\n`));
  assert.equal(run('Get-Service W32Time | Start-Service').exitCode, 0);
  assert.equal(run.state().services.find(s => s.name === 'W32Time')?.status, 'Running');
  assert.match(run('Get-Service | Where-Object {$_.Name.Length -gt 3}').stderr, /not supported/);
});

test('H-2: Clear-DnsClientCache, Test-Connection, Repair-WindowsImage, Get-NetTCPConnection, Set-Service', () => {
  const run = windowsSession('powershell', { ...ONLINE, dnsWorking: false });
  assert.equal(run('Clear-DnsClientCache').stdout, '');
  assert.equal(run.state().dnsWorking, true);
  assert.equal(run.state().dnsCacheFlushed, true);
  assert.match(windowsSession('powershell', STUDENT)('Clear-DnsClientCache').stderr, /Access denied/);
  const tc = run('Test-Connection 8.8.8.8 -Count 2');
  assert.equal(tc.stdout.split('\n').filter(l => /^WIN-CLIENT01 +8\.8\.8\.8/.test(l)).length, 2);
  assert.equal(run('Test-Connection 8.8.8.8 -Quiet').stdout, 'True');
  const offline = windowsSession('powershell')('Test-Connection 8.8.8.8');
  assert.equal(offline.exitCode, 1);
  assert.match(offline.stderr, /Testing connection to computer '8\.8\.8\.8' failed/);
  // -Count is validated like PowerShell's Int32 ValidateRange(1, ...) and replies are capped
  assert.match(run('Test-Connection 127.0.0.1 -Count Infinity').stderr, /Cannot convert value "Infinity" to type "System\.Int32"/);
  assert.match(run('Test-Connection 127.0.0.1 -Count 0').stderr, /less than the minimum allowed range of 1/);
  const huge = run('Test-Connection 127.0.0.1 -Count 2147483647');
  assert.equal(huge.exitCode, 0);
  assert.equal(huge.stdout.split('\n').filter(l => /^WIN-CLIENT01 +127\.0\.0\.1/.test(l)).length, 100);
  assert.match(huge.explanation ?? '', /first 100 replies/);

  const sfcRun = windowsSession('powershell', { systemIntegrityCorrupted: true, dismRepaired: false });
  assert.match(sfcRun('Repair-WindowsImage -Online -ScanHealth').stdout, /ImageHealthState : Repairable/);
  assert.match(sfcRun('Repair-WindowsImage -Online -RestoreHealth').stdout, /ImageHealthState : Healthy/);
  assert.equal(sfcRun.state().dismRepaired, true);

  const tcp = run('Get-NetTCPConnection -RemotePort 4444').stdout;
  assert.match(tcp, /192\.168\.1\.145 +49811 +203\.0\.113\.88 +4444 +Established +Internet +3892/);
  assert.match(run('Get-NetTCPConnection -RemotePort 1').stderr, /No MSFT_NetTCPConnection objects found/);
  assert.equal(run('Set-Service -Name W32Time -StartupType Manual').exitCode, 0);
  assert.equal(run.state().services.find(s => s.name === 'W32Time')?.startType, 'Manual');
  assert.match(run('Set-Service W32Time -StartupType Sometimes').stderr, /Cannot convert value "Sometimes"/);
  assert.equal(run('Invoke-GPUpdate -Force').exitCode, 0);
});

test('F (W-1, E-17): per-drive current directory, D:, cd /d and cd \\', () => {
  const run = windowsSession('cmd');
  const cd = run('cd D:\\Logs');
  assert.equal(cd.stdout, '');
  assert.equal(run.cwd(), 'C:\\Users\\Student', 'cd to another drive does not switch drive');
  assert.match(cd.explanation ?? '', /still on C:/);
  assert.equal(run('cd D:').stdout, 'D:\\Logs');
  run('D:');
  assert.equal(run.cwd(), 'D:\\Logs');
  run('C:');
  assert.equal(run.cwd(), 'C:\\Users\\Student', 'C: returns to its own directory');
  run('cd \\');
  assert.equal(run.cwd(), 'C:\\');
  run('cd /d D:\\Logs');
  assert.equal(run.cwd(), 'D:\\Logs');
  run('cd \\');
  assert.equal(run.cwd(), 'D:\\');
  assert.doesNotMatch(run('set').stdout, /^=/m, 'per-drive directories are hidden from set');
});

test('F (E-17, E-11, E-18): echo keeps quotes, echo off is silent, %ERRORLEVEL%, ipconfig -switches', () => {
  const run = windowsSession('cmd');
  assert.equal(run('echo "quoted"').stdout, '"quoted"');
  assert.equal(run('echo off').stdout, '');
  assert.equal(run('echo').stdout, 'ECHO is on.');
  run('echo a^&b > f.txt');
  assert.equal(run('type f.txt').stdout, 'a&b');
  run('dir nosuch');
  assert.equal(run('echo %ERRORLEVEL%').stdout, '1');
  assert.equal(run('echo %ERRORLEVEL%').stdout, '1', 'echo does not reset it');
  run('ping 8.8.8.8');
  assert.equal(run('echo %ERRORLEVEL%').stdout, '1', 'a failed ping');
  run('ver');
  assert.equal(run('echo %ERRORLEVEL%').stdout, '0');
  assert.equal(run('ipconfig -all').stdout, run('ipconfig /all').stdout);
  run('ipconfig -renew');
  assert.equal(run.state().interfaces[0].ip, '192.168.1.145');
  run('ipconfig -flushdns');
  assert.equal(run.state().dnsCacheFlushed, true);
});

test('F (E-19): taskkill needs /F for a process with no window', () => {
  const run = windowsSession('cmd');
  const soft = run('taskkill /PID 3892');
  assert.equal(soft.exitCode, 1);
  assert.equal(soft.stderr, 'ERROR: The process with PID 3892 could not be terminated.\nReason: This process can only be terminated forcefully (with /F option).');
  assert.ok(pids(run).includes(3892), 'the process keeps running');
  assert.equal(run('taskkill /PID 3892 /F').stdout, 'SUCCESS: The process with PID 3892 has been terminated.');
  assert.ok(!pids(run).includes(3892));
  assert.match(run('taskkill /PID 2140').stdout, /SUCCESS: Sent termination signal to the process with PID 2140\./);
  run('taskkill /F /PID 844');
  assert.ok(!/^svchost\.exe +844 /m.test(run('tasklist').stdout), 'an ended base process does not come back');
});

test('F (W-8, E-24, W-7): diskpart argument checks, format label, clean/convert/active/delete/extend', () => {
  const run = windowsSession('cmd');
  run('diskpart');
  run('select disk 1');
  const gb = run('create partition primary size=50GB');
  assert.match(gb.stdout, /^The arguments specified for this command are not valid\./);
  assert.equal(run.state().disks[1].partitions.filter(p => p.isPrimary).length, 0, 'nothing is created');
  run('create partition primary size=51200');
  assert.equal(run.state().disks[1].partitions.find(p => p.isPrimary)?.sizeMB, 51200);
  run('format fs=ntfs quick');
  assert.equal(run.state().disks[1].partitions.find(p => p.isPrimary)?.label, '', 'no label unless LABEL= is given');
  assert.match(run('assign letter E').stdout, /arguments specified for this command are not valid/);
  assert.ok(!run.state().disks[1].partitions.some(p => p.driveLetter), 'assign letter E assigns nothing');
  run('assign letter=E');
  assert.equal(run.state().disks[1].partitions.find(p => p.isPrimary)?.driveLetter, 'E:');
  assert.match(run('active').stdout, /ACTIVE command can only be used on fixed MBR disks/);
  assert.match(run('convert mbr').stdout, /not convertible/);
  assert.match(run('extend size=10').stdout, /DiskPart successfully extended the volume\./);
  assert.match(run('delete partition').stdout, /DiskPart successfully deleted the selected partition\./);
  assert.equal(run('clean').stdout, 'DiskPart succeeded in cleaning the disk.');
  assert.equal(run.state().disks[1].partitionTable, 'MBR');
  assert.equal(run('convert gpt').stdout, 'DiskPart successfully converted the selected disk to GPT format.');
  assert.match(run('shrink desired=10').stdout, /not simulated/);
  run('select disk 0');
  assert.match(run('clean').stdout, /Clean is not allowed on the disk containing the current boot/);
});

test('F (W-9, W-5, W-6, E-23): whoami /groups and /all, netstat -b, tasklist /svc, net /domain changes AD', () => {
  const run = windowsSession('cmd', ONLINE);
  const groups = run('whoami /groups').stdout;
  assert.match(groups, /^\nGROUP INFORMATION\n-----------------\n/);
  assert.match(groups, /BUILTIN\\Administrators +Alias +S-1-5-32-544 +Mandatory group, Enabled by default, Enabled group, Group owner/);
  assert.match(groups, /Mandatory Label\\High Mandatory Level +Label +S-1-16-12288/);
  const all = run('whoami /all').stdout;
  for (const h of ['USER INFORMATION', 'GROUP INFORMATION', 'PRIVILEGES INFORMATION']) assert.ok(all.includes(h), h);
  assert.ok(!all.includes('@corp.local'), '/all does not include /upn');
  assert.match(windowsSession('cmd', STUDENT)('whoami /groups').stdout, /BUILTIN\\Administrators +Alias +S-1-5-32-544 +Group used for deny only[\s\S]*Medium Mandatory Level/);

  const b = run('netstat -abno').stdout;
  assert.match(b, /203\.0\.113\.88:4444 +ESTABLISHED +3892\n \[svchost_update\.exe\]/);
  assert.equal(windowsSession('cmd', STUDENT)('netstat -b').stderr, 'The requested operation requires elevation.');
  assert.match(run('tasklist /svc').stdout, /^Image Name +PID Services$/m);
  assert.match(run('tasklist /svc').stdout, /^lsass\.exe +704 KeyIso, Netlogon, SamSs, VaultSvc$/m);

  assert.match(run('net user alex P@ssw0rd /add /domain').stdout, /The command completed successfully\./);
  assert.equal(user(run, 'alex')?.enabled, true);
  assert.equal(run('net group "Domain Admins" alex /add /domain').exitCode, 0);
  assert.ok(user(run, 'alex')?.memberOf.includes('Domain Admins'));
  assert.ok(run.state().adGroups.find(g => g.name === 'Domain Admins')?.members.includes('alex'));
  run('net user jdoe /active:no /domain');
  assert.equal(user(run, 'jdoe')?.enabled, false);
  assert.match(run('net group "Domain Admins" nosuch /add /domain').stderr, /There is no such global user or group: nosuch/);
  assert.match(run('net group').stderr, /only on a Windows Domain Controller/);
  assert.match(run('net user bob /add /domain').stderr, /password does not meet the password policy/);
});

test('SFC contract: scanning always records sfcScanned; repairing needs a healthy store', () => {
  const run = windowsSession('cmd', { systemIntegrityCorrupted: true, sfcRepaired: false, dismRepaired: false, sfcScanned: false });
  run('sfc /scannow');
  assert.deepEqual([run.state().sfcScanned, run.state().sfcRepaired, run.state().systemIntegrityCorrupted], [true, false, true]);
  run('dism /online /cleanup-image /restorehealth');
  assert.equal(run.state().dismRepaired, true);
  run('sfc /scannow');
  assert.deepEqual([run.state().sfcRepaired, run.state().systemIntegrityCorrupted], [true, false]);
  const healthy = windowsSession('cmd', { systemIntegrityCorrupted: false, sfcRepaired: false, sfcScanned: false });
  healthy('sfc /scannow');
  assert.deepEqual([healthy.state().sfcScanned, healthy.state().sfcRepaired], [true, true]);
});

test('Ping (E-28, N-9) and nslookup (W-13): own address, LAN TTL, real records', () => {
  const apipa = windowsSession('cmd');
  const self = apipa('ping 169.254.82.114');
  assert.equal(self.exitCode, 0, 'the PC always answers on its own address');
  assert.match(self.stdout, /Reply from 169\.254\.82\.114: bytes=32 time<1ms TTL=128/);
  assert.match(apipa('ping 192.168.1.1').stdout, /PING: transmit failed\. General failure\./);
  const run = windowsSession('cmd', ONLINE);
  assert.match(run('ping 192.168.1.145').stdout, /time<1ms TTL=128/);
  const gw = run('ping 192.168.1.1').stdout;
  assert.match(gw, /Reply from 192\.168\.1\.1: bytes=32 time<1ms TTL=64/);
  const ns = run('nslookup www.example.com').stdout;
  assert.match(ns, /Non-authoritative answer:\nName: +www\.example\.com\nAddress: +93\.184\.215\.14/);
  // nslookup asks the server directly, so a stale client cache does not affect it
  const stale = windowsSession('cmd', { ...ONLINE, dnsWorking: false });
  assert.match(stale('nslookup www.example.com').stdout, /93\.184\.215\.14/);
  assert.equal(stale('ping www.example.com').exitCode, 1);
});

test('H-3: commands that exist on Windows but are not simulated say so', () => {
  const cmd = windowsSession('cmd')('winver');
  assert.equal(cmd.stderr, "'winver' exists on real Windows but is not simulated here.");
  assert.equal(cmd.exitCode, 9009);
  assert.match(windowsSession('cmd')('nosuchcmd').stderr, /is not recognized as an internal or external command/);
  const ps = windowsSession('powershell')('schtasks /query');
  assert.equal(ps.stderr, "schtasks : 'schtasks' exists on real Windows but is not simulated here.");
  assert.match(windowsSession('powershell')('nosuchcmd').stderr, /The term 'nosuchcmd' is not recognized/);
});

test('A (D-1..D-4, W-10): aliases, functions and pipeline binding in the docs', () => {
  const run = windowsSession('powershell');
  assert.match(run('Get-Command mkdir').stdout, /^Function +mkdir/m);
  assert.match(run('Get-Command md').stdout, /^Alias +md -> mkdir/m);
  assert.match(run('Get-Command help').stdout, /^Function +help/m);
  assert.match(run('Get-Command man').stdout, /^Alias +man -> help/m);
  assert.match(run('Get-Command ni').stdout, /^Alias +ni -> New-Item/m);
  for (const [a, c] of [['gps', 'Get-Process'], ['ps', 'Get-Process'], ['kill', 'Stop-Process'], ['spps', 'Stop-Process']]) {
    assert.match(run(`Get-Command ${a}`).stdout, new RegExp(`^Alias +${a} -> ${c}`, 'm'));
  }
  assert.match(run('Get-Help mkdir').stdout, /NAME\n {4}New-Item/);
  assert.match(run('Get-Help Get-Process -Parameter Name').stdout, /Accept pipeline input\? +True \(ByPropertyName\)/);
  const nouns = run('Get-Command -Noun Service').stdout.split('\n').filter(l => l.startsWith('Cmdlet'));
  assert.equal(nouns.length, 8);
  assert.match(run('ps').stdout, /ProcessName/);
  assert.match(windowsSession('cmd')('whoami /?').stdout, /\/ALL +User name and SID, groups, privileges and claims \(not \/UPN/);
});

test('F (W-12): net use maps, lists and deletes network drives', () => {
  const run = windowsSession('cmd', ONLINE);
  assert.match(run('net use').stdout, /There are no entries in the list\./);
  assert.equal(run('net use Z: \\\\fs01\\share').stdout, 'The command completed successfully.');
  assert.match(run('net use').stdout, /^OK {11}Z: {8}\\\\fs01\\share +Microsoft Windows Network$/m);
  assert.match(run('net use Z: \\\\fs01\\other').stderr, /local device name is already in use/);
  assert.match(run('net use * \\\\fs01\\public').stdout, /^Drive Y: is now connected to \\\\fs01\\public\./);
  assert.equal(run('net use Z: /delete').stdout, 'Z: was deleted successfully.');
  assert.doesNotMatch(run('net use').stdout, /Z:/);
  assert.doesNotMatch(run('set').stdout, /NetUse/);
  assert.match(windowsSession('cmd')('net use Z: \\\\fs01\\share').stderr, /System error 53/);
});

test('PowerShell redirection: > file, 2>$null, 2>&1, and > inside quotes or blocks is text', () => {
  const run = windowsSession('powershell');
  assert.equal(run('Get-Service W32Time > s.txt').stdout, '');
  assert.match(run('Get-Content s.txt').stdout, /W32Time +Windows Time/);
  assert.equal(run('Get-Process nope 2>$null').stderr, '');
  assert.match(run('Get-Process nope 2>&1').stdout, /Cannot find a process with the name "nope"/);
  assert.equal(run('Write-Output "a > b"').stdout, 'a > b');
});

test('H-3: every listed Windows command without a handler gives the not-simulated message', () => {
  for (const name of NOT_SIMULATED_WINDOWS) {
    for (const shell of ['cmd', 'powershell'] as const) {
      const res = windowsSession(shell)(name);
      assert.doesNotMatch(res.stderr, /not recognized/, `${shell}: ${name} is listed as not simulated`);
    }
  }
});

test('master re-check R-1: piping into a cmdlet the simulator lacks says so, not a binding error', () => {
  const run = windowsSession('powershell');
  for (const line of ['Get-Service | Out-File svc.txt', 'Get-Service | ForEach-Object { $_.Name }', 'Get-Service | Get-Member']) {
    const res = run(line);
    assert.notEqual(res.exitCode, 0, line);
    assert.match(res.stderr, /is not supported in this simulator/, line);
    assert.doesNotMatch(res.stderr, /InputObjectNotBound/, line);
  }
  // A simulated cmdlet given the wrong kind of object still gets PowerShell's own error
  assert.match(run('Get-Service | Stop-Process').stderr, /InputObjectNotBound/);
});
