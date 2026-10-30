import React, { useId, useState } from 'react';
import { BannerLine, HOSTNAME, PromptStyle } from '../../lib/activity';
import { useGameLayer } from '../celebrate/GameLayer';

/** The Sandbox's Linux machine: its default name and the learner's user name */
export const SANDBOX_HOST = 'sandbox-linux';
export const SANDBOX_USER = 'student';

/** The extra login banner lines a learner can pick once they finish a path */
export const BANNER_TEXT: Record<BannerLine, string> = {
  none: '',
  calm: 'Nothing on this machine can break. Try anything.',
  tip: 'Tip: man followed by a command name opens its manual. Press q to close it.',
  loopback: 'There is no place like 127.0.0.1',
};

const BANNER_LABEL: Record<BannerLine, string> = {
  none: 'No extra line',
  calm: BANNER_TEXT.calm,
  tip: BANNER_TEXT.tip,
  loopback: BANNER_TEXT.loopback,
};

/** What each prompt format looks like, for the radio labels */
export function promptPreview(style: PromptStyle, user: string, host: string): string {
  switch (style) {
    case 'bracket':
      return `[${user}@${host} ~]$`;
    case 'short':
      return '~ $';
    case 'host-first':
      return `${host}:~ ${user}$`;
    default:
      return `${user}@${host}:~$`;
  }
}

const PROMPTS: PromptStyle[] = ['standard', 'bracket', 'short', 'host-first'];
const BANNERS: BannerLine[] = ['none', 'calm', 'tip', 'loopback'];

const buttonClass =
  'inline-flex items-center min-h-10 sm:min-h-9 px-3 rounded-md border border-line-strong bg-surface text-sm font-medium text-text hover:bg-surface-2';

/**
 * "Your machine" in the Sandbox: cosmetic choices earned along the way. Only looks are earned;
 * the theme and anything that affects reading stay open to everyone, always.
 */
export const SandboxLook: React.FC<{ defaultHost: string; user: string; host: string }> = ({ defaultHost, user, host }) => {
  const { prefs, setPrefs, unlocks } = useGameLayer();
  const id = useId();
  const [draft, setDraft] = useState(prefs.sandboxHost || '');
  const [error, setError] = useState<string | null>(null);

  const saveHost = (e: React.FormEvent) => {
    e.preventDefault();
    const name = draft.trim().toLowerCase();
    if (name && !HOSTNAME.test(name)) {
      setError('Use lower-case letters, digits and hyphens, up to 24 characters, starting and ending with a letter or digit.');
      return;
    }
    setError(null);
    setDraft(name);
    setPrefs({ sandboxHost: name });
  };

  return (
    <div className="space-y-6">
      <p className="text-sm text-muted">
        Small touches for this practice machine, earned as you go. They only change how it looks. The theme and the text
        size are always yours to change in Settings.
      </p>

      <section aria-labelledby={`${id}-host`} className="space-y-2">
        <h3 id={`${id}-host`} className="text-sm font-semibold text-text">
          Machine name
        </h3>
        {unlocks.hostname ? (
          <form onSubmit={saveHost} className="space-y-2" noValidate>
            <label htmlFor={`${id}-host-input`} className="block text-sm text-muted">
              Shown in the prompt and by <code className="font-mono">hostname</code>. Leave it empty for{' '}
              <code className="font-mono">{defaultHost}</code>.
            </label>
            <div className="flex flex-wrap gap-2">
              <input
                id={`${id}-host-input`}
                value={draft}
                onChange={e => setDraft(e.target.value)}
                maxLength={24}
                autoComplete="off"
                spellCheck={false}
                aria-invalid={!!error}
                aria-describedby={error ? `${id}-host-error` : undefined}
                className="min-h-10 sm:min-h-9 w-48 rounded-md border border-line-strong bg-surface px-2 font-mono text-sm text-text"
              />
              <button type="submit" className={buttonClass}>
                Save name
              </button>
            </div>
            {error && (
              <p id={`${id}-host-error`} className="text-sm text-danger">
                {error}
              </p>
            )}
          </form>
        ) : (
          <p className="text-sm text-muted">Finish your first lab to choose this machine’s name.</p>
        )}
      </section>

      <fieldset className="space-y-2">
        <legend className="text-sm font-semibold text-text">Prompt format</legend>
        {unlocks.prompt ? (
          <div className="space-y-1">
            {PROMPTS.map(p => (
              <label key={p} className="flex items-center gap-3 min-h-10 py-1 cursor-pointer">
                <input
                  type="radio"
                  name={`${id}-prompt`}
                  checked={prefs.promptStyle === p}
                  onChange={() => setPrefs({ promptStyle: p })}
                  className="size-4 shrink-0 accent-accent"
                />
                <code className="font-mono text-sm">{promptPreview(p, user, host)}</code>
              </label>
            ))}
            <p className="text-sm text-muted">Used by bash. On a real machine you would set this with the PS1 variable.</p>
          </div>
        ) : (
          <p className="text-sm text-muted">Finish a stage of any path to choose a prompt format.</p>
        )}
      </fieldset>

      <fieldset className="space-y-2">
        <legend className="text-sm font-semibold text-text">Login banner line</legend>
        {unlocks.banner ? (
          <div className="space-y-1">
            {BANNERS.map(b => (
              <label key={b} className="flex items-start gap-3 min-h-10 py-1 cursor-pointer">
                <input
                  type="radio"
                  name={`${id}-banner`}
                  checked={prefs.bannerLine === b}
                  onChange={() => setPrefs({ bannerLine: b })}
                  className="mt-0.5 size-4 shrink-0 accent-accent"
                />
                <span className="text-sm">{BANNER_LABEL[b]}</span>
              </label>
            ))}
            <p className="text-sm text-muted">Shown under the welcome line when the terminal starts or is reset.</p>
          </div>
        ) : (
          <p className="text-sm text-muted">Finish a whole path to add a line to the login banner.</p>
        )}
      </fieldset>
    </div>
  );
};
