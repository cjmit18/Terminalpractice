import React from 'react';
import { ArrowRight, Check } from 'lucide-react';
import type { ExamModule } from '../../types/modules';
import type { LearningPath } from '../../types/paths';
import { CompletionSource, nextStep, stepTitle } from '../../lib/journey';
import { learnHref } from '../../lib/router';
import { PathBadgeLine } from '../badges/PathBadgeLine';

interface StageRecapProps {
  path: LearningPath;
  stageIndex: number;
  src: CompletionSource;
  modulesById: Map<string, ExamModule>;
}

/** Shown when the step you just finished cleared its stage, or the whole path, with a link onward. */
export const StageRecap: React.FC<StageRecapProps> = ({ path, stageIndex, src, modulesById }) => {
  const stage = path.stages[stageIndex];
  const next = nextStep(path, src);

  return (
    <section aria-labelledby="stage-recap-heading" className="mt-10 pt-6 border-t border-line space-y-3">
      <h2 id="stage-recap-heading" className="inline-flex items-center gap-2 text-base font-semibold text-text">
        <Check className="size-4 text-ok" aria-hidden="true" />
        {next ? `Stage clear: ${stage.title}` : `You have finished ${path.title}`}
      </h2>
      {next ? (
        <p className="text-[15px]">
          <span className="text-muted">What you can do now: </span>
          {stage.goal}
        </p>
      ) : (
        <p className="text-[15px]">
          Every stage is done:{' '}
          {path.stages.map(s => s.title).join(', ')}.
        </p>
      )}
      {!next && <PathBadgeLine pathId={path.id} />}
      <p className="text-sm">
        <a
          href={next ? learnHref(path.id, next.step.id) : learnHref()}
          className="inline-flex items-center gap-1 font-medium text-accent underline-offset-2 hover:underline rounded-sm"
        >
          {next ? `Next: ${stepTitle(next.step, modulesById)}` : 'Back to all paths and your badges'}
          <ArrowRight className="size-4" aria-hidden="true" />
        </a>
      </p>
    </section>
  );
};
