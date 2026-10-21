// Bash pathname expansion (globbing) over the virtual filesystem.
import { FileNode } from '../../types/terminal';
import { checkNodePermission, getNodeAtPath, normalizePath } from '../filesystem';
import { globToRegex } from '../textUtils';

const WILDCARD = /[*?[]/;

interface GlobUser {
  user: string;
  groups: string[];
  isRoot: boolean;
}

/**
 * Expands one glob pattern the way bash does: matches are sorted, a leading dot must be matched
 * explicitly, directories you cannot read yield no matches, and results keep the form you typed
 * (relative stays relative, `~` and absolute paths stay as typed). Returns [] when nothing matches.
 */
export function expandGlob(pattern: string, cwd: string, fs: FileNode, who: GlobUser): string[] {
  const absolute = pattern.startsWith('/');
  const home = pattern === '~' || pattern.startsWith('~/');
  const segments = pattern.split('/').filter((seg, i) => seg !== '' || i === 0);
  // Each candidate: the text to print and the absolute path it stands for
  let candidates: { shown: string; abs: string }[] = absolute
    ? [{ shown: '', abs: '/' }]
    : home
      ? [{ shown: '~', abs: normalizePath('~', cwd, false) }]
      : [{ shown: '', abs: cwd }];
  const parts = absolute ? segments.slice(1) : home ? segments.slice(1) : segments;

  parts.forEach((seg, idx) => {
    const last = idx === parts.length - 1;
    const next: { shown: string; abs: string }[] = [];
    for (const c of candidates) {
      const join = (name: string) => ({
        shown: c.shown === '' ? (absolute ? `/${name}` : name) : `${c.shown}/${name}`,
        abs: normalizePath(name, c.abs, false),
      });
      if (!WILDCARD.test(seg)) {
        // A literal segment: keep it if the path exists (bash checks this only for the final match list)
        const literal = seg.replace(/\[([*?[])\]/g, '$1');
        const node = getNodeAtPath(fs, join(literal).abs, false);
        if (node && (!last ? node.type === 'directory' : true)) next.push(join(literal));
        continue;
      }
      const dir = getNodeAtPath(fs, c.abs, false);
      if (!dir || dir.type !== 'directory' || !dir.children) continue;
      if (!who.isRoot && !checkNodePermission(dir, who.user, who.groups, 'r')) continue;
      const re = globToRegex(seg);
      const allowDot = seg.startsWith('.');
      for (const name of Object.keys(dir.children).sort()) {
        if (name.startsWith('.') && !allowDot) continue;
        if (!re.test(name)) continue;
        if (!last && dir.children[name].type !== 'directory') continue;
        next.push(join(name));
      }
    }
    candidates = next;
  });

  // A trailing slash in the pattern ("dir*/") keeps directories only and keeps the slash
  const trailingSlash = pattern.endsWith('/') && pattern.length > 1;
  return candidates
    .filter(c => !trailingSlash || getNodeAtPath(fs, c.abs, false)?.type === 'directory')
    .map(c => (trailingSlash ? `${c.shown}/` : c.shown))
    .sort((a, b) => a.localeCompare(b, 'en', { sensitivity: 'base' }) || (a < b ? -1 : 1));
}

/** Expands every arg that has a pattern; args whose pattern matches nothing are passed on literally. */
export function expandArgs(args: string[], globs: (string | undefined)[] | undefined, cwd: string, fs: FileNode, who: GlobUser): string[] {
  if (!globs) return args;
  return args.flatMap((arg, i) => {
    const pattern = globs[i];
    if (!pattern) return [arg];
    const matches = expandGlob(pattern, cwd, fs, who);
    return matches.length ? matches : [arg];
  });
}
