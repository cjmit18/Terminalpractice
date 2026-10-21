import React, { useEffect, useId, useRef, useState } from 'react';
import { Check, Copy } from 'lucide-react';
import { dayKey, weekGoal } from '../../lib/activity';
import { useGameLayer } from '../celebrate/GameLayer';
import { copyText } from './CopyLinkButton';
import { progressSummaryText } from './summaryText';

/**
 * "Copy my progress summary": nothing is sent anywhere. The learner sees exactly what the text
 * says, and it only reaches the clipboard when they press the button.
 */
export const ProgressSummary: React.FC = () => {
  const { activity, badges, progress, journey, paths, modules, weekStart } = useGameLayer();
  const [state, setState] = useState<'idle' | 'copied' | 'failed'>('idle');
  const [open, setOpen] = useState(false);
  const timer = useRef<number | null>(null);
  const id = useId();
  useEffect(() => () => {
    if (timer.current !== null) window.clearTimeout(timer.current);
  }, []);

  const weeksMet = weekGoal(activity, dayKey(), weekStart)?.weeksMet ?? activity.goalWeeks?.length ?? 0;
  const text = progressSummaryText({ activity, badges, progress, journey, paths, modules, weeksMet });

  const copy = async () => {
    const ok = await copyText(text);
    setState(ok ? 'copied' : 'failed');
    // When copying is blocked, show the text so it can be selected by hand
    if (!ok) setOpen(true);
    if (timer.current !== null) window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setState('idle'), 2500);
  };

  return (
    <section aria-labelledby={`${id}-h`} className="space-y-2">
      <h3 id={`${id}-h`} className="text-sm font-semibold text-text">
        Your progress summary
      </h3>
      <p className="text-sm text-muted">
        Plain text you can paste into a message or a study log: the paths and labs you finished and your badges. No
        scores, no times and no name. It is only copied when you press the button.
      </p>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <button
          type="button"
          onClick={copy}
          className="inline-flex items-center gap-1.5 min-h-10 sm:min-h-9 px-3 rounded-md border border-line-strong bg-surface text-sm font-medium text-text hover:bg-surface-2"
        >
          {state === 'copied' ? <Check className="size-4 text-ok" aria-hidden="true" /> : <Copy className="size-4" aria-hidden="true" />}
          Copy my progress summary
        </button>
        <span role="status" className="text-sm text-muted">
          {state === 'copied' ? 'Copied.' : state === 'failed' ? 'Your browser did not allow copying. Select the text below instead.' : ''}
        </span>
      </div>
      <details open={open} onToggle={e => setOpen((e.currentTarget as HTMLDetailsElement).open)}>
        <summary className="cursor-pointer min-h-10 inline-flex items-center text-sm font-medium text-accent rounded-sm">
          See what it says
        </summary>
        <p data-testid="progress-summary" className="mt-2 whitespace-pre-line rounded-md border border-line bg-surface px-3 py-2 text-sm text-text">
          {text}
        </p>
      </details>
    </section>
  );
};
