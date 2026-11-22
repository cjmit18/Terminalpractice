import React, { useEffect, useMemo, useRef, useState } from 'react';
import { ArrowRight, Check, X } from 'lucide-react';
import { DRILLS, type Drill } from '../../lib/drills/catalog';
import { nextSeed } from '../../lib/drills/next';
import { useGameLayer } from '../celebrate/GameLayer';
import { primaryLinkClass, secondaryLinkClass } from '../journey/shared';

const textButtonClass = 'min-h-11 sm:min-h-9 text-sm font-medium text-accent underline-offset-2 hover:underline rounded-sm';

/**
 * The Drills tab (#/sandbox/drills): generated practice. Choose a drill, then one question at a time: type the
 * answer and check it. A miss shows a hint and gives one more try; the answer and how it is worked out show
 * after a right answer or a second miss. A hint is there on request, and a question can be skipped. Every question is new, so there is nothing
 * to finish and no score to keep; the count is for this visit only.
 */
export const DrillsPage: React.FC = () => {
  const [drillId, setDrillId] = useState<Drill['id']>('subnet');
  const drill = DRILLS.find(d => d.id === drillId)!;
  return (
    <>
      <fieldset className="mt-8">
        <legend className="text-sm font-medium text-muted">Drill</legend>
        <div className="mt-2 flex flex-wrap gap-x-5 gap-y-2">
          {DRILLS.map(d => (
            <label key={d.id} className="inline-flex min-h-11 sm:min-h-9 items-center gap-2 text-[15px] text-text cursor-pointer">
              <input
                type="radio"
                name="drill"
                value={d.id}
                checked={d.id === drillId}
                onChange={() => setDrillId(d.id)}
                className="size-4 accent-accent"
              />
              {d.title}
            </label>
          ))}
        </div>
      </fieldset>
      {/* A new drill starts fresh: its own question, answer box and count */}
      <DrillRunner key={drill.id} drill={drill} />
    </>
  );
};

const DrillRunner: React.FC<{ drill: Drill }> = ({ drill }) => {
  const { record } = useGameLayer();
  const [seed, setSeed] = useState(() => nextSeed(drill.generate, null));
  const question = useMemo(() => drill.generate(seed), [drill, seed]);
  const [typed, setTyped] = useState('');
  // Two tries a question: a first miss shows the hint and asks again; the answer only shows after the second
  const [missed, setMissed] = useState(false);
  const [result, setResult] = useState<'right' | 'wrong' | null>(null);
  const [hintShown, setHintShown] = useState(false);
  const [nudge, setNudge] = useState(false);
  const [tally, setTally] = useState({ right: 0, answered: 0 });

  const inputRef = useRef<HTMLInputElement>(null);
  const feedbackRef = useRef<HTMLDivElement>(null);
  // Focus moves only after the learner acts, never when the page first opens
  const focusTarget = useRef<'feedback' | 'input' | null>(null);
  useEffect(() => {
    const target = focusTarget.current;
    focusTarget.current = null;
    if (target === 'feedback') feedbackRef.current?.focus();
    else if (target === 'input') {
      inputRef.current?.focus();
      inputRef.current?.select();
    }
  }, [result, seed, missed]);

  const check = (e: React.FormEvent) => {
    e.preventDefault();
    if (result) return;
    if (typed.trim() === '') {
      setNudge(true);
      inputRef.current?.focus();
      return;
    }
    const right = drill.check(question, typed);
    if (!right && !missed) {
      // First miss: the hint, and one more try with the answer still in the box to correct
      setMissed(true);
      setHintShown(true);
      focusTarget.current = 'input';
      return;
    }
    setResult(right ? 'right' : 'wrong');
    setTally(t => ({ right: t.right + (right ? 1 : 0), answered: t.answered + 1 }));
    if (right) record([drill.fact]);
    focusTarget.current = 'feedback';
  };

  const next = () => {
    // Never the same question twice in a row (#84 review)
    setSeed(nextSeed(drill.generate, question.prompt));
    setTyped('');
    setMissed(false);
    setResult(null);
    setHintShown(false);
    setNudge(false);
    focusTarget.current = 'input';
  };

  const describedBy = [hintShown && result === null ? 'drill-hint' : '', nudge ? 'drill-nudge' : ''].filter(Boolean).join(' ') || undefined;

  return (
    <>
      <section aria-labelledby="drill-heading" className="mt-6">
        <h2 id="drill-heading" className="text-base font-semibold">
          {drill.title}
        </h2>
        <p className="mt-1 text-sm text-muted max-w-prose">{drill.blurb}</p>

        <form onSubmit={check} noValidate data-seed={seed} className="mt-5 rounded-md border border-line bg-surface px-4 py-4 space-y-4">
          <label htmlFor="drill-answer" className="block text-[15px] font-medium text-text max-w-prose">
            {question.prompt}
          </label>
          <div className="flex flex-wrap items-start gap-3">
            <input
              ref={inputRef}
              id="drill-answer"
              type="text"
              value={typed}
              onChange={e => {
                setTyped(e.target.value);
                setNudge(false);
              }}
              readOnly={result !== null}
              autoComplete="off"
              autoCapitalize="none"
              autoCorrect="off"
              spellCheck={false}
              aria-invalid={nudge || (missed && result === null) || undefined}
              aria-describedby={describedBy}
              className={`block w-full sm:w-64 min-h-11 sm:min-h-10 rounded-md border border-line-strong bg-bg px-3 text-[15px] text-text aria-[invalid=true]:border-danger ${drill.mono ? 'font-mono' : ''}`}
            />
            {result === null && (
              <button type="submit" className={primaryLinkClass}>
                {missed ? 'Check again' : 'Check'}
              </button>
            )}
          </div>
          {nudge && (
            <p id="drill-nudge" className="text-sm text-danger">
              Type an answer first.
            </p>
          )}

          {result === null && missed && (
            <p role="status" className="inline-flex items-center gap-1.5 text-[15px] font-medium text-danger">
              <X className="size-4" aria-hidden="true" />
              Not quite. Try once more.
            </p>
          )}
          {result === null && hintShown && (
            <p id="drill-hint" className="text-[15px] text-muted max-w-prose">
              <span className="font-medium text-text">Hint: </span>
              {question.hint}
            </p>
          )}
          {result === null && (
            <p className="flex flex-wrap gap-x-4 gap-y-2">
              {!hintShown && (
                <button type="button" onClick={() => setHintShown(true)} className={textButtonClass}>
                  Show a hint
                </button>
              )}
              <button type="button" onClick={next} className={textButtonClass}>
                Skip this question
              </button>
            </p>
          )}

          {result && (
            <div ref={feedbackRef} tabIndex={-1} role="status" className="space-y-2 rounded-sm">
              <p className={`inline-flex items-center gap-1.5 text-[15px] font-medium ${result === 'right' ? 'text-ok' : 'text-danger'}`}>
                {result === 'right' ? <Check className="size-4" aria-hidden="true" /> : <X className="size-4" aria-hidden="true" />}
                {result === 'right' ? (missed ? 'Correct, on the second try.' : 'Correct.') : 'Not quite.'}
              </p>
              <p className="text-[15px]">
                The answer is <span className={`font-medium ${drill.mono ? 'font-mono' : ''}`}>{question.answer}</span>.
              </p>
              <p className="text-[15px] text-muted max-w-prose">{question.explanation}</p>
              <p className="pt-1">
                <button type="button" onClick={next} className={result === 'right' ? primaryLinkClass : secondaryLinkClass}>
                  Next question
                  <ArrowRight className="size-4" aria-hidden="true" />
                </button>
              </p>
            </div>
          )}
        </form>

        {tally.answered > 0 && (
          <p className="mt-3 text-sm text-muted">
            {tally.right} of {tally.answered} right this visit
          </p>
        )}
      </section>
    </>
  );
};
