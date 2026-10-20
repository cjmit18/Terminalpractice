import React, { useEffect, useState } from 'react';
import { FileNode } from '../../types/terminal';
import { ChevronRight, Folder, FileText } from 'lucide-react';

interface FileTreeProps {
  root: FileNode;
  /** Current directory; its ancestors start expanded and it is marked */
  cwd: string;
  isWindows: boolean;
}

const sep = (isWindows: boolean) => (isWindows ? '\\' : '/');

function childPath(parent: string, name: string, isWindows: boolean) {
  const s = sep(isWindows);
  return parent.endsWith(s) ? parent + name : parent + s + name;
}

function rootPath(root: FileNode, isWindows: boolean) {
  return isWindows ? `${root.name.replace(/\\$/, '')}\\` : '/';
}

/** Paths from the root down to cwd, compared case-insensitively on Windows */
function ancestorsOf(cwd: string, root: FileNode, isWindows: boolean): string[] {
  const s = sep(isWindows);
  const base = rootPath(root, isWindows);
  const rest = isWindows ? cwd.replace(/^[A-Za-z]:\\?/, '') : cwd.replace(/^\//, '');
  const out = [base];
  let acc = base;
  for (const seg of rest.split(s).filter(Boolean)) {
    acc = childPath(acc, seg, isWindows);
    out.push(acc);
  }
  return out;
}

const norm = (p: string, isWindows: boolean) => (isWindows ? p.toLowerCase() : p);

function sortedChildren(node: FileNode) {
  return Object.values(node.children ?? {}).sort((a, b) => {
    if (a.type !== b.type) return a.type === 'directory' ? -1 : 1;
    return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
  });
}

/** The tree of the machine's filesystem, as the engine currently has it */
export const FileTree: React.FC<FileTreeProps> = ({ root, cwd, isWindows }) => {
  const [expanded, setExpanded] = useState<Set<string>>(
    () => new Set(ancestorsOf(cwd, root, isWindows).map(p => norm(p, isWindows)))
  );

  // Follow the user: when they cd somewhere, open the folders on the way
  useEffect(() => {
    setExpanded(prev => {
      const next = new Set(prev);
      ancestorsOf(cwd, root, isWindows).forEach(p => next.add(norm(p, isWindows)));
      return next;
    });
    // root only matters for its name, which does not change between commands
  }, [cwd, isWindows]);

  const toggle = (path: string) =>
    setExpanded(prev => {
      const key = norm(path, isWindows);
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

  const cwdKey = norm(cwd.replace(/[\\/]$/, '') || '/', isWindows);

  const renderNode = (node: FileNode, path: string, depth: number): React.ReactNode => {
    const isDir = node.type === 'directory';
    const isOpen = isDir && expanded.has(norm(path, isWindows));
    const isCwd = isDir && norm(path.replace(/\\$/, ''), isWindows) === cwdKey.replace(/\\$/, '');
    const label = depth === 0 ? path : node.name + (isDir ? sep(isWindows) : '');
    const kids = isOpen ? sortedChildren(node) : [];

    const meta = (
      <span className="shrink-0 font-mono text-xs text-muted whitespace-nowrap">
        {isWindows ? node.owner : `${isDir ? 'd' : '-'}${node.permissions} ${node.owner} ${node.group}`}
      </span>
    );

    const nameBlock = (
      <>
        {isDir ? (
          <ChevronRight
            className={`size-3.5 shrink-0 text-subtle transition-transform ${isOpen ? 'rotate-90' : ''}`}
            aria-hidden="true"
          />
        ) : (
          <span className="w-3.5 shrink-0" aria-hidden="true" />
        )}
        {isDir ? (
          <Folder className="size-4 shrink-0 text-subtle" aria-hidden="true" />
        ) : (
          <FileText className="size-4 shrink-0 text-subtle" aria-hidden="true" />
        )}
        <span className={`truncate font-mono text-[13px] ${isCwd ? 'text-accent font-medium' : ''}`}>{label}</span>
        {isCwd && <span className="sr-only"> (current directory)</span>}
      </>
    );

    const rowClass = `flex items-center gap-2 w-full min-h-8 pr-2 rounded-sm text-left ${isCwd ? 'bg-accent-soft' : 'hover:bg-surface-2'}`;
    const indent = { paddingLeft: `${depth * 14 + 4}px` };

    return (
      <li key={path}>
        {isDir ? (
          <button type="button" aria-expanded={isOpen} onClick={() => toggle(path)} className={rowClass} style={indent}>
            <span className="flex items-center gap-1.5 flex-1 min-w-0">{nameBlock}</span>
            {meta}
          </button>
        ) : (
          <div className={rowClass} style={indent}>
            <span className="flex items-center gap-1.5 flex-1 min-w-0">{nameBlock}</span>
            {meta}
          </div>
        )}
        {isOpen && kids.length > 0 && (
          <ul>{kids.map(k => renderNode(k, childPath(path, k.name, isWindows), depth + 1))}</ul>
        )}
        {isOpen && kids.length === 0 && (
          <p className="text-sm text-subtle py-1" style={{ paddingLeft: `${(depth + 1) * 14 + 26}px` }}>
            Empty
          </p>
        )}
      </li>
    );
  };

  return <ul className="space-y-px">{renderNode(root, rootPath(root, isWindows), 0)}</ul>;
};
