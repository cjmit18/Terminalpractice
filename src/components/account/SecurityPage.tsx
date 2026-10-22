import React, { useCallback, useEffect, useId, useState } from 'react';
import { Github, Mail } from 'lucide-react';
import {
  changeEmail,
  changePassword,
  deleteAccount,
  downloadExport,
  getAccount,
  oauthStartHref,
  signOutEverywhere,
  unlinkIdentity,
  updateDisplayName,
  type AccountDetails,
  type AccountUser,
  type OAuthProvider,
  type Providers,
} from '../../lib/account';
import { replaceRoute } from '../../lib/router';
import { Field, FormError, FormNote, PasswordField, dangerButton, secondaryButton, useFocusFirstError } from './forms';
import { displayNameError, emailError, newPasswordError, type ErrorField } from './messages';

const PROVIDER_NAME: Record<string, string> = { google: 'Google', github: 'GitHub', email: 'Email and password' };

const sectionClass = 'space-y-4 pt-8 border-t border-line first:pt-0 first:border-t-0';

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
      <DeleteAccount />
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
  const [busy, setBusy] = useState(false);
  const { formRef, errorRef, focusErrors } = useFocusFirstError();

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setNote(null);
    setFormError(null);
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
  const [busy, setBusy] = useState(false);
  const { formRef, errorRef, focusErrors } = useFocusFirstError();

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setNote(null);
    setFormError(null);
    const errs: Errors = {};
    const emErr = emailError(email);
    if (emErr) errs.email = emErr;
    if (hasPassword && !password) errs.currentPassword = 'Enter your password to confirm it is you.';
    setErrors(errs);
    if (Object.keys(errs).length) return focusErrors();
    setBusy(true);
    const sentTo = email.trim();
    const r = await changeEmail(hasPassword ? { email: sentTo, password } : { email: sentTo });
    setBusy(false);
    setPassword('');
    if (!r.ok) {
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
          <PasswordField label="Password" value={password} onChange={setPassword} autoComplete="current-password" error={errors.currentPassword} />
        )}
        <button type="submit" disabled={busy} className={secondaryButton}>
          {current ? 'Change email' : 'Add email'}
        </button>
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
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const linked = new Set(details.identities.map(i => i.provider));
  const linkable = (['google', 'github'] as OAuthProvider[]).filter(p => providers[p] && !linked.has(p));
  const methods = details.identities.length + (details.hasPassword && !linked.has('email') ? 1 : 0);

  const unlink = async (provider: string) => {
    setError(null);
    setNote(null);
    setBusy(provider);
    const r = await unlinkIdentity(provider);
    setBusy(null);
    if (!r.ok) {
      setError(r.message);
      return;
    }
    setNote(`${PROVIDER_NAME[provider] ?? provider} is no longer linked.`);
    onChange();
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
      {error && (
        <p role="alert" className="rounded-md bg-danger-soft px-3 py-2 text-sm text-danger">
          {error}
        </p>
      )}
      <FormNote message={note} />
      {methods <= 1 && details.identities.length > 0 && (
        <p className="text-sm text-muted">Link another account or set a password first if you want to unlink this one.</p>
      )}
      {linkable.length > 0 && (
        <div className="flex flex-wrap gap-2">
          {linkable.map(p => (
            <a key={p} href={oauthStartHref(p, { link: true, returnTo: '#/account/security' })} className={secondaryButton}>
              Link {PROVIDER_NAME[p]}
            </a>
          ))}
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

const DeleteAccount: React.FC = () => {
  const id = useId();
  const [typed, setTyped] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const confirmed = typed.trim().toLowerCase() === 'delete';
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!confirmed) {
      setError('Type the word delete to confirm.');
      return;
    }
    setBusy(true);
    setError(null);
    const r = await deleteAccount();
    setBusy(false);
    setTyped('');
    if (!r.ok) setError(r.message);
    else replaceRoute({ section: 'account', page: 'home' });
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
      <form onSubmit={submit} noValidate className="space-y-3">
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
        <button type="submit" disabled={!confirmed || busy} className={dangerButton}>
          Delete my account
        </button>
      </form>
    </section>
  );
};
