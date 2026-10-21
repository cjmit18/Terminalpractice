import { ProcessItem } from '../../../types/terminal';
import { createNode, writeFileContent } from '../../filesystem';
import { WindowsContext, WindowsResult, cmdCommands } from '../context';

// CMD system tools: whoami, hostname, ver, systeminfo, tasklist, taskkill, sfc, dism, chkdsk,
// bootrec, gpupdate, gpresult, net

const NOT_ELEVATED = (ctx: WindowsContext, what: string) =>
  `You are '${ctx.state.currentUser}', a standard user (not elevated). ${what} needs an elevated prompt: right-click Command Prompt and choose "Run as administrator".`;

/** Core processes every Windows session has; the lab's own processes come from state. */
const BASE_PROCESSES: ProcessItem[] = [
  { pid: 0, user: 'SYSTEM', cpu: 0, mem: 0.008, command: 'System Idle Process' },
  { pid: 4, user: 'SYSTEM', cpu: 0, mem: 0.145, command: 'System' },
  { pid: 384, user: 'SYSTEM', cpu: 0, mem: 1.1, command: 'smss.exe' },
  { pid: 540, user: 'SYSTEM', cpu: 0, mem: 4.7, command: 'csrss.exe' },
  { pid: 612, user: 'SYSTEM', cpu: 0, mem: 3.4, command: 'winlogon.exe' },
  { pid: 684, user: 'SYSTEM', cpu: 0, mem: 8.0, command: 'services.exe' },
  { pid: 704, user: 'SYSTEM', cpu: 0, mem: 15.4, command: 'lsass.exe' },
  { pid: 844, user: 'SYSTEM', cpu: 0, mem: 21.9, command: 'svchost.exe' },
  { pid: 2140, user: 'Student', cpu: 0, mem: 47.8, command: 'explorer.exe' },
];
const CRITICAL = new Set(['system idle process', 'system', 'smss.exe', 'csrss.exe', 'wininit.exe', 'winlogon.exe', 'services.exe', 'lsass.exe']);

/** State processes plus base processes whose PID the state does not already list. */
export function allProcesses(ctx: WindowsContext): ProcessItem[] {
  const pids = new Set(ctx.state.processes.map(p => p.pid));
  const imageName = (p: ProcessItem) => p.command.toLowerCase();
  return [
    ...BASE_PROCESSES.filter(p => !pids.has(p.pid) && !ctx.state.processes.some(s => imageName(s) === imageName(p) && imageName(p) !== 'svchost.exe')),
    ...ctx.state.processes,
  ].sort((a, b) => a.pid - b.pid);
}

function tasklist(ctx: WindowsContext): WindowsResult {
  const header = '\nImage Name                     PID Session Name        Session#    Mem Usage\n========================= ======== ================ =========== ============';
  const rows = allProcesses(ctx).map(p => {
    const session = p.user === 'SYSTEM' ? 'Services                   0' : 'Console                    1';
    const mem = `${Math.round(p.mem * 1024).toLocaleString('en-US')} K`;
    return `${p.command.padEnd(25, ' ')} ${p.pid.toString().padStart(8, ' ')} ${session} ${mem.padStart(12, ' ')}`;
  });
  return ctx.ok(`${header}\n${rows.join('\n')}`);
}

function taskkill(ctx: WindowsContext): WindowsResult {
  const args = ctx.args;
  const pids: number[] = [];
  const images: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i].toUpperCase();
    if (a === '/PID' && args[i + 1]) pids.push(parseInt(args[++i], 10));
    else if (a === '/IM' && args[i + 1]) images.push(args[++i]);
  }
  if (pids.length === 0 && images.length === 0) {
    return ctx.fail('ERROR: Invalid syntax. Neither /FI nor /PID nor /IM were specified.\nType "TASKKILL /?" for usage.', 1);
  }
  const procs = allProcesses(ctx);
  const out: string[] = [];
  const errors: string[] = [];
  let note: string | undefined;
  const kill = (p: ProcessItem, byImage: boolean) => {
    const protectedProc = CRITICAL.has(p.command.toLowerCase());
    const otherUser = !ctx.isAdmin && p.user.toLowerCase() !== ctx.state.currentUser.toLowerCase();
    if (protectedProc || otherUser) {
      errors.push(`ERROR: The process ${byImage ? `"${p.command}" ` : ''}with PID ${p.pid} could not be terminated.\nReason: Access is denied.`);
      note = protectedProc
        ? `${p.command} is a critical system process; Windows refuses to end it even for administrators.`
        : NOT_ELEVATED(ctx, `Ending a process owned by ${p.user}`);
      return;
    }
    ctx.state.processes = ctx.state.processes.filter(x => x.pid !== p.pid);
    out.push(byImage
      ? `SUCCESS: The process "${p.command}" with PID ${p.pid} has been terminated.`
      : `SUCCESS: The process with PID ${p.pid} has been terminated.`);
  };
  for (const pid of pids) {
    const p = procs.find(x => x.pid === pid);
    if (p) kill(p, false);
    else errors.push(`ERROR: The process "${pid}" not found.`);
  }
  for (const image of images) {
    const re = new RegExp(`^${image.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')}$`, 'i');
    const matches = procs.filter(p => re.test(p.command));
    if (matches.length === 0) errors.push(`ERROR: The process "${image}" not found.`);
    matches.forEach(p => kill(p, true));
  }
  const code = errors.length ? (out.length ? 255 : errors.some(e => e.includes('not found')) ? 128 : 1) : 0;
  return ctx.result(out.join('\n'), errors.join('\n'), code, note);
}

function sfc(ctx: WindowsContext): WindowsResult {
  const sw = ctx.args.map(a => a.toLowerCase());
  const scan = sw.includes('/scannow');
  const verify = sw.includes('/verifyonly');
  if (!scan && !verify) {
    return ctx.ok('Microsoft (R) Windows (R) Resource Checker Version 6.0\n\nScans the integrity of all protected system files and replaces incorrect versions with\ncorrect Microsoft versions.\n\nSFC [/SCANNOW] [/VERIFYONLY] [/SCANFILE=<file>] [/VERIFYFILE=<file>]');
  }
  if (!ctx.isAdmin) {
    return ctx.fail('You must be an administrator running a console session in order to\nuse the sfc utility.', 1, NOT_ELEVATED(ctx, 'System File Checker'));
  }
  const head = ['Beginning system scan.  This process will take some time.', '', 'Beginning verification phase of system scan.', 'Verification 100% complete.', ''];
  const corrupted = ctx.state.systemIntegrityCorrupted;
  const log = 'Details are included in the CBS.Log windir\\Logs\\CBS\\CBS.log. For example\nC:\\Windows\\Logs\\CBS\\CBS.log.';
  if (verify) {
    return ctx.ok([...head, corrupted
      ? `Windows Resource Protection found integrity violations.\n${log}`
      : 'Windows Resource Protection did not find any integrity violations.'].join('\n'));
  }
  // The scan ran (the lab objective); whether it could repair depends on the component store
  ctx.state.sfcRepaired = true;
  if (!corrupted) return ctx.ok([...head, 'Windows Resource Protection did not find any integrity violations.'].join('\n'));
  if (!ctx.state.dismRepaired) {
    // SFC repairs files from the component store; while the store is damaged it cannot
    return ctx.ok([...head, `Windows Resource Protection found corrupt files but was unable to fix some\nof them. ${log}`].join('\n'));
  }
  ctx.state.systemIntegrityCorrupted = false;
  return ctx.ok([...head, `Windows Resource Protection found corrupt files and successfully repaired\nthem. ${log}`].join('\n'));
}

function dism(ctx: WindowsContext): WindowsResult {
  const sw = ctx.args.map(a => a.toLowerCase());
  const banner = ['Deployment Image Servicing and Management tool', 'Version: 10.0.22621.1', ''];
  if (!sw.includes('/online') || !sw.includes('/cleanup-image')) {
    return ctx.result([...banner, '', 'Error: 87', '', 'The option is unknown or not supported here. Try:',
      '  DISM /Online /Cleanup-Image /CheckHealth | /ScanHealth | /RestoreHealth'].join('\n'), '', 87);
  }
  if (!ctx.isAdmin) {
    return ctx.fail([...banner, 'Error: 740', '', 'Elevated permissions are required to run DISM.', 'Use an elevated command prompt to complete these tasks.'].join('\n'),
      740, NOT_ELEVATED(ctx, 'DISM'));
  }
  const storeDamaged = ctx.state.systemIntegrityCorrupted && !ctx.state.dismRepaired;
  const image = [...banner, 'Image Version: 10.0.22621.1', ''];
  if (sw.includes('/restorehealth')) {
    ctx.state.dismRepaired = true;
    return ctx.ok([...image, '[==========================100.0%==========================]',
      'The restore operation completed successfully.', 'The operation completed successfully.'].join('\n'));
  }
  if (sw.includes('/checkhealth') || sw.includes('/scanhealth')) {
    return ctx.ok([...image, ...(sw.includes('/scanhealth') ? ['[==========================100.0%==========================]'] : []),
      storeDamaged ? 'The component store is repairable.' : 'No component store corruption detected.', 'The operation completed successfully.'].join('\n'));
  }
  return ctx.result([...image, 'Error: 87', '', 'The cleanup-image option is unknown.'].join('\n'), '', 87);
}

function chkdsk(ctx: WindowsContext): WindowsResult {
  const sw = ctx.args.filter(a => a.startsWith('/')).map(a => a.toLowerCase());
  const drive = (ctx.args.find(a => /^[a-z]:$/i.test(a)) ?? 'C:').toUpperCase();
  if (!ctx.isAdmin) {
    return ctx.fail('Access Denied as you do not have sufficient privileges or\nthe disk may be locked by another process.\nYou have to invoke this utility running in elevated mode\nand make sure the disk is unlocked.', 3,
      NOT_ELEVATED(ctx, 'CHKDSK opens the volume for direct access, which'));
  }
  const part = ctx.state.disks.flatMap(d => d.partitions).find(p => (p.driveLetter ?? '').toUpperCase() === drive);
  if (drive !== 'C:' && !part) return ctx.fail('Cannot open volume for direct access.', 3);
  if (part && part.fsType !== 'NTFS' && part.fsType !== 'FAT32') {
    return ctx.fail(`The type of the file system is RAW.\nCHKDSK is not available for RAW drives.`, 3);
  }
  const label = part?.label ?? 'Windows';
  if ((sw.includes('/f') || sw.includes('/r')) && drive === 'C:') {
    return ctx.result(['The type of the file system is NTFS.', 'Cannot lock current drive.', '',
      'Chkdsk cannot run because the volume is in use by another',
      'process.  Would you like to schedule this volume to be',
      'checked the next time the system restarts? (Y/N)'].join('\n'), '', 3);
  }
  const totalKB = Math.round((part?.sizeMB ?? 511372) * 1024);
  return ctx.ok([
    `The type of the file system is ${part?.fsType ?? 'NTFS'}.`,
    `Volume label is ${label}.`,
    '',
    ...(sw.includes('/f') ? [] : ['WARNING!  /F parameter not specified.', 'Running CHKDSK in read-only mode.', '']),
    'Stage 1: Examining basic file system structure ...',
    '  512256 file records processed.',
    'File verification completed.',
    '',
    'Stage 2: Examining file name linkage ...',
    '  640812 index entries processed.',
    'Index verification completed.',
    '',
    'Stage 3: Examining security descriptors ...',
    'Security descriptor verification completed.',
    '',
    'Windows has scanned the file system and found no problems.',
    'No further action is required.',
    '',
    ` ${totalKB.toLocaleString('en-US').padStart(15)} KB total disk space.`,
    ` ${Math.round(totalKB * 0.38).toLocaleString('en-US').padStart(15)} KB in 412883 files.`,
    ` ${Math.round(totalKB * 0.61).toLocaleString('en-US').padStart(15)} KB available on disk.`,
  ].join('\n'));
}

function systeminfo(ctx: WindowsContext): WindowsResult {
  const iface = ctx.state.interfaces[0];
  const apipa = iface?.ip.startsWith('169.254.');
  return ctx.ok([
    '',
    `Host Name:                 ${ctx.state.hostname}`,
    'OS Name:                   Microsoft Windows 11 Pro',
    'OS Version:                10.0.22621 N/A Build 22621',
    'OS Manufacturer:           Microsoft Corporation',
    'OS Configuration:          Member Workstation',
    'OS Build Type:             Multiprocessor Free',
    'Registered Owner:          CORP IT',
    'Original Install Date:     3/14/2025, 9:12:44 AM',
    'System Boot Time:          10/19/2026, 8:58:03 AM',
    'System Manufacturer:       VMware, Inc.',
    'System Model:              VMware20,1',
    'System Type:               x64-based PC',
    'Processor(s):              1 Processor(s) Installed.',
    '                           [01]: Intel64 Family 6 Model 154 Stepping 3 GenuineIntel ~2496 Mhz',
    'BIOS Version:              VMware, Inc. VMW201.00V.21805430.B64.2305221830, 5/22/2023',
    'Windows Directory:         C:\\Windows',
    'System Directory:          C:\\Windows\\system32',
    'Boot Device:               \\Device\\HarddiskVolume1',
    'System Locale:             en-us;English (United States)',
    'Time Zone:                 (UTC-05:00) Eastern Time (US & Canada)',
    'Total Physical Memory:     8,191 MB',
    'Available Physical Memory: 4,212 MB',
    'Domain:                    corp.local',
    'Logon Server:              \\\\DC01',
    'Hotfix(s):                 3 Hotfix(s) Installed.',
    '                           [01]: KB5031455',
    '                           [02]: KB5032190',
    '                           [03]: KB5032288',
    'Network Card(s):           1 NIC(s) Installed.',
    `                           [01]: Intel(R) 82574L Gigabit Network Connection`,
    `                                 Connection Name: ${iface?.name ?? 'Ethernet0'}`,
    `                                 DHCP Enabled:    ${iface?.dhcpEnabled === false ? 'No' : 'Yes'}`,
    ...(apipa ? [] : ['                                 DHCP Server:     192.168.1.10']),
    '                                 IP address(es)',
    `                                 [01]: ${iface?.ip ?? '192.168.1.145'}`,
    'Hyper-V Requirements:      A hypervisor has been detected. Features required for Hyper-V will not be displayed.',
  ].join('\n'));
}

function gpupdate(ctx: WindowsContext): WindowsResult {
  const target = ctx.args.map(a => a.toLowerCase()).find(a => a.startsWith('/target:'))?.slice(8);
  if (target && target !== 'computer' && target !== 'user') return ctx.fail(`Invalid Syntax: "${target}" is not a valid value for /Target.`);
  const lines = ['Updating policy...', ''];
  if (target !== 'user') lines.push('Computer Policy update has completed successfully.');
  if (target !== 'computer') lines.push('User Policy update has completed successfully.');
  return ctx.ok(lines.join('\n'));
}

function gpresult(ctx: WindowsContext): WindowsResult {
  const args = ctx.args;
  const lower = args.map(a => a.toLowerCase());
  const user = ctx.state.currentUser;
  const host = ctx.state.hostname;
  const scope = lower.includes('/scope') ? lower[lower.indexOf('/scope') + 1] : undefined;
  const reportIdx = lower.findIndex(a => a === '/h' || a === '/x');
  if (reportIdx >= 0) {
    const file = args[reportIdx + 1];
    if (!file) return ctx.fail('ERROR: Invalid Syntax. Value expected for \'/h\'.\nType "GPRESULT /?" for usage.');
    const abs = ctx.resolve(file);
    const existing = ctx.node(abs);
    if (existing && !lower.includes('/f')) return ctx.fail(`ERROR: The file "${file}" already exists.`);
    const why = ctx.protectedReason(abs, 'write');
    if (why) return ctx.fail('ERROR: Access is denied.', 1, why);
    const xml = lower[reportIdx] === '/x';
    const body = xml
      ? `<?xml version="1.0" encoding="utf-16"?>\n<Rsop><ComputerResults><Name>CORP\\${host}</Name><GPO><Name>Default Domain Policy</Name></GPO></ComputerResults><UserResults><Name>CORP\\${user}</Name></UserResults></Rsop>`
      : `<html><head><title>Group Policy Results - CORP\\${user} on ${host}</title></head><body><h1>CORP\\${user} on CORP\\${host}</h1><h2>Applied GPOs</h2><ul><li>Default Domain Policy</li><li>Workstation Security Baseline GPO</li><li>BitLocker Enforcement Policy</li></ul></body></html>`;
    if (existing) writeFileContent(existing, body);
    else createNode(ctx.fs, abs, 'file', body, true, user, 'Users', 644);
    return ctx.ok();
  }
  if (!lower.includes('/r') && !lower.includes('/v') && !lower.includes('/z')) {
    return ctx.ok('GPRESULT [/S system [/U username [/P [password]]]] [/SCOPE scope]\n           [/USER targetusername] [/R | /V | /Z] [(/X | /H) <filename> [/F]]');
  }
  const computer = [
    'COMPUTER SETTINGS',
    '------------------',
    `    CN=${host},OU=Workstations,DC=corp,DC=local`,
    '    Last time Group Policy was applied: 10/19/2026 at 10:28:44 AM',
    '    Group Policy was applied from:      dc01.corp.local',
    '    Group Policy slow link threshold:   500 kbps',
    '    Domain Name:                        CORP',
    '    Domain Type:                        Windows 2016 or later',
    '',
    '    Applied Group Policy Objects',
    '    -----------------------------',
    ...(ctx.state.gpos.length
      ? ctx.state.gpos.filter(g => g.status === 'Enabled').map(g => `        ${g.name}`)
      : ['        Default Domain Policy', '        Workstation Security Baseline GPO', '        BitLocker Enforcement Policy']),
  ];
  const userSection = [
    'USER SETTINGS',
    '--------------',
    `    CN=${user},CN=Users,DC=corp,DC=local`,
    '    Last time Group Policy was applied: 10/19/2026 at 10:29:02 AM',
    '    Group Policy was applied from:      dc01.corp.local',
    '',
    '    Applied Group Policy Objects',
    '    -----------------------------',
    '        Default Domain Policy',
  ];
  return ctx.ok([
    '',
    'Microsoft (R) Windows (R) Operating System Group Policy Result tool v2.0',
    '© Microsoft Corporation. All rights reserved.',
    '',
    `Created on 10/19/2026 at 10:30:15 AM`,
    '',
    `RSOP data for CORP\\${user} on ${host} : Logging Mode`,
    '-'.repeat(37 + user.length + host.length),
    '',
    'OS Configuration:            Member Workstation',
    'OS Version:                  10.0.22621',
    'Site Name:                   Default-First-Site-Name',
    'Roaming Profile:             N/A',
    `Local Profile:               C:\\Users\\${user}`,
    'Connected over a slow link?: No',
    '',
    ...(scope === 'user' ? [] : [...computer, '']),
    ...(scope === 'computer' ? [] : userSection),
  ].join('\n'));
}

function net(ctx: WindowsContext): WindowsResult {
  const { args, state } = ctx;
  const sub = args[0]?.toLowerCase();
  const isAdd = args.some(a => a.toLowerCase() === '/add');
  if ((sub === 'user' || sub === 'localgroup') && isAdd && !ctx.isAdmin) {
    return ctx.fail('System error 5 has occurred.\n\nAccess is denied.', 2, NOT_ELEVATED(ctx, 'Adding accounts or group members'));
  }
  if (sub === 'user') {
    if (args.length === 1) {
      return ctx.ok([
        `User accounts for \\\\${state.hostname}`,
        '',
        '-------------------------------------------------------------------------------',
        'Administrator            DefaultAccount           Guest',
        'Student                  WDAGUtilityAccount',
        'The command completed successfully.',
      ].join('\n'));
    }
    if (isAdd) {
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
  whoami: ctx => ctx.ok(`corp\\${ctx.state.currentUser.toLowerCase()}`),
  hostname: ctx => ctx.ok(ctx.state.hostname),
  ver: ctx => ctx.ok('\nMicrosoft Windows [Version 10.0.22621.2428]'),
  systeminfo,
  tasklist,
  taskkill,
  sfc,
  dism,
  chkdsk,
  bootrec: ctx => ctx.ok('The operation completed successfully.'),
  gpupdate,
  gpresult,
  net,
});
