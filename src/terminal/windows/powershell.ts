import { ADUser, WindowsService } from '../../types/terminal';
import { globToRegex } from '../textUtils';
import { WindowsContext, WindowsResult, psCommands } from './context';
import { bindParams, psError, badParameter } from './psUtil';
import { resolveHost, hasConnectivity } from './cmd/network';
import { allProcesses } from './cmd/system';

// PowerShell cmdlets. Handlers see the whole line in ctx.raw because most cmdlets parse
// named parameters (-Identity, -Port ...) straight from it.

type Row = Record<string, unknown>;

export function applyWhereObjectFilter<T extends Row>(items: T[], rawWhereCmd: string): { items: T[]; error?: string } {
  const afterCmd = rawWhereCmd.trim().replace(/^(Where-Object|where|\?)\s*/i, '').trim();
  // { $_.Prop -op 'Val' }  or  Prop -op Val
  const blockMatch = afterCmd.match(/^\{\s*\$_\.([a-zA-Z0-9_]+)\s+(-eq|-ne|-like)\s+['"]?([^'"}]+)['"]?\s*\}$/i);
  const simpleMatch = afterCmd.match(/^([a-zA-Z0-9_]+)\s+(-eq|-ne|-like)\s+['"]?([^'"]+)['"]?$/i);
  const match = blockMatch || simpleMatch;
  if (!match) return { items: [], error: 'Where-Object: filtering is not supported in this sim' };

  const propName = match[1];
  const op = match[2].toLowerCase();
  const targetVal = match[3].trim().toLowerCase();
  const filtered = items.filter(item => {
    const key = Object.keys(item).find(k => k.toLowerCase() === propName.toLowerCase());
    if (!key) return false;
    const val = String(item[key]).toLowerCase();
    if (op === '-eq') return val === targetVal;
    if (op === '-ne') return val !== targetVal;
    const regexStr = '^' + targetVal.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') + '$';
    return new RegExp(regexStr, 'i').test(val);
  });
  return { items: filtered };
}

const SERVICE_HEADER = 'Status   Name               DisplayName\n------   ----               -----------';
const PROCESS_HEADER = ' NPM(K)    PM(M)      WS(M)     CPU(s)      Id  SI ProcessName\n ------    -----      -----     ------      --  -- -----------';

const serviceRows = (items: { status: string; name: string; displayName: string }[]) =>
  items.map(s => `${s.status.padEnd(8, ' ')} ${s.name.padEnd(18, ' ')} ${s.displayName}`);
const processRows = (items: { mem: number; cpu: number; pid: number; command: string }[]) =>
  items.map(p => `     10     ${p.mem.toFixed(2).padStart(5, ' ')}      ${(p.mem * 2).toFixed(2).padStart(5, ' ')}       ${p.cpu.toFixed(2).padStart(5, ' ')}    ${p.pid.toString().padStart(4, ' ')}   1 ${p.command}`);

/**
 * Handles "Get-Service | Where-Object ..." and "Get-Process | Where-Object ...".
 * Returns null when the line is not one of those pipelines.
 */
export function runPowerShellPipeline(ctx: WindowsContext, stages: { name: string; raw: string }[]): WindowsResult | null {
  if (stages.length < 2) return null;
  const s0 = stages[0].raw.trim();
  const isService = /^Get-Service/i.test(s0);
  const isProcess = /^Get-Process/i.test(s0);
  if (!isService && !isProcess) return null;

  if (!/^(Where-Object|where|\?)/i.test(stages[1].name)) {
    return ctx.fail(`${stages[1].name}: pipeline filter not supported in this sim`);
  }
  const s1 = stages[1].raw.trim();
  if (isService) {
    const res = applyWhereObjectFilter(ctx.state.services as unknown as Row[], s1);
    if (res.error) return ctx.fail(res.error);
    return ctx.ok(`${SERVICE_HEADER}\n${serviceRows(res.items as never).join('\n')}`);
  }
  const res = applyWhereObjectFilter(ctx.state.processes as unknown as Row[], s1);
  if (res.error) return ctx.fail(res.error);
  return ctx.ok(`${PROCESS_HEADER}\n${processRows(res.items as never).join('\n')}`);
}

const param = (line: string, name: string): string | undefined => {
  const m = line.match(new RegExp(`-${name}\\s+"([^"]+)"|-${name}\\s+([^\\s]+)`, 'i'));
  return m ? (m[1] || m[2]) : undefined;
};

function testNetConnection(ctx: WindowsContext): WindowsResult {
  const p = bindParams(ctx.args, { ComputerName: 'value', Port: 'value', InformationLevel: 'value', CommonTCPPort: 'value' }, { RemoteAddress: 'ComputerName', cn: 'ComputerName' });
  if (typeof p === 'string') return ctx.fail(badParameter(ctx.raw, 'Test-NetConnection', p));
  const host = (p.named.get('ComputerName') as string | undefined) ?? p.positional[0] ?? 'internetbeacon.msedge.net';
  const common: Record<string, number> = { http: 80, rdp: 3389, smb: 445, winrm: 5985 };
  const portArg = (p.named.get('Port') as string | undefined) ?? (p.named.has('CommonTCPPort') ? String(common[String(p.named.get('CommonTCPPort')).toLowerCase()] ?? '') : undefined);
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
  const reachable = ip.startsWith('127.') || hasConnectivity(ctx);
  const tcpOk = reachable && port !== undefined && !ctx.state.firewallBlockedPorts.includes(port);
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
    ...(reachable ? [`PingReplyDetails (RTT) : ${ip.startsWith('127.') ? 0 : 12} ms`] : []),
    ...(port !== undefined ? ['TcpTestSucceeded       : False'] : []),
  ];
  return ctx.result(lines.join('\n'), warnings.join('\n'), reachable && port === undefined ? 0 : 1);
}

/** Services matching -Name / positional names (comma lists and wildcards), or an error block. */
function matchServices(ctx: WindowsContext, cmdlet: string): { items: WindowsService[]; error?: string } | string {
  const p = bindParams(ctx.args, { Name: 'value', DisplayName: 'value', Force: 'switch', PassThru: 'switch' }, { ServiceName: 'Name' });
  if (typeof p === 'string') return badParameter(ctx.raw, cmdlet, p);
  const wanted = [...((p.named.get('Name') as string | undefined)?.split(',') ?? []), ...p.positional.flatMap(x => x.split(','))]
    .map(x => x.trim()).filter(Boolean);
  const display = p.named.get('DisplayName') as string | undefined;
  if (wanted.length === 0 && !display) return { items: ctx.state.services };
  const items: WindowsService[] = [];
  const errors: string[] = [];
  for (const w of wanted) {
    const re = globToRegex(w, true);
    const found = ctx.state.services.filter(s => re.test(s.name));
    if (found.length === 0 && !/[*?]/.test(w)) {
      errors.push(psError(ctx.raw, cmdlet, `Cannot find any service with service name '${w}'.`, 'ObjectNotFound', w, 'ServiceCommandException', 'NoServiceFoundForGivenName'));
    }
    items.push(...found.filter(f => !items.includes(f)));
  }
  if (display) items.push(...ctx.state.services.filter(s => globToRegex(display, true).test(s.displayName) && !items.includes(s)));
  return { items, error: errors.join('\n') || undefined };
}

function getService(ctx: WindowsContext): WindowsResult {
  const m = matchServices(ctx, 'Get-Service');
  if (typeof m === 'string') return ctx.fail(m);
  const out = m.items.length ? `${SERVICE_HEADER}\n${serviceRows(m.items).join('\n')}` : '';
  return ctx.result(out, m.error ?? '', m.error ? 1 : 0);
}

function setServiceStatus(status: 'Running' | 'Stopped', cmdlet: 'Start-Service' | 'Stop-Service' | 'Restart-Service') {
  return (ctx: WindowsContext): WindowsResult => {
    const m = matchServices(ctx, cmdlet);
    if (typeof m === 'string') return ctx.fail(m);
    if (m.error) return ctx.fail(m.error);
    if (!ctx.isAdmin) {
      const s = m.items[0];
      const verb = cmdlet === 'Stop-Service' ? 'stopped' : 'started';
      return ctx.fail(psError(ctx.raw, cmdlet, `Service '${s?.displayName} (${s?.name})' cannot be ${verb} due to the following error: Cannot open ${s?.name} service on computer '.'.`,
        'OpenError', s?.name ?? '', 'ServiceCommandException', `CouldNotStartService`), 1,
        `You are '${ctx.state.currentUser}', a standard user (not elevated). Starting or stopping services needs an elevated PowerShell (Run as administrator).`);
    }
    for (const s of m.items) {
      if (status === 'Running' && s.startType === 'Disabled') {
        return ctx.fail(psError(ctx.raw, cmdlet, `Service '${s.displayName} (${s.name})' cannot be started due to the following error: Cannot start service ${s.name} on computer '.'.`,
          'OpenError', s.name, 'ServiceCommandException', 'CouldNotStartService'));
      }
      s.status = status;
    }
    return ctx.ok();
  };
}

function getProcess(ctx: WindowsContext): WindowsResult {
  const p = bindParams(ctx.args, { Name: 'value', Id: 'value' }, { ProcessName: 'Name' });
  if (typeof p === 'string') return ctx.fail(badParameter(ctx.raw, 'Get-Process', p));
  // ProcessName is the image name without .exe
  let procs = allProcesses(ctx).filter(x => x.pid !== 0).map(x => ({ ...x, command: x.command.replace(/\.exe$/i, '') }));
  const name = (p.named.get('Name') as string | undefined) ?? p.positional[0];
  const id = p.named.get('Id') as string | undefined;
  if (name) {
    const re = globToRegex(name, true);
    procs = procs.filter(x => re.test(x.command));
    if (procs.length === 0 && !/[*?]/.test(name)) {
      return ctx.fail(psError(ctx.raw, 'Get-Process', `Cannot find a process with the name "${name}". Verify the process name and call the cmdlet again.`,
        'ObjectNotFound', name, 'ProcessCommandException', 'NoProcessFoundForGivenName'));
    }
  }
  if (id) {
    procs = procs.filter(x => String(x.pid) === id);
    if (procs.length === 0) {
      return ctx.fail(psError(ctx.raw, 'Get-Process', `Cannot find a process with the process identifier ${id}.`,
        'ObjectNotFound', id, 'ProcessCommandException', 'NoProcessFoundForGivenId'));
    }
  }
  procs.sort((x, y) => x.command.toLowerCase().localeCompare(y.command.toLowerCase()));
  return ctx.ok(`${PROCESS_HEADER}\n${processRows(procs).join('\n')}`);
}

function stopProcess(ctx: WindowsContext): WindowsResult | null {
  const idMatch = ctx.raw.match(/-Id\s+(\d+)/i) || ctx.raw.match(/Stop-Process\s+(\d+)/i);
  if (!idMatch) return null;
  const pid = parseInt(idMatch[1], 10);
  ctx.state.processes = ctx.state.processes.filter(p => p.pid !== pid);
  return ctx.ok();
}

/** Properties Get-ADUser returns for a user, by name (the default set plus extended ones). */
function adUserProps(u: ADUser): Record<string, string> {
  const dn = `CN=${u.displayName},${u.ou}`;
  const rid = 1100 + [...u.sAMAccountName].reduce((n, c) => n + c.charCodeAt(0), 0);
  return {
    DistinguishedName: dn,
    Enabled: u.enabled ? 'True' : 'False',
    GivenName: u.givenName,
    Name: u.displayName,
    ObjectClass: 'user',
    ObjectGUID: `${rid.toString(16).padStart(8, '0')}-3c1e-4b7a-9f02-5d6e7a8b9c0d`,
    SamAccountName: u.sAMAccountName,
    SID: `S-1-5-21-3623811015-3361044348-30300820-${rid}`,
    Surname: u.surname,
    UserPrincipalName: `${u.sAMAccountName}@corp.local`,
    // extended properties, only shown when asked for with -Properties
    Department: u.department,
    DisplayName: u.displayName,
    EmailAddress: u.email,
    LockedOut: u.locked ? 'True' : 'False',
    MemberOf: `{${u.memberOf.map(g => `CN=${g},CN=Users,DC=corp,DC=local`).join(', ')}}`,
    PasswordNeverExpires: u.passwordNeverExpires ? 'True' : 'False',
  };
}

const AD_DEFAULT = ['DistinguishedName', 'Enabled', 'GivenName', 'Name', 'ObjectClass', 'ObjectGUID', 'SamAccountName', 'SID', 'Surname', 'UserPrincipalName'];

/** Matches -Filter text: *, or Prop -eq/-ne/-like 'value' joined by -and. */
function adFilter(filter: string): ((props: Record<string, string>) => boolean) | null {
  const f = filter.trim().replace(/^[{"']\s*|\s*[}"']$/g, '');
  if (f === '*') return () => true;
  const clauses = f.split(/\s+-and\s+/i).map(c => c.match(/^(\w+)\s+-(eq|ne|like)\s+['"]?(.*?)['"]?$/i));
  if (clauses.some(c => !c)) return null;
  return props => clauses.every(c => {
    const key = Object.keys(props).find(k => k.toLowerCase() === c![1].toLowerCase());
    const actual = (key ? props[key] : '').toLowerCase();
    const want = c![3].replace(/^\$/, '').toLowerCase();
    if (c![2].toLowerCase() === 'eq') return actual === want;
    if (c![2].toLowerCase() === 'ne') return actual !== want;
    return globToRegex(want, true).test(actual);
  });
}

function getADUser(ctx: WindowsContext): WindowsResult {
  const p = bindParams(ctx.args, { Identity: 'value', Filter: 'value', Properties: 'value', SearchBase: 'value', Server: 'value', LDAPFilter: 'value' });
  if (typeof p === 'string') return ctx.fail(badParameter(ctx.raw, 'Get-ADUser', p));
  const identity = (p.named.get('Identity') as string | undefined) ?? p.positional[0];
  const filterText = p.named.get('Filter') as string | undefined;
  const wanted = String(p.named.get('Properties') ?? '').split(',').map(x => x.trim()).filter(Boolean);
  let users = ctx.state.adUsers;
  if (identity) {
    const id = identity.toLowerCase();
    users = users.filter(u => {
      const props = adUserProps(u);
      return [u.sAMAccountName, props.DistinguishedName, props.SID, props.ObjectGUID, props.UserPrincipalName].some(v => v.toLowerCase() === id);
    });
    if (!users.length) {
      return ctx.fail(psError(ctx.raw, 'Get-ADUser', `Cannot find an object with identity: '${identity}' under: 'DC=corp,DC=local'.`, 'ObjectNotFound', identity, 'ADIdentityNotFoundException',
        'ActiveDirectoryCmdlet:Microsoft.ActiveDirectory.Management.ADIdentityNotFoundException,Microsoft.ActiveDirectory.Management.Commands.GetADUser')
        .replace(',Microsoft.PowerShell.Commands.GetADUserCommand', ''));
    }
  } else if (filterText !== undefined) {
    const test = adFilter(filterText);
    if (!test) return ctx.fail(psError(ctx.raw, 'Get-ADUser', `Error parsing query: '${filterText}'`, 'ParserError', filterText, 'ADFilterParsingException', 'ActiveDirectoryCmdlet:Microsoft.ActiveDirectory.Management.ADFilterParsingException,Microsoft.ActiveDirectory.Management.Commands.GetADUser')
      .replace(',Microsoft.PowerShell.Commands.GetADUserCommand', ''));
    users = users.filter(u => test(adUserProps(u)));
  }
  const blocks = users.map(u => {
    const props = adUserProps(u);
    const extra = wanted.includes('*') ? Object.keys(props) : wanted.map(w => Object.keys(props).find(k => k.toLowerCase() === w.toLowerCase())).filter((k): k is string => !!k);
    const keys = [...new Set([...AD_DEFAULT, ...extra])].sort((a, b) => a.localeCompare(b));
    const width = Math.max(...keys.map(k => k.length));
    return keys.map(k => `${k.padEnd(width)} : ${props[k]}`).join('\n');
  });
  return ctx.ok(blocks.length ? `\n${blocks.join('\n\n')}\n` : '');
}

function newADUser(ctx: WindowsContext): WindowsResult {
  const sam = ctx.raw.match(/-SamAccountName\s+([^\s]+)/i)?.[1] ?? 'newuser';
  const name = param(ctx.raw, 'Name') ?? sam;
  const ou = param(ctx.raw, 'Path') ?? 'OU=Users,DC=corp,DC=local';
  if (!ctx.state.adUsers.find(u => u.sAMAccountName.toLowerCase() === sam.toLowerCase())) {
    ctx.state.adUsers.push({
      sAMAccountName: sam,
      givenName: name.split(' ')[0] || sam,
      surname: name.split(' ')[1] || 'User',
      displayName: name,
      email: `${sam}@corp.local`,
      department: 'Engineering',
      ou,
      enabled: true,
      locked: false,
      passwordNeverExpires: false,
      memberOf: ['Domain Users'],
    });
  }
  return ctx.ok();
}

function addADGroupMember(ctx: WindowsContext): WindowsResult {
  const groupName = param(ctx.raw, 'Identity') ?? '';
  const memberName = param(ctx.raw, 'Members') ?? '';
  if (groupName && memberName) {
    const user = ctx.state.adUsers.find(u => u.sAMAccountName.toLowerCase() === memberName.toLowerCase());
    if (user && !user.memberOf.includes(groupName)) user.memberOf.push(groupName);
    const grp = ctx.state.adGroups.find(g => g.name.toLowerCase() === groupName.toLowerCase());
    if (grp && !grp.members.includes(memberName)) grp.members.push(memberName);
  }
  return ctx.ok();
}

function unlockADAccount(ctx: WindowsContext): WindowsResult {
  const idMatch = ctx.raw.match(/-Identity\s+([^\s]+)/i);
  if (idMatch) {
    const u = ctx.state.adUsers.find(user => user.sAMAccountName.toLowerCase() === idMatch[1].toLowerCase());
    if (u) u.locked = false;
  }
  return ctx.ok();
}

psCommands.register(['Test-NetConnection', 'tnc'], testNetConnection);
psCommands.registerAll({
  'Get-Service': getService,
  gsv: getService,
  'Start-Service': setServiceStatus('Running', 'Start-Service'),
  'Stop-Service': setServiceStatus('Stopped', 'Stop-Service'),
  'Restart-Service': setServiceStatus('Running', 'Restart-Service'),
  'Get-Process': getProcess,
  'Stop-Process': stopProcess,
  'Get-ADUser': getADUser,
  'New-ADUser': newADUser,
  'Add-ADGroupMember': addADGroupMember,
  'Unlock-ADAccount': unlockADAccount,
});
