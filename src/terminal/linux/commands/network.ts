import { MAX_REPLIES, repliesNote } from '../../limits';
import { LinuxContext, LinuxResult, linuxCommands } from '../context';
import { parseOptions, optionValue } from '../../textUtils';

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

const ADDR_OBJECTS = ['a', 'ad', 'add', 'addr', 'addre', 'addres', 'address'];
const LINK_OBJECTS = ['l', 'li', 'lin', 'link'];
const ROUTE_OBJECTS = ['r', 'ro', 'rou', 'rout', 'route'];

function ip(ctx: LinuxContext): LinuxResult {
  const args = [...ctx.args];
  const flags = new Set<string>();
  while (args[0]?.startsWith('-')) flags.add(args.shift()!.replace(/^-+/, ''));
  const [object, ...rest] = args;
  const brief = flags.has('br') || flags.has('brief');
  if (!object) return ctx.fail('Usage: ip [ OPTIONS ] OBJECT { COMMAND | help }\nwhere  OBJECT := { address | link | route | neigh | rule | netns ... }', 255);

  if (ROUTE_OBJECTS.includes(object)) {
    return ctx.ok('default via 192.168.1.1 dev eth0 proto dhcp src 192.168.1.105 metric 100\n192.168.1.0/24 dev eth0 proto kernel scope link src 192.168.1.105');
  }
  const isAddr = ADDR_OBJECTS.includes(object);
  if (!isAddr && !LINK_OBJECTS.includes(object)) return ctx.fail(`Object "${object}" is unknown, try "ip help".`, 1);

  // [show|list] [dev] NAME
  const words = rest.filter(w => !['show', 'list', 'ls', 'lst', 'sh', 'dev'].includes(w));
  const dev = words[0];
  // The kernel registers lo first, so it is always index 1
  const ordered = [...ctx.state.interfaces.filter(i => i.name === 'lo'), ...ctx.state.interfaces.filter(i => i.name !== 'lo')];
  const all = ordered.map((iface, idx) => ({ iface, idx }));
  const chosen = dev ? all.filter(x => x.iface.name === dev) : all;
  if (dev && !chosen.length) return ctx.fail(`Device "${dev}" does not exist.`, 1);

  return ctx.ok(chosen.map(({ iface, idx }) => {
    const lo = iface.name === 'lo';
    const prefix = `${iface.ip}/${prefixLength(iface.netmask)}`;
    if (brief) {
      const state = lo ? 'UNKNOWN' : iface.status;
      return isAddr ? `${iface.name.padEnd(16)} ${state.padEnd(14)} ${prefix}` : `${iface.name.padEnd(16)} ${state.padEnd(14)} ${lo ? '00:00:00:00:00:00' : iface.mac}`;
    }
    const tail = isAddr ? 'group default qlen 1000' : 'mode DEFAULT group default qlen 1000';
    const head = lo
      ? `${idx + 1}: lo: <LOOPBACK,UP,LOWER_UP> mtu 65536 qdisc noqueue state UNKNOWN ${tail}`
      : `${idx + 1}: ${iface.name}: <BROADCAST,MULTICAST,${iface.status === 'UP' ? 'UP,LOWER_UP' : 'DOWN'}> mtu 1500 qdisc fq_codel state ${iface.status} ${tail}`;
    const link = lo ? '    link/loopback 00:00:00:00:00:00 brd 00:00:00:00:00:00' : `    link/ether ${iface.mac} brd ff:ff:ff:ff:ff:ff`;
    if (!isAddr) return `${head}\n${link}`;
    const inet = lo
      ? `    inet ${prefix} scope host lo\n       valid_lft forever preferred_lft forever`
      : iface.dhcpEnabled
        ? `    inet ${prefix} brd ${broadcast(iface.ip, iface.netmask)} scope global dynamic ${iface.name}\n       valid_lft 86137sec preferred_lft 86137sec`
        : `    inet ${prefix} brd ${broadcast(iface.ip, iface.netmask)} scope global ${iface.name}\n       valid_lft forever preferred_lft forever`;
    return `${head}\n${link}\n${inet}`;
  }).join('\n'));
}

function ifconfig(ctx: LinuxContext): LinuxResult {
  return ctx.ok(ctx.state.interfaces.map(iface =>
    `${iface.name}: flags=4163<UP,BROADCAST,RUNNING,MULTICAST>  mtu 1500\n        inet ${iface.ip}  netmask ${iface.netmask}  broadcast ${broadcast(iface.ip, iface.netmask)}\n        ether ${iface.mac}  txqueuelen 1000  (Ethernet)\n        RX packets 15822  bytes 12948102 (12.9 MB)\n        TX packets 11200  bytes 1840291 (1.8 MB)`
  ).join('\n\n'));
}

function ping(ctx: LinuxContext): LinuxResult {
  const opts = parseOptions(ctx.args, 'ciIlmMNpQsStTwW', { count: 'c', interval: 'i', size: 's' });
  const host = opts.operands[0];
  if (!host) return ctx.fail('ping: usage error: Destination address required', 1);
  const countArg = optionValue(opts, 'c');
  const count = countArg === undefined ? 4 : Number(countArg);
  if (!Number.isInteger(count) || count < 1) return ctx.fail(`ping: invalid argument: '${countArg}': out of range: 1 <= value <= 9223372036854775807`, 1);
  const sizeArg = optionValue(opts, 's');
  const size = sizeArg === undefined ? 56 : Number(sizeArg);
  const ip = host === 'localhost' ? '127.0.0.1' : /^\d+(\.\d+){3}$/.test(host) ? host : '192.168.1.1';
  // A huge -c would build millions of lines; show the first MAX_REPLIES and say so (statistics still cover all)
  const shown = Math.min(count, MAX_REPLIES);
  const times = Array.from({ length: shown }, (_, i) => [14.2, 13.8, 14.0, 14.1][i % 4]);
  const min = Math.min(...times);
  const max = Math.max(...times);
  const avg = times.reduce((a, b) => a + b, 0) / shown;
  const mdev = Math.sqrt(times.reduce((a, t) => a + (t - avg) ** 2, 0) / shown);
  return ctx.ok([
    `PING ${host} (${ip}) ${size}(${size + 28}) bytes of data.`,
    ...times.map((t, i) => `${size + 8} bytes from ${ip === host ? host : `${host} (${ip})`}: icmp_seq=${i + 1} ttl=117 time=${t.toFixed(1)} ms`),
    ...(count > shown ? [`(${repliesNote(count, 'ping -c')})`] : []),
    '',
    `--- ${host} ping statistics ---`,
    `${count} packets transmitted, ${count} received, 0% packet loss, time ${(count - 1) * 1001}ms`,
    `rtt min/avg/max/mdev = ${min.toFixed(3)}/${avg.toFixed(3)}/${max.toFixed(3)}/${mdev.toFixed(3)} ms`,
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
