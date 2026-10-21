import React, { useState } from 'react';
import { ArrowRight, Check, ChevronDown, Lock } from 'lucide-react';
import { ExamModule } from '../../types/modules';
import { LearningPath, PathStage } from '../../types/paths';
import {
  CompletionSource,
  currentStageIndex,
  formatMinutes,
  nextStep,
  pathMinutes,
  pathPercent,
  pathStarted,
  stageComplete,
  stageUnlocked,
  stageUnits,
  stepComplete,
  stepMinutes,
  stepTitle,
} from '../../lib/journey';
import { learnHref } from '../../lib/router';
import { KIND_ICON, KIND_LABEL, ProgressBar, primaryLinkClass } from './shared';
import { pathProgressText, stagesText } from './progressText';
import { PathBadgeLine } from '../badges/PathBadgeLine';

interface PathOverviewProps {
  path: LearningPath;
  src: CompletionSource;
  modulesById: Map<string, ExamModule>;
  /** Lab progress, to show "1 of 4 tasks done" on a lab you have started */
  progress: Record<string, string[]>;
  onReset: () => void;
}

/** #/learn/<pathId>: the syllabus. */
export const PathOverview: React.FC<PathOverviewProps> = ({ path, src, modulesById, progress, onReset }) => {
  const current = currentStageIndex(path, src);
  const next = nextStep(path, src);
  const started = pathStarted(path, src);
  const hasJourneyProgress =
    src.journey.read.some(k => k.startsWith(`${path.id}/`)) ||
    Object.keys(src.journey.quiz).some(k => k.startsWith(`${path.id}/`));

  // The current stage starts open; the learner can open any other one to look inside
  const [open, setOpen] = useState<Set<string>>(() => new Set(current >= 0 ? [path.stages[current].id] : []));
  const toggle = (id: string) =>
    setOpen(prev => {
      const s = new Set(prev);
      if (s.has(id)) s.delete(id);
      else s.add(id);
      return s;
    });

  const handleReset = () => {
    const ok = window.confirm(
      `Clear the lessons you marked read and your checkpoint scores in ${path.title}? Labs keep their progress.`,
    );
    if (ok) onReset();
  };

  return (
    <div className="max-w-3xl mx-auto w-full px-4 sm:px-6 py-8 sm:py-12">
      <nav aria-label="Breadcrumb" className="text-sm">
        <a href={learnHref()} className="text-muted hover:text-text underline-offset-2 hover:underline">
          Learning paths
        </a>
      </nav>

      <header className="mt-4 space-y-3">
        <p className="text-sm text-muted">{path.exam}</p>
        <h1 className="text-2xl font-semibold text-text">{path.title}</h1>
        <p className="text-[15px] max-w-prose">{path.summary}</p>
        <p className="text-sm text-muted max-w-prose">{path.audience}</p>
        <p className="text-sm text-muted">
          {stagesText(path.stages.length)} · {formatMinutes(pathMinutes(path, modulesById))}
        </p>
        <div className="flex flex-col sm:flex-row sm:items-center gap-3 sm:gap-6 pt-2">
          <div className="flex-1 min-w-0 max-w-sm space-y-1.5">
            <p className="text-sm tabular-nums">{pathProgressText(path, src)}</p>
            <ProgressBar percent={pathPercent(path, src)} />
          </div>
          {next ? (
            <a href={learnHref(path.id, next.step.id)} className={`${primaryLinkClass} self-start sm:self-auto`}>
              {started ? 'Continue' : 'Start'}
              <ArrowRight className="w-4 h-4" aria-hidden="true" />
            </a>
          ) : (
            <p className="text-sm font-medium text-ok inline-flex items-center gap-1.5">
              <Check className="w-4 h-4" aria-hidden="true" />
              You have finished this path
            </p>
          )}
        </div>
        {!next && <PathBadgeLine pathId={path.id} />}
        {next && (
          <p className="text-sm text-muted">
            Next: {stepTitle(next.step, modulesById)}
          </p>
        )}
      </header>

      <h2 className="sr-only">Stages</h2>
      <ol className="mt-10 space-y-2">
        {path.stages.map((stage, i) => (
          <StageItem
            key={stage.id}
            path={path}
            stage={stage}
            index={i}
            isCurrent={i === current}
            open={open.has(stage.id)}
            onToggle={() => toggle(stage.id)}
            src={src}
            modulesById={modulesById}
            progress={progress}
          />
        ))}
      </ol>

      {hasJourneyProgress && (
        <p className="mt-10 text-sm text-muted">
          <button
            type="button"
            onClick={handleReset}
            className="min-h-10 font-medium underline underline-offset-2 decoration-line-strong hover:text-danger hover:decoration-danger rounded-sm"
          >
            Reset path progress
          </button>
        </p>
      )}
    </div>
  );
};

interface StageItemProps {
  path: LearningPath;
  stage: PathStage;
  index: number;
  isCurrent: boolean;
  open: boolean;
  onToggle: () => void;
  src: CompletionSource;
  modulesById: Map<string, ExamModule>;
  progress: Record<string, string[]>;
}

const StageItem: React.FC<StageItemProps> = ({ path, stage, index, isCurrent, open, onToggle, src, modulesById, progress }) => {
  const unlocked = stageUnlocked(path, index, src);
  const done = stageComplete(path.id, stage, src);
  // Alternatives (the same lab for Linux or Windows) count once
  const units = stageUnits(stage);
  const doneCount = units.filter(u => u.some(s => stepComplete(path.id, s, src))).length;
  const prevStage = index > 0 ? path.stages[index - 1] : null;
  const panelId = `stage-${stage.id}-steps`;

  let status: React.ReactNode;
  if (done) {
    status = (
      <span className="inline-flex items-center gap-1 font-medium text-ok">
        <Check className="w-4 h-4" aria-hidden="true" />
        Done
      </span>
    );
  } else if (!unlocked) {
    status = (
      <span className="inline-flex items-center gap-1 text-muted">
        <Lock className="w-3.5 h-3.5" aria-hidden="true" />
        Locked
      </span>
    );
  } else {
    status = (
      <span className="text-muted tabular-nums">
        {doneCount} of {units.length} done
      </span>
    );
  }

  return (
    <li
      className={`rounded-md ${isCurrent ? 'bg-surface border border-line' : 'border border-transparent'}`}
      aria-current={isCurrent ? 'step' : undefined}
    >
      <h3>
        <button
          type="button"
          aria-expanded={open}
          aria-controls={panelId}
          onClick={onToggle}
          className="w-full text-left grid grid-cols-[1fr_auto] gap-x-4 gap-y-1 px-4 py-4 rounded-md hover:bg-surface-2 transition-colors"
        >
          <span className="min-w-0">
            <span className="block text-sm text-muted">Stage {index + 1}</span>
            <span className={`block text-base font-semibold ${unlocked ? 'text-text' : 'text-muted'}`}>{stage.title}</span>
          </span>
          <span className="flex items-center gap-3 text-sm whitespace-nowrap self-start pt-0.5">
            {status}
            <ChevronDown
              className={`w-4 h-4 text-muted ${open ? 'rotate-180' : ''}`}
              aria-hidden="true"
            />
          </span>
          <span className="col-span-2 block text-sm text-muted max-w-prose">{stage.goal}</span>
          {!unlocked && prevStage && (
            <span className="col-span-2 block text-sm text-muted">Finish {prevStage.title} to unlock.</span>
          )}
        </button>
      </h3>

      <div id={panelId} hidden={!open}>
        <ol className="px-2 pb-3">
          {stage.steps.map(step => {
            const Icon = KIND_ICON[step.kind];
            const complete = stepComplete(path.id, step, src);
            const title = stepTitle(step, modulesById);
            let meta = `${KIND_LABEL[step.kind]} · ${stepMinutes(step, modulesById)} min`;
            const mod = step.kind === 'lab' ? modulesById.get(step.moduleId) : undefined;
            if (mod && !complete) {
              const tasksDone = mod.objectives.filter(o => progress[mod.id]?.includes(o.id)).length;
              if (tasksDone > 0) meta += ` · ${tasksDone} of ${mod.objectives.length} tasks done`;
            }
            const inner = (
              <>
                <Icon className={`w-4 h-4 mt-1 shrink-0 ${unlocked ? 'text-muted' : 'text-subtle'}`} aria-hidden="true" />
                <span className="min-w-0 flex-1">
                  <span className={`block text-[15px] ${unlocked ? 'text-text group-hover:text-accent' : 'text-muted'}`}>
                    {title}
                  </span>
                  <span className="block text-sm text-muted">{meta}</span>
                </span>
                <span className="shrink-0 text-sm pt-0.5">
                  {complete ? (
                    <span className="inline-flex items-center gap-1 font-medium text-ok">
                      <Check className="w-4 h-4" aria-hidden="true" />
                      Done
                    </span>
                  ) : !unlocked ? (
                    <>
                      <Lock className="w-4 h-4 text-subtle" aria-hidden="true" />
                      <span className="sr-only">Locked</span>
                    </>
                  ) : null}
                </span>
              </>
            );
            return (
              <li key={step.id}>
                {unlocked ? (
                  <a
                    href={learnHref(path.id, step.id)}
                    className="group flex items-start gap-3 min-h-11 px-2 py-2.5 rounded-md hover:bg-surface-2 transition-colors"
                  >
                    {inner}
                  </a>
                ) : (
                  <div className="flex items-start gap-3 min-h-11 px-2 py-2.5">{inner}</div>
                )}
              </li>
            );
          })}
        </ol>
      </div>
    </li>
  );
};
