import React from 'react';
import { Check } from 'lucide-react';
import { LearningPath } from '../../types/paths';
import { CompletionSource } from '../../lib/journey';
import { ExamObjective, ExamSkillRow, ObjectiveState, SkillOptions, pathSkillReport } from '../../data/examObjectives';
import { textLinkClass } from './shared';

interface SkillMapProps {
  path: LearningPath;
  src: CompletionSource;
  /** Pass per-question answer history here once it exists; see SkillOptions.questionHistory */
  options?: SkillOptions;
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

const label = (o: ExamObjective) => `${o.number} ${o.title}`;

const STATE_TEXT: Record<Exclude<ObjectiveState, 'not-covered'>, string> = {
  'not-started': 'Not started',
  practised: 'Practised',
  confident: 'Confident',
};

/**
 * "Exam objectives" on a path overview: each objective of the path's exam(s) with how far the learner
 * has got, an honest summary line, and links to the official objectives. Derived only: no new state.
 */
export const SkillMap: React.FC<SkillMapProps> = ({ path, src, options }) => {
  const report = pathSkillReport(path, src, options);
  if (!report) return null;

  const links = [...new Map(report.exams.map(e => [e.exam.url, e.exam])).values()];
  const multi = report.exams.length > 1;

  return (
    <section aria-labelledby="skill-map-heading" className="mt-12 space-y-4" data-testid="skill-map">
      <h2 id="skill-map-heading" className="text-base font-semibold text-text">
        Exam objectives
      </h2>
      <div className="space-y-2 text-sm text-muted max-w-prose">
        <p data-testid="readiness" className="text-[15px] text-text">
          You have practised {report.practised} of {report.covered} objectives this path covers.{' '}
          {report.checkpointAverage === null
            ? 'No checkpoints taken yet.'
            : `Checkpoint average ${report.checkpointAverage}%.`}
        </p>
        {report.notCovered.length > 0 && (
          <p>Not covered here: {report.notCovered.map(label).join('; ')}.</p>
        )}
        <p>
          This app covers only part of {multi ? 'these exams' : 'the exam'}, and practising an objective here does not
          mean you know all of it. Check the official list before you book:{' '}
          {links.map((exam, i) => (
            <React.Fragment key={exam.url}>
              {i > 0 && (i === links.length - 1 ? ' and ' : ', ')}
              <a href={exam.url} target="_blank" rel="noopener noreferrer" className={textLinkClass}>
                {exam.urlLabel}
              </a>
            </React.Fragment>
          ))}
          .
        </p>
      </div>

      {report.exams.map(({ exam, rows }) => (
        <div key={exam.id} className="space-y-1">
          <h3 className="text-sm font-medium text-text pt-2">
            {exam.name}
            {exam.level === 'domain' && <span className="font-normal text-muted"> · by domain</span>}
          </h3>
          <ul aria-label={`${exam.name} objectives`} className="divide-y divide-line border-y border-line">
            {rows.map(row => (
              <SkillRow key={row.objective.id} row={row} />
            ))}
          </ul>
        </div>
      ))}
    </section>
  );
};

const SkillRow: React.FC<{ row: ExamSkillRow }> = ({ row }) => {
  const { objective, state } = row;
  const covered = state !== 'not-covered';
  const parts = [
    row.lessons > 0 && plural(row.lessons, 'lesson', 'lessons'),
    row.labs > 0 && plural(row.labs, 'lab', 'labs'),
    row.questions > 0 && plural(row.questions, 'question', 'questions'),
  ].filter(Boolean);

  return (
    <li className="grid grid-cols-[1fr_auto] gap-x-4 py-2.5 px-1" data-objective={objective.id} data-state={state}>
      <span className="min-w-0">
        <span className={`block text-[15px] ${covered ? 'text-text' : 'text-muted'}`}>
          <span className="tabular-nums">{objective.number}</span> {objective.title}
        </span>
        <span className="block text-sm text-muted">
          {covered ? parts.join(', ') : 'Not covered here: study elsewhere'}
        </span>
      </span>
      {covered && (
        <span className="text-sm whitespace-nowrap self-start pt-0.5">
          {state === 'confident' ? (
            <span className="inline-flex items-center gap-1 font-medium text-ok">
              <Check className="w-4 h-4" aria-hidden="true" />
              {STATE_TEXT.confident}
            </span>
          ) : (
            <span className={state === 'practised' ? 'text-text' : 'text-muted'}>{STATE_TEXT[state]}</span>
          )}
        </span>
      )}
    </li>
  );
};
