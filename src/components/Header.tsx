import React from 'react';
import { BookOpen, GraduationCap, Layers, Settings, SquareTerminal, Terminal } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { SETTINGS_HREF, Section } from '../lib/router';
import { AccountMenu } from './AccountMenu';
import { useDisplayAccount } from '../lib/viewAs';
import { useSyncState } from './account/syncAdapter';

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

interface HeaderProps {
  /** The nav item to mark as the current page; null on pages outside the nav (Settings) */
  current: Section | null;
  hrefs: Record<Section, string>;
  tasksDone: number;
  tasksTotal: number;
  /** On #/settings, the Settings link is marked as the current page */
  onSettings: boolean;
}

export const Header: React.FC<HeaderProps> = ({ current, hrefs, tasksDone, tasksTotal, onSettings }) => {
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
          <SettingsLink current={onSettings} />
          <AccountMenu />
        </div>
      </div>
    </header>
  );
};

/**
 * The way to Settings (theme, text size, learning, badges, Auto save, your data). A red dot shows when
 * Auto save is on and the last sync did not finish, so a saving problem is still visible from every page.
 */
const SettingsLink: React.FC<{ current: boolean }> = ({ current }) => {
  const { account } = useDisplayAccount();
  const sync = useSyncState();
  const problem = account.status === 'signed-in' && (sync.status === 'offline' || sync.status === 'error');
  return (
    <a
      href={SETTINGS_HREF}
      aria-current={current ? 'page' : undefined}
      aria-label={problem ? 'Settings: saving to your account needs attention' : 'Settings'}
      title="Settings"
      className={`relative flex items-center justify-center w-10 h-10 md:w-9 md:h-9 rounded-md hover:bg-surface-2 ${
        current ? 'text-accent' : 'text-muted hover:text-text'
      }`}
    >
      <Settings className="size-5 md:size-[18px]" aria-hidden="true" />
      {problem && <span aria-hidden="true" className="absolute top-1.5 right-1.5 size-2 rounded-full bg-danger" />}
    </a>
  );
};

/** Phone-only navigation pinned to the bottom of the screen. */
export const BottomNav: React.FC<{ current: Section | null; hrefs: Record<Section, string>; labsHref: string }> = ({
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
        const active = current !== null && key === phoneKey(current);
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
