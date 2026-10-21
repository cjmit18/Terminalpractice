import React from 'react';
import { ArrowRight, Check } from 'lucide-react';
import type { ExamModule } from '../../types/modules';
import { firstCommandName } from '../../lib/activity';

interface LabRecapProps {
  module: ExamModule;
  /** objectiveId -> the command line that passed it in this visit (null: a simulator panel did) */
  passedBy: Record<string, string | null>;
  next: { href: string; title: string } | null;
}

/**
 * Shown once the last task of a lab passes: the command that passed each task, as a short review of the commands
 * you just used, and where to go next when the lab is part of a path.
 */
export const LabRecap: React.FC<LabRecapProps> = ({ module, passedBy, next }) => {
  const used: string[] = [];
  for (const line of Object.values(passedBy)) {
    if (!line) continue;
    const words = line.trim().split(/\s+/);
    // Keep how the learner wrote it (Get-Service, not get-service); sudo is not the point
    const name = words[0] === 'sudo' && words.length > 1 ? words[1] : words[0];
    if (name && firstCommandName(line, module.defaultShell) && !used.some(u => u.toLowerCase() === name.toLowerCase())) used.push(name);
  }
  return (
  <section aria-labelledby="lab-recap-heading" className="mb-8 rounded-md border border-line bg-surface px-4 py-4 space-y-3">
    <h2 id="lab-recap-heading" className="inline-flex items-center gap-2 text-base font-semibold text-text">
      <Check className="size-4 text-ok" aria-hidden="true" />
      Lab done
    </h2>
    {used.length > 0 && (
      <p className="text-[15px]">
        You just used{' '}
        {used.map((name, i) => (
          <React.Fragment key={name}>
            {i > 0 && (i === used.length - 1 ? ' and ' : ', ')}
            <code className="font-mono text-[0.95em]">{name}</code>
          </React.Fragment>
        ))}
        .
      </p>
    )}
    <p className="text-sm text-muted">The command that passed each task:</p>
    <ol className="space-y-2">
      {module.objectives.map((o, i) => {
        const by = passedBy[o.id];
        return (
          <li key={o.id} className="text-sm">
            <span className="text-text">
              {i + 1}. {o.title}
            </span>
            <span className="block text-muted break-words">
              {by ? (
                <code className="font-mono text-[13px] text-text bg-surface-2 rounded-sm px-1 py-0.5">{by}</code>
              ) : by === null ? (
                'Done with the simulator panel.'
              ) : (
                'Done on an earlier visit.'
              )}
            </span>
          </li>
        );
      })}
    </ol>
    {next && (
      <p className="text-sm">
        <span className="text-muted">Next: </span>
        <a href={next.href} className="inline-flex items-center gap-1 font-medium text-accent underline-offset-2 hover:underline rounded-sm">
          {next.title}
          <ArrowRight className="size-4" aria-hidden="true" />
        </a>
      </p>
    )}
  </section>
  );
};
