import React from 'react';
import { BookOpen, ListChecks, SquareTerminal } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { PathStep } from '../../types/paths';

export const KIND_ICON: Record<PathStep['kind'], LucideIcon> = {
  lesson: BookOpen,
  lab: SquareTerminal,
  quiz: ListChecks,
};

export const KIND_LABEL: Record<PathStep['kind'], string> = {
  lesson: 'Lesson',
  lab: 'Lab',
  quiz: 'Checkpoint',
};

/** Primary action as a link: 44px tall on phones, 36px from sm up. */
export const primaryLinkClass =
  'inline-flex items-center justify-center gap-1.5 min-h-11 sm:min-h-9 px-4 rounded-md bg-accent text-accent-fg text-sm font-medium hover:opacity-90 transition-opacity';

export const secondaryLinkClass =
  'inline-flex items-center justify-center gap-1.5 min-h-11 sm:min-h-9 px-4 rounded-md border border-line-strong bg-surface text-text text-sm font-medium hover:bg-surface-2 transition-colors';

export const textLinkClass = 'text-accent underline-offset-2 hover:underline rounded-sm';

/** Thin progress bar. Decorative: the same number is always written next to it. */
export const ProgressBar: React.FC<{ percent: number; className?: string }> = ({ percent, className = '' }) => (
  <div aria-hidden="true" className={`h-1 rounded-full bg-line overflow-hidden ${className}`}>
    <div className="h-full rounded-full bg-accent" style={{ width: `${Math.max(0, Math.min(100, percent))}%` }} />
  </div>
);
