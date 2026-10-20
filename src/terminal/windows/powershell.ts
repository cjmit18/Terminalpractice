import { WindowsContext, WindowsResult, psCommands } from './context';

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
  const portMatch = ctx.raw.match(/-Port\s+(\d+)/i);
  const hostMatch = ctx.raw.match(/-ComputerName\s+([^\s]+)/i);
  const host = hostMatch ? hostMatch[1] : 'dc01.corp.local';
  const port = portMatch ? parseInt(portMatch[1], 10) : 80;
  return ctx.ok([
    `ComputerName           : ${host}`,
    `RemoteAddress          : 192.168.1.10`,
    `RemotePort             : ${port}`,
    `InterfaceAlias         : Ethernet0`,
    `SourceAddress          : 192.168.1.145`,
    `PingSucceeded          : True`,
    `PingReplyDetails (RTT) : 3 ms`,
    `TcpTestSucceeded       : True`,
  ].join('\n'));
}

function setServiceStatus(status: 'Running' | 'Stopped', verb: string) {
  return (ctx: WindowsContext): WindowsResult => {
    const match = ctx.raw.match(new RegExp(`^${verb}\\s+(?:-Name\\s+)?([^\\s]+)`, 'i'));
    if (match) {
      const srv = ctx.state.services.find(s => s.name.toLowerCase() === match[1].toLowerCase());
      if (srv) srv.status = status;
    }
    return ctx.ok();
  };
}

function getProcess(ctx: WindowsContext): WindowsResult {
  const rows = [
    '      9     1.85       4.20       0.12     540   0 csrss',
    '     14     5.10      14.30       1.45     704   0 lsass',
    '     22    18.50      38.90       2.10     844   0 svchost',
    '     45    64.20     120.40       8.90    2140   1 explorer',
    ...processRows(ctx.state.processes),
  ];
  return ctx.ok(`${PROCESS_HEADER}\n${rows.join('\n')}`);
}

function stopProcess(ctx: WindowsContext): WindowsResult | null {
  const idMatch = ctx.raw.match(/-Id\s+(\d+)/i) || ctx.raw.match(/Stop-Process\s+(\d+)/i);
  if (!idMatch) return null;
  const pid = parseInt(idMatch[1], 10);
  ctx.state.processes = ctx.state.processes.filter(p => p.pid !== pid);
  return ctx.ok();
}

function getADUser(ctx: WindowsContext): WindowsResult {
  const lines: string[] = [];
  for (const u of ctx.state.adUsers) {
    lines.push(
      `DistinguishedName : CN=${u.displayName},${u.ou}`,
      `Enabled           : ${u.enabled}`,
      `GivenName         : ${u.givenName}`,
      `Name              : ${u.displayName}`,
      `ObjectClass       : user`,
      `SamAccountName    : ${u.sAMAccountName}`,
      `Surname           : ${u.surname}`,
      `UserPrincipalName : ${u.sAMAccountName}@corp.local`,
      ''
    );
  }
  return ctx.ok(lines.join('\n'));
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
  'Get-Service': ctx => ctx.ok(`${SERVICE_HEADER}\n${serviceRows(ctx.state.services).join('\n')}`),
  'Start-Service': setServiceStatus('Running', 'Start-Service'),
  'Stop-Service': setServiceStatus('Stopped', 'Stop-Service'),
  'Get-Process': getProcess,
  'Stop-Process': stopProcess,
  'Get-ADUser': getADUser,
  'New-ADUser': newADUser,
  'Add-ADGroupMember': addADGroupMember,
  'Unlock-ADAccount': unlockADAccount,
});
