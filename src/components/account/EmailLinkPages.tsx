import React, { useEffect, useRef, useState } from 'react';
import { clearHashQuery, forgotPassword, readHashToken, resetPassword, verifyEmail } from '../../lib/account';
import { accountHref } from '../../lib/router';
import { Field, FormError, FormNote, PasswordField, primaryButton, textLink, useFocusFirstError } from './forms';
import { emailError, newPasswordError } from './messages';

const FORGOT_SENT = 'If an account uses that email, we sent a reset link.';

/** #/account/forgot: always the same answer, so it never tells whether an email has an account. */
export const ForgotPage: React.FC<{ emailSending: boolean }> = ({ emailSending }) => {
  const [email, setEmail] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState(false);
  const [busy, setBusy] = useState(false);
  const { formRef, errorRef, focusErrors } = useFocusFirstError();

  if (!emailSending) {
    return (
      <div className="space-y-4 max-w-prose">
        <p className="text-[15px]">
          Email links aren’t set up on this site yet, so password reset isn’t available. If you linked Google or GitHub,
          you can still sign in with that.
        </p>
        <a href={accountHref()} className={textLink}>
          Back to sign in
        </a>
      </div>
    );
  }

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    const err = emailError(email);
    setError(err);
    if (err) {
      focusErrors();
      return;
    }
    setBusy(true);
    const r = await forgotPassword(email.trim());
    setBusy(false);
    if (!r.ok && r.code === 'network') {
      setError(r.message);
      focusErrors();
      return;
    }
    // Any other answer, even "too many tries", gets the same message
    setEmail('');
    setSent(true);
  };

  return (
    <form ref={formRef} onSubmit={submit} noValidate className="space-y-4 max-w-md">
      <p className="text-[15px] text-muted">Enter the email you signed up with. We send a link to choose a new password.</p>
      <Field
        label="Email"
        type="email"
        autoComplete="email"
        inputMode="email"
        value={email}
        onChange={e => {
          setEmail(e.target.value);
          setSent(false);
        }}
        error={error}
      />
      <button type="submit" disabled={busy} className={primaryButton}>
        {busy ? 'Sending…' : 'Send reset link'}
      </button>
      <FormNote message={sent ? `${FORGOT_SENT} It works for 1 hour.` : null} />
      <p className="text-sm">
        <a href={accountHref()} className={textLink}>
          Back to sign in
        </a>
      </p>
    </form>
  );
};

/** Reads the one-time token on first render and takes it out of the URL. */
function useHashToken(): string | null {
  const [token] = useState(() => readHashToken());
  useEffect(() => clearHashQuery(), []);
  return token;
}

/** #/account/reset?token=…: choose a new password. */
export const ResetPage: React.FC = () => {
  const token = useHashToken();
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const [busy, setBusy] = useState(false);
  const { formRef, errorRef, focusErrors } = useFocusFirstError();

  if (!token) {
    return (
      <div className="space-y-4 max-w-prose">
        <p className="text-[15px]">This reset link is missing its code. Open the link from the email again, or ask for a new one.</p>
        <a href={accountHref('forgot')} className={textLink}>
          Ask for a new reset link
        </a>
      </div>
    );
  }

  if (done) {
    return (
      <div className="space-y-4 max-w-prose">
        <FormNote message="Your new password is set and you are signed in. Other devices were signed out." />
        <a href={accountHref()} className={textLink}>
          Go to your account
        </a>
      </div>
    );
  }

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    const err = newPasswordError(password);
    setError(err);
    setFormError(null);
    if (err) {
      focusErrors();
      return;
    }
    setBusy(true);
    const r = await resetPassword(token, password);
    setBusy(false);
    setPassword('');
    if (!r.ok) {
      if (r.field === 'password') setError(r.message);
      else setFormError(r.message);
      focusErrors();
      return;
    }
    setDone(true);
  };

  return (
    <form ref={formRef} onSubmit={submit} noValidate className="space-y-4 max-w-md">
      <FormError ref={errorRef} message={formError} />
      <PasswordField label="New password" value={password} onChange={setPassword} autoComplete="new-password" error={error} showLengthHint />
      <button type="submit" disabled={busy} className={primaryButton}>
        {busy ? 'Saving…' : 'Set new password'}
      </button>
      {formError && (
        <p className="text-sm">
          <a href={accountHref('forgot')} className={textLink}>
            Ask for a new reset link
          </a>
        </p>
      )}
    </form>
  );
};

/** #/account/verify?token=…: confirms the email as soon as the page opens. */
export const VerifyPage: React.FC = () => {
  const token = useHashToken();
  const [state, setState] = useState<{ kind: 'working' } | { kind: 'done' } | { kind: 'failed'; message: string }>(
    token ? { kind: 'working' } : { kind: 'failed', message: 'This link is missing its code. Open the link from the email again.' },
  );
  const sent = useRef(false);

  useEffect(() => {
    if (!token || sent.current) return;
    sent.current = true;
    void verifyEmail(token).then(r => setState(r.ok ? { kind: 'done' } : { kind: 'failed', message: r.message }));
  }, [token]);

  return (
    <div className="space-y-4 max-w-prose" aria-live="polite">
      {state.kind === 'working' && <p className="text-[15px]">Confirming your email…</p>}
      {state.kind === 'done' && <FormNote message="Your email is confirmed. Thank you." />}
      {state.kind === 'failed' && (
        <p role="alert" className="rounded-md bg-danger-soft px-3 py-2 text-sm text-danger">
          {state.message}
        </p>
      )}
      {state.kind !== 'working' && (
        <p className="text-sm">
          <a href={accountHref()} className={textLink}>
            Go to your account
          </a>
          {state.kind === 'failed' && <span className="text-muted"> to send a new link.</span>}
        </p>
      )}
    </div>
  );
};
