import { cmdDoc } from '../../docs';
import { NetworkInterface } from '../../../types/terminal';
import { WindowsContext, WindowsResult, cmdCommands } from '../context';
import { allProcesses } from './system';

// CMD networking tools: ipconfig, ping, tracert, nslookup, netstat, route

const isApipa = (ip: string) => ip.startsWith('169.254.');
const DEFAULT_IFACE: NetworkInterface = {
  name: 'Ethernet0', ip: '192.168.1.145', netmask: '255.255.255.0', mac: '00-50-56-A1-2B-3C',
  gateway: '192.168.1.1', dns: ['192.168.1.10', '8.8.8.8'], dhcpEnabled: true, status: 'UP',
};

const toInt = (ip: string) => ip.split('.').reduce((n, o) => (n * 256 + (Number(o) & 255)) >>> 0, 0);
/** True when `ip` is on the adapter's own subnet (so it is reached without the gateway). */
function onSubnet(ip: string, iface: NetworkInterface): boolean {
  if (!/^\d+\.\d+\.\d+\.\d+$/.test(ip) || !iface.netmask || iface.ip === '0.0.0.0') return false;
  const mask = toInt(iface.netmask);
  return ((toInt(ip) & mask) >>> 0) === ((toInt(iface.ip) & mask) >>> 0);
}

/** Public names with their real addresses; other names get a stable made-up public address. */
const PUBLIC_DNS: Record<string, string> = {
  'example.com': '93.184.215.14',
  'www.example.com': '93.184.215.14',
  'google.com': '142.250.80.46',
  'www.google.com': '142.250.80.68',
  'dns.google': '8.8.8.8',
  'one.one.one.one': '1.1.1.1',
  'microsoft.com': '20.70.246.20',
  'www.microsoft.com': '23.45.229.45',
  'comptia.org': '104.18.30.15',
  'www.comptia.org': '104.18.30.15',
  'internetbeacon.msedge.net': '13.107.4.52',
  'www.msftconnecttest.com': '13.107.4.52',
};

/** What a DNS server answers for a name (no hosts file, no client cache). */
export function dnsAnswer(host: string): string {
  const h = host.toLowerCase().replace(/\.$/, '');
  if (/corp\.local$/.test(h) || !h.includes('.')) return h === 'intranet.corp.local' || h === 'intranet' ? '192.168.1.20' : '192.168.1.10';
  if (PUBLIC_DNS[h]) return PUBLIC_DNS[h];
  let n = 0;
  for (const c of h) n = (n * 31 + c.charCodeAt(0)) >>> 0;
  return `142.250.${(n >> 8) & 255}.${n & 255}`;
}

/** True when the adapter has a routable lease and a working gateway. */
export function hasConnectivity(ctx: WindowsContext): boolean {
  const iface = ctx.state.interfaces[0] ?? DEFAULT_IFACE;
  return !isApipa(iface.ip) && iface.ip !== '0.0.0.0' && !!iface.gateway && ctx.state.gatewayWorking !== false;
}

/** Name resolution used by ping/tracert/Test-NetConnection: hosts file first, then a fake DNS. */
export function resolveHost(ctx: WindowsContext, host: string): string | null {
  if (/^\d+\.\d+\.\d+\.\d+$/.test(host)) return host;
  const hosts = ctx.node('C:\\Windows\\System32\\drivers\\etc\\hosts')?.content ?? '';
  for (const line of hosts.split(/\r?\n/)) {
    const [ip, ...names] = line.replace(/#.*/, '').trim().split(/\s+/);
    if (ip && names.some(n => n.toLowerCase() === host.toLowerCase())) return ip;
  }
  if (host.toLowerCase() === 'localhost') return '127.0.0.1';
  if (host.toLowerCase() === ctx.state.hostname.toLowerCase()) return (ctx.state.interfaces[0] ?? DEFAULT_IFACE).ip;
  if (!hasConnectivity(ctx) || ctx.state.dnsWorking === false) return null;
  return dnsAnswer(host);
}

function adapterLines(ctx: WindowsContext, iface: NetworkInterface, all: boolean): string[] {
  const apipa = isApipa(iface.ip);
  const addrLabel = apipa ? '   Autoconfiguration IPv4 Address. . : ' : '   IPv4 Address. . . . . . . . . . . : ';
  const lines = [`Ethernet adapter ${iface.name}:`, '', `   Connection-specific DNS Suffix  . : ${apipa ? '' : 'corp.local'}`];
  if (all) {
    lines.push(
      '   Description . . . . . . . . . . . : Intel(R) 82574L Gigabit Network Connection',
      `   Physical Address. . . . . . . . . : ${iface.mac}`,
      `   DHCP Enabled. . . . . . . . . . . : ${iface.dhcpEnabled ? 'Yes' : 'No'}`,
      '   Autoconfiguration Enabled . . . . : Yes',
      '   Link-local IPv6 Address . . . . . : fe80::49b1:72c8:12e0:98f1%12(Preferred)',
      `${addrLabel}${iface.ip}(Preferred)`,
      `   Subnet Mask . . . . . . . . . . . : ${iface.netmask}`,
    );
    if (iface.dhcpEnabled && !apipa && iface.ip !== '0.0.0.0') {
      lines.push(
        '   Lease Obtained. . . . . . . . . . : Monday, October 19, 2026 8:58:11 AM',
        '   Lease Expires . . . . . . . . . . : Tuesday, October 20, 2026 8:58:11 AM',
      );
    }
    lines.push(`   Default Gateway . . . . . . . . . : ${iface.gateway}`);
    // An APIPA address means no DHCP server answered, so none is listed
    if (iface.dhcpEnabled && !apipa && iface.ip !== '0.0.0.0') lines.push('   DHCP Server . . . . . . . . . . . : 192.168.1.10');
    lines.push(
      `   DNS Servers . . . . . . . . . . . : ${iface.dns.length ? iface.dns.join('\n                                       ') : ''}`,
      '   NetBIOS over Tcpip. . . . . . . . : Enabled',
    );
  } else {
    lines.push(
      '   Link-local IPv6 Address . . . . . : fe80::49b1:72c8:12e0:98f1%12',
      `${addrLabel}${iface.ip}`,
      `   Subnet Mask . . . . . . . . . . . : ${iface.netmask}`,
      `   Default Gateway . . . . . . . . . : ${iface.gateway}`,
    );
  }
  return lines;
}

function displayDns(ctx: WindowsContext): WindowsResult {
  const records: [string, string][] = [['localhost', '127.0.0.1']];
  const hosts = ctx.node('C:\\Windows\\System32\\drivers\\etc\\hosts')?.content ?? '';
  for (const line of hosts.split(/\r?\n/)) {
    const [ip, ...names] = line.replace(/#.*/, '').trim().split(/\s+/);
    if (ip && /^\d/.test(ip)) names.forEach(n => { if (!records.some(r => r[0] === n)) records.push([n, ip]); });
  }
  if (!ctx.state.dnsCacheFlushed) {
    records.push(['www.msftconnecttest.com', '13.107.4.52']);
    // A broken resolver in the scenario left a stale record behind
    records.push(ctx.state.dnsWorking === false ? ['intranet.corp.local', '10.99.0.15'] : ['intranet.corp.local', '192.168.1.20']);
  }
  const blocks = records.map(([name, ip]) => [
    `    ${name}`,
    '    ----------------------------------------',
    `    Record Name . . . . . : ${name}`,
    '    Record Type . . . . . : 1',
    '    Time To Live  . . . . : 3412',
    '    Data Length . . . . . : 4',
    '    Section . . . . . . . : Answer',
    `    A (Host) Record . . . : ${ip}`,
    '',
  ].join('\n'));
  return ctx.ok(['Windows IP Configuration', '', ...blocks].join('\n'));
}

function ipconfig(ctx: WindowsContext): WindowsResult {
  const { state } = ctx;
  // ipconfig accepts -all as well as /all
  const sw = new Set(ctx.args.map(a => a.toLowerCase().replace(/^-/, '/')));
  const needsAdmin = sw.has('/release') || sw.has('/renew') || sw.has('/flushdns') || sw.has('/registerdns');
  if (needsAdmin && !ctx.isAdmin && !sw.has('/flushdns')) {
    return ctx.fail('The requested operation requires elevation.', 1,
      `You are '${state.currentUser}', a standard user (not elevated). Releasing or renewing a DHCP lease changes the network configuration, so run the prompt as administrator.`);
  }
  if (sw.has('/displaydns')) return displayDns(ctx);
  if (sw.has('/flushdns')) {
    state.dnsWorking = true;
    state.dnsCacheFlushed = true;
    return ctx.ok(['Windows IP Configuration', '', 'Successfully flushed the DNS Resolver Cache.'].join('\n'));
  }
  if (sw.has('/release')) {
    state.interfaces = state.interfaces.map(i => ({ ...i, ip: '0.0.0.0', netmask: '0.0.0.0', gateway: '' }));
  }
  if (sw.has('/renew')) {
    state.interfaces = state.interfaces.map(i => ({ ...i, ip: '192.168.1.145', netmask: '255.255.255.0', gateway: '192.168.1.1' }));
    state.gatewayWorking = true;
  }
  const iface = state.interfaces[0] ?? DEFAULT_IFACE;
  const lines = ['Windows IP Configuration', ''];
  if (sw.has('/all')) {
    lines.push(
      `   Host Name . . . . . . . . . . . . : ${state.hostname}`,
      '   Primary Dns Suffix  . . . . . . . : corp.local',
      '   Node Type . . . . . . . . . . . . : Hybrid',
      '   IP Routing Enabled. . . . . . . . : No',
      '   WINS Proxy Enabled. . . . . . . . : No',
      '   DNS Suffix Search List. . . . . . : corp.local',
      '',
    );
  }
  lines.push(...adapterLines(ctx, iface, sw.has('/all')));
  return ctx.ok(lines.join('\n'));
}

/** Windows ping options that take a value. */
const PING_VALUE_OPTS = new Set(['n', 'l', 'i', 'v', 'r', 's', 'w', 'S', 'c', 'j', 'k']);

function ping(ctx: WindowsContext): WindowsResult {
  let count = 4;
  let size = 32;
  let forever = false;
  let target = '';
  for (let i = 0; i < ctx.args.length; i++) {
    const a = ctx.args[i];
    const opt = a.match(/^[-/](\w)$/);
    if (opt) {
      if (opt[1] === 't') forever = true;
      else if (PING_VALUE_OPTS.has(opt[1]) || PING_VALUE_OPTS.has(opt[1].toLowerCase())) {
        const value = ctx.args[++i];
        if (value === undefined) return ctx.fail(`Value must be supplied for option ${a}.`, 1);
        const n = Number(value);
        if (opt[1].toLowerCase() === 'n') {
          if (!Number.isInteger(n) || n < 1) return ctx.fail(`Bad value for option ${a}, valid range is from 1 to 4294967295.`, 1);
          count = n;
        }
        if (opt[1].toLowerCase() === 'l') size = n;
      }
      continue;
    }
    if (!target) target = a;
  }
  if (!target) return ctx.result(cmdDoc('ping')!.usage, '', 1);
  const ip = resolveHost(ctx, target);
  if (!ip) {
    return ctx.fail(`Ping request could not find host ${target}. Please check the name and try again.`, 1);
  }
  // -t keeps going until Ctrl+C; the simulator shows four replies and the interrupt
  const sent = forever ? 4 : count;
  const label = ip === target ? ip : `${target} [${ip}]`;
  const iface = ctx.state.interfaces[0] ?? DEFAULT_IFACE;
  // The loopback range and the PC's own addresses always answer, whatever the network state
  const local = ip.startsWith('127.') || ctx.state.interfaces.some(i => i.ip === ip);
  const lan = !local && onSubnet(ip, iface);
  const head = `Pinging ${label} with ${size} bytes of data:`;
  const failed = (line: string) => ctx.result([
    head,
    ...Array(sent).fill(line),
    '',
    `Ping statistics for ${ip}:`,
    `    Packets: Sent = ${sent}, Received = 0, Lost = ${sent} (100% loss),`,
    ...(forever ? ['Control-C', '^C'] : []),
  ].join('\n'), '', 1);
  if (!local && !hasConnectivity(ctx)) {
    // With no usable address or no route there is nothing to send on; with a dead gateway packets go out unanswered
    const noRoute = isApipa(iface.ip) || iface.ip === '0.0.0.0' || (!lan && !iface.gateway);
    return failed(noRoute ? 'PING: transmit failed. General failure.' : 'Request timed out.');
  }
  // Hosts on the LAN answer in under a millisecond; the router (TTL 64) and Windows hosts (TTL 128) differ
  const fast = local || lan;
  const times = Array.from({ length: sent }, (_, i) => (fast ? 0 : [12, 11, 14, 12][i % 4]));
  const ttl = local ? 128 : lan ? (ip === iface.gateway ? 64 : 128) : 118;
  return ctx.ok([
    head,
    ...times.map(t => `Reply from ${ip}: bytes=${size} time${fast ? '<1ms' : `=${t}ms`} TTL=${ttl}`),
    '',
    `Ping statistics for ${ip}:`,
    `    Packets: Sent = ${sent}, Received = ${sent}, Lost = 0 (0% loss),`,
    'Approximate round trip times in milli-seconds:',
    `    Minimum = ${Math.min(...times)}ms, Maximum = ${Math.max(...times)}ms, Average = ${Math.floor(times.reduce((x, y) => x + y, 0) / sent)}ms`,
    ...(forever ? ['Control-C', '^C'] : []),
  ].join('\n'));
}

function tracert(ctx: WindowsContext): WindowsResult {
  const target = ctx.args.find(a => !a.startsWith('/')) || '8.8.8.8';
  const ip = resolveHost(ctx, target);
  if (!ip) return ctx.fail(`Unable to resolve target system name ${target}.`, 1);
  if (!hasConnectivity(ctx)) {
    return ctx.result([`Tracing route to ${target} over a maximum of 30 hops`, '', '  1     *        *        *     Request timed out.', '', 'Trace complete.'].join('\n'), '', 1);
  }
  const gw = ctx.state.interfaces[0]?.gateway || '192.168.1.1';
  return ctx.ok([
    `Tracing route to ${ip === target ? target : `${target} [${ip}]`} over a maximum of 30 hops`,
    '',
    `  1    <1 ms    <1 ms    <1 ms  ${gw}`,
    '  2     4 ms     3 ms     3 ms  10.200.0.1',
    '  3     9 ms     8 ms     8 ms  core-edge-01.isp.net [72.14.200.1]',
    `  4    12 ms    12 ms    11 ms  ${ip}`,
    '',
    'Trace complete.',
  ].join('\n'));
}

function nslookup(ctx: WindowsContext): WindowsResult {
  const domain = ctx.args.find(a => !a.startsWith('-')) || 'corpdc.corp.local';
  const server = ctx.state.interfaces[0]?.dns[0] ?? '192.168.1.10';
  if (!hasConnectivity(ctx)) {
    return ctx.result(['DNS request timed out.', '    timeout was 2 seconds.', 'Server:  UnKnown', `Address:  ${server}`, '',
      'DNS request timed out.', '    timeout was 2 seconds.', `*** Request to UnKnown timed-out`].join('\n'), '', 1);
  }
  // nslookup asks the DNS server directly: neither the hosts file nor the client cache is used
  const serverName = server === '192.168.1.10' ? 'dc01.corp.local' : server === '8.8.8.8' ? 'dns.google' : server === '1.1.1.1' ? 'one.one.one.one' : 'UnKnown';
  if (/^\d+\.\d+\.\d+\.\d+$/.test(domain)) {
    const known = domain === '192.168.1.10' ? 'dc01.corp.local' : domain === '8.8.8.8' ? 'dns.google' : undefined;
    if (!known) return ctx.result([`Server:  ${serverName}`, `Address:  ${server}`, ''].join('\n'), `*** ${serverName} can't find ${domain}: Non-existent domain`, 1);
    return ctx.ok([`Server:  ${serverName}`, `Address:  ${server}`, '', `Name:    ${known}`, `Address:  ${domain}`].join('\n'));
  }
  const internal = /corp\.local$/i.test(domain) || !domain.includes('.');
  const fqdn = internal && !domain.includes('.') ? `${domain}.corp.local` : domain;
  return ctx.ok([
    `Server:  ${serverName}`, `Address:  ${server}`, '',
    // Answers about other zones come from the server's cache or a forwarder
    ...(internal && serverName === 'dc01.corp.local' ? [] : ['Non-authoritative answer:']),
    `Name:    ${fqdn}`, `Address:  ${dnsAnswer(fqdn)}`,
  ].join('\n'));
}

function routeTable(ctx: WindowsContext): string {
  const iface = ctx.state.interfaces[0] ?? DEFAULT_IFACE;
  const ip = iface.ip;
  const gw = iface.gateway;
  const mask = iface.netmask.split('.').map(Number);
  const net = ip.split('.').map((o, i) => Number(o) & (mask[i] ?? 0)).join('.');
  const rows = [
    ...(gw ? [`          0.0.0.0          0.0.0.0  ${gw.padStart(15)}  ${ip.padStart(15)}     25`] : []),
    '        127.0.0.0        255.0.0.0         On-link         127.0.0.1    331',
    ...(ip !== '0.0.0.0' ? [
      `  ${net.padStart(15)}  ${iface.netmask.padStart(15)}         On-link  ${ip.padStart(15)}    281`,
      `  ${ip.padStart(15)}  255.255.255.255         On-link  ${ip.padStart(15)}    281`,
    ] : []),
  ];
  return [
    '===========================================================================',
    'Interface List',
    `  3...${iface.mac.toLowerCase().replace(/-/g, ' ')} ......Intel(R) 82574L Gigabit Network Connection`,
    '  1...........................Software Loopback Interface 1',
    '===========================================================================',
    '',
    'IPv4 Route Table',
    '===========================================================================',
    'Active Routes:',
    'Network Destination        Netmask          Gateway       Interface  Metric',
    ...rows,
    '===========================================================================',
    'Persistent Routes:',
    '  None',
  ].join('\r\n');
}

export interface Connection { local: string; localPort: number; remote: string; remotePort: number; state: 'LISTENING' | 'ESTABLISHED'; pid: number }

/** The machine's TCP sockets, shared by netstat and Get-NetTCPConnection. */
export function connections(ctx: WindowsContext): Connection[] {
  const ip = ctx.state.interfaces[0]?.ip ?? '192.168.1.145';
  const list: Connection[] = [
    { local: '0.0.0.0', localPort: 135, remote: '0.0.0.0', remotePort: 0, state: 'LISTENING', pid: 844 },
    { local: '0.0.0.0', localPort: 445, remote: '0.0.0.0', remotePort: 0, state: 'LISTENING', pid: 4 },
  ];
  // The session to the domain controller exists only while the network works
  if (hasConnectivity(ctx)) list.push({ local: ip, localPort: 49668, remote: '192.168.1.10', remotePort: 389, state: 'ESTABLISHED', pid: 1120 });
  // A rogue process in the scenario shows up as an outbound connection
  for (const p of ctx.state.processes) {
    if (p.isMalicious && p.port) list.push({ local: ip, localPort: 49811, remote: '203.0.113.88', remotePort: p.port, state: 'ESTABLISHED', pid: p.pid });
  }
  return list;
}

/** Services shown above the image name by netstat -b, for svchost-hosted sockets. */
const NETSTAT_SERVICE: Record<number, string> = { 844: 'RpcSs', 1120: 'Netlogon' };

function netstat(ctx: WindowsContext): WindowsResult {
  const flags = ctx.args.filter(a => a.startsWith('-') || a.startsWith('/')).map(a => a.slice(1).toLowerCase()).join('');
  if (flags.includes('r')) return ctx.ok(routeTable(ctx));
  const showPid = flags.includes('o');
  const all = flags.includes('a');
  const exe = flags.includes('b');
  if (exe && !ctx.isAdmin) {
    return ctx.fail('The requested operation requires elevation.', 1,
      `You are '${ctx.state.currentUser}', a standard user (not elevated). netstat -b looks up the program that owns each connection, which needs an elevated prompt.`);
  }
  const header = `  Proto  Local Address          Foreign Address        State${showPid ? '           PID' : ''}`;
  const procs = allProcesses(ctx);
  const rows: string[] = [];
  for (const c of connections(ctx)) {
    if (c.state === 'LISTENING' && !all) continue;
    rows.push(`  ${'TCP'.padEnd(5)}  ${`${c.local}:${c.localPort}`.padEnd(21)}  ${`${c.remote}:${c.remotePort}`.padEnd(21)}  ${c.state.padEnd(14)}${showPid ? `  ${c.pid}` : ''}`.trimEnd());
    if (exe) {
      const p = procs.find(x => x.pid === c.pid);
      if (!p || p.pid === 4) rows.push(' Can not obtain ownership information');
      else rows.push(...(NETSTAT_SERVICE[p.pid] ? [`  ${NETSTAT_SERVICE[p.pid]}`] : []), ` [${p.command}]`);
    }
  }
  return ctx.ok(`\nActive Connections\n\n${header}\n${rows.join('\n')}`);
}

function route(ctx: WindowsContext): WindowsResult {
  if (ctx.args[0]?.toLowerCase() === 'print') return ctx.ok(routeTable(ctx));
  return ctx.ok('Manipulates network routing tables.\n\nROUTE [-f] [-p] [-4|-6] command [destination]\n                  [MASK netmask]  [gateway] [METRIC metric]  [IF interface]');
}

cmdCommands.registerAll({ ipconfig, ping, tracert, nslookup, netstat, route });
