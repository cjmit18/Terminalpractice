/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { Suspense, useEffect, useMemo, useRef, useState } from 'react';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { BottomNav, Header } from './components/Header';
import { ModuleSelector } from './components/ModuleSelector';
import { ModuleRunner } from './components/ModuleRunner';
import { ExamModule } from './types/modules';
import { SystemState } from './types/terminal';
import { Route, Section, TrackSection, isTrackSection, replaceRoute, routeHref, useHashRoute } from './lib/router';
import { completeObjective, countDone, progressCodec, PROGRESS_KEY, resetModules } from './lib/progress';
import { useSyncedStorage } from './lib/syncedStorage';
import { useTheme } from './lib/theme';
import { ALL_MODULES, TRACK_MODULES, TRACK_NAMES, topicLabel } from './lib/modules';
import {
  CompletionSource,
  JOURNEY_KEY,
  QuizScore,
  findStep,
  journeyCodec,
  labCheck,
  markRead,
  recordQuizScore,
  resetPath,
  stepTitle,
  visit,
} from './lib/journey';
import { LEARNING_PATHS } from './data/paths';
import { PathsList } from './components/journey/PathsList';
import { PathOverview } from './components/journey/PathOverview';
import { StepPage } from './components/journey/StepPage';
import { PageErrorBoundary } from './components/PageErrorBoundary';
import { lazyWithReload, reloadOnPreloadError } from './lib/chunkReload';

const MODULES_BY_ID = new Map(ALL_MODULES.map(m => [m.id, m]));
// How lab progress and the journey are saved and shared with the app's other open tabs
const PROGRESS_CODEC = progressCodec(ALL_MODULES);
const JOURNEY_CODEC = journeyCodec(LEARNING_PATHS);

// Pages that are not needed for the first screen load on demand. If a chunk fails to load (this tab
// runs an older build than the server has), the page reloads once; otherwise PageErrorBoundary shows.
reloadOnPreloadError();
const SimulatorsHub = lazyWithReload(() => import('./components/SimulatorsHub').then(m => ({ default: m.SimulatorsHub })));
const SandboxMode = lazyWithReload(() => import('./components/SandboxMode').then(m => ({ default: m.SandboxMode })));
const CommandEncyclopedia = lazyWithReload(() =>
  import('./components/CommandEncyclopedia').then(m => ({ default: m.CommandEncyclopedia })),
);

const PAGE_TITLES: Record<Section, string> = {
  learn: 'Learn',
  linux: 'Linux labs',
  windows: 'Windows labs',
  simulators: 'Simulators',
  sandbox: 'Sandbox',
  reference: 'Reference',
};

export default function App() {
  const route = useHashRoute();
  const [theme, setTheme] = useTheme();
  // moduleId -> completed objective ids (plus reset tombstones), saved in localStorage and kept in
  // step with other open tabs: saves merge with what is stored, other tabs' saves merge in here
  const [progressRecord, setProgressRecord] = useSyncedStorage(PROGRESS_KEY, PROGRESS_CODEC);
  const progress = progressRecord.done;
  // The lab last open in each track, so coming back to a track returns you to it
  const [lastLab, setLastLab] = useState<Record<TrackSection, string | null>>({ linux: null, windows: null });
  // The lab track used last, for the single Labs item in the phone nav
  const [lastTrack, setLastTrack] = useState<TrackSection>('linux');
  // Lessons read, quiz scores and the last step opened in the learning paths, saved and shared like progress
  const [journey, setJourney] = useSyncedStorage(JOURNEY_KEY, JOURNEY_CODEC);
  // The last learning page open this session, so the Learn link brings you back to it
  const [lastLearnHref, setLastLearnHref] = useState<string | null>(null);
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

  // Learning path routes
  const learnRoute = route.section === 'learn' ? route : null;
  const activePath = learnRoute?.pathId ? LEARNING_PATHS.find(p => p.id === learnRoute.pathId) ?? null : null;
  // Memoized so a rerender (e.g. another tab's journey save) is not mistaken for opening the step again
  const routeStepId = learnRoute?.stepId;
  const activeStep = useMemo(() => (activePath && routeStepId ? findStep(activePath, routeStepId) : null), [activePath, routeStepId]);
  const src: CompletionSource = useMemo(
    () => ({ journey, labComplete: labCheck(progress, ALL_MODULES) }),
    [journey, progress],
  );

  // Unknown path -> the paths list; unknown step -> that path's overview
  useEffect(() => {
    if (!learnRoute) return;
    if (learnRoute.pathId && !activePath) replaceRoute({ section: 'learn', pathId: null, stepId: null });
    else if (activePath && learnRoute.stepId && !activeStep)
      replaceRoute({ section: 'learn', pathId: activePath.id, stepId: null });
  }, [learnRoute, activePath, activeStep]);

  // Remember the last step opened (for "Continue where you left off") and the last learning page
  useEffect(() => {
    if (!learnRoute) return;
    if (activePath && activeStep) setJourney(j => visit(j, activePath.id, activeStep.step.id));
    else if (activePath && !learnRoute.stepId) setJourney(j => (j.last?.pathId === activePath.id ? j : visit(j, activePath.id, null)));
    if (!learnRoute.pathId || activePath) setLastLearnHref(routeKey);
  }, [routeKey, learnRoute, activePath, activeStep]);

  useEffect(() => {
    if (track) setLastTrack(track);
  }, [track]);

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
    const parts = [
      activeModule ? `${topicLabel(activeModule)} ${activeModule.title}` : null,
      activeStep ? stepTitle(activeStep.step, MODULES_BY_ID) : null,
      activePath?.title,
      PAGE_TITLES[route.section],
      'Terminus CertSim',
    ];
    document.title = parts.filter(Boolean).join(' · ');
  }, [routeKey, activeModule, activePath, activeStep, route.section]);

  const handleObjectiveComplete = (moduleId: string, objectiveId: string) =>
    setProgressRecord(prev => completeObjective(prev, moduleId, objectiveId));

  const handleMarkRead = (pathId: string, stepId: string) => setJourney(j => markRead(j, pathId, stepId));
  const handleQuizScore = (pathId: string, stepId: string, score: QuizScore) =>
    setJourney(j => recordQuizScore(j, pathId, stepId, score));

  const resetTrackProgress = (t: TrackSection) => {
    setProgressRecord(prev => resetModules(prev, TRACK_MODULES[t].map(m => m.id)));
  };

  const { done: tasksDone, total: tasksTotal } = countDone(progress, ALL_MODULES);

  // Nav links. A track link takes you back to the lab you last had open there;
  // from inside that track it goes to the catalog.
  const trackHref = (t: TrackSection) =>
    routeHref({ section: t, moduleId: track === t ? null : lastLab[t] });
  const hrefs: Record<Section, string> = {
    learn: learnRoute || !lastLearnHref ? routeHref({ section: 'learn', pathId: null, stepId: null }) : lastLearnHref,
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
        <PageErrorBoundary resetKey={routeKey}>
        {learnRoute && !learnRoute.pathId && <PathsList paths={LEARNING_PATHS} src={src} modulesById={MODULES_BY_ID} />}

        {activePath && !learnRoute?.stepId && (
          <PathOverview
            key={activePath.id}
            path={activePath}
            src={src}
            modulesById={MODULES_BY_ID}
            progress={progress}
            onReset={() => setJourney(j => resetPath(j, activePath.id))}
          />
        )}

        {activePath && activeStep && (
          <StepPage
            key={`${activePath.id}/${activeStep.step.id}`}
            path={activePath}
            loc={activeStep}
            src={src}
            modulesById={MODULES_BY_ID}
            progress={progress}
            onObjectiveComplete={handleObjectiveComplete}
            onMarkRead={handleMarkRead}
            onQuizScore={handleQuizScore}
          />
        )}

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
        </PageErrorBoundary>
      </main>

      <BottomNav current={route.section} hrefs={hrefs} labsHref={hrefs[lastTrack]} />
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
