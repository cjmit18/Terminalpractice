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

export function RadioGroup<T extends string>({
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

/** Settings (#/settings): show or hide badges, and how to celebrate. */
export const BadgeSettings: React.FC = () => {
  const { prefs, setPrefs } = useGameLayer();
  const id = useId();
  return (
    <div className="space-y-5">
      <RadioGroup
        legend="Badges"
        name={`${id}-badges`}
        value={prefs.showBadges ? 'show' : 'hide'}
        options={[
          { value: 'show', label: 'Show', detail: 'Your badges are listed at the end of the Learn page.' },
          { value: 'hide', label: 'Hide', detail: 'Hides the list and the notes about badges.' },
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
    </div>
  );
};

/** Settings (#/settings): story notes on labs and the weekly goal. */
export const LearningSettings: React.FC = () => {
  const { prefs, setPrefs } = useGameLayer();
  const id = useId();
  return (
    <div className="space-y-5">
      <RadioGroup
        legend="Story notes"
        name={`${id}-story`}
        value={prefs.storyNotes === false ? 'hide' : 'show'}
        options={[
          {
            value: 'show',
            label: 'Show',
            detail: 'Each lab opens as a help-desk ticket from a coworker at Northwind Supplies, and closes with a line of thanks.',
          },
          { value: 'hide', label: 'Hide', detail: 'Labs show only the task description.' },
        ]}
        onChange={v => setPrefs({ storyNotes: v === 'show' })}
      />
      <div className="space-y-2">
        <label htmlFor={`${id}-goal`} className="block text-sm font-semibold text-text">
          Weekly goal
        </label>
        <p className="text-sm text-muted">
          A day counts when you finish a task, read a lesson, try a quiz or run three commands in the Sandbox. There are
          no reminders, and a week you miss is never shown.
        </p>
        <select
          id={`${id}-goal`}
          value={prefs.weeklyGoal}
          onChange={e => setPrefs({ weeklyGoal: Number(e.target.value) })}
          className="min-h-10 sm:min-h-9 rounded-md border border-line-strong bg-surface px-2 text-sm text-text"
        >
          <option value={0}>Off</option>
          {[1, 2, 3, 4, 5, 6, 7].map(n => (
            <option key={n} value={n}>
              I’d like to practise on {n === 1 ? '1 day' : `${n} days`} a week
            </option>
          ))}
        </select>
      </div>
    </div>
  );
};

/** Settings (#/settings): clear badges and the record of what was tried. */
export const ClearActivity: React.FC = () => {
  const { clear } = useGameLayer();
  const handleClear = () => {
    const ok = window.confirm(
      'Clear your badges and the record of what you have tried? Your lab and path progress stays, so badges for labs and paths you have finished come back.',
    );
    if (ok) clear();
  };
  return (
    <div className="space-y-2">
      <button
        type="button"
        onClick={handleClear}
        className="inline-flex items-center min-h-10 sm:min-h-9 px-3 rounded-md border border-line-strong bg-surface text-sm font-medium text-text hover:bg-surface-2"
      >
        Clear badges and activity
      </button>
      <p className="text-sm text-muted">
        Badges and the record of which kinds of things you have tried, such as opening a manual page or fixing a typo,
        never what you typed. Your lab and path progress stays.
      </p>
    </div>
  );
};
