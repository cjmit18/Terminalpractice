import type { LearningPath } from '../../types/paths';
import type { TerminalShell } from '../../types/terminal';
import { CMD_DOCS, LINUX_DOCS, PS_DOCS, linuxNames } from '../../terminal/docs';
import type { CmdDoc, LinuxDoc, PsDoc } from '../../terminal/docs';
import { hasManPage, renderBuiltinHelp, renderManPage } from '../../terminal/docs/linuxRender';
import { renderGetHelp } from '../../terminal/windows/help';

/**
 * The field guide's catalogue: every command the simulator documents, by shell and area, and how
 * to tell from the activity facts (src/lib/activity.ts) and the lessons whether you have met it.
 */

export const GUIDE_SHELLS: { shell: TerminalShell; label: string }[] = [
  { shell: 'bash', label: 'Linux (bash)' },
  { shell: 'cmd', label: 'Command Prompt' },
  { shell: 'powershell', label: 'PowerShell' },
];

export interface GuideEntry {
  shell: TerminalShell;
  name: string;
  summary: string;
  area: string;
  /** Names that run it, as stored in `cmd:` facts (lower case outside bash) */
  runNames: string[];
  /** Topics that open its manual, as stored in `help:` facts */
  helpNames: string[];
  /** The manual text, as `man`, `/?` or Get-Help prints it */
  manual: () => string;
  /** How to open the manual in its shell */
  manualCommand: string;
}

// ---------- Areas ----------

const LINUX_AREAS: [string, string[]][] = [
  ['Files and folders', ['ls', 'cd', 'pwd', 'mkdir', 'rmdir', 'touch', 'rm', 'cp', 'mv', 'find', 'tee', 'stat', 'du']],
  ['Text tools', ['echo', 'printf', 'cat', 'head', 'tail', 'grep', 'gawk', 'mawk', 'sed', 'sort', 'uniq', 'wc', 'cut', 'tr', 'xargs', 'nl']],
  [
    'Users and permissions',
    ['whoami', 'id', 'groups', 'who', 'getent', 'su', 'sudo', 'exit', 'chmod', 'chown', 'chgrp', 'umask', 'useradd', 'usermod', 'groupadd', 'userdel', 'chage', 'passwd'],
  ],
  ['Hardware and disks', ['uname', 'dmesg', 'lspci', 'lsusb', 'lsmod', 'modinfo', 'df', 'lsblk', 'blkid', 'free', 'fdisk', 'mount', 'swapon']],
  ['Processes and services', ['ps', 'kill', 'pgrep', 'nice', 'renice', 'uptime', 'systemctl', 'journalctl']],
  ['Network', ['ip', 'ifconfig', 'ping', 'ss', 'netstat', 'hostname']],
  ['Packages and archives', ['apt', 'apt-get', 'tar']],
  ['Getting help', ['man', 'info', 'apropos', 'whatis', 'whereis', 'type', 'help', 'which']],
  ['The shell', ['bash', 'dash', 'source', 'history', 'env', 'printenv', 'export', 'clear', 'date', 'timedatectl', 'true', 'false']],
];

const CMD_AREAS: [string, string[]][] = [
  ['Files and folders', ['cd', 'dir', 'mkdir', 'del', 'copy', 'type', 'more']],
  ['Text tools', ['echo', 'findstr']],
  ['Disks and repair', ['diskpart', 'chkdsk', 'sfc', 'dism', 'bootrec']],
  ['System and processes', ['systeminfo', 'tasklist', 'taskkill', 'ver', 'hostname', 'set']],
  ['Network', ['ipconfig', 'ping', 'tracert', 'nslookup', 'netstat', 'route']],
  ['Users and policy', ['whoami', 'net', 'gpresult', 'gpupdate']],
  ['Getting help', ['help', 'cls']],
];

const PS_AREAS: [string, string[]][] = [
  ['Files and folders', ['get-childitem', 'get-content', 'get-location', 'set-location', 'new-item', 'copy-item', 'remove-item', 'mkdir']],
  [
    'Filtering and output',
    ['write-output', 'sort-object', 'where-object', 'select-object', 'select-string', 'measure-object', 'format-table', 'format-list', 'out-null', 'clear-host'],
  ],
  [
    'Services and processes',
    ['get-service', 'start-service', 'stop-service', 'restart-service', 'set-service', 'new-service', 'suspend-service', 'resume-service', 'get-process', 'stop-process'],
  ],
  ['Network', ['test-netconnection', 'test-connection', 'get-netipconfiguration', 'get-nettcpconnection', 'clear-dnsclientcache']],
  ['Repair and policy', ['repair-windowsimage', 'invoke-gpupdate']],
  ['Getting help', ['get-help', 'get-command', 'help']],
];

const areaOf = (table: [string, string[]][], name: string, fallback: string) =>
  table.find(([, names]) => names.includes(name))?.[0] ?? fallback;

/** Areas in display order for a shell (the order of the tables above, then anything else) */
export function areaOrder(shell: TerminalShell): string[] {
  const table = shell === 'bash' ? LINUX_AREAS : shell === 'cmd' ? CMD_AREAS : PS_AREAS;
  return [...table.map(([a]) => a), 'Active Directory', 'Other'];
}

// ---------- Entries ----------

function linuxEntries(): GuideEntry[] {
  const out: GuideEntry[] = [];
  const seen = new Set<string>();
  for (const d of LINUX_DOCS as LinuxDoc[]) {
    if (d.section === 5 || d.pageOnly || seen.has(d.name)) continue;
    seen.add(d.name);
    const names = linuxNames(d);
    out.push({
      shell: 'bash',
      name: d.name,
      summary: d.summary,
      area: areaOf(LINUX_AREAS, d.name, 'Other'),
      runNames: names,
      helpNames: names,
      manual: () => (hasManPage(d) ? renderManPage(d) : renderBuiltinHelp(d)),
      manualCommand: hasManPage(d) ? `man ${d.name}` : `help ${d.name}`,
    });
  }
  return out;
}

function cmdEntries(): GuideEntry[] {
  return (CMD_DOCS as CmdDoc[])
    .filter(d => /^[a-z]/.test(d.name) && !d.name.endsWith(':'))
    .map(d => {
      const names = [d.name, ...(d.aliases ?? [])].map(n => n.toLowerCase());
      return {
        shell: 'cmd' as const,
        name: d.name,
        summary: d.summary,
        area: areaOf(CMD_AREAS, d.name, 'Other'),
        runNames: names,
        helpNames: names,
        manual: () => d.usage,
        manualCommand: `${d.name} /?`,
      };
    });
}

function psEntries(): GuideEntry[] {
  const cmdNames = new Set(CMD_DOCS.flatMap(d => [d.name, ...(d.aliases ?? [])].map(n => n.toLowerCase())));
  return (PS_DOCS as PsDoc[]).map(d => {
    const lower = d.name.toLowerCase();
    const aliases = d.aliases.map(a => a.toLowerCase());
    return {
      shell: 'powershell' as const,
      name: d.name,
      summary: d.synopsis,
      area: d.module === 'ActiveDirectory' ? 'Active Directory' : areaOf(PS_AREAS, lower, 'Other'),
      runNames: [lower, ...aliases],
      // `help dir` in CMD and `Get-Help dir` share one fact; let the CMD page have it
      helpNames: [lower, ...aliases.filter(a => !cmdNames.has(a))],
      manual: () => renderGetHelp(d),
      manualCommand: `Get-Help ${d.name}`,
    };
  });
}

let cache: GuideEntry[] | null = null;
export function guideEntries(): GuideEntry[] {
  cache ??= [...linuxEntries(), ...cmdEntries(), ...psEntries()];
  return cache;
}

// ---------- Seen in a lesson ----------

const FACT_SHELL: Record<TerminalShell, string> = { bash: 'bash', cmd: 'cmd', powershell: 'ps' };
const norm = (shell: TerminalShell, name: string) => (shell === 'bash' ? name : name.toLowerCase().replace(/\.exe$/, ''));

/**
 * Command names in the lessons' code blocks, as "<shell>:<name>": the first word of each line and of
 * each command joined to it by |, ;, && or ||. After sudo, the command it runs counts too. Output lines give words
 * that are not commands, and those simply match nothing.
 */
export function lessonCommandNames(paths: LearningPath[]): Set<string> {
  const out = new Set<string>();
  for (const path of paths)
    for (const stage of path.stages)
      for (const step of stage.steps) {
        if (step.kind !== 'lesson') continue;
        for (const block of step.blocks) {
          if (block.type !== 'code') continue;
          const shell = block.shell ?? 'bash';
          for (const raw of block.code.split('\n')) {
            const line = raw.replace(/^\s*(\$|#|PS [^>]*>|[A-Za-z]:\\[^>]*>)\s*/, '');
            for (const part of line.split(/\|\||&&|[|;]/)) {
              const words = part.trim().split(/\s+/);
              let word = words[0] ?? '';
              if (word === 'sudo' && shell === 'bash') {
                out.add('bash:sudo');
                word = words.find((w, i) => i > 0 && !w.startsWith('-')) ?? '';
              }
              if (/^[A-Za-z][A-Za-z0-9._-]*$/.test(word)) out.add(`${shell}:${norm(shell, word)}`);
            }
          }
        }
      }
  return out;
}

export interface EntryStatus {
  seen: boolean;
  ran: boolean;
  read: boolean;
}

export function entryStatus(e: GuideEntry, facts: ReadonlySet<string>, lessonNames: ReadonlySet<string>): EntryStatus {
  const os = e.shell === 'bash' ? 'linux' : 'windows';
  return {
    seen: e.runNames.some(n => lessonNames.has(`${e.shell}:${n}`)),
    ran: e.runNames.some(n => facts.has(`cmd:${FACT_SHELL[e.shell]}:${n}`)),
    read: e.helpNames.some(n => facts.has(`help:${os}:${n}`)),
  };
}

export const met = (s: EntryStatus) => s.seen || s.ran || s.read;

/** The help fact for reading an entry's manual in the field guide */
export const readFact = (e: GuideEntry) => `help:${e.shell === 'bash' ? 'linux' : 'windows'}:${e.helpNames[0]}`;
