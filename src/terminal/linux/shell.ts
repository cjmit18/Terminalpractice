// Bash command-line syntax: lexing into words, operators and redirections, and per-word expansion
// (tilde, parameters, command substitution, arithmetic, field splitting, pathname-expansion patterns).
// parser.ts keeps the simpler tokenizer that CMD and PowerShell use; bash goes through this file.

import { ChainedStage } from '../parser';
import { MAX_ARITH_DEPTH } from '../limits';

/** One piece of a word, remembering whether it was quoted (quoted pieces are never split or globbed). */
export type WordPart =
  | { k: 'lit'; text: string; quoted: boolean }
  | { k: 'param'; name: string; op?: string; arg?: string; quoted: boolean }
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
    const end = s.indexOf('}', i + 2);
    const body = s.slice(i + 2, end === -1 ? s.length : end);
    const next = end === -1 ? s.length : end + 1;
    const len = body.match(/^#([A-Za-z_]\w*|[0-9?$#])$/);
    if (len) return { part: { k: 'param', name: len[1], op: '#', quoted }, next };
    const m = body.match(/^([A-Za-z_]\w*|[0-9?$#!@*-])(:?[-=+?])?([\s\S]*)$/);
    if (m) return { part: { k: 'param', name: m[1], op: m[2], arg: m[2] ? m[3] : undefined, quoted }, next };
    return { part: { k: 'param', name: body, quoted }, next };
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
      case 'param': return p.op || p.arg ? `\${${p.name}${p.op ?? ''}${p.arg ?? ''}}` : `$${p.name}`;
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

function paramValue(p: Extract<WordPart, { k: 'param' }>, ex: Expander): string {
  const v = ex.lookup(p.name);
  if (p.op === '#') return String((v ?? '').length);
  if (!p.op) return v ?? '';
  const colon = p.op.startsWith(':');
  const kind = p.op.slice(-1);
  const isSet = colon ? !!v : v !== undefined;
  const arg = expandToString({ parts: [{ k: 'lit', text: p.arg ?? '', quoted: false }] }, ex);
  switch (kind) {
    case '-': return isSet ? v! : arg;
    case '=': if (!isSet) { ex.assign(p.name, arg); return arg; } return v!;
    case '+': return isSet ? arg : '';
    case '?': if (!isSet) throw new ExpansionError(`bash: ${p.name}: ${arg || 'parameter null or not set'}`); return v!;
  }
  return v ?? '';
}

/** Value of one expandable part, before field splitting. */
function partValue(part: Exclude<WordPart, { k: 'lit' } | { k: 'tilde' }>, ex: Expander): string {
  if (part.k === 'param') return paramValue(part, ex);
  if (part.k === 'cmd') return ex.substitute(part.src).replace(/\n+$/, '');
  return String(evalArithmetic(part.src, ex));
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

/** Evaluates $(( ... )) with integer math: + - * / % **, comparisons, && || !, parentheses, variables. */
export function evalArithmetic(src: string, ex: Expander): number {
  // $VAR and ${VAR} inside are expanded first; bare names are read as variables
  const text = src.replace(/\$\{?([A-Za-z_]\w*|[0-9?$#])\}?/g, (_, n) => ex.lookup(n) ?? '0');
  const toks = text.match(/\d+|[A-Za-z_]\w*|\*\*|<=|>=|==|!=|&&|\|\||<<|>>|[-+*/%()<>!~^&|]|\S/g) ?? [];
  let pos = 0;
  const fail = (): never => {
    const rest = toks.slice(pos).join(' ').trim() || toks[toks.length - 1] || '';
    throw new ExpansionError(`bash: ${src.trim()}: syntax error: operand expected (error token is "${rest}")`);
  };
  const peek = () => toks[pos];
  const value = (t: string): number => {
    if (/^\d+$/.test(t)) return parseInt(t, 10);
    const v = ex.lookup(t);
    const n = parseInt(v ?? '0', 10);
    return isNaN(n) ? 0 : n;
  };
  let level = 0;
  const nested = <T>(fn: () => T): T => {
    if (++level > MAX_ARITH_DEPTH) {
      const rest = toks.slice(pos).join('');
      throw new ExpansionError(`bash: ${src.trim()}: expression recursion level exceeded (error token is "${rest}")`);
    }
    try { return fn(); } finally { level--; }
  };
  const primary = (): number => {
    const t = toks[pos++];
    if (t === undefined) return fail();
    if (t === '(') return nested(() => { const v = expr(); if (toks[pos++] !== ')') fail(); return v; });
    if (t === '-') return nested(() => -unary());
    if (t === '+') return nested(() => unary());
    if (t === '!') return nested(() => (unary() ? 0 : 1));
    if (t === '~') return nested(() => ~unary());
    if (/^(\d+|[A-Za-z_]\w*)$/.test(t)) return value(t);
    pos--;
    return fail();
  };
  const unary = (): number => primary();
  const power = (): number => {
    const base = unary();
    if (peek() === '**') { pos++; return nested(() => base ** power()); }
    return base;
  };
  const mul = (): number => {
    let v = power();
    while (['*', '/', '%'].includes(peek())) {
      const op = toks[pos++];
      const r = power();
      if ((op === '/' || op === '%') && r === 0) throw new ExpansionError(`bash: ${src.trim()}: division by 0 (error token is "${toks[pos - 1]}")`);
      v = op === '*' ? v * r : op === '/' ? Math.trunc(v / r) : v % r;
    }
    return v;
  };
  const add = (): number => {
    let v = mul();
    while (peek() === '+' || peek() === '-') v = toks[pos++] === '+' ? v + mul() : v - mul();
    return v;
  };
  const cmp = (): number => {
    let v = add();
    while (['<', '>', '<=', '>='].includes(peek())) {
      const op = toks[pos++];
      const r = add();
      v = Number(op === '<' ? v < r : op === '>' ? v > r : op === '<=' ? v <= r : v >= r);
    }
    return v;
  };
  const eq = (): number => {
    let v = cmp();
    while (peek() === '==' || peek() === '!=') v = Number(toks[pos++] === '==' ? v === cmp() : v !== cmp());
    return v;
  };
  const and = (): number => {
    let v = eq();
    while (peek() === '&&') { pos++; const r = eq(); v = Number(!!v && !!r); }
    return v;
  };
  const expr = (): number => {
    let v = and();
    while (peek() === '||') { pos++; const r = and(); v = Number(!!v || !!r); }
    return v;
  };
  if (toks.length === 0) return 0;
  const result = expr();
  if (pos < toks.length) fail();
  return Math.trunc(result);
}
