// Shared helpers for PowerShell cmdlets: parameter binding and Windows PowerShell 5.1 error blocks.

export interface PsParams {
  named: Map<string, string | true>;
  positional: string[];
}

/**
 * Binds -Name value / -Switch parameters. `spec` maps canonical names to 'value' or 'switch';
 * like PowerShell, a unique prefix (-Rec for -Recurse) and any letter case are accepted.
 * `aliases` maps extra names (e.g. Head -> TotalCount).
 */
export function bindParams(args: string[], spec: Record<string, 'value' | 'switch'>, aliases: Record<string, string> = {}): PsParams | string {
  const named = new Map<string, string | true>();
  const positional: string[] = [];
  const names = [...Object.keys(spec), ...Object.keys(aliases)];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    const m = a.match(/^-([A-Za-z][\w]*)(?::(.*))?$/);
    if (!m) { positional.push(a); continue; }
    const typed = m[1].toLowerCase();
    const exact = names.find(n => n.toLowerCase() === typed);
    const candidates = exact ? [exact] : names.filter(n => n.toLowerCase().startsWith(typed));
    if (candidates.length !== 1) return m[1];
    const canonical = aliases[candidates[0]] ?? candidates[0];
    if (spec[canonical] === 'switch') {
      if (!/^\$?false$/i.test(m[2] ?? '')) named.set(canonical, true);
    }
    else named.set(canonical, m[2] ?? args[++i] ?? '');
  }
  return { named, positional };
}

/** The red error block Windows PowerShell 5.1 prints for a terminating error. */
export function psError(
  line: string,
  cmdlet: string,
  message: string,
  category: string,
  target: string,
  exception: string,
  errorId: string
): string {
  const statement = line.trim();
  return [
    `${cmdlet ? `${cmdlet} : ` : ''}${message}`,
    'At line:1 char:1',
    `+ ${statement}`,
    `+ ${'~'.repeat(Math.max(1, statement.length))}`,
    `    + CategoryInfo          : ${category}: (${target}:String) [${cmdlet}], ${exception}`,
    `    + FullyQualifiedErrorId : ${errorId}${cmdlet ? `,Microsoft.PowerShell.Commands.${cmdlet.replace('-', '')}Command` : ''}`,
  ].join('\n');
}

/** "The term 'x' is not recognized ..." for an unknown command. */
export function psNotRecognized(line: string, name: string): string {
  const statement = line.trim();
  return [
    `${name} : The term '${name}' is not recognized as the name of a cmdlet, function, script file, or operable program. Check the spelling of the name, or if a path was included, verify that the path is correct and try again.`,
    'At line:1 char:1',
    `+ ${statement}`,
    `+ ${'~'.repeat(name.length)}`,
    `    + CategoryInfo          : ObjectNotFound: (${name}:String) [], CommandNotFoundException`,
    '    + FullyQualifiedErrorId : CommandNotFoundException',
  ].join('\n');
}

export const pathNotFound = (line: string, cmdlet: string, path: string) =>
  psError(line, cmdlet, `Cannot find path '${path}' because it does not exist.`, 'ObjectNotFound', path, 'ItemNotFoundException', 'PathNotFound');

export const accessDenied = (line: string, cmdlet: string, path: string) =>
  psError(line, cmdlet, `Access to the path '${path}' is denied.`, 'PermissionDenied', path, 'UnauthorizedAccessException', 'ItemExistsUnauthorizedAccessError');

export const badParameter = (line: string, cmdlet: string, name: string) =>
  psError(line, cmdlet, `A parameter cannot be found that matches parameter name '${name}'.`, 'InvalidArgument', '', 'ParameterBindingException', 'NamedParameterNotFound');

/** The ActiveDirectory module's "Cannot find an object with identity" error. */
export function adNotFound(line: string, cmdlet: string, identity: string): string {
  const statement = line.trim();
  return [
    `${cmdlet} : Cannot find an object with identity: '${identity}' under: 'DC=corp,DC=local'.`,
    'At line:1 char:1',
    `+ ${statement}`,
    `+ ${'~'.repeat(Math.max(1, statement.length))}`,
    `    + CategoryInfo          : ObjectNotFound: (${identity}:ADUser) [${cmdlet}], ADIdentityNotFoundException`,
    `    + FullyQualifiedErrorId : ActiveDirectoryCmdlet:Microsoft.ActiveDirectory.Management.ADIdentityNotFoundException,Microsoft.ActiveDirectory.Management.Commands.${cmdlet.replace('-', '')}`,
  ].join('\n');
}

/** A non-cmdlet-specific message for commands that are real but not modelled here. */
export const psNotSimulated = (name: string) =>
  `${name} : '${name}' exists on real Windows but is not simulated here.`;

// ---------------------------------------------------------------- PowerShell tokens and binding

/** One argument as PowerShell parses it: quotes removed, (...) and {...} kept whole. */
export interface PsToken {
  text: string;
  /** Written in quotes, so it is a value even if it starts with '-'. */
  quoted: boolean;
  /** A (subexpression) or {script block}, kept verbatim with its brackets. */
  group?: '(' | '{';
}

const BACKTICK: Record<string, string> = { n: '\n', t: '\t' };

/**
 * Splits a PowerShell stage into tokens. Quotes group words ('...' literal, "..." with backtick
 * escapes), parentheses and braces are kept as one token, and a comma list written with spaces
 * (a, b) is joined into one token.
 */
export function psTokenize(input: string): PsToken[] {
  const tokens: PsToken[] = [];
  let cur = '';
  let started = false;
  let quoted = false;
  let group: PsToken['group'];
  const push = () => {
    if (started) tokens.push(group ? { text: cur, quoted, group } : { text: cur, quoted });
    cur = '';
    started = false;
    quoted = false;
    group = undefined;
  };
  for (let i = 0; i < input.length; i++) {
    const ch = input[i];
    if (/\s/.test(ch)) { push(); continue; }
    if (ch === '`' && i + 1 < input.length) {
      const next = input[++i];
      cur += BACKTICK[next] ?? next;
      started = true;
      continue;
    }
    if (ch === "'" || ch === '"') {
      let j = i + 1;
      let text = '';
      while (j < input.length && input[j] !== ch) {
        if (ch === '"' && input[j] === '`' && j + 1 < input.length) {
          const next = input[++j];
          text += BACKTICK[next] ?? next;
        } else {
          text += input[j];
        }
        j++;
      }
      cur += text;
      started = true;
      quoted = true;
      i = j;
      continue;
    }
    if ((ch === '(' || ch === '{') && !started) {
      const close = ch === '(' ? ')' : '}';
      let depth = 0;
      let j = i;
      let q: string | null = null;
      for (; j < input.length; j++) {
        const c = input[j];
        if (q) { if (c === q) q = null; continue; }
        if (c === '"' || c === "'") { q = c; continue; }
        if (c === ch) depth++;
        else if (c === close && --depth === 0) break;
      }
      cur = input.slice(i, j + 1);
      started = true;
      group = ch;
      push();
      i = j;
      continue;
    }
    cur += ch;
    started = true;
  }
  push();
  // "a, b" and "a ,b" are one comma-separated list
  const merged: PsToken[] = [];
  for (const t of tokens) {
    const prev = merged[merged.length - 1];
    if (prev && !prev.group && !t.group && (prev.text.endsWith(',') || t.text.startsWith(','))) {
      merged[merged.length - 1] = { text: prev.text + t.text, quoted: prev.quoted || t.quoted };
    } else {
      merged.push(t);
    }
  }
  return merged;
}

/** Splits a PowerShell line on | outside quotes, parentheses and braces. */
export function psSplitPipeline(line: string): string[] {
  const stages: string[] = [];
  let depth = 0;
  let q: string | null = null;
  let start = 0;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '`') { i++; continue; }
    if (q) { if (c === q) q = null; continue; }
    if (c === '"' || c === "'") { q = c; continue; }
    if (c === '(' || c === '{') depth++;
    else if ((c === ')' || c === '}') && depth > 0) depth--;
    else if (c === '|' && depth === 0) {
      stages.push(line.slice(start, i).trim());
      start = i + 1;
    }
  }
  stages.push(line.slice(start).trim());
  return stages.filter(Boolean);
}

export interface PsStage { name: string; args: string[]; tokens: PsToken[]; raw: string }

export function psStage(text: string): PsStage {
  const tokens = psTokenize(text);
  return { name: tokens[0]?.text ?? '', args: tokens.slice(1).map(t => t.text), tokens: tokens.slice(1), raw: text.trim() };
}

export type PsParamKind = 'value' | 'switch' | 'list';
export interface PsParamSpec { kind: PsParamKind; position?: number }
export interface PsBound {
  /** Values by canonical name: a string, a list for 'list' parameters, or true for a switch. */
  named: Map<string, string | string[] | true>;
  str: (name: string) => string | undefined;
  list: (name: string) => string[] | undefined;
  has: (name: string) => boolean;
}

const splitList = (v: string) => v.split(',').map(x => x.trim()).filter(Boolean);

/**
 * The PowerShell parameter binder: named parameters (any case, unique prefix, -Name:value),
 * then positional arguments in order of `position`, quoted values taken literally and comma
 * lists split for 'list' parameters. Returns an error block when binding fails.
 */
export function bindCmdlet(
  raw: string,
  cmdlet: string,
  tokens: PsToken[],
  spec: Record<string, PsParamSpec>,
  aliases: Record<string, string> = {}
): PsBound | string {
  const named = new Map<string, string | string[] | true>();
  const loose: PsToken[] = [];
  const names = [...Object.keys(spec), ...Object.keys(aliases)];
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    const m = !t.quoted && !t.group ? t.text.match(/^-([A-Za-z][\w]*)(?::(.*))?$/) : null;
    if (!m) { loose.push(t); continue; }
    const typed = m[1].toLowerCase();
    const exact = names.find(n => n.toLowerCase() === typed);
    const candidates = exact ? [exact] : names.filter(n => n.toLowerCase().startsWith(typed));
    if (candidates.length > 1) {
      return psError(raw, cmdlet, `Parameter cannot be processed because the parameter name '${m[1]}' is ambiguous. Possible matches include: ${candidates.map(c => `-${c}`).join(' ')}.`,
        'InvalidArgument', '', 'ParameterBindingException', 'AmbiguousParameter');
    }
    if (candidates.length === 0) return badParameter(raw, cmdlet, m[1]);
    const canonical = aliases[candidates[0]] ?? candidates[0];
    const kind = spec[canonical].kind;
    if (kind === 'switch') {
      if (!/^\$?false$/i.test(m[2] ?? '')) named.set(canonical, true);
      continue;
    }
    let value = m[2];
    if (value === undefined) {
      const next = tokens[i + 1];
      if (!next || (!next.quoted && !next.group && /^-[A-Za-z]/.test(next.text))) {
        return psError(raw, cmdlet, `Missing an argument for parameter '${canonical}'. Specify a parameter of type '${kind === 'list' ? 'System.String[]' : 'System.String'}' and try again.`,
          'InvalidArgument', '', 'ParameterBindingException', 'MissingArgument');
      }
      value = next.text;
      i++;
    }
    named.set(canonical, kind === 'list' ? splitList(value) : value);
  }
  const positional = Object.entries(spec).filter(([, s]) => s.position !== undefined).sort((a, b) => a[1].position! - b[1].position!);
  for (const t of loose) {
    const slot = positional.find(([n]) => !named.has(n));
    if (!slot) {
      return psError(raw, cmdlet, `A positional parameter cannot be found that accepts argument '${t.text}'.`, 'InvalidArgument', '', 'ParameterBindingException', 'PositionalParameterNotFound');
    }
    named.set(slot[0], slot[1].kind === 'list' ? splitList(t.text) : t.text);
  }
  return {
    named,
    str: n => { const v = named.get(n); return typeof v === 'string' ? v : Array.isArray(v) ? v.join(',') : undefined; },
    list: n => { const v = named.get(n); return Array.isArray(v) ? v : typeof v === 'string' ? splitList(v) : undefined; },
    has: n => named.has(n),
  };
}

/** Parses a [bool] argument: $true/$false/1/0. Returns null for anything else. */
export function psBool(v: string): boolean | null {
  if (/^(\$true|1)$/i.test(v)) return true;
  if (/^(\$false|0)$/i.test(v)) return false;
  return null;
}
