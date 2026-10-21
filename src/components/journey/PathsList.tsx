import React from 'react';
import { ArrowRight } from 'lucide-react';
import { ExamModule } from '../../types/modules';
import { LearningPath } from '../../types/paths';
import {
  CompletionSource,
  formatMinutes,
  nextStep,
  pathMinutes,
  pathPercent,
  pathStarted,
  resumeTarget,
  reviewStatus,
  stepTitle,
  whenText,
} from '../../lib/journey';
import { learnHref, reviewHref } from '../../lib/router';
import { ProgressBar, primaryLinkClass, secondaryLinkClass, textLinkClass } from './shared';
import { pathProgressText, stagesText } from './progressText';
import { FirstStepsBanner } from './FirstStepsBanner';
import { BadgesSection } from '../badges/BadgesSection';
import { TodayAndWeek } from '../celebrate/TodayAndWeek';

interface PathsListProps {
  paths: LearningPath[];
  src: CompletionSource;
  modulesById: Map<string, ExamModule>;
}

/** #/learn: every path, with where you are in each. */
export const PathsList: React.FC<PathsListProps> = ({ paths, src, modulesById }) => {
  const resume = resumeTarget(paths, src);

  return (
    <div className="max-w-3xl mx-auto w-full px-4 sm:px-6 py-8 sm:py-12">
      <header className="space-y-3">
        <h1 className="text-2xl font-semibold text-text">Learning paths</h1>
        <p className="text-[15px] text-muted max-w-prose">
          Each path takes you through one exam in order: a short lesson, a lab to try it on a working system, then a
          few questions to check it stuck.
        </p>
      </header>

      <FirstStepsBanner paths={paths} src={src} />

      {resume && (
        <p className="mt-6 text-[15px]">
          <span className="text-muted">Continue where you left off: </span>
          <a href={learnHref(resume.path.id, resume.loc.step.id)} className={`${textLinkClass} font-medium`}>
            {stepTitle(resume.loc.step, modulesById)}
          </a>
          <span className="text-muted"> in {resume.path.title}</span>
        </p>
      )}

      <ReviewEntry paths={paths} src={src} />
      <TodayAndWeek />

      <ul className="mt-8 border-t border-line">
        {paths.map(path => {
          const started = pathStarted(path, src);
          const next = nextStep(path, src);
          const percent = pathPercent(path, src);
          const headingId = `path-${path.id}`;
          return (
            <li key={path.id} className="border-b border-line py-6 sm:py-8">
              <article aria-labelledby={headingId} className="space-y-3">
                <div className="space-y-1">
                  <p className="text-sm text-muted">{path.exam}</p>
                  <h2 id={headingId} className="text-lg font-semibold leading-snug">
                    <a href={learnHref(path.id)} className="text-text hover:text-accent rounded-sm">
                      {path.title}
                    </a>
                  </h2>
                </div>
                <p className="text-[15px] max-w-prose">{path.summary}</p>
                <p className="text-sm text-muted max-w-prose">{path.audience}</p>
                <p className="text-sm text-muted">
                  {stagesText(path.stages.length)} · {formatMinutes(pathMinutes(path, modulesById))}
                </p>

                <div className="flex flex-col sm:flex-row sm:items-center gap-3 sm:gap-6 pt-2">
                  <div className="flex-1 min-w-0 max-w-sm space-y-1.5">
                    <p className="text-sm text-text tabular-nums">{pathProgressText(path, src)}</p>
                    <ProgressBar percent={percent} />
                  </div>
                  {next ? (
                    <a
                      href={learnHref(path.id, next.step.id)}
                      aria-label={`${started ? 'Continue' : 'Start'} ${path.title}`}
                      className={`${primaryLinkClass} self-start sm:self-auto`}
                    >
                      {started ? 'Continue' : 'Start'}
                      <ArrowRight className="w-4 h-4" aria-hidden="true" />
                    </a>
                  ) : (
                    <a
                      href={learnHref(path.id)}
                      aria-label={`Review ${path.title}`}
                      className={`${secondaryLinkClass} self-start sm:self-auto`}
                    >
                      Review
                    </a>
                  )}
                </div>
              </article>
            </li>
          );
        })}
      </ul>

      <BadgesSection />

      <section aria-labelledby="about-heading" className="mt-16 pt-6 border-t border-line text-sm text-muted space-y-2 max-w-prose">
        <h2 id="about-heading" className="text-base font-semibold text-text">About this project</h2>
        <p>
          Terminus CertSim was built with AI assistance: much of its code and lesson content was generated with AI tools
          working from my direction and review. I maintain and develop it myself as a personal project for my own learning
          and practice for the LPIC-1 and CompTIA exams.
        </p>
        <p>
          It is a study aid, not official exam material, so check anything important against the official exam
          objectives. Source code:{' '}
          <a href="https://github.com/cjmit18/Terminalpractice" className="text-accent underline underline-offset-2">
            github.com/cjmit18/Terminalpractice
          </a>
          .
        </p>
        <p>
          Not affiliated with or endorsed by the Linux Professional Institute (LPI) or CompTIA. LPIC-1, CompTIA, A+,
          Network+ and Security+ are trademarks of their respective owners.
        </p>
      </section>
    </div>
  );
};

/**
 * The way into the review queue, once the learner has answered checkpoint questions. Says whether
 * anything is ready without nagging: no count of overdue questions.
 */
const ReviewEntry: React.FC<{ paths: LearningPath[]; src: CompletionSource }> = ({ paths, src }) => {
  const { due, nextAt } = reviewStatus(paths, src);
  if (due === 0 && nextAt === null) return null;
  return (
    <p className="mt-4 text-[15px]">
      {due > 0 ? (
        <>
          <a href={reviewHref()} className={`${textLinkClass} font-medium`}>
            Review a few questions
          </a>
          <span className="text-muted"> from the checkpoints you have taken, spaced out so they stick.</span>
        </>
      ) : (
        <span className="text-muted">
          Nothing to review right now. The next checkpoint question comes back {whenText(nextAt!)}.
        </span>
      )}
    </p>
  );
};
