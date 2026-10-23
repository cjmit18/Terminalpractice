import { FileNode } from '../types/terminal';
import { getNodeAtPath, normalizePath } from './filesystem';

/**
 * Tab completion of a file or folder name, the way bash and Command Prompt do it: `word` is the
 * partly typed last word of the line, and the result is what it can become.
 *
 * - One match: the whole name, with `/` (or `\` on Windows) after a folder and a space after a file.
 * - Several: the longest prefix they share (unchanged when there is nothing more to add), plus the names.
 * - None: null.
 *
 * Names starting with a dot are offered only when the word's last part starts with a dot, as in bash.
 * Windows names match without regard to case, and keep the case they are stored with.
 */
export function completePath(fs: FileNode, cwd: string, word: string, isWindows: boolean): { text: string; names: string[] } | null {
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
  if (!isWindows && word === '~') return { text: '~/', names: [] };

  const dirPath = dirPart === '' ? cwd : normalizePath(dirPart.length > 1 ? dirPart.replace(/[\\/]$/, '') : dirPart, cwd, isWindows);
  const dir = getNodeAtPath(fs, dirPath, isWindows);
  if (!dir || dir.type !== 'directory' || !dir.children) return null;

  const fold = (s: string) => (isWindows ? s.toLowerCase() : s);
  const names = Object.keys(dir.children)
    .filter(n => fold(n).startsWith(fold(base)) && (base.startsWith('.') || !n.startsWith('.')))
    .sort();
  if (names.length === 0) return null;

  const sep = isWindows ? '\\' : '/';
  if (names.length === 1) {
    const node = dir.children[names[0]];
    return { text: dirPart + names[0] + (node.type === 'directory' ? sep : ' '), names };
  }
  let prefix = names[0];
  for (const n of names) while (!fold(n).startsWith(fold(prefix))) prefix = prefix.slice(0, -1);
  // Keep what was typed when the shared prefix adds nothing, so the case the learner typed stays
  return { text: dirPart + (prefix.length > base.length ? prefix : base), names };
}
