import { ProcessItem } from '../../../types/terminal';
import { createNode, writeFileContent } from '../../filesystem';
import { WindowsContext, WindowsResult, cmdCommands } from '../context';
import { cmdDoc } from '../../docs';
import { hasConnectivity } from './network';

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
export const CRITICAL_PROCESSES = new Set(['system idle process', 'system', 'smss.exe', 'csrss.exe', 'wininit.exe', 'winlogon.exe', 'services.exe', 'lsass.exe']);
const CRITICAL = CRITICAL_PROCESSES;

/** Programs with a window: taskkill without /F asks them to close instead of refusing. */
const WINDOWED = new Set(['explorer.exe', 'notepad.exe', 'mspaint.exe', 'calc.exe', 'msedge.exe', 'chrome.exe', 'winword.exe', 'excel.exe']);

/** Services hosted by each process, for tasklist /svc. */
const PROCESS_SERVICES: Record<string, string> = {
  'lsass.exe': 'KeyIso, Netlogon, SamSs, VaultSvc',
  'services.exe': 'N/A',
  'svchost.exe': 'BrokerInfrastructure, DcomLaunch, PlugPlay, Power',
  'spoolsv.exe': 'Spooler',
};
const SVCHOST_BY_PID: Record<number, string> = {
  844: 'RpcEptMapper, RpcSs',
  1120: 'Dhcp, Dnscache, EventLog, LanmanWorkstation, Netlogon',
};

/**
 * State processes plus the base processes every session has. A base process is left out when
 * the state lists its PID or another process with the same image name (so a lab can replace it).
 */
export function allProcesses(ctx: WindowsContext): ProcessItem[] {
  // A state that lists the System Idle Process is a full process table (see endProcess)
  if (ctx.state.processes.some(p => p.pid === 0)) return [...ctx.state.processes].sort((a, b) => a.pid - b.pid);
  const pids = new Set(ctx.state.processes.map(p => p.pid));
  const imageName = (p: ProcessItem) => p.command.toLowerCase();
  return [
    ...BASE_PROCESSES.filter(p => !pids.has(p.pid) && !ctx.state.processes.some(s => imageName(s) === imageName(p))),
    ...ctx.state.processes,
  ].sort((a, b) => a.pid - b.pid);
}

/**
 * Ends a process. The process list is first copied into the state, so a base process that was
 * ended does not come back on the next listing.
 */
export function endProcess(ctx: WindowsContext, pid: number): void {
  ctx.state.processes = allProcesses(ctx).filter(p => p.pid !== pid);
}

type TaskFilter = (p: ProcessItem) => boolean;

/** Parses one /FI "NAME op value" filter. Returns null when tasklist would reject it. */
function taskFilter(text: string): TaskFilter | null {
  const m = text.trim().match(/^(\w+)\s+(eq|ne|gt|lt|ge|le)\s+(.+)$/i);
  if (!m) return null;
  const field = m[1].toUpperCase();
  const op = m[2].toLowerCase();
  const value = m[3].trim();
  const numeric = (actual: number, want: number) =>
    ({ eq: actual === want, ne: actual !== want, gt: actual > want, lt: actual < want, ge: actual >= want, le: actual <= want } as Record<string, boolean>)[op];
  const textual = op === 'eq' || op === 'ne';
  const pattern = new RegExp(`^${value.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')}$`, 'i');
  const matches = (...candidates: string[]) => candidates.some(c => pattern.test(c)) === (op === 'eq');
  switch (field) {
    case 'PID': return /^\d+$/.test(value) ? p => numeric(p.pid, Number(value)) : null;
    case 'MEMUSAGE': return /^\d+$/.test(value) ? p => numeric(Math.round(p.mem * 1024), Number(value)) : null;
    case 'IMAGENAME': return textual ? p => matches(p.command) : null;
    case 'USERNAME': return textual ? p => matches(p.user, `${p.user === 'SYSTEM' ? 'NT AUTHORITY' : 'CORP'}\\${p.user}`) : null;
    case 'STATUS': return textual ? () => matches('RUNNING') : null;
    case 'SESSIONNAME': return textual ? p => matches(p.user === 'SYSTEM' ? 'Services' : 'Console') : null;
    default: return null;
  }
}

function tasklist(ctx: WindowsContext): WindowsResult {
  const filters: TaskFilter[] = [];
  let format = 'TABLE';
  let noHeader = false;
  let svc = false;
  for (let i = 0; i < ctx.args.length; i++) {
    const a = ctx.args[i].toLowerCase();
    if (a === '/svc') { svc = true; continue; }
    if (a === '/fi') {
      const f = taskFilter(ctx.args[++i] ?? '');
      if (!f) return ctx.fail('ERROR: The search filter cannot be recognized.', 1);
      filters.push(f);
    } else if (a === '/fo') {
      format = (ctx.args[++i] ?? '').toUpperCase();
      if (!['TABLE', 'LIST', 'CSV'].includes(format)) return ctx.fail(`ERROR: Invalid argument/option - '${ctx.args[i] ?? ''}'.\nType "TASKLIST /?" for usage.`, 1);
    } else if (a === '/nh') {
      noHeader = true;
    }
  }
  const procs = allProcesses(ctx).filter(p => filters.every(f => f(p)));
  if (!procs.length) return ctx.ok('INFO: No tasks are running which match the specified criteria.');
  if (svc) {
    const services = (p: ProcessItem) => (p.command.toLowerCase() === 'svchost.exe' ? SVCHOST_BY_PID[p.pid] ?? 'BFE, mpssvc' : PROCESS_SERVICES[p.command.toLowerCase()] ?? 'N/A');
    const head = '\nImage Name                     PID Services\n========================= ======== ============================================';
    const rows = procs.map(p => `${p.command.padEnd(25)} ${String(p.pid).padStart(8)} ${services(p)}`);
    return ctx.ok(noHeader ? `\n${rows.join('\n')}` : `${head}\n${rows.join('\n')}`);
  }
  const session = (p: ProcessItem) => (p.user === 'SYSTEM' ? ['Services', '0'] : ['Console', '1']);
  const mem = (p: ProcessItem) => `${Math.round(p.mem * 1024).toLocaleString('en-US')} K`;
  if (format === 'CSV') {
    const rows = procs.map(p => [p.command, String(p.pid), ...session(p), mem(p)].map(v => `"${v}"`).join(','));
    return ctx.ok([...(noHeader ? [] : ['"Image Name","PID","Session Name","Session#","Mem Usage"']), ...rows].join('\n'));
  }
  if (format === 'LIST') {
    return ctx.ok(procs.map(p => [
      '', `Image Name:   ${p.command}`, `PID:          ${p.pid}`, `Session Name: ${session(p)[0]}`, `Session#:     ${session(p)[1]}`, `Mem Usage:    ${mem(p)}`,
    ].join('\n')).join('\n'));
  }
  const header = '\nImage Name                     PID Session Name        Session#    Mem Usage\n========================= ======== ================ =========== ============';
  const rows = procs.map(p => {
    const [name, num] = session(p);
    return `${p.command.padEnd(25, ' ')} ${p.pid.toString().padStart(8, ' ')} ${name.padEnd(16)} ${num.padStart(11)} ${mem(p).padStart(12, ' ')}`;
  });
  return ctx.ok(noHeader ? `\n${rows.join('\n')}` : `${header}\n${rows.join('\n')}`);
}

function taskkill(ctx: WindowsContext): WindowsResult {
  const args = ctx.args;
  const pids: string[] = [];
  const images: string[] = [];
  let force = false;
  let tree = false;
  for (let i = 0; i < args.length; i++) {
    const a = args[i].toUpperCase();
    if (a === '/PID' || a === '-PID') {
      const v = args[++i];
      if (v === undefined) return ctx.fail("ERROR: Invalid syntax. Value expected for '/PID'.\nType \"TASKKILL /?\" for usage.", 1);
      pids.push(v);
    } else if (a === '/IM' || a === '-IM') {
      const v = args[++i];
      if (v === undefined) return ctx.fail("ERROR: Invalid syntax. Value expected for '/IM'.\nType \"TASKKILL /?\" for usage.", 1);
      images.push(v);
    } else if (a === '/F' || a === '-F') force = true;
    else if (a === '/T' || a === '-T') tree = true;
    else if (a === '/FI' || a === '/S' || a === '/U' || a === '/P') i++;
    else return ctx.fail(`ERROR: Invalid argument/option - '${args[i]}'.\nType "TASKKILL /?" for usage.`, 1);
  }
  void tree;
  if (pids.length === 0 && images.length === 0) {
    return ctx.fail('ERROR: Invalid syntax. Neither /FI nor /PID nor /IM were specified.\nType "TASKKILL /?" for usage.', 1);
  }
  const procs = allProcesses(ctx);
  const out: string[] = [];
  const errors: string[] = [];
  let note: string | undefined;
  const kill = (p: ProcessItem, byImage: boolean) => {
    const who = `The process ${byImage ? `"${p.command}" ` : ''}with PID ${p.pid}`;
    const protectedProc = CRITICAL.has(p.command.toLowerCase());
    const otherUser = !ctx.isAdmin && p.user.toLowerCase() !== ctx.state.currentUser.toLowerCase();
    if (protectedProc || otherUser) {
      errors.push(`ERROR: ${who} could not be terminated.\nReason: Access is denied.`);
      note = protectedProc
        ? `${p.command} is a critical system process; Windows refuses to end it even for administrators.`
        : NOT_ELEVATED(ctx, `Ending a process owned by ${p.user}`);
      return;
    }
    if (!force) {
      // Without /F, taskkill asks the program to close; a process with no window cannot be asked
      if (WINDOWED.has(p.command.toLowerCase())) {
        endProcess(ctx, p.pid);
        out.push(`SUCCESS: Sent termination signal to the ${byImage ? `process "${p.command}" with PID ${p.pid}` : `process with PID ${p.pid}`}.`);
        return;
      }
      errors.push(`ERROR: ${who} could not be terminated.\nReason: This process can only be terminated forcefully (with /F option).`);
      note = `${p.command} has no window to close, so taskkill can only end it with /F (force).`;
      return;
    }
    endProcess(ctx, p.pid);
    out.push(byImage
      ? `SUCCESS: The process "${p.command}" with PID ${p.pid} has been terminated.`
      : `SUCCESS: The process with PID ${p.pid} has been terminated.`);
  };
  for (const pidText of pids) {
    const p = /^\d+$/.test(pidText) ? procs.find(x => x.pid === Number(pidText)) : undefined;
    if (p) kill(p, false);
    else errors.push(`ERROR: The process "${pidText}" not found.`);
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
  // The scan ran; whether it could repair depends on the component store
  ctx.state.sfcScanned = true;
  if (!corrupted) {
    ctx.state.sfcRepaired = true;
    return ctx.ok([...head, 'Windows Resource Protection did not find any integrity violations.'].join('\n'));
  }
  if (!ctx.state.dismRepaired) {
    // SFC repairs files from the component store; while the store is damaged it cannot
    return ctx.result([...head, `Windows Resource Protection found corrupt files but was unable to fix some\nof them. ${log}`].join('\n'), '', 0,
      'SFC takes its replacement files from the component store (WinSxS), which is damaged too. Repair the store with DISM /Online /Cleanup-Image /RestoreHealth, then run sfc /scannow again.');
  }
  ctx.state.sfcRepaired = true;
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

const BUILTIN_LOCAL_USERS = ['Administrator', 'DefaultAccount', 'Guest', 'Student', 'WDAGUtilityAccount'];
const DISABLED_BUILTINS = new Set(['DefaultAccount', 'Guest', 'WDAGUtilityAccount']);
const DEFAULT_LOCAL_GROUPS: Record<string, { comment: string; members: string[] }> = {
  Administrators: { comment: 'Administrators have complete and unrestricted access to the computer/domain', members: ['Administrator', 'CORP\\Domain Admins', 'Student'] },
  'Backup Operators': { comment: 'Backup Operators can override security restrictions for the sole purpose of backing up or restoring files', members: [] },
  Guests: { comment: 'Guests have the same access as members of the Users group by default, except for the Guest account which is further restricted', members: ['Guest'] },
  'Remote Desktop Users': { comment: 'Members in this group are granted the right to logon remotely', members: [] },
  Users: { comment: 'Users are prevented from making accidental or intentional system-wide changes and can run most applications', members: ['CORP\\Domain Users', 'NT AUTHORITY\\Authenticated Users', 'NT AUTHORITY\\INTERACTIVE'] },
};
const RULE = '-------------------------------------------------------------------------------';
const DONE = 'The command completed successfully.';
const helpMsg = (n: number) => `\n\nMore help is available by typing NET HELPMSG ${n}.`;
const DENIED = 'System error 5 has occurred.\n\nAccess is denied.';
const DC_NOTE = 'The request will be processed at a domain controller for domain corp.local.';

const localUsers = (ctx: WindowsContext) => [...BUILTIN_LOCAL_USERS, ...(ctx.state.localUsers ?? [])];
function localGroups(ctx: WindowsContext): Record<string, string[]> {
  return ctx.state.localGroups ?? Object.fromEntries(Object.entries(DEFAULT_LOCAL_GROUPS).map(([g, v]) => [g, [...v.members]]));
}
const findName = (names: string[], wanted: string) => names.find(n => n.toLowerCase() === wanted.toLowerCase());

/** Three names per row, as net user lists accounts. */
function threeColumns(names: string[]): string[] {
  const rows: string[] = [];
  for (let i = 0; i < names.length; i += 3) rows.push(names.slice(i, i + 3).map(n => n.padEnd(25)).join('').trimEnd());
  return rows;
}

/** A table as whoami prints it: headers, a row of = under each column, then the rows. */
function whoamiTable(title: string, headers: string[], rows: string[][]): string {
  const widths = headers.map((h, i) => Math.max(h.length, ...rows.map(r => r[i].length)));
  const line = (cells: string[]) => cells.map((c, i) => (i === cells.length - 1 ? c : c.padEnd(widths[i]))).join(' ').trimEnd();
  return ['', title, '-'.repeat(title.length), '', line(headers), widths.map(w => '='.repeat(w)).join(' '), ...rows.map(line)].join('\n');
}

const PRIVILEGES: [string, string, boolean][] = [
  ['SeIncreaseQuotaPrivilege', 'Adjust memory quotas for a process', true],
  ['SeSecurityPrivilege', 'Manage auditing and security log', true],
  ['SeTakeOwnershipPrivilege', 'Take ownership of files or other objects', true],
  ['SeLoadDriverPrivilege', 'Load and unload device drivers', true],
  ['SeSystemtimePrivilege', 'Change the system time', true],
  ['SeBackupPrivilege', 'Back up files and directories', true],
  ['SeRestorePrivilege', 'Restore files and directories', true],
  ['SeShutdownPrivilege', 'Shut down the system', false],
  ['SeDebugPrivilege', 'Debug programs', true],
  ['SeChangeNotifyPrivilege', 'Bypass traverse checking', false],
  ['SeUndockPrivilege', 'Remove computer from docking station', false],
  ['SeManageVolumePrivilege', 'Perform volume maintenance tasks', true],
  ['SeImpersonatePrivilege', 'Impersonate a client after authentication', true],
  ['SeCreateGlobalPrivilege', 'Create global objects', true],
  ['SeIncreaseWorkingSetPrivilege', 'Increase a process working set', false],
  ['SeTimeZonePrivilege', 'Change the time zone', false],
  ['SeCreateSymbolicLinkPrivilege', 'Create symbolic links', true],
];
const ENABLED_PRIVS = new Set(['SeChangeNotifyPrivilege', 'SeImpersonatePrivilege', 'SeCreateGlobalPrivilege']);

function whoami(ctx: WindowsContext): WindowsResult {
  const sw = ctx.args.map(a => a.toLowerCase().replace(/^-/, '/'));
  const user = ctx.state.currentUser;
  const account = `corp\\${user.toLowerCase()}`;
  const ridOf = (n: string) => (n.toLowerCase() === 'administrator' ? 500 : 1100 + [...n.toLowerCase()].reduce((s, c) => s + c.charCodeAt(0), 0));
  const domainSid = 'S-1-5-21-3623811015-3361044348-30300820';
  const unknown = sw.find(s => !['/upn', '/fqdn', '/logonid', '/user', '/groups', '/priv', '/all', '/fo', 'table', 'list', 'csv', '/nh'].includes(s));
  if (unknown) return ctx.fail(`ERROR: Invalid argument/option - '${unknown}'.\nType "WHOAMI /?" for usage.`, 1);
  if (!sw.length) return ctx.ok(account);
  if (sw.includes('/upn')) return ctx.ok(`${user.toLowerCase()}@corp.local`);
  if (sw.includes('/fqdn')) return ctx.ok(`CN=${user},CN=Users,DC=corp,DC=local`);
  if (sw.includes('/logonid')) return ctx.ok('S-1-5-5-0-318214');
  const all = sw.includes('/all');
  const elevated = ctx.isAdmin;
  const localAdmin = elevated || (localGroups(ctx).Administrators ?? []).some(m => m.toLowerCase() === user.toLowerCase());
  const ad = ctx.state.adUsers.find(u => u.sAMAccountName.toLowerCase() === user.toLowerCase());
  const std = 'Mandatory group, Enabled by default, Enabled group';
  const groups: string[][] = [
    ['Everyone', 'Well-known group', 'S-1-1-0', std],
    ...(localAdmin ? [['BUILTIN\\Administrators', 'Alias', 'S-1-5-32-544', elevated ? `${std}, Group owner` : 'Group used for deny only']] : []),
    ['BUILTIN\\Users', 'Alias', 'S-1-5-32-545', std],
    ['NT AUTHORITY\\INTERACTIVE', 'Well-known group', 'S-1-5-4', std],
    ['CONSOLE LOGON', 'Well-known group', 'S-1-2-1', std],
    ['NT AUTHORITY\\Authenticated Users', 'Well-known group', 'S-1-5-11', std],
    ['NT AUTHORITY\\This Organization', 'Well-known group', 'S-1-5-15', std],
    ['LOCAL', 'Well-known group', 'S-1-2-0', std],
    ...(ad?.memberOf ?? []).filter(g => g !== 'Domain Users').map(g => [`CORP\\${g}`, 'Group', `${domainSid}-${g === 'Domain Admins' ? 512 : g === 'Enterprise Admins' ? 519 : g === 'Schema Admins' ? 518 : ridOf(g)}`, std]),
    ['Authentication authority asserted identity', 'Well-known group', 'S-1-18-1', std],
    elevated ? ['Mandatory Label\\High Mandatory Level', 'Label', 'S-1-16-12288', ''] : ['Mandatory Label\\Medium Mandatory Level', 'Label', 'S-1-16-8192', ''],
  ];
  const privs = (elevated ? PRIVILEGES : PRIVILEGES.filter(p => !p[2])).map(([n, d]) => [n, d, ENABLED_PRIVS.has(n) ? 'Enabled' : 'Disabled']);
  const parts: string[] = [];
  if (all || sw.includes('/user')) parts.push(whoamiTable('USER INFORMATION', ['User Name', 'SID'], [[account, `${domainSid}-${ridOf(user)}`]]));
  if (all || sw.includes('/groups')) parts.push(whoamiTable('GROUP INFORMATION', ['Group Name', 'Type', 'SID', 'Attributes'], groups));
  if (all || sw.includes('/priv')) parts.push(whoamiTable('PRIVILEGES INFORMATION', ['Privilege Name', 'Description', 'State'], privs));
  if (all) parts.push(['', 'USER CLAIMS INFORMATION', '-----------------------', '', 'User claims unknown.', '', 'Kerberos support for Dynamic Access Control on this device has been disabled.'].join('\n'));
  return ctx.ok(parts.join('\n\n'));
}

/** Mapped network drives, kept as hidden =NetUse:Z: entries in state.envVars. */
const NET_USE_PREFIX = '=NetUse:';
const mappedDrives = (ctx: WindowsContext): [string, string][] =>
  Object.entries(ctx.state.envVars ?? {}).filter(([k]) => k.startsWith(NET_USE_PREFIX)).map(([k, v]) => [k.slice(NET_USE_PREFIX.length), v] as [string, string])
    .sort(([a], [b]) => a.localeCompare(b));

/** net use: list, map (net use Z: \\server\share or net use * ...) and /delete network drives. */
function netUse(ctx: WindowsContext, rest: string[]): WindowsResult {
  const switches = rest.filter(a => a.startsWith('/')).map(a => a.toLowerCase());
  const operands = rest.filter(a => !a.startsWith('/'));
  const vars = { ...(ctx.state.envVars ?? {}) };
  const drives = mappedDrives(ctx);
  if (!operands.length) {
    if (!drives.length) return ctx.ok('New connections will be remembered.\n\nThere are no entries in the list.\n');
    return ctx.ok(['New connections will be remembered.', '', '', 'Status       Local     Remote                    Network', '', RULE,
      ...drives.map(([d, r]) => `OK           ${d.padEnd(10)}${r.padEnd(26)}Microsoft Windows Network`), DONE].join('\n'));
  }
  const local = operands[0].toUpperCase();
  if (switches.includes('/delete') || switches.includes('/d')) {
    const hit = local === '*' ? drives : drives.filter(([d, r]) => d === local || r.toLowerCase() === operands[0].toLowerCase());
    if (!hit.length) return ctx.fail(`The network connection could not be found.${helpMsg(2250)}`, 2);
    for (const [d] of hit) delete vars[`${NET_USE_PREFIX}${d}`];
    ctx.state.envVars = vars;
    return ctx.ok(hit.map(([d]) => `${d} was deleted successfully.`).join('\n\n'));
  }
  const remote = operands.find(o => o.startsWith('\\\\'));
  if (!remote) return ctx.fail(`The syntax of this command is:\n\nNET USE\n[devicename | *] [\\\\computername\\sharename[\\volume] [password | *]]\n        [/USER:[domainname\\]username]\n        [[/DELETE] | [/PERSISTENT:{YES | NO}]]${helpMsg(3506)}`, 1);
  if (!hasConnectivity(ctx)) return ctx.fail('System error 53 has occurred.\n\nThe network path was not found.', 2);
  // net use \\server\share with no drive letter connects without mapping a drive
  if (local !== '*' && !/^[A-Z]:$/.test(local)) return ctx.ok(DONE);
  const used = new Set([...drives.map(([d]) => d), ...ctx.state.disks.flatMap(d => d.partitions).map(p => (p.driveLetter ?? '').toUpperCase()).filter(Boolean), 'C:']);
  const letter = local === '*' ? [...'ZYXWVUTSRQPONMLKJIHGFED'].map(c => `${c}:`).find(c => !used.has(c)) ?? '' : local;
  if (used.has(letter)) return ctx.fail('System error 85 has occurred.\n\nThe local device name is already in use.', 2);
  vars[`${NET_USE_PREFIX}${letter}`] = remote;
  ctx.state.envVars = vars;
  return ctx.ok(local === '*' ? `Drive ${letter} is now connected to ${remote}.\n\n${DONE}` : DONE);
}

const PASSWORD_POLICY = `The password does not meet the password policy requirements. Check the minimum password length, password complexity and password history requirements.${helpMsg(2245)}`;

/** net user NAME [password] /add | /delete | /active:yes|no /domain: changes Active Directory. */
function netUserDomainChange(ctx: WindowsContext, operands: string[], switches: string[], active: string | undefined): WindowsResult {
  const { state } = ctx;
  const name = operands[0];
  if (!name) return ctx.fail(cmdDoc('net')!.topics!.user, 1);
  if (!ctx.isAdmin) return ctx.fail(`${DC_NOTE}\n\n${DENIED}`, 2, NOT_ELEVATED(ctx, 'Changing domain accounts'));
  const existing = state.adUsers.find(u => u.sAMAccountName.toLowerCase() === name.toLowerCase());
  if (switches.includes('/add')) {
    if (existing) return ctx.fail(`${DC_NOTE}\n\nThe account already exists.${helpMsg(2224)}`, 2);
    const password = operands[1];
    // A blank password fails the default domain policy
    if (!password) return ctx.fail(`${DC_NOTE}\n\n${PASSWORD_POLICY}`, 2);
    state.adUsers.push({
      sAMAccountName: name, givenName: '', surname: '', displayName: name, email: '', department: '',
      ou: 'CN=Users,DC=corp,DC=local', enabled: !/^\/active:no$/.test(active ?? ''), locked: false, passwordNeverExpires: false, memberOf: ['Domain Users'],
    });
    const du = state.adGroups.find(g => g.name.toLowerCase() === 'domain users');
    if (du && !du.members.includes(name)) du.members.push(name);
    return ctx.ok(`${DC_NOTE}\n\n${DONE}`);
  }
  if (!existing) return ctx.fail(`${DC_NOTE}\n\nThe user name could not be found.${helpMsg(2221)}`, 2);
  if (switches.includes('/delete')) {
    state.adUsers = state.adUsers.filter(u => u !== existing);
    for (const g of state.adGroups) g.members = g.members.filter(m => m.toLowerCase() !== name.toLowerCase());
    return ctx.ok(`${DC_NOTE}\n\n${DONE}`);
  }
  const value = active!.split(':')[1]?.toLowerCase();
  if (value !== undefined && value !== 'yes' && value !== 'no') return ctx.fail(`${cmdDoc('net')!.topics!.user}${helpMsg(3505)}`, 1);
  existing.enabled = value !== 'no';
  return ctx.ok(`${DC_NOTE}\n\n${DONE}`);
}

/** net group: domain groups, which only a domain controller (or /domain) can show or change. */
function netGroup(ctx: WindowsContext, rest: string[]): WindowsResult {
  const switches = rest.filter(a => a.startsWith('/')).map(a => a.toLowerCase());
  const operands = rest.filter(a => !a.startsWith('/'));
  const { state } = ctx;
  if (!switches.includes('/domain')) {
    return ctx.fail(`This command can be used only on a Windows Domain Controller.${helpMsg(3515)}`, 2, 'This PC is a domain member, not a domain controller. Add /domain to send the request to the domain controller.');
  }
  if (!operands.length) {
    return ctx.ok([DC_NOTE, '', '', 'Group Accounts for \\\\DC01', '', RULE, ...state.adGroups.map(g => `*${g.name}`), DONE].join('\n'));
  }
  const group = state.adGroups.find(g => g.name.toLowerCase() === operands[0].toLowerCase());
  if (!group) return ctx.fail(`${DC_NOTE}\n\nThe group name could not be found.${helpMsg(2220)}`, 2);
  const add = switches.includes('/add');
  const del = switches.includes('/delete');
  if (add || del) {
    if (!ctx.isAdmin) return ctx.fail(`${DC_NOTE}\n\n${DENIED}`, 2, NOT_ELEVATED(ctx, 'Changing domain group membership'));
    const users = operands.slice(1);
    if (!users.length) return ctx.fail(`${DC_NOTE}\n\n${add ? 'The group already exists.' : 'The group cannot be deleted from here.'}${helpMsg(add ? 2223 : 2220)}`, 2);
    for (const name of users) {
      const u = state.adUsers.find(x => x.sAMAccountName.toLowerCase() === name.toLowerCase());
      if (!u) return ctx.fail(`${DC_NOTE}\n\nThere is no such global user or group: ${name}.${helpMsg(3783)}`, 2);
      const has = group.members.some(m => m.toLowerCase() === u.sAMAccountName.toLowerCase()) || u.memberOf.some(g => g.toLowerCase() === group.name.toLowerCase());
      if (add) {
        if (has) return ctx.fail(`${DC_NOTE}\n\nSystem error 1320 has occurred.\n\nThe specified account name is already a member of the group.`, 2);
        group.members.push(u.sAMAccountName);
        u.memberOf.push(group.name);
      } else {
        if (!has) return ctx.fail(`${DC_NOTE}\n\nSystem error 1321 has occurred.\n\nThe specified user account is not a member of the specified group account.`, 2);
        group.members = group.members.filter(m => m.toLowerCase() !== u.sAMAccountName.toLowerCase());
        u.memberOf = u.memberOf.filter(g => g.toLowerCase() !== group.name.toLowerCase());
      }
    }
    return ctx.ok(`${DC_NOTE}\n\n${DONE}`);
  }
  const members = [...new Set([...group.members, ...state.adUsers.filter(u => u.memberOf.includes(group.name)).map(u => u.sAMAccountName)])];
  return ctx.ok([DC_NOTE, '', `Group name     ${group.name}`, `Comment        ${group.description}`, '', 'Members', '', RULE, ...threeColumns(members), DONE].join('\n'));
}

function netUser(ctx: WindowsContext, rest: string[]): WindowsResult {
  const switches = rest.filter(a => a.startsWith('/')).map(a => a.toLowerCase());
  const operands = rest.filter(a => !a.startsWith('/'));
  const domain = switches.includes('/domain');
  const { state } = ctx;
  const active = switches.find(s => s.startsWith('/active'));
  if (domain && (switches.includes('/add') || switches.includes('/delete') || active)) return netUserDomainChange(ctx, operands, switches, active);
  if (active && operands[0]) {
    if (!ctx.isAdmin) return ctx.fail(DENIED, 2, NOT_ELEVATED(ctx, 'Changing an account'));
    if (!findName(localUsers(ctx), operands[0])) return ctx.fail(`The user name could not be found.${helpMsg(2221)}`, 2);
    return ctx.ok(DONE);
  }
  if (switches.includes('/add') || switches.includes('/delete')) {
    if (!ctx.isAdmin) return ctx.fail(DENIED, 2, NOT_ELEVATED(ctx, 'Adding or deleting accounts'));
    const name = operands[0];
    if (!name) return ctx.fail(cmdDoc('net')!.topics!.user, 1);
    if (switches.includes('/add')) {
      if (findName(localUsers(ctx), name)) return ctx.fail(`The account already exists.${helpMsg(2224)}`, 2);
      const groups = localGroups(ctx);
      state.localUsers = [...(state.localUsers ?? []), name];
      state.localGroups = { ...groups, Users: [...groups.Users, name] };
    } else {
      if (!findName(state.localUsers ?? [], name)) return ctx.fail(`The user name could not be found.${helpMsg(2221)}`, 2);
      state.localUsers = (state.localUsers ?? []).filter(u => u.toLowerCase() !== name.toLowerCase());
      state.localGroups = Object.fromEntries(Object.entries(localGroups(ctx)).map(([g, m]) => [g, m.filter(u => u.toLowerCase() !== name.toLowerCase())]));
    }
    return ctx.ok(DONE);
  }
  if (!operands.length) {
    const head = domain ? [DC_NOTE, '', '', 'User accounts for \\\\DC01'] : [`User accounts for \\\\${state.hostname}`];
    const names = domain ? state.adUsers.map(u => u.sAMAccountName) : localUsers(ctx);
    return ctx.ok([...head, '', RULE, ...threeColumns(names), DONE].join('\n'));
  }
  const wanted = operands[0];
  const ad = state.adUsers.find(u => u.sAMAccountName.toLowerCase() === wanted.toLowerCase());
  const local = findName(localUsers(ctx), wanted);
  if (domain ? !ad : !local) {
    return ctx.fail(`The user name could not be found.${helpMsg(2221)}`, 2,
      !domain && ad ? `${ad.sAMAccountName} is a domain account, not a local one. Add /domain (net user ${ad.sAMAccountName} /domain) to ask the domain controller.` : undefined);
  }
  const name = domain ? ad!.sAMAccountName : local!;
  const field = (k: string, v = '') => `${k.padEnd(29)}${v}`.trimEnd();
  const accountActive = domain ? (ad!.locked ? 'Locked' : ad!.enabled ? 'Yes' : 'No') : DISABLED_BUILTINS.has(name) ? 'No' : 'Yes';
  const localMember = Object.entries(localGroups(ctx)).filter(([, m]) => m.some(u => u.toLowerCase() === name.toLowerCase())).map(([g]) => `*${g}`);
  return ctx.ok([
    ...(domain ? [DC_NOTE, ''] : []),
    field('User name', name),
    field('Full Name', domain ? ad!.displayName : ''),
    field('Comment', name === 'Administrator' ? 'Built-in account for administering the computer/domain' : ''),
    field("User's comment"),
    field('Country/region code', '000 (System Default)'),
    field('Account active', accountActive),
    field('Account expires', 'Never'),
    '',
    field('Password last set', '10/1/2026 9:00:00 AM'),
    field('Password expires', domain && ad!.passwordNeverExpires ? 'Never' : '11/12/2026 9:00:00 AM'),
    field('Password changeable', '10/2/2026 9:00:00 AM'),
    field('Password required', 'Yes'),
    field('User may change password', 'Yes'),
    '',
    field('Workstations allowed', 'All'),
    field('Logon script'),
    field('User profile'),
    field('Home directory'),
    field('Last logon', '10/19/2026 8:45:12 AM'),
    '',
    field('Logon hours allowed', 'All'),
    '',
    field('Local Group Memberships', domain ? '' : localMember.join(' ')),
    field('Global Group memberships', domain ? ad!.memberOf.map(g => `*${g}`).join(' ') : '*None'),
    DONE,
  ].join('\n'));
}

function netLocalgroup(ctx: WindowsContext, rest: string[]): WindowsResult {
  const switches = rest.filter(a => a.startsWith('/')).map(a => a.toLowerCase());
  const operands = rest.filter(a => !a.startsWith('/'));
  const groups = localGroups(ctx);
  if (!operands.length) {
    return ctx.ok(['', `Aliases for \\\\${ctx.state.hostname}`, '', RULE, ...Object.keys(groups).sort().map(g => `*${g}`), DONE].join('\n'));
  }
  const group = findName(Object.keys(groups), operands[0]);
  const noGroup = () => ctx.fail(`The specified local group does not exist.${helpMsg(3780)}`, 2);
  if (switches.includes('/add') || switches.includes('/delete')) {
    if (!ctx.isAdmin) return ctx.fail(DENIED, 2, NOT_ELEVATED(ctx, 'Changing local group membership'));
    if (!group) return noGroup();
    let members = [...groups[group]];
    for (const m of operands.slice(1)) {
      const bare = m.replace(/^corp\\/i, '');
      const ad = ctx.state.adUsers.find(u => u.sAMAccountName.toLowerCase() === bare.toLowerCase());
      const entry = findName(localUsers(ctx), m) ?? (ad ? `CORP\\${ad.sAMAccountName}` : undefined);
      if (!entry) return ctx.fail(`There is no such global user or group: ${m}.${helpMsg(3783)}`, 2);
      const has = members.some(x => x.toLowerCase() === entry.toLowerCase());
      if (switches.includes('/add')) {
        if (has) return ctx.fail('System error 1378 has occurred.\n\nThe specified account name is already a member of the group.', 2);
        members.push(entry);
      } else {
        if (!has) return ctx.fail('System error 1377 has occurred.\n\nThe specified account name is not a member of the group.', 2);
        members = members.filter(x => x.toLowerCase() !== entry.toLowerCase());
      }
    }
    ctx.state.localGroups = { ...groups, [group]: members };
    return ctx.ok(DONE);
  }
  if (!group) return noGroup();
  return ctx.ok([
    `Alias name     ${operands[0]}`,
    `Comment        ${DEFAULT_LOCAL_GROUPS[group]?.comment ?? ''}`.trimEnd(),
    '',
    'Members',
    '',
    RULE,
    ...groups[group],
    DONE,
  ].join('\n'));
}

function netService(ctx: WindowsContext, start: boolean, rest: string[]): WindowsResult {
  const name = rest.filter(a => !a.startsWith('/')).join(' ');
  const services = ctx.state.services;
  if (!name) {
    if (!start) return ctx.fail(cmdDoc('net')!.topics!.stop, 1);
    const running = services.filter(s => s.status === 'Running').map(s => s.displayName).sort((a, b) => a.localeCompare(b));
    return ctx.ok(['These Windows services are started:', '', ...running.map(r => `   ${r}`), '', DONE].join('\n'));
  }
  const svc = services.find(s => s.name.toLowerCase() === name.toLowerCase() || s.displayName.toLowerCase() === name.toLowerCase());
  if (!svc) return ctx.fail(`The service name is invalid.${helpMsg(2185)}`, 2);
  if (!ctx.isAdmin) return ctx.fail(DENIED, 2, NOT_ELEVATED(ctx, `${start ? 'Starting' : 'Stopping'} a service`));
  if (start) {
    if (svc.status === 'Running') return ctx.fail(`The requested service has already been started.${helpMsg(2182)}`, 2);
    if (svc.startType === 'Disabled') {
      return ctx.fail('System error 1058 has occurred.\n\nThe service cannot be started, either because it is disabled or because it has no enabled devices associated with it.', 2);
    }
    svc.status = 'Running';
    return ctx.ok(`The ${svc.displayName} service is starting.\nThe ${svc.displayName} service was started successfully.\n`);
  }
  if (svc.status !== 'Running') return ctx.fail(`The ${svc.displayName} service is not started.${helpMsg(3521)}`, 2);
  svc.status = 'Stopped';
  return ctx.ok(`The ${svc.displayName} service is stopping.\nThe ${svc.displayName} service was stopped successfully.\n`);
}

function net(ctx: WindowsContext): WindowsResult {
  const [subRaw, ...rest] = ctx.args;
  switch (subRaw?.toLowerCase()) {
    case 'user': case 'users': return netUser(ctx, rest);
    case 'group': return netGroup(ctx, rest);
    case 'use': return netUse(ctx, rest);
    case 'localgroup': return netLocalgroup(ctx, rest);
    case 'start': return netService(ctx, true, rest);
    case 'stop': return netService(ctx, false, rest);
    case undefined: return ctx.fail(cmdDoc('net')!.usage, 1);
    default: return ctx.ok(DONE);
  }
}

cmdCommands.registerAll({
  whoami,
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
