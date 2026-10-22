import React, { useMemo, useState } from 'react';
import { BadgeCheck } from 'lucide-react';
import { resendVerification, type AccountUser } from '../../lib/account';
import { labCheck, pathPercent } from '../../lib/journey';
import { accountHref, badgeHref, learnHref, reviewHref, routeHref } from '../../lib/router';
import { useGameLayer } from '../celebrate/GameLayer';
import { TodayAndWeek } from '../celebrate/TodayAndWeek';
import { BadgeName } from '../badges/BadgeName';
import { ProgressBar } from '../journey/shared';
import { pathProgressText } from '../journey/progressText';
import { secondaryButton, textLink } from './forms';
import { ImportPrompt, syncStatusText, useSyncState } from './syncAdapter';

const RECENT_BADGES = 6;

/** #/account when signed in: a calm overview, nothing to act on unless you want to. */
export const Dashboard: React.FC<{ user: AccountUser; emailSending: boolean }> = ({ user, emailSending }) => (
  <div className="space-y-10">
    <EmailStatus user={user} emailSending={emailSending} />
    <SyncStatus />
    <PathProgress />
    <RecentBadges />
    <TodayAndWeek />
    <QuickLinks />
  </div>
);

const EmailStatus: React.FC<{ user: AccountUser; emailSending: boolean }> = ({ user, emailSending }) => {
  const [state, setState] = useState<'idle' | 'busy' | 'sent' | { error: string }>('idle');
  if (!user.email) {
    return (
      <p className="text-[15px] text-muted max-w-prose">
        You sign in with {user.login ? `GitHub as ${user.login}` : 'a linked account'}. You can{' '}
        <a href={accountHref('security')} className={textLink}>
          add an email and password
        </a>{' '}
        as a second way in.
      </p>
    );
  }
  if (user.emailVerified) {
    return (
      <p className="flex items-start gap-2 text-[15px]">
        <BadgeCheck className="size-5 mt-0.5 shrink-0 text-ok" aria-hidden="true" />
        <span>
          Your email <span className="font-medium">{user.email}</span> is confirmed.
        </span>
      </p>
    );
  }
  const resend = async () => {
    setState('busy');
    const r = await resendVerification();
    setState(r.ok ? 'sent' : { error: r.message });
  };
  return (
    <section aria-labelledby="email-status" className="space-y-2 max-w-prose">
      <h2 id="email-status" className="text-base font-semibold text-text">
        Confirm your email
      </h2>
      {emailSending ? (
        <>
          <p className="text-[15px]">
            We sent a link to <span className="font-medium">{user.email}</span>. Open it to confirm this email is yours.
            It works for 24 hours.
          </p>
          <div className="flex flex-wrap items-center gap-3">
            <button type="button" onClick={resend} disabled={state === 'busy'} className={secondaryButton}>
              {state === 'busy' ? 'Sending…' : 'Resend the link'}
            </button>
            <span role="status" className="text-sm text-muted">
              {state === 'sent' ? 'Sent. Check your inbox and spam folder.' : ''}
            </span>
          </div>
          {typeof state === 'object' && (
            <p role="alert" className="text-sm text-danger">
              {state.error}
            </p>
          )}
        </>
      ) : (
        <p className="text-[15px] text-muted">
          Your email <span className="font-medium text-text">{user.email}</span> isn’t confirmed yet. Email links aren’t
          set up on this site yet, so there is nothing to do for now.
        </p>
      )}
    </section>
  );
};

// The real sync state (src/lib/sync.ts through syncAdapter.ts), and the offer to add this browser's
// signed-out progress to the account (ImportPrompt renders nothing once answered).
const SyncStatus: React.FC = () => {
  const sync = useSyncState();
  return (
    <section aria-labelledby="sync-heading" className="space-y-2 max-w-prose" data-testid="sync-status">
      <h2 id="sync-heading" className="text-base font-semibold text-text">
        Your progress
      </h2>
      <p className="text-[15px]" role="status">
        {syncStatusText(sync)}
      </p>
      {sync.status !== 'off' && (
        <button type="button" onClick={() => void sync.syncNow()} disabled={sync.status === 'syncing'} className={secondaryButton}>
          Sync now
        </button>
      )}
      <ImportPrompt className="mt-4" />
    </section>
  );
};

const PathProgress: React.FC = () => {
  const { paths, modules, progress, journey } = useGameLayer();
  const src = useMemo(() => ({ journey, labComplete: labCheck(progress, modules) }), [journey, progress, modules]);
  if (paths.length === 0) return null;
  return (
    <section aria-labelledby="paths-heading" className="space-y-3">
      <h2 id="paths-heading" className="text-base font-semibold text-text">
        Learning paths
      </h2>
      <ul className="space-y-4">
        {paths.map(p => (
          <li key={p.id} className="space-y-1.5 max-w-md">
            <p className="text-[15px]">
              <a href={learnHref(p.id)} className="font-medium text-text hover:text-accent rounded-sm">
                {p.title}
              </a>
            </p>
            <p className="text-sm text-muted tabular-nums">{pathProgressText(p, src)}</p>
            <ProgressBar percent={pathPercent(p, src)} />
          </li>
        ))}
      </ul>
    </section>
  );
};

const RecentBadges: React.FC = () => {
  const { activity, badges, prefs } = useGameLayer();
  if (!prefs.showBadges) {
    return (
      <p className="text-sm text-muted">
        Badges are hidden. You can show them again in{' '}
        <a href={accountHref('settings')} className={textLink}>
          Settings
        </a>
        .
      </p>
    );
  }
  const earned = badges
    .filter(b => b.id in activity.badges)
    .sort((a, b) => activity.badges[b.id] - activity.badges[a.id]);
  return (
    <section aria-labelledby="badges-heading" className="space-y-2 max-w-prose">
      <h2 id="badges-heading" className="text-base font-semibold text-text">
        Badges
      </h2>
      {earned.length === 0 ? (
        <p className="text-[15px] text-muted">No badges yet. Run a command in any lab or the Sandbox to earn your first one.</p>
      ) : (
        <>
          <p className="text-sm text-muted">
            {earned.length === 1 ? '1 badge earned' : `${earned.length} badges earned`}
            {earned.length > RECENT_BADGES ? `. The ${RECENT_BADGES} most recent:` : ':'}
          </p>
          <ul aria-label="Recent badges" className="flex flex-wrap gap-x-4 gap-y-2">
            {earned.slice(0, RECENT_BADGES).map(b => (
              <li key={b.id} className="flex items-center gap-1.5 text-[15px]">
                <BadgeCheck className="size-4 shrink-0 text-ok" aria-hidden="true" />
                <a href={badgeHref(b.id)} className="text-text hover:text-accent rounded-sm">
                  <BadgeName badge={b} />
                </a>
              </li>
            ))}
          </ul>
        </>
      )}
      <p className="text-sm">
        <a href={learnHref()} className={textLink}>
          All badges, on the Learn page
        </a>
      </p>
    </section>
  );
};

const QuickLinks: React.FC = () => {
  const links = [
    { href: learnHref(), label: 'Learning paths' },
    { href: reviewHref(), label: 'Review questions' },
    { href: routeHref({ section: 'sandbox' }), label: 'Sandbox' },
    { href: routeHref({ section: 'sandbox', challengeId: null }), label: 'Challenges' },
    { href: accountHref('settings'), label: 'Settings' },
    { href: accountHref('security'), label: 'Security' },
  ];
  return (
    <nav aria-labelledby="quick-links" className="space-y-2">
      <h2 id="quick-links" className="text-base font-semibold text-text">
        Quick links
      </h2>
      <ul className="grid grid-cols-2 sm:grid-cols-3 gap-x-4 gap-y-1">
        {links.map(l => (
          <li key={l.href}>
            <a href={l.href} className={`${textLink} inline-flex items-center min-h-10 text-[15px]`}>
              {l.label}
            </a>
          </li>
        ))}
      </ul>
    </nav>
  );
};
