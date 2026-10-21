import { cmdDoc } from '../../docs';
import { NetworkInterface } from '../../../types/terminal';
import { WindowsContext, WindowsResult, cmdCommands } from '../context';

// CMD networking tools: ipconfig, ping, tracert, nslookup, netstat, route

const isApipa = (ip: string) => ip.startsWith('169.254.');
const DEFAULT_IFACE: NetworkInterface = {
  name: 'Ethernet0', ip: '192.168.1.145', netmask: '255.255.255.0', mac: '00-50-56-A1-2B-3C',
  gateway: '192.168.1.1', dns: ['192.168.1.10', '8.8.8.8'], dhcpEnabled: true, status: 'UP',
};

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
  if (!hasConnectivity(ctx) || ctx.state.dnsWorking === false) return null;
  if (/corp\.local$/i.test(host) || !host.includes('.')) return '192.168.1.10';
  // Stable fake public address per name
  let h = 0;
  for (const c of host.toLowerCase()) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return `142.250.${(h >> 8) & 255}.${h & 255}`;
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
  const sw = new Set(ctx.args.map(a => a.toLowerCase()));
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
  const local = ip.startsWith('127.');
  const head = `Pinging ${label} with ${size} bytes of data:`;
  if (!local && !hasConnectivity(ctx)) {
    return ctx.result([
      head,
      ...Array(sent).fill('PING: transmit failed. General failure.'),
      '',
      `Ping statistics for ${ip}:`,
      `    Packets: Sent = ${sent}, Received = 0, Lost = ${sent} (100% loss),`,
      ...(forever ? ['Control-C', '^C'] : []),
    ].join('\n'), '', 1);
  }
  const times = Array.from({ length: sent }, (_, i) => (local ? 0 : [12, 11, 14, 12][i % 4]));
  const ttl = local ? 128 : 118;
  return ctx.ok([
    head,
    ...times.map(t => `Reply from ${ip}: bytes=${size} time${local ? '<1ms' : `=${t}ms`} TTL=${ttl}`),
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
  const ip = resolveHost(ctx, domain) ?? '192.168.1.10';
  return ctx.ok(['Server:  dc01.corp.local', `Address:  ${server}`, '', `Name:    ${domain}`, `Address:  ${ip}`].join('\n'));
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

function netstat(ctx: WindowsContext): WindowsResult {
  const flags = ctx.args.filter(a => a.startsWith('-') || a.startsWith('/')).map(a => a.slice(1).toLowerCase()).join('');
  if (flags.includes('r')) return ctx.ok(routeTable(ctx));
  const showPid = flags.includes('o');
  const all = flags.includes('a');
  const ip = ctx.state.interfaces[0]?.ip ?? '192.168.1.145';
  const header = `  Proto  Local Address          Foreign Address        State${showPid ? '           PID' : ''}`;
  const row = (proto: string, local: string, remote: string, state: string, pid: number) =>
    `  ${proto.padEnd(5)}  ${local.padEnd(21)}  ${remote.padEnd(21)}  ${state.padEnd(14)}${showPid ? `  ${pid}` : ''}`.trimEnd();
  const rows = [
    ...(all ? [row('TCP', '0.0.0.0:135', '0.0.0.0:0', 'LISTENING', 844), row('TCP', '0.0.0.0:445', '0.0.0.0:0', 'LISTENING', 4)] : []),
    row('TCP', `${ip}:49668`, '192.168.1.10:389', 'ESTABLISHED', 1120),
  ];
  // A rogue process in the scenario shows up as an outbound connection
  for (const p of ctx.state.processes) {
    if (p.isMalicious && p.port) rows.push(row('TCP', `${ip}:49811`, `203.0.113.88:${p.port}`, 'ESTABLISHED', p.pid));
  }
  return ctx.ok(`\nActive Connections\n\n${header}\n${rows.join('\n')}`);
}

function route(ctx: WindowsContext): WindowsResult {
  if (ctx.args[0]?.toLowerCase() === 'print') return ctx.ok(routeTable(ctx));
  return ctx.ok('Manipulates network routing tables.\n\nROUTE [-f] [-p] [-4|-6] command [destination]\n                  [MASK netmask]  [gateway] [METRIC metric]  [IF interface]');
}

cmdCommands.registerAll({ ipconfig, ping, tracert, nslookup, netstat, route });
