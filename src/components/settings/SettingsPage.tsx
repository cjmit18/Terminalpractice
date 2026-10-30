import React, { useId } from 'react';
import { Monitor, Moon, Sun } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import type { ThemeChoice } from '../../lib/theme';
import { TERMINAL_TEXT_SIZES, type TerminalText } from '../../lib/activity';
import { accountHref } from '../../lib/router';
import { useDisplayAccount } from '../../lib/viewAs';
import { useGameLayer } from '../celebrate/GameLayer';
import { syncStatusText, useSyncState } from '../account/syncAdapter';
import { BadgeSettings, ClearActivity, LearningSettings, RadioGroup } from './PrefsSettings';
import { SANDBOX_HOST, SANDBOX_USER, SandboxLook } from './SandboxLook';

const sectionClass = 'space-y-4 pt-8 border-t border-line first:pt-0 first:border-t-0';
const headingClass = 'text-base font-semibold text-text';
const linkClass = 'text-accent underline-offset-2 hover:underline rounded-sm';

const THEMES: { value: ThemeChoice; label: string; detail: string; icon: LucideIcon }[] = [
  { value: 'system', label: 'Match system', detail: 'Light or dark, following your device.', icon: Monitor },
  { value: 'light', label: 'Light', detail: 'Dark text on a light background.', icon: Sun },
  { value: 'dark', label: 'Dark', detail: 'Light text on a dark background.', icon: Moon },
];

const TEXT_LABEL: Record<TerminalText, string> = { small: 'Small', medium: 'Medium', large: 'Large' };
const TEXT_PREVIEW: Record<TerminalText, string> = { small: 'text-xs', medium: 'text-[13px] sm:text-sm', large: 'text-[15px] sm:text-base' };

interface SettingsPageProps {
  theme: ThemeChoice;
  onThemeChange: (theme: ThemeChoice) => void;
}

/**
 * #/settings: every setting in one place, so the header and the Learn page stay free of them.
 * Settings save in this browser and, with Auto save on, follow the account to other devices.
 */
export const SettingsPage: React.FC<SettingsPageProps> = ({ theme, onThemeChange }) => (
  <div className="max-w-3xl mx-auto w-full px-4 sm:px-6 py-8 sm:py-12 space-y-8">
    <header className="space-y-2">
      <h1 className="text-2xl font-semibold text-text">Settings</h1>
      <p className="text-[15px] text-muted max-w-prose">
        Changes apply right away. They are saved in this browser and, when you are signed in with Auto save on, in your
        account too.
      </p>
    </header>
    <div className="space-y-8 max-w-xl">
      <Section title="Appearance">
        <ThemeSetting theme={theme} onChange={onThemeChange} />
        <TerminalTextSetting />
      </Section>
      <Section title="Learning">
        <LearningSettings />
      </Section>
      <Section title="Badges and celebrations">
        <BadgeSettings />
      </Section>
      <Section title="Your Sandbox machine">
        <SandboxMachine />
      </Section>
      <Section title="Saving and your account">
        <Saving />
      </Section>
      <Section title="Your data">
        <ClearActivity />
      </Section>
    </div>
  </div>
);

const Section: React.FC<{ title: string; children: React.ReactNode }> = ({ title, children }) => {
  const id = useId();
  return (
    <section aria-labelledby={id} className={sectionClass}>
      <h2 id={id} className={headingClass}>
        {title}
      </h2>
      {children}
    </section>
  );
};

const ThemeSetting: React.FC<{ theme: ThemeChoice; onChange: (t: ThemeChoice) => void }> = ({ theme, onChange }) => {
  const id = useId();
  return (
    <fieldset className="space-y-2">
      <legend className="text-sm font-semibold text-text">Theme</legend>
      <div className="space-y-1">
        {THEMES.map(({ value, label, detail, icon: Icon }) => (
          <label key={value} className="flex items-start gap-3 min-h-10 py-1.5 cursor-pointer">
            <input
              type="radio"
              name={`${id}-theme`}
              value={value}
              checked={theme === value}
              onChange={() => onChange(value)}
              className="mt-1 size-4 shrink-0 accent-accent"
            />
            <Icon className="size-4 mt-0.5 shrink-0 text-muted" aria-hidden="true" />
            <span className="text-sm">
              <span className="font-medium text-text">{label}</span>
              <span className="block text-muted">{detail}</span>
            </span>
          </label>
        ))}
      </div>
    </fieldset>
  );
};

const TerminalTextSetting: React.FC = () => {
  const { prefs, setPrefs } = useGameLayer();
  const id = useId();
  return (
    <div className="space-y-3">
      <RadioGroup
        legend="Terminal text size"
        name={`${id}-text`}
        value={prefs.terminalText}
        options={TERMINAL_TEXT_SIZES.map(size => ({ value: size, label: TEXT_LABEL[size] }))}
        onChange={v => setPrefs({ terminalText: v })}
      />
      <p className="text-sm text-muted">For the labs, the Sandbox and the simulators. The rest of the page follows your browser’s zoom.</p>
      <pre
        aria-label="Preview"
        className={`overflow-x-auto rounded-md bg-term-bg border border-term-line px-3 py-2 font-mono text-term-text ${TEXT_PREVIEW[prefs.terminalText]}`}
      >
        {`${SANDBOX_USER}@${SANDBOX_HOST}:~$ ls -l notes.txt\n-rw-r--r-- 1 ${SANDBOX_USER} ${SANDBOX_USER} 42 Oct 30 09:15 notes.txt`}
      </pre>
    </div>
  );
};

const SandboxMachine: React.FC = () => {
  const { prefs, unlocks } = useGameLayer();
  const host = (unlocks.hostname && prefs.sandboxHost) || SANDBOX_HOST;
  return <SandboxLook defaultHost={SANDBOX_HOST} user={SANDBOX_USER} host={host} />;
};

const Saving: React.FC = () => {
  const { account } = useDisplayAccount();
  const sync = useSyncState();
  if (account.status === 'loading') return <p className="text-sm text-muted">Loading…</p>;
  if (account.status === 'unavailable') {
    return <p className="text-sm text-muted">Your progress and settings are saved in this browser.</p>;
  }
  if (account.status === 'signed-out') {
    return (
      <p className="text-sm text-muted">
        Your progress and settings are saved in this browser.{' '}
        <a href={accountHref()} className={linkClass}>
          Sign in or create an account
        </a>{' '}
        to save them to an account and use them on other devices.
      </p>
    );
  }
  const on = sync.status !== 'paused';
  return (
    <div className="space-y-3">
      <label className="flex items-start gap-3 min-h-10 py-1 cursor-pointer text-[15px] text-text">
        <input
          type="checkbox"
          checked={on}
          onChange={e => void sync.setAutoSave(e.target.checked)}
          className="mt-1 size-4 shrink-0 accent-accent"
        />
        <span>
          <span className="font-medium">Auto save</span>
          <span className="block text-sm text-muted">Saves your progress and settings to your account as you go.</span>
        </span>
      </label>
      <p role="status" className={`text-sm ${sync.status === 'error' || sync.status === 'offline' ? 'text-danger' : 'text-muted'}`}>
        {syncStatusText(sync)}
      </p>
      <ul className="space-y-1 text-sm">
        <li>
          <a href={accountHref()} className={linkClass}>
            Your account
          </a>
        </li>
        <li>
          <a href={accountHref('security')} className={linkClass}>
            Security and data: password, ways to sign in, sessions, download or delete your account
          </a>
        </li>
      </ul>
    </div>
  );
};
