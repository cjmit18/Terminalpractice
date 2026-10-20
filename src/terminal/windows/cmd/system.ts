import { WindowsContext, WindowsResult, cmdCommands } from '../context';

// CMD system tools: whoami, hostname, tasklist, taskkill, sfc, dism, bootrec, gpupdate, gpresult, net

function tasklist(ctx: WindowsContext): WindowsResult {
  const header = 'Image Name                     PID Session Name        Session#    Mem Usage\n========================= ======== ================ =========== ============';
  const rows = [
    'System Idle Process              0 Services                   0          8 K',
    'System                           4 Services                   0        148 K',
    'smss.exe                       384 Services                   0      1,120 K',
    'csrss.exe                      540 Services                   0      4,820 K',
    'winlogon.exe                   612 Console                    1      3,480 K',
    'services.exe                   684 Services                   0      8,220 K',
    'lsass.exe                      704 Services                   0     15,800 K',
    'svchost.exe                    844 Services                   0     22,400 K',
    'explorer.exe                  2140 Console                    1     48,900 K',
  ];
  for (const p of ctx.state.processes) {
    const mem = `${(p.mem * 1024).toFixed(0)} K`;
    rows.push(`${p.command.padEnd(25, ' ')} ${p.pid.toString().padStart(8, ' ')} Console                    1 ${mem.padStart(12, ' ')}`);
  }
  return ctx.ok(`${header}\n${rows.join('\n')}`);
}

function taskkill(ctx: WindowsContext): WindowsResult {
  let pid: number | null = null;
  for (let i = 0; i < ctx.args.length; i++) {
    if (ctx.args[i].toUpperCase() === '/PID' && ctx.args[i + 1]) pid = parseInt(ctx.args[i + 1], 10);
  }
  if (pid) {
    if (ctx.state.processes.some(p => p.pid === pid)) {
      ctx.state.processes = ctx.state.processes.filter(p => p.pid !== pid);
      return ctx.ok(`SUCCESS: The process with PID ${pid} has been terminated.`);
    }
    return ctx.fail(`ERROR: The process "${pid}" not found.`, 128);
  }
  return ctx.result('ERROR: Invalid syntax. Specify /PID <pid> or /IM <imagename>.', '', 1);
}

function sfc(ctx: WindowsContext): WindowsResult {
  if (ctx.args.includes('/scannow')) {
    ctx.state.sfcRepaired = true;
    ctx.state.systemIntegrityCorrupted = false;
    return ctx.ok([
      'Beginning system scan. This process will take some time.',
      '',
      'Beginning verification phase of system scan.',
      'Verification 100% complete.',
      '',
      'Windows Resource Protection found corrupt files and successfully repaired them.',
      'For online repairs, details are included in the CBS log file located at',
      'windir\\Logs\\CBS\\CBS.log. For example C:\\Windows\\Logs\\CBS\\CBS.log.',
    ].join('\n'));
  }
  return ctx.ok('Microsoft (R) Windows (R) Resource Checker Version 6.0\nSyntax: SFC [/SCANNOW] [/VERIFYONLY] [/SCANFILE=<file>]');
}

function dism(ctx: WindowsContext): WindowsResult {
  ctx.state.dismRepaired = true;
  return ctx.ok([
    'Deployment Image Servicing and Management tool',
    'Version: 10.0.22621.1',
    '',
    'Image Version: 10.0.22621.1',
    '',
    '[==========================100.0%==========================]',
    'The restore operation completed successfully.',
    'The operation completed successfully.',
  ].join('\n'));
}

function gpresult(ctx: WindowsContext): WindowsResult {
  if (ctx.args.includes('/r') || ctx.args.includes('/R')) {
    return ctx.ok([
      'Microsoft (R) Windows (R) Operating System Group Policy Result tool v2.0',
      'Copyright (C) Microsoft Corp. 1981-2001',
      '',
      'Created On 10/19/2026 at 10:30:15 AM',
      '',
      'RSOP data for CORP\\Student on WIN-CLIENT01 : Logging Mode',
      '------------------------------------------------------------',
      '',
      'OS Configuration:            Member Workstation',
      'OS Version:                  10.0.22621',
      'Site Name:                   Default-First-Site-Name',
      'Roaming Profile:             N/A',
      'Local Profile:               C:\\Users\\Student',
      'Connected over a slow link?: No',
      '',
      'COMPUTER SETTINGS',
      '------------------',
      '    CN=WIN-CLIENT01,OU=Workstations,DC=corp,DC=local',
      '    Last time Group Policy was applied: 10/19/2026 at 10:28:44 AM',
      '    Group Policy was applied from:      dc01.corp.local',
      '    Group Policy slow link threshold:   500 kbps',
      '    Domain Name:                        CORP',
      '    Domain Type:                        Windows 2016 or later',
      '',
      '    Applied Group Policy Objects',
      '    -----------------------------',
      '        Default Domain Policy',
      '        Workstation Security Baseline GPO',
      '        BitLocker Enforcement Policy',
    ].join('\n'));
  }
  return ctx.ok('GPRESULT [/S system [/U username [/P [password]]]] [/SCOPE {user | computer}] [/R | /V | /Z] [(/X | /H) <filename> [/F]]');
}

function net(ctx: WindowsContext): WindowsResult {
  const { args, state } = ctx;
  const sub = args[0]?.toLowerCase();
  if (sub === 'user') {
    if (args.length === 1) {
      return ctx.ok([
        'User accounts for \\\\WIN-CLIENT01',
        '-------------------------------------------------------------------------------',
        'Administrator            DefaultAccount           Guest',
        'Student                  WDAGUtilityAccount',
        'The command completed successfully.',
      ].join('\n'));
    }
    if (args.includes('/add') || args.includes('/ADD')) {
      const newUsername = args[1];
      if (newUsername && !state.adUsers.find(u => u.sAMAccountName.toLowerCase() === newUsername.toLowerCase())) {
        state.adUsers.push({
          sAMAccountName: newUsername,
          givenName: newUsername,
          surname: 'User',
          displayName: `${newUsername} (Added via CLI)`,
          email: `${newUsername}@corp.local`,
          department: 'Operations',
          ou: 'OU=Users,DC=corp,DC=local',
          enabled: true,
          locked: false,
          passwordNeverExpires: false,
          memberOf: ['Domain Users'],
        });
      }
    }
  }
  return ctx.ok('The command completed successfully.');
}

cmdCommands.registerAll({
  whoami: ctx => ctx.ok(`CORP\\${ctx.state.currentUser}`),
  hostname: ctx => ctx.ok(ctx.state.hostname),
  tasklist,
  taskkill,
  sfc,
  dism,
  bootrec: ctx => ctx.ok('The operation completed successfully.'),
  gpupdate: ctx => ctx.ok([
    'Updating policy...',
    '',
    'Computer Policy update has completed successfully.',
    'User Policy update has completed successfully.',
  ].join('\n')),
  gpresult,
  net,
});
