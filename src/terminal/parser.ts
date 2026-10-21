/**
 * Command line tokenization, quote-aware chaining, pipelines, and redirects
 */

export type StderrRedirect = { type: '>' | '>>'; target: string } | { type: 'merge' };

/**
 * Quoting rules differ per shell:
 * - bash: '...' is literal, "..." keeps backslashes except before $ ` " \ and newline,
 *   and an unquoted backslash escapes any character.
 * - cmd: only "..." groups; ^ escapes; backslashes and single quotes are ordinary characters.
 * - powershell: '...' and "..." group; the backtick escapes; backslashes are ordinary.
 */
export type ShellSyntax = 'bash' | 'cmd' | 'powershell';

export interface ParsedCommand {
  raw: string;
  name: string;
  args: string[];
  /** For bash: the glob pattern of each arg that has unquoted wildcards (undefined otherwise), aligned with args */
  argGlobs?: (string | undefined)[];
  redirect?: {
    type: '>' | '>>';
    target: string;
  };
  stderrRedirect?: StderrRedirect;
}

export interface ChainedStage {
  commandLine: string;
  nextOp?: '&&' | '||' | ';';
}

const ESCAPE: Record<ShellSyntax, string> = { bash: '\\', cmd: '^', powershell: '`' };

/**
 * For each character, whether it is "active" syntax: outside any quotes, not escaped, and
 * not itself a quote or escape character. Operators (|, &, ;, >) only count when active.
 */
function activeMask(input: string, syntax: ShellSyntax): boolean[] {
  const mask = new Array<boolean>(input.length).fill(false);
  const esc = ESCAPE[syntax];
  let inDouble = false;
  let inSingle = false;
  for (let i = 0; i < input.length; i++) {
    const ch = input[i];
    if (ch === esc && !inSingle && (syntax !== 'bash' || !inDouble || i + 1 < input.length)) {
      i++; // the escaped character is never syntax
      continue;
    }
    if (ch === '"' && !inSingle) { inDouble = !inDouble; continue; }
    if (ch === "'" && !inDouble && syntax !== 'cmd') { inSingle = !inSingle; continue; }
    if (!inDouble && !inSingle) mask[i] = true;
  }
  return mask;
}

/**
 * Tokenizes a single command string into an array of arguments handling quotes and escapes
 */
export function tokenizeArgs(input: string, syntax: ShellSyntax = 'bash'): string[] {
  return tokenizeWords(input, syntax).map(w => w.text);
}

/**
 * A word after quote removal, plus what bash needs for pathname expansion: `globPattern` is set when the
 * word has an unquoted *, ? or [, with any quoted wildcard characters made literal (as [*], [?], [[]).
 */
export interface ShellWord {
  text: string;
  globPattern?: string;
}

export function tokenizeWords(input: string, syntax: ShellSyntax = 'bash'): ShellWord[] {
  const tokens: ShellWord[] = [];
  const esc = ESCAPE[syntax];
  let current = '';
  let pattern = '';
  let hasGlob = false;
  let started = false;
  const push = () => {
    tokens.push(hasGlob ? { text: current, globPattern: pattern } : { text: current });
    current = '';
    pattern = '';
    hasGlob = false;
  };
  // Literal text as it goes into a glob pattern: wildcard characters are bracketed so they match themselves
  const literal = (text: string) => text.replace(/[*?[]/g, c => `[${c}]`);
  let inDouble = false;
  let inSingle = false;

  for (let i = 0; i < input.length; i++) {
    const ch = input[i];

    if (ch === esc && !inSingle && i + 1 < input.length) {
      const next = input[i + 1];
      if (syntax === 'bash' && inDouble && !'$`"\\\n'.includes(next)) {
        current += ch; // inside "...", bash keeps backslashes that escape nothing
        pattern += literal(ch);
      } else {
        const out = syntax === 'powershell' ? ({ n: '\n', t: '\t' } as Record<string, string>)[next] ?? next : next;
        current += out;
        pattern += literal(out);
        i++;
      }
      started = true;
      continue;
    }
    if (ch === '"' && !inSingle) { inDouble = !inDouble; started = true; continue; }
    if (ch === "'" && !inDouble && syntax !== 'cmd') { inSingle = !inSingle; started = true; continue; }

    if (/\s/.test(ch) && !inDouble && !inSingle) {
      if (started) {
        push();
        started = false;
      }
    } else {
      current += ch;
      if (!inDouble && !inSingle && syntax === 'bash' && '*?['.includes(ch)) {
        pattern += ch;
        hasGlob = true;
      } else {
        pattern += literal(ch);
      }
      started = true;
    }
  }
  if (started) push();
  return tokens;
}

/**
 * Extracts stderr redirect (2>, 2>>, 2>&1) outside quotes
 */
export function extractStderrRedirect(cmd: string, syntax: ShellSyntax = 'bash'): { body: string; stderr?: StderrRedirect } {
  const mask = activeMask(cmd, syntax);
  for (let i = 0; i < cmd.length; i++) {
    if (!mask[i] || cmd[i] !== '2' || cmd[i + 1] !== '>' || (i > 0 && !/\s/.test(cmd[i - 1]))) continue;
    const m = cmd.slice(i).match(/^2>(>?)\s*(&1|[^\s|&;]+)/);
    if (!m) continue;
    const body = (cmd.slice(0, i) + cmd.slice(i + m[0].length)).trim();
    const stderr: StderrRedirect = m[2] === '&1'
      ? { type: 'merge' }
      : { type: m[1] ? '>>' : '>', target: m[2] };
    return { body, stderr };
  }
  return { body: cmd };
}

/**
 * Splits a command line into chained stages separated by &&, ||, or ;
 * strictly ignoring operators inside quotes.
 * In cmd, a single & is the sequence operator and ; is literal text.
 */
export function splitChainedCommandLine(input: string, shell: ShellSyntax = 'bash'): ChainedStage[] {
  const mask = activeMask(input, shell);
  const stages: ChainedStage[] = [];
  let start = 0;
  const cut = (end: number, op: ChainedStage['nextOp'], skip: number) => {
    stages.push({ commandLine: input.slice(start, end).trim(), nextOp: op });
    start = end + skip;
  };

  for (let i = 0; i < input.length; i++) {
    if (!mask[i]) continue;
    const ch = input[i];
    if (ch === '&' && input[i + 1] === '&' && mask[i + 1]) { cut(i, '&&', 2); i++; continue; }
    if (ch === '|' && input[i + 1] === '|' && mask[i + 1]) { cut(i, '||', 2); i++; continue; }
    if (shell === 'cmd' && ch === '&' && input[i - 1] !== '>') { cut(i, ';', 1); continue; }
    if (shell !== 'cmd' && ch === ';') { cut(i, ';', 1); continue; }
  }
  const rest = input.slice(start).trim();
  if (rest.length > 0 || stages.length > 0) stages.push({ commandLine: rest });
  return stages.filter(s => s.commandLine.length > 0);
}

/**
 * Parses a single command stage, extracting stderr and stdout redirects if present outside quotes
 */
export function parseSingleCommand(cmdStr: string, syntax: ShellSyntax = 'bash'): ParsedCommand {
  const extracted = extractStderrRedirect(cmdStr, syntax);
  const trimmed = extracted.body.trim();
  const mask = activeMask(trimmed, syntax);
  const redirectIndex = trimmed.split('').findIndex((ch, i) => ch === '>' && mask[i]);

  let body = trimmed;
  let redirect: ParsedCommand['redirect'];
  let leftoverArgs: string[] = [];

  if (redirectIndex !== -1) {
    const type: '>' | '>>' = trimmed[redirectIndex + 1] === '>' ? '>>' : '>';
    // "1>" and "1>>" are the same as ">" and ">>"
    let cutPos = redirectIndex;
    if (cutPos > 0 && trimmed[cutPos - 1] === '1' && (cutPos === 1 || /\s/.test(trimmed[cutPos - 2]))) cutPos--;
    body = trimmed.slice(0, cutPos).trim();
    const targetTokens = tokenizeArgs(trimmed.slice(redirectIndex + type.length).trim(), syntax);
    if (targetTokens.length > 0) {
      redirect = { type, target: targetTokens[0] };
      leftoverArgs = targetTokens.slice(1);
    }
  }

  const words = tokenizeWords(body, syntax);
  const argWords = words.slice(1);
  return {
    raw: cmdStr.trim(),
    name: words[0]?.text ?? '',
    args: [...argWords.map(w => w.text), ...leftoverArgs],
    argGlobs: argWords.some(w => w.globPattern) ? argWords.map(w => w.globPattern) : undefined,
    redirect,
    stderrRedirect: extracted.stderr,
  };
}

/**
 * Parses a piped line (e.g. "cat /var/log/syslog | grep error | wc -l")
 * ignoring pipes that are inside quotes or double pipes (||)
 */
export function parsePipelinedLine(line: string, syntax: ShellSyntax = 'bash'): ParsedCommand[] {
  const mask = activeMask(line, syntax);
  const stages: string[] = [];
  let start = 0;
  for (let i = 0; i < line.length; i++) {
    if (!mask[i] || line[i] !== '|') continue;
    if (line[i + 1] === '|') { i++; continue; }
    stages.push(line.slice(start, i));
    start = i + 1;
  }
  const rest = line.slice(start);
  if (rest.trim().length > 0) stages.push(rest);
  return stages.map(stage => parseSingleCommand(stage, syntax));
}
