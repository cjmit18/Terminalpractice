import React, { useEffect, useRef, useState } from 'react';
import { ArrowRight, Check, X } from 'lucide-react';
import { PathStep, QuizQuestion } from '../../types/paths';
import { QuizScore, correctNeeded, quizPassed } from '../../lib/journey';
import { cx } from '../sims/ui';
import { primaryLinkClass, secondaryLinkClass } from './shared';

type QuizStep = Extract<PathStep, { kind: 'quiz' }>;

interface QuizViewProps {
  step: QuizStep;
  best: QuizScore | undefined;
  onScore: (score: QuizScore) => void;
  /** Where Continue goes once passed, and what it is called */
  next: { href: string; title: string };
}

const buttonClass = (primary: boolean) => (primary ? primaryLinkClass : secondaryLinkClass);

/**
 * One question at a time: answer, check, read why, move on. The explanation sits right
 * under the choices you just made, which is the point of a checkpoint, and on a phone
 * there is never a long page to scroll back through to find the feedback.
 */
export const QuizView: React.FC<QuizViewProps> = ({ step, best, onScore, next }) => {
  const total = step.questions.length;
  const needed = correctNeeded(total, step.passMark);
  const [index, setIndex] = useState(0);
  const [answers, setAnswers] = useState<(number | null)[]>(() => step.questions.map(() => null));
  const [checked, setChecked] = useState(false);
  const [finished, setFinished] = useState(false);
  const [nudge, setNudge] = useState(false);

  const feedbackRef = useRef<HTMLDivElement>(null);
  const legendRef = useRef<HTMLHeadingElement>(null);
  const resultRef = useRef<HTMLHeadingElement>(null);
  const firstChoiceRef = useRef<HTMLInputElement>(null);
  // Only move focus after the learner acts, never on first render
  const focusTarget = useRef<'feedback' | 'question' | 'result' | null>(null);

  const question = step.questions[index];
  const selected = answers[index];

  useEffect(() => {
    const target = focusTarget.current;
    focusTarget.current = null;
    if (target === 'feedback') feedbackRef.current?.focus();
    else if (target === 'question') legendRef.current?.focus();
    else if (target === 'result') resultRef.current?.focus();
  }, [index, checked, finished]);

  const choose = (choice: number) => {
    if (checked) return;
    setNudge(false);
    setAnswers(prev => prev.map((a, i) => (i === index ? choice : a)));
  };

  const check = () => {
    if (selected === null) {
      setNudge(true);
      firstChoiceRef.current?.focus();
      return;
    }
    focusTarget.current = 'feedback';
    setChecked(true);
  };

  const advance = () => {
    if (index < total - 1) {
      focusTarget.current = 'question';
      setIndex(index + 1);
      setChecked(false);
      return;
    }
    const correct = step.questions.filter((q, i) => answers[i] === q.answer).length;
    onScore({ correct, total });
    focusTarget.current = 'result';
    setFinished(true);
  };

  const retry = () => {
    setAnswers(step.questions.map(() => null));
    setIndex(0);
    setChecked(false);
    setFinished(false);
    focusTarget.current = 'question';
  };

  const intro = (
    <p className="text-sm text-muted">
      {total === 1 ? '1 question' : `${total} questions`} · pass with {needed} correct
      {best && (
        <>
          {' '}
          · best so far {best.correct} of {best.total}
          {quizPassed(best, step.passMark) ? ', passed' : ''}
        </>
      )}
    </p>
  );

  if (finished) {
    const correct = step.questions.filter((q, i) => answers[i] === q.answer).length;
    const passed = quizPassed({ correct, total }, step.passMark);
    return (
      <div className="space-y-6">
        <section aria-labelledby="quiz-result" className="space-y-2">
          <h2 id="quiz-result" ref={resultRef} tabIndex={-1} className="text-xl font-semibold focus:outline-none">
            {correct} of {total} correct
          </h2>
          {passed ? (
            <p className="inline-flex items-start gap-2 text-[15px] font-medium text-ok">
              <Check className="w-5 h-5 shrink-0 mt-px" aria-hidden="true" />
              You passed. You needed {needed} of {total}.
            </p>
          ) : (
            <p className="inline-flex items-start gap-2 text-[15px] font-medium text-danger">
              <X className="w-5 h-5 shrink-0 mt-px" aria-hidden="true" />
              Not passed yet. You need {needed} of {total} to pass.
            </p>
          )}
        </section>

        <ol className="border-t border-line">
          {step.questions.map((q, i) => {
            const right = answers[i] === q.answer;
            return (
              <li key={q.id} className="flex items-start gap-3 py-3 border-b border-line">
                {right ? (
                  <Check className="w-4 h-4 mt-1 shrink-0 text-ok" aria-hidden="true" />
                ) : (
                  <X className="w-4 h-4 mt-1 shrink-0 text-danger" aria-hidden="true" />
                )}
                <span className="min-w-0">
                  <span className="block text-[15px]">{q.prompt}</span>
                  <span className={cx('block text-sm', right ? 'text-muted' : 'text-text')}>
                    <span className="sr-only">{right ? 'Correct. ' : 'Incorrect. '}</span>
                    {right ? 'Correct' : `Answer: ${q.choices[q.answer]}`}
                  </span>
                </span>
              </li>
            );
          })}
        </ol>

        <div className="flex flex-wrap items-center gap-3">
          {passed && (
            <a href={next.href} className={primaryLinkClass}>
              Continue
              <ArrowRight className="w-4 h-4" aria-hidden="true" />
            </a>
          )}
          <button type="button" onClick={retry} className={buttonClass(!passed)}>
            Try again
          </button>
        </div>
        {passed && <p className="text-sm text-muted">Next: {next.title}</p>}
      </div>
    );
  }

  return (
    <div className="space-y-5">
      {intro}
      <p className="text-sm font-medium text-muted" aria-hidden="true">
        Question {index + 1} of {total}
      </p>
      <QuestionBlock
        key={question.id}
        question={question}
        number={index + 1}
        total={total}
        selected={selected}
        checked={checked}
        onChoose={choose}
        legendRef={legendRef}
        firstChoiceRef={firstChoiceRef}
      />

      {!checked ? (
        <div className="flex flex-wrap items-center gap-3">
          <button type="button" onClick={check} className={primaryLinkClass}>
            Check answer
          </button>
          {nudge && (
            <p role="status" className="text-sm text-muted">
              Choose an answer first.
            </p>
          )}
        </div>
      ) : (
        <div className="space-y-4">
          <Feedback ref={feedbackRef} question={question} selected={selected} />
          <button type="button" onClick={advance} className={primaryLinkClass}>
            {index < total - 1 ? 'Next question' : 'See your score'}
          </button>
        </div>
      )}
    </div>
  );
};

interface QuestionBlockProps {
  question: QuizQuestion;
  number: number;
  total: number;
  selected: number | null;
  checked: boolean;
  onChoose: (i: number) => void;
  legendRef: React.RefObject<HTMLHeadingElement | null>;
  firstChoiceRef: React.RefObject<HTMLInputElement | null>;
}

/** Native radios inside a fieldset: arrow keys, Space and screen reader grouping come for free. */
const QuestionBlock: React.FC<QuestionBlockProps> = ({
  question,
  number,
  total,
  selected,
  checked,
  onChoose,
  legendRef,
  firstChoiceRef,
}) => {
  const codeId = `${question.id}-code`;
  return (
    <fieldset aria-describedby={question.code ? codeId : undefined} className="space-y-4">
      <legend className="w-full">
        <span className="sr-only">
          Question {number} of {total}:{' '}
        </span>
        <span ref={legendRef} tabIndex={-1} className="block text-lg font-medium leading-snug focus:outline-none">
          {question.prompt}
        </span>
      </legend>
      {question.code && (
        <pre id={codeId} className="overflow-x-auto rounded-md bg-surface-2 px-4 py-3 font-mono text-sm leading-relaxed">
          <code>{question.code}</code>
        </pre>
      )}
      <div className="space-y-2">
        {question.choices.map((choice, i) => {
          const isSelected = selected === i;
          const isAnswer = i === question.answer;
          let tone = 'border-line-strong bg-surface hover:bg-surface-2';
          if (!checked && isSelected) tone = 'border-accent bg-accent-soft';
          if (checked && isAnswer) tone = 'border-ok bg-ok-soft';
          else if (checked && isSelected) tone = 'border-danger bg-danger-soft';
          else if (checked) tone = 'border-line bg-surface';
          return (
            <label
              key={i}
              className={cx(
                'flex flex-wrap items-center gap-x-3 gap-y-1 min-h-12 px-4 py-2.5 rounded-md border text-[15px]',
                checked ? 'cursor-default' : 'cursor-pointer',
                tone,
              )}
            >
              <input
                ref={i === 0 ? firstChoiceRef : undefined}
                type="radio"
                name={question.id}
                value={i}
                checked={isSelected}
                disabled={checked}
                onChange={() => onChoose(i)}
                className="w-4 h-4 shrink-0 accent-[var(--accent)]"
              />
              <span className="flex-1 min-w-0">{choice}</span>
              {checked && isAnswer && (
                <span className="basis-full sm:basis-auto pl-7 sm:pl-0 inline-flex items-center gap-1 text-sm font-medium text-ok">
                  <Check className="w-4 h-4" aria-hidden="true" />
                  {isSelected ? 'Your answer, correct' : 'Correct answer'}
                </span>
              )}
              {checked && isSelected && !isAnswer && (
                <span className="basis-full sm:basis-auto pl-7 sm:pl-0 inline-flex items-center gap-1 text-sm font-medium text-danger">
                  <X className="w-4 h-4" aria-hidden="true" />
                  Your answer
                </span>
              )}
            </label>
          );
        })}
      </div>
    </fieldset>
  );
};

const Feedback = React.forwardRef<HTMLDivElement, { question: QuizQuestion; selected: number | null }>(
  ({ question, selected }, ref) => {
    const right = selected === question.answer;
    return (
      <div ref={ref} tabIndex={-1} className="rounded-md bg-surface px-4 py-3 border border-line focus:outline-none">
        <p className={cx('inline-flex items-start gap-2 text-[15px] font-medium', right ? 'text-ok' : 'text-danger')}>
          {right ? (
            <Check className="w-5 h-5 shrink-0 mt-px" aria-hidden="true" />
          ) : (
            <X className="w-5 h-5 shrink-0 mt-px" aria-hidden="true" />
          )}
          {right ? 'Correct.' : `Not quite. The answer is: ${question.choices[question.answer]}`}
        </p>
        <p className="mt-1.5 text-[15px] text-text">{question.explanation}</p>
      </div>
    );
  },
);
Feedback.displayName = 'Feedback';
