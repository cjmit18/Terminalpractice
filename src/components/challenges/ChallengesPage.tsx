import React, { useEffect } from 'react';
import { CHALLENGES_BY_ID } from '../../data/challenges';
import { ALL_MODULES } from '../../lib/modules';
import { replaceRoute } from '../../lib/router';
import { ChallengeList } from './ChallengeList';
import { ChallengeView } from './ChallengeView';
import { DrillsPage } from './DrillsPage';

const MODULES_BY_ID = new Map(ALL_MODULES.map(m => [m.id, m]));

/** #/sandbox/challenge, #/sandbox/challenge/<id> and #/sandbox/drills. An unknown id (old link, typo) goes to the list. */
export const ChallengesPage: React.FC<{ challengeId: string | null; tab?: 'drills' }> = ({ challengeId, tab }) => {
  const challenge = challengeId ? CHALLENGES_BY_ID.get(challengeId) : undefined;
  const machine = challenge ? MODULES_BY_ID.get(challenge.machineFrom) : undefined;
  const unknown = challengeId !== null && !(challenge && machine);

  useEffect(() => {
    if (unknown) replaceRoute({ section: 'sandbox', challengeId: null });
  }, [unknown]);

  if (challenge && machine) return <ChallengeView key={challenge.id} challenge={challenge} machine={machine} />;
  if (unknown) return null;
  if (tab === 'drills') return <DrillsPage />;
  return <ChallengeList />;
};
