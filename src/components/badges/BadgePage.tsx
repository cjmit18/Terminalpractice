import React from 'react';
import { ArrowLeft, BadgeCheck } from 'lucide-react';
import { FAMILY_LABEL } from '../../data/badges';
import { learnHref } from '../../lib/router';
import { useGameLayer } from '../celebrate/GameLayer';
import { BadgeName } from './BadgeName';
import { CopyLinkButton } from './CopyLinkButton';

/**
 * #/badge/<id>: what one badge means and how it is earned. The link names the badge only, never
 * who earned it or when, so it can be shared without an account. "You have this badge" comes from
 * the viewer's own browser.
 */
export const BadgePage: React.FC<{ badgeId: string }> = ({ badgeId }) => {
  const { badges, activity } = useGameLayer();
  const badge = badges.find(b => b.id === badgeId);
  const back = (
    <a
      href={learnHref()}
      className="-ml-2 mb-4 inline-flex min-h-10 items-center gap-1.5 rounded-md px-2 text-sm font-medium text-accent hover:bg-surface-2"
    >
      <ArrowLeft className="size-4" aria-hidden="true" />
      Learning paths
    </a>
  );

  if (!badge) {
    return (
      <div className="max-w-3xl mx-auto w-full px-4 sm:px-6 py-8 sm:py-12">
        {back}
        <h1 className="text-2xl font-semibold text-text">No badge with that name</h1>
        <p className="mt-3 text-[15px] text-muted max-w-prose">
          The link may be from an older version. Your badges are listed on the Learn page.
        </p>
      </div>
    );
  }

  const mine = badge.id in activity.badges;
  // A hidden badge stays a surprise unless you have found it yourself
  const secret = badge.hidden && !mine;

  return (
    <div className="max-w-3xl mx-auto w-full px-4 sm:px-6 py-8 sm:py-12">
      {back}
      <article aria-labelledby="badge-heading" className="space-y-4 max-w-prose">
        <p className="text-sm text-muted">Terminus CertSim badge · {FAMILY_LABEL[badge.family]}</p>
        <h1 id="badge-heading" className="text-2xl font-semibold text-text">
          <BadgeName badge={badge} />
        </h1>
        {secret ? (
          <p className="text-[15px]">This badge is a surprise. It appears once you find it.</p>
        ) : (
          <>
            <p className="text-[15px]">{badge.description}</p>
            <section aria-labelledby="badge-how" className="space-y-1">
              <h2 id="badge-how" className="text-base font-semibold text-text">
                How it is earned
              </h2>
              <p className="text-[15px] text-muted">{badge.howTo}</p>
            </section>
          </>
        )}
        {mine && (
          <p className="flex items-center gap-2 text-sm text-text">
            <BadgeCheck className="size-4 text-ok" aria-hidden="true" />
            You have this badge in this browser.
          </p>
        )}
        <p className="text-sm text-muted">
          Badges mark something a learner can now do or something they tried. None are needed for anything, and this
          page says nothing about who earned it.
        </p>
        <CopyLinkButton badgeId={badge.id} />
      </article>
    </div>
  );
};
