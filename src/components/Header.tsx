import React from 'react';
import { BookOpen, GraduationCap, Layers, Monitor, Moon, SquareTerminal, Sun, Terminal } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { Section } from '../lib/router';
import { ThemeChoice } from '../lib/theme';

/** Desktop navigation, one row. */
export const NAV_ITEMS: { section: Section; label: string }[] = [
  { section: 'learn', label: 'Learn' },
  { section: 'linux', label: 'Linux labs' },
  { section: 'windows', label: 'Windows labs' },
  { section: 'simulators', label: 'Simulators' },
  { section: 'sandbox', label: 'Sandbox' },
  { section: 'reference', label: 'Reference' },
];

/**
 * Phones have room for five items at 44px+, so the two lab catalogs share one "Labs" item
 * (it opens the track you used last; the catalog has a Linux/Windows switch at the top).
 */
type PhoneNavKey = 'learn' | 'labs' | 'simulators' | 'sandbox' | 'reference';
const PHONE_NAV_ITEMS: { key: PhoneNavKey; label: string; icon: LucideIcon }[] = [
  { key: 'learn', label: 'Learn', icon: GraduationCap },
  { key: 'labs', label: 'Labs', icon: SquareTerminal },
  { key: 'simulators', label: 'Simulators', icon: Layers },
  { key: 'sandbox', label: 'Sandbox', icon: Terminal },
  { key: 'reference', label: 'Reference', icon: BookOpen },
];
const phoneKey = (section: Section): PhoneNavKey => (section === 'linux' || section === 'windows' ? 'labs' : section);

const THEME_OPTIONS: { value: ThemeChoice; label: string; icon: LucideIcon }[] = [
  { value: 'system', label: 'Match system theme', icon: Monitor },
  { value: 'light', label: 'Light theme', icon: Sun },
  { value: 'dark', label: 'Dark theme', icon: Moon },
];

interface HeaderProps {
  current: Section;
  hrefs: Record<Section, string>;
  tasksDone: number;
  tasksTotal: number;
  theme: ThemeChoice;
  onThemeChange: (theme: ThemeChoice) => void;
}

export const Header: React.FC<HeaderProps> = ({ current, hrefs, tasksDone, tasksTotal, theme, onThemeChange }) => {
  return (
    <header className="shrink-0 bg-surface border-b border-line">
      <div className="flex items-center gap-4 lg:gap-8 h-14 px-4 lg:px-6">
        <a
          href="#/learn"
          className="shrink-0 text-base font-semibold text-text whitespace-nowrap rounded-sm"
        >
          Terminus CertSim
        </a>

        <nav aria-label="Main" className="hidden md:flex self-stretch items-stretch gap-1 min-w-0">
          {NAV_ITEMS.map(item => {
            const active = item.section === current;
            return (
              <a
                key={item.section}
                href={hrefs[item.section]}
                aria-current={active ? 'page' : undefined}
                className={`flex items-center px-2.5 lg:px-3 text-sm font-medium whitespace-nowrap border-b-2 -mb-px transition-colors ${
                  active
                    ? 'text-accent border-accent'
                    : 'text-muted border-transparent hover:text-text'
                }`}
              >
                {item.label}
              </a>
            );
          })}
        </nav>

        <div className="ml-auto flex items-center gap-3 lg:gap-4 shrink-0">
          {/* Hidden only at tablet widths, where the top nav needs the room; phones use the bottom nav */}
          <p className="md:hidden lg:block text-sm text-muted whitespace-nowrap tabular-nums">
            {tasksDone} of {tasksTotal}
            <span className="hidden xl:inline"> lab tasks</span> done
          </p>
          <ThemeSwitch theme={theme} onChange={onThemeChange} />
          <ThemeCycleButton theme={theme} onChange={onThemeChange} />
        </div>
      </div>
    </header>
  );
};

const ThemeSwitch: React.FC<{ theme: ThemeChoice; onChange: (t: ThemeChoice) => void }> = ({ theme, onChange }) => (
  <div role="radiogroup" aria-label="Color theme" className="hidden md:flex items-center rounded-md border border-line p-0.5">
    {THEME_OPTIONS.map(({ value, label, icon: Icon }) => {
      const selected = theme === value;
      return (
        <button
          key={value}
          type="button"
          role="radio"
          aria-checked={selected}
          aria-label={label}
          title={label}
          onClick={() => onChange(value)}
          className={`flex items-center justify-center w-7 h-7 rounded-sm transition-colors ${
            selected ? 'bg-accent-soft text-accent' : 'text-muted hover:text-text'
          }`}
        >
          <Icon className="w-4 h-4" aria-hidden="true" />
        </button>
      );
    })}
  </div>
);

/** Phones: one 40px button that steps through System, Light and Dark. */
const ThemeCycleButton: React.FC<{ theme: ThemeChoice; onChange: (t: ThemeChoice) => void }> = ({ theme, onChange }) => {
  const index = THEME_OPTIONS.findIndex(o => o.value === theme);
  const current = THEME_OPTIONS[index] ?? THEME_OPTIONS[0];
  const next = THEME_OPTIONS[(index + 1) % THEME_OPTIONS.length];
  const Icon = current.icon;
  return (
    <button
      type="button"
      onClick={() => onChange(next.value)}
      aria-label={`${current.label}. Switch to ${next.label.toLowerCase()}`}
      className="md:hidden flex items-center justify-center w-10 h-10 -mr-2 rounded-md text-muted hover:text-text hover:bg-surface-2"
    >
      <Icon className="w-5 h-5" aria-hidden="true" />
    </button>
  );
};

/** Phone-only navigation pinned to the bottom of the screen. */
export const BottomNav: React.FC<{ current: Section; hrefs: Record<Section, string>; labsHref: string }> = ({
  current,
  hrefs,
  labsHref,
}) => (
  <nav
    aria-label="Main"
    className="md:hidden shrink-0 bg-surface border-t border-line"
    style={{ paddingBottom: 'env(safe-area-inset-bottom)' }}
  >
    <ul className="grid grid-cols-5">
      {PHONE_NAV_ITEMS.map(({ key, label, icon: Icon }) => {
        const active = key === phoneKey(current);
        return (
          <li key={key}>
            <a
              href={key === 'labs' ? labsHref : hrefs[key]}
              aria-current={active ? 'page' : undefined}
              className={`flex flex-col items-center justify-center gap-0.5 min-h-[52px] px-1 text-xs font-medium border-t-2 -mt-px transition-colors ${
                active ? 'text-accent border-accent' : 'text-muted border-transparent hover:text-text'
              }`}
            >
              <Icon className="w-5 h-5" aria-hidden="true" />
              <span>{label}</span>
            </a>
          </li>
        );
      })}
    </ul>
  </nav>
);
