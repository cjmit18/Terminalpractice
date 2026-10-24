import { CommandContext } from '../types/modules';
import { FileNode, SystemState, TerminalShell } from '../types/terminal';
import { getNodeAtPath } from '../terminal/filesystem';
import { printsTypedText, runsTool } from './verifiers';

/**
 * Mini challenges: short puzzles answered with one command (sometimes two), on the machines of
 * the existing labs. Each one is checked like a lab task, from what the last command printed.
 *
 * Every challenge stays open forever, and there is no cap on how many there are: new ones are added to
 * this list and old ones stay. The order they are shown in, and "Today's pick" at the top, is a random
 * rotation chosen from the date; nothing expires and nothing is lost by skipping a day.
 *
 * The checks look at the output, not the exact command, so any correct way passes. They also
 * want the command to read the real source (the file or the tool named in the question) and the
 * output to hold only the answer, so `cat` of the whole file or an `echo` of a guess does not pass.
 */

export interface Challenge {
  id: string;
  /** Short name for lists and the page heading */
  title: string;
  shell: TerminalShell;
  /** Id of the lab whose machine (initialFs and initialState) the challenge runs on */
  machineFrom: string;
  /** The question, in one or two plain sentences */
  prompt: string;
  verifier: (fs: FileNode, state: SystemState, ctx?: CommandContext) => boolean;
  hint: string;
  /** Shown once solved: the answer and why the command works */
  explanation: string;
  /** A known way to solve it, one command per entry (the replay test runs these) */
  solution: string[];
}

const lines = (text: string) =>
  text
    .split('\n')
    .map(l => l.replace(/\r$/, ''))
    .filter(l => l.trim() !== '');

/** The machine's own lines of a file, so an answer is checked against the real source. */
function fileLines(fs: FileNode, path: string): string[] {
  const node = getNodeAtPath(fs, path, false);
  return node?.type === 'file' && node.content ? lines(node.content) : [];
}

/** The output is exactly these lines of the file, in order, each whole and unchanged. */
const printsLines = (stdout: string, expected: string[]) => {
  const out = lines(stdout);
  return expected.length > 0 && out.length === expected.length && out.every((l, i) => l === expected[i]);
};

/**
 * The last command succeeded, read from `source`, and no part of it simply printed typed text (echo and
 * friends can repeat an answer but never find one, also after a real command: cat f >/dev/null; echo 2).
 * `okCodes` lists the exit codes that count as success: find exits 1 when a folder such as /root cannot be
 * read, even though it printed every match it could reach.
 */
function answered(ctx: CommandContext | undefined, source: RegExp, okCodes: number[] = [0]): ctx is CommandContext {
  return !!ctx && okCodes.includes(ctx.exitCode) && source.test(ctx.command) && !printsTypedText(ctx.command);
}

/** Output rows without table headers and dashed underlines (PowerShell and tasklist tables). */
function dataRows(stdout: string, header: RegExp): string[] {
  return lines(stdout).filter(l => !header.test(l) && !/^[\s=-]+$/.test(l));
}

const PS_SERVICE_HEADER = /^\s*Status\s+Name\s+DisplayName\s*$/;
// Windows PowerShell 5.1's Get-Process view starts with Handles; older output started with NPM(K)
const PS_PROCESS_HEADER = /^\s*(Handles\s+)?NPM\(K\)\s/;
const TASKLIST_HEADER = /^\s*Image Name\s+PID\b/;

export const CHALLENGES: Challenge[] = [
  // ---------------------------------------------------------------------------- bash
  {
    id: 'bash-login-shells',
    title: 'Accounts that use bash',
    shell: 'bash',
    machineFrom: 'lpi-107-1-user-administration',
    prompt: 'How many accounts on this server log in with /bin/bash? Print just the number.',
    verifier: (_fs, _s, ctx) => answered(ctx, /\/etc\/passwd|getent\s+passwd/) && ctx.stdout.trim() === '2',
    hint: 'The login shell is the last field of each line in /etc/passwd. grep -c counts matching lines.',
    explanation:
      'Two accounts, root and student. grep -c /bin/bash /etc/passwd counts the lines that mention bash; grep /bin/bash /etc/passwd | wc -l does the same in two steps. The other accounts use /usr/sbin/nologin, so nobody can log in as them.',
    solution: ['grep -c /bin/bash /etc/passwd'],
  },
  {
    id: 'bash-sshd-line',
    title: 'The log line about sshd',
    shell: 'bash',
    machineFrom: 'lpi-103-2-text-processing',
    prompt: 'Which line in /var/log/syslog mentions sshd? Print only that line.',
    verifier: (fs, _s, ctx) => {
      if (!answered(ctx, /\/var\/log\/syslog|\bsyslog\b/)) return false;
      return printsLines(ctx.stdout, fileLines(fs, '/var/log/syslog').filter(l => /\bsshd\[/.test(l)));
    },
    hint: 'grep prints only the lines that contain a word. Give it the word and the file.',
    explanation:
      'grep sshd /var/log/syslog prints the one line where the SSH server says it is listening on port 22. Filtering a log by the name of the program that wrote it is often the first step in reading one.',
    solution: ['grep sshd /var/log/syslog'],
  },
  {
    id: 'bash-failed-count',
    title: 'Failed SSH logins',
    shell: 'bash',
    machineFrom: 'lpi-103-2-text-processing',
    prompt: 'How many "Failed password" lines are in /var/log/auth.log? Print just the number.',
    verifier: (_fs, _s, ctx) => answered(ctx, /auth\.log/) && /failed/i.test(ctx.command) && ctx.stdout.trim() === '3',
    hint: 'grep -c prints how many lines match instead of the lines themselves. Quote the two words so grep sees them as one pattern.',
    explanation:
      'Three. grep -c "Failed password" /var/log/auth.log counts them. Without the quotes, grep treats password as a second file name: it reports that password does not exist and still counts Failed in auth.log, with the file name in front.',
    solution: ['grep -c "Failed password" /var/log/auth.log'],
  },
  {
    id: 'bash-suid-programs',
    title: 'Programs that run as root',
    shell: 'bash',
    machineFrom: 'lpi-104-5-permissions',
    prompt: 'Which programs in /usr/bin have the SUID bit set, so they run with their owner\'s rights? List just those files.',
    verifier: (_fs, _s, ctx) => {
      // find / as a normal user cannot read /root and exits 1; the matches it printed are still the answer
      const okCodes = ctx && runsTool(ctx.command, /^find$/) ? [0, 1] : [0];
      if (!answered(ctx, /\/usr\/bin|\bfind\s+\//, okCodes)) return false;
      const out = lines(ctx.stdout).map(l => l.trim().split(/\s+/).pop() ?? '').map(p => p.replace(/^.*\//, ''));
      return out.length === 3 && ['passwd', 'su', 'sudo'].every(n => out.includes(n));
    },
    hint: '`find` can match permission bits: `-perm -4000` means "at least the SUID bit".',
    explanation:
      'passwd, su and sudo. find /usr/bin -perm -4000 lists them. In ls -l they show an s where the owner\'s x would be (rwsr-xr-x). chage has the SGID bit instead (rwxr-sr-x), so it is not in the list.',
    solution: ['find /usr/bin -perm -4000'],
  },
  {
    id: 'bash-listening-ports',
    title: 'Listening ports',
    shell: 'bash',
    machineFrom: 'lpi-101-1-system-architecture',
    prompt: 'Which TCP ports is this server listening on? Show only the listening TCP sockets.',
    verifier: (_fs, _s, ctx) => {
      if (!answered(ctx, /^\s*(sudo\s+)?(ss|netstat)\b/)) return false;
      const rows = lines(ctx.stdout).filter(l => /^tcp/i.test(l.trim()));
      return rows.length === 2 && rows.every(r => /LISTEN/.test(r)) && rows.some(r => /:22\b/.test(r)) && rows.some(r => /:80\b/.test(r));
    },
    hint: 'ss shows sockets. -t limits it to TCP, -l to listening sockets, -n shows port numbers instead of names.',
    explanation:
      'Ports 22 (SSH) and 80 (the web server). ss -tln is the modern way; netstat -tln gives the same answer on older systems. Add -p as root to see which program owns each port.',
    solution: ['ss -tln'],
  },
  {
    id: 'bash-name-servers',
    title: 'Name servers',
    shell: 'bash',
    machineFrom: 'lpi-102-1-disk-partitioning',
    prompt: 'Which DNS servers does this machine ask? Print only the nameserver lines of its resolver file.',
    verifier: (fs, _s, ctx) => {
      if (!answered(ctx, /resolv\.conf/)) return false;
      return printsLines(ctx.stdout, fileLines(fs, '/etc/resolv.conf').filter(l => /^\s*nameserver\s/.test(l)));
    },
    hint: 'The resolver settings live in /etc/resolv.conf. grep can pick out the lines that start with a word.',
    explanation:
      '192.168.1.1 first, then 8.8.8.8. grep nameserver /etc/resolv.conf (or grep ^nameserver to be strict) leaves out the comment and the search line.',
    solution: ['grep nameserver /etc/resolv.conf'],
  },
  {
    id: 'bash-adm-group',
    title: 'Who can read the logs',
    shell: 'bash',
    machineFrom: 'lpi-104-5-permissions',
    prompt: 'The logs in /var/log belong to the adm group. Who is in it? Print only that group\'s entry.',
    verifier: (_fs, _s, ctx) => {
      if (!answered(ctx, /\/etc\/group|getent\s+group/)) return false;
      const out = lines(ctx.stdout);
      return out.length === 1 && /^adm:x:4:/.test(out[0].trim());
    },
    hint: 'Groups are listed in /etc/group, one per line, with the members last. getent group can also look one up by name.',
    explanation:
      'syslog and student. getent group adm or grep ^adm: /etc/group prints adm:x:4:syslog,student. The members after the last colon are supplementary members, which is why student can read /var/log/auth.log.',
    solution: ['getent group adm'],
  },
  {
    id: 'bash-boot-usage',
    title: 'How full /boot is',
    shell: 'bash',
    machineFrom: 'lpi-102-1-disk-partitioning',
    prompt: 'How full is the /boot partition? Show the usage of that filesystem only, in sizes a person can read.',
    verifier: (_fs, _s, ctx) => {
      if (!answered(ctx, /^\s*df\b/)) return false;
      const rows = lines(ctx.stdout).filter(l => !/^Filesystem/.test(l));
      return rows.length === 1 && /\s\/boot\s*$/.test(rows[0]) && /\d(\.\d)?[KMGT]\b/.test(rows[0]);
    },
    hint: 'df reports free space per filesystem. -h makes the sizes readable, and you can name a mount point to see just that one.',
    explanation:
      '26% used, 353M free. df -h /boot shows only the filesystem that holds /boot. Without -h the sizes are in 1K blocks.',
    solution: ['df -h /boot'],
  },

  // ---------------------------------------------------------------------------- Command Prompt
  {
    id: 'cmd-port-4444-pid',
    title: 'The PID on port 4444',
    shell: 'cmd',
    machineFrom: 'win-pbq-incident-response-taskkill',
    prompt: 'Something on this PC is talking to remote port 4444. Show only that connection, with the PID that owns it.',
    verifier: (_fs, _s, ctx) => {
      if (!answered(ctx, /^\s*netstat\b/i)) return false;
      const out = lines(ctx.stdout);
      return out.length === 1 && /:4444\b/.test(out[0]) && /\b3892\s*$/.test(out[0]);
    },
    hint: 'netstat -ano lists every connection with its PID in the last column. Pipe it to findstr to keep one line.',
    explanation:
      'PID 3892. netstat -ano | findstr 4444 keeps the one connection: -a lists all connections, -n keeps numbers, -o adds the owning PID.',
    solution: ['netstat -ano | findstr 4444'],
  },
  {
    id: 'cmd-port-4444-program',
    title: 'The program on port 4444',
    shell: 'cmd',
    machineFrom: 'win-pbq-incident-response-taskkill',
    prompt: 'Which program owns the connection to remote port 4444? Find its PID, then show the task list filtered to just that process.',
    verifier: (_fs, _s, ctx) => {
      if (!answered(ctx, /^\s*tasklist\b/i)) return false;
      const rows = dataRows(ctx.stdout, TASKLIST_HEADER);
      return rows.length === 1 && /^svchost_update\.exe\s+3892\b/i.test(rows[0].trim());
    },
    hint: '`netstat -ano | findstr 4444` gives the PID. `tasklist /fi "PID eq <pid>"` then shows only that process.',
    explanation:
      'svchost_update.exe, PID 3892. The name is made to look like the real svchost.exe, which is why matching the PID matters more than reading the name. tasklist | findstr 3892 works as well.',
    solution: ['netstat -ano | findstr 4444', 'tasklist /fi "PID eq 3892"'],
  },
  {
    id: 'cmd-ipv4-address',
    title: 'The workstation\'s address',
    shell: 'cmd',
    machineFrom: 'win-pbq-network-troubleshoot',
    prompt: 'What IPv4 address does this workstation have? Print only that line of the adapter settings.',
    verifier: (_fs, _s, ctx) => {
      if (!answered(ctx, /^\s*ipconfig\b/i)) return false;
      const out = lines(ctx.stdout);
      return out.length === 1 && /IPv4/.test(out[0]) && /169\.254\.82\.114/.test(out[0]);
    },
    hint: 'ipconfig prints the adapter settings. findstr keeps only the lines that contain a word, such as IPv4.',
    explanation:
      '169.254.82.114. ipconfig | findstr IPv4 shows it. An address that starts with 169.254 is APIPA: Windows picked it itself because no DHCP server answered, so the PC can only reach others on the same local network.',
    solution: ['ipconfig | findstr IPv4'],
  },
  {
    id: 'cmd-hosts-dc01',
    title: 'dc01 in the hosts file',
    shell: 'cmd',
    machineFrom: 'win-pbq-active-directory-mgmt',
    prompt: 'Which address does the local hosts file give dc01? Print only that line.',
    verifier: (_fs, _s, ctx) => {
      if (!answered(ctx, /drivers\\etc\\hosts/i)) return false;
      const out = lines(ctx.stdout);
      return out.length === 1 && /^\s*192\.168\.1\.10\s+dc01\b/i.test(out[0]);
    },
    hint: 'The hosts file is C:\\Windows\\System32\\drivers\\etc\\hosts. findstr takes a word and then a file.',
    explanation:
      '192.168.1.10. findstr dc01 C:\\Windows\\System32\\drivers\\etc\\hosts prints that entry. Windows reads the hosts file before it asks DNS, so a wrong line here can send a PC to the wrong server.',
    solution: ['findstr dc01 C:\\Windows\\System32\\drivers\\etc\\hosts'],
  },

  // ---------------------------------------------------------------------------- PowerShell
  {
    id: 'ps-stopped-services',
    title: 'Stopped services',
    shell: 'powershell',
    machineFrom: 'win-pbq-powershell-automation',
    prompt: 'Which services on this PC are stopped? List only those.',
    verifier: (_fs, _s, ctx) => {
      // gsv is PowerShell's own alias for Get-Service
      if (!answered(ctx, /get-service|\bgsv\b/i)) return false;
      const rows = dataRows(ctx.stdout, PS_SERVICE_HEADER);
      return rows.length === 2 && rows.every(r => /^\s*Stopped\b/.test(r)) && rows.some(r => /W32Time/.test(r));
    },
    hint: 'Get-Service lists every service. Pipe it to Where-Object and keep the ones whose Status is Stopped.',
    explanation:
      'W32Time (Windows Time) and wuauserv (Windows Update). Get-Service | Where-Object Status -eq Stopped filters the objects by a property, so it does not depend on how the table looks.',
    solution: ['Get-Service | Where-Object Status -eq Stopped'],
  },
  {
    id: 'ps-top-cpu',
    title: 'The busiest process',
    shell: 'powershell',
    machineFrom: 'win-pbq-incident-response-taskkill',
    prompt: 'Which process is using the most CPU time? Show only that one process.',
    verifier: (_fs, _s, ctx) => {
      // gps is PowerShell's own alias for Get-Process
      if (!answered(ctx, /get-process|\bgps\b/i)) return false;
      const rows = dataRows(ctx.stdout, PS_PROCESS_HEADER);
      return rows.length === 1 && /\bsvchost_update\s*$/.test(rows[0]);
    },
    hint: 'Sort the output of Get-Process by CPU, largest first, then keep the first one with Select-Object -First 1.',
    explanation:
      'svchost_update, PID 3892. Get-Process | Sort-Object CPU -Descending | Select-Object -First 1 sorts the process objects and keeps the top one. It is the same program that owns the connection to port 4444.',
    solution: ['Get-Process | Sort-Object CPU -Descending | Select-Object -First 1'],
  },
  {
    id: 'ps-servicing-stack',
    title: 'The servicing stack version',
    shell: 'powershell',
    machineFrom: 'win-pbq-sfc-dism-recovery',
    prompt: 'Which line of C:\\Logs\\CBS.log names the servicing stack version? Print only that line.',
    verifier: (_fs, _s, ctx) => {
      if (!answered(ctx, /cbs\.log/i)) return false;
      const out = lines(ctx.stdout);
      return out.length === 1 && /Servicing Stack v10\.0\.22621\.1/.test(out[0]);
    },
    hint: 'Select-String is PowerShell\'s grep: give it -Path and a -Pattern to look for.',
    explanation:
      'Servicing Stack v10.0.22621.1. Get-Content C:\\Logs\\CBS.log | Select-String Servicing prints just the line. Select-String -Path C:\\Logs\\CBS.log -Pattern Servicing finds it too, with the file name and line number in front.',
    solution: ['Get-Content C:\\Logs\\CBS.log | Select-String Servicing'],
  },
];

export const CHALLENGES_BY_ID = new Map(CHALLENGES.map(c => [c.id, c]));

/** Days since 1970-01-01 for a local calendar date, so the pick changes at local midnight. */
function dayNumber(d: Date): number {
  return Math.floor(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()) / 86_400_000);
}

/** The list in a random order fixed by `seed` (Fisher-Yates with a mulberry32 generator), the same on every device */
function shuffled<T>(list: readonly T[], seed: number): T[] {
  let s = seed >>> 0;
  const random = () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const out = [...list];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

/** One cycle's shuffle; a cycle never starts with the challenge the previous cycle ended on */
function cycleOrder<T>(list: readonly T[], cycle: number): T[] {
  const order = shuffled(list, cycle);
  if (order.length > 1 && order[0] === shuffled(list, cycle - 1)[order.length - 1]) [order[0], order[1]] = [order[1], order[0]];
  return order;
}

/**
 * Every challenge, in an order that changes each day. Days run in cycles as long as the list: each
 * cycle shuffles the whole list at random, and each day starts at its own place in that shuffle. So
 * every challenge leads the list (as today's pick) once per cycle, in a new order each cycle.
 */
export function dailyOrder(date: Date = new Date(), list: Challenge[] = CHALLENGES): Challenge[] {
  const n = list.length;
  const day = dayNumber(date);
  const start = ((day % n) + n) % n;
  const order = cycleOrder(list, Math.floor((day - start) / n));
  return [...order.slice(start), ...order.slice(0, start)];
}

/** The challenge highlighted today: the first of today's order. Only a highlight: every challenge is always open. */
export function todaysPick(date: Date = new Date(), list: Challenge[] = CHALLENGES): Challenge {
  return dailyOrder(date, list)[0];
}

/** The activity fact recorded when a challenge is solved */
export const challengeFact = (id: string) => `challenge:${id}`;

/** The challenge after this one in the list, wrapping around */
export function nextChallenge(id: string, list: Challenge[] = CHALLENGES): Challenge {
  const i = list.findIndex(c => c.id === id);
  return list[(i + 1) % list.length];
}
