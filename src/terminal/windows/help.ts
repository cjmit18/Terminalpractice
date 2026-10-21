import { CMD_DOCS, PS_DOCS, cmdDoc, psDoc } from '../docs';
import { PsDoc, PsParameter } from '../docs/types';
import { DISKPART_COMMANDS, DISKPART_TOPICS } from '../docs/cmdDocs';
import { wrap } from '../docs/linuxRender';
import { globToRegex } from '../textUtils';
import { WindowsContext, WindowsResult, cmdCommands, psCommands } from './context';
import { bindParams, badParameter, psError } from './psUtil';

// Getting help on Windows: CMD's HELP and /?, DiskPart's HELP, and PowerShell's
// Get-Help, Get-Command and -?, all answering from src/terminal/docs.

/** Programs (not CMD built-ins) that PowerShell can run directly. */
export const NATIVE_TOOLS = [
  'ipconfig', 'ping', 'tracert', 'nslookup', 'netstat', 'route', 'tasklist', 'taskkill', 'sfc', 'dism', 'gpupdate',
  'gpresult', 'net', 'whoami', 'hostname', 'systeminfo', 'chkdsk', 'findstr', 'more', 'bootrec',
];

// ---------------------------------------------------------------- CMD

/** Usage text for `<command> /?`, or null when the line is not asking for help. */
export function cmdSlashHelp(name: string, args: string[]): string | null {
  const lower = args.map(a => a.toLowerCase());
  let command = name;
  if (/\/\?$/.test(name) && name.length > 2) command = name.slice(0, -2);
  else if (!lower.includes('/?')) return null;
  const doc = cmdDoc(command);
  if (!doc) return null;
  const topic = lower.find(a => doc.topics?.[a]);
  return topic ? doc.topics![topic] : doc.usage;
}

function cmdHelp(ctx: WindowsContext): WindowsResult {
  const topic = ctx.args.find(a => a !== '/?');
  if (ctx.args.includes('/?') && !topic) return ctx.ok(cmdDoc('help')!.usage);
  if (!topic) {
    const names = CMD_DOCS.filter(d => d.inHelpList).flatMap(d => [d.name, ...(d.aliases ?? []).filter(a => !a.endsWith('.'))])
      .sort((a, b) => a.localeCompare(b));
    const rows = names.flatMap(n => {
      const text = wrap(cmdDoc(n)!.summary, 79, ' '.repeat(15));
      return [n.toUpperCase().padEnd(15) + text[0].trimStart(), ...text.slice(1)];
    });
    return ctx.ok([
      'For more information on a specific command, type HELP command-name',
      ...rows,
      '',
      'For more information on tools see the command-line reference in the online help.',
    ].join('\r\n'));
  }
  const doc = cmdDoc(topic);
  if (!doc || !doc.inHelpList) {
    return ctx.fail(`This command is not supported by the help utility.  Try "${topic} /?".`, 1);
  }
  return ctx.ok(doc.usage);
}

cmdCommands.register('help', cmdHelp);

/** `diskpart /?` typed at the CMD prompt. */
export const diskpartUsage = (): string => cmdDoc('diskpart')!.usage;

// ---------------------------------------------------------------- DiskPart

export const DISKPART_VERSION = 'Microsoft DiskPart version 10.0.22621.1';

/** DiskPart's command list: printed by HELP and for any command it does not know. */
export function diskpartCommandList(): string {
  return ['', DISKPART_VERSION, '', ...DISKPART_COMMANDS.map(([n, d]) => `${n.padEnd(12)}- ${d}`)].join('\n');
}

/** HELP [command] inside DiskPart, and `<command> /?`. Returns null for other lines. */
export function diskpartHelp(line: string): string | null {
  const words = line.trim().toLowerCase().split(/\s+/);
  if (words[0] === 'help') return (words[1] && DISKPART_TOPICS[words[1]]) || diskpartCommandList();
  if (words.includes('/?')) return DISKPART_TOPICS[words[0]] ?? diskpartCommandList();
  return null;
}

// ---------------------------------------------------------------- PowerShell: Get-Help

const indent = (text: string, n = 4) => wrap(text, 80, ' '.repeat(n));
const online = (d: PsDoc) => `https://learn.microsoft.com/powershell/module/${d.onlinePath}?view=powershell-5.1`;

function parameterBlock(p: PsParameter, full: boolean): string[] {
  const head = `    -${p.name}${p.type ? ` <${p.type}>` : ''}`;
  const lines = [head, ...indent(p.desc, 8)];
  if (full) {
    lines.push(
      '',
      `        Required?                    ${p.required ? 'true' : 'false'}`,
      `        Position?                    ${p.position ?? 'named'}`,
      `        Accept pipeline input?       ${p.pipeline ? `True (${p.pipeline === true ? 'ByValue' : p.pipeline})` : 'False'}`,
      `        Accept wildcard characters?  ${p.wildcards ? 'true' : 'false'}`,
    );
  }
  return [...lines, ''];
}

function exampleBlocks(d: PsDoc): string[] {
  return d.examples.flatMap((e, i) => {
    const title = ` Example ${i + 1}: ${e.title} `;
    const dashes = Math.max(2, Math.floor((70 - title.length) / 2));
    return [`    ${'-'.repeat(dashes)}${title}${'-'.repeat(dashes)}`, '', `    PS C:\\>${e.code}`, '', ...indent(e.desc), '', ''];
  });
}

function remarks(d: PsDoc): string[] {
  const n = d.name;
  return [
    'REMARKS',
    `    To see the examples, type: "get-help ${n} -examples".`,
    `    For more information, type: "get-help ${n} -detailed".`,
    `    For technical information, type: "get-help ${n} -full".`,
    ...(d.onlinePath ? [`    For online help, type: "get-help ${n} -online"`] : []),
  ];
}

export function renderGetHelp(d: PsDoc, view: 'default' | 'examples' | 'detailed' | 'full' = 'default'): string {
  const lines = ['', 'NAME', `    ${d.name}`, '', 'SYNOPSIS', ...indent(d.synopsis), ''];
  if (view === 'examples') {
    lines.push('', ...exampleBlocks(d));
    return lines.join('\n').trimEnd();
  }
  lines.push('', 'SYNTAX', ...d.syntax.flatMap(s => [...indent(s), '']), '', 'DESCRIPTION', ...d.description.flatMap(p => [...indent(p), '']), '');
  if (view === 'detailed' || view === 'full') {
    lines.push('PARAMETERS', ...d.parameters.flatMap(p => parameterBlock(p, view === 'full')),
      '    <CommonParameters>', ...indent('This cmdlet supports the common parameters: Verbose, Debug, ErrorAction, ErrorVariable, WarningAction, WarningVariable, OutBuffer, PipelineVariable, and OutVariable.', 8), '', '');
    lines.push(...exampleBlocks(d));
  }
  lines.push('RELATED LINKS', ...(d.onlinePath ? [`    Online Version: ${online(d)}`] : []), ...d.related.map(r => `    ${r}`), '');
  lines.push(...remarks(d));
  return lines.join('\n');
}

const ABOUT_HELP = [
  '',
  'TOPIC',
  '    Windows PowerShell Help System',
  '',
  'SHORT DESCRIPTION',
  '    Displays help about Windows PowerShell cmdlets and concepts.',
  '',
  'LONG DESCRIPTION',
  ...indent('Get-Help shows the help for any cmdlet, function or alias, and for the about_ concept topics. Every command follows the same Verb-Noun naming, so Get-Command is the way to find a command and Get-Help the way to learn how to use it.'),
  '',
  ...indent('Windows PowerShell ships without full help files; Update-Help downloads them, and -Online opens the web version of a topic.'),
  '',
  '  GET-HELP',
  '      Get-Help <command>              Name, synopsis, syntax and description',
  '      Get-Help <command> -Examples    Only the examples',
  '      Get-Help <command> -Detailed    Adds parameter descriptions and examples',
  '      Get-Help <command> -Full        Everything, with parameter attributes',
  '      Get-Help <command> -Parameter N Help for one parameter',
  '      Get-Help *service*              Topics whose names match the pattern',
  '      <command> -?                    Same as Get-Help <command>',
  '',
  '  GET-COMMAND',
  '      Get-Command *service*           Commands whose names match',
  '      Get-Command -Noun Process       Commands that work on processes',
  '      Get-Command -Verb Get           Commands that read something',
  '',
  ...indent('help is a function that runs Get-Help one page at a time, and man is an alias of help.'),
].join('\n');

function helpTopicTable(docs: PsDoc[]): string {
  const rows = docs.map(d => `${d.name.padEnd(34)}${d.commandType.padEnd(10)}${(d.module || '').padEnd(32)}${d.synopsis}`);
  return ['', `${'Name'.padEnd(34)}${'Category'.padEnd(10)}${'Module'.padEnd(32)}Synopsis`, `${'----'.padEnd(34)}${'--------'.padEnd(10)}${'------'.padEnd(32)}--------`, ...rows].join('\n');
}

function getHelp(ctx: WindowsContext): WindowsResult {
  const p = bindParams(ctx.args, {
    Name: 'value', Examples: 'switch', Detailed: 'switch', Full: 'switch', Parameter: 'value', Online: 'switch',
    Category: 'value', ShowWindow: 'switch',
  });
  if (typeof p === 'string') return ctx.fail(badParameter(ctx.raw, 'Get-Help', p));
  const name = (p.named.get('Name') as string | undefined) ?? p.positional[0];
  if (!name) return ctx.ok(ABOUT_HELP);

  if (/[*?]/.test(name)) {
    const re = globToRegex(name, true);
    const matches = PS_DOCS.filter(d => re.test(d.name) || d.aliases.some(a => re.test(a)));
    if (matches.length === 1) return ctx.ok(renderGetHelp(matches[0]));
    if (matches.length) return ctx.ok(helpTopicTable(matches));
  }
  const found = psDoc(name);
  // Functions such as mkdir and help show the help of the command they run
  const doc = found?.forwardHelpTo ? psDoc(found.forwardHelpTo) : found;
  if (!doc) {
    return ctx.fail(psError(ctx.raw, 'Get-Help', `Get-Help could not find ${name} in a help file in this session. To download updated help topics type: "Update-Help". To get help online, search for the help topic in the TechNet library at https:/go.microsoft.com/fwlink/?LinkID=107116.`,
      'ResourceUnavailable', name, 'HelpNotFoundException', 'HelpNotFound'));
  }
  if (p.named.has('Online')) {
    return ctx.ok(`(The simulator cannot open a browser. The online version of this topic is ${online(doc)})`);
  }
  const paramName = p.named.get('Parameter') as string | undefined;
  if (paramName) {
    const re = globToRegex(paramName, true);
    const params = doc.parameters.filter(x => re.test(x.name));
    if (!params.length) {
      return ctx.fail(psError(ctx.raw, 'Get-Help', `No parameter matches criteria ${paramName}.`, 'InvalidArgument', paramName, 'ArgumentException', 'NoParmsFound'));
    }
    return ctx.ok(['', ...params.flatMap(x => parameterBlock(x, true))].join('\n').trimEnd());
  }
  const view = p.named.has('Examples') ? 'examples' : p.named.has('Full') ? 'full' : p.named.has('Detailed') ? 'detailed' : 'default';
  return ctx.ok(renderGetHelp(doc, view));
}

// ---------------------------------------------------------------- PowerShell: Get-Command

interface CommandRow { type: 'Alias' | 'Function' | 'Cmdlet' | 'Application'; name: string; shown: string; version: string; source: string; verb?: string; noun?: string; module: string }

function commandRows(): CommandRow[] {
  const rows: CommandRow[] = [];
  for (const d of PS_DOCS) {
    const [verb, noun] = d.name.includes('-') ? d.name.split('-') : [undefined, undefined];
    rows.push({ type: d.commandType, name: d.name, shown: d.name, version: d.version, source: d.module, verb, noun, module: d.module });
    for (const a of d.aliases) rows.push({ type: 'Alias', name: a, shown: `${a} -> ${d.name}`, version: d.version, source: d.module, module: d.module });
  }
  for (const t of NATIVE_TOOLS) {
    rows.push({ type: 'Application', name: `${t}.exe`, shown: `${t}.exe`, version: '10.0.22621.1', source: `C:\\Windows\\system32\\${t}.exe`, module: '' });
  }
  return rows;
}

const TYPE_ORDER = ['Alias', 'Function', 'Cmdlet', 'Application'];

function commandTable(rows: CommandRow[]): string {
  const version = (v: string) => (v.length > 10 ? `${v.slice(0, 7)}...` : v);
  return [
    '',
    `${'CommandType'.padEnd(16)}${'Name'.padEnd(51)}${'Version'.padEnd(11)}Source`,
    `${'-----------'.padEnd(16)}${'----'.padEnd(51)}${'-------'.padEnd(11)}------`,
    ...rows.map(r => `${r.type.padEnd(16)}${r.shown.padEnd(51)}${version(r.version).padEnd(11)}${r.source}`.trimEnd()),
  ].join('\n');
}

function getCommand(ctx: WindowsContext): WindowsResult {
  const p = bindParams(ctx.args, { Name: 'value', Verb: 'value', Noun: 'value', CommandType: 'value', Module: 'value', Syntax: 'switch', All: 'switch' });
  if (typeof p === 'string') return ctx.fail(badParameter(ctx.raw, 'Get-Command', p));
  const list = (v: string | true | undefined) => (typeof v === 'string' ? v.split(',').map(s => s.trim()).filter(Boolean) : []);
  const names = [...list(p.named.get('Name')), ...p.positional.flatMap(x => list(x))];
  const verbs = list(p.named.get('Verb'));
  const nouns = list(p.named.get('Noun'));
  const types = list(p.named.get('CommandType')).map(t => t.toLowerCase());
  const modules = list(p.named.get('Module'));

  let rows = commandRows();
  if (!names.length) rows = rows.filter(r => r.type !== 'Application');
  if (verbs.length || nouns.length) {
    rows = rows.filter(r => (r.type === 'Cmdlet' || r.type === 'Function') && r.verb
      && (!verbs.length || verbs.some(v => globToRegex(v, true).test(r.verb!)))
      && (!nouns.length || nouns.some(n => globToRegex(n, true).test(r.noun ?? ''))));
  }
  if (types.length && !types.includes('all')) rows = rows.filter(r => types.includes(r.type.toLowerCase()));
  if (modules.length) rows = rows.filter(r => modules.some(m => globToRegex(m, true).test(r.module)));

  const errors: string[] = [];
  if (names.length) {
    const picked: CommandRow[] = [];
    for (const n of names) {
      const re = globToRegex(n, true);
      const hits = rows.filter(r => re.test(r.name) || (r.type === 'Application' && re.test(r.name.replace(/\.exe$/, ''))));
      if (!hits.length && !/[*?]/.test(n)) {
        errors.push(psError(ctx.raw, 'Get-Command', `The term '${n}' is not recognized as the name of a cmdlet, function, script file, or operable program. Check the spelling of the name, or if a path was included, verify that the path is correct and try again.`,
          'ObjectNotFound', n, 'CommandNotFoundException', 'CommandNotFoundException'));
      }
      picked.push(...hits.filter(h => !picked.includes(h)));
    }
    rows = picked;
  }
  rows.sort((a, b) => TYPE_ORDER.indexOf(a.type) - TYPE_ORDER.indexOf(b.type) || a.name.localeCompare(b.name));

  if (p.named.has('Syntax')) {
    const out = rows.map(r => {
      const d = psDoc(r.name);
      if (r.type === 'Alias') return r.shown;
      return d ? d.syntax.join('\n\n') : r.source;
    });
    return ctx.result(out.join('\n\n'), errors.join('\n'), errors.length ? 1 : 0);
  }
  return ctx.result(rows.length ? commandTable(rows) : '', errors.join('\n'), errors.length ? 1 : 0);
}

psCommands.register(['Get-Help', 'help'], getHelp);
psCommands.register('Get-Command', getCommand);

/**
 * Registers the aliases the docs list (help, man, gcm, sasv ...) that no module registered.
 * Called by the engine once every cmdlet module has loaded.
 */
export function registerDocAliases(): void {
  for (const d of PS_DOCS) {
    const handler = psCommands.get(d.name);
    if (!handler) continue;
    for (const a of d.aliases) if (!psCommands.has(a)) psCommands.register(a, handler);
  }
}

/** `<cmdlet> -?`: the cmdlet's help instead of running it. Returns null otherwise. */
export function psDashQuestion(ctx: WindowsContext, name: string, args: string[]): WindowsResult | null {
  if (!args.includes('-?')) return null;
  const found = psDoc(name);
  const doc = found?.forwardHelpTo ? psDoc(found.forwardHelpTo) : found;
  return doc ? ctx.ok(renderGetHelp(doc)) : null;
}
