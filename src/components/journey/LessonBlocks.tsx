import React from 'react';
import { LessonBlock } from '../../types/paths';
import { CopyButton, thClass } from '../sims/ui';

const PROMPTS: Record<'bash' | 'cmd' | 'powershell', string> = {
  bash: '$',
  cmd: 'C:\\>',
  powershell: 'PS C:\\>',
};

const NOTE_STYLE: Record<'tip' | 'warning' | 'exam', { label: string; box: string; labelColor: string }> = {
  exam: { label: 'Exam tip', box: 'bg-accent-soft', labelColor: 'text-accent' },
  tip: { label: 'Tip', box: 'bg-accent-soft', labelColor: 'text-accent' },
  warning: { label: 'Watch out', box: 'bg-warn-soft', labelColor: 'text-warn' },
};

/** Renders lesson content. Strings are plain text; React escapes them. */
export const LessonBlocks: React.FC<{ blocks: LessonBlock[] }> = ({ blocks }) => (
  <div className="space-y-5 text-[16px] leading-relaxed">
    {blocks.map((block, i) => (
      <Block key={i} block={block} />
    ))}
  </div>
);

const Block: React.FC<{ block: LessonBlock }> = ({ block }) => {
  switch (block.type) {
    case 'p':
      return <p>{block.text}</p>;
    case 'heading':
      return <h2 className="pt-3 text-lg font-semibold leading-snug">{block.text}</h2>;
    case 'list': {
      const ListTag = block.ordered ? 'ol' : 'ul';
      return (
        <ListTag className={`pl-6 space-y-1.5 ${block.ordered ? 'list-decimal' : 'list-disc'} marker:text-subtle`}>
          {block.items.map((item, i) => (
            <li key={i} className="pl-1">
              {item}
            </li>
          ))}
        </ListTag>
      );
    }
    case 'code':
      return <LessonCode code={block.code} shell={block.shell} caption={block.caption} />;
    case 'note': {
      const style = NOTE_STYLE[block.tone];
      return (
        <aside aria-label={style.label} className={`rounded-md px-4 py-3 ${style.box}`}>
          <p className={`text-xs font-medium ${style.labelColor}`}>{style.label}</p>
          <p className="mt-1 text-[15px] text-text">{block.text}</p>
        </aside>
      );
    }
    case 'table':
      return (
        <div className="overflow-x-auto rounded-md border border-line">
          <table className="w-full text-[15px] border-collapse">
            <thead className="bg-surface-2">
              <tr>
                <th scope="col" className={thClass}>
                  {block.columns[0]}
                </th>
                <th scope="col" className={thClass}>
                  {block.columns[1]}
                </th>
              </tr>
            </thead>
            <tbody className="bg-surface">
              {block.rows.map((row, i) => (
                <tr key={i} className="border-t border-line">
                  <td className={`px-3 py-2 align-top ${looksLikeMachineText(row[0]) ? 'font-mono text-sm whitespace-nowrap' : ''}`}>
                    {row[0]}
                  </td>
                  <td className="px-3 py-2 align-top">{row[1]}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      );
  }
};

/**
 * Table cells are plain text, but the first column often holds something a terminal prints
 * (rw-, 750, /etc/fstab). Show those in mono; leave words and phrases in the UI font.
 */
function looksLikeMachineText(text: string): boolean {
  return !/\s/.test(text) && /[0-9\-/._~*$=|<>:\\]/.test(text) && !/^[A-Z]/.test(text);
}

/**
 * A terminal snippet. With a shell, the first line is the command (shown after a prompt and copied
 * by the Copy button) and any further lines are what it prints. Without one, it is shown and copied as is.
 */
const LessonCode: React.FC<{ code: string; shell?: 'bash' | 'cmd' | 'powershell'; caption?: string }> = ({
  code,
  shell,
  caption,
}) => {
  const lines = code.replace(/\n+$/, '').split('\n');
  const command = shell ? lines[0] : code;
  const output = shell ? lines.slice(1).join('\n') : '';

  return (
    <figure className="space-y-1.5">
      <div className="flex items-start gap-2 rounded-md bg-surface-2 py-1 pl-4 pr-1">
        <pre className="min-w-0 flex-1 overflow-x-auto py-2 font-mono text-sm leading-relaxed">
          {shell ? (
            <code>
              <span className="select-none text-muted">{PROMPTS[shell]} </span>
              <span className="font-medium text-text">{command}</span>
              {output && (
                <>
                  {'\n'}
                  <span className="text-muted">{output}</span>
                </>
              )}
            </code>
          ) : (
            <code>{code}</code>
          )}
        </pre>
        <CopyButton text={command} />
      </div>
      {caption && <figcaption className="text-sm text-muted">{caption}</figcaption>}
    </figure>
  );
};
