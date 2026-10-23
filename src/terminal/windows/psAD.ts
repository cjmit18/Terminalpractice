import { ADGroup, ADUser, SystemState } from '../../types/terminal';
import { globToRegex } from '../textUtils';
import { WindowsContext, WindowsResult, psCommands } from './context';
import { PsBound, PsParamSpec, adNotFound, bindCmdlet, psBool, psError } from './psUtil';

// ActiveDirectory module cmdlets: Get-ADUser, New-ADUser, Unlock/Enable/Disable-ADAccount,
// Set-ADAccountPassword, Search-ADAccount, Add-ADGroupMember and Get-ADGroupMember.

export type Row = Record<string, unknown>;

export const DOMAIN_DN = 'DC=corp,DC=local';
const USERS_CONTAINER = `CN=Users,${DOMAIN_DN}`;

const rid = (sam: string) => 1100 + [...sam.toLowerCase()].reduce((n, c) => n + c.charCodeAt(0), 0);
const guid = (sam: string) => `${rid(sam).toString(16).padStart(8, '0')}-3c1e-4b7a-9f02-5d6e7a8b9c0d`;
const sid = (sam: string) => `S-1-5-21-3623811015-3361044348-30300820-${rid(sam)}`;

/** A sign-in name like the ones a domain controller generates ($K3Q000-8F2NJ4TQB1LV), the same for the same DN. */
function generatedSam(dn: string): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  let h = 2166136261;
  const pick = () => chars[((h = Math.imul(h ^ 0x9e37, 16777619) >>> 0) >>> 7) % chars.length];
  for (const c of dn.toLowerCase()) h = Math.imul(h ^ c.charCodeAt(0), 16777619) >>> 0;
  const head = Array.from({ length: 3 }, pick).join('');
  return `$${head}000-${Array.from({ length: 12 }, pick).join('')}`;
}

export const userDN = (u: ADUser) => `CN=${u.displayName},${u.ou}`;
export const groupDN = (g: ADGroup) => `CN=${g.name},${g.ou || USERS_CONTAINER}`;

/** Every property Get-ADUser can return for a user, by name. */
export function adUserProps(state: SystemState, u: ADUser): Record<string, string> {
  const groupDNs = u.memberOf
    .filter(g => g.toLowerCase() !== 'domain users') // the primary group is not listed in memberOf
    .map(g => {
      const grp = state.adGroups.find(x => x.name.toLowerCase() === g.toLowerCase());
      return grp ? groupDN(grp) : `CN=${g},${USERS_CONTAINER}`;
    });
  return {
    DistinguishedName: userDN(u),
    Enabled: u.enabled ? 'True' : 'False',
    GivenName: u.givenName,
    Name: u.displayName,
    ObjectClass: 'user',
    ObjectGUID: guid(u.sAMAccountName),
    SamAccountName: u.sAMAccountName,
    SID: sid(u.sAMAccountName),
    Surname: u.surname,
    UserPrincipalName: u.userPrincipalName ?? `${u.sAMAccountName}@corp.local`,
    // extended properties, only shown when asked for with -Properties
    Department: u.department,
    DisplayName: u.displayName,
    EmailAddress: u.email,
    LockedOut: u.locked ? 'True' : 'False',
    MemberOf: `{${groupDNs.join(', ')}}`,
    PasswordNeverExpires: u.passwordNeverExpires ? 'True' : 'False',
  };
}

const AD_DEFAULT = ['DistinguishedName', 'Enabled', 'GivenName', 'Name', 'ObjectClass', 'ObjectGUID', 'SamAccountName', 'SID', 'Surname', 'UserPrincipalName'];

/** A user by sAMAccountName, distinguished name, SID, GUID or UPN. */
export function findADUser(state: SystemState, identity: string): ADUser | undefined {
  const id = identity.trim().toLowerCase();
  return state.adUsers.find(u => {
    const p = adUserProps(state, u);
    return [p.SamAccountName, p.DistinguishedName, p.SID, p.ObjectGUID, p.UserPrincipalName].some(v => v.toLowerCase() === id);
  });
}

export function findADGroup(state: SystemState, identity: string): ADGroup | undefined {
  const id = identity.trim().toLowerCase();
  return state.adGroups.find(g => g.name.toLowerCase() === id || groupDN(g).toLowerCase() === id || sid(g.name).toLowerCase() === id);
}

/** Renders objects the way PowerShell's list view does: "Name : value", one block per object. */
export function listView(rows: Row[]): string {
  if (!rows.length) return '';
  const blocks = rows.map(r => {
    const keys = Object.keys(r);
    const width = Math.max(...keys.map(k => k.length));
    return keys.map(k => `${k.padEnd(width)} : ${r[k] ?? ''}`.trimEnd()).join('\n');
  });
  return `\n${blocks.join('\n\n')}\n`;
}

/** Keeps the given properties of a full property map, sorted by name as the AD cmdlets print them. */
function pick(props: Record<string, string>, keys: string[]): Row {
  const sorted = [...new Set(keys)].sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));
  return Object.fromEntries(sorted.map(k => [k, props[k]]));
}

/** Matches -Filter text: *, or Prop -eq/-ne/-like 'value' joined by -and. */
function adFilter(filter: string): ((props: Record<string, string>) => boolean) | null {
  const f = filter.trim().replace(/^[{"']\s*|\s*[}"']$/g, '').trim();
  if (f === '*') return () => true;
  const clauses = f.split(/\s+-and\s+/i).map(c => c.match(/^(\w+)\s+-(eq|ne|like|notlike)\s+['"]?(.*?)['"]?$/i));
  if (clauses.some(c => !c)) return null;
  return props => clauses.every(c => {
    const key = Object.keys(props).find(k => k.toLowerCase() === c![1].toLowerCase());
    const actual = (key ? props[key] : '').toLowerCase();
    const want = c![3].replace(/^\$/, '').toLowerCase();
    switch (c![2].toLowerCase()) {
      case 'eq': return actual === want;
      case 'ne': return actual !== want;
      case 'like': return globToRegex(want, true).test(actual);
      default: return !globToRegex(want, true).test(actual);
    }
  });
}

const missingMandatory = (ctx: WindowsContext, cmdlet: string, param: string) =>
  ctx.fail(psError(ctx.raw, cmdlet, `Cannot process command because of one or more missing mandatory parameters: ${param}.`, 'InvalidArgument', '', 'ParameterBindingException', 'MissingMandatoryParameter'));

function bind(ctx: WindowsContext, cmdlet: string, spec: Record<string, PsParamSpec>, aliases: Record<string, string> = {}): PsBound | WindowsResult {
  const common: Record<string, PsParamSpec> = { Server: { kind: 'value' }, Credential: { kind: 'value' }, AuthType: { kind: 'value' }, WhatIf: { kind: 'switch' }, Confirm: { kind: 'switch' }, PassThru: { kind: 'switch' } };
  const b = bindCmdlet(ctx.raw, cmdlet, ctx.tokens, { ...common, ...spec }, aliases);
  return typeof b === 'string' ? ctx.fail(b) : b;
}
const isResult = (b: PsBound | WindowsResult): b is WindowsResult => 'exitCode' in b;

const whatIf = (op: string, target: string) => `What if: Performing the operation "${op}" on target "${target}".`;

/** Get-ADUser as objects for the pipeline: one property map per user, or an error result. */
export function getADUserRows(ctx: WindowsContext): Row[] | WindowsResult {
  const b = bind(ctx, 'Get-ADUser', {
    Identity: { kind: 'value', position: 0 }, Filter: { kind: 'value' }, LDAPFilter: { kind: 'value' },
    Properties: { kind: 'list' }, SearchBase: { kind: 'value' }, SearchScope: { kind: 'value' },
    ResultSetSize: { kind: 'value' }, Partition: { kind: 'value' },
  }, { Property: 'Properties' });
  if (isResult(b)) return b;
  const identity = b.str('Identity');
  const filterText = b.str('Filter');
  const wanted = b.list('Properties') ?? [];
  const { state } = ctx;
  let users: ADUser[];
  if (identity !== undefined) {
    const u = findADUser(state, identity);
    if (!u) return ctx.fail(adNotFound(ctx.raw, 'Get-ADUser', identity));
    users = [u];
  } else if (filterText !== undefined) {
    const test = adFilter(filterText);
    if (!test) {
      return ctx.fail(psError(ctx.raw, 'Get-ADUser', `Error parsing query: '${filterText}' Error Message: 'syntax error' at position: '1'.`, 'ParserError', filterText, 'ADFilterParsingException',
        'ActiveDirectoryCmdlet:Microsoft.ActiveDirectory.Management.ADFilterParsingException,Microsoft.ActiveDirectory.Management.Commands.GetADUser')
        .replace(',Microsoft.PowerShell.Commands.GetADUserCommand', ''));
    }
    users = state.adUsers.filter(u => test(adUserProps(state, u)));
  } else if (b.has('LDAPFilter')) {
    users = state.adUsers;
  } else {
    return missingMandatory(ctx, 'Get-ADUser', 'Filter');
  }
  const base = b.str('SearchBase');
  if (base) users = users.filter(u => userDN(u).toLowerCase().endsWith(base.toLowerCase()));
  return users.map(u => {
    const props = adUserProps(state, u);
    const extra = wanted.includes('*') ? Object.keys(props) : wanted.map(w => Object.keys(props).find(k => k.toLowerCase() === w.toLowerCase())).filter((k): k is string => !!k);
    return pick(props, [...AD_DEFAULT, ...extra]);
  });
}

function getADUser(ctx: WindowsContext): WindowsResult {
  const rows = getADUserRows(ctx);
  return Array.isArray(rows) ? ctx.ok(listView(rows)) : rows;
}

/** OUs and containers that exist in the lab directory. */
function knownContainers(state: SystemState): string[] {
  const dns = [USERS_CONTAINER, DOMAIN_DN, ...state.adUsers.map(u => u.ou), ...state.adGroups.map(g => g.ou), ...state.gpos.flatMap(g => g.linkedOUs)];
  return [...new Set(dns.filter(Boolean).map(d => d.toLowerCase()))];
}

const SECURE_STRING = /^\((\s*ConvertTo-SecureString\b|\s*Read-Host\b[^)]*-AsSecureString)/i;

function newADUser(ctx: WindowsContext): WindowsResult {
  const cmdlet = 'New-ADUser';
  const b = bind(ctx, cmdlet, {
    Name: { kind: 'value', position: 0 }, SamAccountName: { kind: 'value' }, Path: { kind: 'value' },
    GivenName: { kind: 'value' }, Surname: { kind: 'value' }, DisplayName: { kind: 'value' }, Department: { kind: 'value' },
    EmailAddress: { kind: 'value' }, UserPrincipalName: { kind: 'value' }, Title: { kind: 'value' }, Description: { kind: 'value' },
    AccountPassword: { kind: 'value' }, Enabled: { kind: 'value' }, ChangePasswordAtLogon: { kind: 'value' },
    PasswordNeverExpires: { kind: 'value' }, Type: { kind: 'value' }, Instance: { kind: 'value' }, OtherAttributes: { kind: 'value' },
  });
  if (isResult(b)) return b;
  const name = b.str('Name');
  if (!name) return missingMandatory(ctx, cmdlet, 'Name');
  const { state } = ctx;
  const boolArg = (param: string): boolean | null | undefined => {
    const v = b.str(param);
    return v === undefined ? undefined : psBool(v);
  };
  for (const param of ['Enabled', 'ChangePasswordAtLogon', 'PasswordNeverExpires']) {
    if (boolArg(param) === null) {
      return ctx.fail(psError(ctx.raw, cmdlet, `Cannot convert 'System.String' to the type 'System.Nullable\`1[System.Boolean]' required by parameter '${param}'. Boolean parameters accept only Boolean values and numbers, such as $True, $False, 1 or 0.`,
        'InvalidArgument', '', 'ParameterBindingException', 'CannotConvertArgument'));
    }
  }
  const password = b.str('AccountPassword');
  if (password !== undefined && !SECURE_STRING.test(password) && !password.startsWith('$')) {
    return ctx.fail(psError(ctx.raw, cmdlet, `Cannot bind parameter 'AccountPassword'. Cannot convert the "${password}" value of type "System.String" to type "System.Security.SecureString".`,
      'InvalidArgument', '', 'ParameterBindingException', 'CannotConvertArgumentNoMessage'));
  }
  const path = b.str('Path') ?? USERS_CONTAINER;
  const dn = `CN=${name},${path}`;
  // Without -SamAccountName the domain controller makes one up ($ABC000-...); -Name is not copied into it
  const sam = b.str('SamAccountName') ?? generatedSam(dn);
  if (b.has('WhatIf')) return ctx.ok(whatIf('New', dn));
  if (!knownContainers(state).includes(path.toLowerCase())) {
    return ctx.fail(psError(ctx.raw, cmdlet, 'Directory object not found', 'ObjectNotFound', dn, 'ADIdentityNotFoundException',
      'ActiveDirectoryCmdlet:Microsoft.ActiveDirectory.Management.ADIdentityNotFoundException,Microsoft.ActiveDirectory.Management.Commands.NewADUser')
      .replace(':String)', ':ADUser)').replace(',Microsoft.PowerShell.Commands.NewADUserCommand', ''));
  }
  if (state.adUsers.some(u => u.sAMAccountName.toLowerCase() === sam.toLowerCase() || userDN(u).toLowerCase() === dn.toLowerCase())) {
    return ctx.fail(psError(ctx.raw, cmdlet, 'The specified account already exists', 'ResourceExists', dn, 'ADIdentityAlreadyExistsException',
      'ActiveDirectoryServer:1316,Microsoft.ActiveDirectory.Management.Commands.NewADUser').replace(':String)', ':ADUser)').replace(',Microsoft.PowerShell.Commands.NewADUserCommand', ''));
  }
  // Like the real cmdlet, the account is created disabled unless it gets a password and -Enabled $true
  const wantsEnabled = boolArg('Enabled') === true;
  const enabled = wantsEnabled && password !== undefined;
  state.adUsers.push({
    sAMAccountName: sam,
    // New-ADUser sets no UPN unless asked
    userPrincipalName: b.str('UserPrincipalName') ?? '',
    givenName: b.str('GivenName') ?? '',
    surname: b.str('Surname') ?? '',
    displayName: name,
    email: b.str('EmailAddress') ?? '',
    department: b.str('Department') ?? '',
    ou: path,
    enabled,
    locked: false,
    passwordNeverExpires: boolArg('PasswordNeverExpires') === true,
    memberOf: ['Domain Users'],
  });
  const du = state.adGroups.find(g => g.name.toLowerCase() === 'domain users');
  if (du && !du.members.includes(sam)) du.members.push(sam);
  if (wantsEnabled && !enabled) {
    // The object is created, but enabling it fails because a disabled account with no password is all policy allows
    return ctx.fail(psError(ctx.raw, cmdlet, 'The password does not meet the length, complexity, or history requirement of the domain.', 'InvalidData', dn, 'ADPasswordComplexityException',
      'ActiveDirectoryServer:1325,Microsoft.ActiveDirectory.Management.Commands.NewADUser').replace(':String)', ':ADUser)').replace(',Microsoft.PowerShell.Commands.NewADUserCommand', ''), 1,
      `The account ${sam} was created but is disabled: -Enabled $true needs -AccountPassword as well.`);
  }
  return ctx.ok(b.has('PassThru') ? listView([pick(adUserProps(state, state.adUsers[state.adUsers.length - 1]), AD_DEFAULT)]) : '');
}

/** Unlock-ADAccount, Enable-ADAccount, Disable-ADAccount and Set-ADAccountPassword share one shape. */
function accountCmdlet(cmdlet: string, op: string, apply: (u: ADUser) => void, extra: Record<string, PsParamSpec> = {}) {
  return (ctx: WindowsContext): WindowsResult => {
    const b = bind(ctx, cmdlet, { Identity: { kind: 'value', position: 0 }, Partition: { kind: 'value' }, ...extra });
    if (isResult(b)) return b;
    const identity = b.str('Identity');
    if (identity === undefined) return missingMandatory(ctx, cmdlet, 'Identity');
    const u = findADUser(ctx.state, identity);
    if (!u) return ctx.fail(adNotFound(ctx.raw, cmdlet, identity));
    if (b.has('WhatIf')) return ctx.ok(whatIf(op, userDN(u)));
    apply(u);
    return ctx.ok(b.has('PassThru') ? listView([pick(adUserProps(ctx.state, u), ['DistinguishedName', 'Enabled', 'Name', 'ObjectClass', 'ObjectGUID', 'SamAccountName', 'SID', 'UserPrincipalName'])]) : '');
  };
}

/** Search-ADAccount -LockedOut | -AccountDisabled | -PasswordNeverExpires ... */
export function searchADAccountRows(ctx: WindowsContext): Row[] | WindowsResult {
  const b = bind(ctx, 'Search-ADAccount', {
    LockedOut: { kind: 'switch' }, AccountDisabled: { kind: 'switch' }, PasswordNeverExpires: { kind: 'switch' },
    AccountExpired: { kind: 'switch' }, AccountExpiring: { kind: 'switch' }, PasswordExpired: { kind: 'switch' }, AccountInactive: { kind: 'switch' },
    UsersOnly: { kind: 'switch' }, ComputersOnly: { kind: 'switch' }, SearchBase: { kind: 'value' }, SearchScope: { kind: 'value' },
    TimeSpan: { kind: 'value' }, DateTime: { kind: 'value' },
  });
  if (isResult(b)) return b;
  const { state } = ctx;
  const tests: ((u: ADUser) => boolean)[] = [];
  if (b.has('LockedOut')) tests.push(u => u.locked);
  if (b.has('AccountDisabled')) tests.push(u => !u.enabled);
  if (b.has('PasswordNeverExpires')) tests.push(u => u.passwordNeverExpires);
  if (b.has('AccountExpired') || b.has('AccountExpiring') || b.has('PasswordExpired') || b.has('AccountInactive')) tests.push(() => false);
  if (!tests.length) {
    return ctx.fail(psError(ctx.raw, 'Search-ADAccount', 'Parameter set cannot be resolved using the specified named parameters.', 'InvalidArgument', '', 'ParameterBindingException', 'AmbiguousParameterSet'));
  }
  const base = b.str('SearchBase');
  const users = b.has('ComputersOnly') ? [] : state.adUsers.filter(u => tests.some(t => t(u)) && (!base || userDN(u).toLowerCase().endsWith(base.toLowerCase())));
  return users.map(u => {
    const p = adUserProps(state, u);
    return {
      AccountExpirationDate: '', DistinguishedName: p.DistinguishedName, Enabled: p.Enabled, LastLogonDate: '10/19/2026 8:45:12 AM',
      LockedOut: p.LockedOut, Name: p.Name, ObjectClass: 'user', ObjectGUID: p.ObjectGUID, PasswordExpired: 'False',
      PasswordNeverExpires: p.PasswordNeverExpires, SamAccountName: p.SamAccountName, SID: p.SID, UserPrincipalName: p.UserPrincipalName,
    };
  });
}

function addADGroupMember(ctx: WindowsContext): WindowsResult {
  const cmdlet = 'Add-ADGroupMember';
  const b = bind(ctx, cmdlet, { Identity: { kind: 'value', position: 0 }, Members: { kind: 'list', position: 1 }, Partition: { kind: 'value' } }, { Member: 'Members' });
  if (isResult(b)) return b;
  const groupId = b.str('Identity');
  if (groupId === undefined) return missingMandatory(ctx, cmdlet, 'Identity');
  const members = b.list('Members');
  if (!members?.length) return missingMandatory(ctx, cmdlet, 'Members');
  const { state } = ctx;
  const group = findADGroup(state, groupId);
  if (!group) return ctx.fail(adNotFound(ctx.raw, cmdlet, groupId).replace(':ADUser)', ':ADGroup)'));
  // Every member must exist before any is added
  const resolved: { sam: string; user?: ADUser }[] = [];
  for (const m of members) {
    const user = findADUser(state, m);
    const nested = user ? undefined : findADGroup(state, m);
    if (!user && !nested) return ctx.fail(adNotFound(ctx.raw, cmdlet, m).replace(':ADUser)', ':ADPrincipal)'));
    resolved.push({ sam: user ? user.sAMAccountName : nested!.name, user });
  }
  if (b.has('WhatIf')) return ctx.ok(whatIf('Set', groupDN(group)));
  for (const r of resolved) {
    if (!group.members.some(x => x.toLowerCase() === r.sam.toLowerCase())) group.members.push(r.sam);
    if (r.user && !r.user.memberOf.some(g => g.toLowerCase() === group.name.toLowerCase())) r.user.memberOf.push(group.name);
  }
  return ctx.ok();
}

export function getADGroupMemberRows(ctx: WindowsContext): Row[] | WindowsResult {
  const cmdlet = 'Get-ADGroupMember';
  const b = bind(ctx, cmdlet, { Identity: { kind: 'value', position: 0 }, Recursive: { kind: 'switch' }, Partition: { kind: 'value' } });
  if (isResult(b)) return b;
  const groupId = b.str('Identity');
  if (groupId === undefined) return missingMandatory(ctx, cmdlet, 'Identity');
  const { state } = ctx;
  const group = findADGroup(state, groupId);
  if (!group) return ctx.fail(adNotFound(ctx.raw, cmdlet, groupId).replace(':ADUser)', ':ADGroup)'));
  // Users that list the group are members too (the lab data keeps both sides)
  const sams = new Set(group.members.map(m => m.toLowerCase()));
  for (const u of state.adUsers) if (u.memberOf.some(g => g.toLowerCase() === group.name.toLowerCase())) sams.add(u.sAMAccountName.toLowerCase());
  const rows: Row[] = [];
  for (const s of sams) {
    const u = state.adUsers.find(x => x.sAMAccountName.toLowerCase() === s);
    const g = u ? undefined : findADGroup(state, s);
    if (u) rows.push({ distinguishedName: userDN(u), name: u.displayName, objectClass: 'user', objectGUID: guid(u.sAMAccountName), SamAccountName: u.sAMAccountName, SID: sid(u.sAMAccountName) });
    else if (g) rows.push({ distinguishedName: groupDN(g), name: g.name, objectClass: 'group', objectGUID: guid(g.name), SamAccountName: g.name, SID: sid(g.name) });
  }
  return rows;
}

const rowsCmdlet = (f: (ctx: WindowsContext) => Row[] | WindowsResult) => (ctx: WindowsContext): WindowsResult => {
  const rows = f(ctx);
  return Array.isArray(rows) ? ctx.ok(listView(rows)) : rows;
};

psCommands.registerAll({
  'Get-ADUser': getADUser,
  'New-ADUser': newADUser,
  'Unlock-ADAccount': accountCmdlet('Unlock-ADAccount', 'Set', u => { u.locked = false; }),
  'Enable-ADAccount': accountCmdlet('Enable-ADAccount', 'Set', u => { u.enabled = true; }),
  'Disable-ADAccount': accountCmdlet('Disable-ADAccount', 'Set', u => { u.enabled = false; }),
  'Set-ADAccountPassword': accountCmdlet('Set-ADAccountPassword', 'Set-ADAccountPassword', () => undefined,
    { Reset: { kind: 'switch' }, NewPassword: { kind: 'value' }, OldPassword: { kind: 'value' } }),
  'Search-ADAccount': rowsCmdlet(searchADAccountRows),
  'Add-ADGroupMember': addADGroupMember,
  'Get-ADGroupMember': rowsCmdlet(getADGroupMemberRows),
});
