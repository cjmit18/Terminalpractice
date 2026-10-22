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
// lpi-103-2: text processing
// ---------------------------------------------------------------------------------------------

const ATTACKER = '198.51.100.44';

/** Output is only the attacker's address, one per line, read from auth.log by any filter. */
export function extractedSourceIps(ctx?: CommandContext): boolean {
  if (!ctx || ctx.exitCode !== 0 || !/auth\.log/.test(ctx.command)) return false;
  const out = lines(ctx.stdout).filter(l => l.trim() !== '');
  return out.length > 0 && out.every(l => /^\s*198\.51\.100\.44\s*$/.test(l));
}

/** uniq -c was used and the output counts the three failures from the attacker's address. */
export function countedSourceIps(ctx?: CommandContext): boolean {
  if (!ctx || ctx.exitCode !== 0) return false;
  const usesCount = /\buniq\b[^|]*\s(-[a-zA-Z]*c[a-zA-Z]*|--count)\b/.test(ctx.command);
  return usesCount && new RegExp(`^\\s*3 ${ATTACKER.replace(/\./g, '\\.')}\\s*$`, 'm').test(ctx.stdout);
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

/** The last command read /etc/passwd (grep, cat, getent ...) and printed sarah's entry. */
export function passwdEntryShown(ctx?: CommandContext): boolean {
  if (!ctx || ctx.exitCode !== 0) return false;
  const readsPasswd = /\/etc\/passwd\b/.test(ctx.command) || /\bgetent\s+passwd\b/.test(ctx.command);
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
  const first = ctx.command.split('|')[0].trim().replace(/^sudo\s+/, '');
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

/** dmesg output that includes the SATA (AHCI) controller. */
export function sataInDmesg(ctx?: CommandContext): boolean {
  return !!ctx && ctx.exitCode === 0 && /\bdmesg\b/.test(ctx.command) && /SATA|ahci/.test(ctx.stdout);
}

// ---------------------------------------------------------------------------------------------
// win-pbq-network-troubleshoot
// ---------------------------------------------------------------------------------------------

/** ipconfig /all in any case, or with a dash (ipconfig -all). */
export function ipconfigAllRun(ctx?: CommandContext): boolean {
  return !!ctx && ctx.exitCode === 0 && /\bipconfig(\.exe)?\s+[/-]all\b/i.test(ctx.command) && ctx.stdout.includes('Windows IP Configuration');
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
  const probe = ctx.command.split('|')[0].trim();
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

/** alex exists (stored without quotes) and its DN ends in the IT_Admins OU. */
export function alexInItAdmins(state: SystemState): boolean {
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
// win-pbq-incident-response-taskkill
// ---------------------------------------------------------------------------------------------

/** netstat or Get-NetTCPConnection output that shows the 4444 connection and its PID. */
export function maliciousConnectionFound(ctx?: CommandContext): boolean {
  return !!ctx && ctx.exitCode === 0 && /\b(netstat|get-nettcpconnection)\b/i.test(ctx.command) && ctx.stdout.includes('4444') && /\b3892\b/.test(ctx.stdout);
}

/** tasklist or Get-Process output that names the malicious program. */
export function maliciousProcessNamed(ctx?: CommandContext): boolean {
  return !!ctx && ctx.exitCode === 0 && /\b(tasklist|get-process|gps)\b/i.test(ctx.command) && ctx.stdout.includes('svchost_update');
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
