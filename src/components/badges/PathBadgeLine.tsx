import React from 'react';
import { BadgeCheck } from 'lucide-react';
import { pathBadgeId } from '../../data/badges';
import { useGameLayer } from '../celebrate/GameLayer';
import { BadgeName } from './BadgeName';

/** A finished path's badge, worded as the ability it stands for. Nothing when not earned or badges are hidden. */
export const PathBadgeLine: React.FC<{ pathId: string }> = ({ pathId }) => {
  const { badges, activity, prefs } = useGameLayer();
  const badge = badges.find(b => b.id === pathBadgeId(pathId));
  if (!badge || !prefs.showBadges || !(badge.id in activity.badges)) return null;
  return (
    <p className="flex items-start gap-2 text-[15px] max-w-prose">
      <BadgeCheck className="size-5 mt-0.5 shrink-0 text-ok" aria-hidden="true" />
      <span>
        <span className="sr-only">Badge earned: </span>
        <BadgeName badge={badge} className="font-medium" />
        <span className="block text-sm text-muted">{badge.description}</span>
      </span>
    </p>
  );
};
