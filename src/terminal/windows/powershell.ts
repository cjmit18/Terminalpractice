import { NetworkInterface, ProcessItem, WindowsService } from '../../types/terminal';
import { globToRegex } from '../textUtils';
import { WindowsContext, WindowsResult, psCommands } from './context';
import { bindCmdlet, PsBound, PsParamSpec, psError } from './psUtil';
import { resolveHost, hasConnectivity } from './cmd/network';
import { allProcesses, CRITICAL_PROCESSES, endProcess } from './cmd/system';
import './psAD';

// PowerShell service, process and network cmdlets. Pipelines are run by psPipeline.ts.

export type Row = Record<string, unknown>;

export const SERVICE_HEADER = 'Status   Name               DisplayName\n------   ----               -----------';
export const PROCESS_HEADER = 'Handles  NPM(K)    PM(K)      WS(K)     CPU(s)     Id  SI ProcessName\n-------  ------    -----      -----     ------     --  -- -----------';

/** Service objects as the pipeline sees them (the ServiceController properties). */
export const serviceObject = (s: WindowsService): Row => ({ Status: s.status, Name: s.name, DisplayName: s.displayName, StartType: s.startType, ServiceName: s.name });
export const serviceTable = (items: Row[]) =>
  `${SERVICE_HEADER}\n${items.map(s => `${String(s.Status).padEnd(8, ' ')} ${String(s.Name).padEnd(18, ' ')} ${s.DisplayName}`).join('\n')}`;

/** Process objects as the pipeline sees them. Handles and paged pool are made up but stable per process. */
export const processObject = (p: ProcessItem): Row => {
  const name = p.command.replace(/\.exe$/i, '');
  return {
    Handles: 150 + ((p.pid * 37) % 850), NPM: Math.max(4, Math.round(p.mem * 0.8)) * 1024, ProcessName: name, Id: p.pid, CPU: p.cpu,
    WS: Math.round(p.mem * 2 * 1048576), PM: Math.round(p.mem * 1048576), SI: p.user === 'SYSTEM' ? 0 : 1, Name: name, UserName: p.user,
  };
};
/** The Windows PowerShell 5.1 default view of processes (the K columns are kilobytes). */
export const processTable = (items: Row[]) => `${PROCESS_HEADER}\n${items.map(p => {
  const kb = (v: unknown) => String(Math.round(Number(v) / 1024));
  return `${String(p.Handles).padStart(7)}${kb(p.NPM).padStart(8)}${kb(p.PM).padStart(9)}${kb(p.WS).padStart(11)}${Number(p.CPU).toFixed(2).padStart(11)}${String(p.Id).padStart(7)}${String(p.SI).padStart(4)} ${p.ProcessName}`;
}).join('\n')}`;

function bind(ctx: WindowsContext, cmdlet: string, spec: Record<string, PsParamSpec>, aliases: Record<string, string> = {}): PsBound | WindowsResult {
  const b = bindCmdlet(ctx.raw, cmdlet, ctx.tokens, spec, aliases);
  return typeof b === 'string' ? ctx.fail(b) : b;
}
const isResult = (b: PsBound | WindowsResult): b is WindowsResult => 'exitCode' in b;

// ---------------------------------------------------------------- services

// Parameters shared by the service cmdlets; each cmdlet adds its own (Get-Service.md, Start-Service.md ... for 5.1)
const SERVICE_PARAMS: Record<string, PsParamSpec> = {
  Name: { kind: 'list', position: 0 }, DisplayName: { kind: 'list' }, Include: { kind: 'list' }, Exclude: { kind: 'list' },
};
const SERVICE_ALIASES: Record<string, string> = { ServiceName: 'Name', Cn: 'ComputerName', DS: 'DependentServices', SDO: 'RequiredServices', ServicesDependedOn: 'RequiredServices' };
const sw = (...names: string[]) => Object.fromEntries(names.map(n => [n, { kind: 'switch' } as PsParamSpec]));
const GET_SERVICE: Record<string, PsParamSpec> = { ComputerName: { kind: 'list' }, ...sw('DependentServices', 'RequiredServices') };
const CHANGE_SERVICE: Record<string, Record<string, PsParamSpec>> = {
  'Start-Service': sw('PassThru', 'WhatIf', 'Confirm'),
  'Stop-Service': sw('Force', 'NoWait', 'PassThru', 'WhatIf', 'Confirm'),
  'Restart-Service': sw('Force', 'PassThru', 'WhatIf', 'Confirm'),
  'Suspend-Service': sw('PassThru', 'WhatIf', 'Confirm'),
  'Resume-Service': sw('PassThru', 'WhatIf', 'Confirm'),
  'Set-Service': { ComputerName: { kind: 'list' }, ...sw('PassThru', 'WhatIf', 'Confirm') },
};

/** Services matching -Name / positional names (comma lists and wildcards), or an error result. */
export function matchServices(ctx: WindowsContext, cmdlet: string, extra: Record<string, PsParamSpec> = {}): { items: WindowsService[]; error?: string; b: PsBound } | WindowsResult {
  const spec = { ...SERVICE_PARAMS, ...(CHANGE_SERVICE[cmdlet] ?? GET_SERVICE), ...extra };
  const b = bind(ctx, cmdlet, spec, Object.fromEntries(Object.entries(SERVICE_ALIASES).filter(([, to]) => spec[to])));
  if (isResult(b)) return b;
  const wanted = b.list('Name') ?? [];
  const display = b.list('DisplayName') ?? [];
  if (wanted.length === 0 && !display.length) return { items: ctx.state.services, b };
  const items: WindowsService[] = [];
  const errors: string[] = [];
  for (const w of wanted) {
    const re = globToRegex(w, true);
    const found = ctx.state.services.filter(s => re.test(s.name) || re.test(s.displayName) && !/[*?]/.test(w));
    if (found.length === 0 && !/[*?]/.test(w)) {
      errors.push(psError(ctx.raw, cmdlet, `Cannot find any service with service name '${w}'.`, 'ObjectNotFound', w, 'ServiceCommandException', 'NoServiceFoundForGivenName'));
    }
    items.push(...found.filter(f => !items.includes(f)));
  }
  for (const d of display) items.push(...ctx.state.services.filter(s => globToRegex(d, true).test(s.displayName) && !items.includes(s)));
  return { items, error: errors.join('\n') || undefined, b };
}

function getService(ctx: WindowsContext): WindowsResult {
  const m = matchServices(ctx, 'Get-Service');
  if ('exitCode' in m) return m;
  const items = [...m.items].sort((a, b) => a.name.localeCompare(b.name, 'en', { sensitivity: 'base' }));
  const out = items.length ? serviceTable(items.map(serviceObject)) : '';
  return ctx.result(out, m.error ?? '', m.error ? 1 : 0);
}

const notElevatedService = (ctx: WindowsContext) =>
  `You are '${ctx.state.currentUser}' in a prompt that is not elevated. Changing services needs an elevated PowerShell (Run as administrator).`;

function setServiceStatus(status: 'Running' | 'Stopped', cmdlet: 'Start-Service' | 'Stop-Service' | 'Restart-Service') {
  return (ctx: WindowsContext): WindowsResult => {
    const m = matchServices(ctx, cmdlet);
    if ('exitCode' in m) return m;
    if (m.error) return ctx.fail(m.error);
    if (!m.b.has('Name') && !m.b.has('DisplayName')) {
      return ctx.fail(psError(ctx.raw, cmdlet, 'Cannot process command because of one or more missing mandatory parameters: Name.', 'InvalidArgument', '', 'ParameterBindingException', 'MissingMandatoryParameter'));
    }
    const verb = cmdlet === 'Stop-Service' ? 'stop' : cmdlet === 'Restart-Service' ? 'restart' : 'start';
    if (m.b.has('WhatIf')) {
      return ctx.ok(m.items.map(s => `What if: Performing the operation "${cmdlet}" on target "${s.displayName} (${s.name})".`).join('\n'));
    }
    if (!ctx.isAdmin) {
      const s = m.items[0];
      return ctx.fail(psError(ctx.raw, cmdlet, `Service '${s?.displayName} (${s?.name})' cannot be ${verb === 'stop' ? 'stopped' : 'started'} due to the following error: Cannot open ${s?.name} service on computer '.'.`,
        'OpenError', s?.name ?? '', 'ServiceCommandException', `CouldNot${verb === 'stop' ? 'Stop' : 'Start'}Service`), 1, notElevatedService(ctx));
    }
    for (const s of m.items) {
      if (status === 'Running' && s.startType === 'Disabled') {
        return ctx.fail(psError(ctx.raw, cmdlet, `Service '${s.displayName} (${s.name})' cannot be started due to the following error: Cannot start service ${s.name} on computer '.'.`,
          'OpenError', s.name, 'ServiceCommandException', 'CouldNotStartService'));
      }
      s.status = status;
    }
    return ctx.ok(m.b.has('PassThru') ? serviceTable(m.items.map(serviceObject)) : '');
  };
}

const START_MODES = ['Boot', 'System', 'Automatic', 'Manual', 'Disabled'];

function setService(ctx: WindowsContext): WindowsResult {
  const cmdlet = 'Set-Service';
  const m = matchServices(ctx, cmdlet, { StartupType: { kind: 'value' }, Status: { kind: 'value' }, Description: { kind: 'value' }, InputObject: { kind: 'value' } }, );
  if ('exitCode' in m) return m;
  if (m.error) return ctx.fail(m.error.replace(/Cannot find any service with service name '([^']+)'\./, "Service $1 was not found on computer '.'."));
  const { b } = m;
  const type = b.str('StartupType');
  const mode = type === undefined ? undefined : START_MODES.find(x => x.toLowerCase() === type.toLowerCase());
  if (type !== undefined && !mode) {
    return ctx.fail(psError(ctx.raw, cmdlet, `Cannot bind parameter 'StartupType'. Cannot convert value "${type}" to type "System.ServiceProcess.ServiceStartMode". Error: "Unable to match the identifier name ${type} to a valid enumerator name. Specify one of the following enumerator names and try again:\n${START_MODES.join(', ')}"`,
      'InvalidArgument', '', 'ParameterBindingException', 'CannotConvertArgumentNoMessage'));
  }
  const statusArg = b.str('Status');
  const status = statusArg === undefined ? undefined : ['Running', 'Stopped', 'Paused'].find(x => x.toLowerCase() === statusArg.toLowerCase());
  if (statusArg !== undefined && !status) {
    return ctx.fail(psError(ctx.raw, cmdlet, `Cannot bind parameter 'Status'. Cannot convert value "${statusArg}" to type "System.ServiceProcess.ServiceControllerStatus".`, 'InvalidArgument', '', 'ParameterBindingException', 'CannotConvertArgumentNoMessage'));
  }
  if (b.has('WhatIf')) {
    return ctx.ok(m.items.map(s => `What if: Performing the operation "Set-Service" on target "${s.displayName} (${s.name})".`).join('\n'));
  }
  if (!ctx.isAdmin) {
    const s = m.items[0];
    return ctx.fail(psError(ctx.raw, cmdlet, `Service '${s?.displayName} (${s?.name})' cannot be configured due to the following error: Access is denied`, 'PermissionDenied', s?.name ?? '', 'ServiceCommandException', 'CouldNotSetService'), 1, notElevatedService(ctx));
  }
  for (const s of m.items) {
    if (mode === 'Automatic' || mode === 'Manual' || mode === 'Disabled') s.startType = mode;
    if (status === 'Running') {
      if (s.startType === 'Disabled') {
        return ctx.fail(psError(ctx.raw, cmdlet, `Service '${s.displayName} (${s.name})' cannot be started due to the following error: Cannot start service ${s.name} on computer '.'.`, 'OpenError', s.name, 'ServiceCommandException', 'CouldNotStartService'));
      }
      s.status = 'Running';
    } else if (status === 'Stopped') {
      s.status = 'Stopped';
    }
  }
  return ctx.ok(b.has('PassThru') ? serviceTable(m.items.map(serviceObject)) : '');
}

function suspendResume(cmdlet: 'Suspend-Service' | 'Resume-Service') {
  return (ctx: WindowsContext): WindowsResult => {
    const m = matchServices(ctx, cmdlet);
    if ('exitCode' in m) return m;
    if (m.error) return ctx.fail(m.error);
    const s = m.items[0];
    if (!s) return ctx.ok();
    return ctx.fail(psError(ctx.raw, cmdlet, `Service '${s.displayName} (${s.name})' cannot be ${cmdlet === 'Suspend-Service' ? 'suspended' : 'resumed'} because the service does not support being suspended or resumed.`,
      'CloseError', s.name, 'ServiceCommandException', `CouldNot${cmdlet === 'Suspend-Service' ? 'Suspend' : 'Resume'}ServiceNotSupported`));
  };
}

function newService(ctx: WindowsContext): WindowsResult {
  const cmdlet = 'New-Service';
  const b = bind(ctx, cmdlet, {
    Name: { kind: 'value', position: 0 }, BinaryPathName: { kind: 'value', position: 1 }, DisplayName: { kind: 'value' }, Description: { kind: 'value' },
    StartupType: { kind: 'value' }, Credential: { kind: 'value' }, DependsOn: { kind: 'list' }, WhatIf: { kind: 'switch' }, Confirm: { kind: 'switch' },
  }, { Path: 'BinaryPathName' });
  if (isResult(b)) return b;
  const name = b.str('Name');
  const bin = b.str('BinaryPathName');
  if (!name || !bin) return ctx.fail(psError(ctx.raw, cmdlet, `Cannot process command because of one or more missing mandatory parameters: ${!name ? 'Name ' : ''}${!bin ? 'BinaryPathName' : ''}`.trim() + '.', 'InvalidArgument', '', 'ParameterBindingException', 'MissingMandatoryParameter'));
  if (!ctx.isAdmin) {
    return ctx.fail(psError(ctx.raw, cmdlet, `Service '${name} (${name})' cannot be created due to the following error: Access is denied`, 'PermissionDenied', name, 'ServiceCommandException', 'CouldNotNewService'), 1, notElevatedService(ctx));
  }
  if (ctx.state.services.some(s => s.name.toLowerCase() === name.toLowerCase())) {
    return ctx.fail(psError(ctx.raw, cmdlet, `Service '${name} (${name})' cannot be created due to the following error: The specified service already exists`, 'PermissionDenied', name, 'ServiceCommandException', 'CouldNotNewService'));
  }
  const type = b.str('StartupType');
  const mode = (['Automatic', 'Manual', 'Disabled'] as const).find(x => x.toLowerCase() === (type ?? 'automatic').toLowerCase()) ?? 'Automatic';
  const svc: WindowsService = { name, displayName: b.str('DisplayName') ?? name, status: 'Stopped', startType: mode };
  ctx.state.services = [...ctx.state.services, svc];
  return ctx.ok(serviceTable([serviceObject(svc)]));
}

// ---------------------------------------------------------------- processes

/** Get-Process as objects, or an error result. */
export function getProcessRows(ctx: WindowsContext): Row[] | WindowsResult {
  const b = bind(ctx, 'Get-Process', {
    Name: { kind: 'list', position: 0 }, Id: { kind: 'list' }, IncludeUserName: { kind: 'switch' }, Module: { kind: 'switch' },
    FileVersionInfo: { kind: 'switch' }, ComputerName: { kind: 'list' }, InputObject: { kind: 'value' },
  }, { ProcessName: 'Name', PID: 'Id' });
  if (isResult(b)) return b;
  let procs = allProcesses(ctx).filter(x => x.pid !== 0);
  const names = b.list('Name');
  const ids = b.list('Id');
  const errors: string[] = [];
  if (names) {
    const picked: ProcessItem[] = [];
    for (const n of names) {
      const re = globToRegex(n, true);
      const hits = procs.filter(x => re.test(x.command.replace(/\.exe$/i, '')));
      if (!hits.length && !/[*?]/.test(n)) {
        errors.push(psError(ctx.raw, 'Get-Process', `Cannot find a process with the name "${n}". Verify the process name and call the cmdlet again.`,
          'ObjectNotFound', n, 'ProcessCommandException', 'NoProcessFoundForGivenName'));
      }
      picked.push(...hits.filter(h => !picked.includes(h)));
    }
    procs = picked;
  }
  if (ids) {
    const picked: ProcessItem[] = [];
    for (const id of ids) {
      const hit = procs.find(x => String(x.pid) === id);
      if (!hit) {
        errors.push(psError(ctx.raw, 'Get-Process', `Cannot find a process with the process identifier ${id}.`, 'ObjectNotFound', id, 'ProcessCommandException', 'NoProcessFoundForGivenId').replace(`(${id}:String)`, `(${id}:Int32)`));
      } else if (!picked.includes(hit)) picked.push(hit);
    }
    procs = picked;
  }
  if (errors.length && !procs.length) return ctx.fail(errors.join('\n'));
  procs.sort((x, y) => x.command.toLowerCase().localeCompare(y.command.toLowerCase()));
  const rows = procs.map(processObject);
  if (errors.length) (rows as Row[] & { errors?: string }).errors = errors.join('\n');
  return rows;
}

function getProcess(ctx: WindowsContext): WindowsResult {
  const rows = getProcessRows(ctx);
  if (!Array.isArray(rows)) return rows;
  const errors = (rows as Row[] & { errors?: string }).errors ?? '';
  return ctx.result(rows.length ? processTable(rows) : '', errors, errors ? 1 : 0);
}

function stopProcess(ctx: WindowsContext): WindowsResult {
  const cmdlet = 'Stop-Process';
  const b = bind(ctx, cmdlet, {
    Id: { kind: 'list', position: 0 }, Name: { kind: 'list' }, InputObject: { kind: 'value' }, Force: { kind: 'switch' },
    PassThru: { kind: 'switch' }, WhatIf: { kind: 'switch' }, Confirm: { kind: 'switch' },
  }, { ProcessName: 'Name', PID: 'Id' });
  if (isResult(b)) return b;
  const ids = b.list('Id');
  const names = b.list('Name');
  if (!ids && !names) {
    return ctx.fail(psError(ctx.raw, cmdlet, 'Cannot process command because of one or more missing mandatory parameters: Id.', 'InvalidArgument', '', 'ParameterBindingException', 'MissingMandatoryParameter'));
  }
  const procs = allProcesses(ctx).filter(p => p.pid !== 0);
  const targets: ProcessItem[] = [];
  const errors: string[] = [];
  for (const id of ids ?? []) {
    if (!/^\d+$/.test(id)) {
      return ctx.fail(psError(ctx.raw, cmdlet, `Cannot bind parameter 'Id'. Cannot convert value "${id}" to type "System.Int32". Error: "Input string was not in a correct format."`, 'InvalidArgument', '', 'ParameterBindingException', 'CannotConvertArgumentNoMessage'));
    }
    const p = procs.find(x => String(x.pid) === id);
    if (p) targets.push(p);
    else errors.push(psError(ctx.raw, cmdlet, `Cannot find a process with the process identifier ${id}.`, 'ObjectNotFound', id, 'ProcessCommandException', 'NoProcessFoundForGivenId').replace(`(${id}:String)`, `(${id}:Int32)`));
  }
  for (const n of names ?? []) {
    const re = globToRegex(n.replace(/\.exe$/i, ''), true);
    const hits = procs.filter(x => re.test(x.command.replace(/\.exe$/i, '')));
    if (!hits.length && !/[*?]/.test(n)) {
      errors.push(psError(ctx.raw, cmdlet, `Cannot find a process with the name "${n}". Verify the process name and call the cmdlet again.`, 'ObjectNotFound', n, 'ProcessCommandException', 'NoProcessFoundForGivenName'));
    }
    targets.push(...hits.filter(h => !targets.includes(h)));
  }
  const out: string[] = [];
  let note: string | undefined;
  for (const p of targets) {
    const name = p.command.replace(/\.exe$/i, '');
    if (b.has('WhatIf')) { out.push(`What if: Performing the operation "Stop-Process" on target "${name} (${p.pid})".`); continue; }
    const critical = CRITICAL_PROCESSES.has(p.command.toLowerCase());
    const otherUser = !ctx.isAdmin && p.user.toLowerCase() !== ctx.state.currentUser.toLowerCase();
    if (critical || otherUser) {
      errors.push(psError(ctx.raw, cmdlet, `Cannot stop process "${name} (${p.pid})" because of the following error: Access is denied`, 'CloseError', `System.Diagnostics.Process (${name})`, 'ProcessCommandException', 'CouldNotStopProcess')
        .replace(`(System.Diagnostics.Process (${name}):String)`, `(System.Diagnostics.Process (${name}):Process)`));
      note = critical
        ? `${p.command} is a critical system process; Windows refuses to end it even for administrators.`
        : `You are '${ctx.state.currentUser}' in a prompt that is not elevated. Ending a process owned by ${p.user} needs an elevated PowerShell (Run as administrator).`;
      continue;
    }
    endProcess(ctx, p.pid);
    if (b.has('PassThru')) out.push(processTable([processObject(p)]));
  }
  return ctx.result(out.join('\n'), errors.join('\n'), errors.length ? 1 : 0, note);
}

// ---------------------------------------------------------------- network

function testNetConnection(ctx: WindowsContext): WindowsResult {
  const b = bind(ctx, 'Test-NetConnection', {
    ComputerName: { kind: 'value', position: 0 }, Port: { kind: 'value' }, InformationLevel: { kind: 'value' }, CommonTCPPort: { kind: 'value', position: 1 },
    TraceRoute: { kind: 'switch' }, Hops: { kind: 'value' },
  }, { RemoteAddress: 'ComputerName', cn: 'ComputerName', RemotePort: 'Port' });
  if (isResult(b)) return b;
  const host = b.str('ComputerName') ?? 'internetbeacon.msedge.net';
  const common: Record<string, number> = { http: 80, rdp: 3389, smb: 445, winrm: 5985 };
  const portArg = b.str('Port') ?? (b.has('CommonTCPPort') ? String(common[String(b.str('CommonTCPPort')).toLowerCase()] ?? '') : undefined);
  const port = portArg !== undefined ? parseInt(portArg, 10) : undefined;
  const iface = ctx.state.interfaces[0];
  const source = iface?.ip ?? '192.168.1.145';
  const alias = iface?.name ?? 'Ethernet0';
  const ip = resolveHost(ctx, host);
  const warnings: string[] = [];
  if (!ip) {
    warnings.push(`WARNING: Name resolution of ${host} failed`);
    return ctx.result([`ComputerName   : ${host}`, 'RemoteAddress  :', `InterfaceAlias : ${alias}`, `SourceAddress  : ${source}`, 'PingSucceeded  : False'].join('\n'), warnings.join('\n'), 1);
  }
  const self = ip.startsWith('127.') || ctx.state.interfaces.some(i => i.ip === ip);
  const reachable = self || hasConnectivity(ctx);
  const tcpOk = reachable && port !== undefined && !ctx.state.firewallBlockedPorts.includes(port);
  if (b.str('InformationLevel')?.toLowerCase() === 'quiet') return ctx.ok(port !== undefined ? (tcpOk ? 'True' : 'False') : reachable ? 'True' : 'False');
  if (port !== undefined && tcpOk) {
    return ctx.ok([
      `ComputerName     : ${host}`,
      `RemoteAddress    : ${ip}`,
      `RemotePort       : ${port}`,
      `InterfaceAlias   : ${alias}`,
      `SourceAddress    : ${source}`,
      'TcpTestSucceeded : True',
    ].join('\n'));
  }
  if (port !== undefined) warnings.push(`WARNING: TCP connect to (${ip} : ${port}) failed`);
  if (!reachable) warnings.push(`WARNING: Ping to ${ip} failed with status: DestinationHostUnreachable`);
  const lines = [
    `ComputerName           : ${host}`,
    `RemoteAddress          : ${ip}`,
    ...(port !== undefined ? [`RemotePort             : ${port}`] : []),
    `InterfaceAlias         : ${alias}`,
    `SourceAddress          : ${source}`,
    `PingSucceeded          : ${reachable ? 'True' : 'False'}`,
    ...(reachable ? [`PingReplyDetails (RTT) : ${self ? 0 : 12} ms`] : []),
    ...(port !== undefined ? ['TcpTestSucceeded       : False'] : []),
  ];
  return ctx.result(lines.join('\n'), warnings.join('\n'), reachable && port === undefined ? 0 : 1);
}

/** Get-NetIPConfiguration [-InterfaceAlias name] [-Detailed]: the adapter summary PowerShell shows. */
function getNetIPConfiguration(ctx: WindowsContext): WindowsResult {
  const b = bind(ctx, 'Get-NetIPConfiguration', { InterfaceAlias: { kind: 'value', position: 0 }, InterfaceIndex: { kind: 'value' }, Detailed: { kind: 'switch' }, All: { kind: 'switch' } });
  if (isResult(b)) return b;
  const alias = b.str('InterfaceAlias');
  const adapters: NetworkInterface[] = ctx.state.interfaces.filter(i => i.name !== 'lo' && !i.ip.startsWith('127.'));
  const chosen = alias ? adapters.filter(i => globToRegex(alias, true).test(i.name)) : adapters;
  if (alias && !chosen.length && !/[*?]/.test(alias)) {
    return ctx.fail(psError(ctx.raw, 'Get-NetIPConfiguration', `No MSFT_NetIPInterface objects found with property 'InterfaceAlias' equal to '${alias}'.  Verify the value of the property and retry.`,
      'ObjectNotFound', alias, 'CimJobException', 'CmdletizationQuery_NotFound_InterfaceAlias,Get-NetIPInterface'));
  }
  const detailed = b.has('Detailed');
  const blocks = chosen.map((i, n) => {
    const apipa = i.ip.startsWith('169.254.');
    const rows: [string, string][] = [
      ['InterfaceAlias', i.name],
      ['InterfaceIndex', String(12 + n)],
      ['InterfaceDescription', 'Intel(R) 82574L Gigabit Network Connection'],
      ...(detailed ? [['NetAdapter.LinkLayerAddress', i.mac], ['NetAdapter.Status', i.status === 'UP' ? 'Up' : 'Disconnected']] as [string, string][] : []),
      ['NetProfile.Name', apipa ? 'Unidentified network' : 'corp.local'],
      ...(detailed ? [['NetProfile.NetworkCategory', apipa ? 'Public' : 'DomainAuthenticated'], ['NetProfile.IPv4Connectivity', apipa ? 'NoTraffic' : 'Internet']] as [string, string][] : []),
      ['IPv4Address', i.ip],
      ['IPv6DefaultGateway', ''],
      ['IPv4DefaultGateway', i.gateway],
      ['DNSServer', i.dns.join('\n')],
    ];
    const width = Math.max(...rows.map(([k]) => k.length)) + 1;
    return rows.map(([k, v]) => {
      const [first, ...more] = v.split('\n');
      return [`${k.padEnd(width)}: ${first}`.trimEnd(), ...more.map(m => `${' '.repeat(width + 2)}${m}`)].join('\n');
    }).join('\n');
  });
  return ctx.ok(blocks.length ? `\n${blocks.join('\n\n')}\n` : '');
}

psCommands.register(['Test-NetConnection', 'tnc'], testNetConnection);
psCommands.register(['Get-NetIPConfiguration', 'gip'], getNetIPConfiguration);
psCommands.registerAll({
  'Get-Service': getService,
  'Start-Service': setServiceStatus('Running', 'Start-Service'),
  'Stop-Service': setServiceStatus('Stopped', 'Stop-Service'),
  'Restart-Service': setServiceStatus('Running', 'Restart-Service'),
  'Set-Service': setService,
  'Suspend-Service': suspendResume('Suspend-Service'),
  'Resume-Service': suspendResume('Resume-Service'),
  'New-Service': newService,
  'Get-Process': getProcess,
  'Stop-Process': stopProcess,
});
