import React, { useState } from 'react';
import { ArrowRight } from 'lucide-react';
import { LearningPath } from '../../types/paths';
import { CompletionSource, allSteps, stepsDone } from '../../lib/journey';
import { learnHref } from '../../lib/router';
import { readStorage, writeStorage } from '../../lib/storage';
import { FIRST_STEPS_PATH_ID } from '../../data/paths';
import { primaryLinkClass } from './shared';

/** Set once the learner says they have used a terminal before. Per browser; it only hides this offer. */
export const FIRST_STEPS_DISMISSED_KEY = 'certsim:firststeps-dismissed';

/**
 * True when nothing at all has been saved yet: no lesson read, no quiz taken, no path opened, no step
 * done, and no lab task done (`progress`: moduleId -> completed objective ids).
 */
export function noSavedProgress(paths: LearningPath[], src: CompletionSource, progress: Record<string, string[]> = {}): boolean {
  const { journey } = src;
  if (journey.last || journey.read.length > 0 || Object.keys(journey.quiz).length > 0) return false;
  if (Object.values(progress).some(ids => ids.length > 0)) return false;
  return paths.every(path => stepsDone(path, src).done === 0);
}

function readDismissed(): boolean {
  try {
    return readStorage(FIRST_STEPS_DISMISSED_KEY) === '1';
  } catch {
    return false;
  }
}

function saveDismissed(): void {
  try {
    writeStorage(FIRST_STEPS_DISMISSED_KEY, '1');
  } catch {
    // Storage blocked: the offer stays hidden until the page reloads, which is fine
  }
}

/**
 * "New to the command line? Start here": offered at the top of the Learn page to someone with
 * no saved progress, linking to the first lesson of the beginners' path. One click hides it for good.
 */
export const FirstStepsBanner: React.FC<{
  paths: LearningPath[];
  src: CompletionSource;
  progress: Record<string, string[]>;
  /** Where focus goes once the offer is dismissed (the page heading), so it is not lost with the button */
  focusAfterDismissId: string;
}> = ({ paths, src, progress, focusAfterDismissId }) => {
  const [dismissed, setDismissed] = useState(readDismissed);
  const path = paths.find(p => p.id === FIRST_STEPS_PATH_ID);
  const first = path ? allSteps(path)[0] : undefined;
  if (dismissed || !path || !first || !noSavedProgress(paths, src, progress)) return null;

  const dismiss = () => {
    saveDismissed();
    setDismissed(true);
    requestAnimationFrame(() => document.getElementById(focusAfterDismissId)?.focus());
  };

  return (
    <section aria-labelledby="first-steps-heading" className="mt-8 rounded-md border border-line bg-surface px-4 sm:px-5 py-4 space-y-2">
      <h2 id="first-steps-heading" className="text-base font-semibold text-text">
        New to the command line? Start here (5 minutes)
      </h2>
      <p className="text-[15px] text-muted max-w-prose">
        Find out what the prompt means, then try five small commands on a practice Linux or Windows computer.
        You do not need to know anything yet, and nothing you type here can break anything.
      </p>
      <div className="flex flex-wrap items-center gap-x-5 gap-y-1 pt-2">
        <a href={learnHref(path.id, first.id)} className={primaryLinkClass}>
          Begin
          <ArrowRight className="w-4 h-4" aria-hidden="true" />
        </a>
        <button
          type="button"
          onClick={dismiss}
          className="min-h-11 sm:min-h-9 text-sm font-medium text-muted underline underline-offset-2 decoration-line-strong hover:text-text rounded-sm"
        >
          I've used a terminal before
        </button>
      </div>
    </section>
  );
};
