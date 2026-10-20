import React from 'react';
import { ArrowRight, Check } from 'lucide-react';
import { ExamModule } from '../types/modules';
import { TrackSection, routeHref } from '../lib/router';
import { Progress } from '../lib/progress';
import { TRACK_NAMES, moduleSummary, topicLabel } from '../lib/modules';

interface ModuleSelectorProps {
  track: TrackSection;
  modules: ExamModule[];
  progress: Progress;
  onResetProgress: () => void;
}

const INTRO: Record<TrackSection, string> = {
  linux:
    'Practice for the LPIC-1 exams (101-500 and 102-500) in a simulated Linux shell. ' +
    'Each lab gives you a small problem on a working system and a short list of tasks. ' +
    'You solve it with the same commands you would type on a real machine, and each task is checked as soon as you finish it.',
  windows:
    'Practice for the performance-based questions on CompTIA A+, Network+ and Security+. ' +
    'Each lab puts you on a Windows machine with something to fix, using Command Prompt, PowerShell ' +
    'or a simulated admin console such as Active Directory or Group Policy. Tasks are checked as you go.',
};

export const ModuleSelector: React.FC<ModuleSelectorProps> = ({ track, modules, progress, onResetProgress }) => {
  const doneCount = (mod: ExamModule) =>
    mod.objectives.filter(o => progress[mod.id]?.includes(o.id)).length;
  const labsDone = modules.filter(m => doneCount(m) === m.objectives.length).length;
  const tasksDone = modules.reduce((sum, mod) => sum + doneCount(mod), 0);
  const tasksTotal = modules.reduce((sum, mod) => sum + mod.objectives.length, 0);
  const hasProgress = modules.some(m => doneCount(m) > 0);
  const nextModule = modules.find(m => doneCount(m) < m.objectives.length) ?? modules[0];
  const nextModuleName = nextModule ? `${topicLabel(nextModule)} ${nextModule.title}` : null;

  const handleReset = () => {
    const ok = window.confirm(
      `Clear your saved progress for the ${modules.length} ${TRACK_NAMES[track].toLowerCase()}? This can't be undone.`,
    );
    if (ok) onResetProgress();
  };

  return (
    <div className="max-w-3xl mx-auto w-full px-4 sm:px-6 py-8 sm:py-12">
      <header className="space-y-3">
        <h1 className="text-2xl font-semibold text-text">{TRACK_NAMES[track]}</h1>
        <p className="text-[15px] text-muted max-w-prose">{INTRO[track]}</p>
        <div className="mt-5 max-w-xl space-y-2">
          <div
            role="progressbar"
            aria-label={`${TRACK_NAMES[track]} task progress`}
            aria-valuemin={0}
            aria-valuemax={tasksTotal}
            aria-valuenow={tasksDone}
            className="h-2 overflow-hidden rounded-full bg-surface-2"
          >
            <div
              className="h-full rounded-full bg-accent transition-[width]"
              style={{ width: `${tasksTotal ? (tasksDone / tasksTotal) * 100 : 0}%` }}
            />
          </div>
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-muted">
            <span>{tasksDone} of {tasksTotal} tasks done</span>
            <span aria-hidden="true">·</span>
            <span>{labsDone} of {modules.length} labs complete</span>
            <span className="text-subtle">Saved in this browser</span>
          {hasProgress && (
            <button
              type="button"
              onClick={handleReset}
              className="text-sm font-medium text-muted underline underline-offset-2 decoration-line-strong hover:text-danger hover:decoration-danger rounded-sm"
            >
              Reset progress
            </button>
          )}
          </div>
        </div>
        {nextModule && (
          <a
            href={routeHref({ section: track, moduleId: nextModule.id })}
            className="mt-5 inline-flex min-h-11 items-center gap-2 rounded-md bg-accent px-4 py-2 text-sm font-medium text-accent-fg hover:opacity-90"
          >
            <span>{hasProgress ? 'Continue' : 'Start your first lab'}: {nextModuleName}</span>
            <ArrowRight className="size-4 shrink-0" aria-hidden="true" />
          </a>
        )}
      </header>

      <ol className="mt-8 border-t border-line">
        {modules.map(mod => {
          const done = doneCount(mod);
          const total = mod.objectives.length;
          const complete = total > 0 && done === total;
          return (
            <li key={mod.id} className="border-b border-line">
              <a
                href={routeHref({ section: track, moduleId: mod.id })}
                className="group grid grid-cols-[3.75rem_1fr] sm:grid-cols-[5rem_1fr_auto] gap-x-4 gap-y-1 px-2 -mx-2 py-4 rounded-md hover:bg-surface-2 transition-colors"
              >
                <span className="text-[15px] text-muted tabular-nums pt-px">{topicLabel(mod)}</span>
                <span className="min-w-0 space-y-1">
                  <span className="block text-[15px] font-medium text-text group-hover:text-accent">
                    {mod.title}
                  </span>
                  <span className="block text-sm text-muted">{moduleSummary(mod)}</span>
                  <span className="block text-sm text-muted">
                    {mod.difficulty} · about {mod.estimatedMinutes} min
                  </span>
                </span>
                <span className="col-start-2 sm:col-start-3 sm:row-start-1 text-sm whitespace-nowrap sm:text-right sm:pt-px">
                  {complete ? (
                    <span className="inline-flex items-center gap-1 font-medium text-ok">
                      <Check className="w-4 h-4" aria-hidden="true" />
                      Done
                    </span>
                  ) : (
                    <span className="text-muted tabular-nums">
                      {done} of {total} tasks
                    </span>
                  )}
                </span>
              </a>
            </li>
          );
        })}
      </ol>
    </div>
  );
};
