import test from 'node:test';
import assert from 'node:assert/strict';
import { windowsSession } from './testUtils.ts';
import { executeWindowsLine } from './windowsEngine.ts';
import { WINDOWS_PBQS } from '../data/windowsPbqs.ts';

// Regression tests for the round-2 fact-check of the Windows engine (Package B, L2-* and N-* IDs).

const STUDENT = { currentUser: 'Student', currentGroup: 'Users', isRootOrAdmin: false };

test('B1 (L2-4): PowerShell parse errors stop the line, with the 5.1 ParserError block', () => {
  const run = windowsSession('powershell');
  const cases: [string, RegExp, string][] = [
    ['"unclosed', /The string is missing the terminator: "\./, 'TerminatorExpectedAtEndOfString'],
    ['{', /Missing closing '\}' in statement block or type definition\./, 'MissingEndCurlyBrace'],
    ['Get-Process |', /An empty pipe element is not allowed\./, 'EmptyPipeElement'],
    ['| Get-Process', /An empty pipe element is not allowed\./, 'EmptyPipeElement'],
    ['(Get-Service', /Missing closing '\)' in expression\./, 'MissingEndParenthesisInExpression'],
    ['Get-Service && Get-Process', /The token '&&' is not a valid statement separator in this version\./, 'InvalidEndOfLine'],
  ];
  for (const [line, message, id] of cases) {
    const res = run(line);
    assert.equal(res.exitCode, 1, line);
    assert.equal(res.stdout, '', line);
    assert.match(res.stderr, message, line);
    assert.match(res.stderr, /CategoryInfo {10}: ParserError: \(:\) \[\], ParentContainsErrorRecordException/, line);
    assert.match(res.stderr, new RegExp(`FullyQualifiedErrorId : ${id}$`), line);
  }
  // The ~ marks the place the parser stopped: after the pipe
  assert.match(run('Get-Process |').stderr, /^At line:1 char:14\n\+ Get-Process \|\n\+ {14}~\n/);
  // A parse error runs nothing, not even the part before it
  run('Start-Service W32Time; Get-Service |');
  assert.equal(run.state().services.find(s => s.name === 'W32Time')?.status, 'Stopped');
});

test('B1 (L2-4): CMD rejects operators with no command on one side', () => {
  const run = windowsSession('cmd');
  assert.deepEqual([run('|').stderr, run('|').exitCode], ['| was unexpected at this time.', 1]);
  assert.equal(run('| dir').stderr, '| was unexpected at this time.');
  assert.equal(run('dir && && ver').stderr, '&& was unexpected at this time.');
  assert.equal(run('dir |').stderr, 'The syntax of the command is incorrect.');
  assert.equal(run('dir >').stderr, 'The syntax of the command is incorrect.');
  // Quoted and escaped operators are text
  assert.equal(run('echo "a|b"').stdout, '"a|b"');
  assert.equal(run('echo a ^| b').stdout, 'a | b');
  assert.equal(run('dir 2>&1 | findstr Desktop').exitCode, 0);
});

test('B1: an internal error is reported and leaves fs, state and cwd unchanged', () => {
  const lab = WINDOWS_PBQS[0];
  const fs = structuredClone(lab.initialFs);
  // A state the engine cannot work with (no services list) makes Get-Service throw
  const state = { ...structuredClone(lab.initialState), services: undefined } as unknown as typeof lab.initialState;
  const res = executeWindowsLine('Get-Service', 'C:\\Users\\Student', fs, state, 'powershell');
  assert.equal(res.exitCode, 1);
  assert.match(res.stderr, /internal error/);
  assert.equal(res.newFs, fs);
  assert.equal(res.newState, state);
  assert.equal(res.newCwd, 'C:\\Users\\Student');
});

test('B2 (L2-12): PowerShell runs statements separated by ; in order', () => {
  const lab = WINDOWS_PBQS.find(m => m.id === 'win-pbq-powershell-automation')!;
  const run = windowsSession('powershell');
  const res = run('Start-Service W32Time; Get-Service W32Time');
  assert.equal(res.exitCode, 0);
  assert.match(res.stdout, /Running +W32Time +Windows Time/);
  const objective = lab.objectives.find(o => o.id === 'ps-start-service')!;
  assert.ok(objective.verifier(run.fs(), run.state(), { command: 'Start-Service W32Time; Get-Service W32Time', exitCode: 0, stdout: res.stdout }));

  const both = windowsSession('powershell')('Get-Location; Get-Service W32Time');
  assert.match(both.stdout, /^\nPath\n----\nC:\\Users\\Student\n/);
  assert.match(both.stdout, /Stopped +W32Time/);
  // A ; inside quotes is text, a failing statement does not stop the next, and # starts a comment
  assert.equal(windowsSession('powershell')('Write-Output "a;b"; Write-Output c').stdout, 'a;b\nc');
  const failed = windowsSession('powershell')('Get-Service nosuch; Write-Output after');
  assert.equal(failed.stdout, 'after');
  assert.match(failed.stderr, /Cannot find any service with service name 'nosuch'/);
  assert.equal(failed.exitCode, 1);
  assert.equal(windowsSession('powershell')('Get-Service W32Time # the time service').exitCode, 0);
  // cd in one statement moves the next one
  assert.match(windowsSession('powershell')('cd C:\\; Get-Location').stdout, /\nC:\\\n/);
});

test('B3 (L2-11): CMD cd.. cd\\ cd. cd/d and chdir.., PowerShell cd.. and cd\\', () => {
  const cmd = windowsSession('cmd');
  assert.equal(cmd('cd..').exitCode, 0);
  assert.equal(cmd.cwd(), 'C:\\Users');
  cmd('cd.');
  assert.equal(cmd.cwd(), 'C:\\Users');
  cmd('cd\\');
  assert.equal(cmd.cwd(), 'C:\\');
  cmd('cd/d C:\\Users\\Student');
  assert.equal(cmd.cwd(), 'C:\\Users\\Student');
  cmd('chdir..');
  assert.equal(cmd.cwd(), 'C:\\Users');
  cmd('cd\\Windows');
  assert.equal(cmd.cwd(), 'C:\\Windows');
  assert.match(cmd('cd/?').stdout, /CHDIR \[\/D\]/);

  const ps = windowsSession('powershell');
  assert.equal(ps('cd..').exitCode, 0);
  assert.equal(ps.cwd(), 'C:\\Users');
  ps('cd\\');
  assert.equal(ps.cwd(), 'C:\\');
});

test('B4 (L2-10): CMD more shows a file, and < feeds a file to a command', () => {
  const run = windowsSession('cmd');
  run('echo first line> notes.txt');
  assert.deepEqual([run('more notes.txt').stdout, run('more notes.txt').exitCode], ['first line', 0]);
  assert.equal(run('more < notes.txt').stdout, 'first line');
  assert.equal(run('more <notes.txt').stdout, 'first line');
  assert.equal(run('findstr first < notes.txt').stdout, 'first line');
  assert.equal(run('type notes.txt | more').stdout, 'first line');
  const missing = run('more nosuch.txt');
  assert.deepEqual([missing.stderr, missing.exitCode], ['Cannot access file C:\\Users\\Student\\nosuch.txt', 1]);
  const noInput = run('more < nosuch.txt');
  assert.deepEqual([noInput.stderr, noInput.exitCode], ['The system cannot find the file specified.', 1]);
  // A quoted < is text
  assert.equal(run('echo "<b>"').stdout, '"<b>"');
});

/** A session on one lab, with the objectives it has passed so far (as the lab runner checks them). */
function labRun(id: string) {
  const lab = WINDOWS_PBQS.find(m => m.id === id)!;
  let fs = structuredClone(lab.initialFs);
  let state = structuredClone(lab.initialState);
  let cwd = 'C:\\Users\\Student';
  let diskpart = false;
  const done = new Set<string>();
  const run = (line: string) => {
    const res = executeWindowsLine(line, cwd, fs, state, lab.defaultShell, diskpart);
    ({ newFs: fs, newState: state, newCwd: cwd } = res);
    diskpart = !!res.diskpartActive;
    for (const o of lab.objectives) if (o.verifier(fs, state, { command: line, exitCode: res.exitCode, stdout: res.stdout })) done.add(o.id);
    return res;
  };
  return { run, done, lab, inDiskpart: () => diskpart, state: () => state };
}

test('B5 (L2-13, N-1, N-6): diskpart keywords by prefix, diskpart.exe, /s, elevation and banner', () => {
  const dp = labRun('win-pbq-diskpart-partitioning');
  const banner = dp.run('diskpart');
  assert.match(banner.stdout, /^Microsoft DiskPart version [\d.]+\n\nCopyright \(C\) Microsoft Corporation\.\nOn computer: WIN-CLIENT01\n/);
  for (const line of ['sel dis 1', 'create part primary', 'form fs=ntfs quick', 'assi letter=E']) {
    const res = dp.run(line);
    assert.equal(res.exitCode, 0, line);
    assert.doesNotMatch(res.stdout, /ACTIVE {6}- Mark/, `${line} is not answered with the command list`);
  }
  assert.deepEqual([...dp.done].sort(), dp.lab.objectives.map(o => o.id).sort(), 'every objective passes with the short forms');
  assert.match(dp.run('lis vol').stdout, /\* Volume 2 +E +NTFS/);
  assert.match(dp.run('det dis').stdout, /Disk ID:/);
  // Two letters is too short
  assert.match(dp.run('li dis').stdout, /ACTIVE {6}- Mark/);
  dp.run('exit');

  const exe = labRun('win-pbq-diskpart-partitioning');
  assert.equal(exe.run('diskpart.exe').exitCode, 0);
  assert.ok(exe.inDiskpart());
  const script = labRun('win-pbq-diskpart-partitioning').run('diskpart /s C:\\setup.txt');
  assert.deepEqual([script.stderr, script.exitCode, !!script.diskpartActive], ['Script mode (/s) is not simulated here; type the commands at the DISKPART> prompt.', 1, false]);

  // Student's prompt is not elevated: diskpart does not start
  const student = labRun('win-000-first-steps');
  for (const line of ['diskpart', 'diskpart.exe']) {
    const res = student.run(line);
    assert.equal(res.exitCode, 5, line);
    assert.equal(student.inDiskpart(), false, line);
    assert.match(res.explanation ?? '', /User Account Control/);
  }
  assert.equal(windowsSession('cmd', STUDENT)('diskpart').exitCode, 5);
});

test('B6 (L2-5, L2-9): gpupdate checks its switches, and gpresult shows when it last ran', () => {
  const gp = labRun('win-pbq-group-policy-mgmt');
  const applied = (out: string) => [...out.matchAll(/Last time Group Policy was applied: (.*)/g)].map(m => m[1]);
  const before = gp.run('gpresult /r').stdout;
  assert.deepEqual(applied(before), ['10/19/2026 at 10:28:44 AM', '10/19/2026 at 10:29:02 AM']);
  assert.match(before, /Created on 10\/19\/2026 at 10:30:15 AM/);

  const bad = gp.run('gpupdate /forcex');
  assert.deepEqual([bad.exitCode, bad.stdout], [1, '']);
  assert.match(bad.stderr, /Invalid argument\/option - '\/forcex'/);
  assert.equal(gp.done.has('gpo-gpupdate-force'), false);
  assert.equal(gp.run('gpupdate force').exitCode, 1);

  assert.equal(gp.run('gpupdate /force').exitCode, 0);
  const after = gp.run('gpresult /r').stdout;
  assert.notDeepEqual(applied(after), applied(before));
  assert.deepEqual(applied(after), ['10/19/2026 at 10:30:19 AM', '10/19/2026 at 10:30:22 AM']);
  assert.match(after, /Created on 10\/19\/2026 at 10:30:27 AM/);
  assert.deepEqual([...gp.done].sort(), ['gpo-gpresult-r', 'gpo-gpupdate-force']);

  // /target:user refreshes only user policy; Invoke-GPUpdate refreshes too
  gp.run('gpupdate /target:user');
  assert.equal(applied(gp.run('gpresult /r').stdout)[0], '10/19/2026 at 10:30:19 AM');
  const ps = windowsSession('powershell');
  ps('Invoke-GPUpdate -Force');
  assert.deepEqual(ps.state().gpApplied, { computer: 4, user: 7 });
  assert.ok(gp.run('gpresult /v').explanation?.includes('not simulated'));
});

test('B7 (L2-18): net user /active:yes /domain clears the lockout and the disabled flag', () => {
  const ad = labRun('win-pbq-active-directory-mgmt');
  const jdoe = () => ad.state().adUsers.find(u => u.sAMAccountName === 'jdoe')!;
  assert.equal(jdoe().locked, true);
  ad.run('net user jdoe /active:no /domain');
  assert.deepEqual([jdoe().enabled, jdoe().locked], [false, true], '/active:no does not unlock');
  const res = ad.run('net user jdoe /active:yes /domain');
  assert.equal(res.exitCode, 0);
  assert.deepEqual([jdoe().enabled, jdoe().locked], [true, false]);
  assert.ok(ad.done.has(ad.lab.objectives[0].id), `${ad.lab.objectives[0].id} passes`);
});

test('B8 (L2-19): common parameters bind, -WhatIf only where supported, Get-Service aliases', () => {
  const run = windowsSession('powershell');
  assert.match(run('Get-Service -ErrorAction SilentlyContinue W32Time').stdout, /W32Time/);
  assert.equal(run('Get-Service -Verbose -OutVariable svc -ea Stop Dhcp').exitCode, 0);
  const quiet = run('Get-Service nosuch -ErrorAction SilentlyContinue');
  assert.deepEqual([quiet.stdout, quiet.stderr], ['', '']);
  assert.match(run('Get-Service nosuch -ErrorAction Stop').stderr, /Cannot find any service/);
  assert.match(run('Get-Service -ErrorAction Bogus').stderr, /Cannot convert value "Bogus" to type "System\.Management\.Automation\.ActionPreference"/);
  assert.match(run('Get-ChildItem -ErrorAction SilentlyContinue').stdout, /Desktop/);

  assert.match(run('Get-Service -WhatIf').stderr, /A parameter cannot be found that matches parameter name 'WhatIf'/);
  assert.match(run('Start-Service W32Time -WhatIf').stdout, /^What if: Performing the operation "Start-Service" on target "Windows Time \(W32Time\)"\.$/);
  assert.equal(run.state().services.find(s => s.name === 'W32Time')?.status, 'Stopped');
  const startType = run.state().services.find(s => s.name === 'W32Time')?.startType;
  assert.match(run('Set-Service W32Time -StartupType Disabled -WhatIf').stdout, /^What if:/);
  assert.equal(run.state().services.find(s => s.name === 'W32Time')?.startType, startType);
  assert.match(run('Remove-Item Desktop -WhatIf').stdout, /What if: Performing the operation "Remove Directory" on target "C:\\Users\\Student\\Desktop"/);
  assert.match(run('Get-ChildItem -Name').stdout, /^Desktop$/m, '-WhatIf removed nothing');

  assert.match(run('Get-Service -SN W32Time').stderr, /parameter name 'SN'/);
  for (const alias of ['-ServiceName W32Time', '-DS W32Time', '-SDO W32Time', '-ServicesDependedOn W32Time']) {
    assert.equal(run(`Get-Service ${alias}`).exitCode, 0, alias);
  }
  assert.doesNotMatch(run('Get-Service -S').stderr, /-SN\b/);
  // ps-get-service accepts gsv once the verifier allows it; the engine side runs it
  assert.match(run('gsv w32time').stdout, /Stopped +W32Time/);
});

test('B8 (L2-19): Get-Process uses the 5.1 columns', () => {
  const out = windowsSession('powershell')('Get-Process').stdout.split('\n');
  assert.equal(out[0], 'Handles  NPM(K)    PM(K)      WS(K)     CPU(s)     Id  SI ProcessName');
  assert.equal(out[1], '-------  ------    -----      -----     ------     --  -- -----------');
  // Each value ends under the end of its heading
  const ends = [7, 15, 24, 35, 46, 53, 57];
  for (const row of out.slice(2)) {
    for (const end of ends) assert.match(row[end - 1], /\d/, `${row} at ${end}`);
    assert.equal(row[57], ' ');
  }
});

test('B8 (L2-19): Sort-Object and Where-Object keep the Get-ChildItem view', () => {
  const run = windowsSession('powershell');
  run('New-Item a.txt -Value hello');
  run('New-Item big.txt -Value "a much longer line of text"');
  const sorted = run('Get-ChildItem | Sort-Object Length -Descending').stdout;
  assert.match(sorted, /^\n {4}Directory: C:\\Users\\Student\n\n\nMode {17}LastWriteTime {9}Length Name\n/);
  const names = [...sorted.matchAll(/^[-d][-a]---- .* (\S+)$/gm)].map(m => m[1]);
  assert.deepEqual(names.slice(0, 2), ['big.txt', 'a.txt'], 'the longer file first');
  assert.deepEqual(names.slice(2).sort(), ['Desktop', 'Documents'], 'folders (no Length) last');
  assert.match(run('Get-ChildItem | Where-Object Name -like "b*"').stdout, /-a---- .* big\.txt$/m);
  assert.match(run('Get-ChildItem | Select-Object Name').stdout, /^\nName\n----\nbig\.txt|Desktop/);
  assert.equal(run('Get-ChildItem -Name | Sort-Object -Descending').stdout.split('\n')[0], 'Documents');
});

test('B9 (L2-23): dir lists by name, /O /W /A work, unsimulated switches say so, bad ones fail', () => {
  const run = windowsSession('cmd');
  run('echo hi> zed.txt');
  run('echo a> Apple.txt');
  const names = (out: string) => [...out.matchAll(/^10\/19\/2026 .* (\S+)$/gm)].map(m => m[1]);
  assert.deepEqual(names(run('dir').stdout), ['.', '..', 'Apple.txt', 'Desktop', 'Documents', 'zed.txt']);
  assert.deepEqual(run('dir /b /o:-n').stdout.split('\n'), ['zed.txt', 'Documents', 'Desktop', 'Apple.txt']);
  assert.deepEqual(run('dir /b /o').stdout.split('\n'), ['Desktop', 'Documents', 'Apple.txt', 'zed.txt'], '/O alone: folders, then files');
  assert.match(run('dir /w').stdout, /^\[\.\] +\[\.\.\] +Apple\.txt +\[Desktop\] +\[Documents\] +zed\.txt$/m);
  assert.equal(run('dir /a /b').exitCode, 0);
  const s = run('dir /s');
  assert.deepEqual([s.exitCode, /not simulated/.test(s.explanation ?? '')], [0, true]);
  assert.deepEqual([run('dir /z').stderr, run('dir /z').exitCode], ['Invalid switch - "z".', 1]);
});

test('B9 (L2-25, N-3, N-5): ping to an unknown address times out, SFC and elevation wording', () => {
  const online = {
    interfaces: [{ name: 'Ethernet0', ip: '192.168.1.145', netmask: '255.255.255.0', mac: '00-50-56-A1-2B-3C', gateway: '192.168.1.1', dns: ['192.168.1.10'], dhcpEnabled: true, status: 'UP' as const }],
    gatewayWorking: true, dnsWorking: true,
  };
  const run = windowsSession('cmd', online);
  const lost = run('ping 10.99.99.99');
  assert.equal(lost.exitCode, 1);
  assert.equal(lost.stdout.match(/^Request timed out\.$/gm)?.length, 4);
  for (const ip of ['8.8.8.8', '1.1.1.1', '192.168.1.1', 'google.com']) assert.equal(run(`ping ${ip}`).exitCode, 0, ip);

  const sfc = windowsSession('cmd', { systemIntegrityCorrupted: true, dismRepaired: true })('sfc /scannow').stdout;
  assert.match(sfc, /successfully repaired them\.\nFor online repairs, details are included in the CBS log file located at\nwindir\\Logs\\CBS\\CBS\.log\. For example C:\\Windows\\Logs\\CBS\\CBS\.log\. For offline\nrepairs, details are included in the log file provided by the \/OFFLOGFILE flag\.$/);

  // whoami /groups shows a filtered administrator token, so the notes say "not elevated", not "standard user"
  const student = windowsSession('cmd', STUDENT);
  assert.match(student('whoami /groups').stdout, /BUILTIN\\Administrators/);
  const note = student('sfc /scannow').explanation ?? '';
  assert.match(note, /not elevated/);
  assert.doesNotMatch(note, /standard user/);
});

test('B8 (L2-19): $PWD and $HOME expand instead of echoing the name', () => {
  const run = windowsSession('powershell');
  assert.equal(run('echo $PWD').stdout, '\nPath\n----\nC:\\Users\\Student\n');
  assert.equal(run('$PWD').stdout, '\nPath\n----\nC:\\Users\\Student\n');
  assert.equal(run('"I am in $PWD"').stdout, 'I am in C:\\Users\\Student');
  assert.equal(run('Write-Output $PWD.Path').stdout, 'C:\\Users\\Student');
  assert.equal(run("Write-Output '$PWD'").stdout, '$PWD', 'single quotes are literal');
  run('cd C:\\Windows');
  run('cd $HOME');
  assert.equal(run.cwd(), `C:\\Users\\${run.state().currentUser}`);
});
