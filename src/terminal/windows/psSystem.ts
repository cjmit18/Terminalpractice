import { WindowsContext, WindowsResult, psCommands } from './context';
import { PsBound, PsParamSpec, bindCmdlet, psError } from './psUtil';
import { connections, hasConnectivity, resolveHost } from './cmd/network';
import { lineMatcher } from './psPipeline';

// PowerShell counterparts of CMD tools that labs accept as answers: Clear-DnsClientCache,
// Test-Connection, Repair-WindowsImage, Invoke-GPUpdate, Get-NetTCPConnection and Select-String.

type Row = Record<string, unknown>;

function bind(ctx: WindowsContext, cmdlet: string, spec: Record<string, PsParamSpec>, aliases: Record<string, string> = {}): PsBound | WindowsResult {
  const b = bindCmdlet(ctx.raw, cmdlet, ctx.tokens, spec, aliases);
  return typeof b === 'string' ? ctx.fail(b) : b;
}
const isResult = (b: PsBound | WindowsResult): b is WindowsResult => 'exitCode' in b;

const NOT_ELEVATED = (ctx: WindowsContext, what: string) =>
  `You are '${ctx.state.currentUser}', a standard user (not elevated). ${what} needs an elevated PowerShell (Run as administrator).`;

/** The CIM "Access denied" block the NetTCPIP/DnsClient cmdlets print for a standard user. */
const cimDenied = (ctx: WindowsContext, cmdlet: string, cls: string) =>
  psError(ctx.raw, cmdlet, 'Access denied', 'PermissionDenied', cls, 'CimException', `Windows System Error 5,${cmdlet}`)
    .replace(`(${cls}:String) [${cmdlet}]`, `(${cls}:ROOT/StandardCimv2/${cls}) [${cmdlet}]`)
    .replace(`,Microsoft.PowerShell.Commands.${cmdlet.replace('-', '')}Command`, '');

function clearDnsClientCache(ctx: WindowsContext): WindowsResult {
  const b = bind(ctx, 'Clear-DnsClientCache', { WhatIf: { kind: 'switch' }, Confirm: { kind: 'switch' }, CimSession: { kind: 'value' }, AsJob: { kind: 'switch' } });
  if (isResult(b)) return b;
  if (!ctx.isAdmin) return ctx.fail(cimDenied(ctx, 'Clear-DnsClientCache', 'MSFT_DNSClientCache'), 1, NOT_ELEVATED(ctx, 'Clearing the DNS client cache'));
  if (b.has('WhatIf')) return ctx.ok('What if: Performing the operation "Clear-DnsClientCache" on target "DNS client cache".');
  // Same effect as ipconfig /flushdns, with no output
  ctx.state.dnsWorking = true;
  ctx.state.dnsCacheFlushed = true;
  return ctx.ok();
}

function testConnection(ctx: WindowsContext): WindowsResult {
  const cmdlet = 'Test-Connection';
  const b = bind(ctx, cmdlet, {
    ComputerName: { kind: 'list', position: 0 }, Count: { kind: 'value' }, Quiet: { kind: 'switch' }, BufferSize: { kind: 'value' },
    Source: { kind: 'list' }, Delay: { kind: 'value' }, TimeToLive: { kind: 'value' }, AsJob: { kind: 'switch' },
  }, { CN: 'ComputerName', IPAddress: 'ComputerName', Size: 'BufferSize', Bytes: 'BufferSize', TTL: 'TimeToLive' });
  if (isResult(b)) return b;
  const hosts = b.list('ComputerName');
  if (!hosts?.length) return ctx.fail(psError(ctx.raw, cmdlet, 'Cannot process command because of one or more missing mandatory parameters: ComputerName.', 'InvalidArgument', '', 'ParameterBindingException', 'MissingMandatoryParameter'));
  // -Count is an Int32 with ValidateRange(1, Int32.MaxValue)
  const countArg = b.str('Count') ?? '4';
  if (!/^[-+]?\d+$/.test(countArg) || Math.abs(Number(countArg)) > 2147483647) {
    return ctx.fail(psError(ctx.raw, cmdlet, `Cannot bind parameter 'Count'. Cannot convert value "${countArg}" to type "System.Int32". Error: "Input string was not in a correct format."`, 'InvalidArgument', '', 'ParameterBindingException', 'CannotConvertArgumentNoMessage'));
  }
  const count = Number(countArg);
  if (count < 1) {
    return ctx.fail(psError(ctx.raw, cmdlet, `Cannot validate argument on parameter 'Count'. The ${count} argument is less than the minimum allowed range of 1. Supply an argument that is greater than or equal to 1 and then try the command again.`, 'InvalidData', '', 'ParameterBindingValidationException', 'ParameterArgumentValidationError'));
  }
  // Real pings take a second each; the simulator prints at most this many replies per host
  const MAX_REPLIES = 100;
  const shown = Math.min(count, MAX_REPLIES);
  const size = Number(b.str('BufferSize') ?? 32) || 32;
  const rows: string[] = [];
  const errors: string[] = [];
  const quiet: string[] = [];
  for (const host of hosts) {
    const ip = resolveHost(ctx, host);
    const self = !!ip && (ip.startsWith('127.') || ctx.state.interfaces.some(i => i.ip === ip));
    const ok = !!ip && (self || hasConnectivity(ctx));
    if (b.has('Quiet')) { quiet.push(ok ? 'True' : 'False'); continue; }
    if (!ok) {
      errors.push(psError(ctx.raw, cmdlet, `Testing connection to computer '${host}' failed: ${ip ? 'Error due to lack of resources' : 'No such host is known'}`,
        'ResourceUnavailable', host, 'PingException', 'TestConnectionException'));
      continue;
    }
    const time = self || ip!.startsWith('192.168.') ? 0 : 12;
    for (let i = 0; i < shown; i++) {
      rows.push(`${ctx.state.hostname.padEnd(13)} ${host.padEnd(15)} ${ip!.padEnd(16)} ${''.padEnd(40)} ${String(size).padEnd(8)} ${time}`);
    }
  }
  if (b.has('Quiet')) return ctx.ok(quiet.join('\n'));
  const head = ['', 'Source        Destination     IPV4Address      IPV6Address                              Bytes    Time(ms)', '------        -----------     -----------      -----------                              -----    --------'];
  return ctx.result(rows.length ? [...head, ...rows].join('\n') : '', errors.join('\n'), errors.length ? 1 : 0,
    count > MAX_REPLIES ? `The simulator shows the first ${MAX_REPLIES} replies per host; a real -Count ${count} keeps pinging once a second.` : undefined);
}

function repairWindowsImage(ctx: WindowsContext): WindowsResult {
  const cmdlet = 'Repair-WindowsImage';
  const b = bind(ctx, cmdlet, {
    Online: { kind: 'switch' }, Path: { kind: 'value' }, CheckHealth: { kind: 'switch' }, ScanHealth: { kind: 'switch' }, RestoreHealth: { kind: 'switch' },
    Source: { kind: 'list' }, LimitAccess: { kind: 'switch' }, NoRestart: { kind: 'switch' }, LogPath: { kind: 'value' },
  });
  if (isResult(b)) return b;
  if (!b.has('Online') && !b.has('Path')) {
    return ctx.fail(psError(ctx.raw, cmdlet, 'Parameter set cannot be resolved using the specified named parameters.', 'InvalidArgument', '', 'ParameterBindingException', 'AmbiguousParameterSet'));
  }
  if (!ctx.isAdmin) {
    return ctx.fail(psError(ctx.raw, cmdlet, 'The requested operation requires elevation.', 'NotSpecified', '', 'COMException', 'Microsoft.Dism.Commands.RepairWindowsImageCommand')
      .replace(',Microsoft.PowerShell.Commands.RepairWindowsImageCommand', ''), 1, NOT_ELEVATED(ctx, 'Repair-WindowsImage (DISM)'));
  }
  const storeDamaged = ctx.state.systemIntegrityCorrupted && !ctx.state.dismRepaired;
  let health = storeDamaged ? 'Repairable' : 'Healthy';
  // -RestoreHealth is DISM /RestoreHealth: it repairs the component store
  if (b.has('RestoreHealth')) {
    ctx.state.dismRepaired = true;
    health = 'Healthy';
  } else if (!b.has('CheckHealth') && !b.has('ScanHealth')) {
    return ctx.fail(psError(ctx.raw, cmdlet, 'Parameter set cannot be resolved using the specified named parameters.', 'InvalidArgument', '', 'ParameterBindingException', 'AmbiguousParameterSet'));
  }
  return ctx.ok(['', `Path             : ${b.str('Path') ?? ''}`.trimEnd(), `Online           : ${b.has('Online') ? 'True' : 'False'}`, `ImageHealthState : ${health}`, 'RestartNeeded    : False', ''].join('\n'));
}

function invokeGPUpdate(ctx: WindowsContext): WindowsResult {
  const b = bind(ctx, 'Invoke-GPUpdate', {
    Computer: { kind: 'value', position: 0 }, Force: { kind: 'switch' }, Target: { kind: 'value' }, RandomDelayInMinutes: { kind: 'value' },
    Boot: { kind: 'switch' }, LogOff: { kind: 'switch' }, Sync: { kind: 'switch' }, AsJob: { kind: 'switch' },
  });
  if (isResult(b)) return b;
  const target = b.str('Target');
  if (target && !['computer', 'user'].includes(target.toLowerCase())) {
    return ctx.fail(psError(ctx.raw, 'Invoke-GPUpdate', `Cannot validate argument on parameter 'Target'. The argument "${target}" does not belong to the set "Computer,User" specified by the ValidateSet attribute.`, 'InvalidData', '', 'ParameterBindingValidationException', 'ParameterArgumentValidationError'));
  }
  // Like gpupdate, it runs silently when it succeeds
  return ctx.ok();
}

/** Get-NetTCPConnection as objects. */
export function tcpConnectionRows(ctx: WindowsContext): Row[] | WindowsResult {
  const cmdlet = 'Get-NetTCPConnection';
  const b = bind(ctx, cmdlet, {
    LocalAddress: { kind: 'list', position: 0 }, LocalPort: { kind: 'list', position: 1 }, RemoteAddress: { kind: 'list' }, RemotePort: { kind: 'list' },
    State: { kind: 'list' }, OwningProcess: { kind: 'list' }, AppliedSetting: { kind: 'list' },
  });
  if (isResult(b)) return b;
  const filters: [string, string[] | undefined][] = [
    ['LocalAddress', b.list('LocalAddress')], ['LocalPort', b.list('LocalPort')], ['RemoteAddress', b.list('RemoteAddress')],
    ['RemotePort', b.list('RemotePort')], ['State', b.list('State')], ['OwningProcess', b.list('OwningProcess')],
  ];
  const rows: Row[] = connections(ctx).map(c => ({
    LocalAddress: c.local, LocalPort: c.localPort, RemoteAddress: c.remote, RemotePort: c.remotePort,
    State: c.state === 'LISTENING' ? 'Listen' : 'Established', AppliedSetting: c.state === 'LISTENING' ? '' : c.remote.startsWith('192.168.') ? 'Datacenter' : 'Internet', OwningProcess: c.pid,
  }));
  const hits = rows.filter(r => filters.every(([k, want]) => !want || want.some(w => String(r[k]).toLowerCase() === w.toLowerCase())));
  if (!hits.length) {
    const used = filters.find(([, w]) => w)?.[0];
    return ctx.fail(psError(ctx.raw, cmdlet, `No MSFT_NetTCPConnection objects found with property '${used ?? 'LocalPort'}' equal to '${filters.find(([, w]) => w)?.[1]?.join(',') ?? ''}'.  Verify the value of the property and retry.`,
      'ObjectNotFound', String(filters.find(([, w]) => w)?.[1]?.[0] ?? ''), 'CimJobException', `CmdletizationQuery_NotFound_${used ?? 'LocalPort'},Get-NetTCPConnection`)
      .replace(',Microsoft.PowerShell.Commands.GetNetTCPConnectionCommand', ''));
  }
  return hits;
}

export function tcpTable(rows: Row[]): string {
  const head = [
    '',
    'LocalAddress                        LocalPort RemoteAddress                       RemotePort State       AppliedSetting OwningProcess',
    '------------                        --------- -------------                       ---------- -----       -------------- -------------',
  ];
  return [...head, ...rows.map(r => `${String(r.LocalAddress).padEnd(35)} ${String(r.LocalPort).padEnd(9)} ${String(r.RemoteAddress).padEnd(35)} ${String(r.RemotePort).padEnd(10)} ${String(r.State).padEnd(11)} ${String(r.AppliedSetting).padEnd(14)} ${r.OwningProcess}`)].join('\n');
}

function getNetTCPConnection(ctx: WindowsContext): WindowsResult {
  const rows = tcpConnectionRows(ctx);
  return Array.isArray(rows) ? ctx.ok(tcpTable(rows)) : rows;
}

/** Select-String -Path file -Pattern text: matching lines as file:line:text. */
function selectString(ctx: WindowsContext): WindowsResult {
  const cmdlet = 'Select-String';
  const b = bind(ctx, cmdlet, {
    Pattern: { kind: 'list', position: 0 }, Path: { kind: 'list', position: 1 }, SimpleMatch: { kind: 'switch' }, CaseSensitive: { kind: 'switch' },
    NotMatch: { kind: 'switch' }, Quiet: { kind: 'switch' }, List: { kind: 'switch' }, AllMatches: { kind: 'switch' }, Context: { kind: 'value' }, InputObject: { kind: 'value' },
  }, { LiteralPath: 'Path' });
  if (isResult(b)) return b;
  const patterns = b.list('Pattern');
  if (!patterns) return ctx.fail(psError(ctx.raw, cmdlet, 'Cannot process command because of one or more missing mandatory parameters: Pattern.', 'InvalidArgument', '', 'ParameterBindingException', 'MissingMandatoryParameter'));
  const paths = b.list('Path');
  if (!paths) return ctx.ok('');
  const test = lineMatcher(patterns, b.has('SimpleMatch'), b.has('CaseSensitive'));
  const out: string[] = [];
  const errors: string[] = [];
  for (const p of paths) {
    const abs = ctx.resolve(p);
    const node = ctx.node(abs);
    if (!node || node.type !== 'file') {
      errors.push(psError(ctx.raw, cmdlet, `Cannot find path '${abs}' because it does not exist.`, 'ObjectNotFound', abs, 'ItemNotFoundException', 'PathNotFound'));
      continue;
    }
    const why = ctx.protectedReason(abs, 'read');
    if (why) { errors.push(psError(ctx.raw, cmdlet, `Access to the path '${abs}' is denied.`, 'PermissionDenied', abs, 'UnauthorizedAccessException', 'ProcessingFile')); continue; }
    const shown = abs.toLowerCase().startsWith(`${ctx.cwd.toLowerCase()}\\`) ? abs.slice(ctx.cwd.length + 1) : abs;
    (node.content ?? '').replace(/\r/g, '').split('\n').forEach((line, i) => {
      if (test(line) !== b.has('NotMatch')) out.push(`${shown}:${i + 1}:${line}`);
    });
  }
  if (b.has('Quiet')) return ctx.ok(out.length ? 'True' : 'False');
  return ctx.result(out.length ? `\n${out.join('\n')}\n` : '', errors.join('\n'), errors.length ? 1 : 0);
}

psCommands.registerAll({
  'Clear-DnsClientCache': clearDnsClientCache,
  'Test-Connection': testConnection,
  'Repair-WindowsImage': repairWindowsImage,
  'Invoke-GPUpdate': invokeGPUpdate,
  'Get-NetTCPConnection': getNetTCPConnection,
  'Select-String': selectString,
});
// Pipeline-only cmdlets with nothing piped in output nothing, as in PowerShell
psCommands.register(['Sort-Object', 'Where-Object', 'Select-Object', 'Measure-Object', 'Format-Table', 'Format-List', 'Out-Null'], ctx => ctx.ok(''));
