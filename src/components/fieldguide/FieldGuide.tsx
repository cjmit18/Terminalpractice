import React, { useMemo, useState } from 'react';
import { Check, Circle } from 'lucide-react';
import type { TerminalShell } from '../../types/terminal';
import { LEARNING_PATHS } from '../../data/paths';
import { useGameLayer } from '../celebrate/GameLayer';
import { Segmented } from '../sims/ui';
import { EntryStatus, GUIDE_SHELLS, GuideEntry, areaOrder, entryStatus, guideEntries, lessonCommandNames, met, readFact } from './catalog';
import { offerInSandbox } from './tryInSandbox';

interface FieldGuideProps {
  /** Opens a command's Reference page when it has one */
  onOpenReference: (name: string) => void;
  hasReference: (name: string) => boolean;
}

const actionClass =
  'inline-flex items-center min-h-10 sm:min-h-8 px-2 -mx-2 rounded-md text-sm font-medium text-accent hover:bg-surface-2';

/**
 * "Your field guide": every command, grouped by shell and area, with three quiet ticks (seen in a
 * lesson, ran it, read its manual). Commands not met yet show by name only. Counts are per area,
 * never one big total.
 */
export const FieldGuide: React.FC<FieldGuideProps> = ({ onOpenReference, hasReference }) => {
  const { activity, record } = useGameLayer();
  const [shell, setShell] = useState<TerminalShell>('bash');
  const lessonNames = useMemo(() => lessonCommandNames(LEARNING_PATHS), []);
  const facts = useMemo(() => new Set(activity.facts), [activity.facts]);
  const entries = guideEntries().filter(e => e.shell === shell);

  const groups = areaOrder(shell)
    .map(area => {
      const list = entries.filter(e => e.area === area).sort((a, b) => a.name.localeCompare(b.name));
      return { area, list: list.map(e => ({ entry: e, status: entryStatus(e, facts, lessonNames) })) };
    })
    .filter(g => g.list.length > 0);

  return (
    <div className="mx-auto w-full max-w-3xl px-4 pb-12 pt-5 sm:px-8 md:pt-8 space-y-6">
      <p className="max-w-prose text-[15px] text-muted">
        Every command this simulator knows. A command joins your guide when you see it in a lesson, run it, or read its
        manual. The ones you have not met yet show by name only.
      </p>
      <Segmented<TerminalShell>
        label="Shell"
        value={shell}
        onChange={setShell}
        className="flex w-full sm:w-auto"
        options={GUIDE_SHELLS.map(s => ({ value: s.shell, label: s.label }))}
      />

      {groups.map(g => {
        const count = g.list.filter(x => met(x.status)).length;
        const headingId = `guide-${shell}-${g.area.replace(/\W+/g, '-').toLowerCase()}`;
        return (
          <section key={g.area} aria-labelledby={headingId} className="space-y-2">
            <h2 id={headingId} className="text-base font-semibold text-text">
              {g.area}
              <span className="font-normal text-muted">: {count} of {g.list.length} met</span>
            </h2>
            <ul className="border-t border-line">
              {g.list.map(({ entry, status }) => (
                <GuideItem
                  key={entry.name}
                  entry={entry}
                  status={status}
                  onRead={() => record([readFact(entry)])}
                  reference={hasReference(entry.name) ? () => onOpenReference(entry.name) : null}
                />
              ))}
            </ul>
          </section>
        );
      })}
    </div>
  );
};

const Tick: React.FC<{ on: boolean; label: string }> = ({ on, label }) => (
  <span className={`inline-flex items-center gap-1 ${on ? 'text-text' : 'text-muted'}`}>
    {on ? <Check className="size-3.5 text-ok" aria-hidden="true" /> : <Circle className="size-3 text-subtle" aria-hidden="true" />}
    {label}
    <span className="sr-only">{on ? ': yes' : ': not yet'}</span>
  </span>
);

const GuideItem: React.FC<{ entry: GuideEntry; status: EntryStatus; onRead: () => void; reference: (() => void) | null }> = ({
  entry,
  status,
  onRead,
  reference,
}) => {
  const [open, setOpen] = useState(false);
  if (!met(status)) {
    return (
      <li className="border-b border-line py-2" data-guide-entry={entry.name} data-met="false">
        <code className="font-mono text-sm text-muted">{entry.name}</code>
      </li>
    );
  }
  return (
    <li className="border-b border-line py-3 space-y-1.5" data-guide-entry={entry.name} data-met="true">
      <p className="text-[15px]">
        <code className="font-mono font-medium text-text">{entry.name}</code>
        <span className="text-muted"> · {entry.summary}</span>
      </p>
      <p className="flex flex-wrap gap-x-4 gap-y-1 text-sm">
        <Tick on={status.seen} label="Seen in a lesson" />
        <Tick on={status.ran} label="Ran it" />
        <Tick on={status.read} label="Read its manual" />
      </p>
      <p className="flex flex-wrap gap-x-5">
        <button
          type="button"
          aria-expanded={open}
          onClick={() => {
            if (!open) onRead();
            setOpen(v => !v);
          }}
          className={actionClass}
        >
          {open ? 'Hide the manual' : 'Read the manual'}
        </button>
        <button
          type="button"
          onClick={() => offerInSandbox({ shell: entry.shell, command: entry.name })}
          className={actionClass}
        >
          Try it in the Sandbox
        </button>
        {reference && (
          <button type="button" onClick={reference} className={actionClass}>
            Reference page
          </button>
        )}
      </p>
      {open && (
        <div className="space-y-1">
          <p className="text-sm text-muted">
            What <code className="font-mono">{entry.manualCommand}</code> shows:
          </p>
          <pre className="max-h-96 overflow-auto rounded-md bg-surface-2 px-3 py-2 font-mono text-[13px] leading-relaxed whitespace-pre">
            {entry.manual().replace(/^\n+/, '')}
          </pre>
        </div>
      )}
    </li>
  );
};
