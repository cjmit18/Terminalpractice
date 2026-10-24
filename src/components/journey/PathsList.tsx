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
import { learnHref, reviewHref, routeHref } from '../../lib/router';
import { todaysPick } from '../../data/challenges';
import { ProgressBar, primaryLinkClass, secondaryLinkClass, textLinkClass } from './shared';
import { pathProgressText, stagesText } from './progressText';
import { FirstStepsBanner } from './FirstStepsBanner';
import { BadgesSection } from '../badges/BadgesSection';
import { TodayAndWeek } from '../celebrate/TodayAndWeek';

interface PathsListProps {
  paths: LearningPath[];
  src: CompletionSource;
  modulesById: Map<string, ExamModule>;
  /** moduleId -> completed objective ids */
  progress: Record<string, string[]>;
}

/** #/learn: every path, with where you are in each. */
export const PathsList: React.FC<PathsListProps> = ({ paths, src, modulesById, progress }) => {
  const resume = resumeTarget(paths, src);

  return (
    // Phone: one column, in the order intro, review and today, paths, today's challenge.
    // Wide screens: the paths take the main column, two cards a row, and the sidebar beside them holds
    // review, today, today's challenge and the tools, from the top. The sidebar's two parts are
    // `contents` on a phone so the order classes can put the paths between them.
    <div className="max-w-3xl lg:max-w-6xl mx-auto w-full px-4 sm:px-6 py-8 sm:py-12">
      <div className="flex flex-col lg:grid lg:grid-cols-[minmax(0,1fr)_19rem] lg:grid-rows-[auto_1fr] lg:gap-x-10">
        <div className="order-1 lg:col-start-1 lg:row-start-1">
          <header className="space-y-3">
            <h1 id="learn-heading" tabIndex={-1} className="text-2xl font-semibold text-text focus:outline-none">
              Learning paths
            </h1>
            <p className="text-[15px] text-muted max-w-prose">
              Each path takes you through one exam in order: a short lesson, a lab to try it on a working system, then a
              few questions to check it stuck.
            </p>
          </header>

          <FirstStepsBanner paths={paths} src={src} progress={progress} focusAfterDismissId="learn-heading" />

          {resume && (
            <p className="mt-6 text-[15px]">
              <span className="text-muted">Continue where you left off: </span>
              <a href={learnHref(resume.path.id, resume.loc.step.id)} className={`${textLinkClass} font-medium`}>
                {stepTitle(resume.loc.step, modulesById)}
              </a>
              <span className="text-muted"> in {resume.path.title}</span>
            </p>
          )}
        </div>

        {/* A plain div, not an aside: `display: contents` can hide a landmark from screen readers.
            On a wide screen the first part that shows anything starts flush with the heading. */}
        <div className="contents lg:block lg:col-start-2 lg:row-start-1 lg:row-span-2 lg:[&>div:empty]:hidden lg:[&>div:not(:empty)>:first-child]:mt-0 lg:[&>div:not(:empty)~div>:first-child]:mt-8">
          <div className="order-2">
            <ReviewEntry paths={paths} src={src} />
            <TodayAndWeek />
          </div>
          <div className="order-4">
            <TodaysChallenge />
            <PracticeLinks />
          </div>
        </div>

      <ul className="order-3 mt-8 border-t border-line lg:col-start-1 lg:row-start-2 lg:border-t-0 lg:grid lg:grid-cols-2 lg:gap-4">
        {paths.map(path => {
          const started = pathStarted(path, src);
          const next = nextStep(path, src);
          const percent = pathPercent(path, src);
          const headingId = `path-${path.id}`;
          return (
            <li key={path.id} className="border-b border-line py-6 sm:py-8 lg:border lg:rounded-md lg:bg-surface lg:p-5 lg:flex">
              <article aria-labelledby={headingId} className="space-y-3 lg:flex lg:flex-col lg:w-full">
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

                <div className="flex flex-col sm:flex-row sm:items-center gap-3 sm:gap-6 pt-2 lg:mt-auto lg:gap-4">
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
      </div>

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

/** Today's challenge in a small card: every day another one from the rotation */
const TodaysChallenge: React.FC = () => {
  const pick = todaysPick();
  return (
    <section aria-labelledby="todays-challenge-heading" className="mt-8 rounded-md border border-line bg-surface px-4 py-4 space-y-2">
      <h2 id="todays-challenge-heading" className="text-sm text-muted font-medium">
        Today&rsquo;s challenge
      </h2>
      <p className="text-[15px] font-semibold text-text">{pick.title}</p>
      <p className="text-sm">{pick.prompt}</p>
      <p className="pt-1 flex flex-wrap items-center gap-x-4 gap-y-2">
        <a href={routeHref({ section: 'sandbox', challengeId: pick.id })} className={primaryLinkClass}>
          Try it
          <ArrowRight className="w-4 h-4" aria-hidden="true" />
        </a>
        <a href={routeHref({ section: 'sandbox', challengeId: null })} className={`${textLinkClass} text-sm`}>
          All challenges
        </a>
      </p>
    </section>
  );
};

/** The free-practice tools, one click from the start page (wide screens; phones have them in the bottom bar) */
const PracticeLinks: React.FC = () => (
  <section aria-labelledby="practice-heading" className="hidden lg:block mt-8 space-y-3">
    <h2 id="practice-heading" className="text-base font-semibold text-text">Practise freely</h2>
    <ul className="space-y-2 text-[15px]">
      {[
        { label: 'Sandbox', note: 'bash, Command Prompt and PowerShell to try anything', href: routeHref({ section: 'sandbox' }) },
        { label: 'Simulators', note: 'Active Directory, Group Policy, disks, networks, permissions', href: routeHref({ section: 'simulators' }) },
        { label: 'Command reference', note: 'syntax, options and exam notes', href: routeHref({ section: 'reference' }) },
      ].map(l => (
        <li key={l.label}>
          <a href={l.href} className={`${textLinkClass} font-medium`}>{l.label}</a>
          <span className="block text-sm text-muted">{l.note}</span>
        </li>
      ))}
    </ul>
  </section>
);

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
