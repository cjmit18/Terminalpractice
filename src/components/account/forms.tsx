import React, { useEffect, useId, useRef, useState } from 'react';
import { Eye, EyeOff } from 'lucide-react';
import { passwordLengthHint } from './messages';

export const primaryButton =
  'inline-flex items-center justify-center gap-2 min-h-10 px-4 rounded-md bg-accent text-accent-fg text-sm font-medium hover:opacity-90 disabled:opacity-60 disabled:cursor-not-allowed';
export const secondaryButton =
  'inline-flex items-center justify-center gap-2 min-h-10 px-4 rounded-md border border-line-strong bg-surface text-sm font-medium text-text hover:bg-surface-2 disabled:opacity-60 disabled:cursor-not-allowed';
export const dangerButton =
  'inline-flex items-center justify-center gap-2 min-h-10 px-4 rounded-md border border-danger bg-surface text-sm font-medium text-danger hover:bg-danger-soft disabled:opacity-60 disabled:cursor-not-allowed';
export const textLink = 'text-accent underline-offset-2 hover:underline rounded-sm';
const inputClass =
  'block w-full min-h-10 rounded-md border border-line-strong bg-surface px-3 text-[15px] text-text aria-[invalid=true]:border-danger';

const describedBy = (...ids: (string | false | undefined)[]) => ids.filter(Boolean).join(' ') || undefined;

interface FieldProps extends Omit<React.InputHTMLAttributes<HTMLInputElement>, 'id'> {
  label: string;
  hint?: React.ReactNode;
  error?: string | null;
}

/** A labelled input with its hint and error tied to it by aria-describedby. */
export const Field: React.FC<FieldProps> = ({ label, hint, error, className, ...input }) => {
  const id = useId();
  return (
    <div className={`space-y-1.5 ${className ?? ''}`}>
      <label htmlFor={id} className="block text-sm font-medium text-text">
        {label}
      </label>
      <input
        id={id}
        aria-invalid={error ? true : undefined}
        aria-describedby={describedBy(hint !== undefined && `${id}-hint`, !!error && `${id}-error`)}
        className={inputClass}
        {...input}
      />
      {hint !== undefined && (
        <p id={`${id}-hint`} className="text-sm text-muted">
          {hint}
        </p>
      )}
      {error && (
        <p id={`${id}-error`} className="text-sm text-danger">
          {error}
        </p>
      )}
    </div>
  );
};

interface PasswordFieldProps {
  label: string;
  value: string;
  onChange: (v: string) => void;
  autoComplete: 'current-password' | 'new-password';
  error?: string | null;
  /** New passwords show a live length hint */
  showLengthHint?: boolean;
  name?: string;
}

/** Password input with a show/hide toggle. The value lives only in the form's state. */
export const PasswordField: React.FC<PasswordFieldProps> = ({ label, value, onChange, autoComplete, error, showLengthHint, name }) => {
  const id = useId();
  const [visible, setVisible] = useState(false);
  return (
    <div className="space-y-1.5">
      <label htmlFor={id} className="block text-sm font-medium text-text">
        {label}
      </label>
      <div className="flex gap-2">
        <input
          id={id}
          name={name}
          type={visible ? 'text' : 'password'}
          value={value}
          onChange={e => onChange(e.target.value)}
          autoComplete={autoComplete}
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
          maxLength={256}
          aria-invalid={error ? true : undefined}
          aria-describedby={describedBy(showLengthHint && `${id}-hint`, !!error && `${id}-error`)}
          className={`${inputClass} flex-1 min-w-0`}
        />
        <button
          type="button"
          onClick={() => setVisible(v => !v)}
          aria-pressed={visible}
          aria-controls={id}
          aria-label={visible ? `Hide ${label.toLowerCase()}` : `Show ${label.toLowerCase()}`}
          className="inline-flex items-center justify-center gap-1.5 min-h-10 px-3 rounded-md border border-line-strong bg-surface text-sm font-medium text-text hover:bg-surface-2 shrink-0"
        >
          {visible ? <EyeOff className="size-4" aria-hidden="true" /> : <Eye className="size-4" aria-hidden="true" />}
          <span aria-hidden="true" className="hidden sm:inline">
            {visible ? 'Hide' : 'Show'}
          </span>
        </button>
      </div>
      {showLengthHint && (
        <p id={`${id}-hint`} className="text-sm text-muted" data-testid="password-hint">
          {passwordLengthHint(value)}
        </p>
      )}
      {error && (
        <p id={`${id}-error`} className="text-sm text-danger">
          {error}
        </p>
      )}
    </div>
  );
};

/** A form-wide error (from the server). Focusable so focus can move to it. */
export const FormError = React.forwardRef<HTMLParagraphElement, { message: string | null }>(({ message }, ref) =>
  message ? (
    <p ref={ref} tabIndex={-1} role="alert" className="rounded-md bg-danger-soft px-3 py-2 text-sm text-danger focus:outline-none">
      {message}
    </p>
  ) : null,
);
FormError.displayName = 'FormError';

/** A plain success note, announced politely. */
export const FormNote: React.FC<{ message: string | null }> = ({ message }) => (
  <p role="status" className={message ? 'rounded-md bg-ok-soft px-3 py-2 text-sm text-ok' : 'sr-only'}>
    {message ?? ''}
  </p>
);

/**
 * After a failed submit, move focus to the first invalid field, or to the form's error message.
 * Call `focusErrors()` after setting the errors; it runs once React has rendered them.
 */
export function useFocusFirstError() {
  const formRef = useRef<HTMLFormElement>(null);
  const errorRef = useRef<HTMLParagraphElement>(null);
  const [tick, setTick] = useState(0);
  useEffect(() => {
    if (tick === 0) return;
    const field = formRef.current?.querySelector<HTMLElement>('[aria-invalid="true"]');
    (field ?? errorRef.current)?.focus();
  }, [tick]);
  return { formRef, errorRef, focusErrors: () => setTick(t => t + 1) };
}
