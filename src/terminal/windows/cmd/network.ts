import { WindowsContext, WindowsResult, cmdCommands } from '../context';

// CMD networking tools: ipconfig, ping, tracert, nslookup, netstat, route

function ipconfig(ctx: WindowsContext): WindowsResult {
  const { args, state } = ctx;
  if (args.includes('/flushdns')) {
    state.dnsWorking = true;
    return ctx.ok(['Windows IP Configuration', '', 'Successfully flushed the DNS Resolver Cache.'].join('\n'));
  }

  if (args.includes('/release')) {
    state.interfaces = state.interfaces.map(i => ({ ...i, ip: '0.0.0.0', gateway: '' }));
    return ctx.ok([
      'Windows IP Configuration',
      '',
      'Ethernet adapter Ethernet0:',
      '   Connection-specific DNS Suffix  . : corp.local',
      '   IPv4 Address. . . . . . . . . . . : 0.0.0.0',
      '   Subnet Mask . . . . . . . . . . . : 0.0.0.0',
      '   Default Gateway . . . . . . . . . : ',
    ].join('\n'));
  }

  if (args.includes('/renew')) {
    state.interfaces = state.interfaces.map(i => ({ ...i, ip: '192.168.1.145', netmask: '255.255.255.0', gateway: '192.168.1.1' }));
    state.gatewayWorking = true;
    return ctx.ok([
      'Windows IP Configuration',
      '',
      'Ethernet adapter Ethernet0:',
      '   Connection-specific DNS Suffix  . : corp.local',
      '   Link-local IPv6 Address . . . . . : fe80::49b1:72c8:12e0:98f1%12',
      '   IPv4 Address. . . . . . . . . . . : 192.168.1.145',
      '   Subnet Mask . . . . . . . . . . . : 255.255.255.0',
      '   Default Gateway . . . . . . . . . : 192.168.1.1',
    ].join('\n'));
  }

  const iface = state.interfaces[0] || {
    ip: '192.168.1.145',
    netmask: '255.255.255.0',
    mac: '00-50-56-A1-2B-3C',
    gateway: '192.168.1.1',
    dns: ['192.168.1.10', '8.8.8.8'],
  };
  const lines = ['Windows IP Configuration', ''];
  if (args.includes('/all')) {
    lines.push(
      '   Host Name . . . . . . . . . . . . : WIN-CLIENT01',
      '   Primary Dns Suffix  . . . . . . . : corp.local',
      '   Node Type . . . . . . . . . . . . : Hybrid',
      '   IP Routing Enabled. . . . . . . . : No',
      '   WINS Proxy Enabled. . . . . . . . : No',
      '   DNS Suffix Search List. . . . . . : corp.local',
      '',
      'Ethernet adapter Ethernet0:',
      '   Connection-specific DNS Suffix  . : corp.local',
      '   Description . . . . . . . . . . . : Intel(R) 82574L Gigabit Network Connection',
      `   Physical Address. . . . . . . . . : ${iface.mac}`,
      '   DHCP Enabled. . . . . . . . . . . : Yes',
      '   Autoconfiguration Enabled . . . . : Yes',
      `   IPv4 Address. . . . . . . . . . . : ${iface.ip}(Preferred)`,
      `   Subnet Mask . . . . . . . . . . . : ${iface.netmask}`,
      `   Default Gateway . . . . . . . . . : ${iface.gateway}`,
      '   DHCP Server . . . . . . . . . . . : 192.168.1.10',
      `   DNS Servers . . . . . . . . . . . : ${iface.dns.join('\n                                       ')}`,
      '   NetBIOS over Tcpip. . . . . . . . : Enabled'
    );
  } else {
    lines.push(
      'Ethernet adapter Ethernet0:',
      '   Connection-specific DNS Suffix  . : corp.local',
      '   Link-local IPv6 Address . . . . . : fe80::49b1:72c8:12e0:98f1%12',
      `   IPv4 Address. . . . . . . . . . . : ${iface.ip}`,
      `   Subnet Mask . . . . . . . . . . . : ${iface.netmask}`,
      `   Default Gateway . . . . . . . . . : ${iface.gateway}`
    );
  }
  return ctx.ok(lines.join('\n'));
}

function ping(ctx: WindowsContext): WindowsResult {
  const target = ctx.args.find(a => !a.startsWith('/') && !a.startsWith('-')) || '127.0.0.1';
  return ctx.ok([
    `Pinging ${target} with 32 bytes of data:`,
    `Reply from ${target}: bytes=32 time=12ms TTL=118`,
    `Reply from ${target}: bytes=32 time=11ms TTL=118`,
    `Reply from ${target}: bytes=32 time=14ms TTL=118`,
    `Reply from ${target}: bytes=32 time=12ms TTL=118`,
    '',
    `Ping statistics for ${target}:`,
    '    Packets: Sent = 4, Received = 4, Lost = 0 (0% loss),',
    'Approximate round trip times in milli-seconds:',
    '    Minimum = 11ms, Maximum = 14ms, Average = 12ms',
  ].join('\n'));
}

function tracert(ctx: WindowsContext): WindowsResult {
  const target = ctx.args.find(a => !a.startsWith('/')) || '8.8.8.8';
  return ctx.ok([
    `Tracing route to ${target} over a maximum of 30 hops`,
    '',
    '  1    <1 ms    <1 ms    <1 ms  192.168.1.1 [gw.corp.local]',
    '  2     4 ms     3 ms     3 ms  10.200.0.1',
    '  3     9 ms     8 ms     8 ms  core-edge-01.isp.net [72.14.200.1]',
    `  4    12 ms    12 ms    11 ms  ${target}`,
    '',
    'Trace complete.',
  ].join('\n'));
}

function nslookup(ctx: WindowsContext): WindowsResult {
  const domain = ctx.args[0] || 'corpdc.corp.local';
  return ctx.ok(['Server:  dc01.corp.local', 'Address:  192.168.1.10', '', `Name:    ${domain}`, 'Address:  192.168.1.10'].join('\n'));
}

function netstat(ctx: WindowsContext): WindowsResult {
  const header = '  Proto  Local Address          Foreign Address        State           PID';
  const rows = [
    '  TCP    0.0.0.0:135            0.0.0.0:0              LISTENING       844',
    '  TCP    0.0.0.0:445            0.0.0.0:0              LISTENING       4',
    '  TCP    192.168.1.145:49668    192.168.1.10:389       ESTABLISHED     1120',
  ];
  // A rogue process in the scenario shows up as an outbound connection
  for (const p of ctx.state.processes) {
    if (p.isMalicious && p.port) rows.push(`  TCP    192.168.1.145:49811    203.0.113.88:${p.port}       ESTABLISHED     ${p.pid}`);
  }
  return ctx.ok(`Active Connections\n\n${header}\n${rows.join('\n')}`);
}

function route(ctx: WindowsContext): WindowsResult {
  if (ctx.args[0]?.toLowerCase() === 'print') {
    return ctx.ok([
      '===========================================================================',
      'Interface List',
      '  3...00 50 56 a1 2b 3c ......Intel(R) 82574L Gigabit Network Connection',
      '  1...........................Software Loopback Interface 1',
      '===========================================================================',
      '',
      'IPv4 Route Table',
      '===========================================================================',
      'Active Routes:',
      'Network Destination        Netmask          Gateway       Interface  Metric',
      '          0.0.0.0          0.0.0.0      192.168.1.1    192.168.1.145      25',
      '        127.0.0.0        255.0.0.0         On-link         127.0.0.1     331',
      '      192.168.1.0    255.255.255.0         On-link     192.168.1.145     281',
      '    192.168.1.145  255.255.255.255         On-link     192.168.1.145     281',
      '===========================================================================',
      'Persistent Routes:',
      '  None',
    ].join('\r\n'));
  }
  return ctx.ok('Manipulates network routing tables.\nROUTE [-f] [-p] [-4|-6] command [destination] [MASK netmask] [gateway] [METRIC metric] [IF interface]');
}

cmdCommands.registerAll({ ipconfig, ping, tracert, nslookup, netstat, route });
