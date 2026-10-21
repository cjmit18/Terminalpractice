// GNU getopt checks for the common coreutils and grep: an option the real command does not know
// stops it before it does anything, with the real message (`rm -Q file` must not delete the file).
// The tables list every option the real tools accept (from their --help), not only the ones the
// simulator acts on, so a valid option is never reported as invalid.

interface OptionSpec {
  /** Short options without a value */
  flags: string;
  /** Short options that take a value (the rest of the word, or the next argument) */
  values?: string;
  /** Long options; a trailing '=' means a required value, '?' an optional one (--color[=WHEN]) */
  long: string[];
  /** -NUM is accepted (head -5, tail -20, grep -2) */
  numeric?: boolean;
  /** Exit status for a bad option (2 for ls, grep and sort; 1 for the others) */
  code?: number;
  /** Extra line printed before "Try ..." (grep prints its usage) */
  usage?: string;
}

const COMMON = ['help', 'version'];

const SPECS: Record<string, OptionSpec> = {
  rm: { flags: 'fiIrRdv', long: ['force', 'interactive?', 'one-file-system', 'no-preserve-root', 'preserve-root?', 'recursive', 'dir', 'verbose'] },
  cp: {
    flags: 'abdfiHlLnPpRrsTuvxZ', values: 'St',
    long: ['archive', 'attributes-only', 'backup?', 'copy-contents', 'debug', 'force', 'interactive', 'link', 'dereference',
      'no-clobber', 'no-dereference', 'preserve?', 'no-preserve=', 'parents', 'recursive', 'reflink?', 'remove-destination',
      'sparse=', 'strip-trailing-slashes', 'symbolic-link', 'suffix=', 'target-directory=', 'no-target-directory', 'update?',
      'verbose', 'one-file-system', 'context?'],
  },
  mv: {
    flags: 'bfinTuvZ', values: 'St',
    long: ['backup?', 'debug', 'force', 'interactive', 'no-clobber', 'no-copy', 'strip-trailing-slashes', 'suffix=',
      'target-directory=', 'no-target-directory', 'update?', 'verbose', 'context', 'exchange'],
  },
  mkdir: { flags: 'pvZ', values: 'm', long: ['mode=', 'parents', 'verbose', 'context?'] },
  rmdir: { flags: 'pv', long: ['ignore-fail-on-non-empty', 'parents', 'verbose'] },
  ls: {
    flags: 'aAbBcCdDfFgGhHikLlmnNopqQrRsStuUvxXZ1', values: 'ITw', code: 2,
    long: ['all', 'almost-all', 'author', 'escape', 'block-size=', 'ignore-backups', 'color?', 'colour?', 'directory', 'dired',
      'classify?', 'file-type', 'format=', 'full-time', 'group-directories-first', 'no-group', 'human-readable', 'si',
      'dereference-command-line', 'dereference-command-line-symlink-to-dir', 'hide=', 'hyperlink?', 'indicator-style=',
      'inode', 'ignore=', 'kibibytes', 'dereference', 'numeric-uid-gid', 'literal', 'hide-control-chars',
      'show-control-chars', 'quote-name', 'quoting-style=', 'reverse', 'recursive', 'size', 'sort=', 'time=', 'time-style=',
      'tabsize=', 'width=', 'context', 'zero'],
  },
  cat: { flags: 'AbeEnstTuv', long: ['show-all', 'number-nonblank', 'show-ends', 'number', 'squeeze-blank', 'show-tabs', 'show-nonprinting'] },
  touch: { flags: 'acfhm', values: 'drt', long: ['no-create', 'date=', 'no-dereference', 'reference=', 'time='] },
  // chmod also takes modes such as -w or -rwx where an option would go
  chmod: { flags: 'cfvRrwxXstugoa,+=01234567', long: ['changes', 'silent', 'quiet', 'verbose', 'no-preserve-root', 'preserve-root', 'reference=', 'recursive'] },
  chown: { flags: 'cfvhRHLP', long: ['changes', 'silent', 'quiet', 'verbose', 'dereference', 'no-dereference', 'from=', 'no-preserve-root', 'preserve-root', 'reference=', 'recursive'] },
  chgrp: { flags: 'cfvhRHLP', long: ['changes', 'silent', 'quiet', 'verbose', 'dereference', 'no-dereference', 'no-preserve-root', 'preserve-root', 'reference=', 'recursive'] },
  head: { flags: 'qvz', values: 'cn', numeric: true, long: ['bytes=', 'lines=', 'quiet', 'silent', 'verbose', 'zero-terminated'] },
  tail: {
    flags: 'fFqvz', values: 'cns', numeric: true,
    long: ['bytes=', 'follow?', 'lines=', 'max-unchanged-stats=', 'pid=', 'quiet', 'silent', 'retry', 'sleep-interval=', 'verbose', 'zero-terminated'],
  },
  sort: {
    flags: 'bdfgiMhnRrVcCmsuz', values: 'koStT', code: 2,
    long: ['ignore-leading-blanks', 'dictionary-order', 'ignore-case', 'general-numeric-sort', 'ignore-nonprinting', 'month-sort',
      'human-numeric-sort', 'numeric-sort', 'random-sort', 'random-source=', 'reverse', 'sort=', 'version-sort', 'batch-size=',
      'check?', 'compress-program=', 'debug', 'files0-from=', 'key=', 'merge', 'output=', 'stable', 'buffer-size=',
      'field-separator=', 'temporary-directory=', 'parallel=', 'unique', 'zero-terminated'],
  },
  uniq: { flags: 'cdDiuz', values: 'fsw', long: ['count', 'repeated', 'all-repeated?', 'skip-fields=', 'group?', 'ignore-case', 'skip-chars=', 'unique', 'zero-terminated', 'check-chars='] },
  wc: { flags: 'cmlLw', long: ['bytes', 'chars', 'lines', 'files0-from=', 'max-line-length', 'words', 'total='] },
  grep: {
    flags: 'EFGPiywxzsvVbnHhoqaIrRLlcTZUu', values: 'efmdDABC', numeric: true, code: 2,
    usage: 'Usage: grep [OPTION]... PATTERNS [FILE]...',
    long: ['extended-regexp', 'fixed-strings', 'basic-regexp', 'perl-regexp', 'regexp=', 'file=', 'ignore-case', 'no-ignore-case',
      'word-regexp', 'line-regexp', 'null-data', 'no-messages', 'invert-match', 'max-count=', 'byte-offset', 'line-number',
      'no-line-number', 'line-buffered', 'with-filename', 'no-filename', 'label=', 'only-matching', 'quiet', 'silent',
      'binary-files=', 'text', 'directories=', 'devices=', 'recursive', 'dereference-recursive', 'include=', 'exclude=',
      'exclude-from=', 'exclude-dir=', 'files-without-match', 'files-with-matches', 'count', 'initial-tab', 'null',
      'before-context=', 'after-context=', 'context=', 'group-separator=', 'no-group-separator', 'color?', 'colour?', 'binary'],
  },
  cut: { flags: 'nszM', values: 'bcdf', long: ['bytes=', 'characters=', 'delimiter=', 'fields=', 'complement', 'only-delimited', 'output-delimiter=', 'zero-terminated'] },
  ln: {
    flags: 'bdFfiLnPrsTv', values: 'St',
    long: ['backup?', 'directory', 'force', 'interactive', 'logical', 'no-dereference', 'physical', 'relative', 'symbolic', 'suffix=', 'target-directory=', 'no-target-directory', 'verbose'],
  },
};
SPECS.egrep = SPECS.fgrep = SPECS.grep;

/**
 * Checks a command's arguments the way GNU getopt_long does (options may follow operands,
 * "--" ends them, long options may be abbreviated). Returns the error to print and its exit
 * status, or null when every option is valid (or the command is not one of those checked).
 * When valid, abbreviated long options in `args` are replaced by their full names (--rec → --recursive)
 * so the command's own parsing sees what getopt would have handed it.
 */
export function checkOptions(cmd: string, args: string[]): { stderr: string; code: number } | null {
  const spec = SPECS[cmd];
  if (!spec) return null;
  const expanded: [number, string][] = [];
  const tryLine = `${spec.usage ? spec.usage + '\n' : ''}Try '${cmd} --help' for more information.`;
  const bad = (msg: string) => ({ stderr: `${cmd}: ${msg}\n${tryLine}`, code: spec.code ?? 1 });
  const longs = [...spec.long, ...COMMON];
  const names = longs.map(l => l.replace(/[=?]$/, ''));

  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--') break;
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      const name = a.slice(2, eq === -1 ? undefined : eq);
      let idx = names.indexOf(name);
      if (idx === -1) {
        const matches = names.filter(n => n.startsWith(name));
        if (matches.length === 0) return bad(`unrecognized option '${a}'`);
        if (matches.length > 1) {
          return bad(`option '${a.slice(0, eq === -1 ? undefined : eq)}' is ambiguous; possibilities: ${matches.map(m => `'--${m}'`).join(' ')}`);
        }
        idx = names.indexOf(matches[0]);
        expanded.push([i, `--${matches[0]}${eq === -1 ? '' : a.slice(eq)}`]);
      }
      const kind = longs[idx].slice(-1);
      const full = names[idx];
      if (kind === '=' && eq === -1) {
        if (i + 1 >= args.length) return bad(`option '--${full}' requires an argument`);
        i++;
      } else if (kind !== '=' && kind !== '?' && eq !== -1) {
        return bad(`option '--${full}' doesn't allow an argument`);
      }
      continue;
    }
    if (!a.startsWith('-') || a === '-') continue;
    if (spec.numeric && /^-\d+$/.test(a)) continue;
    for (let j = 1; j < a.length; j++) {
      const c = a[j];
      if (spec.values?.includes(c)) {
        if (j === a.length - 1) {
          if (i + 1 >= args.length) return bad(`option requires an argument -- '${c}'`);
          i++;
        }
        break;
      }
      if (spec.numeric && /\d/.test(c)) continue;
      if (!spec.flags.includes(c)) return bad(`invalid option -- '${c}'`);
    }
  }
  for (const [i, full] of expanded) args[i] = full;
  return null;
}
