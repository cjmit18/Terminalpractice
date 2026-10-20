import React, { useEffect, useRef, useState } from 'react';
import { Check, CheckCircle2, Copy, X } from 'lucide-react';

/*
 * Small building blocks shared by the simulators and the command reference.
 * Everything here uses the design tokens from src/index.css (see docs/DESIGN.md).
 */

export const cx = (...parts: (string | false | null | undefined)[]) => parts.filter(Boolean).join(' ');

/** Height rule for controls: 40px on phones, 32px from the sm breakpoint up. */
const controlHeight = 'min-h-10 sm:min-h-8';

type ButtonVariant = 'primary' | 'secondary' | 'quiet';

const buttonStyles: Record<ButtonVariant, string> = {
  primary: 'bg-accent text-accent-fg hover:opacity-90 px-3',
  secondary: 'border border-line-strong bg-surface text-text hover:bg-surface-2 px-3',
  quiet: 'text-accent hover:bg-surface-2 px-2',
};

export const Button: React.FC<
  React.ButtonHTMLAttributes<HTMLButtonElement> & { variant?: ButtonVariant }
> = ({ variant = 'secondary', className, type = 'button', ...rest }) => (
  <button
    type={type}
    className={cx(
      'inline-flex items-center justify-center gap-1.5 rounded-md text-sm font-medium whitespace-nowrap transition-colors',
      'disabled:cursor-not-allowed disabled:opacity-50',
      controlHeight,
      buttonStyles[variant],
      className,
    )}
    {...rest}
  />
);

/** The one bordered container a simulator gets. A container query root, so it adapts to the pane it sits in. */
export const SimPanel: React.FC<{ label: string; children: React.ReactNode; className?: string }> = ({
  label,
  children,
  className,
}) => (
  <section
    aria-label={label}
    className={cx(
      '@container flex h-full min-h-0 flex-col overflow-hidden rounded-md border border-line bg-surface text-[15px] text-text',
      className,
    )}
  >
    {children}
  </section>
);

/** Title row plus toolbar, like the menu strip of the real console. */
export const SimToolbar: React.FC<{
  title: string;
  context?: React.ReactNode;
  children?: React.ReactNode;
}> = ({ title, context, children }) => (
  <div className="flex shrink-0 flex-wrap items-center justify-between gap-x-4 gap-y-2 border-b border-line px-4 py-2.5">
    <div className="min-w-0">
      <h2 className="text-base font-semibold leading-tight">{title}</h2>
      {context && <div className="mt-0.5 text-sm text-muted">{context}</div>}
    </div>
    {children && <div className="flex flex-wrap items-center gap-2">{children}</div>}
  </div>
);

/** Status text with an icon. Color carries meaning, the word carries it too. */
export const StatusText: React.FC<{
  tone: 'ok' | 'warn' | 'danger' | 'muted';
  icon?: React.ComponentType<{ className?: string; 'aria-hidden'?: boolean }>;
  children: React.ReactNode;
  className?: string;
}> = ({ tone, icon: Icon, children, className }) => {
  const color = { ok: 'text-ok', warn: 'text-warn', danger: 'text-danger', muted: 'text-muted' }[tone];
  return (
    <span className={cx('inline-flex items-center gap-1.5 font-medium', color, className)}>
      {Icon && <Icon className="h-4 w-4 shrink-0" aria-hidden />}
      <span>{children}</span>
    </span>
  );
};

/** A confirmation line under the toolbar. Clears itself after a few seconds. */
export const useNotice = (timeoutMs = 4000) => {
  const [notice, setNotice] = useState<string | null>(null);
  useEffect(() => {
    if (!notice) return;
    const t = window.setTimeout(() => setNotice(null), timeoutMs);
    return () => window.clearTimeout(t);
  }, [notice, timeoutMs]);
  return [notice, setNotice] as const;
};

export const Notice: React.FC<{ message: string | null; onDismiss: () => void }> = ({ message, onDismiss }) => (
  <div role="status" aria-live="polite" className="shrink-0">
    {message && (
      <div className="flex items-center gap-2 border-b border-line bg-ok-soft px-4 py-1.5 text-sm text-text">
        <CheckCircle2 className="h-4 w-4 shrink-0 text-ok" aria-hidden />
        <span className="flex-1">{message}</span>
        <button
          type="button"
          onClick={onDismiss}
          aria-label="Dismiss message"
          className="inline-flex h-10 w-10 items-center justify-center rounded-md text-muted hover:bg-surface-2 hover:text-text sm:h-7 sm:w-7"
        >
          <X className="h-4 w-4" aria-hidden />
        </button>
      </div>
    )}
  </div>
);

/** Segmented control: one accent for the selected option. */
export function Segmented<T extends string>({
  label,
  value,
  options,
  onChange,
  className,
}: {
  label: string;
  value: T;
  options: { value: T; label: string }[];
  onChange: (v: T) => void;
  className?: string;
}) {
  return (
    <div role="radiogroup" aria-label={label} className={cx('inline-flex rounded-md border border-line bg-surface-2 p-0.5', className)}>
      {options.map(o => {
        const selected = o.value === value;
        return (
          <button
            key={o.value}
            type="button"
            role="radio"
            aria-checked={selected}
            onClick={() => onChange(o.value)}
            className={cx(
              'flex-1 rounded-[5px] px-3 text-sm font-medium transition-colors',
              controlHeight,
              selected ? 'bg-surface text-accent shadow-[0_0_0_1px_var(--line)]' : 'text-muted hover:text-text',
            )}
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );
}

/** Copies text and briefly says so. */
export const CopyButton: React.FC<{ text: string; label?: string; className?: string }> = ({
  text,
  label = 'Copy',
  className,
}) => {
  const [copied, setCopied] = useState(false);
  const timer = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(timer.current), []);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      // Clipboard can be unavailable (insecure context, denied permission). Nothing else to do.
      return;
    }
    setCopied(true);
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setCopied(false), 1800);
  };

  return (
    <button
      type="button"
      onClick={copy}
      aria-label={copied ? 'Copied' : `${label}: ${text}`}
      className={cx(
        'inline-flex shrink-0 items-center gap-1 rounded-md px-2 text-xs font-medium text-muted hover:bg-surface hover:text-text',
        controlHeight,
        className,
      )}
    >
      {copied ? <Check className="h-3.5 w-3.5 text-ok" aria-hidden /> : <Copy className="h-3.5 w-3.5" aria-hidden />}
      <span aria-hidden>{copied ? 'Copied' : 'Copy'}</span>
    </button>
  );
};

/** A command or output in mono with a copy button. */
export const CodeBlock: React.FC<{ code: string; className?: string }> = ({ code, className }) => (
  <div className={cx('flex items-start gap-2 rounded-md bg-surface-2 py-1 pl-3 pr-1', className)}>
    <pre className="min-w-0 flex-1 overflow-x-auto py-1.5 font-mono text-sm leading-relaxed whitespace-pre-wrap break-words">
      <code>{code}</code>
    </pre>
    <CopyButton text={code} />
  </div>
);

/** Shared input classes for forms in the simulators. */
export const inputClass =
  'rounded-md border border-line-strong bg-surface px-3 text-[15px] text-text placeholder:text-subtle min-h-10 sm:min-h-9';

/** Tiny table header style (the one place uppercase labels are allowed). */
export const thClass = 'px-3 py-2 text-left text-xs font-medium uppercase tracking-wide text-muted';

export interface TreeNode {
  id: string;
  label: string;
  depth: number;
  icon?: React.ComponentType<{ className?: string; 'aria-hidden'?: boolean }>;
  /** Items that can't be selected render as plain labels (folders that only group things). */
  selectable?: boolean;
}

/**
 * The left-hand console tree. In a narrow pane it turns into a labelled select,
 * because a tree squeezed to phone width is hard to use.
 */
export const ConsoleTree: React.FC<{
  id: string;
  label: string;
  nodes: TreeNode[];
  selectedId: string;
  onSelect: (id: string) => void;
}> = ({ id, label, nodes, selectedId, onSelect }) => {
  const selectable = nodes.filter(n => n.selectable !== false);
  return (
    <>
      <div className="shrink-0 border-b border-line px-4 py-3 @2xl:hidden">
        <label className="block text-xs font-medium text-muted" htmlFor={id}>
          {label}
        </label>
        <select id={id} value={selectedId} onChange={e => onSelect(e.target.value)} className={cx(inputClass, 'mt-1 w-full')}>
          {selectable.map(n => (
            <option key={n.id} value={n.id}>
              {n.label}
            </option>
          ))}
        </select>
      </div>
      <nav aria-label={label} className="hidden w-56 shrink-0 overflow-y-auto border-r border-line py-2 @2xl:block @4xl:w-64">
        <ul>
          {nodes.map(n => {
            const Icon = n.icon;
            const isSel = n.id === selectedId;
            const pad = { paddingLeft: `${0.75 + n.depth}rem` };
            const inner = (
              <>
                {Icon && <Icon className="h-4 w-4 shrink-0 text-muted" aria-hidden />}
                <span className="truncate">{n.label}</span>
              </>
            );
            return (
              <li key={n.id}>
                {n.selectable === false ? (
                  <div style={pad} className="flex min-h-8 items-center gap-2 pr-3 text-sm text-muted">
                    {inner}
                  </div>
                ) : (
                  <button
                    type="button"
                    style={pad}
                    onClick={() => onSelect(n.id)}
                    aria-current={isSel ? 'true' : undefined}
                    className={cx(
                      'flex min-h-8 w-full items-center gap-2 pr-3 text-left text-sm transition-colors',
                      isSel ? 'bg-accent-soft font-medium text-text' : 'text-text hover:bg-surface-2',
                    )}
                  >
                    {inner}
                  </button>
                )}
              </li>
            );
          })}
        </ul>
      </nav>
    </>
  );
};
