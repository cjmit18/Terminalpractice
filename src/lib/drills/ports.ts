// Generated ports and protocols drills (CompTIA Network+ N10-009, objective 1.4). A question is made from a
// seed and its answer comes from one reviewed table, so a new seed is a new question and there is no separate
// answer key to keep in step.
import { seededRandom } from '../rotation';

export interface PortProtocol {
  /** The usual short name, e.g. "SSH" */
  name: string;
  /** The full name as CompTIA prints it */
  full: string;
  ports: number[];
  /** Transport layer, only where the answer is clear-cut; left out where the protocol also runs over the other */
  transport?: 'TCP' | 'UDP' | 'both';
  /** Other names a learner may reasonably type for it */
  aliases?: string[];
  /** What it is for, without its name or ports: the hint */
  clue: string;
  /** A line on what it is for, shown in every explanation */
  use: string;
}

/**
 * The ports in N10-009 objective 1.4, exactly as CompTIA lists them (Exam Objectives version 4.0, checked
 * 2026-11-22 against the PDF linked in src/data/examObjectives.ts). CompTIA does not print TCP or UDP; the
 * transport here is the protocol's usual one, and is left out where the protocol also runs over the other, so
 * "TCP, UDP or both?" would have no single right answer: HTTPS (HTTP/3 over QUIC), LDAP (CLDAP), RDP (its
 * UDP transport), SIP (both), SNMP (TCP, RFC 3430) and Syslog (TLS over TCP, RFC 5425) (#87 review).
 */
export const NETPLUS_PORTS: readonly PortProtocol[] = [
  { name: 'FTP', full: 'File Transfer Protocol', ports: [20, 21], transport: 'TCP', clue: 'moving files, with one connection for commands and another for data', use: 'file transfer; 21 carries commands, 20 carries data in active mode' },
  { name: 'SFTP', full: 'Secure File Transfer Protocol', ports: [22], transport: 'TCP', aliases: ['ssh file transfer protocol'], clue: 'moving files inside an encrypted remote-login connection', use: 'file transfer over an SSH connection' },
  { name: 'SSH', full: 'Secure Shell', ports: [22], transport: 'TCP', clue: 'an encrypted remote command line', use: 'encrypted remote command line' },
  { name: 'Telnet', full: 'Telnet', ports: [23], transport: 'TCP', clue: 'a remote command line that sends everything in plain text', use: 'remote command line in plain text, replaced by SSH' },
  { name: 'SMTP', full: 'Simple Mail Transfer Protocol', ports: [25], transport: 'TCP', clue: 'sending mail from one server to another', use: 'sending mail between servers' },
  { name: 'DNS', full: 'Domain Name System', ports: [53], transport: 'both', clue: 'turning names such as example.com into addresses', use: 'name lookups: UDP for most queries, TCP for zone transfers and large answers' },
  { name: 'DHCP', full: 'Dynamic Host Configuration Protocol', ports: [67, 68], transport: 'UDP', clue: 'handing out IP addresses, gateways and DNS servers automatically', use: 'handing out IP addresses; servers listen on 67, clients on 68' },
  { name: 'TFTP', full: 'Trivial File Transfer Protocol', ports: [69], transport: 'UDP', clue: 'simple file transfer with no login, as used for network boot', use: 'simple file transfer with no login, used for network boot and device configs' },
  { name: 'HTTP', full: 'Hypertext Transfer Protocol', ports: [80], transport: 'TCP', clue: 'web pages without encryption', use: 'web pages without encryption' },
  { name: 'NTP', full: 'Network Time Protocol', ports: [123], transport: 'UDP', clue: 'keeping clocks in step', use: 'keeping clocks in step' },
  { name: 'SNMP', full: 'Simple Network Management Protocol', ports: [161, 162], clue: 'monitoring network devices and receiving their alerts', use: 'monitoring devices; queries go to 161, traps arrive on 162' },
  { name: 'LDAP', full: 'Lightweight Directory Access Protocol', ports: [389], clue: 'looking up users and groups in a directory, in plain text', use: 'directory lookups, such as Active Directory' },
  { name: 'HTTPS', full: 'Hypertext Transfer Protocol Secure', ports: [443], clue: 'web pages with encryption', use: 'web pages over TLS' },
  { name: 'SMB', full: 'Server Message Block', ports: [445], transport: 'TCP', aliases: ['cifs'], clue: 'Windows file and printer sharing', use: 'Windows file and printer sharing' },
  { name: 'Syslog', full: 'Syslog', ports: [514], clue: 'sending log messages to a central server', use: 'sending log messages to a central server' },
  { name: 'SMTPS', full: 'Simple Mail Transfer Protocol Secure', ports: [587], transport: 'TCP', aliases: ['smtp secure', 'smtp over tls'], clue: 'sending mail with encryption', use: 'sending mail with encryption. CompTIA lists 587, the submission port that upgrades to TLS with STARTTLS; 465 is the registered port for submission over TLS from the start' },
  { name: 'LDAPS', full: 'Lightweight Directory Access Protocol over SSL', ports: [636], transport: 'TCP', aliases: ['ldap over ssl', 'ldap over tls'], clue: 'looking up users and groups in a directory, with encryption', use: 'directory lookups over TLS' },
  { name: 'SQL Server', full: 'Structured Query Language (SQL) Server', ports: [1433], transport: 'TCP', aliases: ['sql', 'mssql', 'microsoft sql server', 'ms sql'], clue: "Microsoft's database server", use: "Microsoft's database server" },
  { name: 'RDP', full: 'Remote Desktop Protocol', ports: [3389], clue: 'remote control of a Windows desktop', use: 'Windows remote desktop' },
  { name: 'SIP', full: 'Session Initiation Protocol', ports: [5060, 5061], clue: 'setting up voice and video calls', use: 'setting up voice and video calls; 5061 is SIP over TLS' },
];

export type PortQuestionKind = 'port' | 'protocol' | 'transport';
export const PORT_KINDS: readonly PortQuestionKind[] = ['port', 'protocol', 'transport'];

export interface PortQuestion {
  seed: number;
  kind: PortQuestionKind;
  prompt: string;
  /** The answer as it is shown: "22", "20 and 21", "SSH or SFTP", "UDP" */
  answer: string;
  explanation: string;
  /** A nudge that does not give the answer away */
  hint: string;
  objectives: string[];
  /** What the checker compares against (normalised) */
  accept: string[][];
}

const OBJECTIVES = ['n10-009:1.0'];
const PROTOCOLS_BY_PORT = new Map<number, PortProtocol[]>();
for (const p of NETPLUS_PORTS) for (const port of p.ports) PROTOCOLS_BY_PORT.set(port, [...(PROTOCOLS_BY_PORT.get(port) ?? []), p]);
const ALL_PORTS = [...PROTOCOLS_BY_PORT.keys()].sort((a, b) => a - b);
const WITH_TRANSPORT = NETPLUS_PORTS.filter(p => p.transport);

/** Lower case, letters and digits only: "SQL Server" and "sqlserver" match */
const norm = (text: string) => text.toLowerCase().replace(/[^a-z0-9]/g, '');
const namesOf = (p: PortProtocol) => [p.name, p.full, ...(p.aliases ?? [])].map(norm);
const listPorts = (ports: number[]) => (ports.length === 1 ? String(ports[0]) : `${ports.slice(0, -1).join(', ')} and ${ports.at(-1)}`);
const describe = (p: PortProtocol) => `${p.name} (${p.full}) uses ${p.ports.length > 1 ? 'ports' : 'port'} ${listPorts(p.ports)}: ${p.use}.`;

export function generatePortQuestion(seed: number, kind?: PortQuestionKind): PortQuestion {
  const random = seededRandom(seed);
  const pick = <T,>(list: readonly T[]): T => list[Math.floor(random() * list.length)];
  // Drawn in a fixed order, so the same seed always gives the same question
  const drawnKind = pick(PORT_KINDS);
  const protocol = pick(NETPLUS_PORTS);
  const port = pick(ALL_PORTS);
  const withTransport = pick(WITH_TRANSPORT);
  const k = kind ?? drawnKind;
  const make = (prompt: string, answer: string, explanation: string, accept: string[][], hint: string): PortQuestion => ({ seed, kind: k, prompt, answer, explanation, hint, objectives: OBJECTIVES, accept });

  switch (k) {
    case 'port': {
      const two = protocol.ports.length > 1;
      return make(
        // SMTPS has two conventions (587 and 465); the drill teaches the one CompTIA lists, and says so
        protocol.name === 'SMTPS'
          ? 'Which port does the CompTIA Network+ list give for SMTPS?'
          : two ? `Which two ports does ${protocol.name} use?` : `Which port does ${protocol.name} use?`,
        listPorts(protocol.ports),
        describe(protocol),
        [protocol.ports.map(String)],
        `${protocol.name} stands for ${protocol.full}, used for ${protocol.clue}. ${protocol.ports[0] < 1024 ? 'It is a well-known port, below 1024.' : 'It is a registered port, above 1023.'}`,
      );
    }
    case 'protocol': {
      const owners = PROTOCOLS_BY_PORT.get(port)!;
      return make(
        `Which protocol uses port ${port}?`,
        owners.map(o => o.name).join(' or '),
        `${owners.map(describe).join(' ')}${owners.length > 1 ? ' Either name is right.' : ''}`,
        owners.map(namesOf),
        `Port ${port} is used for ${owners.map(o => o.clue).join(', and also for ')}.`,
      );
    }
    case 'transport': {
      const t = withTransport.transport!;
      return make(
        `Does ${withTransport.name} use TCP, UDP or both?`,
        t === 'both' ? 'both' : t,
        `${describe(withTransport)} It runs over ${t === 'both' ? 'both TCP and UDP' : t}.`,
        [[t.toLowerCase()]],
        `${withTransport.name} is used for ${withTransport.clue}. Does that need a connection with guaranteed delivery (TCP), quick small messages (UDP), or each at different times?`,
      );
    }
  }
}

/** True when what the learner typed means the same as the question's answer */
export function checkPortAnswer(q: PortQuestion, input: string): boolean {
  const typed = input.trim();
  if (typed === '') return false;
  switch (q.kind) {
    case 'port': {
      // Every port, each once, in any order, with one separator between each: "20/21", "21, 20", "20 and 21".
      // Not "20,,21" or "20/" (#87 review)
      if (!/^\d{1,5}(\s*(,|\/|&|\band\b)\s*\d{1,5}|\s+\d{1,5})*$/i.test(typed)) return false;
      const numbers = typed.split(/\s*(?:,|\/|&|\band\b)\s*|\s+/i);
      const want = q.accept[0];
      return numbers.length === want.length && want.every(p => numbers.includes(p));
    }
    case 'protocol': {
      // One name is enough where two protocols share the port; "SSH or SFTP", "SSH and SFTP" or "SSH, SFTP"
      // name both and are right too. Each separator must have a name on both sides (#87 review)
      const raw = typed.split(/\s+(?:or|and)\s+|\s*[/,&]\s*/i);
      if (raw.some(r => r.trim() === '')) return false;
      const parts = raw.map(norm);
      return parts.length > 0 && parts.length <= q.accept.length && parts.every(t => q.accept.some(names => names.includes(t)))
        && new Set(parts.map(t => q.accept.findIndex(names => names.includes(t)))).size === parts.length;
    }
    case 'transport':
      return norm(typed) === q.accept[0][0] || (q.accept[0][0] === 'both' && /^(tcp\W*(and|\/|&)\W*udp|udp\W*(and|\/|&)\W*tcp)$/i.test(typed));
  }
}
