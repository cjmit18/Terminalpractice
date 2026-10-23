import React, { useEffect, useRef, useState } from 'react';
import { ArrowRight } from 'lucide-react';
import { LearningPath } from '../../types/paths';
import {
  ANSWER_HISTORY,
  CompletionSource,
  ReviewItem,
  comeBackText,
  reviewQueue,
  reviewStatus,
  whenText,
} from '../../lib/journey';
import { learnHref } from '../../lib/router';
import { useGameLayer } from '../celebrate/GameLayer';
import { Feedback, QuestionBlock } from './QuizView';
import { primaryLinkClass, secondaryLinkClass } from './shared';

interface ReviewPageProps {
  paths: LearningPath[];
  src: CompletionSource;
  /** Each answer as it is checked */
  onAnswer: (pathId: string, questionId: string, right: boolean) => void;
}

/** The answer history of a question once this answer is added */
interface Answered {
  right: boolean;
  history: boolean[];
}

/**
 * #/learn/review: up to five questions from checkpoints already taken, spaced out over days.
 * No score, no streak: just how many were right and when they come back.
 */
export const ReviewPage: React.FC<ReviewPageProps> = ({ paths, src, onAnswer }) => {
  const { record } = useGameLayer();
  // The questions are picked once per round, so answering does not reshuffle them
  const [queue, setQueue] = useState<ReviewItem[]>(() => reviewQueue(paths, src));
  const [index, setIndex] = useState(0);
  const [selected, setSelected] = useState<number | null>(null);
  const [checked, setChecked] = useState(false);
  const [answered, setAnswered] = useState<Answered[]>([]);
  const [finished, setFinished] = useState(false);
  const [nudge, setNudge] = useState(false);

  const feedbackRef = useRef<HTMLDivElement>(null);
  const legendRef = useRef<HTMLHeadingElement>(null);
  const resultRef = useRef<HTMLHeadingElement>(null);
  const firstChoiceRef = useRef<HTMLInputElement>(null);
  const focusTarget = useRef<'feedback' | 'question' | 'result' | null>(null);

  useEffect(() => {
    const target = focusTarget.current;
    focusTarget.current = null;
    if (target === 'feedback') feedbackRef.current?.focus();
    else if (target === 'question') legendRef.current?.focus();
    else if (target === 'result') resultRef.current?.focus();
  }, [index, checked, finished, queue]);

  const item = queue[index];
  const total = queue.length;

  const check = () => {
    if (!item) return;
    if (selected === null) {
      setNudge(true);
      firstChoiceRef.current?.focus();
      return;
    }
    const right = selected === item.question.answer;
    const before = src.journey.answers?.[item.key]?.history ?? [];
    setAnswered(prev => [...prev, { right, history: [...before, right].slice(-ANSWER_HISTORY) }]);
    onAnswer(item.path.id, item.question.id, right);
    focusTarget.current = 'feedback';
    setChecked(true);
  };

  const advance = () => {
    if (index < total - 1) {
      focusTarget.current = 'question';
      setIndex(index + 1);
      setSelected(null);
      setChecked(false);
      return;
    }
    record(['review:done']);
    focusTarget.current = 'result';
    setFinished(true);
  };

  const again = () => {
    setQueue(reviewQueue(paths, src));
    setIndex(0);
    setSelected(null);
    setChecked(false);
    setAnswered([]);
    setFinished(false);
    focusTarget.current = 'question';
  };

  const header = (
    <>
      <nav aria-label="Breadcrumb" className="text-sm">
        <a href={learnHref()} className="text-muted hover:text-text underline-offset-2 hover:underline">
          Learning paths
        </a>
      </nav>
      <header className="mt-4 space-y-2">
        <h1 className="text-2xl font-semibold text-text">Review</h1>
        <p className="text-[15px] text-muted max-w-prose">
          A few questions from checkpoints you have taken. Each right answer sends a question further out, from a day to
          three weeks. One you miss comes back soon.
        </p>
      </header>
    </>
  );

  const back = (
    <a href={learnHref()} className={primaryLinkClass}>
      Back to learning paths
      <ArrowRight className="w-4 h-4" aria-hidden="true" />
    </a>
  );

  if (total === 0) {
    const { nextAt } = reviewStatus(paths, src);
    return (
      <div className="max-w-3xl mx-auto w-full px-4 sm:px-6 py-8 sm:py-12">
        {header}
        <section className="mt-8 space-y-4 max-w-prose">
          <h2 className="text-base font-semibold">Nothing to review right now</h2>
          <p className="text-[15px]">
            {nextAt
              ? `The next question comes back ${whenText(nextAt)}.`
              : 'Take a checkpoint in any path first. The questions you answer come back here a day or more later, and the ones you miss come back sooner.'}
          </p>
          {back}
        </section>
      </div>
    );
  }

  if (finished) {
    const more = reviewQueue(paths, src).length > 0;
    return (
      <div className="max-w-3xl mx-auto w-full px-4 sm:px-6 py-8 sm:py-12">
        {header}
        <section aria-labelledby="review-done" className="mt-8 space-y-4 max-w-prose">
          <h2 id="review-done" ref={resultRef} tabIndex={-1} className="text-xl font-semibold focus:outline-none">
            Review complete!
          </h2>
          <p className="text-[15px]">
            Nice work practising. Questions you answered correctly return later, and the ones you missed come back sooner.
          </p>
          <p className="text-[15px]">{comeBackText(answered.map(a => a.history))}</p>
          <p className="text-[15px]">Keep learning at your own pace.</p>
          <div className="flex flex-wrap items-center gap-3">
            {back}
            {more && (
              <button type="button" onClick={again} className={secondaryLinkClass}>
                Review a few more
              </button>
            )}
          </div>
        </section>
      </div>
    );
  }

  return (
    <div className="max-w-3xl mx-auto w-full px-4 sm:px-6 py-8 sm:py-12">
      {header}
      <div className="mt-8 max-w-prose space-y-5">
        <p className="text-sm text-muted">
          <span aria-hidden="true">
            Question {index + 1} of {total} ·{' '}
          </span>
          From {item.path.title}, {item.quiz.title}
        </p>
        <QuestionBlock
          key={`${index}-${item.key}`}
          question={item.question}
          number={index + 1}
          total={total}
          selected={selected}
          checked={checked}
          onChoose={i => {
            if (checked) return;
            setNudge(false);
            setSelected(i);
          }}
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
            <Feedback ref={feedbackRef} question={item.question} selected={selected} />
            <button type="button" onClick={advance} className={primaryLinkClass}>
              {index < total - 1 ? 'Next question' : 'Finish'}
            </button>
          </div>
        )}
      </div>
    </div>
  );
};
