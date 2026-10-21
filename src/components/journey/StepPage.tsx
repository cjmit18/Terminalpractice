import React, { useState } from 'react';
import { ArrowRight, Check, ChevronLeft, ChevronRight, Lock } from 'lucide-react';
import { ExamModule } from '../../types/modules';
import { LearningPath, PathStep } from '../../types/paths';
import {
  CompletionSource,
  QuizScore,
  StepLocation,
  allSteps,
  currentStageIndex,
  markRead,
  nextStep,
  stageComplete,
  stageUnlocked,
  stepAfter,
  stepComplete,
  stepKey,
  stepMinutes,
  stepTitle,
  stepAt,
} from '../../lib/journey';
import { learnHref } from '../../lib/router';
import { ModuleRunner } from '../ModuleRunner';
import { LessonBlocks } from './LessonBlocks';
import { QuizView } from './QuizView';
import { KIND_LABEL, primaryLinkClass, secondaryLinkClass, textLinkClass } from './shared';
import { StageRecap } from '../celebrate/StageRecap';

interface StepPageProps {
  path: LearningPath;
  loc: StepLocation;
  src: CompletionSource;
  modulesById: Map<string, ExamModule>;
  progress: Record<string, string[]>;
  onObjectiveComplete: (moduleId: string, objectiveId: string) => void;
  onMarkRead: (pathId: string, stepId: string) => void;
  onQuizScore: (pathId: string, stepId: string, score: QuizScore) => void;
}

/** #/learn/<pathId>/<stepId> */
export const StepPage: React.FC<StepPageProps> = props => {
  const { path, loc, src, modulesById } = props;
  const { step } = loc;
  const unlocked = stageUnlocked(path, loc.stageIndex, src);
  // Did finishing this step, on this visit, clear its stage (or the whole path)?
  const stageDone = stageComplete(path.id, loc.stage, src);
  const [stageDoneAtOpen] = useState(stageDone);
  const justCleared = stageDone && !stageDoneAtOpen;
  const pathDone = currentStageIndex(path, src) === -1;

  // Where "Continue" goes from here, given the progress so far
  const nextHref = (source: CompletionSource) => {
    const after = stepAfter(path, step.id, source);
    return after
      ? { href: learnHref(path.id, after.step.id), title: stepTitle(after.step, modulesById) }
      : { href: learnHref(path.id), title: `${path.title} overview` };
  };

  const bar = <StepBar path={path} loc={loc} modulesById={modulesById} />;

  if (!unlocked) {
    return (
      <>
        {bar}
        <LockedStep path={path} loc={loc} src={src} modulesById={modulesById} />
      </>
    );
  }

  if (step.kind === 'lab') {
    const mod = modulesById.get(step.moduleId);
    const done = stepComplete(path.id, step, src);
    const next = nextHref(src);
    return (
      <div className="flex flex-col h-full">
        {bar}
        {step.note && (
          <p className="shrink-0 px-4 sm:px-6 py-2.5 text-sm text-muted border-b border-line">{step.note}</p>
        )}
        {mod ? (
          <ModuleRunner
            key={mod.id}
            module={mod}
            completedObjectiveIds={props.progress[mod.id] ?? []}
            onObjectiveComplete={props.onObjectiveComplete}
            recap={justCleared ? <StageRecap path={path} stageIndex={loc.stageIndex} src={src} modulesById={modulesById} /> : null}
          />
        ) : (
          <p className="px-4 sm:px-6 py-8 text-[15px] text-muted">This lab is not available in this version of the app.</p>
        )}
        {done && (
          <div
            role="status"
            className="shrink-0 flex flex-wrap items-center justify-between gap-x-4 gap-y-2 px-4 sm:px-6 py-2.5 border-t border-line bg-ok-soft"
          >
            <p className="inline-flex items-center gap-2 text-[15px] font-medium text-text">
              <Check className="w-4 h-4 text-ok" aria-hidden="true" />
              {justCleared
                ? pathDone
                  ? `Lab done. You have finished ${path.title}.`
                  : `Lab done. Stage clear: ${loc.stage.title}.`
                : 'Lab done'}
            </p>
            <a href={next.href} className={`${primaryLinkClass} max-w-full`}>
              <span className="truncate">Continue to {next.title}</span>
              <ArrowRight className="w-4 h-4 shrink-0" aria-hidden="true" />
            </a>
          </div>
        )}
      </div>
    );
  }

  const header = (
    <header className="space-y-1">
      <p className="text-sm text-muted">
        {KIND_LABEL[step.kind]} · {stepMinutes(step, modulesById)} min
      </p>
      <h1 className="text-2xl font-semibold leading-snug">{stepTitle(step, modulesById)}</h1>
    </header>
  );

  if (step.kind === 'lesson') {
    const read = stepComplete(path.id, step, src);
    // Continue marks the lesson read first, so work out where it leads with that already counted
    const next = nextHref({ ...src, journey: markRead(src.journey, path.id, step.id) });
    return (
      <>
        {bar}
        <article className="max-w-3xl mx-auto w-full px-4 sm:px-6 py-8 sm:py-12">
          {header}
          <div className="mt-8 max-w-prose">
            <LessonBlocks blocks={step.blocks} />
          </div>
          <footer className="mt-12 pt-6 border-t border-line max-w-prose space-y-3">
            <div className="flex flex-wrap items-center gap-3">
              <a href={next.href} onClick={() => props.onMarkRead(path.id, step.id)} className={primaryLinkClass}>
                Continue
                <ArrowRight className="w-4 h-4" aria-hidden="true" />
              </a>
              {read ? (
                <p className="inline-flex items-center gap-1.5 min-h-11 sm:min-h-9 text-sm font-medium text-ok">
                  <Check className="w-4 h-4" aria-hidden="true" />
                  Marked as read
                </p>
              ) : (
                <button type="button" onClick={() => props.onMarkRead(path.id, step.id)} className={secondaryLinkClass}>
                  Mark as read
                </button>
              )}
            </div>
            <p className="text-sm text-muted">Next: {next.title}</p>
          </footer>
          {justCleared && (
            <div className="max-w-prose">
              <StageRecap path={path} stageIndex={loc.stageIndex} src={src} modulesById={modulesById} />
            </div>
          )}
        </article>
      </>
    );
  }

  // Quiz
  return (
    <>
      {bar}
      <div className="max-w-3xl mx-auto w-full px-4 sm:px-6 py-8 sm:py-12">
        {header}
        <div className="mt-6 max-w-prose">
          <QuizView
            key={`${path.id}/${step.id}`}
            step={step}
            best={src.journey.quiz[stepKey(path.id, step.id)]}
            onScore={score => props.onQuizScore(path.id, step.id, score)}
            next={nextHref(src)}
          />
          {justCleared && <StageRecap path={path} stageIndex={loc.stageIndex} src={src} modulesById={modulesById} />}
        </div>
      </div>
    </>
  );
};

/** Breadcrumb, position in the path and links to the neighbouring steps. */
const StepBar: React.FC<{ path: LearningPath; loc: StepLocation; modulesById: Map<string, ExamModule> }> = ({
  path,
  loc,
  modulesById,
}) => {
  const total = allSteps(path).length;
  const prev = stepAt(path, loc.index - 1);
  const next = stepAt(path, loc.index + 1);

  return (
    <div className="shrink-0 flex items-center justify-between gap-3 min-h-11 px-4 lg:px-6 border-b border-line bg-bg">
      <nav aria-label="Breadcrumb" className="min-w-0">
        <ol className="flex items-center gap-2 text-sm min-w-0">
          <li className="shrink-0">
            <a href={learnHref()} className="text-muted hover:text-text underline-offset-2 hover:underline">
              Learn
            </a>
          </li>
          <li aria-hidden="true" className="shrink-0 text-subtle">
            /
          </li>
          <li className="min-w-0 truncate">
            <a href={learnHref(path.id)} className="text-muted hover:text-text underline-offset-2 hover:underline">
              {path.title}
            </a>
          </li>
          <li aria-hidden="true" className="hidden md:block shrink-0 text-subtle">
            /
          </li>
          <li aria-current="page" className="hidden md:block min-w-0 truncate font-medium text-text">
            {loc.stage.title}
          </li>
        </ol>
      </nav>

      <div className="flex items-center gap-1 shrink-0 -mr-2">
        <span className="text-sm text-muted tabular-nums whitespace-nowrap pr-1">
          Step {loc.index + 1} of {total}
        </span>
        <StepLink path={path} target={prev?.step ?? null} direction="prev" modulesById={modulesById} />
        <StepLink path={path} target={next?.step ?? null} direction="next" modulesById={modulesById} />
      </div>
    </div>
  );
};

const StepLink: React.FC<{
  path: LearningPath;
  target: PathStep | null;
  direction: 'prev' | 'next';
  modulesById: Map<string, ExamModule>;
}> = ({ path, target, direction, modulesById }) => {
  const label = direction === 'prev' ? 'Previous' : 'Next';
  const Icon = direction === 'prev' ? ChevronLeft : ChevronRight;
  const base = 'flex items-center justify-center gap-1 min-w-10 h-10 sm:h-8 px-2 rounded-md text-sm font-medium';
  const content = (
    <>
      {direction === 'prev' && <Icon className="w-4 h-4" aria-hidden="true" />}
      <span className="hidden lg:inline">{label}</span>
      {direction === 'next' && <Icon className="w-4 h-4" aria-hidden="true" />}
    </>
  );
  if (!target) {
    return (
      <span aria-hidden="true" className={`${base} text-subtle opacity-50`}>
        {content}
      </span>
    );
  }
  const name = stepTitle(target, modulesById);
  return (
    <a
      href={learnHref(path.id, target.id)}
      aria-label={`${label} step: ${name}`}
      title={name}
      className={`${base} text-muted hover:text-text hover:bg-surface-2`}
    >
      {content}
    </a>
  );
};

/** A step in a stage that is not open yet: say what opens it and where to go instead. */
const LockedStep: React.FC<{
  path: LearningPath;
  loc: StepLocation;
  src: CompletionSource;
  modulesById: Map<string, ExamModule>;
}> = ({ path, loc, src, modulesById }) => {
  const prevStage = path.stages[loc.stageIndex - 1];
  const next = nextStep(path, src);
  const todo = next ? next.stage.steps.filter(s => !stepComplete(path.id, s, src)) : [];

  return (
    <div className="max-w-3xl mx-auto w-full px-4 sm:px-6 py-8 sm:py-12 space-y-6">
      <header className="space-y-1">
        <p className="text-sm text-muted">
          {KIND_LABEL[loc.step.kind]} · Stage {loc.stageIndex + 1}: {loc.stage.title}
        </p>
        <h1 className="text-2xl font-semibold leading-snug">{stepTitle(loc.step, modulesById)}</h1>
      </header>

      <p className="flex items-start gap-2 text-[15px] max-w-prose">
        <Lock className="w-4 h-4 mt-1 shrink-0 text-muted" aria-hidden="true" />
        <span>
          This step opens once you finish Stage {loc.stageIndex}, {prevStage?.title}.
        </span>
      </p>

      {next && todo.length > 0 && (
        <section aria-labelledby="locked-todo" className="space-y-2 max-w-prose">
          <h2 id="locked-todo" className="text-base font-semibold">
            Still to do in {next.stage.title}
          </h2>
          <ul className="space-y-1">
            {todo.map(s => (
              <li key={s.id} className="text-[15px]">
                <a href={learnHref(path.id, s.id)} className={textLinkClass}>
                  {stepTitle(s, modulesById)}
                </a>
                <span className="text-sm text-muted"> · {KIND_LABEL[s.kind]}</span>
              </li>
            ))}
          </ul>
        </section>
      )}

      {next && (
        <a href={learnHref(path.id, next.step.id)} className={primaryLinkClass}>
          Go to {stepTitle(next.step, modulesById)}
          <ArrowRight className="w-4 h-4" aria-hidden="true" />
        </a>
      )}
    </div>
  );
};
