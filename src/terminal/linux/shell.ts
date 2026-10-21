// Bash command-line syntax: lexing into words, operators and redirections, and per-word expansion
// (tilde, parameters, command substitution, arithmetic, field splitting, pathname-expansion patterns).
// parser.ts keeps the simpler tokenizer that CMD and PowerShell use; bash goes through this file.

import { ChainedStage } from '../parser';
import { MAX_ARITH_DEPTH } from '../limits';

/** One piece of a word, remembering whether it was quoted (quoted pieces are never split or globbed). */
export type WordPart =
  | { k: 'lit'; text: string; quoted: boolean }
  | { k: 'param'; name: string; op?: string; arg?: string; arg2?: string; raw?: string; quoted: boolean }
  | { k: 'cmd'; src: string; quoted: boolean }
  | { k: 'arith'; src: string; quoted: boolean }
  | { k: 'tilde'; user: string };

export interface Word {
  parts: WordPart[];
}

export type RedirOp = '<' | '<<<' | '>' | '>>' | '>&' | '&>' | '&>>';

export interface Redirection {
  /** File descriptor the redirection applies to (0 stdin, 1 stdout, 2 stderr). Unused by &> and &>>. */
  fd: number;
  op: RedirOp;
  /** File name (or here-string text) for every op except >& */
  target?: Word;
  /** For >&: the descriptor being copied (2>&1 has fd 2, dupFrom 1) */
  dupFrom?: number;
}

export interface BashCommand {
  words: Word[];
  redirs: Redirection[];
  /** Followed by |& : stderr also goes into the pipe */
  pipeStderr?: boolean;
}

type Op = '&&' | '||' | ';' | '|' | '|&';
type Token =
  | { t: 'word'; w: Word; start: number; end: number }
  | { t: 'op'; op: Op; start: number; end: number }
  | { t: 'redir'; r: Redirection; start: number; end: number };

const META = ' \t\n|&;<>()';
const isNameStart = (c: string | undefined) => !!c && /[A-Za-z_]/.test(c);
const isNameChar = (c: string | undefined) => !!c && /\w/.test(c);

/** Index just past the `)` that closes a `(` at `open` - 1, skipping quotes and escapes. */
function scanParens(s: string, i: number): number {
  let depth = 1;
  while (i < s.length) {
    const c = s[i];
    if (c === '\\') { i += 2; continue; }
    if (c === "'") { const j = s.indexOf("'", i + 1); i = j === -1 ? s.length : j + 1; continue; }
    if (c === '"') {
      i++;
      while (i < s.length && s[i] !== '"') i += s[i] === '\\' ? 2 : 1;
      i++;
      continue;
    }
    if (c === '(') depth++;
    if (c === ')' && --depth === 0) return i + 1;
    i++;
  }
  // Unterminated (checkBashSyntax reports it first); as if the ) followed the last character
  return s.length + 1;
}

/** Index just past the closing backtick of a backtick substitution starting after `i`. */
function scanBacktick(s: string, i: number): number {
  while (i < s.length && s[i] !== '`') i += s[i] === '\\' ? 2 : 1;
  return Math.min(i, s.length) + 1;
}

/** Index of the } that closes a ${ whose body starts at i (nested ${ }, $( ) and quotes skipped), or -1. */
function scanBrace(s: string, i: number): number {
  let depth = 1;
  while (i < s.length) {
    const c = s[i];
    if (c === '\\') { i += 2; continue; }
    if (c === "'") { const j = s.indexOf("'", i + 1); if (j === -1) return -1; i = j + 1; continue; }
    if (c === '"') {
      i++;
      while (i < s.length && s[i] !== '"') i += s[i] === '\\' ? 2 : 1;
      i++;
      continue;
    }
    if (c === '`') { i = scanBacktick(s, i + 1); continue; }
    if (c === '$' && s[i + 1] === '(') { i = scanParens(s, i + 2); continue; }
    if (c === '$' && s[i + 1] === '{') { depth++; i += 2; continue; }
    if (c === '}' && --depth === 0) return i;
    i++;
  }
  return -1;
}

/** Index of the first `sep` in s outside quotes, ${ }, $( ) and backslash escapes, or -1. */
function topLevelIndex(s: string, sep: string): number {
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === '\\') { i++; continue; }
    if (c === "'") { const j = s.indexOf("'", i + 1); if (j === -1) return -1; i = j; continue; }
    if (c === '$' && s[i + 1] === '{') { const j = scanBrace(s, i + 2); if (j === -1) return -1; i = j; continue; }
    if (c === '$' && s[i + 1] === '(') { i = scanParens(s, i + 2) - 1; continue; }
    if (c === sep) return i;
  }
  return -1;
}

const PARAM_NAME = /^([A-Za-z_]\w*|\d+|[?$#!@*-])/;

/**
 * Parses the inside of ${...}: a name and at most one operator. Anything bash would reject is
 * kept with op 'bad' and reported as "bad substitution" when the word is expanded.
 */
function parseParam(body: string, quoted: boolean): WordPart {
  const raw = `\${${body}}`;
  const bad: WordPart = { k: 'param', name: body, op: 'bad', raw, quoted };
  // ${#name}: length
  if (body.length > 1 && body[0] === '#') {
    const m = body.slice(1).match(/^([A-Za-z_]\w*|\d+|[?$#!@*-])$/);
    return m ? { k: 'param', name: m[1], op: 'len', raw, quoted } : bad;
  }
  // ${!name}: indirection
  if (body.length > 1 && body[0] === '!') {
    const m = body.slice(1).match(/^([A-Za-z_]\w*|\d+)$/);
    return m ? { k: 'param', name: m[1], op: 'ind', raw, quoted } : bad;
  }
  const m = body.match(PARAM_NAME);
  if (!m) return bad;
  const name = m[1];
  const rest = body.slice(name.length);
  if (rest === '') return { k: 'param', name, quoted };
  const part = (op: string, arg?: string, arg2?: string): WordPart => ({ k: 'param', name, op, arg, arg2, raw, quoted });
  const def = rest.match(/^(:?[-=+?])([\s\S]*)$/);
  if (def) return part(def[1], def[2]);
  if (rest[0] === ':') {
    const spec = rest.slice(1);
    const colon = topLevelIndex(spec, ':');
    return colon === -1 ? part('sub', spec) : part('sub', spec.slice(0, colon), spec.slice(colon + 1));
  }
  const trim = rest.match(/^(##|#|%%|%)([\s\S]*)$/);
  if (trim) return part(trim[1], trim[2]);
  const repl = rest.match(/^(\/\/|\/#|\/%|\/)([\s\S]*)$/);
  if (repl) {
    const slash = topLevelIndex(repl[2], '/');
    return slash === -1 ? part(repl[1], repl[2], '') : part(repl[1], repl[2].slice(0, slash), repl[2].slice(slash + 1));
  }
  const kase = rest.match(/^(\^\^|\^|,,|,)([\s\S]*)$/);
  if (kase) return part(kase[1], kase[2]);
  const tr = rest.match(/^@([ULuQ])$/);
  if (tr) return part('@' + tr[1]);
  return bad;
}

/** Inside backticks, \` \\ and \$ stand for the character itself. */
const unBacktick = (src: string) => src.replace(/\\([`\\$])/g, '$1');

/**
 * Reads a $-expansion at s[i] === '$'. Returns the part and the index after it,
 * or null when the $ is just a character (e.g. "$" at the end, "$ ", "$/").
 */
function readDollar(s: string, i: number, quoted: boolean): { part: WordPart; next: number } | null {
  const n = s[i + 1];
  if (n === '(' && s[i + 2] === '(') {
    // $(( expr )) - find the matching )) at depth zero
    let depth = 0;
    for (let j = i + 3; j < s.length; j++) {
      if (s[j] === '(') depth++;
      else if (s[j] === ')') {
        if (depth === 0 && s[j + 1] === ')') return { part: { k: 'arith', src: s.slice(i + 3, j), quoted }, next: j + 2 };
        depth--;
      }
    }
    // not arithmetic after all: a command substitution whose command starts with (
  }
  if (n === '(') {
    const end = scanParens(s, i + 2);
    return { part: { k: 'cmd', src: s.slice(i + 2, end - 1), quoted }, next: Math.min(end, s.length) };
  }
  if (n === '{') {
    const end = scanBrace(s, i + 2);
    const body = s.slice(i + 2, end === -1 ? s.length : end);
    const next = end === -1 ? s.length : end + 1;
    return { part: parseParam(body, quoted), next };
  }
  if (isNameStart(n)) {
    let j = i + 1;
    while (isNameChar(s[j])) j++;
    return { part: { k: 'param', name: s.slice(i + 1, j), quoted }, next: j };
  }
  if (n !== undefined && /[0-9?$#!@*-]/.test(n)) return { part: { k: 'param', name: n, quoted }, next: i + 2 };
  return null;
}

/** Splits a bash line into tokens. Unterminated quotes simply run to the end of the line. */
function lex(s: string): Token[] {
  const tokens: Token[] = [];
  let parts: WordPart[] = [];
  let started = false;
  let wordStart = 0;
  let pendingRedir: { r: Redirection; start: number } | null = null;

  const lit = (text: string, quoted: boolean) => {
    const last = parts[parts.length - 1];
    if (last && last.k === 'lit' && last.quoted === quoted) last.text += text;
    else parts.push({ k: 'lit', text, quoted });
  };
  const endWord = (end: number) => {
    if (!started) return;
    const w: Word = { parts };
    if (pendingRedir) {
      pendingRedir.r.target = w;
      tokens.push({ t: 'redir', r: pendingRedir.r, start: pendingRedir.start, end });
      pendingRedir = null;
    } else {
      tokens.push({ t: 'word', w, start: wordStart, end });
    }
    parts = [];
    started = false;
  };
  const begin = (i: number) => {
    if (!started) { started = true; wordStart = i; }
  };
  /** The word so far is a bare file-descriptor number (as in 2>). */
  const fdPrefix = (): number | null => {
    if (!started || parts.length !== 1) return null;
    const p = parts[0];
    return p.k === 'lit' && !p.quoted && /^\d$/.test(p.text) ? Number(p.text) : null;
  };

  let i = 0;
  while (i < s.length) {
    const c = s[i];
    if (c === ' ' || c === '\t' || c === '\n') { endWord(i); i++; continue; }
    if (c === '#' && !started) break; // a comment runs to the end of the line
    if (c === '<' || c === '>' || (c === '&' && s[i + 1] === '>')) {
      const fd = fdPrefix();
      const start = fd !== null ? wordStart : i;
      if (fd !== null) { parts = []; started = false; } else endWord(i);
      if (pendingRedir) { tokens.push({ t: 'redir', r: pendingRedir.r, start: pendingRedir.start, end: i }); pendingRedir = null; }
      let r: Redirection;
      if (c === '&') {
        const app = s[i + 2] === '>';
        r = { fd: 1, op: app ? '&>>' : '&>' };
        i += app ? 3 : 2;
      } else if (c === '<') {
        if (s.startsWith('<<<', i)) { r = { fd: fd ?? 0, op: '<<<' }; i += 3; }
        else { r = { fd: fd ?? 0, op: '<' }; i += 1; }
      } else if (s[i + 1] === '>') {
        r = { fd: fd ?? 1, op: '>>' };
        i += 2;
      } else if (s[i + 1] === '&' && /\d/.test(s[i + 2] ?? '')) {
        r = { fd: fd ?? 1, op: '>&', dupFrom: Number(s[i + 2]) };
        i += 3;
        tokens.push({ t: 'redir', r, start, end: i });
        continue;
      } else {
        r = { fd: fd ?? 1, op: '>' };
        i += s[i + 1] === '|' ? 2 : 1;
      }
      pendingRedir = { r, start };
      continue;
    }
    if (c === '|' || c === '&' || c === ';') {
      endWord(i);
      if (pendingRedir) { tokens.push({ t: 'redir', r: pendingRedir.r, start: pendingRedir.start, end: i }); pendingRedir = null; }
      let op: Op;
      let len = 1;
      if (c === '|' && s[i + 1] === '|') { op = '||'; len = 2; }
      else if (c === '|' && s[i + 1] === '&') { op = '|&'; len = 2; }
      else if (c === '|') op = '|';
      else if (c === '&' && s[i + 1] === '&') { op = '&&'; len = 2; }
      else op = ';'; // ; or a lone & (no job control here, so it just runs in order)
      tokens.push({ t: 'op', op, start: i, end: i + len });
      i += len;
      continue;
    }
    begin(i);
    if (c === '\\') {
      if (i + 1 < s.length) {
        if (s[i + 1] !== '\n') lit(s[i + 1], true);
        i += 2;
      } else { lit('\\', false); i++; }
      continue;
    }
    if (c === "'") {
      const j = s.indexOf("'", i + 1);
      const end = j === -1 ? s.length : j;
      lit(s.slice(i + 1, end), true);
      i = end + 1;
      continue;
    }
    if (c === '"') {
      lit('', true);
      i++;
      while (i < s.length && s[i] !== '"') {
        const d = s[i];
        if (d === '\\' && i + 1 < s.length) {
          const nx = s[i + 1];
          if ('$`"\\'.includes(nx)) lit(nx, true);
          else if (nx !== '\n') lit('\\' + nx, true);
          i += 2;
          continue;
        }
        if (d === '$') {
          const r = readDollar(s, i, true);
          if (r) { parts.push(r.part); i = r.next; continue; }
        }
        if (d === '`') {
          const end = scanBacktick(s, i + 1);
          parts.push({ k: 'cmd', src: unBacktick(s.slice(i + 1, end - 1)), quoted: true });
          i = end;
          continue;
        }
        lit(d, true);
        i++;
      }
      i++;
      continue;
    }
    if (c === '$') {
      const r = readDollar(s, i, false);
      if (r) { parts.push(r.part); i = r.next; continue; }
    }
    if (c === '`') {
      const end = scanBacktick(s, i + 1);
      parts.push({ k: 'cmd', src: unBacktick(s.slice(i + 1, end - 1)), quoted: false });
      i = end;
      continue;
    }
    if (c === '~' && parts.length === 0) {
      let j = i + 1;
      while (j < s.length && /[\w.-]/.test(s[j])) j++;
      if (j >= s.length || s[j] === '/' || META.includes(s[j])) {
        parts.push({ k: 'tilde', user: s.slice(i + 1, j) });
        i = j;
        continue;
      }
    }
    if (c === '(' || c === ')') {
      // Subshells and groups are not simulated; keep the character so the command sees it
      lit(c, false);
      i++;
      continue;
    }
    lit(c, false);
    i++;
  }
  endWord(s.length);
  if (pendingRedir) tokens.push({ t: 'redir', r: pendingRedir.r, start: pendingRedir.start, end: s.length });
  return tokens;
}

// ---------- syntax check ----------

const nearToken = (tok: string) => `bash: syntax error near unexpected token \`${tok}'`;
const eofLooking = (c: string) => `bash: unexpected EOF while looking for matching \`${c}'`;
const UNEXPECTED_EOF = 'bash: syntax error: unexpected end of file';

class SyntaxProblem extends Error {}

/**
 * Checks a bash line the way the parser does before anything runs: unterminated quotes and
 * substitutions, operators with no command on one side, and redirections with no target.
 * Returns bash's message (exit status 2), or null when the line parses. `closer` is set when
 * checking the inside of $( ... ), where the end of the text is that closing parenthesis.
 */
export function checkBashSyntax(line: string, closer?: string): string | null {
  try {
    scanSyntax(line, closer);
    return null;
  } catch (e) {
    if (e instanceof SyntaxProblem) return e.message;
    throw e;
  }
}

/** Index of the closing quote of a "..." starting at i (the opening quote); checks substitutions inside. */
function skipDouble(s: string, i: number): number {
  i++;
  while (i < s.length && s[i] !== '"') {
    if (s[i] === '\\') { i += 2; continue; }
    if (s[i] === '$' || s[i] === '`') { i = skipDollarOrTick(s, i); continue; }
    i++;
  }
  if (i >= s.length) throw new SyntaxProblem(eofLooking('"'));
  return i + 1;
}

/** At a $ or `: returns the index after the expansion, checking substitutions recursively. */
function skipDollarOrTick(s: string, i: number): number {
  if (s[i] === '`') {
    let j = i + 1;
    while (j < s.length && s[j] !== '`') j += s[j] === '\\' ? 2 : 1;
    if (j >= s.length) throw new SyntaxProblem(eofLooking('`'));
    scanSyntax(unBacktick(s.slice(i + 1, j)), '`');
    return j + 1;
  }
  const n = s[i + 1];
  if (n === '(') {
    if (s[i + 2] === '(') {
      // $(( ... )): find the matching )) the way readDollar does
      let depth = 0;
      for (let j = i + 3; j < s.length; j++) {
        if (s[j] === '(') depth++;
        else if (s[j] === ')') {
          if (depth === 0 && s[j + 1] === ')') return j + 2;
          depth--;
        }
      }
    }
    const end = scanParens(s, i + 2);
    if (end > s.length) throw new SyntaxProblem(eofLooking(')'));
    scanSyntax(s.slice(i + 2, end - 1), ')');
    return end;
  }
  if (n === '{') {
    let depth = 1;
    let j = i + 2;
    while (j < s.length) {
      const c = s[j];
      if (c === '\\') { j += 2; continue; }
      if (c === "'") { const k = s.indexOf("'", j + 1); if (k === -1) throw new SyntaxProblem(eofLooking("'")); j = k + 1; continue; }
      if (c === '"') { j = skipDouble(s, j); continue; }
      if (c === '$' && (s[j + 1] === '{' || s[j + 1] === '(')) {
        if (s[j + 1] === '{') { depth++; j += 2; continue; }
        j = skipDollarOrTick(s, j);
        continue;
      }
      if (c === '`') { j = skipDollarOrTick(s, j); continue; }
      if (c === '}' && --depth === 0) return j + 1;
      j++;
    }
    throw new SyntaxProblem(eofLooking('}'));
  }
  return i + 1;
}

function scanSyntax(s: string, closer?: string): void {
  // `start`: no command yet since the last operator; `redir`: a redirection still needs its target
  let start = true;
  let redir = false;
  let inWord = false;
  let parens = 0;
  const op = (tok: string) => {
    if (redir || start) throw new SyntaxProblem(nearToken(tok));
    start = true;
    inWord = false;
  };
  const word = () => {
    start = false;
    redir = false;
    inWord = true;
  };
  let i = 0;
  let last = '';
  while (i < s.length) {
    const c = s[i];
    if (c === ' ' || c === '\t' || c === '\n') { inWord = false; i++; continue; }
    if (c === '#' && !inWord) break;
    if (c === '|' || c === '&' || c === ';') {
      if (c === '&' && s[i + 1] === '>') {
        if (redir) throw new SyntaxProblem(nearToken(s[i + 2] === '>' ? '&>>' : '&>'));
        redir = true; inWord = false;
        i += s[i + 2] === '>' ? 3 : 2;
        continue;
      }
      const two = s.slice(i, i + 2);
      const tok = ['||', '|&', '&&', ';;'].includes(two) ? two : c;
      if (tok === ';;') throw new SyntaxProblem(nearToken(';;'));
      // ; and & may end a line; a command list cannot be empty before them
      op(tok);
      last = tok;
      i += tok.length;
      continue;
    }
    if (c === '<' || c === '>') {
      if (redir) throw new SyntaxProblem(nearToken(s.startsWith('<<<', i) ? '<<<' : s.startsWith('>>', i) ? '>>' : c));
      inWord = false;
      if (s.startsWith('<<<', i)) i += 3;
      else if (c === '>' && s[i + 1] === '&' && /\d/.test(s[i + 2] ?? '')) { i += 3; start = false; last = ''; continue; }
      else if (c === '>' && (s[i + 1] === '>' || s[i + 1] === '|')) i += 2;
      else i++;
      redir = true;
      start = false;
      last = '';
      continue;
    }
    if (c === '(') { parens++; word(); i++; last = ''; continue; }
    if (c === ')') {
      if (parens === 0) throw new SyntaxProblem(nearToken(')'));
      parens--; word(); i++; last = ''; continue;
    }
    word();
    last = '';
    if (c === '\\') { i += 2; continue; }
    if (c === "'") {
      const j = s.indexOf("'", i + 1);
      if (j === -1) throw new SyntaxProblem(eofLooking("'"));
      i = j + 1;
      continue;
    }
    if (c === '"') { i = skipDouble(s, i); continue; }
    if (c === '$' || c === '`') { i = skipDollarOrTick(s, i); continue; }
    i++;
  }
  if (redir) throw new SyntaxProblem(nearToken(closer ?? 'newline'));
  if (start && ['|', '||', '&&', '|&'].includes(last)) {
    throw new SyntaxProblem(closer ? nearToken(closer) : UNEXPECTED_EOF);
  }
}

/** Splits a line at &&, || and ; (outside quotes and substitutions), keeping each stage's text. */
export function splitBashChain(line: string): ChainedStage[] {
  const stages: ChainedStage[] = [];
  let start = 0;
  let commentAt = line.length;
  const tokens = lex(line);
  for (const tok of tokens) {
    if (tok.t !== 'op' || (tok.op !== '&&' && tok.op !== '||' && tok.op !== ';')) continue;
    stages.push({ commandLine: line.slice(start, tok.start).trim(), nextOp: tok.op });
    start = tok.end;
  }
  // Anything after the last token is a comment (or whitespace)
  const last = tokens[tokens.length - 1];
  commentAt = last ? Math.max(last.end, start) : start;
  const rest = line.slice(start, commentAt).trim();
  if (rest.length > 0 || stages.length > 0) stages.push({ commandLine: rest });
  return stages.filter(s => s.commandLine.length > 0);
}

/** Parses one chain stage (a pipeline) into commands. */
export function parseBashPipeline(line: string): BashCommand[] {
  const cmds: BashCommand[] = [];
  let cur: BashCommand = { words: [], redirs: [] };
  for (const tok of lex(line)) {
    if (tok.t === 'word') cur.words.push(tok.w);
    else if (tok.t === 'redir') cur.redirs.push(tok.r);
    else if (tok.op === '|' || tok.op === '|&') {
      if (tok.op === '|&') cur.pipeStderr = true;
      cmds.push(cur);
      cur = { words: [], redirs: [] };
    }
  }
  if (cur.words.length || cur.redirs.length || cmds.length === 0) cmds.push(cur);
  return cmds;
}

/** A word as the user typed it, minus quotes (expansions shown in their $ form), e.g. for ps listings. */
export function wordText(word: Word): string {
  return word.parts.map(p => {
    switch (p.k) {
      case 'lit': return p.text;
      case 'tilde': return `~${p.user}`;
      case 'param': return p.raw ?? (p.op || p.arg ? `\${${p.name}${p.op ?? ''}${p.arg ?? ''}}` : `$${p.name}`);
      case 'cmd': return `$(${p.src})`;
      case 'arith': return `$((${p.src}))`;
    }
  }).join('');
}

/** A leading NAME=value word (before expansion). */
export function assignmentOf(word: Word): { name: string; value: Word } | null {
  const first = word.parts[0];
  if (!first || first.k !== 'lit' || first.quoted) return null;
  const m = first.text.match(/^([A-Za-z_]\w*)=/);
  if (!m) return null;
  const rest = first.text.slice(m[0].length);
  const value: Word = { parts: [...(rest ? [{ k: 'lit' as const, text: rest, quoted: false }] : []), ...word.parts.slice(1)] };
  return { name: m[1], value };
}

// ---------- expansion ----------

export class ExpansionError extends Error {}

export interface Expander {
  /** Value of a parameter, or undefined when unset. */
  lookup(name: string): string | undefined;
  /** Assigns a variable (for ${VAR:=word}). */
  assign(name: string, value: string): void;
  /** Runs a command substitution and returns its standard output. */
  substitute(src: string): string;
  /** Home directory of a user ('' means the current user); undefined if unknown. */
  home(user: string): string | undefined;
}

export interface Field {
  text: string;
  /** Set when the field has active wildcards: the pattern with quoted wildcard characters bracketed */
  glob?: string;
}

const literalGlob = (t: string) => t.replace(/[*?[]/g, c => `[${c}]`);

/**
 * Turns the text after an operator (${x:-TEXT}, ${x#TEXT}) into a word: quotes, backslashes and
 * nested $-expansions and backticks are honoured; spaces are kept as they are.
 */
function argWord(text: string): Word {
  const parts: WordPart[] = [];
  const lit = (t: string, quoted: boolean) => {
    const last = parts[parts.length - 1];
    if (last && last.k === 'lit' && last.quoted === quoted) last.text += t;
    else parts.push({ k: 'lit', text: t, quoted });
  };
  let i = 0;
  while (i < text.length) {
    const c = text[i];
    if (c === '\\' && i + 1 < text.length) { lit(text[i + 1], true); i += 2; continue; }
    if (c === "'") {
      const j = text.indexOf("'", i + 1);
      const end = j === -1 ? text.length : j;
      lit(text.slice(i + 1, end), true);
      i = end + 1;
      continue;
    }
    if (c === '"') {
      lit('', true);
      i++;
      while (i < text.length && text[i] !== '"') {
        if (text[i] === '\\' && i + 1 < text.length && '$`"\\'.includes(text[i + 1])) { lit(text[i + 1], true); i += 2; continue; }
        if (text[i] === '$') {
          const r = readDollar(text, i, true);
          if (r) { parts.push(r.part); i = r.next; continue; }
        }
        if (text[i] === '`') {
          const end = scanBacktick(text, i + 1);
          parts.push({ k: 'cmd', src: unBacktick(text.slice(i + 1, end - 1)), quoted: true });
          i = end;
          continue;
        }
        lit(text[i], true);
        i++;
      }
      i++;
      continue;
    }
    if (c === '$') {
      const r = readDollar(text, i, false);
      if (r) { parts.push(r.part); i = r.next; continue; }
    }
    if (c === '`') {
      const end = scanBacktick(text, i + 1);
      parts.push({ k: 'cmd', src: unBacktick(text.slice(i + 1, end - 1)), quoted: false });
      i = end;
      continue;
    }
    lit(c, false);
    i++;
  }
  return { parts };
}

const argText = (text: string | undefined, ex: Expander) => expandToString(argWord(text ?? ''), ex);

/** A glob pattern (from ${x#pat} and friends) as an anchored RegExp; quoted characters are literal. */
function argPattern(text: string | undefined, ex: Expander): RegExp {
  const fields = expandWord(argWord(text ?? ''), ex, false);
  const glob = fields.map(f => f.glob ?? literalGlob(f.text)).join(' ');
  let src = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*') src += '[\\s\\S]*';
    else if (c === '?') src += '[\\s\\S]';
    else if (c === '[') {
      const end = glob.indexOf(']', i + 2);
      if (end === -1) src += '\\[';
      else { src += '[' + glob.slice(i + 1, end).replace(/^!/, '^').replace(/\\/g, '\\\\') + ']'; i = end; }
    } else src += c.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
  }
  return new RegExp(`^(?:${src})$`);
}

/** Longest match of `re` starting at `start` (end index), or -1. */
function longestAt(v: string, start: number, re: RegExp): number {
  for (let end = v.length; end >= start; end--) if (re.test(v.slice(start, end))) return end;
  return -1;
}

function paramValue(p: Extract<WordPart, { k: 'param' }>, ex: Expander): string {
  if (p.op === 'bad') throw new ExpansionError(`bash: ${p.raw}: bad substitution`);
  const v = ex.lookup(p.name);
  if (!p.op) return v ?? '';
  const val = v ?? '';
  switch (p.op) {
    case 'len': return String([...val].length);
    case 'ind': return v === undefined ? '' : ex.lookup(v) ?? '';
    case 'sub': {
      const chars = [...val];
      let off = evalArithmetic(p.arg ?? '', ex);
      if (off < 0) off = Math.max(chars.length + off, -1);
      if (off < 0 || off > chars.length) return '';
      if (p.arg2 === undefined) return chars.slice(off).join('');
      const len = evalArithmetic(p.arg2, ex);
      if (len < 0) {
        const end = chars.length + len;
        if (end < off) throw new ExpansionError(`bash: ${p.arg2.trim()}: substring expression < 0`);
        return chars.slice(off, end).join('');
      }
      return chars.slice(off, off + len).join('');
    }
    case '#': case '##': {
      const re = argPattern(p.arg, ex);
      const ks = [...Array(val.length + 1).keys()];
      const k = (p.op === '#' ? ks : ks.reverse()).find(n => re.test(val.slice(0, n)));
      return k === undefined ? val : val.slice(k);
    }
    case '%': case '%%': {
      const re = argPattern(p.arg, ex);
      const ks = [...Array(val.length + 1).keys()];
      const k = (p.op === '%' ? ks.reverse() : ks).find(n => re.test(val.slice(n)));
      return k === undefined ? val : val.slice(0, k);
    }
    case '/': case '//': case '/#': case '/%': {
      if (!p.arg) return val;
      const re = argPattern(p.arg, ex);
      const rep = argText(p.arg2, ex);
      if (p.op === '/#') { const end = longestAt(val, 0, re); return end === -1 ? val : rep + val.slice(end); }
      if (p.op === '/%') {
        for (let start = 0; start <= val.length; start++) if (re.test(val.slice(start))) return val.slice(0, start) + rep;
        return val;
      }
      let out = '';
      let i = 0;
      let done = false;
      while (i <= val.length) {
        const end = done ? -1 : longestAt(val, i, re);
        if (end > i) {
          out += rep;
          i = end;
          if (p.op === '/') done = true;
          continue;
        }
        if (i < val.length) out += val[i];
        i++;
      }
      return out;
    }
    case '^': case '^^': case ',': case ',,': {
      const re = p.arg ? argPattern(p.arg, ex) : null;
      const upper = p.op[0] === '^';
      const all = p.op.length === 2;
      return [...val].map((ch, idx) => {
        if ((!all && idx > 0) || (re && !re.test(ch))) return ch;
        return upper ? ch.toUpperCase() : ch.toLowerCase();
      }).join('');
    }
    case '@U': return val.toUpperCase();
    case '@L': return val.toLowerCase();
    case '@u': return val.charAt(0).toUpperCase() + val.slice(1);
    case '@Q': return v === undefined ? '' : `'${val.replace(/'/g, "'\\''")}'`;
  }
  // ${x-word} ${x:-word} ${x=word} ${x+word} ${x?word}: with a colon, empty counts as unset
  const colon = p.op.startsWith(':');
  const kind = p.op.slice(-1);
  const isSet = colon ? !!v : v !== undefined;
  const arg = () => argText(p.arg, ex);
  switch (kind) {
    case '-': return isSet ? v! : arg();
    case '=': if (!isSet) { const a = arg(); ex.assign(p.name, a); return a; } return v!;
    case '+': return isSet ? arg() : '';
    case '?': if (!isSet) { const a = arg(); throw new ExpansionError(`bash: ${p.name}: ${a || 'parameter null or not set'}`); } return v!;
  }
  return val;
}

/** Value of one expandable part, before field splitting. */
function partValue(part: Exclude<WordPart, { k: 'lit' } | { k: 'tilde' }>, ex: Expander): string {
  if (part.k === 'param') return paramValue(part, ex);
  if (part.k === 'cmd') return ex.substitute(part.src).replace(/\n+$/, '');
  return String(evalArithmeticBig(part.src, ex));
}

/**
 * Expands a word into fields, as bash does before running a command: tilde, parameter, command and
 * arithmetic expansion, then field splitting of unquoted results. A word made only of unquoted
 * expansions that came out empty disappears.
 */
export function expandWord(word: Word, ex: Expander, split = true): Field[] {
  const fields: Field[] = [];
  let text = '';
  let pattern = '';
  let glob = false;
  let has = false; // the current field exists even if empty (e.g. from "")
  const push = () => {
    fields.push(glob ? { text, glob: pattern } : { text });
    text = ''; pattern = ''; glob = false; has = false;
  };
  const addUnquoted = (t: string) => {
    text += t;
    pattern += t;
    if (/[*?[]/.test(t)) glob = true;
    if (t) has = true;
  };
  for (const part of word.parts) {
    if (part.k === 'lit') {
      if (part.quoted) { text += part.text; pattern += literalGlob(part.text); has = true; }
      else addUnquoted(part.text);
      continue;
    }
    if (part.k === 'tilde') {
      const home = ex.home(part.user);
      const t = home ?? `~${part.user}`;
      text += t; pattern += literalGlob(t); has = true;
      continue;
    }
    const value = partValue(part, ex);
    if (part.quoted) { text += value; pattern += literalGlob(value); has = true; continue; }
    if (!split) { addUnquoted(value); continue; }
    const pieces = value.split(/[ \t\n]+/);
    pieces.forEach((piece, idx) => {
      if (idx > 0 && (has || text)) push();
      addUnquoted(piece);
    });
    // A trailing separator ends the field
    if (pieces.length > 1 && pieces[pieces.length - 1] === '' && has) push();
  }
  if (has || text) push();
  return fields;
}

/** Expands a word into one string with no field splitting (assignments, redirect targets, here-strings). */
export function expandToString(word: Word, ex: Expander): string {
  return expandWord(word, ex, false).map(f => f.text).join(' ');
}

// ---------- arithmetic ----------

const wrap = (n: bigint) => BigInt.asIntN(64, n);
const DIGITS = '0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ@_';

/**
 * A bash integer constant: 0x1f (hex), 017 (octal), 2#101 (base 2 to 64) or decimal.
 * Returns null when a digit is too large for the base.
 */
function parseIntegerConstant(t: string): bigint | null {
  let base = 10;
  let digits = t;
  const based = t.match(/^(\d+)#(.*)$/);
  if (based) {
    base = Number(based[1]);
    digits = based[2];
    if (base < 2 || base > 64) return null;
  } else if (/^0[xX]/.test(t)) {
    base = 16;
    digits = t.slice(2);
  } else if (t.length > 1 && t[0] === '0') {
    base = 8;
    digits = t.slice(1);
  }
  let n = 0n;
  for (const ch of digits) {
    let d = DIGITS.indexOf(base <= 36 ? ch.toLowerCase() : ch);
    if (base <= 36 && d >= 36) d = -1;
    if (d < 0 || d >= base) return null;
    n = wrap(n * BigInt(base) + BigInt(d));
  }
  return n;
}

const ARITH_TOKEN = /\d+#[0-9A-Za-z@_]*|0[xX][0-9A-Fa-f]*|\d[0-9A-Za-z_]*|[A-Za-z_]\w*|<<=|>>=|\*\*|<<|>>|<=|>=|==|!=|&&|\|\||\+\+|--|[-+*/%&^|]=|[-+*/%()<>!~^&|?:=,]|\S/g;

/**
 * Evaluates $(( ... )) the way bash does: 64-bit signed integers that wrap around, constants in
 * any base, variables (whose values are themselves evaluated), assignment operators, ++/--,
 * the comma, ternary, logical, bitwise, comparison, shift and arithmetic operators.
 */
export function evalArithmeticBig(src: string, ex: Expander, level = 0): bigint {
  // $VAR and ${VAR} inside are expanded first; bare names are read as variables
  const text = src.replace(/\$\{?([A-Za-z_]\w*|[0-9?$#])\}?/g, (_, n) => ex.lookup(n) ?? '0');
  const toks = text.match(ARITH_TOKEN) ?? [];
  const expr0 = src.trim();
  let pos = 0;
  let noeval = 0;
  const err = (what: string, token: string): never => {
    throw new ExpansionError(`bash: ${expr0}: ${what} (error token is "${token}")`);
  };
  const operandExpected = (): never => {
    const rest = toks.slice(pos).join(' ').trim() || toks[toks.length - 1] || '';
    return err('syntax error: operand expected', rest);
  };
  const peek = () => toks[pos];
  const nested = <T>(fn: () => T): T => {
    if (++level > MAX_ARITH_DEPTH) err('expression recursion level exceeded', toks.slice(pos).join(''));
    try { return fn(); } finally { level--; }
  };
  const isName = (t: string | undefined) => !!t && /^[A-Za-z_]\w*$/.test(t);
  const readVar = (name: string): bigint => {
    const v = (ex.lookup(name) ?? '').trim();
    if (v === '') return 0n;
    const n = parseIntegerConstant(v.replace(/^[-+]/, ''));
    if (n !== null && /^[-+]?\w+(#\w*)?$/.test(v)) return v.startsWith('-') ? wrap(-n) : n;
    // A variable may hold an expression of its own
    return nested(() => evalArithmeticBig(v, ex, level));
  };
  const setVar = (name: string, v: bigint): bigint => {
    if (!noeval) ex.assign(name, String(v));
    return v;
  };
  const divide = (op: string, l: bigint, r: bigint): bigint => {
    if (r === 0n) {
      if (noeval) return 0n;
      err('division by 0', toks[pos - 1] ?? '');
    }
    return wrap(op === '/' ? l / r : l % r);
  };
  const binary = (op: string, l: bigint, r: bigint): bigint => {
    switch (op) {
      case '*': return wrap(l * r);
      case '/': case '%': return divide(op, l, r);
      case '+': return wrap(l + r);
      case '-': return wrap(l - r);
      case '<<': return wrap(l << (r & 63n));
      case '>>': return l >> (r & 63n);
      case '&': return l & r;
      case '^': return l ^ r;
      case '|': return l | r;
      case '**': {
        if (r < 0n) err('exponent less than 0', toks[pos - 1] ?? '');
        let out = 1n;
        for (let i = 0n; i < r && i < 64n; i++) out = wrap(out * l);
        // beyond 64 squarings only 0, 1 and -1 stay meaningful
        if (r >= 64n) out = l === 1n ? 1n : l === -1n ? (r % 2n ? -1n : 1n) : 0n;
        return out;
      }
    }
    return 0n;
  };

  const primary = (): bigint => {
    const t = toks[pos++];
    if (t === undefined) return operandExpected();
    if (t === '(') return nested(() => { const v = comma(); if (toks[pos++] !== ')') { pos--; operandExpected(); } return v; });
    if (t === '-') return nested(() => wrap(-unary()));
    if (t === '+') return nested(() => unary());
    if (t === '!') return nested(() => (unary() ? 0n : 1n));
    if (t === '~') return nested(() => ~unary());
    if ((t === '++' || t === '--') && isName(peek())) {
      const name = toks[pos++];
      return setVar(name, wrap(readVar(name) + (t === '++' ? 1n : -1n)));
    }
    if (/^\d/.test(t)) {
      const base = t.match(/^(\d+)#/);
      if (base && (Number(base[1]) < 2 || Number(base[1]) > 64)) err('invalid arithmetic base', t);
      const n = parseIntegerConstant(t);
      return n === null ? err('value too great for base', t) : n;
    }
    if (isName(t)) {
      // name++ / name-- give the old value
      if (peek() === '++' || peek() === '--') {
        const op = toks[pos++];
        const old = readVar(t);
        setVar(t, wrap(old + (op === '++' ? 1n : -1n)));
        return old;
      }
      return readVar(t);
    }
    pos--;
    return operandExpected();
  };
  const unary = (): bigint => primary();
  const power = (): bigint => {
    const base = unary();
    if (peek() === '**') { pos++; const e = nested(() => power()); return binary('**', base, e); }
    return base;
  };
  const leftAssoc = (next: () => bigint, ops: string[]) => (): bigint => {
    let v = next();
    while (ops.includes(peek())) {
      const op = toks[pos++];
      v = binary(op, v, next());
    }
    return v;
  };
  const mul = leftAssoc(power, ['*', '/', '%']);
  const add = leftAssoc(mul, ['+', '-']);
  const shift = leftAssoc(add, ['<<', '>>']);
  const cmp = (): bigint => {
    let v = shift();
    while (['<', '>', '<=', '>='].includes(peek())) {
      const op = toks[pos++];
      const r = shift();
      v = (op === '<' ? v < r : op === '>' ? v > r : op === '<=' ? v <= r : v >= r) ? 1n : 0n;
    }
    return v;
  };
  const eq = (): bigint => {
    let v = cmp();
    while (peek() === '==' || peek() === '!=') {
      const op = toks[pos++];
      const r = cmp();
      v = (op === '==' ? v === r : v !== r) ? 1n : 0n;
    }
    return v;
  };
  const band = leftAssoc(eq, ['&']);
  const bxor = leftAssoc(band, ['^']);
  const bor = leftAssoc(bxor, ['|']);
  const land = (): bigint => {
    let v = bor();
    while (peek() === '&&') {
      pos++;
      if (!v) noeval++;
      const r = bor();
      if (!v) noeval--;
      v = v && r ? 1n : 0n;
    }
    return v;
  };
  const lor = (): bigint => {
    let v = land();
    while (peek() === '||') {
      pos++;
      if (v) noeval++;
      const r = land();
      if (v) noeval--;
      v = v || r ? 1n : 0n;
    }
    return v;
  };
  const ternary = (): bigint => {
    const c = lor();
    if (peek() !== '?') return c;
    pos++;
    if (!c) noeval++;
    const a = nested(() => assignment());
    if (!c) noeval--;
    if (toks[pos++] !== ':') { pos--; err('`:\' expected for conditional expression', toks.slice(pos).join(' ')); }
    if (c) noeval++;
    const b = nested(() => ternary());
    if (c) noeval--;
    return c ? a : b;
  };
  const ASSIGN_OPS = ['=', '+=', '-=', '*=', '/=', '%=', '<<=', '>>=', '&=', '^=', '|='];
  const assignment = (): bigint => {
    if (isName(peek()) && ASSIGN_OPS.includes(toks[pos + 1])) {
      const name = toks[pos];
      const op = toks[pos + 1];
      pos += 2;
      const r = nested(() => assignment());
      const v = op === '=' ? r : binary(op.slice(0, -1), readVar(name), r);
      return setVar(name, v);
    }
    return ternary();
  };
  const comma = (): bigint => {
    let v = assignment();
    while (peek() === ',') { pos++; v = assignment(); }
    return v;
  };

  if (toks.length === 0) return 0n;
  const result = comma();
  if (pos < toks.length) err('syntax error in expression', toks.slice(pos).join(' '));
  return result;
}

/** $(( ... )) as a JavaScript number (for offsets and lengths). */
export function evalArithmetic(src: string, ex: Expander): number {
  return Number(evalArithmeticBig(src, ex));
}
