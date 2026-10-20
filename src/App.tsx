/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { Suspense, lazy, useEffect, useRef, useState } from 'react';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { BottomNav, Header } from './components/Header';
import { ModuleSelector } from './components/ModuleSelector';
import { ModuleRunner } from './components/ModuleRunner';
import { ExamModule } from './types/modules';
import { SystemState } from './types/terminal';
import { Route, Section, TrackSection, isTrackSection, replaceRoute, routeHref, useHashRoute } from './lib/router';
import { Progress, countDone, loadProgress, saveProgress } from './lib/progress';
import { useTheme } from './lib/theme';
import { ALL_MODULES, TRACK_MODULES, TRACK_NAMES, topicLabel } from './lib/modules';

// Pages that are not needed for the first screen load on demand.
const SimulatorsHub = lazy(() => import('./components/SimulatorsHub').then(m => ({ default: m.SimulatorsHub })));
const SandboxMode = lazy(() => import('./components/SandboxMode').then(m => ({ default: m.SandboxMode })));
const CommandEncyclopedia = lazy(() =>
  import('./components/CommandEncyclopedia').then(m => ({ default: m.CommandEncyclopedia })),
);

const PAGE_TITLES: Record<Section, string> = {
  linux: 'Linux labs',
  windows: 'Windows labs',
  simulators: 'Simulators',
  sandbox: 'Sandbox',
  reference: 'Reference',
};

export default function App() {
  const route = useHashRoute();
  const [theme, setTheme] = useTheme();
  // moduleId -> completed objective ids, saved in localStorage
  const [progress, setProgress] = useState<Progress>(() => loadProgress(ALL_MODULES));
  // The lab last open in each track, so coming back to a track returns you to it
  const [lastLab, setLastLab] = useState<Record<TrackSection, string | null>>({ linux: null, windows: null });
  const mainRef = useRef<HTMLElement>(null);

  // Shared state for the simulators hub
  const [sharedSimState, setSharedSimState] = useState<SystemState>({
    hostname: 'WIN-CLIENT01',
    currentUser: 'Administrator',
    currentGroup: 'Administrators',
    isRootOrAdmin: true,
    umask: 0,
    interfaces: [
      {
        name: 'Ethernet0',
        ip: '169.254.82.114',
        netmask: '255.255.0.0',
        mac: '00-50-56-A1-2B-3C',
        gateway: '',
        dns: ['192.168.1.10'],
        dhcpEnabled: true,
        status: 'UP',
      }
    ],
    processes: [
      { pid: 4, user: 'SYSTEM', cpu: 0.1, mem: 0.1, command: 'System' },
      { pid: 844, user: 'SYSTEM', cpu: 0.5, mem: 22.4, command: 'svchost.exe' },
      { pid: 3892, user: 'Student', cpu: 85.0, mem: 12.0, command: 'svchost_update.exe', port: 4444, isMalicious: true },
    ],
    services: [
      { name: 'Spooler', displayName: 'Print Spooler', status: 'Running', startType: 'Automatic' },
      { name: 'W32Time', displayName: 'Windows Time', status: 'Stopped', startType: 'Automatic' },
      { name: 'LanmanServer', displayName: 'Server (SMB)', status: 'Running', startType: 'Automatic' },
    ],
    disks: [
      {
        diskNumber: 0,
        totalSizeMB: 512000,
        model: 'SAMSUNG 980 NVMe',
        status: 'Online',
        partitionTable: 'GPT',
        partitions: [
          { id: 1, sizeMB: 500, fsType: 'FAT32', driveLetter: '', label: 'EFI System', isPrimary: true },
          { id: 2, sizeMB: 511500, fsType: 'NTFS', driveLetter: 'C:', label: 'Windows', isPrimary: true },
        ],
      },
      {
        diskNumber: 1,
        totalSizeMB: 256000,
        model: 'Crucial SSD',
        status: 'Online',
        partitionTable: 'GPT',
        partitions: [
          { id: 1, sizeMB: 256000, fsType: 'Unallocated' },
        ],
      }
    ],
    adUsers: [
      {
        sAMAccountName: 'jdoe',
        givenName: 'John',
        surname: 'Doe',
        displayName: 'John Doe',
        email: 'jdoe@corp.local',
        department: 'Marketing',
        ou: 'OU=Marketing,DC=corp,DC=local',
        enabled: true,
        locked: true,
        passwordNeverExpires: false,
        memberOf: ['Domain Users'],
      },
      {
        sAMAccountName: 'administrator',
        givenName: 'Admin',
        surname: 'Account',
        displayName: 'Administrator',
        email: 'admin@corp.local',
        department: 'IT',
        ou: 'OU=IT_Admins,DC=corp,DC=local',
        enabled: true,
        locked: false,
        passwordNeverExpires: true,
        memberOf: ['Domain Users', 'Domain Admins'],
      }
    ],
    adGroups: [
      {
        name: 'Domain Admins',
        scope: 'Global',
        category: 'Security',
        ou: 'OU=IT_Admins,DC=corp,DC=local',
        description: 'Designated administrators',
        members: ['administrator'],
      },
      {
        name: 'Domain Users',
        scope: 'Global',
        category: 'Security',
        ou: 'OU=Users,DC=corp,DC=local',
        description: 'All users',
        members: ['jdoe', 'administrator'],
      }
    ],
    gpos: [
      {
        id: '{31B2F340-016D-11D2-945F-00C04FB984F9}',
        name: 'Default Domain Policy',
        linkedOUs: ['DC=corp,DC=local'],
        status: 'Enabled',
        settings: [
          { category: 'Account Policies/Password Policy', setting: 'Minimum password length', value: '14 characters' },
          { category: 'Account Policies/Password Policy', setting: 'Password must meet complexity requirements', value: 'Enabled' },
        ],
      }
    ],
    installedPackages: ['RSAT-AD-PowerShell', 'GPMC'],
    systemIntegrityCorrupted: true,
    dismRepaired: false,
    sfcRepaired: false,
    dnsWorking: false,
    gatewayWorking: false,
    firewallBlockedPorts: [4444],
    diskpartSelectedDisk: null,
    diskpartSelectedPartition: null,
    envVars: { COMPUTERNAME: 'WIN-CLIENT01', USERNAME: 'Administrator' },
  });

  const track: TrackSection | null = isTrackSection(route.section) ? route.section : null;
  const moduleId = 'moduleId' in route ? route.moduleId : null;
  const trackModules = track ? TRACK_MODULES[track] : [];
  const activeModule = moduleId ? trackModules.find(m => m.id === moduleId) ?? null : null;
  const routeKey = routeHref(route);

  // A lab id that does not exist (old link, typo) falls back to the track's catalog
  useEffect(() => {
    if (track && moduleId && !activeModule) replaceRoute({ section: track, moduleId: null });
  }, [track, moduleId, activeModule]);

  // Remember where you were in each track
  useEffect(() => {
    if (!track || (moduleId && !activeModule)) return;
    setLastLab(prev => (prev[track] === moduleId ? prev : { ...prev, [track]: moduleId }));
  }, [track, moduleId, activeModule]);

  // New page: start at the top, and name it in the tab title
  useEffect(() => {
    mainRef.current?.scrollTo({ top: 0 });
    const parts = [activeModule ? `${topicLabel(activeModule)} ${activeModule.title}` : null, PAGE_TITLES[route.section], 'Terminus CertSim'];
    document.title = parts.filter(Boolean).join(' · ');
  }, [routeKey, activeModule, route.section]);

  useEffect(() => {
    saveProgress(progress);
  }, [progress]);

  const handleObjectiveComplete = (moduleId: string, objectiveId: string) => {
    setProgress(prev => {
      const done = prev[moduleId] ?? [];
      return done.includes(objectiveId) ? prev : { ...prev, [moduleId]: [...done, objectiveId] };
    });
  };

  const resetTrackProgress = (t: TrackSection) => {
    setProgress(prev => {
      const next = { ...prev };
      for (const m of TRACK_MODULES[t]) delete next[m.id];
      return next;
    });
  };

  const { done: tasksDone, total: tasksTotal } = countDone(progress, ALL_MODULES);

  // Nav links. A track link takes you back to the lab you last had open there;
  // from inside that track it goes to the catalog.
  const trackHref = (t: TrackSection) =>
    routeHref({ section: t, moduleId: track === t ? null : lastLab[t] });
  const hrefs: Record<Section, string> = {
    linux: trackHref('linux'),
    windows: trackHref('windows'),
    simulators: routeHref({ section: 'simulators' }),
    sandbox: routeHref({ section: 'sandbox' }),
    reference: routeHref({ section: 'reference' }),
  };

  const loading = <p className="px-4 sm:px-6 py-8 text-sm text-muted">Loading…</p>;

  return (
    <div className="h-dvh flex flex-col bg-bg text-text font-sans">
      <a
        href="#main"
        onClick={e => {
          e.preventDefault();
          mainRef.current?.focus();
        }}
        className="sr-only focus:not-sr-only focus:absolute focus:z-50 focus:top-2 focus:left-2 focus:px-3 focus:py-2 focus:rounded-md focus:bg-surface focus:text-text focus:border focus:border-line"
      >
        Skip to content
      </a>

      <Header
        current={route.section}
        hrefs={hrefs}
        tasksDone={tasksDone}
        tasksTotal={tasksTotal}
        theme={theme}
        onThemeChange={setTheme}
      />

      <main id="main" ref={mainRef} tabIndex={-1} className="flex-1 min-h-0 overflow-y-auto focus:outline-none">
        {track && activeModule && (
          <div className="flex flex-col h-full">
            <LabBar track={track} module={activeModule} modules={trackModules} />
            <ModuleRunner
              key={activeModule.id}
              module={activeModule}
              completedObjectiveIds={progress[activeModule.id] ?? []}
              onObjectiveComplete={handleObjectiveComplete}
            />
          </div>
        )}

        {track && !moduleId && (
          <ModuleSelector
            track={track}
            modules={trackModules}
            progress={progress}
            onResetProgress={() => resetTrackProgress(track)}
          />
        )}

        {route.section === 'simulators' && (
          <Suspense fallback={loading}>
            <SimulatorsHub systemState={sharedSimState} onUpdateState={setSharedSimState} />
          </Suspense>
        )}

        {route.section === 'sandbox' && (
          <Suspense fallback={loading}>
            <SandboxMode />
          </Suspense>
        )}

        {route.section === 'reference' && (
          <Suspense fallback={loading}>
            <CommandEncyclopedia />
          </Suspense>
        )}
      </main>

      <BottomNav current={route.section} hrefs={hrefs} />
    </div>
  );
}

interface LabBarProps {
  track: TrackSection;
  module: ExamModule;
  modules: ExamModule[];
}

/** Breadcrumb back to the catalog, plus links to the neighbouring labs. */
function LabBar({ track, module, modules }: LabBarProps) {
  const index = modules.findIndex(m => m.id === module.id);
  const prev = index > 0 ? modules[index - 1] : null;
  const next = index >= 0 && index < modules.length - 1 ? modules[index + 1] : null;

  return (
    <div className="shrink-0 flex items-center justify-between gap-3 min-h-11 px-4 lg:px-6 border-b border-line bg-bg">
      <nav aria-label="Breadcrumb" className="min-w-0">
        <ol className="flex items-center gap-2 text-sm min-w-0">
          <li className="shrink-0">
            <a href={routeHref({ section: track, moduleId: null })} className="text-muted hover:text-text underline-offset-2 hover:underline">
              {TRACK_NAMES[track]}
            </a>
          </li>
          <li aria-hidden="true" className="shrink-0 text-subtle">
            /
          </li>
          <li aria-current="page" className="min-w-0 truncate font-medium text-text">
            {/* The full title is the page heading right below; phones show only the topic number here */}
            <span className="tabular-nums">{topicLabel(module)}</span>
            <span className="hidden sm:inline"> {module.title}</span>
          </li>
        </ol>
      </nav>

      <div className="flex items-center gap-1 shrink-0 -mr-2">
        <NeighbourLink track={track} target={prev} direction="prev" />
        <NeighbourLink track={track} target={next} direction="next" />
      </div>
    </div>
  );
}

function NeighbourLink({ track, target, direction }: { track: TrackSection; target: ExamModule | null; direction: 'prev' | 'next' }) {
  const label = direction === 'prev' ? 'Previous' : 'Next';
  const Icon = direction === 'prev' ? ChevronLeft : ChevronRight;
  const base = 'flex items-center gap-1 h-10 sm:h-8 px-2 rounded-md text-sm font-medium';
  const content = (
    <>
      {direction === 'prev' && <Icon className="w-4 h-4" aria-hidden="true" />}
      <span className="hidden sm:inline">{label}</span>
      {direction === 'next' && <Icon className="w-4 h-4" aria-hidden="true" />}
    </>
  );

  if (!target) {
    return (
      <span aria-hidden="true" className={`${base} text-subtle opacity-50`}>
        {content}
      </span>
    );
  }

  const name = `${topicLabel(target)} ${target.title}`;
  const route: Route = { section: track, moduleId: target.id };
  return (
    <a
      href={routeHref(route)}
      aria-label={`${label} lab: ${name}`}
      title={name}
      className={`${base} text-muted hover:text-text hover:bg-surface-2`}
    >
      {content}
    </a>
  );
}
