import React, { useId, useRef, useState } from 'react';
import { Github } from 'lucide-react';
import { githubSignInHref, login, register, type Providers } from '../../lib/account';
import { accountHref } from '../../lib/router';
import { Field, FormError, PasswordField, primaryButton, secondaryButton, textLink, useFocusFirstError } from './forms';
import { displayNameError, emailError, newPasswordError, normalizeEmail, type ErrorField } from './messages';

type Tab = 'signin' | 'create';

/** The sign-in card: GitHub first when the server offers it, then email and password with two tabs. */
export const SignInCard: React.FC<{ providers: Providers; emailSending: boolean }> = ({ providers, emailSending }) => {
  const [tab, setTab] = useState<Tab>('signin');
  const id = useId();
  const tabs: { key: Tab; label: string }[] = [
    { key: 'signin', label: 'Sign in' },
    { key: 'create', label: 'Create account' },
  ];
  const tabRefs = useRef<(HTMLButtonElement | null)[]>([]);
  const onKey = (e: React.KeyboardEvent, i: number) => {
    let next = -1;
    if (e.key === 'ArrowRight') next = (i + 1) % tabs.length;
    else if (e.key === 'ArrowLeft') next = (i - 1 + tabs.length) % tabs.length;
    else if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = tabs.length - 1;
    if (next < 0) return;
    e.preventDefault();
    setTab(tabs[next].key);
    tabRefs.current[next]?.focus();
  };

  return (
    <div className="rounded-md border border-line bg-surface p-5 sm:p-6 space-y-6">
      {providers.github && (
        <a href={githubSignInHref('#/account')} className={`${secondaryButton} w-full`}>
          <Github className="size-4" aria-hidden="true" />
          Continue with GitHub
        </a>
      )}

      {providers.email && (
        <>
          {providers.github && (
            <p className="flex items-center gap-3 text-sm text-muted" aria-hidden="true">
              <span className="flex-1 border-t border-line" />
              or use your email
              <span className="flex-1 border-t border-line" />
            </p>
          )}
          <div role="tablist" aria-label="Email and password" className="flex border-b border-line">
            {tabs.map((t, i) => {
              const selected = tab === t.key;
              return (
                <button
                  key={t.key}
                  ref={el => {
                    tabRefs.current[i] = el;
                  }}
                  type="button"
                  role="tab"
                  id={`${id}-tab-${t.key}`}
                  aria-selected={selected}
                  aria-controls={`${id}-panel-${t.key}`}
                  tabIndex={selected ? 0 : -1}
                  onClick={() => setTab(t.key)}
                  onKeyDown={e => onKey(e, i)}
                  className={`min-h-10 px-3 -mb-px border-b-2 text-sm font-medium ${
                    selected ? 'border-accent text-accent' : 'border-transparent text-muted hover:text-text'
                  }`}
                >
                  {t.label}
                </button>
              );
            })}
          </div>
          <div role="tabpanel" id={`${id}-panel-${tab}`} aria-labelledby={`${id}-tab-${tab}`}>
            {tab === 'signin' ? <SignInForm emailSending={emailSending} /> : <CreateAccountForm emailSending={emailSending} />}
          </div>
        </>
      )}
    </div>
  );
};

type Errors = Partial<Record<ErrorField, string>>;

const SignInForm: React.FC<{ emailSending: boolean }> = ({ emailSending }) => {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [errors, setErrors] = useState<Errors>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const { formRef, errorRef, focusErrors } = useFocusFirstError();

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    const next: Errors = {};
    const emailErr = emailError(email);
    if (emailErr) next.email = emailErr;
    if (!password) next.password = 'Enter your password.';
    setErrors(next);
    setFormError(null);
    if (Object.keys(next).length) {
      focusErrors();
      return;
    }
    setBusy(true);
    const r = await login({ email: normalizeEmail(email), password });
    setBusy(false);
    // The password never outlives the request
    setPassword('');
    if (!r.ok) {
      setFormError(r.message);
      focusErrors();
    }
  };

  return (
    <form ref={formRef} onSubmit={submit} noValidate className="space-y-4 pt-4">
      <FormError ref={errorRef} message={formError} />
      <Field label="Email" type="email" autoComplete="email" inputMode="email" value={email} onChange={e => setEmail(e.target.value)} error={errors.email} />
      <PasswordField label="Password" value={password} onChange={setPassword} autoComplete="current-password" error={errors.password} />
      <div className="flex flex-wrap items-center justify-between gap-3">
        <button type="submit" disabled={busy} className={primaryButton}>
          {busy ? 'Signing in…' : 'Sign in'}
        </button>
        {emailSending && (
          <a href={accountHref('forgot')} className={`${textLink} text-sm`}>
            Forgot password?
          </a>
        )}
      </div>
      {!emailSending && (
        <p className="text-sm text-muted">
          This site can’t send email yet, so a forgotten password can’t be reset for now. Keep your password somewhere safe.
        </p>
      )}
    </form>
  );
};

const CreateAccountForm: React.FC<{ emailSending: boolean }> = ({ emailSending }) => {
  const [displayName, setDisplayName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [age, setAge] = useState(false);
  const [errors, setErrors] = useState<Errors>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const { formRef, errorRef, focusErrors } = useFocusFirstError();
  const id = useId();

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    const next: Errors = {};
    const nameErr = displayNameError(displayName);
    if (nameErr) next.displayName = nameErr;
    const emailErr = emailError(email);
    if (emailErr) next.email = emailErr;
    const pwErr = newPasswordError(password);
    if (pwErr) next.password = pwErr;
    if (!age) next.age = 'Confirm that you are 13 or older to create an account.';
    setErrors(next);
    setFormError(null);
    if (Object.keys(next).length) {
      focusErrors();
      return;
    }
    setBusy(true);
    const r = await register({ email: normalizeEmail(email), password, displayName: displayName.trim(), ageConfirmed: true });
    setBusy(false);
    setPassword('');
    if (!r.ok) {
      if (r.field) setErrors({ [r.field]: r.message });
      else setFormError(r.message);
      focusErrors();
    }
  };

  return (
    <form ref={formRef} onSubmit={submit} noValidate className="space-y-4 pt-4">
      <FormError ref={errorRef} message={formError} />
      <Field
        label="Display name"
        hint="Shown only to you, on your account pages."
        autoComplete="name"
        maxLength={50}
        value={displayName}
        onChange={e => setDisplayName(e.target.value)}
        error={errors.displayName}
      />
      <Field
        label="Email"
        type="email"
        autoComplete="email"
        inputMode="email"
        value={email}
        onChange={e => setEmail(e.target.value)}
        error={errors.email}
        hint={emailSending ? 'We send a link to confirm it. No newsletters.' : 'Used to sign in. No newsletters.'}
      />
      <PasswordField label="Password" value={password} onChange={setPassword} autoComplete="new-password" error={errors.password} showLengthHint />
      <div className="space-y-1.5">
        <label className="flex items-start gap-3 min-h-10 py-1 cursor-pointer text-[15px] text-text">
          <input
            type="checkbox"
            checked={age}
            onChange={e => setAge(e.target.checked)}
            aria-invalid={errors.age ? true : undefined}
            aria-describedby={errors.age ? `${id}-age-error` : undefined}
            className="mt-1 size-4 shrink-0 accent-accent"
          />
          I am 13 or older
        </label>
        {errors.age && (
          <p id={`${id}-age-error`} className="text-sm text-danger">
            {errors.age}
          </p>
        )}
      </div>
      <button type="submit" disabled={busy} className={primaryButton}>
        {busy ? 'Creating your account…' : 'Create account'}
      </button>
    </form>
  );
};

/** What an account stores, in plain words. */
export const PrivacyNote: React.FC = () => (
  <section aria-labelledby="privacy-heading" className="space-y-2 text-sm text-muted max-w-prose">
    <h2 id="privacy-heading" className="text-base font-semibold text-text">
      About accounts and your data
    </h2>
    <p>
      You don’t need an account. Everything in the app works without one, and your progress is saved in this browser.
    </p>
    <p>
      An account stores your display name, your email, a scrambled form of your password (never the password itself) and
      the sign-in methods you use. Never what you type in a terminal. Syncing your progress to the account comes next.
    </p>
    <p>It is never sold or shared for advertising. Accounts are for people 13 or older.</p>
  </section>
);
