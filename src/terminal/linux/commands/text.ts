
import { LinuxContext, LinuxResult, linuxCommands } from '../context';

// Text processing: echo, head, tail, grep, awk, sed, sort, uniq, wc

function echo(ctx: LinuxContext): LinuxResult {
  const text = ctx.args.map(arg => arg
    .replace(/\$USER/g, ctx.state.currentUser)
    .replace(/\$HOSTNAME/g, ctx.state.hostname)
    .replace(/\$HOME/g, '/home/student')
  ).join(' ');
  return ctx.ok(text);
}

function headOrTail(which: 'head' | 'tail') {
  return (ctx: LinuxContext): LinuxResult => {
    const { args } = ctx;
    let count = 10;
    let filename = '';
    for (let i = 0; i < args.length; i++) {
      if (args[i] === '-n' && args[i + 1]) {
        count = parseInt(args[i + 1], 10) || 10;
        i++;
      } else if (args[i].startsWith('-') && /^\-\d+$/.test(args[i])) {
        count = parseInt(args[i].slice(1), 10) || 10;
      } else {
        filename = args[i];
      }
    }
    let content = ctx.stdin;
    if (filename) {
      const targetPath = ctx.resolve(filename);
      const node = ctx.node(targetPath);
      if (!node || node.type !== 'file') return ctx.fail(`${which}: cannot open '${filename}'`);
      const readCheck = ctx.canRead(targetPath);
      if (!readCheck.ok) return ctx.fail(`${which}: cannot open '${filename}': ${readCheck.error || 'Permission denied'}`);
      content = node.content || '';
    }
    const all = content.split('\n');
    const lines = which === 'head' ? all.slice(0, count) : all.slice(Math.max(0, all.length - count));
    return ctx.ok(lines.join('\n'));
  };
}

function grep(ctx: LinuxContext): LinuxResult {
  let ignoreCase = false;
  let invert = false;
  let countOnly = false;
  let pattern = '';
  let fileArg = '';

  for (const a of ctx.args) {
    if (a === '-i') ignoreCase = true;
    else if (a === '-v') invert = true;
    else if (a === '-c') countOnly = true;
    else if (!pattern) pattern = a;
    else if (!fileArg) fileArg = a;
  }

  let content = ctx.stdin;
  if (fileArg) {
    const targetPath = ctx.resolve(fileArg);
    const node = ctx.node(targetPath);
    if (!node || node.type !== 'file') return ctx.fail(`grep: ${fileArg}: No such file or directory`, 2);
    const check = ctx.canRead(targetPath);
    if (!check.ok) return ctx.fail(`grep: ${fileArg}: ${check.error || 'Permission denied'}`, 2);
    content = node.content || '';
  }

  const matches = content.split('\n').filter(l => {
    let text = l;
    let p = pattern;
    if (ignoreCase) {
      text = text.toLowerCase();
      p = p.toLowerCase();
    }
    const has = text.includes(p);
    return invert ? !has : has;
  });

  const code = matches.length > 0 ? 0 : 1;
  return ctx.result(countOnly ? matches.length.toString() : matches.join('\n'), '', code);
}

function awk(ctx: LinuxContext): LinuxResult {
  const { args } = ctx;
  let delimiter = /\s+/;
  let expr = '';
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '-F' && args[i + 1]) {
      delimiter = new RegExp(args[i + 1].replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
      i++;
    } else if (args[i].startsWith('-F')) {
      delimiter = new RegExp(args[i].slice(2).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
    } else if (!expr) {
      expr = args[i];
    }
  }

  const resolveField = (fields: string[], token: string): string => {
    if (token === 'NF') return fields[fields.length - 1] ?? '';
    const m = token.match(/^\(NF-(\d+)\)$/);
    if (m) return fields[fields.length - 1 - Number(m[1])] ?? '';
    const n = Number(token);
    return n === 0 ? fields.join(' ') : fields[n - 1] ?? '';
  };

  const tokens = [...expr.matchAll(/\$(NF|\(NF-\d+\)|\d+)/g)].map(t => t[1]);
  const isWhitespace = delimiter.source === '\\s+';
  const out: string[] = [];
  for (const line of ctx.stdin.split('\n').filter(Boolean)) {
    const fields = isWhitespace ? line.trim().split(delimiter) : line.split(delimiter);
    out.push(tokens.length === 0 ? line : tokens.map(t => resolveField(fields, t)).join(' '));
  }
  return ctx.ok(out.join('\n'));
}

function sed(ctx: LinuxContext): LinuxResult {
  const pattern = ctx.args[0] || '';
  const sMatch = pattern.match(/s\/(.*?)\/(.*?)\/([g]?)/);
  if (sMatch) {
    const regex = new RegExp(sMatch[1], sMatch[3] === 'g' ? 'g' : '');
    return ctx.ok(ctx.stdin.replace(regex, sMatch[2]));
  }
  return ctx.ok(ctx.stdin);
}

function sort(ctx: LinuxContext): LinuxResult {
  const lines = ctx.stdin.split('\n').filter(Boolean);
  const reverse = ctx.args.includes('-r');
  lines.sort((a, b) => reverse ? b.localeCompare(a) : a.localeCompare(b));
  return ctx.ok(lines.join('\n'));
}

function uniq(ctx: LinuxContext): LinuxResult {
  const lines = ctx.stdin.split('\n').filter(Boolean);
  const withCount = ctx.args.includes('-c');
  const counts: { [key: string]: number } = {};
  const uniqueKeys: string[] = [];
  for (const line of lines) {
    if (!counts[line]) {
      counts[line] = 0;
      uniqueKeys.push(line);
    }
    counts[line]++;
  }
  return ctx.ok(uniqueKeys.map(k => withCount ? `   ${counts[k]} ${k}` : k).join('\n'));
}

function wc(ctx: LinuxContext): LinuxResult {
  const { args } = ctx;
  let content = ctx.stdin;
  if (args.length > 0 && !args[0].startsWith('-')) {
    const node = ctx.node(ctx.resolve(args[0]));
    if (node && node.type === 'file') content = node.content || '';
  }
  const lines = content.length === 0 ? 0 : (content.split('\n').length - (content.endsWith('\n') ? 1 : 0));
  const words = content.trim().split(/\s+/).filter(Boolean).length;
  const bytes = content.length;
  if (args.includes('-l')) return ctx.ok(lines.toString());
  return ctx.ok(`${lines} ${words} ${bytes}`);
}

linuxCommands.registerAll({ echo, head: headOrTail('head'), tail: headOrTail('tail'), grep, awk, sed, sort, uniq, wc });
