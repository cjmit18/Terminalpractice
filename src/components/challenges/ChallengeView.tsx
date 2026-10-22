import React, { useCallback, useRef, useState } from 'react';
import { ArrowRight, Check } from 'lucide-react';
import { Challenge, challengeFact, nextChallenge } from '../../data/challenges';
import { ExamModule } from '../../types/modules';
import { TerminalView } from '../TerminalView';
import { createSession, ShellSession, useShellSession } from '../lab/useShellSession';
import { HintText } from '../lab/LabManual';
import { PageHeader, ResetButton } from '../lab/PageHeader';
import { useGameLayer } from '../celebrate/GameLayer';
import { textLinkClass } from '../journey/shared';
import { challengeHref, challengeMeta } from './ChallengeList';

interface ChallengeViewProps {
  challenge: Challenge;
  /** The lab whose machine the challenge runs on */
  machine: ExamModule;
}

const freshSession = (m: ExamModule) =>
  createSession(m.initialFs, m.initialState, m.track === 'lpi' ? '/home/student' : 'C:\\Users\\Student');

/** #/sandbox/challenge/<id>: the question, a hint, and a terminal on the lab's machine. */
export const ChallengeView: React.FC<ChallengeViewProps> = ({ challenge, machine }) => {
  const { activity, record, announce } = useGameLayer();
  const solvedBefore = activity.facts.includes(challengeFact(challenge.id));
  // The command line that solved it in this visit
  const [solvedBy, setSolvedBy] = useState<string | null>(null);
  const [showHint, setShowHint] = useState(false);
  const [resetCount, setResetCount] = useState(0);

  const solvedRef = useRef(false);
  const lastOutcomeRef = useRef<ShellSession['lastOutcome']>(undefined);
  const challengeRef = useRef(challenge);
  challengeRef.current = challenge;
  const recordRef = useRef(record);
  recordRef.current = record;
  const announceRef = useRef(announce);
  announceRef.current = announce;

  const verify = useCallback((s: ShellSession) => {
    // Only a new command can solve it
    if (!s.lastOutcome || s.lastOutcome === lastOutcomeRef.current) return;
    lastOutcomeRef.current = s.lastOutcome;
    if (solvedRef.current) return;
    const c = challengeRef.current;
    let ok = false;
    try {
      ok = c.verifier(s.fs, s.state, s.lastResult);
    } catch (err) {
      if (import.meta.env.DEV) console.error(`Verifier for challenge "${c.id}" threw`, err);
    }
    if (!ok) return;
    solvedRef.current = true;
    setSolvedBy(s.lastOutcome.line);
    recordRef.current([challengeFact(c.id)]);
    announceRef.current({ kind: 'milestone', text: `Challenge solved: ${c.title}` });
  }, []);

  const { session, run, clearHistory, reset } = useShellSession(() => freshSession(machine), verify, record);

  const handleReset = () => {
    // A fresh machine is a fresh attempt; the saved "solved before" fact stays
    lastOutcomeRef.current = undefined;
    solvedRef.current = false;
    setSolvedBy(null);
    reset(freshSession(machine));
    setResetCount(n => n + 1);
  };

  const next = nextChallenge(challenge.id);
  const solved = solvedBy !== null;

  return (
    <div className="flex flex-col lg:h-full lg:min-h-0 lg:overflow-hidden bg-bg text-text">
      <PageHeader
        title={challenge.title}
        badge={solved || solvedBefore ? 'Solved' : undefined}
        meta={challengeMeta(challenge)}
        actions={<ResetButton label="Reset machine" onClick={handleReset} />}
      />

      <div className="flex-1 lg:min-h-0 grid grid-cols-1 lg:grid-cols-[minmax(0,5fr)_minmax(0,7fr)] lg:overflow-hidden">
        <section aria-label="Challenge" className="lg:min-h-0 lg:overflow-y-auto px-4 sm:px-6 py-6 lg:border-r border-line">
          <div className="space-y-6 max-w-prose">
            <p className="text-sm">
              <a href={challengeHref(null)} className={textLinkClass}>
                All challenges
              </a>
            </p>

            <section aria-labelledby="challenge-question" className="space-y-2">
              <h2 id="challenge-question" className="text-base font-semibold">
                The question
              </h2>
              <p className="text-[15px] leading-relaxed">{challenge.prompt}</p>
              {!solved && (
                <p className="text-sm text-muted">It is checked each time you run a command. Wrong tries cost nothing.</p>
              )}
            </section>

            <div className="space-y-2">
              <button
                type="button"
                aria-expanded={showHint}
                aria-controls="challenge-hint"
                onClick={() => setShowHint(v => !v)}
                className="text-sm font-medium text-accent underline-offset-2 hover:underline rounded-sm min-h-10 sm:min-h-0"
              >
                {showHint ? 'Hide hint' : 'Show hint'}
              </button>
              {showHint && (
                <p id="challenge-hint" className="text-sm text-muted">
                  <HintText text={challenge.hint} />
                </p>
              )}
            </div>

            <div aria-live="polite">
              {solved && (
                <section aria-labelledby="challenge-solved" className="rounded-md border border-line bg-surface px-4 py-4 space-y-3">
                  <h2 id="challenge-solved" className="inline-flex items-center gap-2 text-base font-semibold">
                    <Check className="size-4 text-ok" aria-hidden="true" />
                    Solved
                  </h2>
                  <p className="text-sm text-muted break-words">
                    Your command:{' '}
                    <code className="font-mono text-[13px] text-text bg-surface-2 rounded-sm px-1 py-0.5">{solvedBy}</code>
                  </p>
                  <p className="text-[15px] leading-relaxed">{challenge.explanation}</p>
                  {next.id !== challenge.id && (
                    <p className="text-sm">
                      <span className="text-muted">Next: </span>
                      <a href={challengeHref(next.id)} className={`inline-flex items-center gap-1 font-medium ${textLinkClass}`}>
                        {next.title}
                        <ArrowRight className="size-4" aria-hidden="true" />
                      </a>
                    </p>
                  )}
                </section>
              )}
            </div>
          </div>
        </section>

        <section aria-label="Terminal" className="flex flex-col h-[70dvh] lg:h-auto lg:min-h-0 overflow-hidden p-3 sm:p-4">
          <TerminalView
            shell={challenge.shell}
            cwd={session.cwd}
            history={session.history}
            onExecuteCommand={line => run(line, challenge.shell)}
            onClearHistory={clearHistory}
            onActivity={record}
            resetKey={resetCount}
            isDiskpartActive={session.diskpartActive}
            currentUser={session.state.currentUser}
            hostname={session.state.hostname}
          />
        </section>
      </div>
    </div>
  );
};
