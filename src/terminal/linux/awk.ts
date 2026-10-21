// A compact awk interpreter covering what LPI students type: patterns (/re/, comparisons,
// BEGIN/END), fields ($1, $NF, $(NF-1)), NR/NF/FS/OFS, variables and arrays, print/printf,
// if/else, for, for-in, while, next, and the common string functions.

import { MAX_FORMAT_WIDTH } from '../limits';
import { posixToJsRegex } from '../textUtils';

type Value = string | number;
type Arr = Map<string, Value>;

interface Env {
  fields: string[]; // fields[0] is $0
  vars: Map<string, Value | Arr>;
  out: string[];
  next: boolean;
}

type Expr = (env: Env) => Value;
type Stmt = (env: Env) => void;
interface LValue { get: Expr; set: (env: Env, v: Value) => void }

export class AwkError extends Error {}

// ---------- lexer ----------

type Tok = { k: 'num'; v: number } | { k: 'str'; v: string } | { k: 're'; v: string } | { k: 'name'; v: string } | { k: 'op'; v: string } | { k: 'end' };

const OPS = ['+=', '-=', '*=', '/=', '%=', '==', '!=', '<=', '>=', '&&', '||', '++', '--', '!~', '>', '<', '=', '+', '-', '*', '/', '%', '^', '!', '~', '(', ')', '{', '}', '[', ']', ',', ';', '\n', '$', '?', ':'];

function unescape(s: string): string {
  return s.replace(/\\(.)/g, (_, c) => ({ n: '\n', t: '\t', r: '\r', '\\': '\\', '"': '"', '/': '/' } as Record<string, string>)[c] ?? '\\' + c);
}

function lex(src: string): Tok[] {
  const toks: Tok[] = [];
  let i = 0;
  const operandExpected = () => {
    const p = toks[toks.length - 1];
    if (!p) return true;
    if (p.k === 'num' || p.k === 'str' || p.k === 're' || p.k === 'name') return false;
    return !(p.k === 'op' && (p.v === ')' || p.v === ']' || p.v === '++' || p.v === '--' || p.v === '$'));
  };
  while (i < src.length) {
    const c = src[i];
    if (c === ' ' || c === '\t' || c === '\r') { i++; continue; }
    if (c === '\\' && src[i + 1] === '\n') { i += 2; continue; }
    if (c === '#') { while (i < src.length && src[i] !== '\n') i++; continue; }
    if (/[0-9]/.test(c) || (c === '.' && /[0-9]/.test(src[i + 1] ?? ''))) {
      const m = src.slice(i).match(/^(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?/)!;
      toks.push({ k: 'num', v: parseFloat(m[0]) });
      i += m[0].length;
      continue;
    }
    if (c === '"') {
      let j = i + 1;
      while (j < src.length && src[j] !== '"') j += src[j] === '\\' ? 2 : 1;
      toks.push({ k: 'str', v: unescape(src.slice(i + 1, j)) });
      i = j + 1;
      continue;
    }
    if (c === '/' && operandExpected()) {
      let j = i + 1;
      while (j < src.length && src[j] !== '/') j += src[j] === '\\' ? 2 : 1;
      toks.push({ k: 're', v: src.slice(i + 1, j).replace(/\\\//g, '/') });
      i = j + 1;
      continue;
    }
    const name = src.slice(i).match(/^[A-Za-z_]\w*/);
    if (name) {
      toks.push({ k: 'name', v: name[0] });
      i += name[0].length;
      continue;
    }
    const op = OPS.find(o => src.startsWith(o, i));
    if (!op) throw new AwkError(c);
    toks.push({ k: 'op', v: op });
    i += op.length;
  }
  toks.push({ k: 'end' });
  return toks;
}

// ---------- values ----------

const NUMERIC = /^\s*[-+]?(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?\s*$/;
const toNum = (v: Value): number => typeof v === 'number' ? v : parseFloat(v.match(/^\s*[-+]?(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?/)?.[0] ?? '0') || 0;
const toStr = (v: Value): string => typeof v === 'number' ? (Number.isInteger(v) ? String(v) : String(Number(v.toPrecision(6)))) : v;
const truthy = (v: Value): boolean => typeof v === 'number' ? v !== 0 : v !== '';
const looksNumeric = (v: Value) => typeof v === 'number' || NUMERIC.test(v);

function compare(a: Value, b: Value): number {
  if (looksNumeric(a) && looksNumeric(b)) return toNum(a) - toNum(b);
  const sa = toStr(a), sb = toStr(b);
  return sa < sb ? -1 : sa > sb ? 1 : 0;
}

function sprintf(fmt: string, args: Value[]): string {
  let n = 0;
  return fmt.replace(/%([-+ 0#]*)(\d+|\*)?(?:\.(\d+))?([sdifcxXeEgGo%])/g, (_, flags: string, width: string, prec: string, conv: string) => {
    if (conv === '%') return '%';
    // A huge width or precision would build an enormous string (or make toFixed throw); refuse instead
    if (Number(width) > MAX_FORMAT_WIDTH || Number(prec) > MAX_FORMAT_WIDTH) {
      throw new AwkError(`format width or precision is larger than this simulator allows (${MAX_FORMAT_WIDTH})`);
    }
    const digits = (d: number) => Math.min(d, 100);
    const arg = args[n++] ?? '';
    let s: string;
    switch (conv) {
      case 'd': case 'i': s = String(Math.trunc(toNum(arg))); break;
      case 'f': s = toNum(arg).toFixed(digits(prec !== undefined ? Number(prec) : 6)); break;
      case 'e': case 'E': s = toNum(arg).toExponential(digits(prec !== undefined ? Number(prec) : 6)); break;
      case 'g': case 'G': s = String(Number(toNum(arg).toPrecision(Math.max(1, digits(prec !== undefined ? Number(prec) || 1 : 6))))); break;
      case 'x': s = Math.trunc(toNum(arg)).toString(16); break;
      case 'X': s = Math.trunc(toNum(arg)).toString(16).toUpperCase(); break;
      case 'o': s = Math.trunc(toNum(arg)).toString(8); break;
      case 'c': s = typeof arg === 'number' ? String.fromCharCode(arg) : arg.charAt(0); break;
      default: s = toStr(arg); if (prec !== undefined) s = s.slice(0, Number(prec));
    }
    const w = width ? Number(width) : 0;
    if (s.length < w) s = flags.includes('-') ? s.padEnd(w) : s.padStart(w, flags.includes('0') && conv !== 's' ? '0' : ' ');
    return s;
  });
}

// ---------- parser ----------

interface Program { begin: Stmt[]; rules: { pattern?: Expr; action?: Stmt }[]; end: Stmt[] }

function parse(src: string, fieldSplit: (env: Env) => void): Program {
  const toks = lex(src);
  let p = 0;
  const peek = (o = 0) => toks[p + o];
  const isOp = (v: string, o = 0) => { const t = peek(o); return t.k === 'op' && t.v === v; };
  const isName = (v: string) => { const t = peek(); return t.k === 'name' && t.v === v; };
  const fail = (): never => {
    const t = peek();
    throw new AwkError(t.k === 'end' ? 'end of file' : t.k === 'num' || t.k === 'name' || t.k === 'str' || t.k === 'op' || t.k === 're' ? String(t.v) : '?');
  };
  const expect = (v: string) => { if (!isOp(v)) fail(); p++; };
  const skipNl = () => { while (isOp('\n')) p++; };
  const skipTerm = () => { while (isOp('\n') || isOp(';')) p++; };

  const getVar = (env: Env, name: string): Value => {
    if (name === 'NF') return env.fields.length - 1;
    const v = env.vars.get(name);
    return v instanceof Map ? '' : v ?? '';
  };
  const setVar = (env: Env, name: string, v: Value) => {
    if (name === 'NF') { env.fields = env.fields.slice(0, toNum(v) + 1); rebuild(env); return; }
    env.vars.set(name, v);
  };
  const arr = (env: Env, name: string): Arr => {
    let a = env.vars.get(name);
    if (!(a instanceof Map)) { a = new Map(); env.vars.set(name, a); }
    return a;
  };
  const rebuild = (env: Env) => {
    while (env.fields.length < 1) env.fields.push('');
    env.fields[0] = env.fields.slice(1).join(toStr(getVar(env, 'OFS')));
  };
  const setField = (env: Env, i: number, v: Value) => {
    if (i === 0) { env.fields = [toStr(v)]; fieldSplit(env); return; }
    while (env.fields.length <= i) env.fields.push('');
    env.fields[i] = toStr(v);
    rebuild(env);
  };

  const startsOperand = () => {
    const t = peek();
    return t.k === 'num' || t.k === 'str' || (t.k === 'name' && !['in', 'getline'].includes(t.v)) || (t.k === 'op' && ['$', '(', '!', '++', '--', '-'].includes(t.v) && t.v !== '-');
  };

  function primary(): Expr {
    const t = peek();
    if (t.k === 'num') { p++; return () => t.v; }
    if (t.k === 'str') { p++; return () => t.v; }
    if (t.k === 're') { p++; const re = new RegExp(posixToJsRegex(t.v, true)); return env => (re.test(env.fields[0]) ? 1 : 0); }
    if (isOp('(')) { p++; const e = expr(); expect(')'); return e; }
    if (isOp('$')) { p++; const idx = highPrecOperand(); return env => env.fields[toNum(idx(env))] ?? ''; }
    if (t.k === 'name') {
      p++;
      const name = t.v;
      if (isOp('(')) return call(name);
      if (name === 'length') return env => env.fields[0].length;
      if (isOp('[')) { p++; const key = expr(); expect(']'); return env => arr(env, name).get(toStr(key(env))) ?? ''; }
      return env => getVar(env, name);
    }
    return fail();
  }

  // operand of $ binds tighter than arithmetic: $NF-1 is ($NF)-1
  function highPrecOperand(): Expr {
    if (isOp('-')) { p++; const e = highPrecOperand(); return env => -toNum(e(env)); }
    if (isOp('++') || isOp('--')) return prefixIncr();
    return primary();
  }

  function lvalue(): LValue {
    if (isOp('$')) {
      p++;
      const idx = highPrecOperand();
      return { get: env => env.fields[toNum(idx(env))] ?? '', set: (env, v) => setField(env, toNum(idx(env)), v) };
    }
    const t = peek();
    if (t.k !== 'name') return fail();
    p++;
    if (isOp('[')) {
      p++; const key = expr(); expect(']');
      return { get: env => arr(env, t.v).get(toStr(key(env))) ?? '', set: (env, v) => arr(env, t.v).set(toStr(key(env)), v) };
    }
    return { get: env => getVar(env, t.v), set: (env, v) => setVar(env, t.v, v) };
  }

  function prefixIncr(): Expr {
    const d = isOp('++') ? 1 : -1;
    p++;
    const lv = lvalue();
    return env => { const v = toNum(lv.get(env)) + d; lv.set(env, v); return v; };
  }

  function call(name: string): Expr {
    expect('(');
    const args: Expr[] = [];
    let arrName = '';
    if (!isOp(')')) {
      for (;;) {
        if (name === 'split' && args.length === 1 && peek().k === 'name') { arrName = (peek() as { v: string }).v; p++; args.push(() => ''); }
        else args.push(expr());
        if (!isOp(',')) break;
        p++;
      }
    }
    expect(')');
    const a = (env: Env, i: number) => (args[i] ? args[i](env) : '');
    switch (name) {
      case 'length': return env => toStr(args.length ? a(env, 0) : env.fields[0]).length;
      case 'substr': return env => {
        const s = toStr(a(env, 0)); const m = Math.round(toNum(a(env, 1)));
        const n = args[2] ? Math.round(toNum(a(env, 2))) : Infinity;
        const start = Math.max(1, m); const stop = Math.min(s.length + 1, m + n);
        return stop > start ? s.slice(start - 1, stop - 1) : '';
      };
      case 'index': return env => toStr(a(env, 0)).indexOf(toStr(a(env, 1))) + 1;
      case 'toupper': return env => toStr(a(env, 0)).toUpperCase();
      case 'tolower': return env => toStr(a(env, 0)).toLowerCase();
      case 'int': return env => Math.trunc(toNum(a(env, 0)));
      case 'sprintf': return env => sprintf(toStr(a(env, 0)), args.slice(1).map(e => e(env)));
      case 'split': return env => {
        const s = toStr(a(env, 0));
        const sep = args[2] ? toStr(a(env, 2)) : toStr(getVar(env, 'FS'));
        const parts = sep === ' ' ? s.trim().split(/\s+/).filter(Boolean) : s.split(sep.length === 1 ? sep : new RegExp(sep));
        const target = arr(env, arrName); target.clear();
        parts.forEach((v, i) => target.set(String(i + 1), v));
        return parts.length;
      };
      default: throw new AwkError(`function ${name} never defined`);
    }
  }

  function postfix(): Expr {
    if (isOp('++') || isOp('--')) return prefixIncr();
    const save = p;
    if (isOp('$') || peek().k === 'name') {
      const nameTok = peek();
      if (!(nameTok.k === 'name' && isOp('(', 1))) {
        const lv = lvalue();
        if (isOp('++') || isOp('--')) {
          const d = isOp('++') ? 1 : -1; p++;
          return env => { const v = toNum(lv.get(env)); lv.set(env, v + d); return v; };
        }
        p = save;
      }
    }
    return primary();
  }

  function power(): Expr {
    const base = postfix();
    if (isOp('^')) { p++; const e = unary(); return env => Math.pow(toNum(base(env)), toNum(e(env))); }
    return base;
  }

  function unary(): Expr {
    if (isOp('!')) { p++; const e = unary(); return env => (truthy(e(env)) ? 0 : 1); }
    if (isOp('-')) { p++; const e = unary(); return env => -toNum(e(env)); }
    if (isOp('+')) { p++; const e = unary(); return env => toNum(e(env)); }
    return power();
  }

  function mult(): Expr {
    let l = unary();
    while (isOp('*') || isOp('/') || isOp('%')) {
      const op = (peek() as { v: string }).v; p++;
      const r = unary(); const left = l;
      l = op === '*' ? env => toNum(left(env)) * toNum(r(env))
        : op === '/' ? env => { const d = toNum(r(env)); if (d === 0) throw new AwkError('division by zero'); return toNum(left(env)) / d; }
        : env => toNum(left(env)) % toNum(r(env));
    }
    return l;
  }

  function additive(): Expr {
    let l = mult();
    while (isOp('+') || isOp('-')) {
      const op = (peek() as { v: string }).v; p++;
      const r = mult(); const left = l;
      l = op === '+' ? env => toNum(left(env)) + toNum(r(env)) : env => toNum(left(env)) - toNum(r(env));
    }
    return l;
  }

  function concat(): Expr {
    let l = additive();
    while (startsOperand()) {
      const r = additive(); const left = l;
      l = env => toStr(left(env)) + toStr(r(env));
    }
    return l;
  }

  function comparison(): Expr {
    const l = concat();
    for (const op of ['<=', '>=', '==', '!=', '<', '>']) {
      if (isOp(op)) {
        p++;
        const r = concat();
        const test: Record<string, (c: number) => boolean> = {
          '<': c => c < 0, '<=': c => c <= 0, '>': c => c > 0, '>=': c => c >= 0, '==': c => c === 0, '!=': c => c !== 0,
        };
        return env => (test[op](compare(l(env), r(env))) ? 1 : 0);
      }
    }
    return l;
  }

  function match(): Expr {
    let l = comparison();
    while (isOp('~') || isOp('!~')) {
      const neg = isOp('!~'); p++;
      const t = peek();
      let re: (env: Env) => RegExp;
      if (t.k === 're') { p++; const r = new RegExp(posixToJsRegex(t.v, true)); re = () => r; }
      else { const e = comparison(); re = env => new RegExp(posixToJsRegex(toStr(e(env)), true)); }
      const left = l;
      l = env => (re(env).test(toStr(left(env))) !== neg ? 1 : 0);
    }
    return l;
  }

  function and(): Expr {
    let l = match();
    while (isOp('&&')) { p++; skipNl(); const r = match(); const left = l; l = env => (truthy(left(env)) && truthy(r(env)) ? 1 : 0); }
    return l;
  }

  function or(): Expr {
    let l = and();
    while (isOp('||')) { p++; skipNl(); const r = and(); const left = l; l = env => (truthy(left(env)) || truthy(r(env)) ? 1 : 0); }
    return l;
  }

  function ternary(): Expr {
    const c = or();
    if (!isOp('?')) return c;
    p++; const a = ternary(); expect(':'); const b = ternary();
    return env => (truthy(c(env)) ? a(env) : b(env));
  }

  function expr(): Expr {
    const save = p;
    if (isOp('$') || peek().k === 'name') {
      const t = peek();
      if (!(t.k === 'name' && isOp('(', 1))) {
        try {
          const lv = lvalue();
          for (const op of ['=', '+=', '-=', '*=', '/=', '%=']) {
            if (isOp(op)) {
              p++;
              const r = expr();
              return env => {
                const rv = r(env);
                const cur = toNum(lv.get(env));
                const v = op === '=' ? rv : op === '+=' ? cur + toNum(rv) : op === '-=' ? cur - toNum(rv)
                  : op === '*=' ? cur * toNum(rv) : op === '/=' ? cur / toNum(rv) : cur % toNum(rv);
                lv.set(env, v);
                return v;
              };
            }
          }
        } catch (e) {
          if (!(e instanceof AwkError)) throw e;
        }
        p = save;
      }
    }
    return ternary();
  }

  function exprList(): Expr[] {
    const list: Expr[] = [];
    if (isOp(';') || isOp('\n') || isOp('}') || peek().k === 'end') return list;
    // print (a, b) groups its list in parentheses
    if (isOp('(')) {
      const save = p;
      p++;
      const inner = [expr()];
      while (isOp(',')) { p++; inner.push(expr()); }
      if (isOp(')') && (isOp(';', 1) || isOp('\n', 1) || isOp('}', 1) || peek(1).k === 'end')) { p++; return inner; }
      p = save;
    }
    list.push(expr());
    while (isOp(',')) { p++; skipNl(); list.push(expr()); }
    return list;
  }

  function simpleOrBlock(): Stmt {
    skipNl();
    return statement();
  }

  function statement(): Stmt {
    if (isOp('{')) return block();
    if (isName('if')) {
      p++; expect('('); const c = expr(); expect(')');
      const then = simpleOrBlock();
      const save = p; skipTerm();
      if (isName('else')) { p++; const other = simpleOrBlock(); return env => (truthy(c(env)) ? then(env) : other(env)); }
      p = save;
      return env => { if (truthy(c(env))) then(env); };
    }
    if (isName('while')) {
      p++; expect('('); const c = expr(); expect(')'); const body = simpleOrBlock();
      return env => { let guard = 0; while (truthy(c(env)) && !env.next && guard++ < 100000) body(env); };
    }
    if (isName('for')) {
      p++; expect('(');
      if (peek().k === 'name' && peek(1).k === 'name' && (peek(1) as { v: string }).v === 'in') {
        const v = (peek() as { v: string }).v; p += 2;
        const a = (peek() as { v: string }).v; p++;
        expect(')');
        const body = simpleOrBlock();
        return env => { for (const k of [...arr(env, a).keys()]) { setVar(env, v, k); body(env); if (env.next) return; } };
      }
      const init = isOp(';') ? null : expr(); expect(';');
      const cond = isOp(';') ? null : expr(); expect(';');
      const step = isOp(')') ? null : expr(); expect(')');
      const body = simpleOrBlock();
      return env => {
        let guard = 0;
        for (init?.(env); (!cond || truthy(cond(env))) && guard++ < 100000; step?.(env)) { body(env); if (env.next) return; }
      };
    }
    if (isName('next')) { p++; return env => { env.next = true; }; }
    if (isName('print')) {
      p++;
      const list = exprList();
      return env => {
        if (env.next) return;
        const ofs = toStr(getVar(env, 'OFS'));
        env.out.push((list.length ? list.map(e => toStr(e(env))).join(ofs) : env.fields[0]) + toStr(getVar(env, 'ORS')));
      };
    }
    if (isName('printf')) {
      p++;
      const list = exprList();
      return env => { if (!env.next && list.length) env.out.push(sprintf(toStr(list[0](env)), list.slice(1).map(e => e(env)))); };
    }
    if (isOp(';')) { p++; return () => undefined; }
    const e = expr();
    return env => { if (!env.next) e(env); };
  }

  function block(): Stmt {
    expect('{');
    const stmts: Stmt[] = [];
    skipTerm();
    while (!isOp('}')) {
      if (peek().k === 'end') fail();
      stmts.push(statement());
      skipTerm();
    }
    p++;
    return env => { for (const s of stmts) { if (env.next) return; s(env); } };
  }

  const prog: Program = { begin: [], rules: [], end: [] };
  skipTerm();
  while (peek().k !== 'end') {
    if (isName('BEGIN')) { p++; skipNl(); prog.begin.push(block()); }
    else if (isName('END')) { p++; skipNl(); prog.end.push(block()); }
    else if (isOp('{')) prog.rules.push({ action: block() });
    else {
      const pattern = expr();
      prog.rules.push({ pattern, action: isOp('{') ? block() : undefined });
    }
    skipTerm();
  }
  return prog;
}

// ---------- runner ----------

/**
 * Runs an awk program over input records. `fs` is the -F value (default ' ': runs of blanks),
 * `assigns` the -v name=value pairs. Throws AwkError on a syntax or runtime error.
 */
export function runAwk(program: string, inputs: string[][], fs = ' ', assigns: [string, string][] = []): string {
  const fieldSplit = (env: Env) => {
    const sep = toStr(env.vars.get('FS') as Value ?? ' ');
    const rec = env.fields[0];
    let parts: string[];
    if (sep === ' ') parts = rec.trim() === '' ? [] : rec.trim().split(/[ \t\n]+/);
    else if (sep.length === 1) parts = rec === '' ? [] : rec.split(sep === '\t' ? '\t' : sep);
    else parts = rec === '' ? [] : rec.split(new RegExp(sep));
    env.fields = [rec, ...parts];
  };
  const prog = parse(program, fieldSplit);
  const env: Env = {
    fields: [''],
    vars: new Map<string, Value | Arr>([['FS', fs], ['OFS', ' '], ['ORS', '\n'], ['NR', 0], ['FNR', 0]]),
    out: [],
    next: false,
  };
  for (const [k, v] of assigns) env.vars.set(k, unescape(v));
  for (const s of prog.begin) s(env);
  if (prog.rules.length || prog.end.length) {
    let nr = 0;
    for (const lines of inputs) {
      let fnr = 0;
      for (const line of lines) {
        env.vars.set('NR', ++nr);
        env.vars.set('FNR', ++fnr);
        env.fields = [line];
        fieldSplit(env);
        env.next = false;
        for (const rule of prog.rules) {
          if (env.next) break;
          if (rule.pattern && !truthy(rule.pattern(env))) continue;
          if (rule.action) rule.action(env);
          else env.out.push(env.fields[0] + toStr(env.vars.get('ORS') as Value));
        }
      }
    }
    env.next = false;
    for (const s of prog.end) s(env);
  }
  const text = env.out.join('');
  return text.endsWith('\n') ? text.slice(0, -1) : text;
}
