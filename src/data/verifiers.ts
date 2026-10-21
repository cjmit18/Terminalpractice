import { FileNode, SystemState } from '../types/terminal';
import { CommandContext } from '../types/modules';
import { getNodeAtPath } from '../terminal/filesystem';

/**
 * Lab objective checks that need more than a one-line condition. They are pure functions of
 * the filesystem, the system state and the last command, so the tests can call them directly.
 *
 * Where possible they check the result (state or output) rather than the exact command text,
 * so every correct way of doing a task passes and wrong answers that happen to print the
 * right word do not.
 */

const lines = (text: string) => text.split('\n').map(l => l.replace(/\r$/, ''));

/** True when the line has more than one command chained with ;, && or || (pipes are fine). */
const isChained = (command: string) => /;|&&|\|\|/.test(command);

// ---------------------------------------------------------------------------------------------
// Reading the command line
// ---------------------------------------------------------------------------------------------

/**
 * Splits a command line into its commands: the stages of a pipeline and the commands chained
 * with ;, && or ||. Quotes are respected, and a # that starts a word ends the line, so text in
 * a comment never counts. A backslash escapes only shell punctuation, which keeps Windows paths
 * such as C:\Users\Student intact.
 */
export function commandStages(command: string): string[] {
  const stages: string[] = [];
  let cur = '';
  let quote: '"' | "'" | null = null;
  for (let i = 0; i < command.length; i++) {
    const c = command[i];
    if (quote) {
      cur += c;
      if (c === quote) quote = null;
      continue;
    }
    if (c === '\\' && i + 1 < command.length && /["'|;&# \\]/.test(command[i + 1])) {
      cur += c + command[++i];
      continue;
    }
    if (c === '"' || c === "'") {
      quote = c;
      cur += c;
      continue;
    }
    if (c === '#' && /^$|\s$/.test(cur)) break;
    // 2>&1 and &> are redirections, not a background &
    const redirect = c === '&' && (cur.endsWith('>') || command[i + 1] === '>');
    if (!redirect && (c === '|' || c === ';' || c === '&')) {
      stages.push(cur);
      cur = '';
      if ((c === '|' || c === '&') && command[i + 1] === c) i++;
      continue;
    }
    cur += c;
  }
  stages.push(cur);
  return stages.map(s => s.trim()).filter(Boolean);
}

/** The program a command runs, lowercased, without sudo, a directory or .exe in front of or after it. */
function toolOf(stage: string): string {
  const words = stage.split(/\s+/);
  while (words.length > 1 && /^(sudo|\w+=\S*)$/.test(words[0])) words.shift();
  return (words[0] ?? '').replace(/^["']|["']$/g, '').replace(/^.*[\\/]/, '').replace(/\.exe$/i, '').toLowerCase();
}

/** True when the line just prints text: its first command is echo, printf, Write-Output or Write-Host. */
function onlyPrints(stages: string[]): boolean {
  return stages.length === 0 || /^(echo|printf|write-output|write-host)$/.test(toolOf(stages[0]));
}

/**
 * The commands on the line that run one of the given programs (as the first word of a stage,
 * not as an argument or inside a comment). Empty when the line only echoes text.
 */
export function stagesRunning(command: string, tools: RegExp): string[] {
  const stages = commandStages(command);
  if (onlyPrints(stages)) return [];
  return stages.filter(s => tools.test(toolOf(s)));
}

/** True when some command on the line runs one of the given programs. */
export const runsTool = (command: string, tools: RegExp) => stagesRunning(command, tools).length > 0;

/** True when a command on the line that is not echo or printf names the path. */
const namesPath = (command: string, path: RegExp) =>
  stagesRunning(command, /^(?!(echo|printf|write-output|write-host)$)/).some(s => path.test(s));

// ---------------------------------------------------------------------------------------------
// lpi-103-2: text processing
// ---------------------------------------------------------------------------------------------

const ATTACKER = '198.51.100.44';

/** Output is only the attacker's address, one per line, read from auth.log by any filter. */
export function extractedSourceIps(ctx?: CommandContext): boolean {
  if (!ctx || ctx.exitCode !== 0 || !namesPath(ctx.command, /auth\.log/)) return false;
  const out = lines(ctx.stdout).filter(l => l.trim() !== '');
  return out.length > 0 && out.every(l => /^\s*198\.51\.100\.44\s*$/.test(l));
}

/**
 * The pipeline sorts the addresses and then counts them with uniq -c, and the output counts the
 * three failures from the attacker's address. uniq only merges neighbouring lines, so the sort
 * stage has to come before it: on this log the attacker's lines happen to be together, which is
 * why the output alone cannot tell the difference.
 */
export function countedSourceIps(ctx?: CommandContext): boolean {
  if (!ctx || ctx.exitCode !== 0) return false;
  const stages = commandStages(ctx.command);
  if (onlyPrints(stages)) return false;
  const tools = stages.map(toolOf);
  const uniqAt = stages.findIndex((s, i) => tools[i] === 'uniq' && /\s(-[a-zA-Z]*c[a-zA-Z]*|--count)\b/.test(s));
  const sorted = uniqAt > 0 && tools.slice(0, uniqAt).includes('sort');
  return sorted && new RegExp(`^\\s*3 ${ATTACKER.replace(/\./g, '\\.')}\\s*$`, 'm').test(ctx.stdout);
}

/** grep found the attacker's lines. Any grep pattern that does is fine, as long as grep ran it. */
export function failedLinesFound(ctx?: CommandContext): boolean {
  return !!ctx && ctx.exitCode === 0 && runsTool(ctx.command, /^[efz]?grep$/) && ctx.stdout.includes(ATTACKER);
}

// ---------------------------------------------------------------------------------------------
// lpi-107-1: user administration
// ---------------------------------------------------------------------------------------------

function fileLines(fs: FileNode, path: string): string[] {
  const node = getNodeAtPath(fs, path, false);
  return node?.type === 'file' && node.content ? lines(node.content) : [];
}

const passwdEntry = (fs: FileNode, user: string) =>
  fileLines(fs, '/etc/passwd').map(l => l.split(':')).find(f => f[0] === user);

const groupEntry = (fs: FileNode, group: string) =>
  fileLines(fs, '/etc/group').map(l => l.split(':')).find(f => f[0] === group);

/**
 * sarah exists with bash as her shell and developers as a supplementary group. Her primary
 * group must not be developers: that is what -g does, and the task asks for -G.
 */
export function sarahCreated(fs: FileNode): boolean {
  const user = passwdEntry(fs, 'sarah');
  const dev = groupEntry(fs, 'developers');
  if (!user || user.length < 7 || !dev) return false;
  const members = (dev[3] ?? '').split(',').map(m => m.trim());
  return user[6] === '/bin/bash' && members.includes('sarah') && user[3] !== dev[2];
}

/** /home/sarah exists as a directory and sarah owns it. */
export function sarahHomeOwned(fs: FileNode): boolean {
  const home = getNodeAtPath(fs, '/home/sarah', false);
  return !!home && home.type === 'directory' && home.owner === 'sarah';
}

/**
 * sarah owns /home/sarah, and the last command looked at it: ls or stat on /home/sarah (or on
 * /home, which lists it), with output that shows sarah as the owner. Creating the account
 * does not tick this task by itself; the task is to check.
 */
export function sarahHomeChecked(fs: FileNode, ctx?: CommandContext): boolean {
  if (!sarahHomeOwned(fs) || !ctx || ctx.exitCode !== 0) return false;
  const looks = stagesRunning(ctx.command, /^(ls|stat)$/).some(s => /(^|\s)(\/home\/sarah|\/home|~sarah)\/?(\s|$)/.test(s));
  return looks && /\bsarah\b/.test(ctx.stdout);
}

/** The last command read /etc/passwd (grep, cat, getent ...) and printed sarah's entry. */
export function passwdEntryShown(ctx?: CommandContext): boolean {
  if (!ctx || ctx.exitCode !== 0) return false;
  const readsPasswd = namesPath(ctx.command, /\/etc\/passwd\b/) || stagesRunning(ctx.command, /^getent$/).some(s => /\spasswd\b/.test(s));
  return readsPasswd && /(^|[\s:])sarah:[^:\n]*:\d+:\d+:/m.test(ctx.stdout);
}

// ---------------------------------------------------------------------------------------------
// lpi-104-5: permissions
// ---------------------------------------------------------------------------------------------

/**
 * ls -l (any flag order, with or without -d/-a/-h) or stat printed the finance directory
 * itself: an ls line for a directory whose name is finance, or stat's File: line for it.
 */
export function financeDirShown(ctx?: CommandContext): boolean {
  if (!ctx || ctx.exitCode !== 0 || isChained(ctx.command)) return false;
  const first = (commandStages(ctx.command)[0] ?? '').replace(/^sudo\s+/, '');
  const name = /^(\S+\/)?finance\/?$/;
  if (/^ls\s/.test(first)) {
    return lines(ctx.stdout).some(l => {
      const f = l.trim().split(/\s+/);
      return /^d[rwxsStT-]{9}[.+@]?$/.test(f[0] ?? '') && f.length >= 9 && name.test(f[f.length - 1]);
    });
  }
  if (/^stat\s/.test(first)) {
    return lines(ctx.stdout).some(l => {
      const m = l.match(/^\s*File:\s*['‘]?(.+?)['’]?\s*$/);
      return !!m && name.test(m[1]);
    }) && /directory/.test(ctx.stdout);
  }
  return false;
}

// ---------------------------------------------------------------------------------------------
// lpi-101-1: hardware
// ---------------------------------------------------------------------------------------------

/** Kernel messages (dmesg, or journalctl, which also holds them) that include the SATA (AHCI) controller. */
export function sataInDmesg(ctx?: CommandContext): boolean {
  return !!ctx && ctx.exitCode === 0 && runsTool(ctx.command, /^(dmesg|journalctl)$/) && /SATA|ahci/.test(ctx.stdout);
}

/** lspci ran and listed the Ethernet controller. */
export function pciListed(ctx?: CommandContext): boolean {
  return !!ctx && ctx.exitCode === 0 && runsTool(ctx.command, /^lspci$/) && ctx.stdout.includes('Ethernet');
}

/** The loaded modules: lsmod, or /proc/modules (which lsmod reads), showing e1000e or the lsmod table. */
export function modulesListed(ctx?: CommandContext): boolean {
  if (!ctx || ctx.exitCode !== 0) return false;
  const reads = runsTool(ctx.command, /^lsmod$/) || namesPath(ctx.command, /\/proc\/modules\b/);
  return reads && (ctx.stdout.includes('e1000e') || /^Module\s/m.test(ctx.stdout));
}

// ---------------------------------------------------------------------------------------------
// lpi-102-1: disks
// ---------------------------------------------------------------------------------------------

/** fdisk -l (or --list) printed the partition table of /dev/sda. */
export function partitionTableListed(ctx?: CommandContext): boolean {
  return !!ctx && ctx.exitCode === 0 && stagesRunning(ctx.command, /^fdisk$/).some(s => /\s(-[a-zA-Z]*l[a-zA-Z]*|--list)\b/.test(s)) && ctx.stdout.includes('Disk /dev/sda');
}

/** df ran and showed the /boot filesystem. */
export function mountsShown(ctx?: CommandContext): boolean {
  return !!ctx && ctx.exitCode === 0 && runsTool(ctx.command, /^df$/) && ctx.stdout.includes('/boot');
}

// ---------------------------------------------------------------------------------------------
// win-pbq-network-troubleshoot
// ---------------------------------------------------------------------------------------------

/** ipconfig /all in any case, or with a dash (ipconfig -all). */
export function ipconfigAllRun(ctx?: CommandContext): boolean {
  return !!ctx && ctx.exitCode === 0 && stagesRunning(ctx.command, /^ipconfig$/).some(s => /\s[/-]all\b/i.test(s)) && ctx.stdout.includes('Windows IP Configuration');
}

const PROBE = /^\s*(ping|tnc|test-netconnection|test-connection)\b/i;

/**
 * A successful ping or connection test to a real destination after the adapter has a working
 * lease. Loopback and the PC's own address answer even with no network, so they do not count.
 */
export function connectivityVerified(state: SystemState, ctx?: CommandContext): boolean {
  if (!ctx || ctx.exitCode !== 0) return false;
  const iface = state.interfaces[0];
  if (!state.gatewayWorking || !iface || iface.ip.startsWith('169.254.')) return false;
  const probe = commandStages(ctx.command)[0] ?? '';
  const tool = probe.match(PROBE)?.[1].toLowerCase();
  if (!tool) return false;
  const out = ctx.stdout;
  // Judge the address the engine actually reached: the one in the output, or, for -Quiet
  // output that shows none, each target named on the line resolved the way the engine does
  const isLocal = (addr: string) => {
    const a = addr.toLowerCase();
    return a === 'localhost' || a === '::1' || a === state.hostname.toLowerCase() || /^127\./.test(a) || state.interfaces.some(i => i.ip === a);
  };
  const shown = [
    ...out.matchAll(/^Pinging (?:\S+ \[([^\]]+)\]|(\S+)) with/gim),
    ...out.matchAll(/^Reply from ([^:\s]+):/gim),
    ...out.matchAll(/^RemoteAddress\s*:\s*(\S+)/gim),
    // Test-Connection's table rows (Source Destination IPV4Address …); "Key : value" lines such as
    // Test-NetConnection's SourceAddress are the PC itself, not the destination, so they are skipped
    ...out.matchAll(/^\S+\s+[^\s:]\S*\s+(\d+\.\d+\.\d+\.\d+)\s/gm),
  ].map(m => m[1] ?? m[2]);
  const named = probe.split(/\s+/).slice(1).flatMap(w => w.split(',')).map(w => w.replace(/^["']|["']$/g, '')).filter(w => w && !w.startsWith('-'));
  if ([...shown, ...named].some(isLocal)) return false;
  // -Quiet / -InformationLevel Quiet print only True or False, one per target
  const quiet = out.trim().split(/\s*\n\s*/);
  if (quiet.every(l => /^(True|False)$/i.test(l))) return quiet.every(l => /^True$/i.test(l));
  if (tool === 'ping') return /bytes=\d+.*TTL=\d+/i.test(out);
  if (tool === 'test-connection') return out.trim() !== '' && !/failed|error/i.test(out);
  return /(PingSucceeded|TcpTestSucceeded)\s*:\s*True/i.test(out);
}

// ---------------------------------------------------------------------------------------------
// win-pbq-active-directory-mgmt
// ---------------------------------------------------------------------------------------------

const findAdUser = (state: SystemState, sam: string) =>
  state.adUsers.find(u => u.sAMAccountName.toLowerCase() === sam);

/** jdoe exists and is no longer locked out. */
export function jdoeUnlocked(state: SystemState): boolean {
  const user = findAdUser(state, 'jdoe');
  return !!user && !user.locked;
}

/**
 * alex exists (stored without quotes) and its DN ends in the IT_Admins OU. A New-ADUser line
 * without -SamAccountName does not count: the real cmdlet does not copy -Name into the sign-in
 * name, so that command would not have created the account alex.
 */
export function alexInItAdmins(state: SystemState, ctx?: CommandContext): boolean {
  if (ctx && stagesRunning(ctx.command, /^new-aduser$/).some(s => !/\s-sam[a-z]*\b/i.test(s))) return false;
  const user = findAdUser(state, 'alex');
  return !!user && user.ou.replace(/\s*,\s*/g, ',').toLowerCase().endsWith('ou=it_admins,dc=corp,dc=local');
}

/** alex exists and is a member of Domain Admins (on either side of the link). */
export function alexInDomainAdmins(state: SystemState): boolean {
  const user = findAdUser(state, 'alex');
  const group = state.adGroups.find(g => g.name.toLowerCase() === 'domain admins');
  return !!user && (user.memberOf.some(g => g.toLowerCase() === 'domain admins') || !!group?.members.some(m => m.toLowerCase() === 'alex'));
}

// ---------------------------------------------------------------------------------------------
// win-pbq-group-policy-mgmt, win-pbq-diskpart-partitioning, win-pbq-powershell-automation
// ---------------------------------------------------------------------------------------------

/** gpupdate /force, or Invoke-GPUpdate -Force in PowerShell. */
export function policyForced(ctx?: CommandContext): boolean {
  return !!ctx && ctx.exitCode === 0 && stagesRunning(ctx.command, /^(gpupdate|invoke-gpupdate)$/).some(s => /\s[/-]force\b/i.test(s));
}

/** gpresult /r printed the summary. */
export function policyResultShown(ctx?: CommandContext): boolean {
  return !!ctx && ctx.exitCode === 0 && stagesRunning(ctx.command, /^gpresult$/).some(s => /\s\/r\b/i.test(s));
}

/** diskpart (or diskpart.exe) started on its own line. */
export function diskpartStarted(ctx?: CommandContext): boolean {
  if (!ctx || ctx.exitCode !== 0) return false;
  const stages = commandStages(ctx.command);
  return stages.length === 1 && /^diskpart(\.exe)?$/i.test(stages[0].replace(/^.*\\/, ''));
}

/** Get-Service (or its alias gsv) listed W32Time. */
export function servicesListed(ctx?: CommandContext): boolean {
  return !!ctx && ctx.exitCode === 0 && runsTool(ctx.command, /^(get-service|gsv)$/) && ctx.stdout.includes('W32Time');
}

// ---------------------------------------------------------------------------------------------
// win-pbq-incident-response-taskkill
// ---------------------------------------------------------------------------------------------

/** netstat or Get-NetTCPConnection output that shows the 4444 connection and its PID. */
export function maliciousConnectionFound(ctx?: CommandContext): boolean {
  return !!ctx && ctx.exitCode === 0 && runsTool(ctx.command, /^(netstat|get-nettcpconnection)$/) && ctx.stdout.includes('4444') && /\b3892\b/.test(ctx.stdout);
}

/** tasklist or Get-Process output that names the malicious program. */
export function maliciousProcessNamed(ctx?: CommandContext): boolean {
  return !!ctx && ctx.exitCode === 0 && runsTool(ctx.command, /^(tasklist|get-process|gps|ps)$/) && ctx.stdout.includes('svchost_update');
}

/** PID 3892 is gone, however it was killed. */
export function maliciousProcessKilled(state: SystemState): boolean {
  return !state.processes.some(p => p.pid === 3892);
}

// ---------------------------------------------------------------------------------------------
// win-pbq-sfc-dism-recovery
// ---------------------------------------------------------------------------------------------

/** SFC has been run at least once (a repair also implies a scan). */
export function sfcRan(state: SystemState): boolean {
  return !!state.sfcScanned || state.sfcRepaired;
}

/** The component store is repaired. */
export function dismRan(state: SystemState): boolean {
  return state.dismRepaired;
}

/** SFC ran after DISM and repaired the protected files from the fixed store. */
export function sfcRepairedAfterDism(state: SystemState): boolean {
  return state.dismRepaired && state.sfcRepaired && !state.systemIntegrityCorrupted;
}
