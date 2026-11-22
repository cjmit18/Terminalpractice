import React, { useEffect } from 'react';
import { CHALLENGES_BY_ID } from '../../data/challenges';
import { ALL_MODULES } from '../../lib/modules';
import { replaceRoute } from '../../lib/router';
import { ChallengeList } from './ChallengeList';
import { ChallengeView } from './ChallengeView';
import { DrillsPage } from './DrillsPage';
import { ChallengeTabs } from './ChallengeTabs';

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
  // One page for both tabs, so the heading and the tab links stay put when switching: keyboard focus stays on
  // the tab just chosen instead of falling back to the top of the page (#84 review)
  const current = tab === 'drills' ? 'drills' : 'challenges';
  return (
    <div className="max-w-3xl mx-auto w-full px-4 sm:px-6 py-8 sm:py-12">
      <header className="space-y-3">
        <h1 className="text-2xl font-semibold text-text">Challenges</h1>
        <p className="text-[15px] text-muted max-w-prose">{INTRO[current]}</p>
      </header>
      <ChallengeTabs current={current} />
      {current === 'drills' ? <DrillsPage /> : <ChallengeList />}
    </div>
  );
};

const INTRO = {
  challenges:
    'Short puzzles you answer with a command or two, on the machines from the labs. Take them in any order and come back to them whenever you like; they all stay here.',
  drills: 'Drills make a new question every time, so there is no answer to memorise, only the method.',
};
