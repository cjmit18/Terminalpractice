import React, { useState } from 'react';
import { BadgeCheck, LogOut } from 'lucide-react';
import { resendVerification, signOut, type AccountUser } from '../../lib/account';
import { learnHref } from '../../lib/router';
import { secondaryButton, textLink } from './forms';

/** #/account when signed in: who you are, whether your email is confirmed, and signing out. */
export const Dashboard: React.FC<{ user: AccountUser; emailSending: boolean }> = ({ user, emailSending }) => (
  <div className="space-y-10">
    <EmailStatus user={user} emailSending={emailSending} />
    <section aria-labelledby="progress-heading" className="space-y-2 max-w-prose">
      <h2 id="progress-heading" className="text-base font-semibold text-text">
        Your progress
      </h2>
      <p className="text-[15px]">
        Your progress is saved in this browser, as before. Syncing it to your account, so it follows you to other
        devices, is the next step.{' '}
        <a href={learnHref()} className={textLink}>
          Back to the learning paths
        </a>
      </p>
    </section>
    <SignOut />
  </div>
);

const EmailStatus: React.FC<{ user: AccountUser; emailSending: boolean }> = ({ user, emailSending }) => {
  const [state, setState] = useState<'idle' | 'busy' | 'sent' | { error: string }>('idle');
  if (!user.email) {
    return (
      <p className="text-[15px] text-muted max-w-prose">
        You sign in with {user.login ? `GitHub as ${user.login}` : 'a linked account'}.
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
            We sent a link to <span className="font-medium">{user.email}</span>. Open it to confirm this email is yours. It
            works for 24 hours.
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
          Your email <span className="font-medium text-text">{user.email}</span> isn’t confirmed yet. This site can’t send
          email yet, so there is nothing to do for now: you can sign in with your password as usual.
        </p>
      )}
    </section>
  );
};

const SignOut: React.FC = () => {
  const [error, setError] = useState('');
  return (
    <div className="space-y-2">
      <button
        type="button"
        onClick={async () => {
          setError('');
          if (!(await signOut())) setError('Could not sign out. Check your connection and try again.');
        }}
        className={secondaryButton}
      >
        <LogOut className="size-4" aria-hidden="true" />
        Sign out
      </button>
      {error && (
        <p role="alert" className="text-sm text-danger">
          {error}
        </p>
      )}
    </div>
  );
};
