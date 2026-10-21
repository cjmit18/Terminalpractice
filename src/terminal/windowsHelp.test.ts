import test from 'node:test';
import assert from 'node:assert/strict';
import { windowsSession } from './testUtils.ts';
import { cmdCommands, psCommands } from './windows/context.ts';
import { cmdDoc, psDoc, PS_DOCS } from './docs/index.ts';

test('docs: every registered CMD command and PowerShell command or alias has documentation', () => {
  const cmdMissing = cmdCommands.names().filter(n => !cmdDoc(n));
  assert.deepEqual(cmdMissing, [], `CMD commands without docs: ${cmdMissing.join(', ')}`);
  const psMissing = psCommands.names().filter(n => !psDoc(n));
  assert.deepEqual(psMissing, [], `PowerShell commands without docs: ${psMissing.join(', ')}`);
  for (const d of PS_DOCS) {
    assert.ok(psCommands.has(d.name), `${d.name} is documented but not registered`);
    for (const a of d.aliases) assert.ok(psCommands.has(a), `alias ${a} of ${d.name} is not registered`);
  }
});

test('CMD help lists commands and HELP <cmd> / <cmd> /? print usage without running', () => {
  const run = windowsSession('cmd');
  const list = run('help');
  assert.equal(list.exitCode, 0);
  assert.match(list.stdout, /^For more information on a specific command, type HELP command-name/);
  assert.match(list.stdout, /\r\nDIR {12}Displays a list of files and subdirectories in a directory\./);
  assert.match(list.stdout, /\r\nTASKLIST {7}/);
  assert.equal(run('help dir').stdout, run('dir /?').stdout);
  assert.match(run('dir /?').stdout, /^Displays a list of files and subdirectories in a directory\.\n\nDIR \[drive:\]/);

  const ipconfig = run('ipconfig /?');
  assert.equal(ipconfig.exitCode, 0);
  assert.match(ipconfig.stdout, /^USAGE:\n\n {4}ipconfig \[\/allcompartments\]/);
  assert.doesNotMatch(ipconfig.stdout, /IPv4 Address/);
  assert.equal(run('ipconfig/?').stdout, ipconfig.stdout);
  const notInHelp = run('help ipconfig');
  assert.equal(notInHelp.stderr, 'This command is not supported by the help utility.  Try "ipconfig /?".');

  // del /? must not delete anything; mkdir /? must not create a directory
  const before = JSON.stringify(run.fs());
  assert.match(run('del /? *.*').stdout, /^Deletes one or more files\./);
  assert.match(run('mkdir /?').stdout, /^Creates a directory\./);
  assert.equal(JSON.stringify(run.fs()), before);

  assert.match(run('net user /?').stdout, /^The syntax of this command is:\n\nNET USER/);
  assert.match(run('net /?').stdout, /LOCALGROUP/);
  assert.match(run('dism /online /cleanup-image /?').stdout, /\/RestoreHealth/);
  assert.match(run('echo /?').stdout, /^Displays messages/);
  assert.match(run('diskpart /?').stdout, /DISKPART \[\/S script\]/);
  assert.equal(run('nosuch /?').exitCode, 9009);
});

test('DiskPart has its own HELP', () => {
  const run = windowsSession('cmd');
  run('diskpart');
  const list = run('help');
  assert.match(list.stdout, /^\nMicrosoft DiskPart version 10\.0/);
  assert.match(list.stdout, /\nLIST {8}- List disks, partitions or volumes\./);
  assert.ok(run('help').diskpartActive !== false);
  assert.match(run('help format').stdout, /FS=<FS>/);
  assert.match(run('list /?').stdout, /LIST VOLUME/);
  assert.match(run('frobnicate').stdout, /SELECT {6}- /, 'unknown commands show the command list');
  assert.equal(run('exit').stdout, 'Leaving DiskPart...');
});

test('PowerShell Get-Help, help/man aliases and -?', () => {
  const run = windowsSession('powershell');
  const help = run('Get-Help Get-Service');
  assert.equal(help.exitCode, 0);
  const text = help.stdout;
  for (const h of ['NAME', 'SYNOPSIS', 'SYNTAX', 'DESCRIPTION', 'RELATED LINKS', 'REMARKS']) assert.match(text, new RegExp(`\\n${h}\\n`));
  assert.match(text, /\nNAME\n {4}Get-Service\n\nSYNOPSIS\n {4}Gets the services/);
  assert.match(text, /Get-Service \[\[-Name\] <String\[\]>\]/);
  assert.equal(run('help Get-Service').stdout, text);
  assert.equal(run('man gsv').stdout, text);
  assert.equal(run('Get-Service -?').stdout, text);
  // -? shows help and does not stop anything
  const services = JSON.stringify(run.state().services);
  assert.match(run('Stop-Service Spooler -?').stdout, /NAME\n {4}Stop-Service/);
  assert.equal(JSON.stringify(run.state().services), services);

  const ex = run('Get-Help Get-Service -Examples').stdout;
  assert.match(ex, /Example 1: Every service/);
  assert.doesNotMatch(ex, /SYNTAX/);
  assert.match(run('Get-Help Get-Process -Detailed').stdout, /\nPARAMETERS\n {4}-Name <String\[\]>/);
  assert.match(run('Get-Help Get-Process -Full').stdout, /Required\? +false/);
  assert.match(run('Get-Help Get-Process -Parameter Id').stdout, /-Id <Int32\[\]>/);
  assert.match(run('Get-Help').stdout, /TOPIC\n {4}Windows PowerShell Help System/);
  assert.match(run('Get-Help *item*').stdout, /New-Item +Cmdlet/);
  const none = run('Get-Help nosuch');
  assert.equal(none.exitCode, 1);
  assert.match(none.stderr, /^Get-Help : Get-Help could not find nosuch/);
  assert.match(run('ipconfig /?').stdout, /^USAGE:/);
});

test('PowerShell Get-Command lists commands with wildcards, verbs and nouns', () => {
  const run = windowsSession('powershell');
  const all = run('Get-Command');
  assert.match(all.stdout, /^\nCommandType {5}Name {47}Version {4}Source\n-{11} {5}-{4}/);
  assert.match(all.stdout, /\nAlias {11}gsv -> Get-Service {33}3\.1\.0\.0 {4}Microsoft\.PowerShell\.Management/);
  assert.match(all.stdout, /\nCmdlet {10}Get-Help {43}3\.0\.0\.0 {4}Microsoft\.PowerShell\.Core/);
  const svc = run('Get-Command *service*').stdout.split('\n').filter(l => l.startsWith('Cmdlet')).map(l => l.split(/\s+/)[1]);
  assert.deepEqual(svc, ['Get-Service', 'New-Service', 'Restart-Service', 'Resume-Service', 'Set-Service', 'Start-Service', 'Stop-Service', 'Suspend-Service']);
  assert.match(run('Get-Command ls').stdout, /Alias {11}ls -> Get-ChildItem/);
  assert.match(run('Get-Command ipconfig').stdout, /Application {5}ipconfig\.exe/);
  assert.match(run('Get-Command -Noun Process').stdout, /Stop-Process/);
  assert.doesNotMatch(run('Get-Command -Verb Stop').stdout, /Get-/);
  assert.match(run('gcm Get-Help').stdout, /Get-Help/);
  const none = run('Get-Command nosuch');
  assert.equal(none.exitCode, 1);
  assert.match(none.stderr, /CommandNotFoundException,Microsoft\.PowerShell\.Commands\.GetCommandCommand/);
  assert.equal(run('Get-Command *nomatch*').stdout, '');
});
