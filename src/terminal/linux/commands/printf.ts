import { MAX_FORMAT_WIDTH } from '../../limits';
import { LinuxContext, LinuxResult, linuxCommands } from '../context';

// printf FORMAT [ARGUMENTS...] (the bash builtin): %s %d %i %u %x %X %o %c %f %e %g %b %q %%,
// flags, width and precision, backslash escapes, and the format reused until the arguments run out.

/** Backslash escapes in the format (and in %b arguments). */
function unescape(text: string): string {
  return text.replace(/\\(0[0-7]{0,3}|[0-7]{1,3}|x[0-9a-fA-F]{1,2}|.)/g, (_, e: string) => {
    if (/^0?[0-7]{1,3}$/.test(e)) return String.fromCharCode(parseInt(e, 8));
    if (e[0] === 'x' && e.length > 1) return String.fromCharCode(parseInt(e.slice(1), 16));
    const map: Record<string, string> = { n: '\n', t: '\t', r: '\r', a: '\x07', b: '\b', f: '\f', v: '\v', e: '\x1b', '\\': '\\', '"': '"', "'": "'" };
    return map[e] ?? `\\${e}`;
  });
}

const pad = (s: string, width: number, left: boolean, zero = false) => {
  if (s.length >= width) return s;
  if (left) return s.padEnd(width);
  if (zero) {
    const sign = /^[-+ ]/.test(s) ? s[0] : '';
    return sign + s.slice(sign.length).padStart(width - sign.length, '0');
  }
  return s.padStart(width);
};

function printf(ctx: LinuxContext): LinuxResult {
  const args = [...ctx.args];
  if (args[0] === '--') args.shift();
  if (args[0] === '-v') return ctx.fail('bash: printf: -v: not supported in this simulator', 2);
  const format = args.shift();
  if (format === undefined) return ctx.fail('printf: usage: printf [-v var] format [arguments]', 2);
  const errors: string[] = [];
  let out = '';
  let used = 0;

  const toNumber = (a: string | undefined): number => {
    if (a === undefined || a === '') return 0;
    if (/^['"]/.test(a)) return a.charCodeAt(1) || 0;
    const t = a.trim();
    const n = /^[-+]?0x[0-9a-f]+$/i.test(t) ? parseInt(t, 16)
      : /^[-+]?0[0-7]+$/.test(t) ? parseInt(t, 8)
        : /^[-+]?\d+$/.test(t) ? parseInt(t, 10) : NaN;
    if (isNaN(n)) {
      errors.push(`bash: printf: ${a}: invalid number`);
      const lead = t.match(/^[-+]?\d+/);
      return lead ? parseInt(lead[0], 10) : 0;
    }
    return n;
  };
  const toFloat = (a: string | undefined): number => {
    if (a === undefined || a === '') return 0;
    const n = Number(a);
    if (isNaN(n)) { errors.push(`bash: printf: ${a}: invalid number`); return 0; }
    return n;
  };

  const spec = /%([-+ #0]*)(\*|\d+)?(?:\.(\*|\d+))?([sdiuxXocfFeEgGbq%])|\\(?:0[0-7]{0,3}|[0-7]{1,3}|x[0-9a-fA-F]{1,2}|.)|[^%\\]+|[%\\]/g;
  do {
    const before = used;
    let stop = false;
    for (const m of format.matchAll(spec)) {
      const [whole, flags = '', w, p, conv] = m;
      if (!conv) {
        if (whole.startsWith('\\c')) { stop = true; break; }
        out += whole.startsWith('\\') ? unescape(whole) : whole;
        continue;
      }
      if (conv === '%') { out += '%'; continue; }
      const width = w === '*' ? toNumber(args[used++]) : w ? Number(w) : 0;
      // A negative precision from * counts as omitted, as in bash
      const rawPrec = p === '*' ? toNumber(args[used++]) : p !== undefined ? Number(p) : undefined;
      const prec = rawPrec !== undefined && rawPrec < 0 ? undefined : rawPrec;
      // Real bash would build a string this long; the simulator refuses rather than freeze the page
      if (Math.abs(width) > MAX_FORMAT_WIDTH || (prec ?? 0) > MAX_FORMAT_WIDTH) {
        return ctx.fail(`bash: printf: field width or precision ${Math.max(Math.abs(width), prec ?? 0)} is larger than this simulator allows (${MAX_FORMAT_WIDTH})`, 1);
      }
      const left = flags.includes('-');
      const zero = flags.includes('0') && !left;
      const arg = args[used++];
      let s: string;
      switch (conv) {
        case 's': s = arg ?? ''; if (prec !== undefined) s = s.slice(0, prec); break;
        case 'b': s = unescape(arg ?? ''); if (prec !== undefined) s = s.slice(0, prec); break;
        case 'q': s = arg === undefined ? "''" : /^[\w@%+=:,./-]+$/.test(arg) ? arg : arg.replace(/([^\w@%+=:,./-])/g, '\\$1'); break;
        case 'c': s = (arg ?? '')[0] ?? ''; break;
        case 'd': case 'i': case 'u': {
          const n = Math.trunc(toNumber(arg));
          s = String(Math.abs(n));
          if (prec !== undefined) s = s.padStart(prec, '0');
          s = (n < 0 ? '-' : flags.includes('+') ? '+' : flags.includes(' ') ? ' ' : '') + s;
          break;
        }
        case 'x': case 'X': case 'o': {
          const n = Math.trunc(toNumber(arg));
          s = (n >>> 0).toString(conv === 'o' ? 8 : 16);
          if (conv === 'X') s = s.toUpperCase();
          if (prec !== undefined) s = s.padStart(prec, '0');
          if (flags.includes('#') && n !== 0) s = (conv === 'o' ? '0' : conv === 'x' ? '0x' : '0X') + s;
          break;
        }
        default: {
          const n = toFloat(arg);
          // JS number formatting accepts at most 100 digits; clamp rather than throw
          const digits = Math.min(prec ?? 6, 100);
          if (conv === 'f' || conv === 'F') s = n.toFixed(digits);
          else if (conv === 'e' || conv === 'E') {
            s = n.toExponential(digits).replace(/e([+-])(\d)$/, 'e$10$2');
            if (conv === 'E') s = s.toUpperCase();
          } else {
            s = String(Number(n.toPrecision(digits || 1)));
            if (conv === 'G') s = s.toUpperCase();
          }
          if (n >= 0 && flags.includes('+')) s = '+' + s;
          else if (n >= 0 && flags.includes(' ')) s = ' ' + s;
        }
      }
      const numeric = !'sbqc'.includes(conv);
      out += pad(s, width, left, zero && numeric && prec === undefined);
    }
    // Reuse the format while arguments remain, but only if it consumed some
    if (stop || used === before) break;
  } while (used < args.length);

  // Output is stored without its final newline (the terminal adds line breaks)
  return ctx.result(out.replace(/\n$/, ''), errors.join('\n'), errors.length ? 1 : 0);
}

linuxCommands.register('printf', printf);
