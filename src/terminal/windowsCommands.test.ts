import test from 'node:test';
import assert from 'node:assert/strict';
import { createNode, getNodeAtPath } from './filesystem.ts';
import { windowsSession } from './testUtils.ts';

const STUDENT = { currentUser: 'Student', currentGroup: 'Users', isRootOrAdmin: false };
const node = (run: ReturnType<typeof windowsSession>, p: string) => getNodeAtPath(run.fs(), p, true);

test('CMD: %VAR% expansion from state.envVars and dynamic variables', () => {
  const run = windowsSession('cmd');
  assert.equal(run('echo %USERNAME%').stdout, 'Administrator');
  assert.equal(run('echo %COMPUTERNAME% %userdnsdomain%').stdout, 'WIN-CLIENT01 CORP.LOCAL');
  assert.equal(run('echo %CD%').stdout, 'C:\\Users\\Student');
  assert.equal(run('echo %SystemRoot%\\System32').stdout, 'C:\\Windows\\System32');
  assert.equal(run('echo %NOPE%').stdout, '%NOPE%', 'undefined variables stay as typed');
  assert.equal(run('cd %USERPROFILE%').exitCode, 0);
  assert.equal(run.cwd(), 'C:\\Users\\Administrator');
  const student = windowsSession('cmd', { ...STUDENT, envVars: {} });
  assert.equal(student('echo %USERNAME% %USERPROFILE%').stdout, 'Student C:\\Users\\Student');
  assert.equal(windowsSession('powershell')('echo %USERNAME%').stdout, '%USERNAME%', 'PowerShell does not expand %VAR%');
  assert.equal(windowsSession('powershell')('echo $env:USERNAME').stdout, 'Administrator');
  const ps = windowsSession('powershell');
  assert.equal(ps("Write-Output '$env:USERNAME'").stdout, '$env:USERNAME', 'single-quoted strings are literal');
  assert.equal(ps('Write-Output $env:ProgramFiles').stdout, 'C:\\Program Files', 'expanded values stay one argument');
  assert.equal(ps('Write-Output "$env:ProgramFiles"').stdout, 'C:\\Program Files');
  assert.equal(ps('Write-Output `$env:USERNAME').stdout, '$env:USERNAME', 'backtick-escaped variables are literal');
});

test('CMD: set lists, assigns, filters and computes', () => {
  const run = windowsSession('cmd');
  const all = run('set').stdout.split('\r\n');
  assert.ok(all.includes('USERNAME=Administrator'));
  assert.ok(all.includes('COMPUTERNAME=WIN-CLIENT01'));
  const names = all.map(l => l.split('=')[0]);
  assert.deepEqual([...names].sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase())), names, 'sorted by name like CMD');
  assert.equal(run('set PROJECT=Terminus CertSim').exitCode, 0);
  assert.equal(run.state().envVars.PROJECT, 'Terminus CertSim');
  assert.equal(run('echo %project%').stdout, 'Terminus CertSim');
  assert.equal(run('set PROJ').stdout, 'PROJECT=Terminus CertSim');
  const missing = run('set ZZZ');
  assert.equal(missing.stderr, 'Environment variable ZZZ not defined');
  assert.equal(missing.exitCode, 1);
  run('set PROJECT=');
  assert.equal(run('echo %PROJECT%').stdout, '%PROJECT%');
  assert.equal(run('set /a 6*7').stdout, '42');
  run('set /a N=(2+3)*4');
  assert.equal(run('echo %N%').stdout, '20');
  assert.equal(run('set > vars.txt').exitCode, 0);
  assert.match(node(run, 'C:\\Users\\Student\\vars.txt')?.content ?? '', /^ALLUSERSPROFILE=/);
});

test('CMD: mkdir/md, copy, del, type', () => {
  const run = windowsSession('cmd');
  assert.equal(run('mkdir Projects').exitCode, 0);
  assert.equal(node(run, 'C:\\Users\\Student\\Projects')?.type, 'directory');
  assert.equal(run('md a\\b\\c').exitCode, 0, 'intermediate folders are created');
  assert.ok(node(run, 'C:\\Users\\Student\\a\\b\\c'));
  const again = run('mkdir Projects');
  assert.equal(again.stderr, 'A subdirectory or file Projects already exists.');
  assert.equal(again.exitCode, 1);

  const cp = run('copy Desktop\\TroubleTicket.txt Projects');
  assert.equal(cp.stdout, '        1 file(s) copied.');
  assert.ok(node(run, 'C:\\Users\\Student\\Projects\\TroubleTicket.txt'));
  assert.equal(run('copy Desktop\\TroubleTicket.txt ticket.txt').exitCode, 0);
  assert.match(run('type ticket.txt').stdout, /^TICKET #8491/);
  const none = run('copy nothing.txt x.txt');
  assert.equal(none.stderr, 'The system cannot find the file specified.');
  assert.equal(none.stdout, '        0 file(s) copied.');
  const wild = run('copy Projects\\*.txt a');
  assert.equal(wild.stdout, 'TroubleTicket.txt\n        1 file(s) copied.');

  assert.equal(run('del ticket.txt').exitCode, 0);
  assert.equal(node(run, 'C:\\Users\\Student\\ticket.txt'), null);
  assert.equal(run('del ticket.txt').stderr, 'Could Not Find C:\\Users\\Student\\ticket.txt');
  run('del Projects\\*.txt');
  assert.deepEqual(Object.keys(node(run, 'C:\\Users\\Student\\Projects')?.children ?? {}), []);
  assert.equal(run('type Desktop').stderr, 'Access is denied.');
  assert.equal(run('erase a\\TroubleTicket.txt').exitCode, 0);
});

test('CMD: standard users get Access is denied with an explanation', () => {
  const run = windowsSession('cmd', STUDENT);
  createNode(run.fs(), 'C:\\Users\\Administrator\\secret.txt', 'file', 'private', true, 'Administrator', 'Administrators', 600);
  const md = run('mkdir C:\\Windows\\Evil');
  assert.equal(md.stderr, 'Access is denied.');
  assert.match(md.explanation ?? '', /standard user .*C:\\Windows is protected/);
  const redirect = run('echo x > C:\\Windows\\System32\\x.txt');
  assert.equal(redirect.stderr, 'Access is denied.');
  assert.ok(redirect.explanation);
  assert.equal(node(run, 'C:\\Windows\\System32\\x.txt'), null);
  const other = run('dir C:\\Users\\Administrator');
  assert.match(other.explanation ?? '', /belongs to another account/);
  const findstr = run('findstr private C:\\Users\\Administrator\\secret.txt');
  assert.equal(findstr.stderr, 'Access is denied.');
  assert.equal(findstr.stdout, '');
  assert.match(findstr.explanation ?? '', /belongs to another account/);
  assert.equal(run('mkdir mine').exitCode, 0, 'own profile is writable');
  const del = run('del C:\\Windows\\System32\\drivers\\etc\\hosts');
  assert.match(del.stderr, /Access is denied\./);
  assert.ok(node(run, 'C:\\Windows\\System32\\drivers\\etc\\hosts'));
});

test('CMD: ver, systeminfo and chkdsk', () => {
  const run = windowsSession('cmd');
  assert.equal(run('ver').stdout, '\nMicrosoft Windows [Version 10.0.22621.2428]');
  const info = run('systeminfo').stdout;
  assert.match(info, /^Host Name: +WIN-CLIENT01$/m);
  assert.match(info, /^OS Name: +Microsoft Windows 11 Pro$/m);
  assert.match(info, /\[01\]: 169\.254\.82\.114/);
  const chk = run('chkdsk');
  assert.match(chk.stdout, /Running CHKDSK in read-only mode\./);
  assert.match(chk.stdout, /found no problems/);
  assert.match(run('chkdsk C: /f').stdout, /Cannot lock current drive/);
  assert.equal(run('chkdsk Q:').stderr, 'Cannot open volume for direct access.');
  const user = windowsSession('cmd', STUDENT)('chkdsk');
  assert.match(user.stderr, /^Access Denied as you do not have sufficient privileges/);
  assert.equal(user.exitCode, 3);
  assert.match(user.explanation ?? '', /Run as administrator/);
});

test('Review: taskkill /IM, tasklist without duplicates, protected processes', () => {
  const run = windowsSession('cmd');
  const list = run('tasklist').stdout;
  for (const image of [/^System +4 /, /^csrss\.exe /, /^lsass\.exe /, /^explorer\.exe /]) {
    assert.equal(list.split('\n').filter(l => image.test(l)).length, 1, `${image} listed once`);
  }
  assert.match(list, /svchost_update\.exe +3892/);
  const im = run('taskkill /IM svchost_update.exe /F');
  assert.equal(im.stdout, 'SUCCESS: The process "svchost_update.exe" with PID 3892 has been terminated.');
  assert.ok(!run.state().processes.some(p => p.pid === 3892));
  assert.equal(run('taskkill /IM nothing.exe').stderr, 'ERROR: The process "nothing.exe" not found.');
  const lsass = run('taskkill /F /IM lsass.exe');
  assert.match(lsass.stderr, /could not be terminated\.\nReason: Access is denied\./);
  assert.match(lsass.explanation ?? '', /critical system process/);
  assert.match(run('taskkill').stderr, /Invalid syntax/);
  const user = windowsSession('cmd', STUDENT)('taskkill /PID 844');
  assert.match(user.explanation ?? '', /not elevated/);
});

test('Review: sfc before and after DISM, sfc /verifyonly, dism health checks', () => {
  const run = windowsSession('cmd', { systemIntegrityCorrupted: true, sfcRepaired: false, dismRepaired: false });
  assert.match(run('sfc /verifyonly').stdout, /found integrity violations/);
  assert.equal(run.state().sfcRepaired, false, '/verifyonly repairs nothing');
  assert.match(run('dism /online /cleanup-image /checkhealth').stdout, /The component store is repairable\./);
  const first = run('sfc /scannow');
  assert.match(first.stdout, /found corrupt files but was unable to fix some\nof them/);
  assert.equal(run.state().systemIntegrityCorrupted, true);
  assert.equal(run.state().sfcRepaired, true, 'the scan ran (lab objective)');
  run('dism /online /cleanup-image /restorehealth');
  assert.equal(run.state().dismRepaired, true);
  assert.match(run('sfc /scannow').stdout, /found corrupt files and successfully repaired\nthem/);
  assert.equal(run.state().systemIntegrityCorrupted, false);
  assert.match(run('sfc /scannow').stdout, /did not find any integrity violations/);
  assert.match(run('sfc').stdout, /SFC \[\/SCANNOW\]/);
  const user = windowsSession('cmd', STUDENT)('sfc /scannow');
  assert.match(user.stderr, /You must be an administrator/);
});

test('Review: gpresult /h and user, gpupdate /target', () => {
  const run = windowsSession('cmd');
  assert.match(run('gpresult /r').stdout, /RSOP data for CORP\\Administrator on WIN-CLIENT01/);
  assert.match(windowsSession('cmd', STUDENT)('gpresult /r').stdout, /RSOP data for CORP\\Student/);
  const h = run('gpresult /h report.html');
  assert.equal(h.stdout, '');
  assert.match(node(run, 'C:\\Users\\Student\\report.html')?.content ?? '', /<html>/);
  assert.equal(run('gpresult /h report.html').stderr, 'ERROR: The file "report.html" already exists.');
  assert.equal(run('gpresult /h report.html /f').exitCode, 0);
  assert.ok(!run('gpresult /r /scope computer').stdout.includes('USER SETTINGS'));
  const comp = run('gpupdate /target:computer').stdout;
  assert.match(comp, /Computer Policy update has completed successfully\./);
  assert.ok(!comp.includes('User Policy'));
  assert.ok(!run('gpupdate /target:user').stdout.includes('Computer Policy'));
});

test('Review: ipconfig APIPA labels, /displaydns, ping without a lease, netstat -r', () => {
  const run = windowsSession('cmd');
  const all = run('ipconfig /all').stdout;
  assert.match(all, /Autoconfiguration IPv4 Address\. \. : 169\.254\.82\.114\(Preferred\)/);
  assert.ok(!all.includes('DHCP Server'), 'no DHCP server answered');
  assert.match(all, /Host Name . . . . . . . . . . . . : WIN-CLIENT01/);
  const ping = run('ping 8.8.8.8');
  assert.match(ping.stdout, /PING: transmit failed\. General failure\./);
  assert.equal(ping.exitCode, 1);

  const cache = run('ipconfig /displaydns').stdout;
  assert.match(cache, /Record Name \. \. \. \. \. : dc01\.corp\.local/);
  assert.match(cache, /intranet\.corp\.local\n.*\n.*\n.*\n.*\n.*\n.*\n    A \(Host\) Record \. \. \. : 10\.99\.0\.15/);
  run('ipconfig /renew');
  run('ipconfig /flushdns');
  const after = run('ipconfig /displaydns').stdout;
  assert.ok(!after.includes('intranet'), 'flushed entries are gone');
  assert.match(after, /localhost/, 'hosts-file entries stay');
  assert.match(run('ipconfig /all').stdout, /DHCP Server . . . . . . . . . . . : 192\.168\.1\.10/);
  assert.match(run('ping 8.8.8.8').stdout, /Reply from 8\.8\.8\.8: bytes=32/);
  assert.match(run('ping dc01.corp.local').stdout, /Pinging dc01\.corp\.local \[192\.168\.1\.10\]/);

  const routes = run('netstat -r').stdout;
  assert.match(routes, /IPv4 Route Table/);
  assert.match(routes, /0\.0\.0\.0 +0\.0\.0\.0 +192\.168\.1\.1 +192\.168\.1\.145/);
  assert.equal(routes, run('route print').stdout);
});

test('Review: diskpart assign/format need a selected partition', () => {
  const run = windowsSession('cmd');
  run('diskpart');
  assert.match(run('assign letter=E').stdout, /There is no volume selected/);
  assert.equal(run('assign letter=E').exitCode, 1);
  run('select disk 1');
  assert.match(run('format fs=ntfs quick').stdout, /There is no volume selected/);
  // an empty disk has no partition 1 until one is created
  assert.match(run('select partition 1').stdout, /The specified partition is not valid/);
  run('create partition primary');
  run('select disk 1');
  assert.match(run('select partition 1').stdout, /Partition 1 is now the selected partition/);
  assert.match(run('format fs=ntfs quick label=Data').stdout, /successfully formatted/);
  assert.match(run('assign letter=C').stdout, /not free to be assigned/);
  run('assign letter=F');
  const part = run.state().disks[1].partitions[0];
  assert.deepEqual([part.fsType, part.driveLetter, part.label], ['NTFS', 'F:', 'Data']);
});

test('PowerShell: Get-ChildItem, Get-Content, Get-Location and aliases', () => {
  const run = windowsSession('powershell');
  const gci = run('Get-ChildItem').stdout;
  assert.match(gci, /^\n    Directory: C:\\Users\\Student\n\n\nMode +LastWriteTime +Length Name\n/);
  assert.match(gci, /^d----- +10\/19\/2026 +9:30 AM +Desktop$/m);
  for (const alias of ['ls', 'dir', 'gci']) assert.equal(run(alias).stdout, gci, alias);
  assert.match(run('ls Desktop').stdout, /^-a---- .* 214 TroubleTicket\.txt$/m);
  assert.equal(run('gci -Name').stdout, 'Desktop\nDocuments');
  assert.equal(run('Get-ChildItem -Recurse -File -Name').stdout, 'Desktop\\TroubleTicket.txt');
  assert.equal(run('gci *.txt -Name').stdout, '');

  const gc = run('Get-Content Desktop\\TroubleTicket.txt -TotalCount 1');
  assert.equal(gc.stdout, 'TICKET #8491: Sales Workstation Network Unreachable');
  for (const alias of ['cat', 'type', 'gc']) assert.match(run(`${alias} Desktop\\TroubleTicket.txt`).stdout, /^TICKET/);
  assert.equal(run('gc Desktop\\TroubleTicket.txt -Tail 1').stdout, 'Please review IP configuration, gateway, DNS settings, and verify connectivity.');
  const missing = run('cat nofile.txt');
  assert.match(missing.stderr, /^Get-Content : Cannot find path 'C:\\Users\\Student\\nofile\.txt' because it does not exist\.\nAt line:1 char:1/);
  assert.match(missing.stderr, /FullyQualifiedErrorId : PathNotFound,Microsoft\.PowerShell\.Commands\.GetContentCommand/);

  assert.equal(run('Get-Location').stdout, '\nPath\n----\nC:\\Users\\Student\n');
  assert.equal(run('pwd').stdout, run('gl').stdout);
  run('cd Desktop');
  assert.equal(run.cwd(), 'C:\\Users\\Student\\Desktop');
  assert.match(run('Set-Location nowhere').stderr, /^Set-Location : Cannot find path/);
  assert.match(run('gci -Bogus').stderr, /A parameter cannot be found that matches parameter name 'Bogus'/);
});

test('PowerShell: New-Item, Copy-Item, Remove-Item, Write-Output', () => {
  const run = windowsSession('powershell');
  assert.match(run('mkdir Reports').stdout, /Directory: C:\\Users\\Student[\s\S]*Reports$/m);
  assert.equal(node(run, 'C:\\Users\\Student\\Reports')?.type, 'directory');
  assert.match(run('mkdir Reports').stderr, /An item with the specified name C:\\Users\\Student\\Reports already exists/);
  run('New-Item -ItemType File -Path Reports\\a.txt -Value hello');
  assert.equal(node(run, 'C:\\Users\\Student\\Reports\\a.txt')?.content, 'hello');
  const selfCopy = run('Copy-Item Reports Reports\\inner -Recurse');
  assert.equal(selfCopy.exitCode, 1);
  assert.match(selfCopy.stderr, /into itself or a subdirectory/);
  assert.equal(node(run, 'C:\\Users\\Student\\Reports\\inner'), null, 'reject before creating the destination');
  run('Copy-Item Reports\\a.txt b.txt');
  assert.equal(node(run, 'C:\\Users\\Student\\b.txt')?.content, 'hello');
  assert.match(run('Remove-Item Reports').stdout, /has children and the Recurse parameter was not specified/);
  assert.ok(node(run, 'C:\\Users\\Student\\Reports'));
  assert.match(run('Remove-Item Reports -Recurse:$false').stdout, /Recurse parameter was not specified/);
  assert.ok(node(run, 'C:\\Users\\Student\\Reports'), 'an explicit false switch is not recursive');
  run('Remove-Item Reports -Recurse');
  assert.equal(node(run, 'C:\\Users\\Student\\Reports'), null);
  run('New-Item -ItemType File -Path a.txt');
  const nested = run('New-Item -ItemType File -Path a.txt\\b.txt');
  assert.equal(nested.exitCode, 1);
  assert.match(nested.stderr, /Could not find a part of the path/);
  assert.equal(run('echo a b').stdout, 'a\nb', 'Write-Output prints one item per line');
  const denied = windowsSession('powershell', STUDENT)('New-Item C:\\Windows\\x.txt');
  assert.match(denied.stderr, /Access to the path 'C:\\Windows\\x\.txt' is denied/);
  assert.ok(denied.explanation);
});

test('PowerShell recursive file operations honor protected profile boundaries', () => {
  const listing = windowsSession('powershell', STUDENT);
  createNode(listing.fs(), 'C:\\Users\\Administrator\\secret.txt', 'file', 'private', true, 'Administrator', 'Administrators', 600);
  const listed = listing('Get-ChildItem C:\\Users -Recurse -Name');
  assert.equal(listed.exitCode, 1);
  assert.ok(listed.stdout.includes('Student\\Desktop\\TroubleTicket.txt'));
  assert.ok(!listed.stdout.includes('Administrator\\secret.txt'));
  assert.match(listed.stderr, /Access to the path 'C:\\Users\\Administrator' is denied/);
  assert.match(listed.explanation ?? '', /belongs to another account/);

  const copy = windowsSession('powershell', STUDENT);
  createNode(copy.fs(), 'C:\\Users\\Administrator\\secret.txt', 'file', 'private', true, 'Administrator', 'Administrators', 600);
  const copied = copy('Copy-Item C:\\Users C:\\Logs\\user-copy -Recurse');
  assert.equal(copied.exitCode, 1);
  assert.equal(node(copy, 'C:\\Logs\\user-copy\\Administrator\\secret.txt'), null);
  assert.match(copied.explanation ?? '', /belongs to another account/);

  const remove = windowsSession('powershell', STUDENT);
  createNode(remove.fs(), 'C:\\Users\\Administrator\\secret.txt', 'file', 'private', true, 'Administrator', 'Administrators', 600);
  const removed = remove('Remove-Item C:\\Users -Recurse');
  assert.equal(removed.exitCode, 1);
  assert.ok(node(remove, 'C:\\Users\\Administrator\\secret.txt'), 'protected profile content must remain');
  assert.match(removed.explanation ?? '', /belongs to another account/);
});

test('PowerShell: Get-Service by name, service errors, Test-NetConnection host', () => {
  const run = windowsSession('powershell');
  assert.equal(run('Get-Service W32Time').stdout, 'Status   Name               DisplayName\n------   ----               -----------\nStopped  W32Time            Windows Time');
  assert.equal(run('Get-Service -Name W32Time,Spooler').stdout.split('\n').length, 4);
  assert.equal(run('Get-Service win*').stdout.split('\n').length, 3);
  const nope = run('Get-Service nosuch');
  assert.match(nope.stderr, /^Get-Service : Cannot find any service with service name 'nosuch'\./);
  assert.match(run('Start-Service nosuch').stderr, /Cannot find any service with service name 'nosuch'/);
  const user = windowsSession('powershell', STUDENT)('Start-Service W32Time');
  assert.match(user.stderr, /cannot be started due to the following error/);
  assert.ok(user.explanation);

  // No lease yet: name resolution and ping fail
  const offline = run('Test-NetConnection 8.8.8.8');
  assert.match(offline.stdout, /PingSucceeded +: False/);
  assert.match(offline.stderr, /WARNING: Ping to 8\.8\.8\.8 failed/);
  run('ipconfig /renew');
  const tnc = run('tnc 8.8.8.8');
  assert.match(tnc.stdout, /^ComputerName +: 8\.8\.8\.8\nRemoteAddress +: 8\.8\.8\.8/);
  assert.match(tnc.stdout, /PingSucceeded +: True/);
  const port = run('Test-NetConnection dc01.corp.local -Port 389');
  assert.match(port.stdout, /RemoteAddress +: 192\.168\.1\.10\nRemotePort +: 389/);
  assert.match(port.stdout, /TcpTestSucceeded : True/);
  const blocked = windowsSession('powershell', { firewallBlockedPorts: [3389] });
  blocked('ipconfig /renew');
  blocked('ipconfig /flushdns');
  const rdp = blocked('Test-NetConnection server01 -Port 3389');
  assert.match(rdp.stderr, /WARNING: TCP connect to \(192\.168\.1\.10 : 3389\) failed/);
  assert.match(rdp.stdout, /TcpTestSucceeded +: False/);
});

test('PowerShell: own not-recognized message; CMD-only built-ins are not commands there', () => {
  const run = windowsSession('powershell');
  const res = run('foo');
  assert.match(res.stderr, /^foo : The term 'foo' is not recognized as the name of a cmdlet, function, script file, or operable program\./);
  assert.ok(!res.stderr.includes('internal or external command'));
  assert.match(run('ver').stderr, /The term 'ver' is not recognized/);
  assert.match(run('ipconfig.exe').stdout, /Windows IP Configuration/);
  assert.match(run('Get-Process lsass').stdout, /lsass$/m);
  assert.equal(run('Get-Process').stdout.split('\n').filter(l => / csrss$/.test(l)).length, 1);
  assert.match(run('Get-Process nope').stderr, /Cannot find a process with the name "nope"/);
});
