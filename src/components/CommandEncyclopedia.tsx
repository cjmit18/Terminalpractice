import React, { useRef, useState } from 'react';
import { COMMAND_REFERENCE, CommandRefEntry } from '../data/commandReference';
import { ArrowLeft, Search, X } from 'lucide-react';
import { Button, CodeBlock, Segmented, cx } from './sims/ui';

interface CommandEncyclopediaProps {
  onSelectCommand?: (cmd: string) => void;
}

type Platform = 'all' | 'linux' | 'windows';

const PLATFORM_LABEL: Record<CommandRefEntry['platform'], string> = {
  linux: 'Linux',
  windows: 'Windows',
  both: 'Linux and Windows',
};

const matches = (cmd: CommandRefEntry, q: string) =>
  !q ||
  cmd.name.toLowerCase().includes(q) ||
  cmd.summary.toLowerCase().includes(q) ||
  cmd.exam.toLowerCase().includes(q) ||
  cmd.category.toLowerCase().includes(q) ||
  cmd.switches.some(s => s.flag.toLowerCase().includes(q) || s.description.toLowerCase().includes(q)) ||
  cmd.examples.some(e => e.cmd.toLowerCase().includes(q));

export const CommandEncyclopedia: React.FC<CommandEncyclopediaProps> = ({
  onSelectCommand,
}) => {
  const [search, setSearch] = useState('');
  const [platformFilter, setPlatformFilter] = useState<Platform>('all');
  const [selectedName, setSelectedName] = useState<string>(COMMAND_REFERENCE[0]?.name ?? '');
  // Phones show one pane at a time: the list, or one command's page
  const [phoneView, setPhoneView] = useState<'list' | 'page'>('list');
  const articleRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);

  const q = search.trim().toLowerCase();
  const filtered = COMMAND_REFERENCE.filter(
    cmd => (platformFilter === 'all' || cmd.platform === platformFilter || cmd.platform === 'both') && matches(cmd, q),
  );

  // Keep the data file's order, grouped by category
  const groups: { category: string; items: CommandRefEntry[] }[] = [];
  for (const cmd of filtered) {
    const g = groups.find(x => x.category === cmd.category);
    if (g) g.items.push(cmd);
    else groups.push({ category: cmd.category, items: [cmd] });
  }

  const selected = COMMAND_REFERENCE.find(c => c.name === selectedName) ?? COMMAND_REFERENCE[0];
  const index = COMMAND_REFERENCE.indexOf(selected);
  const next = COMMAND_REFERENCE[index + 1];

  const open = (name: string) => {
    setSelectedName(name);
    setPhoneView('page');
    articleRef.current?.scrollTo({ top: 0 });
  };

  return (
    <div className="flex h-full min-h-0 flex-col bg-bg text-text md:flex-row">
      {/* Command list */}
      <aside
        aria-label="Commands"
        className={cx(
          'min-h-0 flex-col border-line md:flex md:w-72 md:shrink-0 md:border-r lg:w-80',
          phoneView === 'list' ? 'flex flex-1 md:flex-none' : 'hidden',
        )}
      >
        <div className="shrink-0 space-y-3 border-b border-line px-4 pb-4 pt-5">
          <div>
            <h1 className="text-2xl font-semibold">Command reference</h1>
            <p className="mt-0.5 text-sm text-muted">The commands the labs use, with the options the exams ask about.</p>
          </div>
          <div className="relative">
            <label htmlFor="ref-search" className="sr-only">Search commands</label>
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted" aria-hidden />
            <input
              ref={searchRef}
              id="ref-search"
              type="search"
              value={search}
              onChange={e => setSearch(e.target.value)}
              placeholder="Search, e.g. -ano or /flushdns"
              autoComplete="off"
              spellCheck={false}
              className="min-h-10 w-full rounded-md border border-line-strong bg-surface pl-9 pr-10 text-[15px] text-text placeholder:text-subtle [&::-webkit-search-cancel-button]:hidden"
            />
            {search && (
              <button
                type="button"
                onClick={() => {
                  setSearch('');
                  searchRef.current?.focus();
                }}
                aria-label="Clear search"
                className="absolute right-0 top-0 inline-flex h-10 w-10 items-center justify-center rounded-md text-muted hover:text-text"
              >
                <X className="h-4 w-4" aria-hidden />
              </button>
            )}
          </div>
          <Segmented<Platform>
            label="Platform"
            value={platformFilter}
            onChange={setPlatformFilter}
            className="flex w-full"
            options={[
              { value: 'all', label: 'All' },
              { value: 'linux', label: 'Linux' },
              { value: 'windows', label: 'Windows' },
            ]}
          />
        </div>

        <nav aria-label="Command list" className="min-h-0 flex-1 overflow-y-auto py-2">
          <p className="sr-only" role="status" aria-live="polite">
            {filtered.length === 1 ? '1 command' : `${filtered.length} commands`}
          </p>
          {groups.length === 0 && (
            <p className="px-4 py-6 text-sm text-muted">
              Nothing matches “{search.trim()}”. Try a command name or a flag.
            </p>
          )}
          {groups.map(g => (
            <div key={g.category} className="pb-2">
              <h2 className="px-4 pb-1 pt-3 text-xs font-medium text-muted">{g.category}</h2>
              <ul>
                {g.items.map(cmd => {
                  const isSel = cmd.name === selected?.name;
                  return (
                    <li key={cmd.name}>
                      <button
                        type="button"
                        onClick={() => open(cmd.name)}
                        aria-current={isSel ? 'page' : undefined}
                        className={cx(
                          'block min-h-10 w-full border-l-2 border-transparent px-4 py-1.5 text-left hover:bg-surface-2',
                          isSel && 'md:border-accent md:bg-surface-2',
                        )}
                      >
                        <span className="flex items-baseline justify-between gap-3">
                          <span className={cx('font-mono text-sm', isSel ? 'md:font-semibold md:text-accent' : '')}>{cmd.name}</span>
                          <span className="shrink-0 text-xs text-muted">{PLATFORM_LABEL[cmd.platform]}</span>
                        </span>
                        <span className="block truncate text-sm text-muted">{cmd.summary}</span>
                      </button>
                    </li>
                  );
                })}
              </ul>
            </div>
          ))}
        </nav>
      </aside>

      {/* One command's page */}
      <div
        ref={articleRef}
        className={cx('min-h-0 min-w-0 flex-1 overflow-y-auto', phoneView === 'page' ? 'block' : 'hidden md:block')}
      >
        {selected && (
          <article className="mx-auto max-w-3xl px-4 pb-12 pt-4 sm:px-8 md:pt-8">
            <button
              type="button"
              onClick={() => setPhoneView('list')}
              className="-ml-2 mb-3 inline-flex min-h-10 items-center gap-1.5 rounded-md px-2 text-sm font-medium text-accent hover:bg-surface-2 md:hidden"
            >
              <ArrowLeft className="h-4 w-4" aria-hidden />
              All commands
            </button>

            <header>
              <h1 className="break-words font-mono text-2xl font-semibold">{selected.name}</h1>
              <p className="mt-1 text-sm text-muted">
                {PLATFORM_LABEL[selected.platform]} · {selected.category} · {selected.exam}
              </p>
              <p className="mt-4 max-w-prose">{selected.summary}</p>
            </header>

            <section className="mt-8" aria-labelledby="ref-syntax">
              <h2 id="ref-syntax" className="text-base font-semibold">Syntax</h2>
              <CodeBlock code={selected.syntax} className="mt-2" />
            </section>

            {selected.switches.length > 0 && (
              <section className="mt-8" aria-labelledby="ref-options">
                <h2 id="ref-options" className="text-base font-semibold">Options</h2>
                <dl className="mt-2 grid grid-cols-1 border-t border-line sm:grid-cols-[minmax(7rem,max-content)_1fr]">
                  {selected.switches.map((sw, i) => (
                    <div key={i} className="contents">
                      <dt className="break-words pt-2.5 font-mono text-sm font-medium sm:border-b sm:border-line sm:py-2.5 sm:pr-6">
                        {sw.flag}
                      </dt>
                      <dd className="border-b border-line pb-2.5 text-muted sm:py-2.5">{sw.description}</dd>
                    </div>
                  ))}
                </dl>
              </section>
            )}

            {selected.examples.length > 0 && (
              <section className="mt-8" aria-labelledby="ref-examples">
                <h2 id="ref-examples" className="text-base font-semibold">Examples</h2>
                <ul className="mt-2 space-y-4">
                  {selected.examples.map((ex, i) => (
                    <li key={i}>
                      <p className="text-sm text-muted">{ex.description}</p>
                      <CodeBlock code={ex.cmd} className="mt-1" />
                    </li>
                  ))}
                </ul>
              </section>
            )}

            <section className="mt-8" aria-labelledby="ref-exam">
              <h2 id="ref-exam" className="text-base font-semibold">Exam notes</h2>
              <p className="mt-2 max-w-prose border-l-2 border-warn bg-warn-soft px-4 py-3">{selected.examNotes}</p>
            </section>

            <footer className="mt-10 flex flex-wrap items-center justify-between gap-3 border-t border-line pt-4">
              {onSelectCommand ? (
                <Button variant="secondary" onClick={() => onSelectCommand(selected.name)}>
                  Try <span className="font-mono">{selected.name}</span> in the sandbox
                </Button>
              ) : (
                <span />
              )}
              {next && (
                <button
                  type="button"
                  onClick={() => open(next.name)}
                  className="inline-flex min-h-10 items-center gap-1.5 rounded-md px-2 text-sm text-muted hover:bg-surface-2 hover:text-text"
                >
                  Next: <span className="font-mono text-accent">{next.name}</span>
                </button>
              )}
            </footer>
          </article>
        )}
      </div>
    </div>
  );
};
