import React, { useEffect, useRef, useState } from 'react';
import { Check, Link as LinkIcon } from 'lucide-react';
import { badgeHref } from '../../lib/router';

/** Copies text to the clipboard; false when the browser does not allow it. */
export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

/** The address of a badge's page, for sharing */
export function badgeUrl(badgeId: string): string {
  const { origin, pathname } = window.location;
  return `${origin}${pathname}${badgeHref(badgeId)}`;
}

/** "Copy link" for a badge's page. The link names the badge only. */
export const CopyLinkButton: React.FC<{ badgeId: string; className?: string; label?: string }> = ({
  badgeId,
  className = '',
  label = 'Copy link to this badge',
}) => {
  const [state, setState] = useState<'idle' | 'copied' | 'failed'>('idle');
  const timer = useRef<number | null>(null);
  useEffect(() => () => {
    if (timer.current !== null) window.clearTimeout(timer.current);
  }, []);

  const copy = async () => {
    const ok = await copyText(badgeUrl(badgeId));
    setState(ok ? 'copied' : 'failed');
    if (timer.current !== null) window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setState('idle'), 2500);
  };

  return (
    <span className={`inline-flex flex-wrap items-center gap-x-3 gap-y-1 ${className}`}>
      <button
        type="button"
        onClick={copy}
        className="inline-flex items-center gap-1.5 min-h-10 sm:min-h-9 px-3 rounded-md border border-line-strong bg-surface text-sm font-medium text-text hover:bg-surface-2"
      >
        {state === 'copied' ? <Check className="size-4 text-ok" aria-hidden="true" /> : <LinkIcon className="size-4" aria-hidden="true" />}
        {label}
      </button>
      <span role="status" className="text-sm text-muted">
        {state === 'copied' ? 'Link copied.' : state === 'failed' ? 'Your browser did not allow copying.' : ''}
      </span>
    </span>
  );
};
