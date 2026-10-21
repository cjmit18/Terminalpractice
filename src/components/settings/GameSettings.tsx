import React, { useId } from 'react';
import type { CelebrationMode } from '../../lib/activity';
import { useGameLayer } from '../celebrate/GameLayer';

const CELEBRATION_OPTIONS: { value: CelebrationMode; label: string; detail: string }[] = [
  { value: 'quiet', label: 'Quiet', detail: 'A short note when you finish a task, a lab or a stage, or earn a badge.' },
  { value: 'off', label: 'Off', detail: 'No notes. Tasks still show as done.' },
  {
    value: 'lively',
    label: 'Lively',
    detail: 'The same notes, plus a short burst of confetti when you finish a stage or a path. Skipped when your system is set to reduce motion.',
  },
];

interface Option<T> {
  value: T;
  label: string;
  detail?: string;
}

function RadioGroup<T extends string>({
  legend,
  name,
  value,
  options,
  onChange,
}: {
  legend: string;
  name: string;
  value: T;
  options: Option<T>[];
  onChange: (v: T) => void;
}) {
  return (
    <fieldset className="space-y-2">
      <legend className="text-sm font-semibold text-text">{legend}</legend>
      <div className="space-y-1">
        {options.map(o => (
          <label key={o.value} className="flex items-start gap-3 min-h-10 py-1.5 cursor-pointer">
            <input
              type="radio"
              name={name}
              value={o.value}
              checked={value === o.value}
              onChange={() => onChange(o.value)}
              className="mt-1 size-4 shrink-0 accent-accent"
            />
            <span className="text-sm">
              <span className="font-medium text-text">{o.label}</span>
              {o.detail && <span className="block text-muted">{o.detail}</span>}
            </span>
          </label>
        ))}
      </div>
    </fieldset>
  );
}

/** Badges and celebrations settings: show or hide badges, how to celebrate, and clearing it all. */
export const GameSettings: React.FC = () => {
  const { prefs, setPrefs, clear } = useGameLayer();
  const id = useId();

  const handleClear = () => {
    const ok = window.confirm(
      'Clear your badges and the record of what you have tried? Your lab and path progress stays, so badges for labs and paths you have finished come back.',
    );
    if (ok) clear();
  };

  return (
    <section aria-labelledby={`${id}-heading`} className="space-y-5 pt-2">
      <h3 id={`${id}-heading`} className="text-sm font-semibold text-text">
        Settings for badges and celebrations
      </h3>
      <RadioGroup
        legend="Badges"
        name={`${id}-badges`}
        value={prefs.showBadges ? 'show' : 'hide'}
        options={[
          { value: 'show', label: 'Show' },
          { value: 'hide', label: 'Hide', detail: 'Hides this list and the notes about badges.' },
        ]}
        onChange={v => setPrefs({ showBadges: v === 'show' })}
      />
      <RadioGroup
        legend="Celebrations"
        name={`${id}-celebrations`}
        value={prefs.celebrations}
        options={CELEBRATION_OPTIONS}
        onChange={v => setPrefs({ celebrations: v })}
      />
      <div className="space-y-2">
        <button
          type="button"
          onClick={handleClear}
          className="inline-flex items-center min-h-10 sm:min-h-9 px-3 rounded-md border border-line-strong bg-surface text-sm font-medium text-text hover:bg-surface-2"
        >
          Clear badges and activity
        </button>
        <p className="text-sm text-muted">
          Everything here is saved only in this browser. It records which kinds of things you have tried, such as
          opening a manual page or fixing a typo, never what you typed.
        </p>
      </div>
    </section>
  );
};
