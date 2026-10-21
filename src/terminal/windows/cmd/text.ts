import { WindowsContext, WindowsResult, cmdCommands } from '../context';

// CMD text commands: cls, echo, findstr

function findstr(ctx: WindowsContext): WindowsResult {
  const { args } = ctx;
  let ignoreCase = false;
  let invert = false;
  let pattern = '';
  for (const a of args) {
    if (a.toLowerCase() === '/i') ignoreCase = true;
    else if (a.toLowerCase() === '/v') invert = true;
    else if (!pattern && !a.startsWith('/')) pattern = a;
  }
  let content = ctx.stdin;
  if (!ctx.stdin && args.length > 0) {
    const lastArg = args[args.length - 1];
    if (lastArg !== pattern && !lastArg.startsWith('/')) {
      const abs = ctx.resolve(lastArg);
      const why = ctx.protectedReason(abs, 'read');
      if (why) return ctx.fail('Access is denied.', 1, why);
      const node = ctx.node(abs);
      if (node && node.type === 'file') content = node.content || '';
    }
  }
  const matches = content.split(/\r?\n/).filter(l => {
    let text = l;
    let p = pattern;
    if (ignoreCase) {
      text = text.toLowerCase();
      p = p.toLowerCase();
    }
    const has = text.includes(p);
    return invert ? !has : has;
  });
  return ctx.result(matches.join('\r\n'), '', matches.length > 0 ? 0 : 1);
}

/**
 * The text after echo exactly as typed: CMD keeps quotes and spacing, removes ^ escapes, and
 * stops at an unquoted redirection.
 */
export function echoText(raw: string): string {
  const body = raw.replace(/^\s*\S+?(?=[\s.:]|$)[.:]?\s?/, '');
  let out = '';
  let quoted = false;
  for (let i = 0; i < body.length; i++) {
    const ch = body[i];
    if (ch === '"') quoted = !quoted;
    if (!quoted && ch === '^' && i + 1 < body.length) { out += body[++i]; continue; }
    if (!quoted && (ch === '>' || ch === '<')) {
      // 2> and 1> belong to the redirection too
      if (/(^|\s)[12]$/.test(out)) out = out.slice(0, -1);
      break;
    }
    out += ch;
  }
  return out.trimEnd();
}

function echo(ctx: WindowsContext): WindowsResult {
  const text = echoText(ctx.raw);
  if (!text) return ctx.ok('ECHO is on.');
  // echo on / echo off change command echoing (not modelled) and print nothing
  if (/^(on|off)$/i.test(text)) return ctx.ok('');
  return ctx.ok(text);
}

cmdCommands.registerAll({
  cls: ctx => ctx.ok('\x1b[2J\x1b[0;0H'),
  echo,
  'echo.': ctx => ctx.ok(echoText(ctx.raw)),
  findstr,
});
