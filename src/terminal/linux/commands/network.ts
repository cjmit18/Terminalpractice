import { LinuxContext, LinuxResult, linuxCommands } from '../context';

// Networking: ip, ifconfig, ping

function ip(ctx: LinuxContext): LinuxResult {
  const sub = ctx.args[0];
  if (sub === 'addr' || sub === 'a') {
    return ctx.ok(ctx.state.interfaces.map((iface, idx) =>
      `${idx + 1}: ${iface.name}: <BROADCAST,MULTICAST,${iface.status}> mtu 1500 qdisc fq_codel state UP\n    link/ether ${iface.mac} brd ff:ff:ff:ff:ff:ff\n    inet ${iface.ip}/${iface.netmask === '255.255.255.0' ? '24' : '16'} brd 192.168.1.255 scope global ${iface.name}`
    ).join('\n'));
  }
  if (sub === 'route' || sub === 'r') {
    return ctx.ok('default via 192.168.1.1 dev eth0 proto dhcp src 192.168.1.105 metric 100\n192.168.1.0/24 dev eth0 proto kernel scope link src 192.168.1.105');
  }
  return ctx.ok('Usage: ip [ OPTIONS ] OBJECT { COMMAND | help }');
}

function ifconfig(ctx: LinuxContext): LinuxResult {
  return ctx.ok(ctx.state.interfaces.map(iface =>
    `${iface.name}: flags=4163<UP,BROADCAST,RUNNING,MULTICAST>  mtu 1500\n        inet ${iface.ip}  netmask ${iface.netmask}  broadcast 192.168.1.255\n        ether ${iface.mac}  txqueuelen 1000  (Ethernet)\n        RX packets 15822  bytes 12948102 (12.9 MB)\n        TX packets 11200  bytes 1840291 (1.8 MB)`
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

linuxCommands.registerAll({ ip, ifconfig, ping });
