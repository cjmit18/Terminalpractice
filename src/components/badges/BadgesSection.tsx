import React from 'react';
import { BadgeCheck, Circle } from 'lucide-react';
import { Badge, BadgeFamily, FAMILY_LABEL } from '../../data/badges';
import { useGameLayer } from '../celebrate/GameLayer';
import { GameSettings } from '../settings/GameSettings';
import { BadgeName } from './BadgeName';

const FAMILIES: BadgeFamily[] = ['curiosity', 'resilience', 'milestone'];

const earnedDate = (t: number) => {
  try {
    return new Date(t).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
  } catch {
    return '';
  }
};

/**
 * "Your badges" on the Learn page: earned badges first with what they mean, then the ones still
 * to earn with how, in muted text. Hidden badges only appear once earned. No totals: badges are
 * feedback, not a checklist. The settings for the whole game layer sit at the end.
 */
export const BadgesSection: React.FC = () => {
  const { activity, badges, prefs } = useGameLayer();

  if (!prefs.showBadges) {
    return (
      <section aria-labelledby="badges-heading" className="mt-16 pt-6 border-t border-line max-w-prose space-y-4">
        <h2 id="badges-heading" className="text-base font-semibold text-text">
          Badges and celebrations
        </h2>
        <p className="text-sm text-muted">Badges are hidden. You can show them again here.</p>
        <GameSettings />
      </section>
    );
  }

  const earned = badges
    .filter(b => b.id in activity.badges)
    .sort((a, b) => activity.badges[a.id] - activity.badges[b.id]);
  const todo = badges.filter(b => !(b.id in activity.badges) && !b.hidden);

  return (
    <section aria-labelledby="badges-heading" className="mt-16 pt-6 border-t border-line max-w-prose space-y-6">
      <header className="space-y-2">
        <h2 id="badges-heading" className="text-base font-semibold text-text">
          Your badges
        </h2>
        <p className="text-sm text-muted">
          Badges mark something you can now do or something you tried. None of them are needed for anything, and they
          stay when you reset a lab or a path.
        </p>
      </header>

      {earned.length > 0 ? (
        <ul aria-label="Badges earned" className="space-y-3">
          {earned.map(b => (
            <EarnedBadge key={b.id} badge={b} at={activity.badges[b.id]} />
          ))}
        </ul>
      ) : (
        <p className="text-[15px]">No badges yet. Run a command in any lab or the Sandbox to earn your first one.</p>
      )}

      {todo.length > 0 && (
        <details className="group">
          <summary className="cursor-pointer min-h-10 inline-flex items-center text-sm font-medium text-accent rounded-sm">
            Badges you can still earn
          </summary>
          <div className="mt-3 space-y-5">
            {FAMILIES.map(family => {
              const list = todo.filter(b => b.family === family);
              if (list.length === 0) return null;
              return (
                <div key={family} className="space-y-2">
                  <h3 className="text-sm font-semibold text-text">{FAMILY_LABEL[family]}</h3>
                  <ul className="space-y-2">
                    {list.map(b => (
                      <li key={b.id} className="flex items-start gap-3">
                        <Circle className="size-4 mt-0.5 shrink-0 text-subtle" aria-hidden="true" />
                        <p className="min-w-0 text-sm">
                          <span className="sr-only">Not earned yet: </span>
                          <BadgeName badge={b} className="font-medium text-text" />
                          <span className="sr-only">. </span>
                          <span className="block text-muted">How to earn: {b.howTo}</span>
                        </p>
                      </li>
                    ))}
                  </ul>
                </div>
              );
            })}
          </div>
        </details>
      )}

      <GameSettings />
    </section>
  );
};

const EarnedBadge: React.FC<{ badge: Badge; at: number }> = ({ badge, at }) => (
  <li className="flex items-start gap-3" data-badge={badge.id}>
    <BadgeCheck className="size-5 mt-0.5 shrink-0 text-ok" aria-hidden="true" />
    <p className="min-w-0 text-[15px]">
      <span className="sr-only">Badge earned: </span>
      <BadgeName badge={badge} className="font-medium text-text" />
      <span className="sr-only">. </span>
      <span className="block text-sm text-muted">
        {badge.description}
        {earnedDate(at) && <span className="text-muted"> Earned {earnedDate(at)}.</span>}
      </span>
    </p>
  </li>
);
