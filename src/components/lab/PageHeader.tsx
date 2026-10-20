import React from 'react';
import { TerminalShell } from '../../types/terminal';
import { RotateCcw } from 'lucide-react';

export const SHELL_LABELS: Record<TerminalShell, string> = {
  bash: 'bash',
  cmd: 'Command Prompt',
  powershell: 'PowerShell',
};

/** Classes for one option of a two- or three-way switch */
export const segmentClass = (selected: boolean) =>
  `px-3 h-10 sm:h-8 text-sm rounded-sm transition-colors whitespace-nowrap ${
    selected ? 'bg-accent-soft text-accent font-medium' : 'text-muted hover:text-text'
  }`;

export const secondaryButtonClass =
  'inline-flex items-center justify-center gap-1.5 h-10 sm:h-9 min-w-10 px-2.5 sm:px-3 rounded-md border border-line-strong bg-surface text-sm font-medium hover:bg-surface-2 transition-colors';

interface ShellSwitchProps {
  shells: TerminalShell[];
  value: TerminalShell;
  onChange: (s: TerminalShell) => void;
  className?: string;
}

export const ShellSwitch: React.FC<ShellSwitchProps> = ({ shells, value, onChange, className = '' }) => (
  <div className={`flex items-center gap-0.5 p-0.5 rounded-md border border-line bg-surface ${className}`} role="group" aria-label="Shell">
    {shells.map(sh => (
      <button key={sh} type="button" aria-pressed={value === sh} onClick={() => onChange(sh)} className={`flex-1 ${segmentClass(value === sh)}`}>
        {SHELL_LABELS[sh]}
      </button>
    ))}
  </div>
);

/** Reset with an icon; the word shows from the small breakpoint up and is always the accessible name */
export const ResetButton: React.FC<{ label: string; onClick: () => void }> = ({ label, onClick }) => (
  <button type="button" onClick={onClick} className={secondaryButtonClass}>
    <RotateCcw className="size-4 text-muted" aria-hidden="true" />
    <span className="sr-only sm:not-sr-only">{label}</span>
  </button>
);

interface PageHeaderProps {
  title: string;
  /** Short state next to the title, e.g. Done */
  badge?: string;
  meta: string;
  shellSwitch?: Omit<ShellSwitchProps, 'className'>;
  actions: React.ReactNode;
}

/** Title and meta on the left, controls on the right. On phones the shell switch gets its own row. */
export const PageHeader: React.FC<PageHeaderProps> = ({ title, badge, meta, shellSwitch, actions }) => (
  <header className="px-4 sm:px-6 py-3 sm:py-4 border-b border-line shrink-0">
    <div className="flex items-start justify-between gap-4">
      <div className="min-w-0">
        <h1 className="text-lg sm:text-2xl font-semibold leading-snug">
          {title}
          {badge && (
            <span className="ml-2.5 align-middle inline-flex items-center px-1.5 py-0.5 rounded-sm bg-ok-soft text-ok text-xs font-medium">
              {badge}
            </span>
          )}
        </h1>
        <p className="text-sm text-muted mt-0.5">{meta}</p>
      </div>
      <div className="flex items-center gap-2 shrink-0">
        {shellSwitch && <ShellSwitch {...shellSwitch} className="hidden md:flex" />}
        {actions}
      </div>
    </div>
    {shellSwitch && <ShellSwitch {...shellSwitch} className="md:hidden mt-3" />}
  </header>
);
