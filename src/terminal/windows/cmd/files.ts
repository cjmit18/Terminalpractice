import { fileSize } from '../../filesystem';
import { WindowsContext, WindowsResult, cmdCommands } from '../context';

// CMD navigation and file commands: cd/chdir, dir, type, more

function cd(ctx: WindowsContext): WindowsResult {
  if (ctx.args.length === 0) return ctx.ok(ctx.cwd);
  const resolved = ctx.resolve(ctx.args[0]);
  if (!ctx.node(resolved)) return ctx.fail('The system cannot find the path specified.');
  ctx.cwd = resolved;
  return ctx.ok();
}

function dir(ctx: WindowsContext): WindowsResult {
  const resolved = ctx.resolve(ctx.args[0] || '.');
  const node = ctx.node(resolved);
  if (!node) return ctx.fail('File Not Found');

  const lines = [
    ' Volume in drive C has no label.',
    ' Volume Serial Number is 4C19-A3F2',
    '',
    ` Directory of ${resolved}`,
    '',
    '10/19/2026  09:00 AM    <DIR>          .',
    '10/19/2026  09:00 AM    <DIR>          ..',
  ];
  let fileCount = 0;
  let totalBytes = 0;
  let dirCount = 2;
  for (const [key, child] of Object.entries(node.children || {})) {
    if (child.type === 'directory') {
      dirCount++;
      lines.push(`10/19/2026  09:30 AM    <DIR>          ${key}`);
    } else {
      fileCount++;
      const sz = fileSize(child);
      totalBytes += sz;
      lines.push(`10/19/2026  09:45 AM            ${sz.toLocaleString().padStart(8, ' ')} ${key}`);
    }
  }
  lines.push(`               ${fileCount} File(s)     ${totalBytes.toLocaleString()} bytes`);
  lines.push(`               ${dirCount} Dir(s)  120,412,891,136 bytes free`);
  return ctx.ok(lines.join('\n'));
}

function type(ctx: WindowsContext): WindowsResult {
  if (ctx.args.length === 0) return ctx.fail('The syntax of the command is incorrect.');
  const node = ctx.node(ctx.resolve(ctx.args[0]));
  if (!node || node.type !== 'file') return ctx.fail('The system cannot find the file specified.');
  return ctx.ok(node.content || '');
}

cmdCommands.register(['cd', 'chdir'], cd);
cmdCommands.registerAll({ dir, type, more: ctx => ctx.ok(ctx.stdin) });
