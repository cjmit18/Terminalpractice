import React, { useCallback, useEffect, useId, useRef, useState } from 'react';
import { Github, Mail, Monitor } from 'lucide-react';
import {
  changePassword,
  deleteAccount,
  downloadExport,
  endOtherSessions,
  endSession,
  getAccount,
  githubSignInHref,
  listSessions,
  unlinkIdentity,
  updateDisplayName,
  type AccountDetails,
  type AccountSession,
  type AccountUser,
  type ApiResult,
} from '../../lib/account';
import { accountHref } from '../../lib/router';
import { Field, FormError, FormNote, PasswordField, dangerButton, secondaryButton, textLink, useFocusFirstError } from './forms';
import { displayNameError, newPasswordError, type ErrorField } from './messages';

const PROVIDER_NAME: Record<string, string> = { github: 'GitHub', email: 'Email and password' };
const RETURN_HERE = '#/account/security';

const sectionClass = 'space-y-4 pt-8 border-t border-line first:pt-0 first:border-t-0';
const headingClass = 'text-base font-semibold text-text';

const formatDate = (ms: number | null) =>
  ms === null ? '' : new Date(ms).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });

/** The providers a 403 `reauth_required` offers, or null when the answer is something else */
const reauthProviders = (r: ApiResult<unknown>): string[] | null => (!r.ok && r.code === 'reauth_required' ? (r.providers ?? []) : null);

/** After 403 `reauth_required` (an account without a password): sign in again, which brings you back here */
const ReauthNotice: React.FC<{ providers: string[] | null }> = ({ providers }) => {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (providers) ref.current?.focus();
  }, [providers]);
  if (!providers) return null;
  return (
    <div ref={ref} tabIndex={-1} role="alert" className="space-y-3 rounded-md border border-line-strong bg-surface-2 px-3 py-3 focus:outline-none">
      <p className="text-sm text-text">For your security, sign in again to continue. You’ll come back to this page.</p>
      {providers.includes('github') ? (
        <a href={githubSignInHref(RETURN_HERE)} className={secondaryButton}>
          <Github className="size-4" aria-hidden="true" />
          Sign in again with GitHub
        </a>
      ) : (
        <p className="text-sm text-muted">Sign out, sign in again, then come back here.</p>
      )}
    </div>
  );
};

/** #/account/security: name, password, ways to sign in, sessions, export and delete. */
export const SecurityPage: React.FC<{ user: AccountUser }> = ({ user }) => {
  const [details, setDetails] = useState<AccountDetails | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const load = useCallback(async () => {
    const r = await getAccount();
    if (r.ok) {
      setDetails(r.data);
      setLoadError(null);
    } else setLoadError(r.message);
  }, []);
  useEffect(() => {
    void load();
  }, [load]);

  return (
    <div className="space-y-8 max-w-xl">
      <p className="text-sm">
        <a href={accountHref()} className={textLink}>
          Back to your account
        </a>
      </p>
      <DisplayNameForm user={user} />
      {loadError && (
        <p role="alert" className="rounded-md bg-danger-soft px-3 py-2 text-sm text-danger">
          Could not load your sign-in details. {loadError}
        </p>
      )}
      {details && (
        <>
          <PasswordForm details={details} onDone={load} />
          <SignInMethods details={details} onChange={load} />
        </>
      )}
      <Sessions />
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
      <h2 id="name-h" className={headingClass}>
        Display name
      </h2>
      <form ref={formRef} onSubmit={submit} noValidate className="space-y-3">
        <Field label="Display name" autoComplete="name" maxLength={50} value={name} onChange={e => setName(e.target.value)} error={error ?? undefined} />
        <button type="submit" disabled={busy} className={secondaryButton}>
          Save name
        </button>
        <FormNote message={note} />
      </form>
    </section>
  );
};

type Errors = Partial<Record<ErrorField, string>>;

const PasswordForm: React.FC<{ details: AccountDetails; onDone: () => void }> = ({ details, onDone }) => {
  const { hasPassword } = details;
  const email = details.user.email ?? null;
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [errors, setErrors] = useState<Errors>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [reauth, setReauth] = useState<string[] | null>(null);
  const [busy, setBusy] = useState(false);
  const { formRef, errorRef, focusErrors } = useFocusFirstError();

  if (!hasPassword && !email) {
    return (
      <section aria-labelledby="pw-h" className={sectionClass}>
        <h2 id="pw-h" className={headingClass}>
          Password
        </h2>
        <p className="text-sm text-muted">You sign in with GitHub, so this account has no password.</p>
      </section>
    );
  }

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setNote(null);
    setFormError(null);
    setReauth(null);
    const errs: Errors = {};
    if (hasPassword && !current) errs.currentPassword = 'Enter your current password.';
    const pwErr = newPasswordError(next);
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
      <h2 id="pw-h" className={headingClass}>
        {hasPassword ? 'Change password' : 'Set a password'}
      </h2>
      {!hasPassword && <p className="text-sm text-muted">Add a password to sign in with your email as well.</p>}
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

const SignInMethods: React.FC<{ details: AccountDetails; onChange: () => void }> = ({ details, onChange }) => {
  const { hasPassword } = details;
  const [password, setPassword] = useState('');
  const [passwordError, setPasswordError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [reauth, setReauth] = useState<string[] | null>(null);
  const [busy, setBusy] = useState(false);
  const { formRef, focusErrors } = useFocusFirstError();
  const onlyOne = details.signInMethods.length <= 1;

  const unlink = async (provider: string) => {
    setError(null);
    setNote(null);
    setReauth(null);
    setPasswordError(null);
    if (hasPassword && !password) {
      setPasswordError('Enter your current password to confirm it is you.');
      return focusErrors();
    }
    setBusy(true);
    const r = await unlinkIdentity(provider, hasPassword ? password : undefined);
    setBusy(false);
    setPassword('');
    if (!r.ok) {
      const providers = reauthProviders(r);
      if (providers) return setReauth(providers);
      if (r.field === 'currentPassword') {
        setPasswordError(r.message);
        return focusErrors();
      }
      return setError(r.message);
    }
    setNote(`${PROVIDER_NAME[provider] ?? provider} is no longer linked.`);
    onChange();
  };

  return (
    <section aria-labelledby="methods-h" className={sectionClass}>
      <h2 id="methods-h" className={headingClass}>
        Ways to sign in
      </h2>
      <ul className="divide-y divide-line border-y border-line">
        {details.identities.map(i => {
          const name = PROVIDER_NAME[i.provider] ?? i.provider;
          return (
            <li key={i.provider} className="flex flex-wrap items-center justify-between gap-3 py-3">
              <div className="flex items-start gap-3 min-w-0">
                {i.provider === 'github' ? <Github className="size-4 mt-1 shrink-0" aria-hidden="true" /> : <Mail className="size-4 mt-1 shrink-0" aria-hidden="true" />}
                <p className="min-w-0 text-[15px]">
                  <span className="font-medium">{name}</span>
                  <span className="block text-sm text-muted break-words">
                    {i.label}
                    {i.linkedAt ? ` · linked ${formatDate(i.linkedAt)}` : ''}
                  </span>
                </p>
              </div>
              {!onlyOne && (
                <button type="button" onClick={() => unlink(i.provider)} disabled={busy} aria-label={`Unlink ${name}`} className={secondaryButton}>
                  Unlink
                </button>
              )}
            </li>
          );
        })}
      </ul>
      {onlyOne ? (
        <p className="text-sm text-muted">This is your only way to sign in, so it can’t be removed.</p>
      ) : (
        hasPassword && (
          <form ref={formRef} onSubmit={e => e.preventDefault()} noValidate>
            <PasswordField
              label="Current password"
              value={password}
              onChange={v => {
                setPassword(v);
                setPasswordError(null);
              }}
              autoComplete="current-password"
              error={passwordError ?? undefined}
            />
            <p className="mt-1.5 text-sm text-muted">Needed to unlink a way to sign in.</p>
          </form>
        )
      )}
      {error && (
        <p role="alert" className="rounded-md bg-danger-soft px-3 py-2 text-sm text-danger">
          {error}
        </p>
      )}
      <ReauthNotice providers={reauth} />
      <FormNote message={note} />
    </section>
  );
};

const Sessions: React.FC = () => {
  const [list, setList] = useState<AccountSession[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const load = useCallback(async () => {
    const r = await listSessions();
    if (r.ok) setList(r.data.sessions);
    else setError(r.message);
  }, []);
  useEffect(() => {
    void load();
  }, [load]);

  const end = async (s: AccountSession) => {
    setError(null);
    setNote(null);
    setBusy(true);
    const r = await endSession(s);
    setBusy(false);
    // Ending this browser's session signs out here, and the page shows sign-in
    if (!r.ok) return setError(r.message);
    setNote('Signed out on that device.');
    void load();
  };
  const endOthers = async () => {
    setError(null);
    setNote(null);
    setBusy(true);
    const r = await endOtherSessions();
    setBusy(false);
    if (!r.ok) return setError(r.message);
    setNote(r.data.ended === 1 ? 'Signed out on 1 other device.' : `Signed out on ${r.data.ended} other devices.`);
    void load();
  };
  const others = list?.filter(s => !s.current).length ?? 0;

  return (
    <section aria-labelledby="sessions-h" className={sectionClass}>
      <h2 id="sessions-h" className={headingClass}>
        Where you’re signed in
      </h2>
      <p className="text-sm text-muted">
        Each sign-in, newest first. If you don’t recognise one, sign it out and change your password. Progress saved in
        each browser stays there.
      </p>
      {list === null && !error && <p className="text-sm text-muted">Loading…</p>}
      {list && (
        <ul className="divide-y divide-line border-y border-line" aria-label="Sessions">
          {list.map(s => (
            <li key={s.id} className="flex flex-wrap items-center justify-between gap-3 py-3">
              <div className="flex items-start gap-3 min-w-0">
                <Monitor className="size-4 mt-1 shrink-0" aria-hidden="true" />
                <p className="min-w-0 text-[15px]">
                  <span className="font-medium">{s.current ? 'This browser' : 'Another device or browser'}</span>
                  <span className="block text-sm text-muted">
                    Signed in {formatDate(s.signedInAt)} · stays signed in until {formatDate(s.expiresAt)} if unused
                  </span>
                </p>
              </div>
              <button
                type="button"
                onClick={() => end(s)}
                disabled={busy}
                aria-label={s.current ? 'Sign out of this browser' : `Sign out the session from ${formatDate(s.signedInAt)}`}
                className={secondaryButton}
              >
                Sign out
              </button>
            </li>
          ))}
        </ul>
      )}
      {others > 0 && (
        <button type="button" onClick={endOthers} disabled={busy} className={secondaryButton}>
          Sign out everywhere else
        </button>
      )}
      {error && (
        <p role="alert" className="text-sm text-danger">
          {error}
        </p>
      )}
      <FormNote message={note} />
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
      <h2 id="export-h" className={headingClass}>
        Your data
      </h2>
      <p className="text-sm text-muted">A JSON file with everything stored for your account: profile, ways to sign in, sessions and progress.</p>
      <div className="flex flex-wrap items-center gap-3">
        <button type="button" onClick={run} disabled={state === 'busy'} className={secondaryButton}>
          Download my data
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
  const [passwordError, setPasswordError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [reauth, setReauth] = useState<string[] | null>(null);
  const [busy, setBusy] = useState(false);
  const { formRef, focusErrors } = useFocusFirstError();
  const confirmed = typed.trim().toLowerCase() === 'delete';
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setReauth(null);
    setPasswordError(null);
    if (!confirmed) return setError('Type the word delete to confirm.');
    if (hasPassword && !password) {
      setPasswordError('Enter your current password to confirm it is you.');
      return focusErrors();
    }
    setBusy(true);
    setError(null);
    const r = await deleteAccount(hasPassword ? password : undefined);
    setBusy(false);
    setPassword('');
    // On success this browser is signed out and the page shows sign-in
    if (r.ok) return;
    const providers = reauthProviders(r);
    if (providers) return setReauth(providers);
    if (r.field === 'currentPassword') {
      setPasswordError(r.message);
      return focusErrors();
    }
    setError(r.message);
  };
  return (
    <section aria-labelledby="delete-h" className={sectionClass}>
      <h2 id="delete-h" className={headingClass}>
        Delete account
      </h2>
      <p className="text-sm text-muted">
        Deletes your account, its ways to sign in and the progress saved to it. This can’t be undone. The app keeps
        working without an account, with the progress saved in this browser before you signed in.
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
        {hasPassword && (
          <PasswordField label="Current password" value={password} onChange={setPassword} autoComplete="current-password" error={passwordError ?? undefined} />
        )}
        <button type="submit" disabled={!confirmed || busy} className={dangerButton}>
          Delete my account
        </button>
        <ReauthNotice providers={reauth} />
      </form>
    </section>
  );
};
