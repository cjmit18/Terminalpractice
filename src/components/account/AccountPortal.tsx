import React from 'react';
import { useAccount } from '../../lib/account';
import { learnHref, type AccountPage } from '../../lib/router';
import { Dashboard } from './Dashboard';
import { ForgotPage, ResetPage, VerifyPage } from './EmailLinkPages';
import { textLink } from './forms';
import { PrivacyNote, SignInCard } from './SignIn';
import { SecurityPage } from './SecurityPage';

const TITLES: Record<AccountPage, string> = {
  home: 'Account',
  security: 'Security and data',
  forgot: 'Reset your password',
  verify: 'Confirm your email',
  reset: 'Choose a new password',
};

/** #/account and the pages emailed links open. #/account itself follows the account state. */
export const AccountPortal: React.FC<{ page: AccountPage }> = ({ page }) => {
  const { account, providers, emailSending } = useAccount();

  let title = TITLES[page];
  if (page === 'home') title = account.status === 'signed-in' ? `Hello, ${account.user.name}` : account.status === 'signed-out' ? 'Sign in' : 'Account';
  if (page === 'security' && account.status === 'signed-out') title = 'Sign in';

  let body: React.ReactNode;
  if (page === 'forgot') body = <ForgotPage emailSending={emailSending} />;
  else if (page === 'reset') body = <ResetPage />;
  else if (page === 'verify') body = <VerifyPage />;
  else if (account.status === 'loading') body = <p className="text-sm text-muted">Loading…</p>;
  else if (account.status === 'unavailable') body = <Unavailable />;
  else if (account.status === 'signed-out') {
    body = (
      <div className="space-y-10">
        <p className="text-[15px] text-muted max-w-prose">
          Sign in to keep your progress with you on other devices. You don’t need an account to use the app.
        </p>
        <div className="max-w-md">
          <SignInCard providers={providers} emailSending={emailSending} />
        </div>
        <PrivacyNote />
      </div>
    );
  } else if (page === 'security') body = <SecurityPage user={account.user} />;
  else body = <Dashboard user={account.user} emailSending={emailSending} />;

  return (
    <div className="max-w-3xl mx-auto w-full px-4 sm:px-6 py-8 sm:py-12 space-y-8">
      <h1 id="account-heading" tabIndex={-1} className="text-2xl font-semibold text-text break-words focus:outline-none">
        {title}
      </h1>
      {body}
    </div>
  );
};

const Unavailable: React.FC = () => (
  <div className="space-y-4 max-w-prose text-[15px]">
    <p>Accounts aren’t available on this copy of the app. Everything works without one, and your progress is saved in this browser.</p>
    <p>
      <a href={learnHref()} className={textLink}>
        Learning paths
      </a>
    </p>
  </div>
);
