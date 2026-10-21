import { globToRegex } from '../textUtils';
import { psDoc } from '../docs';
import { WindowsContext, WindowsResult, psCommands } from './context';
import { PsStage, PsToken, bindCmdlet, psError, psStage } from './psUtil';
import { Row, getProcessRows, matchServices, processTable, serviceObject, serviceTable } from './powershell';
import { getADGroupMemberRows, getADUserRows, listView, searchADAccountRows } from './psAD';
import { tcpConnectionRows, tcpTable } from './psSystem';
import { NATIVE_TOOLS } from './help';
import { childItems, itemTable } from './psFiles';

// The PowerShell object pipeline: a source cmdlet produces objects, Where-Object, Sort-Object,
// Select-Object, Select-String and Measure-Object transform them, and a cmdlet such as
// Stop-Process or Unlock-ADAccount can consume them (binding each object by property name).

type Kind = 'service' | 'process' | 'aduser' | 'tcp' | 'file' | 'string' | 'custom';
interface Objects { kind: Kind; items: Row[]; /** Show as a list even with few properties (Measure-Object). */ list?: boolean }

/** The canonical cmdlet name for a name or alias (sort -> Sort-Object), lower case. */
const canonical = (name: string) => (psDoc(name)?.name ?? name).toLowerCase();

function stageContext(ctx: WindowsContext, stage: PsStage): WindowsContext {
  const sub = new WindowsContext(stage.name, stage.args, '', stage.raw, ctx.cwd, ctx.fs, ctx.state);
  sub.tokens = stage.tokens;
  return sub;
}

const lines = (text: string) => text.replace(/\r/g, '').split('\n').filter((l, i, a) => !(l === '' && (i === 0 || i === a.length - 1)));
const strings = (text: string): Row[] => lines(text).map(l => ({ '': l }));

/** Runs the first stage and returns its output as objects. */
function source(ctx: WindowsContext, stage: PsStage, runNative: (line: string) => WindowsResult): Objects | WindowsResult {
  const sub = stageContext(ctx, stage);
  const name = canonical(stage.name);
  const rowsOr = (r: Row[] | WindowsResult, kind: Kind): Objects | WindowsResult => (Array.isArray(r) ? { kind, items: r } : r);
  switch (name) {
    case 'get-service': {
      const m = matchServices(sub, 'Get-Service');
      if ('exitCode' in m) return m;
      if (m.error) return sub.fail(m.error);
      return { kind: 'service', items: [...m.items].sort((a, b) => a.name.localeCompare(b.name, 'en', { sensitivity: 'base' })).map(serviceObject) };
    }
    case 'get-process': return rowsOr(getProcessRows(sub), 'process');
    case 'get-aduser': return rowsOr(getADUserRows(sub), 'aduser');
    case 'search-adaccount': return rowsOr(searchADAccountRows(sub), 'aduser');
    case 'get-adgroupmember': return rowsOr(getADGroupMemberRows(sub), 'aduser');
    case 'get-nettcpconnection': return rowsOr(tcpConnectionRows(sub), 'tcp');
    case 'get-childitem': {
      const r = childItems(sub);
      if ('exitCode' in r) return r;
      if (r.errors.length) return psCommands.get('Get-ChildItem')!(sub)!;
      // -Name passes the names on as strings
      return r.nameOnly ? { kind: 'string', items: r.names.map(n => ({ Name: n, '': n })) } : { kind: 'file', items: r.items };
    }
  }
  // A quoted string (or several, comma-separated) on its own is output as is
  if (!stage.tokens.length && /^["']/.test(stage.raw)) return { kind: 'string', items: [{ '': stage.name }] };
  const handler = psCommands.get(stage.name);
  if (handler && ['get-content', 'write-output'].includes(name)) {
    const res = handler(sub);
    if (!res) return sub.fail('');
    if (res.exitCode !== 0) return res;
    return { kind: 'string', items: strings(res.stdout) };
  }
  if (NATIVE_TOOLS.includes(stage.name.toLowerCase().replace(/\.exe$/, ''))) {
    const res = runNative(stage.raw.replace(/^(\S+?)\.exe\b/i, '$1'));
    if (res.exitCode !== 0 && !res.stdout) return res;
    return { kind: 'string', items: strings(res.stdout) };
  }
  return sub.fail(`${stage.name} : piping the output of ${stage.name} into another command is not supported in this simulator.`, 1);
}

// ---------------------------------------------------------------- Where-Object

const prop = (item: Row, name: string): unknown => {
  if (name === '') return item[''] ?? Object.values(item)[0];
  const key = Object.keys(item).find(k => k.toLowerCase() === name.toLowerCase());
  return key === undefined ? undefined : item[key];
};

/** A literal in a filter: 'text', "text", 42, $true, $false, $null or a bare word. */
function literal(text: string): unknown {
  const t = text.trim();
  if (/^'.*'$|^".*"$/.test(t)) return t.slice(1, -1);
  if (/^\$true$/i.test(t)) return true;
  if (/^\$false$/i.test(t)) return false;
  if (/^\$null$/i.test(t)) return null;
  if (/^-?\d+(\.\d+)?(kb|mb|gb)?$/i.test(t)) {
    const m = t.match(/^(-?[\d.]+)(kb|mb|gb)?$/i)!;
    return Number(m[1]) * ({ kb: 1024, mb: 1048576, gb: 1073741824 }[(m[2] ?? '').toLowerCase() as 'kb'] ?? 1);
  }
  return t;
}

function compare(actual: unknown, op: string, wanted: unknown): boolean {
  const neg = op.startsWith('not');
  const base = neg ? op.slice(3) : op;
  const a = actual === undefined || actual === null ? '' : actual;
  const asNum = (v: unknown) => (typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' && !isNaN(Number(v)) ? Number(v) : NaN);
  const na = asNum(a);
  const nw = asNum(wanted);
  const numeric = !isNaN(na) && !isNaN(nw);
  const sa = String(typeof a === 'boolean' ? (a ? 'True' : 'False') : a).toLowerCase();
  const sw = String(typeof wanted === 'boolean' ? (wanted ? 'True' : 'False') : wanted ?? '').toLowerCase();
  let r: boolean;
  switch (base) {
    case 'eq': r = numeric ? na === nw : sa === sw; break;
    case 'ne': r = numeric ? na !== nw : sa !== sw; break;
    case 'gt': r = numeric ? na > nw : sa > sw; break;
    case 'lt': r = numeric ? na < nw : sa < sw; break;
    case 'ge': r = numeric ? na >= nw : sa >= sw; break;
    case 'le': r = numeric ? na <= nw : sa <= sw; break;
    case 'like': r = globToRegex(sw, true).test(sa); break;
    case 'match': try { r = new RegExp(String(wanted), 'i').test(String(a)); } catch { r = false; } break;
    case 'contains': r = sa.split(/,\s*/).includes(sw); break;
    default: r = false;
  }
  return neg && base !== 'ne' ? !r : r;
}

const OPS = '(?:c|i)?(?:eq|ne|gt|lt|ge|le|like|notlike|match|notmatch|contains|notcontains)';

/** Compiles a filter script block ({ $_.CPU -gt 50 -and $_.Name -like 'svc*' }) or the simplified Prop -op Value form. */
export function compileFilter(body: string, simplified: boolean): ((item: Row) => boolean) | null {
  let text = body.trim();
  if (text.startsWith('{') && text.endsWith('}')) text = text.slice(1, -1).trim();
  else if (simplified) {
    const m = text.match(new RegExp(`^(\\w+)\\s+-(${OPS})\\s+(.+)$`, 'i'));
    if (m) text = `$_.${m[1]} -${m[2]} ${/^['"$\d-]/.test(m[3]) ? m[3] : `'${m[3]}'`}`;
    else if (/^\w+$/.test(text)) text = `$_.${text}`;
    else return null;
  }
  const ors = text.split(/\s+-or\s+/i);
  const compiled = ors.map(or => or.split(/\s+-and\s+/i).map(clause => {
    let c = clause.trim().replace(/^\((.*)\)$/, '$1').trim();
    let negate = false;
    const not = c.match(/^(?:-not\s+|!)(.*)$/i);
    if (not) { negate = true; c = not[1].trim().replace(/^\((.*)\)$/, '$1').trim(); }
    const m = c.match(new RegExp(`^\\$(?:_|PSItem)(?:\\.(\\w+))?\\s+-(${OPS})\\s+(.+)$`, 'i'));
    if (m) {
      const op = m[2].toLowerCase().replace(/^[ci]/, '');
      const wanted = literal(m[3]);
      return (item: Row) => compare(prop(item, m[1] ?? ''), op, wanted) !== negate;
    }
    const bare = c.match(/^\$(?:_|PSItem)\.(\w+)$/i);
    if (bare) {
      return (item: Row) => {
        const v = prop(item, bare[1]);
        const truthy = !(v === undefined || v === null || v === '' || v === 0 || v === false || String(v).toLowerCase() === 'false');
        return truthy !== negate;
      };
    }
    return null;
  }));
  if (compiled.some(and => and.some(c => !c))) return null;
  return item => compiled.some(and => and.every(c => c!(item)));
}

// ---------------------------------------------------------------- transforms

const STATUS_RANK: Record<string, number> = { Stopped: 1, StartPending: 2, StopPending: 3, Running: 4 };

function sortObjects(ctx: WindowsContext, objs: Objects, stage: PsStage): Objects | WindowsResult {
  const b = bindCmdlet(stage.raw, 'Sort-Object', stage.tokens, { Property: { kind: 'list', position: 0 }, Descending: { kind: 'switch' }, Unique: { kind: 'switch' }, CaseSensitive: { kind: 'switch' } });
  if (typeof b === 'string') return ctx.fail(b);
  const defaults: Record<Kind, string> = { service: 'Name', process: 'ProcessName', aduser: 'Name', tcp: 'LocalPort', file: 'Name', string: '', custom: '' };
  const keys = b.list('Property') ?? [defaults[objs.kind]];
  const dir = b.has('Descending') ? -1 : 1;
  const sorted = [...objs.items].sort((x, y) => {
    for (const k of keys) {
      const rank = (v: unknown) => (k.toLowerCase() === 'status' && typeof v === 'string' && v in STATUS_RANK ? STATUS_RANK[v] : v);
      const [rx, ry] = [rank(prop(x, k)), rank(prop(y, k))];
      const c = typeof rx === 'number' && typeof ry === 'number' ? rx - ry : String(rx ?? '').localeCompare(String(ry ?? ''), 'en', { sensitivity: 'base' });
      if (c) return c * dir;
    }
    return 0;
  });
  const items = b.has('Unique') ? sorted.filter((it, i) => i === 0 || keys.some(k => String(prop(it, k)).toLowerCase() !== String(prop(sorted[i - 1], k)).toLowerCase())) : sorted;
  return { kind: objs.kind, items };
}

function selectObjects(ctx: WindowsContext, objs: Objects, stage: PsStage): Objects | WindowsResult {
  const b = bindCmdlet(stage.raw, 'Select-Object', stage.tokens, {
    Property: { kind: 'list', position: 0 }, First: { kind: 'value' }, Last: { kind: 'value' }, Skip: { kind: 'value' },
    ExpandProperty: { kind: 'value' }, Unique: { kind: 'switch' }, Index: { kind: 'list' },
  });
  if (typeof b === 'string') return ctx.fail(b);
  let items = objs.items;
  if (b.has('Skip')) items = items.slice(Number(b.str('Skip')) || 0);
  if (b.has('First')) items = items.slice(0, Number(b.str('First')) || 0);
  if (b.has('Last')) items = items.slice(-(Number(b.str('Last')) || 0));
  if (b.has('Index')) items = (b.list('Index') ?? []).map(Number).map(i => items[i]).filter(Boolean);
  const expand = b.str('ExpandProperty');
  if (expand) {
    const missing = items.find(it => prop(it, expand) === undefined);
    if (missing) {
      return ctx.fail(psError(stage.raw, 'Select-Object', `Property "${expand}" cannot be found.`, 'InvalidArgument', '', 'PSArgumentException', 'ExpandPropertyNotFound'));
    }
    return { kind: 'string', items: items.map(it => ({ '': String(prop(it, expand)) })) };
  }
  const props = (b.list('Property') ?? []).filter(p => p !== '*');
  if (props.length) {
    items = items.map(it => Object.fromEntries(props.map(p => {
      const key = Object.keys(it).find(k => k.toLowerCase() === p.toLowerCase()) ?? p;
      return [key, it[key] ?? ''];
    })));
    return { kind: 'custom', items };
  }
  return { kind: objs.kind, items };
}

function selectString(ctx: WindowsContext, objs: Objects, stage: PsStage): Objects | WindowsResult {
  const b = bindCmdlet(stage.raw, 'Select-String', stage.tokens, {
    Pattern: { kind: 'list', position: 0 }, SimpleMatch: { kind: 'switch' }, CaseSensitive: { kind: 'switch' }, NotMatch: { kind: 'switch' },
    Context: { kind: 'value' }, AllMatches: { kind: 'switch' }, Quiet: { kind: 'switch' }, List: { kind: 'switch' },
  });
  if (typeof b === 'string') return ctx.fail(b);
  const patterns = b.list('Pattern');
  if (!patterns) return ctx.fail(psError(stage.raw, 'Select-String', 'Cannot process command because of one or more missing mandatory parameters: Pattern.', 'InvalidArgument', '', 'ParameterBindingException', 'MissingMandatoryParameter'));
  const test = lineMatcher(patterns, b.has('SimpleMatch'), b.has('CaseSensitive'));
  const text = (it: Row) => (objs.kind === 'string' ? String(it['']) : Object.values(it).join(' '));
  const hits = objs.items.filter(it => test(text(it)) !== b.has('NotMatch'));
  if (b.has('Quiet')) return { kind: 'string', items: [{ '': hits.length ? 'True' : 'False' }] };
  return { kind: 'string', items: hits.map(h => ({ '': text(h) })) };
}

export function lineMatcher(patterns: string[], simple: boolean, caseSensitive: boolean): (line: string) => boolean {
  const res = patterns.map(p => {
    try {
      return new RegExp(simple ? p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') : p, caseSensitive ? '' : 'i');
    } catch {
      return new RegExp(p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), caseSensitive ? '' : 'i');
    }
  });
  return line => res.some(r => r.test(line));
}

function measureObject(ctx: WindowsContext, objs: Objects, stage: PsStage): Objects | WindowsResult {
  const b = bindCmdlet(stage.raw, 'Measure-Object', stage.tokens, {
    Property: { kind: 'list', position: 0 }, Sum: { kind: 'switch' }, Average: { kind: 'switch' }, Maximum: { kind: 'switch' }, Minimum: { kind: 'switch' },
    Line: { kind: 'switch' }, Word: { kind: 'switch' }, Character: { kind: 'switch' },
  });
  if (typeof b === 'string') return ctx.fail(b);
  const p = b.list('Property')?.[0];
  const nums = p ? objs.items.map(it => Number(prop(it, p))).filter(n => !isNaN(n)) : [];
  const fmt = (n: number) => String(Math.round(n * 1000) / 1000);
  const row: Row = {
    Count: objs.items.length,
    Average: b.has('Average') && nums.length ? fmt(nums.reduce((x, y) => x + y, 0) / nums.length) : '',
    Sum: b.has('Sum') && nums.length ? fmt(nums.reduce((x, y) => x + y, 0)) : '',
    Maximum: b.has('Maximum') && nums.length ? fmt(Math.max(...nums)) : '',
    Minimum: b.has('Minimum') && nums.length ? fmt(Math.min(...nums)) : '',
    Property: p ?? '',
  };
  return { kind: 'custom', items: [row], list: true };
}

// ---------------------------------------------------------------- output

/** Format-Table layout: a column per property, numbers right-aligned. */
export function tableView(items: Row[]): string {
  if (!items.length) return '';
  const keys = Object.keys(items[0]);
  const cell = (v: unknown) => (v === undefined || v === null ? '' : String(v));
  const numeric = keys.map(k => items.every(it => typeof it[k] === 'number'));
  const widths = keys.map(k => Math.max(k.length, ...items.map(it => cell(it[k]).length)));
  const pad = (v: string, i: number) => (numeric[i] ? v.padStart(widths[i]) : i === keys.length - 1 ? v : v.padEnd(widths[i]));
  const row = (vals: string[]) => vals.map(pad).join(' ').trimEnd();
  return ['', row(keys), row(keys.map(k => '-'.repeat(k.length))), ...items.map(it => row(keys.map(k => cell(it[k]))))].join('\n');
}

function render(objs: Objects & { list?: boolean }, format?: 'table' | 'list'): string {
  const { items } = objs;
  if (!items.length) return '';
  if (format === 'list') return listView(items.map(it => (objs.kind === 'string' ? { Value: it[''] } : it)));
  switch (objs.kind) {
    case 'service': return format === 'table' ? tableView(items.map(i => ({ Status: i.Status, Name: i.Name, DisplayName: i.DisplayName }))) : serviceTable(items);
    case 'process': return processTable(items);
    case 'aduser': return format === 'table' ? tableView(items) : listView(items);
    case 'tcp': return tcpTable(items);
    case 'file': return itemTable(items);
    case 'string': return items.map(i => String(i[''] ?? Object.values(i)[0] ?? '')).join('\n');
    default:
      if (objs.list || Object.keys(items[0]).length >= 5) return listView(items);
      return tableView(items);
  }
}

/** Cmdlets that take pipeline objects by property name: parameter and the property it binds. */
const BY_PROPERTY: Record<string, { param: string; prop: string; kinds: Kind[] }> = {
  'stop-process': { param: 'Id', prop: 'Id', kinds: ['process'] },
  'start-service': { param: 'Name', prop: 'Name', kinds: ['service'] },
  'stop-service': { param: 'Name', prop: 'Name', kinds: ['service'] },
  'restart-service': { param: 'Name', prop: 'Name', kinds: ['service'] },
  'set-service': { param: 'Name', prop: 'Name', kinds: ['service'] },
  'suspend-service': { param: 'Name', prop: 'Name', kinds: ['service'] },
  'resume-service': { param: 'Name', prop: 'Name', kinds: ['service'] },
  'get-service': { param: 'Name', prop: 'Name', kinds: ['service', 'string'] },
  'get-process': { param: 'Id', prop: 'Id', kinds: ['process'] },
  'unlock-adaccount': { param: 'Identity', prop: 'SamAccountName', kinds: ['aduser'] },
  'enable-adaccount': { param: 'Identity', prop: 'SamAccountName', kinds: ['aduser'] },
  'disable-adaccount': { param: 'Identity', prop: 'SamAccountName', kinds: ['aduser'] },
  'set-adaccountpassword': { param: 'Identity', prop: 'SamAccountName', kinds: ['aduser'] },
  'get-aduser': { param: 'Identity', prop: 'SamAccountName', kinds: ['aduser', 'string'] },
};

function consume(ctx: WindowsContext, objs: Objects, stage: PsStage): WindowsResult {
  const name = canonical(stage.name);
  const bindTo = BY_PROPERTY[name];
  const handler = psCommands.get(stage.name);
  const doc = psDoc(stage.name);
  // Only a simulated cmdlet given the wrong kind of input gets PowerShell's binding error. Elsewhere the
  // limit is the simulator's, and saying so avoids teaching that the cmdlet takes no pipeline input.
  if (!bindTo || !handler) {
    return ctx.fail(`${doc?.name ?? stage.name} : piping into ${doc?.name ?? stage.name} is not supported in this simulator.`, 1);
  }
  if (!objs.kind || (!bindTo.kinds.includes(objs.kind) && objs.kind !== 'custom')) {
    return ctx.fail(psError(stage.raw, doc?.name ?? stage.name, 'The input object cannot be bound to any parameters for the command either because the command does not take pipeline input or the input and its properties do not match any of the parameters that take pipeline input.',
      'InvalidArgument', '', 'ParameterBindingException', 'InputObjectNotBound'));
  }
  const out: string[] = [];
  const errors: string[] = [];
  const notes: string[] = [];
  let exitCode = 0;
  for (const item of objs.items) {
    const value = objs.kind === 'string' ? String(item['']) : prop(item, bindTo.prop);
    if (value === undefined) continue;
    const tokens: PsToken[] = [{ text: `-${bindTo.param}`, quoted: false }, { text: String(value), quoted: true }, ...stage.tokens];
    const sub = new WindowsContext(stage.name, tokens.map(t => t.text), '', stage.raw, ctx.cwd, ctx.fs, ctx.state);
    sub.tokens = tokens;
    const res = handler(sub);
    if (!res) continue;
    if (res.stdout) out.push(res.stdout);
    if (res.stderr) errors.push(res.stderr);
    if (res.explanation && !notes.includes(res.explanation)) notes.push(res.explanation);
    if (res.exitCode !== 0) exitCode = res.exitCode;
  }
  return ctx.result(out.join('\n'), errors.join('\n'), exitCode, notes.join('\n') || undefined);
}

/**
 * Runs a multi-stage PowerShell pipeline. `runNative` runs a native program (ipconfig, ping ...)
 * whose text output then flows on as strings.
 */
export function runPowerShellPipeline(ctx: WindowsContext, stages: PsStage[], runNative: (line: string) => WindowsResult): WindowsResult {
  const first = source(ctx, stages[0], runNative);
  if ('exitCode' in first) return first;
  let objs: Objects & { list?: boolean } = first;
  let format: 'table' | 'list' | undefined;
  const rest = stages.slice(1);
  for (let i = 0; i < rest.length; i++) {
    const stage = rest[i];
    const name = canonical(stage.name);
    let next: Objects | WindowsResult;
    switch (name) {
      case 'where-object': {
        const body = stage.raw.slice(stage.raw.indexOf(stage.name) + stage.name.length).trim().replace(/^-FilterScript\s+/i, '');
        const f = compileFilter(body, !body.startsWith('{'));
        if (!f) return ctx.fail(`Where-Object : this filter is not supported in this simulator. Use { $_.Property -eq 'value' } with -eq, -ne, -gt, -lt, -ge, -le, -like, -match, -and, -or.`);
        next = { kind: objs.kind, items: objs.items.filter(f) };
        break;
      }
      case 'sort-object': next = sortObjects(ctx, objs, stage); break;
      case 'select-object': next = selectObjects(ctx, objs, stage); break;
      case 'select-string': next = selectString(ctx, objs, stage); break;
      case 'measure-object': next = measureObject(ctx, objs, stage); break;
      case 'format-table': case 'format-list': {
        const b = bindCmdlet(stage.raw, stage.name, stage.tokens, { Property: { kind: 'list', position: 0 }, AutoSize: { kind: 'switch' }, Wrap: { kind: 'switch' } });
        if (typeof b === 'string') return ctx.fail(b);
        format = name === 'format-table' ? 'table' : 'list';
        const props = b.list('Property');
        next = props ? selectObjects(ctx, objs, psStage(`Select-Object ${props.join(',')}`)) : objs;
        if (!('exitCode' in next) && next.kind === 'custom' && format === 'table') {
          if (i === rest.length - 1) return ctx.ok(tableView(next.items));
        }
        break;
      }
      case 'out-null': return ctx.ok('');
      case 'out-host': case 'out-string': case 'out-default': next = objs; break;
      default:
        if (i !== rest.length - 1 && !BY_PROPERTY[name]) {
          return ctx.fail(`${stage.name} : this pipeline is not supported in this simulator.`);
        }
        return consume(ctx, objs, stage);
    }
    if ('exitCode' in next) return next;
    objs = next;
  }
  return ctx.ok(render(objs, format));
}
