import { FileNode } from '../types/terminal';
import { getNodeAtPath, normalizePath } from './filesystem';
import { ShellSyntax, tokenizeWords } from './parser';

/** What a partly typed path can become: the path itself, what kind of name it ends in, and every match */
interface PathMatch {
  path: string;
  /** 'file' or 'dir' when a single name was finished; null when it was only extended (or left as typed) */
  end: 'file' | 'dir' | null;
  names: string[];
}

function matchPath(fs: FileNode, cwd: string, word: string, isWindows: boolean): PathMatch | null {
  const seps = isWindows ? /[\\/]/ : /\//;
  let cut = -1;
  for (let i = word.length - 1; i >= 0; i--) {
    if (seps.test(word[i])) {
      cut = i;
      break;
    }
  }
  const dirPart = word.slice(0, cut + 1);
  const base = word.slice(cut + 1);
  // `~` alone names the home folder, so complete it as `~/`
  if (!isWindows && word === '~') return { path: '~', end: 'dir', names: [] };

  const dirPath = dirPart === '' ? cwd : normalizePath(dirPart.length > 1 ? dirPart.replace(/[\\/]$/, '') : dirPart, cwd, isWindows);
  const dir = getNodeAtPath(fs, dirPath, isWindows);
  if (!dir || dir.type !== 'directory' || !dir.children) return null;

  const fold = (s: string) => (isWindows ? s.toLowerCase() : s);
  const names = Object.keys(dir.children)
    .filter(n => fold(n).startsWith(fold(base)) && (base.startsWith('.') || !n.startsWith('.')))
    .sort();
  if (names.length === 0) return null;

  if (names.length === 1) {
    return { path: dirPart + names[0], end: dir.children[names[0]].type === 'directory' ? 'dir' : 'file', names };
  }
  let prefix = names[0];
  for (const n of names) while (!fold(n).startsWith(fold(prefix))) prefix = prefix.slice(0, -1);
  // Keep what was typed when the shared prefix adds nothing, so the case the learner typed stays
  return { path: dirPart + (prefix.length > base.length ? prefix : base), end: null, names };
}

/**
 * Tab completion of a file or folder name, the way bash and Command Prompt do it: `word` is the
 * partly typed word (quotes already removed), and the result is what it can become.
 *
 * - One match: the whole name, with `/` (or `\` on Windows) after a folder and a space after a file.
 * - Several: the longest prefix they share (unchanged when there is nothing more to add), plus the names.
 * - None: null.
 *
 * Names starting with a dot are offered only when the word's last part starts with a dot, as in bash.
 * Windows names match without regard to case, and keep the case they are stored with.
 */
export function completePath(fs: FileNode, cwd: string, word: string, isWindows: boolean): { text: string; names: string[] } | null {
  const m = matchPath(fs, cwd, word, isWindows);
  if (!m) return null;
  const sep = isWindows ? '\\' : '/';
  return { text: m.path + (m.end === 'dir' ? sep : m.end === 'file' ? ' ' : ''), names: m.names };
}

type Quote = '"' | "'";

/**
 * The word the caret is in, up to the caret: where it starts in the line, its text with quotes and
 * escapes removed, and the quote it leaves open (as in `cat "my fi`).
 */
export function wordBefore(line: string, caret: number, syntax: ShellSyntax): { start: number; text: string; quote: Quote | null } {
  const esc = syntax === 'bash' ? '\\' : syntax === 'cmd' ? '^' : '`';
  let start = 0;
  let quote: Quote | null = null;
  for (let i = 0; i < caret; i++) {
    const ch = line[i];
    if (ch === esc && quote !== "'" && i + 1 < caret) {
      i++;
      continue;
    }
    if (quote) {
      if (ch === quote) quote = null;
    } else if (ch === '"' || (ch === "'" && syntax !== 'cmd')) {
      quote = ch;
    } else if (/\s/.test(ch)) {
      start = i + 1;
    }
  }
  return { start, text: tokenizeWords(line.slice(start, caret), syntax)[0]?.text ?? '', quote };
}

// Characters that would split or change a word if typed bare
const SPECIAL: Record<ShellSyntax, RegExp> = {
  bash: /[\s'"\\$`!&|;<>()*?[\]#{}]/,
  cmd: /[\s&|<>()^,;=]/,
  powershell: /[\s'"`$&|;<>(){}@#,]/,
};

/** A path written so the shell reads it back as one word; `close` ends an open quote after it */
function quotePath(path: string, syntax: ShellSyntax, open: Quote | null, close: boolean): string {
  let quote = open;
  if (!quote) {
    if (!SPECIAL[syntax].test(path)) return path;
    // bash escapes each character, as its own completion does (a leading ~ stays bare so it still means home)
    if (syntax === 'bash') return path.replace(/./g, (c, i) => (SPECIAL.bash.test(c) && !(c === '~' && i === 0) ? `\\${c}` : c));
    quote = syntax === 'cmd' || path.includes("'") ? '"' : "'";
  }
  let body = path;
  if (syntax === 'bash') body = quote === '"' ? path.replace(/["\\$`]/g, c => `\\${c}`) : path.replace(/'/g, `'\\''`);
  else if (syntax === 'powershell') body = quote === '"' ? path.replace(/["`$]/g, c => `\`${c}`) : path.replace(/'/g, "''");
  return quote + body + (close ? quote : '');
}

/**
 * Completes the file or folder name the caret is in. Text after the caret stays as it is, and the
 * caret goes to the end of the completed name. Names with spaces or other special characters are
 * quoted or escaped for the shell, so the line still runs.
 */
export function completeFileAt(
  fs: FileNode, cwd: string, line: string, caret: number, syntax: ShellSyntax,
): { line: string; caret: number; names: string[] } | null {
  const word = wordBefore(line, caret, syntax);
  const isWindows = syntax !== 'bash';
  const m = matchPath(fs, cwd, word.text, isWindows);
  if (!m) return null;
  const sep = isWindows ? '\\' : '/';
  const text = quotePath(m.path, syntax, word.quote, m.end === 'file') + (m.end === 'dir' ? sep : m.end === 'file' ? ' ' : '');
  const before = line.slice(0, word.start) + text;
  // A finished file closes the open quote; when the word already had its closing quote right after
  // the caret (`cat "qua|"`), that one is used up instead of being left as a stray extra quote
  const after = m.end === 'file' && word.quote && line[caret] === word.quote ? line.slice(caret + 1) : line.slice(caret);
  return { line: before + after, caret: before.length, names: m.names };
}
