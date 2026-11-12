import React, { useEffect, useMemo, useRef, useState } from 'react';
import { ArrowRight, Check, X } from 'lucide-react';
import { checkSubnetAnswer, generateSubnetQuestion } from '../../lib/drills/subnet';
import { randomSeed } from '../../lib/rotation';
import { useGameLayer } from '../celebrate/GameLayer';
import { primaryLinkClass, secondaryLinkClass } from '../journey/shared';
import { ChallengeTabs } from './ChallengeTabs';

/** The fact kept once a subnetting drill has been answered right (for the activity record) */
export const SUBNET_DRILL_FACT = 'drill:subnet';

/**
 * #/sandbox/drills: generated practice. One subnetting question at a time: type the answer, check it,
 * read how it is worked out, take the next one. Every question is new, so there is nothing to finish
 * and no score to keep; the count is for this visit only.
 */
export const DrillsPage: React.FC = () => {
  const { record } = useGameLayer();
  const [seed, setSeed] = useState(randomSeed);
  const question = useMemo(() => generateSubnetQuestion(seed), [seed]);
  const [typed, setTyped] = useState('');
  const [result, setResult] = useState<'right' | 'wrong' | null>(null);
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
    else if (target === 'input') inputRef.current?.focus();
  }, [result, seed]);

  const check = (e: React.FormEvent) => {
    e.preventDefault();
    if (result) return;
    if (typed.trim() === '') {
      setNudge(true);
      inputRef.current?.focus();
      return;
    }
    const right = checkSubnetAnswer(question, typed);
    setResult(right ? 'right' : 'wrong');
    setTally(t => ({ right: t.right + (right ? 1 : 0), answered: t.answered + 1 }));
    if (right) record([SUBNET_DRILL_FACT]);
    focusTarget.current = 'feedback';
  };

  const next = () => {
    setSeed(randomSeed());
    setTyped('');
    setResult(null);
    setNudge(false);
    focusTarget.current = 'input';
  };

  return (
    <div className="max-w-3xl mx-auto w-full px-4 sm:px-6 py-8 sm:py-12">
      <header className="space-y-3">
        <h1 className="text-2xl font-semibold text-text">Challenges</h1>
        <p className="text-[15px] text-muted max-w-prose">
          Drills make a new question every time, so there is no answer to memorise, only the method.
        </p>
      </header>
      <ChallengeTabs current="drills" />

      <section aria-labelledby="drill-heading" className="mt-8">
        <h2 id="drill-heading" className="text-base font-semibold">
          Subnetting
        </h2>
        <p className="mt-1 text-sm text-muted max-w-prose">
          Network and broadcast addresses, host ranges, masks and prefix lengths, on private addresses from /16 to /30.
        </p>

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
              aria-invalid={nudge || undefined}
              aria-describedby={nudge ? 'drill-nudge' : undefined}
              className="block w-full sm:w-64 min-h-11 sm:min-h-10 rounded-md border border-line-strong bg-bg px-3 font-mono text-[15px] text-text aria-[invalid=true]:border-danger"
            />
            {result === null && (
              <button type="submit" className={primaryLinkClass}>
                Check
              </button>
            )}
          </div>
          {nudge && (
            <p id="drill-nudge" className="text-sm text-danger">
              Type an answer first.
            </p>
          )}

          {result && (
            <div ref={feedbackRef} tabIndex={-1} role="status" className="space-y-2 rounded-sm">
              <p className={`inline-flex items-center gap-1.5 text-[15px] font-medium ${result === 'right' ? 'text-ok' : 'text-danger'}`}>
                {result === 'right' ? <Check className="size-4" aria-hidden="true" /> : <X className="size-4" aria-hidden="true" />}
                {result === 'right' ? 'Correct.' : 'Not quite.'}
              </p>
              <p className="text-[15px]">
                The answer is <span className="font-mono font-medium">{question.answer}</span>.
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
    </div>
  );
};
