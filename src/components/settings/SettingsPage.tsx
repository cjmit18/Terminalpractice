import React, { useEffect, useId } from 'react';
import type { SandboxShell, TermFontSize } from '../../lib/activity';
import type { ThemeChoice } from '../../lib/theme';
import { useGameLayer } from '../celebrate/GameLayer';
import { GameSettings, RadioGroup } from './GameSettings';
import { SandboxLook } from './SandboxLook';

/** The Sandbox's Linux machine, as SandboxMode names it */
const SANDBOX_DEFAULT_HOST = 'sandbox-linux';
const SANDBOX_USER = 'student';

/** Terminal text sizes; medium keeps the built-in size (13px on phones, 14px wider) */
const TERM_FONT_PX: Record<Exclude<TermFontSize, 'm'>, string> = { s: '12px', l: '16px' };

/** Applies the terminal text size as the --term-font-size CSS variable on <html>. Call once, high up. */
export function useApplyTerminalFontSize(): void {
  const { prefs } = useGameLayer();
  const size = prefs.termFontSize;
  useEffect(() => {
    const root = document.documentElement.style;
    if (size === 'm') root.removeProperty('--term-font-size');
    else root.setProperty('--term-font-size', TERM_FONT_PX[size]);
  }, [size]);
}

/**
 * #/account/settings: every preference in one place. It works the same signed in or out; the
 * settings are saved with the rest of the activity record in this browser.
 */
export const SettingsPage: React.FC<{ theme: ThemeChoice; onThemeChange: (t: ThemeChoice) => void }> = ({ theme, onThemeChange }) => {
  const { prefs, setPrefs, unlocks } = useGameLayer();
  const id = useId();
  const host = (unlocks.hostname && prefs.sandboxHost) || SANDBOX_DEFAULT_HOST;

  return (
    <div className="space-y-12 max-w-prose">
      <section aria-labelledby={`${id}-look`} className="space-y-5">
        <h2 id={`${id}-look`} className="text-base font-semibold text-text">
          Appearance
        </h2>
        <RadioGroup<ThemeChoice>
          legend="Theme"
          name={`${id}-theme`}
          value={theme}
          options={[
            { value: 'system', label: 'Match system', detail: 'Light or dark, following your device.' },
            { value: 'light', label: 'Light' },
            { value: 'dark', label: 'Dark', detail: 'The terminal is dark in both.' },
          ]}
          onChange={onThemeChange}
        />
        <RadioGroup<TermFontSize>
          legend="Terminal text size"
          name={`${id}-font`}
          value={prefs.termFontSize}
          options={[
            { value: 's', label: 'Small' },
            { value: 'm', label: 'Medium', detail: 'The default.' },
            { value: 'l', label: 'Large' },
          ]}
          onChange={v => setPrefs({ termFontSize: v })}
        />
      </section>

      <section aria-labelledby={`${id}-sandbox`} className="space-y-5">
        <h2 id={`${id}-sandbox`} className="text-base font-semibold text-text">
          Sandbox
        </h2>
        <RadioGroup<SandboxShell>
          legend="Shell the Sandbox opens with"
          name={`${id}-shell`}
          value={prefs.defaultShell}
          options={[
            { value: 'bash', label: 'bash', detail: 'A Linux machine.' },
            { value: 'cmd', label: 'Command Prompt', detail: 'Windows, cmd.exe.' },
            { value: 'powershell', label: 'PowerShell', detail: 'Windows, PowerShell.' },
          ]}
          onChange={v => setPrefs({ defaultShell: v })}
        />
        <div className="space-y-3">
          <h3 className="text-sm font-semibold text-text">Your machine</h3>
          <SandboxLook defaultHost={SANDBOX_DEFAULT_HOST} user={SANDBOX_USER} host={host} />
        </div>
      </section>

      <GameSettings />
    </div>
  );
};
