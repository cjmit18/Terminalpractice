import React, { useEffect, useRef, useState } from 'react';
import { ExamModule, ModuleObjective } from '../../types/modules';
import { Check, CheckCircle2 } from 'lucide-react';

/**
 * Hints in the data read like `Execute: chmod 750 dir` or `Run "ls -ld dir" to ...`.
 * Show the command parts in mono and the rest as prose.
 */
export function HintText({ text }: { text: string }) {
  const exec = text.match(/^Execute:\s*(.+)$/s);
  if (exec) {
    return (
      <>
        Run <code className="font-mono text-text">{exec[1]}</code>
      </>
    );
  }
  const parts = text.split(/"([^"]+)"/g);
  return (
    <>
      {parts.map((part, i) =>
        i % 2 === 1 ? (
          <code key={i} className="font-mono text-text">{part}</code>
        ) : (
          <React.Fragment key={i}>{part}</React.Fragment>
        )
      )}
    </>
  );
}

interface TasksPanelProps {
  module: ExamModule;
  completed: Set<string>;
  /** Called each time a hint rung is revealed. `rung` counts from 1 (the gentlest); the last rung is the full hint. */
  onHint?: (objectiveId: string, rung: number) => void;
}

type HintRung = { kind: 'nudge' | 'shape' | 'answer'; text: string };

/** The rungs of one task's hint ladder, gentlest first. A task with no nudge or shape has just its hint. */
const hintRungs = (obj: ModuleObjective): HintRung[] => [
  ...(obj.nudge ? [{ kind: 'nudge' as const, text: obj.nudge }] : []),
  ...(obj.shape ? [{ kind: 'shape' as const, text: obj.shape }] : []),
  { kind: 'answer' as const, text: obj.hint },
];

export const TasksPanel: React.FC<TasksPanelProps> = ({ module, completed, onHint }) => {
  // How many rungs of each task's ladder are showing; a missing entry means none
  const [shown, setShown] = useState<Map<string, number>>(new Map());
  const total = module.objectives.length;
  const done = module.objectives.filter(o => completed.has(o.id)).length;
  const allDone = total > 0 && done === total;

  const setRungs = (id: string, count: number) =>
    setShown(prev => {
      const next = new Map(prev);
      if (count > 0) next.set(id, count);
      else next.delete(id);
      return next;
    });

  const reveal = (id: string, count: number) => {
    setRungs(id, count);
    onHint?.(id, count);
  };

  return (
    <div className="space-y-8 max-w-prose">
      <section className="space-y-3">
        <p className="text-[15px] leading-relaxed">{module.scenarioDescription}</p>
        <p className="text-sm text-muted">{module.systemContext.split(/\s*\|\s*/).join(' · ')}</p>
      </section>

      <section aria-labelledby="tasks-heading">
        <div className="flex items-baseline justify-between gap-4 mb-2">
          <h2 id="tasks-heading" className="text-base font-semibold">Your tasks</h2>
          <span className="text-sm text-muted" aria-live="polite">
            {done} of {total} done
          </span>
        </div>

        {allDone && (
          <p className="flex items-start gap-2 mb-3 px-3 py-2.5 rounded-md bg-ok-soft text-sm text-text">
            <CheckCircle2 className="size-4 mt-0.5 shrink-0 text-ok" aria-hidden="true" />
            <span>All tasks done. Reset the lab if you want to run through it again from scratch.</span>
          </p>
        )}

        <ol className="divide-y divide-line border-y border-line">
          {module.objectives.map((obj, idx) => {
            const isDone = completed.has(obj.id);
            const rungs = hintRungs(obj);
            const count = shown.get(obj.id) ?? 0;
            const hintId = `hint-${obj.id}`;
            return (
              <li key={obj.id} className="flex gap-3 py-4">
                <span
                  className={`mt-0.5 size-6 shrink-0 inline-flex items-center justify-center rounded-full text-xs font-medium ${
                    isDone ? 'bg-ok text-bg' : 'border border-line-strong text-muted'
                  }`}
                  aria-hidden="true"
                >
                  {isDone ? <Check className="size-3.5" strokeWidth={3} /> : idx + 1}
                </span>
                <div className="flex-1 min-w-0 space-y-1">
                  <p className="font-medium">
                    {obj.title}
                    {isDone && <span className="sr-only"> (done)</span>}
                  </p>
                  <p className="text-sm text-muted leading-relaxed">
                    <HintText text={obj.description} />
                  </p>
                  {rungs.length > 1 ? (
                    <HintLadder
                      id={hintId}
                      rungs={rungs}
                      count={count}
                      onReveal={next => reveal(obj.id, next)}
                      onHide={() => setRungs(obj.id, 0)}
                      note={idx === 0}
                    />
                  ) : (
                    <>
                      <button
                        type="button"
                        onClick={() => (count ? setRungs(obj.id, 0) : reveal(obj.id, 1))}
                        aria-expanded={count > 0}
                        aria-controls={hintId}
                        className="text-sm text-accent hover:underline underline-offset-2 py-1"
                      >
                        {count ? 'Hide hint' : 'Show hint'}
                      </button>
                      {idx === 0 && <HintCostNote />}
                      {count > 0 && (
                        <p id={hintId} className="text-sm text-muted bg-surface-2 rounded-md px-3 py-2 break-words">
                          <HintText text={obj.hint} />
                        </p>
                      )}
                    </>
                  )}
                </div>
              </li>
            );
          })}
        </ol>
      </section>

      {module.examTips.length > 0 && (
        <section aria-labelledby="tips-heading" className="space-y-2">
          <h2 id="tips-heading" className="text-base font-semibold">Exam tips</h2>
          <ul className="list-disc pl-5 space-y-2 text-[15px] leading-relaxed marker:text-subtle">
            {module.examTips.map((tip, i) => (
              <li key={i}>{tip}</li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
};

interface HintLadderProps {
  id: string;
  rungs: HintRung[];
  count: number;
  onReveal: (count: number) => void;
  onHide: () => void;
  /** Show "Hints never cost anything." under the buttons (the first task only) */
  note: boolean;
}

/** Said once, under the first task's hint button. Nothing counts hints, anywhere. */
const HintCostNote = () => <p className="text-sm text-muted">Hints never cost anything.</p>;

/**
 * A nudge first, then the command's shape, then the full hint. Each rung stays on screen
 * under the one before, so the help narrows down step by step.
 */
const HintLadder: React.FC<HintLadderProps> = ({ id, rungs, count, onReveal, onHide, note }) => {
  const more = count < rungs.length;
  // "Show more" goes away with the last rung, and "Hide hints" when hiding: keep keyboard focus on the hint controls
  const hideRef = useRef<HTMLButtonElement>(null);
  const showRef = useRef<HTMLButtonElement>(null);
  const focusHide = useRef(false);
  const focusShow = useRef(false);
  useEffect(() => {
    if (focusHide.current) hideRef.current?.focus();
    if (focusShow.current) showRef.current?.focus();
    focusHide.current = false;
    focusShow.current = false;
  }, [count]);

  return (
    <>
      <div className="flex flex-wrap gap-x-4">
        {more && (
          <button
            ref={showRef}
            type="button"
            onClick={() => {
              focusHide.current = count + 1 === rungs.length;
              onReveal(count + 1);
            }}
            aria-expanded={count > 0}
            aria-controls={id}
            className="text-sm text-accent hover:underline underline-offset-2 py-1"
          >
            {count === 0 ? 'Show a nudge' : 'Show more'}
          </button>
        )}
        {count > 0 && (
          <button
            ref={hideRef}
            type="button"
            onClick={() => {
              focusShow.current = true;
              onHide();
            }}
            className="text-sm text-accent hover:underline underline-offset-2 py-1">
            Hide hints
          </button>
        )}
      </div>
      {note && <HintCostNote />}
      {count > 0 && (
        <div id={id} aria-live="polite" className="space-y-2 text-sm text-muted bg-surface-2 rounded-md px-3 py-2 break-words">
          {rungs.slice(0, count).map(rung =>
            rung.kind === 'shape' ? (
              <p key={rung.kind}>
                Fill in the blanks: <code className="font-mono text-text">{rung.text}</code>
              </p>
            ) : (
              <p key={rung.kind}>
                <HintText text={rung.text} />
              </p>
            )
          )}
          {count === 1 && more && <p>Try it in the terminal first. Come back for more if you need it.</p>}
        </div>
      )}
    </>
  );
};

export const ConceptsPanel: React.FC<{ module: ExamModule }> = ({ module }) => (
  <div className="max-w-prose space-y-6">
    {module.solutionWalkthrough.map(step => (
      <section key={step.step} className="space-y-1">
        <h2 className="text-base font-semibold">{step.title}</h2>
        <p className="text-[15px] leading-relaxed text-muted">{step.underlyingConcept}</p>
      </section>
    ))}
  </div>
);

interface WalkthroughPanelProps {
  module: ExamModule;
  onRunStep: (lines: string[]) => void;
}

export const WalkthroughPanel: React.FC<WalkthroughPanelProps> = ({ module, onRunStep }) => {
  const [ran, setRan] = useState<Set<number>>(new Set());

  return (
    <div className="max-w-prose space-y-6">
      <p className="text-sm text-muted">
        One way to solve this lab, step by step. Try it on your own first. Run sends the step to the terminal.
      </p>
      <ol className="space-y-6">
        {module.solutionWalkthrough.map(step => {
          const lines = step.command.split('\n');
          return (
            <li key={step.step} className="space-y-2">
              <h2 className="text-base font-semibold">
                <span className="text-muted font-normal">{step.step}.</span> {step.title}
              </h2>
              <div className="flex items-start gap-2">
                <pre className="flex-1 min-w-0 px-3 py-2 rounded-md bg-surface-2 font-mono text-sm whitespace-pre-wrap break-words">
                  {step.command}
                </pre>
                <button
                  type="button"
                  onClick={() => {
                    onRunStep(lines);
                    setRan(prev => new Set(prev).add(step.step));
                  }}
                  aria-label={`Run step ${step.step}${lines.length > 1 ? `, ${lines.length} commands` : ''}`}
                  className="shrink-0 h-10 sm:h-9 px-3 rounded-md border border-line-strong bg-surface text-sm font-medium hover:bg-surface-2 transition-colors"
                >
                  Run
                </button>
              </div>
              {ran.has(step.step) && (
                <p className="flex items-center gap-1.5 text-sm text-muted">
                  <Check className="size-4 text-ok" aria-hidden="true" />
                  Sent to the terminal
                </p>
              )}
              <p className="text-sm text-muted leading-relaxed">{step.explanation}</p>
            </li>
          );
        })}
      </ol>
    </div>
  );
};
