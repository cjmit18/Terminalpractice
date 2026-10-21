import { FileNode } from '../../../types/terminal';
import { createNode, writeFileContent, modeBits, toOctalField, getNodeAtPath } from '../../filesystem';
import { parseOptions } from '../../textUtils';
import { LinuxContext, LinuxResult, linuxCommands } from '../context';

// cp and mv

const TRY = (cmd: string) => `\nTry '${cmd} --help' for more information.`;
const baseName = (p: string) => p.split('/').filter(Boolean).pop() ?? p;
const parentPath = (p: string) => '/' + p.split('/').filter(Boolean).slice(0, -1).join('/');
const joinLabel = (dir: string, name: string) => (dir.endsWith('/') ? dir + name : `${dir}/${name}`);

/** Validates "SOURCE... DEST" operands and resolves where each source lands. */
function plan(ctx: LinuxContext, cmd: 'cp' | 'mv', operands: string[]):
  { error?: LinuxResult; moves?: { src: string; srcAbs: string; dest: string; destAbs: string }[] } {
  if (operands.length === 0) return { error: ctx.fail(`${cmd}: missing file operand${TRY(cmd)}`) };
  if (operands.length === 1) {
    return { error: ctx.fail(`${cmd}: missing destination file operand after '${operands[0]}'${TRY(cmd)}`) };
  }
  const destArg = operands[operands.length - 1];
  const destAbs = ctx.resolve(destArg);
  const destNode = ctx.node(destAbs);
  const sources = operands.slice(0, -1);
  const intoDir = destNode?.type === 'directory';
  if (sources.length > 1 && !intoDir) {
    return { error: ctx.fail(`${cmd}: target '${destArg}' is not a directory`) };
  }
  return {
    moves: sources.map(src => {
      const srcAbs = ctx.resolve(src);
      return intoDir
        ? { src, srcAbs, dest: joinLabel(destArg, baseName(srcAbs)), destAbs: joinLabel(destAbs, baseName(srcAbs)).replace(/^\/\//, '/') }
        : { src, srcAbs, dest: destArg, destAbs };
    }),
  };
}

function cp(ctx: LinuxContext): LinuxResult {
  const opts = parseOptions(ctx.args, 'S', {
    recursive: 'r', archive: 'a', verbose: 'v', force: 'f', interactive: 'i', 'no-clobber': 'n', preserve: 'p',
  });
  const f = opts.flags;
  const recursive = f.has('r') || f.has('R') || f.has('a');
  const preserve = f.has('p') || f.has('a');
  const p = plan(ctx, 'cp', opts.operands);
  if (p.error) return p.error;

  const errors: string[] = [];
  const out: string[] = [];
  const newMode = (node: FileNode) => (preserve ? node.octal : toOctalField(modeBits(node) & 0o777 & ~ctx.state.umask));

  const copy = (node: FileNode, srcAbs: string, srcLabel: string, destAbs: string, destLabel: string): void => {
    const existing = ctx.node(destAbs);
    if (node.type === 'file') {
      if (!ctx.access(node, srcAbs, 'r').ok) {
        errors.push(`cp: cannot open '${srcLabel}' for reading: Permission denied`);
        return;
      }
      if (existing?.type === 'directory') {
        errors.push(`cp: cannot overwrite directory '${destLabel}' with non-directory`);
        return;
      }
      if (existing && f.has('n')) return;
      const check = existing ? ctx.access(existing, destAbs, 'w') : ctx.canWrite(destAbs);
      if (!check.ok) {
        errors.push(`cp: cannot create regular file '${destLabel}': ${check.error}`);
        return;
      }
      if (existing) {
        writeFileContent(existing, node.content || '');
      } else {
        createNode(ctx.fs, destAbs, 'file', node.content || '', false, preserve && ctx.isRoot ? node.owner : ctx.user,
          preserve && ctx.isRoot ? node.group : ctx.group, newMode(node));
      }
    } else {
      if (!recursive) {
        errors.push(`cp: -r not specified; omitting directory '${srcLabel}'`);
        return;
      }
      if (!ctx.access(node, srcAbs, 'r').ok || !ctx.access(node, srcAbs, 'x').ok) {
        errors.push(`cp: cannot access '${srcLabel}': Permission denied`);
        return;
      }
      if (existing && existing.type !== 'directory') {
        errors.push(`cp: cannot overwrite non-directory '${destLabel}' with directory '${srcLabel}'`);
        return;
      }
      if (!existing) {
        const check = ctx.canWrite(destAbs);
        if (!check.ok) {
          errors.push(`cp: cannot create directory '${destLabel}': ${check.error}`);
          return;
        }
        createNode(ctx.fs, destAbs, 'directory', '', false, ctx.user, ctx.group, newMode(node));
      }
      for (const name of Object.keys(node.children ?? {}).sort()) {
        copy(node.children![name], joinLabel(srcAbs, name), joinLabel(srcLabel, name), joinLabel(destAbs, name), joinLabel(destLabel, name));
      }
    }
    if (f.has('v')) out.push(`'${srcLabel}' -> '${destLabel}'`);
  };

  for (const m of p.moves!) {
    if (!ctx.traverse(m.srcAbs).ok) { errors.push(`cp: cannot stat '${m.src}': Permission denied`); continue; }
    const node = ctx.node(m.srcAbs);
    if (!node) { errors.push(`cp: cannot stat '${m.src}': No such file or directory`); continue; }
    if (m.destAbs === m.srcAbs) { errors.push(`cp: '${m.src}' and '${m.dest}' are the same file`); continue; }
    if (node.type === 'directory' && recursive && m.destAbs.startsWith(m.srcAbs + '/')) {
      errors.push(`cp: cannot copy a directory, '${m.src}', into itself, '${m.dest}'`);
      continue;
    }
    copy(node, m.srcAbs, m.src, m.destAbs, m.dest);
  }
  return ctx.result(out.join('\n'), errors.join('\n'), errors.length ? 1 : 0);
}

function mv(ctx: LinuxContext): LinuxResult {
  const opts = parseOptions(ctx.args, 'S', { verbose: 'v', force: 'f', interactive: 'i', 'no-clobber': 'n' });
  const p = plan(ctx, 'mv', opts.operands);
  if (p.error) return p.error;
  const errors: string[] = [];
  const out: string[] = [];

  for (const m of p.moves!) {
    if (!ctx.traverse(m.srcAbs).ok) { errors.push(`mv: cannot stat '${m.src}': Permission denied`); continue; }
    const node = ctx.node(m.srcAbs);
    if (!node) { errors.push(`mv: cannot stat '${m.src}': No such file or directory`); continue; }
    if (m.destAbs === m.srcAbs) { errors.push(`mv: '${m.src}' and '${m.dest}' are the same file`); continue; }
    if (node.type === 'directory' && m.destAbs.startsWith(m.srcAbs + '/')) {
      errors.push(`mv: cannot move '${m.src}' to a subdirectory of itself, '${m.dest}'`);
      continue;
    }
    const existing = ctx.node(m.destAbs);
    if (existing && opts.flags.has('n')) continue;
    if (existing?.type === 'directory' && node.type !== 'directory') {
      errors.push(`mv: cannot overwrite directory '${m.dest}' with non-directory`);
      continue;
    }
    if (existing && existing.type !== 'directory' && node.type === 'directory') {
      errors.push(`mv: cannot overwrite non-directory '${m.dest}' with directory '${m.src}'`);
      continue;
    }
    if (existing?.type === 'directory' && Object.keys(existing.children ?? {}).length > 0) {
      errors.push(`mv: cannot move '${m.src}' to '${m.dest}': Directory not empty`);
      continue;
    }
    // A rename edits two directories: the source's (remove entry) and the destination's (add entry)
    const leave = ctx.canDelete(m.srcAbs);
    const arrive = existing ? ctx.canDelete(m.destAbs) : ctx.canWrite(m.destAbs);
    const blocked = !leave.ok ? leave : !arrive.ok ? arrive : null;
    if (blocked) {
      errors.push(`mv: cannot move '${m.src}' to '${m.dest}': ${blocked.error}`);
      continue;
    }
    const from = getNodeAtPath(ctx.fs, parentPath(m.srcAbs), false)!;
    const to = getNodeAtPath(ctx.fs, parentPath(m.destAbs), false);
    if (!to || to.type !== 'directory') {
      errors.push(`mv: cannot move '${m.src}' to '${m.dest}': No such file or directory`);
      continue;
    }
    delete from.children![baseName(m.srcAbs)];
    node.name = baseName(m.destAbs);
    node.updatedAt = new Date().toISOString();
    to.children = { ...(to.children ?? {}), [node.name]: node };
    if (opts.flags.has('v')) out.push(`renamed '${m.src}' -> '${m.dest}'`);
  }
  return ctx.result(out.join('\n'), errors.join('\n'), errors.length ? 1 : 0);
}

linuxCommands.registerAll({ cp, mv });
