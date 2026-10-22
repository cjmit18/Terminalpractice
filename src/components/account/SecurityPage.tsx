import React, { useCallback, useEffect, useId, useRef, useState } from 'react';
import { Github, Mail } from 'lucide-react';
import {
  changeEmail,
  changePassword,
  deleteAccount,
  downloadExport,
  getAccount,
  oauthStartHref,
  reauthHref,
  reauthWithPassword,
  signOutEverywhere,
  unlinkIdentity,
  updateDisplayName,
  type AccountDetails,
  type AccountUser,
  type ApiResult,
  type OAuthProvider,
  type Providers,
} from '../../lib/account';
import { replaceRoute } from '../../lib/router';
import { Field, FormError, FormNote, PasswordField, dangerButton, secondaryButton, useFocusFirstError } from './forms';
import { displayNameError, emailError, newPasswordError, normalizeEmail, type ErrorField } from './messages';

const PROVIDER_NAME: Record<string, string> = { google: 'Google', github: 'GitHub', email: 'Email and password' };

const sectionClass = 'space-y-4 pt-8 border-t border-line first:pt-0 first:border-t-0';

const OAUTH: OAuthProvider[] = ['google', 'github'];

/** The providers a 403 `reauth_required` offers, or null when the answer is something else */
const reauthProviders = (r: ApiResult<unknown>): OAuthProvider[] | null =>
  !r.ok && r.code === 'reauth_required' ? OAUTH.filter(p => r.providers?.includes(p)) : null;

/**
 * After 403 `reauth_required` (an account without a password): sign in again with a linked
 * provider, which brings you back to this page to try again.
 */
const ReauthNotice: React.FC<{ providers: OAuthProvider[] | null }> = ({ providers }) => {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (providers) ref.current?.focus();
  }, [providers]);
  if (!providers) return null;
  return (
    <div ref={ref} tabIndex={-1} role="alert" data-testid="reauth" className="space-y-3 rounded-md border border-line-strong bg-surface-2 px-3 py-3 focus:outline-none">
      <p className="text-sm text-text">For your security, sign in again to continue.</p>
      {providers.length > 0 ? (
        <div className="flex flex-wrap gap-2">
          {providers.map(p => (
            <a key={p} href={reauthHref(p)} className={secondaryButton}>
              Sign in again with {PROVIDER_NAME[p]}
            </a>
          ))}
        </div>
      ) : (
        <p className="text-sm text-muted">Sign out, sign in again, then come back here.</p>
      )}
    </div>
  );
};

/** #/account/security: name, password, email, sign-in methods, sessions, export and delete. */
export const SecurityPage: React.FC<{ user: AccountUser; providers: Providers; emailSending: boolean }> = ({
  user,
  providers,
  emailSending,
}) => {
  const [details, setDetails] = useState<AccountDetails | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  const load = useCallback(async () => {
    const r = await getAccount();
    if (r.ok && r.data) {
      setDetails(r.data);
      setLoadError(null);
    } else if (!r.ok) setLoadError(r.message);
  }, []);
  useEffect(() => {
    void load();
  }, [load]);

  return (
    <div className="space-y-8 max-w-xl">
      <DisplayNameForm user={user} />
      {loadError && (
        <p role="alert" className="rounded-md bg-danger-soft px-3 py-2 text-sm text-danger">
          Could not load your sign-in details. {loadError}
        </p>
      )}
      {details && (
        <>
          <PasswordForm hasPassword={details.hasPassword} email={details.user.email ?? user.email ?? undefined} onDone={load} />
          <EmailForm current={details.user.email ?? user.email ?? null} hasPassword={details.hasPassword} emailSending={emailSending} onDone={load} />
          <LinkedMethods details={details} providers={providers} onChange={load} />
        </>
      )}
      <SignOutEverywhere />
      <ExportData />
      <DeleteAccount hasPassword={details?.hasPassword ?? false} />
    </div>
  );
};

const DisplayNameForm: React.FC<{ user: AccountUser }> = ({ user }) => {
  const [name, setName] = useState(user.name);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const { formRef, focusErrors } = useFocusFirstError();
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setNote(null);
    const err = displayNameError(name);
    setError(err);
    if (err) return focusErrors();
    setBusy(true);
    const r = await updateDisplayName(name.trim());
    setBusy(false);
    if (!r.ok) {
      setError(r.message);
      return focusErrors();
    }
    setNote('Display name saved.');
  };
  return (
    <section aria-labelledby="name-h" className={sectionClass}>
      <h2 id="name-h" className="text-base font-semibold text-text">
        Display name
      </h2>
      <form ref={formRef} onSubmit={submit} noValidate className="space-y-3">
        <Field label="Display name" autoComplete="name" maxLength={50} value={name} onChange={e => setName(e.target.value)} error={error} />
        <button type="submit" disabled={busy} className={secondaryButton}>
          Save name
        </button>
        <FormNote message={note} />
      </form>
    </section>
  );
};

type Errors = Partial<Record<ErrorField, string>>;

const PasswordForm: React.FC<{ hasPassword: boolean; email?: string; onDone: () => void }> = ({ hasPassword, email, onDone }) => {
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [errors, setErrors] = useState<Errors>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [reauth, setReauth] = useState<OAuthProvider[] | null>(null);
  const [busy, setBusy] = useState(false);
  const { formRef, errorRef, focusErrors } = useFocusFirstError();

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setNote(null);
    setFormError(null);
    setReauth(null);
    const errs: Errors = {};
    if (hasPassword && !current) errs.currentPassword = 'Enter your current password.';
    const pwErr = newPasswordError(next, email);
    if (pwErr) errs.password = pwErr;
    setErrors(errs);
    if (Object.keys(errs).length) return focusErrors();
    setBusy(true);
    const r = await changePassword(hasPassword ? { currentPassword: current, newPassword: next } : { newPassword: next });
    setBusy(false);
    // Neither password is kept once sent
    setCurrent('');
    setNext('');
    if (!r.ok) {
      const providers = reauthProviders(r);
      if (providers) return setReauth(providers);
      if (r.field === 'currentPassword' || r.field === 'password') setErrors({ [r.field]: r.message });
      else setFormError(r.message);
      return focusErrors();
    }
    setNote(hasPassword ? 'Password changed. Your other devices were signed out.' : 'Password set. You can now sign in with your email and this password.');
    onDone();
  };

  return (
    <section aria-labelledby="pw-h" className={sectionClass}>
      <h2 id="pw-h" className="text-base font-semibold text-text">
        {hasPassword ? 'Change password' : 'Set a password'}
      </h2>
      {!hasPassword && (
        <p className="text-sm text-muted">
          {email ? 'Add a password to sign in with your email as well.' : 'Add an email below first, then set a password to sign in with it.'}
        </p>
      )}
      <form ref={formRef} onSubmit={submit} noValidate className="space-y-3">
        <FormError ref={errorRef} message={formError} />
        {hasPassword && (
          <PasswordField label="Current password" value={current} onChange={setCurrent} autoComplete="current-password" error={errors.currentPassword} />
        )}
        <PasswordField label="New password" value={next} onChange={setNext} autoComplete="new-password" error={errors.password} showLengthHint />
        <button type="submit" disabled={busy} className={secondaryButton}>
          {hasPassword ? 'Change password' : 'Set password'}
        </button>
        <ReauthNotice providers={reauth} />
        <FormNote message={note} />
      </form>
    </section>
  );
};

const EmailForm: React.FC<{ current: string | null; hasPassword: boolean; emailSending: boolean; onDone: () => void }> = ({
  current,
  hasPassword,
  emailSending,
  onDone,
}) => {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [errors, setErrors] = useState<Errors>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [reauth, setReauth] = useState<OAuthProvider[] | null>(null);
  const [busy, setBusy] = useState(false);
  const { formRef, errorRef, focusErrors } = useFocusFirstError();

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setNote(null);
    setFormError(null);
    setReauth(null);
    const errs: Errors = {};
    const emErr = emailError(email);
    if (emErr) errs.email = emErr;
    if (hasPassword && !password) errs.currentPassword = 'Enter your current password to confirm it is you.';
    setErrors(errs);
    if (Object.keys(errs).length) return focusErrors();
    setBusy(true);
    const sentTo = normalizeEmail(email);
    const r = await changeEmail(hasPassword ? { email: sentTo, currentPassword: password } : { email: sentTo });
    setBusy(false);
    setPassword('');
    if (!r.ok) {
      const providers = reauthProviders(r);
      if (providers) return setReauth(providers);
      if (r.field === 'email' || r.field === 'currentPassword') setErrors({ [r.field]: r.message });
      else if (r.field === 'password') setErrors({ currentPassword: r.message });
      else setFormError(r.message);
      return focusErrors();
    }
    setEmail('');
    setNote(
      emailSending
        ? `We sent a link to ${sentTo}. Open it to confirm the new email.`
        : `Saved. Email links aren’t set up on this site yet, so ${sentTo} can’t be confirmed for now.`,
    );
    onDone();
  };

  return (
    <section aria-labelledby="email-h" className={sectionClass}>
      <h2 id="email-h" className="text-base font-semibold text-text">
        {current ? 'Change email' : 'Add an email'}
      </h2>
      <p className="text-sm text-muted">
        {current ? (
          <>
            Your email is <span className="font-medium text-text">{current}</span>.
          </>
        ) : (
          'An email lets you sign in with a password and reset it if you forget it.'
        )}
      </p>
      <form ref={formRef} onSubmit={submit} noValidate className="space-y-3">
        <FormError ref={errorRef} message={formError} />
        <Field
          label={current ? 'New email' : 'Email'}
          type="email"
          autoComplete="email"
          inputMode="email"
          value={email}
          onChange={e => setEmail(e.target.value)}
          error={errors.email}
        />
        {hasPassword && (
          <PasswordField label="Current password" value={password} onChange={setPassword} autoComplete="current-password" error={errors.currentPassword} />
        )}
        <button type="submit" disabled={busy} className={secondaryButton}>
          {current ? 'Change email' : 'Add email'}
        </button>
        <ReauthNotice providers={reauth} />
        <FormNote message={note} />
      </form>
    </section>
  );
};

const formatDate = (t: number | string) => {
  try {
    const d = new Date(typeof t === 'number' && t < 1e12 ? t * 1000 : t);
    return Number.isNaN(d.getTime()) ? '' : d.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
  } catch {
    return '';
  }
};

const LinkedMethods: React.FC<{ details: AccountDetails; providers: Providers; onChange: () => void }> = ({ details, providers, onChange }) => {
  const id = useId();
  const [password, setPassword] = useState('');
  const [passwordError, setPasswordError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [reauth, setReauth] = useState<OAuthProvider[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const { formRef, focusErrors } = useFocusFirstError();
  const { hasPassword } = details;
  const linked = new Set(details.identities.map(i => i.provider));
  const linkable = OAUTH.filter(p => providers[p] && !linked.has(p));
  const methods = details.identities.length + (details.hasPassword && !linked.has('email') ? 1 : 0);
  // An unconfirmed email could belong to someone else: linking waits until it is confirmed
  const unverified = !!details.user.email && !details.emailVerified;

  const start = () => {
    setError(null);
    setNote(null);
    setReauth(null);
    setPasswordError(null);
  };
  /** Accounts with a password type it first; false (and the field marked) when it is missing */
  const needPassword = () => {
    if (!hasPassword || password) return true;
    setPasswordError('Enter your current password to confirm it is you.');
    focusErrors();
    return false;
  };
  const failed = (r: ApiResult<unknown>) => {
    if (r.ok) return;
    const reauthWith = reauthProviders(r);
    if (reauthWith) setReauth(reauthWith);
    else if (r.field === 'currentPassword') {
      setPasswordError(r.message);
      focusErrors();
    } else setError(r.message);
  };

  const unlink = async (provider: string) => {
    start();
    if (!needPassword()) return;
    setBusy(provider);
    const r = await unlinkIdentity(provider, hasPassword ? password : undefined);
    setBusy(null);
    setPassword('');
    if (!r.ok) return failed(r);
    setNote(`${PROVIDER_NAME[provider] ?? provider} is no longer linked.`);
    onChange();
  };

  /** With a password: confirm it first (POST /api/account/reauth), then go to Google/GitHub to link */
  const link = async (provider: OAuthProvider) => {
    start();
    const href = oauthStartHref(provider, { link: true, returnTo: '#/account/security' });
    if (!hasPassword) return window.location.assign(href);
    if (!needPassword()) return;
    setBusy(provider);
    const r = await reauthWithPassword(password);
    setPassword('');
    if (!r.ok) {
      setBusy(null);
      return failed(r);
    }
    window.location.assign(href);
  };

  return (
    <section aria-labelledby="methods-h" className={sectionClass}>
      <h2 id="methods-h" className="text-base font-semibold text-text">
        Ways to sign in
      </h2>
      <p className="text-sm text-muted">You need at least one way to sign in, so the last one can’t be removed.</p>
      <ul className="divide-y divide-line border-y border-line">
        {details.identities.map(i => (
          <li key={i.provider} className="flex flex-wrap items-center justify-between gap-3 py-3">
            <div className="flex items-start gap-3 min-w-0">
              {i.provider === 'github' ? (
                <Github className="size-4 mt-1 shrink-0" aria-hidden="true" />
              ) : (
                <Mail className="size-4 mt-1 shrink-0" aria-hidden="true" />
              )}
              <p className="min-w-0 text-[15px]">
                <span className="font-medium">{PROVIDER_NAME[i.provider] ?? i.provider}</span>
                <span className="block text-sm text-muted break-words">
                  {i.label}
                  {formatDate(i.linkedAt) && ` · linked ${formatDate(i.linkedAt)}`}
                </span>
              </p>
            </div>
            <button
              type="button"
              onClick={() => unlink(i.provider)}
              disabled={busy !== null}
              aria-label={`Unlink ${PROVIDER_NAME[i.provider] ?? i.provider}`}
              className={secondaryButton}
            >
              Unlink
            </button>
          </li>
        ))}
      </ul>
      {hasPassword && (details.identities.length > 0 || (linkable.length > 0 && !unverified)) && (
        <form ref={formRef} onSubmit={e => e.preventDefault()} noValidate>
          <PasswordField
            label="Current password"
            value={password}
            onChange={v => {
              setPassword(v);
              setPasswordError(null);
            }}
            autoComplete="current-password"
            error={passwordError}
          />
          <p className="mt-1.5 text-sm text-muted">Needed to link or unlink a way to sign in.</p>
        </form>
      )}
      {error && (
        <p role="alert" className="rounded-md bg-danger-soft px-3 py-2 text-sm text-danger">
          {error}
        </p>
      )}
      <ReauthNotice providers={reauth} />
      <FormNote message={note} />
      {methods <= 1 && details.identities.length > 0 && (
        <p className="text-sm text-muted">Link another account or set a password first if you want to unlink this one.</p>
      )}
      {linkable.length > 0 && (
        <div className="space-y-2">
          <div className="flex flex-wrap gap-2">
            {linkable.map(p =>
              hasPassword || unverified ? (
                <button
                  key={p}
                  type="button"
                  onClick={() => link(p)}
                  disabled={unverified || busy !== null}
                  aria-describedby={unverified ? `${id}-verify` : undefined}
                  className={secondaryButton}
                >
                  Link {PROVIDER_NAME[p]}
                </button>
              ) : (
                <a key={p} href={oauthStartHref(p, { link: true, returnTo: '#/account/security' })} className={secondaryButton}>
                  Link {PROVIDER_NAME[p]}
                </a>
              ),
            )}
          </div>
          {unverified && (
            <p id={`${id}-verify`} className="text-sm text-muted">
              Verify your email first, then you can link Google or GitHub.
            </p>
          )}
        </div>
      )}
    </section>
  );
};

const SignOutEverywhere: React.FC = () => {
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const run = async () => {
    setBusy(true);
    setError(null);
    const r = await signOutEverywhere();
    setBusy(false);
    if (!r.ok) setError(r.message);
    else replaceRoute({ section: 'account', page: 'home' });
  };
  return (
    <section aria-labelledby="sessions-h" className={sectionClass}>
      <h2 id="sessions-h" className="text-base font-semibold text-text">
        Devices
      </h2>
      <p className="text-sm text-muted">
        Signs you out everywhere, including here. Use it if you signed in on a shared or lost device. Progress saved in
        each browser stays there.
      </p>
      <button type="button" onClick={run} disabled={busy} className={secondaryButton}>
        Sign out on all devices
      </button>
      {error && (
        <p role="alert" className="text-sm text-danger">
          {error}
        </p>
      )}
    </section>
  );
};

const ExportData: React.FC = () => {
  const [state, setState] = useState<'idle' | 'busy' | 'done' | { error: string }>('idle');
  const run = async () => {
    setState('busy');
    const r = await downloadExport();
    setState(r.ok ? 'done' : { error: r.message });
  };
  return (
    <section aria-labelledby="export-h" className={sectionClass}>
      <h2 id="export-h" className="text-base font-semibold text-text">
        Your data
      </h2>
      <p className="text-sm text-muted">A JSON file with everything stored for your account: profile, sign-in methods and progress.</p>
      <div className="flex flex-wrap items-center gap-3">
        <button type="button" onClick={run} disabled={state === 'busy'} className={secondaryButton}>
          Export my data
        </button>
        <span role="status" className="text-sm text-muted">
          {state === 'done' ? 'Downloaded.' : ''}
        </span>
      </div>
      {typeof state === 'object' && (
        <p role="alert" className="text-sm text-danger">
          {state.error}
        </p>
      )}
    </section>
  );
};

const DeleteAccount: React.FC<{ hasPassword: boolean }> = ({ hasPassword }) => {
  const id = useId();
  const [typed, setTyped] = useState('');
  const [password, setPassword] = useState('');
  // An older page may not know the account has a password: the server's answer shows the field
  const [askPassword, setAskPassword] = useState(false);
  const [passwordError, setPasswordError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [reauth, setReauth] = useState<OAuthProvider[] | null>(null);
  const [busy, setBusy] = useState(false);
  const { formRef, focusErrors } = useFocusFirstError();
  const withPassword = hasPassword || askPassword;
  const confirmed = typed.trim().toLowerCase() === 'delete';
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setReauth(null);
    setPasswordError(null);
    if (!confirmed) {
      setError('Type the word delete to confirm.');
      return;
    }
    if (withPassword && !password) {
      setPasswordError('Enter your current password to confirm it is you.');
      return focusErrors();
    }
    setBusy(true);
    setError(null);
    const r = await deleteAccount(withPassword ? password : undefined);
    setBusy(false);
    setPassword('');
    if (r.ok) return replaceRoute({ section: 'account', page: 'home' });
    const providers = reauthProviders(r);
    if (providers) return setReauth(providers);
    if (r.field === 'currentPassword') {
      setAskPassword(true);
      setPasswordError(r.message);
      return focusErrors();
    }
    setTyped('');
    setError(r.message);
  };
  return (
    <section aria-labelledby="delete-h" className={sectionClass}>
      <h2 id="delete-h" className="text-base font-semibold text-text">
        Delete account
      </h2>
      <p className="text-sm text-muted">
        Deletes your account, its sign-in methods and the progress saved to it. This can’t be undone. Progress saved in
        this browser stays, and the app keeps working without an account.
      </p>
      <form ref={formRef} onSubmit={submit} noValidate className="space-y-3">
        <div className="space-y-1.5">
          <label htmlFor={`${id}-confirm`} className="block text-sm font-medium text-text">
            Type <span className="font-mono">delete</span> to confirm
          </label>
          <input
            id={`${id}-confirm`}
            value={typed}
            onChange={e => {
              setTyped(e.target.value);
              setError(null);
            }}
            autoComplete="off"
            autoCapitalize="none"
            spellCheck={false}
            aria-invalid={error ? true : undefined}
            aria-describedby={error ? `${id}-error` : undefined}
            className="block w-full max-w-xs min-h-10 rounded-md border border-line-strong bg-surface px-3 text-[15px] text-text"
          />
          {error && (
            <p id={`${id}-error`} role="alert" className="text-sm text-danger">
              {error}
            </p>
          )}
        </div>
        {withPassword && (
          <PasswordField label="Current password" value={password} onChange={setPassword} autoComplete="current-password" error={passwordError} />
        )}
        <button type="submit" disabled={!confirmed || busy} className={dangerButton}>
          Delete my account
        </button>
        <ReauthNotice providers={reauth} />
      </form>
    </section>
  );
};
