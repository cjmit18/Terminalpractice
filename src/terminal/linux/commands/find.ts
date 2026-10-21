import { FileNode } from '../../../types/terminal';
import { applyChmod, modeBits, fileSize, removeNode } from '../../filesystem';
import { globToRegex } from '../../textUtils';
import { LinuxContext, LinuxResult, linuxCommands } from '../context';
import { runChildLine } from '../scripts';

// find PATH... [EXPRESSION]
// Supports -name -iname -type -perm -user -group -size -empty -maxdepth -mindepth,
// ! / -not, -o / -or, -a / -and, -print, -delete and -exec CMD {} \; (or +).

interface Entry { node: FileNode; abs: string; label: string; depth: number }
type Test = (e: Entry) => boolean;

class FindError extends Error {}

/** Parses a -perm MODE argument: octal or symbolic, with optional - (all bits) or / (any bit) prefix. */
function permTest(arg: string): Test {
  const prefix = arg[0] === '-' || arg[0] === '/' ? arg[0] : '';
  const body = prefix ? arg.slice(1) : arg;
  let want: number;
  if (/^[0-7]{1,4}$/.test(body)) {
    want = parseInt(body, 8);
  } else {
    const sym = applyChmod('---------', body);
    if (!sym) throw new FindError(`find: invalid mode '${arg}'`);
    const s = String(sym.octal).padStart(4, '0');
    want = (Number(s[0]) << 9) | parseInt(s.slice(1), 8);
  }
  return e => {
    const have = modeBits(e.node);
    if (prefix === '-') return (have & want) === want;
    if (prefix === '/') return want === 0 || (have & want) !== 0;
    return (have & 0o7777) === want;
  };
}

function sizeTest(arg: string): Test {
  const m = arg.match(/^([+-]?)(\d+)([bckMG]?)$/);
  if (!m) throw new FindError(`find: invalid argument \`${arg}' to \`-size'`);
  const unit = { b: 512, c: 1, k: 1024, M: 1024 ** 2, G: 1024 ** 3, '': 512 }[m[3] as 'b'];
  const n = Number(m[2]);
  return e => {
    // find rounds sizes up to whole units
    const units = Math.ceil(fileSize(e.node) / unit);
    return m[1] === '+' ? units > n : m[1] === '-' ? units < n : units === n;
  };
}

function find(ctx: LinuxContext): LinuxResult {
  const args = ctx.args;
  let i = 0;
  const starts: string[] = [];
  while (i < args.length && !args[i].startsWith('-') && args[i] !== '!' && args[i] !== '(') starts.push(args[i++]);
  if (starts.length === 0) starts.push('.');

  let maxDepth = Infinity;
  let minDepth = 0;
  const out: string[] = [];
  const errors: string[] = [];
  const stderrFromExec: string[] = [];
  let hasAction = false;
  let deleteAction = false;

  // Expression: OR of AND-groups of (optionally negated) primaries
  const groups: Test[][] = [[]];
  let negate = false;
  try {
    const need = (flag: string): string => {
      if (i >= args.length) throw new FindError(`find: missing argument to \`${flag}'`);
      return args[i++];
    };
    while (i < args.length) {
      const tok = args[i++];
      let test: Test | null = null;
      switch (tok) {
        case '!': case '-not': negate = !negate; continue;
        case '-o': case '-or': groups.push([]); continue;
        case '-a': case '-and': continue;
        case '-name': case '-iname': {
          const re = globToRegex(need(tok), tok === '-iname');
          test = e => re.test(e.node.name === '/' ? '/' : e.label.split('/').filter(Boolean).pop() ?? e.label);
          break;
        }
        case '-type': {
          const t = need(tok);
          if (!['f', 'd', 'l'].includes(t)) throw new FindError(`find: Unknown argument to -type: ${t}`);
          test = e => (t === 'f' ? e.node.type === 'file' : t === 'd' ? e.node.type === 'directory' : false);
          break;
        }
        case '-perm': test = permTest(need(tok)); break;
        case '-user': { const u = need(tok); test = e => e.node.owner === u; break; }
        case '-group': { const g = need(tok); test = e => e.node.group === g; break; }
        case '-size': test = sizeTest(need(tok)); break;
        case '-empty': test = e => (e.node.type === 'directory' ? Object.keys(e.node.children ?? {}).length === 0 : fileSize(e.node) === 0); break;
        case '-maxdepth': maxDepth = Number(need(tok)); continue;
        case '-mindepth': minDepth = Number(need(tok)); continue;
        case '-print': hasAction = true; test = e => { out.push(e.label); return true; }; break;
        case '-delete': {
          hasAction = true;
          deleteAction = true;
          test = e => {
            const check = ctx.canDelete(e.abs);
            if (!check.ok) { errors.push(`find: cannot delete '${e.label}': ${check.error}`); return false; }
            if (e.node.type === 'directory' && Object.keys(e.node.children ?? {}).length > 0) {
              errors.push(`find: cannot delete '${e.label}': Directory not empty`);
              return false;
            }
            removeNode(ctx.fs, e.abs, false);
            return true;
          };
          break;
        }
        case '-exec': case '-ok': {
          hasAction = true;
          const cmd: string[] = [];
          while (i < args.length && args[i] !== ';' && args[i] !== '+') cmd.push(args[i++]);
          if (i >= args.length) throw new FindError(`find: missing argument to \`${tok}'`);
          i++;
          const quote = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;
          test = e => {
            const line = cmd.map(c => (c === '{}' ? quote(e.label) : quote(c).replace(/\{\}/g, e.label))).join(' ');
            const res = runChildLine(ctx, line);
            if (res.stdout) out.push(res.stdout);
            if (res.stderr) stderrFromExec.push(res.stderr);
            return res.exitCode === 0;
          };
          break;
        }
        default:
          throw new FindError(tok.startsWith('-') ? `find: unknown predicate \`${tok}'` : `find: paths must precede expression: \`${tok}'`);
      }
      const t = test!;
      groups[groups.length - 1].push(negate ? e => !t(e) : t);
      negate = false;
    }
  } catch (e) {
    if (e instanceof FindError) return ctx.fail(e.message);
    throw e;
  }

  const matches = (e: Entry) => groups.some(g => g.every(t => t(e)));
  const visit = (e: Entry) => {
    const apply = () => {
      if (e.depth >= minDepth && matches(e) && !hasAction) out.push(e.label);
    };
    const descend = () => {
      if (e.node.type !== 'directory' || e.depth >= maxDepth) return;
      const why = `Searching inside ${e.abs} needs read (r) and execute (x) on it, but it`;
      if (!ctx.access(e.node, e.abs, 'r', why).ok || !ctx.access(e.node, e.abs, 'x', why).ok) {
        errors.push(`find: '${e.label}': Permission denied`);
        return;
      }
      for (const name of Object.keys(e.node.children ?? {}).sort()) {
        const child = e.node.children?.[name];
        if (!child) continue; // removed by -delete or -exec
        visit({
          node: child,
          abs: e.abs === '/' ? `/${name}` : `${e.abs}/${name}`,
          label: e.label.endsWith('/') ? e.label + name : `${e.label}/${name}`,
          depth: e.depth + 1,
        });
      }
    };
    if (deleteAction) { descend(); apply(); }
    else { apply(); descend(); }
  };

  for (const s of starts) {
    const abs = ctx.resolve(s);
    if (!ctx.traverse(abs).ok) { errors.push(`find: '${s}': Permission denied`); continue; }
    const node = ctx.node(abs);
    if (!node) { errors.push(`find: '${s}': No such file or directory`); continue; }
    visit({ node, abs, label: s, depth: 0 });
  }
  return ctx.result(out.join('\n'), [...errors, ...stderrFromExec].join('\n'), errors.length ? 1 : 0);
}

linuxCommands.register('find', find);
