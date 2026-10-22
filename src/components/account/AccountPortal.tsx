import React, { useEffect, useState } from 'react';
import { clearHashQuery, readHashParam, useAccount } from '../../lib/account';
import { accountHref, learnHref, type AccountPage } from '../../lib/router';
import type { ThemeChoice } from '../../lib/theme';
import { SettingsPage } from '../settings/SettingsPage';
import { Dashboard } from './Dashboard';
import { ForgotPage, ResetPage, VerifyPage } from './EmailLinkPages';
import { FormNote, textLink } from './forms';
import { returnErrorMessage } from './messages';
import { SecurityPage } from './SecurityPage';
import { PrivacyNote, SignInCard } from './SignIn';

interface Props {
  page: AccountPage;
  theme: ThemeChoice;
  onThemeChange: (t: ThemeChoice) => void;
}

const TITLES: Record<AccountPage, string> = {
  home: 'Account',
  settings: 'Settings',
  security: 'Security',
  forgot: 'Reset your password',
  verify: 'Confirm your email',
  reset: 'Choose a new password',
};

/**
 * `?error=<code>` that the server adds when it sends the browser back after linking Google or GitHub,
 * or after signing in again to confirm it is you. Read once per page, then taken out of the URL so a
 * reload or a shared link does not show it again.
 */
function useReturnError(page: AccountPage): string | null {
  const [code, setCode] = useState<string | null>(null);
  useEffect(() => {
    setCode(null);
    if (page !== 'home' && page !== 'security') return;
    const read = () => {
      const c = readHashParam('error');
      if (!c) return;
      setCode(c);
      clearHashQuery();
    };
    read();
    window.addEventListener('hashchange', read);
    return () => window.removeEventListener('hashchange', read);
  }, [page]);
  return code;
}

/** #/account and its pages. Settings work signed out; everything else follows the account state. */
export const AccountPortal: React.FC<Props> = ({ page, theme, onThemeChange }) => {
  // notice: what just happened (signed out everywhere, account deleted), until the next sign-in
  const { account, providers, emailSending, notice } = useAccount();
  const signedIn = account.status === 'signed-in';
  const returnError = useReturnError(page);

  let title = TITLES[page];
  if (page === 'home') title = signedIn ? `Hello, ${account.user.name}` : account.status === 'signed-out' ? 'Sign in' : 'Account';

  let body: React.ReactNode;
  if (page === 'settings') {
    body = <SettingsPage theme={theme} onThemeChange={onThemeChange} />;
  } else if (page === 'forgot') {
    body = <ForgotPage emailSending={emailSending} />;
  } else if (page === 'reset') {
    body = <ResetPage />;
  } else if (page === 'verify') {
    body = <VerifyPage />;
  } else if (account.status === 'loading') {
    body = <p className="text-sm text-muted">Loading…</p>;
  } else if (account.status === 'unavailable') {
    body = <Unavailable />;
  } else if (account.status === 'signed-out') {
    body = (
      <div className="space-y-10">
        {page === 'security' && (
          <p className="text-[15px]">Sign in to change your password, email and sign-in methods.</p>
        )}
        {page === 'home' && (
          <p className="text-[15px] text-muted max-w-prose">
            Sign in to keep your progress with you on other devices. You don’t need an account to use the app.
          </p>
        )}
        <div className="max-w-md">
          <SignInCard providers={providers} emailSending={emailSending} />
        </div>
        <PrivacyNote />
      </div>
    );
  } else if (page === 'security') {
    body = <SecurityPage user={account.user} providers={providers} emailSending={emailSending} />;
  } else {
    body = <Dashboard user={account.user} emailSending={emailSending} />;
  }

  return (
    <div className="max-w-3xl mx-auto w-full px-4 sm:px-6 py-8 sm:py-12 space-y-8">
      <header className="space-y-4">
        <h1 className="text-2xl font-semibold text-text break-words">{title}</h1>
        {(signedIn || page === 'settings') && <AccountTabs page={page} signedIn={signedIn} />}
      </header>
      {returnError && (
        <p role="alert" data-testid="return-error" className="rounded-md bg-danger-soft px-3 py-2 text-sm text-danger max-w-prose">
          {returnErrorMessage(returnError)}
        </p>
      )}
      {notice && account.status === 'signed-out' && (page === 'home' || page === 'security') && <FormNote message={notice} />}
      {body}
    </div>
  );
};

/** Dashboard / Settings / Security, as links (each is its own address) */
const AccountTabs: React.FC<{ page: AccountPage; signedIn: boolean }> = ({ page, signedIn }) => {
  const items: { page: AccountPage; label: string }[] = signedIn
    ? [
        { page: 'home', label: 'Dashboard' },
        { page: 'settings', label: 'Settings' },
        { page: 'security', label: 'Security' },
      ]
    : [];
  if (!signedIn) {
    return (
      <p className="text-[15px] text-muted max-w-prose">
        Saved in this browser. They work the same with or without an account.
      </p>
    );
  }
  return (
    <nav aria-label="Account" className="border-b border-line">
      <ul className="flex gap-1">
        {items.map(i => {
          const current = i.page === page;
          return (
            <li key={i.page}>
              <a
                href={accountHref(i.page)}
                aria-current={current ? 'page' : undefined}
                className={`inline-flex items-center min-h-10 px-3 -mb-px border-b-2 text-sm font-medium ${
                  current ? 'border-accent text-accent' : 'border-transparent text-muted hover:text-text'
                }`}
              >
                {i.label}
              </a>
            </li>
          );
        })}
      </ul>
    </nav>
  );
};

const Unavailable: React.FC = () => (
  <div className="space-y-4 max-w-prose text-[15px]">
    <p>Accounts aren’t available on this copy of the app. Everything works without one, and your progress is saved in this browser.</p>
    <p>
      <a href={accountHref('settings')} className={textLink}>
        Settings
      </a>{' '}
      ·{' '}
      <a href={learnHref()} className={textLink}>
        Learning paths
      </a>
    </p>
  </div>
);
