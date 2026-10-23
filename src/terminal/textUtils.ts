// Small helpers shared by command handlers: option parsing, line splitting, regex and glob conversion.

export interface ParsedOptions {
  /** Single-letter flags that were given (combined forms like -rin are split). */
  flags: Set<string>;
  /** Values of options that take an argument, in the order given (e.g. -e for grep). */
  values: Map<string, string[]>;
  /** Long options without a value (--recursive), stored without the dashes. */
  long: Set<string>;
  /** Everything that is not an option, in order. */
  operands: string[];
}

/**
 * GNU-style getopt: options may appear anywhere (they are permuted), short flags can be
 * combined (-rin), and letters listed in `valueFlags` take the rest of the token or the next
 * argument as their value (-d: or -d :). "--" ends option parsing; "-" alone is an operand.
 * `longAliases` maps long option names to short letters (e.g. { 'ignore-case': 'i' }).
 */
export function parseOptions(
  args: string[],
  valueFlags = '',
  longAliases: Record<string, string> = {}
): ParsedOptions {
  const flags = new Set<string>();
  const values = new Map<string, string[]>();
  const long = new Set<string>();
  const operands: string[] = [];
  const addValue = (k: string, v: string) => values.set(k, [...(values.get(k) ?? []), v]);

  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--') {
      operands.push(...args.slice(i + 1));
      break;
    }
    if (a.startsWith('--')) {
      const [name, value] = a.slice(2).split(/=(.*)/s, 2);
      const short = longAliases[name];
      if (short && valueFlags.includes(short)) addValue(short, value ?? args[++i] ?? '');
      else if (short) flags.add(short);
      else if (value !== undefined) addValue(name, value);
      else long.add(name);
      continue;
    }
    if (a.startsWith('-') && a.length > 1) {
      for (let j = 1; j < a.length; j++) {
        const c = a[j];
        if (valueFlags.includes(c)) {
          const rest = a.slice(j + 1);
          addValue(c, rest !== '' ? rest : args[++i] ?? '');
          break;
        }
        flags.add(c);
      }
      continue;
    }
    operands.push(a);
  }
  return { flags, values, long, operands };
}

/** Last value given for an option, if any. */
export function optionValue(opts: ParsedOptions, flag: string): string | undefined {
  const v = opts.values.get(flag);
  return v ? v[v.length - 1] : undefined;
}

/** Splits text into lines. Contents are stored without a final newline; one is tolerated. */
export function toLines(text: string): string[] {
  if (text === '') return [];
  return (text.endsWith('\n') ? text.slice(0, -1) : text).split('\n');
}

const POSIX_CLASSES: Record<string, string> = {
  alpha: 'a-zA-Z', digit: '0-9', alnum: 'a-zA-Z0-9', upper: 'A-Z', lower: 'a-z',
  space: ' \\t\\n\\r\\f\\v', blank: ' \\t', punct: '!-\\/:-@\\[-`{-~', xdigit: '0-9A-Fa-f', word: '\\w',
};

/**
 * Converts a POSIX basic (BRE) or extended (ERE) regular expression to JavaScript syntax.
 * In BRE, ( ) { } | + ? are literal and their backslashed forms are special; ERE is the
 * reverse. [[:class:]] bracket classes and \< \> word anchors are translated in both.
 */
export function posixToJsRegex(pattern: string, extended: boolean): string {
  let out = '';
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i];
    if (c === '[') {
      // Copy a bracket expression, translating [:name:] classes
      let j = i + 1;
      let body = '';
      if (pattern[j] === '^') { body += '^'; j++; }
      if (pattern[j] === ']') { body += '\\]'; j++; }
      while (j < pattern.length && pattern[j] !== ']') {
        const cls = pattern.slice(j).match(/^\[:(\w+):\]/);
        if (cls) {
          body += POSIX_CLASSES[cls[1]] ?? '';
          j += cls[0].length;
        } else {
          body += pattern[j] === '\\' ? '\\\\' : pattern[j];
          j++;
        }
      }
      if (j >= pattern.length) { out += '\\['; continue; }
      out += `[${body}]`;
      i = j;
      continue;
    }
    if (c === '\\' && i + 1 < pattern.length) {
      const n = pattern[++i];
      if (n === '<' || n === '>') out += '\\b';
      else if (!extended && '(){}|+?'.includes(n)) out += n;
      else out += '\\' + n;
      continue;
    }
    if (!extended && '(){}|+?'.includes(c)) {
      out += '\\' + c;
      continue;
    }
    if (c === '*' && (out === '' || out === '^')) {
      out += '\\*'; // a leading * is literal
      continue;
    }
    out += c;
  }
  return out;
}

/** Escapes text for literal use inside a RegExp. */
export function escapeRegex(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Shell glob (*, ?, [abc]) to an anchored RegExp. */
/**
 * Joins glob pieces (regex text for literals, ? and [...], and null for each *) into regex source that
 * matches in linear time. A plain ".*" per star backtracks: *a*a*a*...*b against a long name takes
 * exponentially long and would freeze the page. Instead each star between two pieces jumps to the earliest
 * place the next piece matches, inside an atomic lookahead ((?=(.*?x))\1 never retries), and only the last
 * star is an ordinary greedy run. For full-string glob matching the earliest place is always a correct
 * choice, so the result is the same as before, minus the blow-up.
 */
export function linearGlobSource(pieces: (string | null)[], any: string): string {
  const segments: string[] = [''];
  for (const p of pieces) {
    if (p === null) {
      if (segments[segments.length - 1] !== '' || segments.length === 1) segments.push('');
    } else segments[segments.length - 1] += p;
  }
  let src = segments[0];
  for (let i = 1; i < segments.length; i++) {
    src += i < segments.length - 1 ? `(?=(${any}*?${segments[i]}))\\${i}` : `${any}*${segments[i]}`;
  }
  return src;
}

export function globToRegex(glob: string, ignoreCase = false): RegExp {
  const pieces: (string | null)[] = [];
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*') pieces.push(null);
    else if (c === '?') pieces.push('.');
    else if (c === '[') {
      const end = glob.indexOf(']', i + 1);
      if (end === -1) pieces.push('\\[');
      else {
        pieces.push('[' + glob.slice(i + 1, end).replace(/^!/, '^').replace(/\\/g, '\\\\') + ']');
        i = end;
      }
    } else pieces.push(escapeRegex(c));
  }
  return new RegExp(`^${linearGlobSource(pieces, '.')}$`, ignoreCase ? 'i' : '');
}

/** Right-aligns a number in a field, like printf("%*d"). */
export function padNum(n: number, width: number): string {
  return String(n).padStart(width, ' ');
}
