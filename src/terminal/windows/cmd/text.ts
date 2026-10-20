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
      const node = ctx.node(ctx.resolve(lastArg));
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

cmdCommands.registerAll({
  cls: ctx => ctx.ok('\x1b[2J\x1b[0;0H'),
  echo: ctx => ctx.ok(ctx.args.join(' ')),
  findstr,
});
