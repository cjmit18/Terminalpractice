import React from 'react';
import { Check } from 'lucide-react';
import { CHALLENGES, Challenge, challengeFact, dailyOrder } from '../../data/challenges';
import { routeHref } from '../../lib/router';
import { ALL_MODULES } from '../../lib/modules';
import { SHELL_LABELS } from '../lab/PageHeader';
import { useGameLayer } from '../celebrate/GameLayer';
import { primaryLinkClass } from '../journey/shared';

const MODULE_TITLES = new Map(ALL_MODULES.map(m => [m.id, m.title]));

export const challengeHref = (id: string | null) => routeHref({ section: 'sandbox', challengeId: id });

/** "bash · the machine from Process text streams using filters" */
export const challengeMeta = (c: Challenge) => {
  const lab = MODULE_TITLES.get(c.machineFrom);
  return lab ? `${SHELL_LABELS[c.shell]} · the machine from ${lab}` : SHELL_LABELS[c.shell];
};

/** #/sandbox/challenge: every challenge in today's rotated order, with the first highlighted as today's pick. */
export const ChallengeList: React.FC = () => {
  const { activity } = useGameLayer();
  const solved = (id: string) => activity.facts.includes(challengeFact(id));
  // Today's order: the pick first, then every other challenge, reshuffled as the days go by
  const order = dailyOrder();
  const pick = order[0];
  const count = CHALLENGES.filter(c => solved(c.id)).length;

  return (
    <div className="max-w-3xl mx-auto w-full px-4 sm:px-6 py-8 sm:py-12">
      <header className="space-y-3">
        <h1 className="text-2xl font-semibold text-text">Challenges</h1>
        <p className="text-[15px] text-muted max-w-prose">
          Short puzzles you answer with a command or two, on the machines from the labs. Take them in any order and
          come back to them whenever you like; they all stay here.
        </p>
        {count > 0 && (
          <p className="text-sm text-muted">
            {count} of {CHALLENGES.length} solved
          </p>
        )}
      </header>

      <section aria-labelledby="pick-heading" className="mt-8 rounded-md border border-line bg-surface px-4 py-4 space-y-2">
        <h2 id="pick-heading" className="text-sm text-muted font-medium">
          Today&rsquo;s pick
        </h2>
        <p className="text-base font-semibold text-text">{pick.title}</p>
        <p className="text-[15px] max-w-prose">{pick.prompt}</p>
        <p className="text-sm text-muted">{challengeMeta(pick)}</p>
        <p className="pt-1">
          <a href={challengeHref(pick.id)} className={primaryLinkClass}>
            {solved(pick.id) ? 'Try it again' : 'Start this challenge'}
          </a>
        </p>
      </section>

      <section aria-labelledby="all-heading" className="mt-10">
        <h2 id="all-heading" className="text-base font-semibold">
          All challenges
        </h2>
        <ul className="mt-3 border-t border-line">
          {order.map(c => (
            <li key={c.id} className="border-b border-line">
              <a
                href={challengeHref(c.id)}
                className="flex items-start justify-between gap-4 py-3 px-1 -mx-1 rounded-sm hover:bg-surface-2"
              >
                <span className="min-w-0">
                  <span className="block text-[15px] font-medium text-text">{c.title}</span>
                  <span className="block text-sm text-muted">{challengeMeta(c)}</span>
                </span>
                {solved(c.id) && (
                  <span className="shrink-0 inline-flex items-center gap-1 text-sm text-ok">
                    <Check className="size-4" aria-hidden="true" />
                    Solved
                  </span>
                )}
              </a>
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
};
