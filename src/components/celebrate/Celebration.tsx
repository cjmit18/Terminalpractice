import React, { useEffect, useState } from 'react';
import { Check, X } from 'lucide-react';
import type { Batch } from '../../lib/celebrate';

/** How long a note stays (unless hovered or focused): tasks briefly, badges and milestones longer */
const SHORT_NOTE_MS = 6000;
const LASTING_NOTE_MS = 15000;

/**
 * The one polite live region for celebrations. It is always in the page (a region added at the
 * same time as its text is often not read), and the latest batch also shows as a one-line note.
 *
 * The note sits at the bottom (left on wide screens, above the phone nav), away from page actions,
 * and only its dismiss button takes clicks: taps on the text reach whatever is underneath.
 */
export const Celebration: React.FC<{ note: (Batch & { id: number }) | null; onDismiss: () => void }> = ({ note, onDismiss }) => {
  const [paused, setPaused] = useState(false);

  useEffect(() => {
    if (!note || paused) return;
    const t = window.setTimeout(onDismiss, note.lasting ? LASTING_NOTE_MS : SHORT_NOTE_MS);
    return () => window.clearTimeout(t);
  }, [note, paused, onDismiss]);

  return (
    <div
      className="fixed z-40 inset-x-4 bottom-[calc(60px+env(safe-area-inset-bottom))] md:inset-x-auto md:left-6 md:bottom-6 md:w-[26rem] pointer-events-none"
      onMouseEnter={() => setPaused(true)}
      onMouseLeave={() => setPaused(false)}
      onFocus={() => setPaused(true)}
      onBlur={() => setPaused(false)}
    >
      <div role="status" aria-live="polite" aria-atomic="true" aria-label="Celebrations" className="sr-only">
        {note?.text ?? ''}
      </div>
      {note && (
        <div
          key={note.id}
          data-testid="celebration-note"
          className="flex items-start gap-3 rounded-md border border-line bg-surface pl-3 pr-1 py-1 shadow-sm"
        >
          <Check className="size-4 mt-2.5 shrink-0 text-ok" aria-hidden="true" />
          {/* The live region above reads this out; the visible copy is hidden from screen readers so it is not read twice */}
          <p aria-hidden="true" className="flex-1 min-w-0 py-1.5 text-sm text-text">
            {note.text}
          </p>
          <button
            type="button"
            onClick={onDismiss}
            aria-label="Dismiss note"
            className="pointer-events-auto inline-flex items-center justify-center size-10 sm:size-8 shrink-0 rounded-sm text-muted hover:text-text hover:bg-surface-2"
          >
            <X className="size-4" aria-hidden="true" />
          </button>
        </div>
      )}
    </div>
  );
};
