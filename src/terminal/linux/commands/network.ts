import { LinuxContext, LinuxResult, linuxCommands } from '../context';
import { parseOptions } from '../../textUtils';

// Networking: ip, ifconfig, ping, ss, netstat

const octets = (a: string) => a.split('.').map(Number);
/** 255.255.255.0 -> 24 */
export function prefixLength(mask: string): number {
  return octets(mask).reduce((n, o) => n + (o >>> 0).toString(2).split('').filter(b => b === '1').length, 0);
}
function broadcast(ip: string, mask: string): string {
  const m = octets(mask);
  return octets(ip).map((o, i) => (o & m[i]) | (~m[i] & 255)).join('.');
}

function ip(ctx: LinuxContext): LinuxResult {
  const sub = ctx.args[0];
  if (sub === 'addr' || sub === 'a') {
    return ctx.ok(ctx.state.interfaces.map((iface, idx) => {
      if (iface.name === 'lo') {
        return `${idx + 1}: lo: <LOOPBACK,UP,LOWER_UP> mtu 65536 qdisc noqueue state UNKNOWN\n    link/loopback 00:00:00:00:00:00 brd 00:00:00:00:00:00\n    inet ${iface.ip}/${prefixLength(iface.netmask)} scope host lo`;
      }
      return `${idx + 1}: ${iface.name}: <BROADCAST,MULTICAST,${iface.status}> mtu 1500 qdisc fq_codel state ${iface.status}\n    link/ether ${iface.mac} brd ff:ff:ff:ff:ff:ff\n    inet ${iface.ip}/${prefixLength(iface.netmask)} brd ${broadcast(iface.ip, iface.netmask)} scope global ${iface.name}`;
    }).join('\n'));
  }
  if (sub === 'route' || sub === 'r') {
    return ctx.ok('default via 192.168.1.1 dev eth0 proto dhcp src 192.168.1.105 metric 100\n192.168.1.0/24 dev eth0 proto kernel scope link src 192.168.1.105');
  }
  return ctx.ok('Usage: ip [ OPTIONS ] OBJECT { COMMAND | help }');
}

function ifconfig(ctx: LinuxContext): LinuxResult {
  return ctx.ok(ctx.state.interfaces.map(iface =>
    `${iface.name}: flags=4163<UP,BROADCAST,RUNNING,MULTICAST>  mtu 1500\n        inet ${iface.ip}  netmask ${iface.netmask}  broadcast ${broadcast(iface.ip, iface.netmask)}\n        ether ${iface.mac}  txqueuelen 1000  (Ethernet)\n        RX packets 15822  bytes 12948102 (12.9 MB)\n        TX packets 11200  bytes 1840291 (1.8 MB)`
  ).join('\n\n'));
}

function ping(ctx: LinuxContext): LinuxResult {
  const host = ctx.args.find(a => !a.startsWith('-')) || 'localhost';
  return ctx.ok([
    `PING ${host} (${host === '8.8.8.8' ? '8.8.8.8' : '192.168.1.1'}) 56(84) bytes of data.`,
    `64 bytes from ${host}: icmp_seq=1 ttl=117 time=14.2 ms`,
    `64 bytes from ${host}: icmp_seq=2 ttl=117 time=13.8 ms`,
    `64 bytes from ${host}: icmp_seq=3 ttl=117 time=14.0 ms`,
    `64 bytes from ${host}: icmp_seq=4 ttl=117 time=14.1 ms`,
    '',
    `--- ${host} ping statistics ---`,
    '4 packets transmitted, 4 received, 0% packet loss, time 3004ms',
    'rtt min/avg/max/mdev = 13.811/14.025/14.212/0.141 ms',
  ].join('\n'));
}

// ---------- sockets: ss and netstat ----------

interface Socket { proto: 'tcp' | 'udp'; local: string; port: number; peer: string; state: 'LISTEN' | 'ESTAB' | 'UNCONN'; program: string; pid: number }

const SERVICE_PORTS: Record<string, { port: number; program: string; pid: number }> = {
  ssh: { port: 22, program: 'sshd', pid: 1420 },
  nginx: { port: 80, program: 'nginx', pid: 1201 },
};
const PORT_NAMES: Record<number, string> = { 22: 'ssh', 53: 'domain', 80: 'http', 443: 'https' };

/** Sockets derived from processes with a port and from running services, so ps/systemctl agree. */
function sockets(ctx: LinuxContext): Socket[] {
  const list: Socket[] = [
    { proto: 'udp', local: '127.0.0.53', port: 53, peer: '0.0.0.0:*', state: 'UNCONN', program: 'systemd-resolve', pid: 588 },
  ];
  for (const p of ctx.state.processes) {
    if (!p.port) continue;
    const program = p.command.split(/\s+/)[0].split('/').pop() ?? p.command;
    list.push({ proto: 'tcp', local: '0.0.0.0', port: p.port, peer: '0.0.0.0:*', state: 'LISTEN', program, pid: p.pid });
  }
  for (const s of ctx.state.services) {
    const known = SERVICE_PORTS[s.name.toLowerCase()];
    if (!known || s.status !== 'Running' || list.some(x => x.port === known.port)) continue;
    list.push({ proto: 'tcp', local: '0.0.0.0', peer: '0.0.0.0:*', state: 'LISTEN', ...known });
  }
  const ip = ctx.state.interfaces.find(i => i.name !== 'lo')?.ip ?? '192.168.1.105';
  if (list.some(x => x.port === 22)) {
    list.push({ proto: 'tcp', local: ip, port: 22, peer: '192.168.1.100:51220', state: 'ESTAB', program: 'sshd', pid: 2088 });
  }
  return list.sort((a, b) => (a.proto === b.proto ? a.port - b.port : a.proto === 'udp' ? -1 : 1));
}

function socketFilter(ctx: LinuxContext, f: Set<string>): Socket[] {
  const wantTcp = f.has('t') || !f.has('u');
  const wantUdp = f.has('u') || !f.has('t');
  return sockets(ctx).filter(s => {
    if (s.proto === 'tcp' ? !wantTcp : !wantUdp) return false;
    const listening = s.state !== 'ESTAB';
    if (f.has('a')) return true;
    return f.has('l') ? listening : !listening;
  });
}

function ss(ctx: LinuxContext): LinuxResult {
  const f = parseOptions(ctx.args, '', { tcp: 't', udp: 'u', listening: 'l', numeric: 'n', processes: 'p', all: 'a' }).flags;
  const port = (n: number) => (f.has('n') ? String(n) : PORT_NAMES[n] ?? String(n));
  const rows = socketFilter(ctx, f).map(s => {
    const local = `${s.local === '127.0.0.53' ? '127.0.0.53%lo' : s.local}:${port(s.port)}`;
    const proc = f.has('p') && ctx.isRoot ? ` users:(("${s.program}",pid=${s.pid},fd=3))` : '';
    return `${s.proto.padEnd(5)} ${s.state.padEnd(6)} 0      ${s.state === 'LISTEN' ? '128' : '0  '}    ${local.padStart(20)} ${s.peer.padStart(20)}${proc}`;
  });
  return ctx.ok(['Netid State  Recv-Q Send-Q        Local Address:Port    Peer Address:Port Process', ...rows].join('\n'));
}

function netstat(ctx: LinuxContext): LinuxResult {
  const f = parseOptions(ctx.args, '', { route: 'r', tcp: 't', udp: 'u', listening: 'l', numeric: 'n', program: 'p', all: 'a' }).flags;
  if (f.has('r')) {
    const iface = ctx.state.interfaces.find(i => i.name !== 'lo');
    const gw = iface?.gateway || '192.168.1.1';
    const net = (iface?.ip ?? '192.168.1.105').split('.').slice(0, 3).join('.') + '.0';
    const n = f.has('n');
    return ctx.ok([
      'Kernel IP routing table',
      'Destination     Gateway         Genmask         Flags   MSS Window  irtt Iface',
      `${(n ? '0.0.0.0' : 'default').padEnd(15)} ${(n ? gw : '_gateway').padEnd(15)} 0.0.0.0         UG        0 0          0 ${iface?.name ?? 'eth0'}`,
      `${net.padEnd(15)} 0.0.0.0         ${iface?.netmask ?? '255.255.255.0'}   U         0 0          0 ${iface?.name ?? 'eth0'}`,
    ].join('\n'));
  }
  const port = (n: number) => (f.has('n') ? String(n) : PORT_NAMES[n] ?? String(n));
  const showProg = f.has('p');
  const title = f.has('a') ? 'Active Internet connections (servers and established)'
    : f.has('l') ? 'Active Internet connections (only servers)' : 'Active Internet connections (w/o servers)';
  const header = `Proto Recv-Q Send-Q Local Address           Foreign Address         State      ${showProg ? ' PID/Program name' : ''}`.trimEnd();
  const rows = socketFilter(ctx, f).map(s => {
    const local = `${s.local}:${port(s.port)}`;
    const state = s.state === 'ESTAB' ? 'ESTABLISHED' : s.state === 'LISTEN' ? 'LISTEN' : '';
    const prog = showProg ? ` ${ctx.isRoot ? `${s.pid}/${s.program}` : '-'}` : '';
    return `${s.proto.padEnd(5)}        0      0 ${local.padEnd(23)} ${s.peer.padEnd(23)} ${state.padEnd(11)}${prog}`.trimEnd();
  });
  const warning = showProg && !ctx.isRoot
    ? '(Not all processes could be identified, non-owned process info\n will not be shown, you would have to be root to see it all.)'
    : '';
  return ctx.result([title, header, ...rows].join('\n'), warning, 0);
}

linuxCommands.registerAll({ ip, ifconfig, ping, ss, netstat });
