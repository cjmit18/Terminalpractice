import React from 'react';
import { routeHref } from '../../lib/router';
import { cx } from '../sims/ui';

const TABS = [
  { id: 'challenges', label: 'Challenges', href: routeHref({ section: 'sandbox', challengeId: null }) },
  { id: 'drills', label: 'Drills', href: routeHref({ section: 'sandbox', challengeId: null, tab: 'drills' }) },
] as const;

export type ChallengeTab = (typeof TABS)[number]['id'];

/**
 * The two kinds of quick practice, as tabs. Each tab is its own address (#/sandbox/challenge and
 * #/sandbox/drills), so these are links: Back works and a tab can be bookmarked.
 */
export const ChallengeTabs: React.FC<{ current: ChallengeTab }> = ({ current }) => (
  <nav aria-label="Quick practice" className="mt-5 flex gap-1 border-b border-line">
    {TABS.map(t => (
      <a
        key={t.id}
        href={t.href}
        aria-current={t.id === current ? 'page' : undefined}
        className={cx(
          '-mb-px inline-flex min-h-11 sm:min-h-10 items-center border-b-2 px-3 text-sm font-medium transition-colors rounded-t-sm',
          t.id === current ? 'border-accent text-text' : 'border-transparent text-muted hover:text-text',
        )}
      >
        {t.label}
      </a>
    ))}
  </nav>
);
