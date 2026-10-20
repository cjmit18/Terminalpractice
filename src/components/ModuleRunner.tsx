import React, { useState, useEffect, useRef, useCallback } from 'react';
import { ExamModule } from '../types/modules';
import { TerminalShell } from '../types/terminal';
import { TerminalView } from './TerminalView';
import { ActiveDirectorySim } from './ActiveDirectorySim';
import { GroupPolicySim } from './GroupPolicySim';
import { DiskpartSim } from './DiskpartSim';
import { NetworkTopologySim } from './NetworkTopologySim';
import { PermissionMatrixSim } from './PermissionMatrixSim';
import { createSession, ShellSession, useShellSession } from './lab/useShellSession';
import { TasksPanel, ConceptsPanel, WalkthroughPanel } from './lab/LabManual';
import { RotateCcw } from 'lucide-react';

interface ModuleRunnerProps {
  module: ExamModule;
  /** Objectives already completed for this module (persisted by the app) */
  completedObjectiveIds: string[];
  /** Called once per objective, the first time it passes */
  onObjectiveComplete: (moduleId: string, objectiveId: string) => void;
}

type SideTab = 'tasks' | 'simulator' | 'concepts' | 'walkthrough';

const SHELL_LABELS: Record<TerminalShell, string> = {
  bash: 'bash',
  cmd: 'Command Prompt',
  powershell: 'PowerShell',
};

const startCwd = (module: ExamModule) => (module.track === 'lpi' ? '/home/student' : 'C:\\Users\\Student');
const freshSession = (module: ExamModule) => createSession(module.initialFs, module.initialState, startCwd(module));

export const ModuleRunner: React.FC<ModuleRunnerProps> = ({
  module,
  completedObjectiveIds,
  onObjectiveComplete,
}) => {
  const [activeShell, setActiveShell] = useState<TerminalShell>(module.defaultShell);
  const [activeTab, setActiveTab] = useState<SideTab>('tasks');
  const [mobilePane, setMobilePane] = useState<'lab' | 'terminal'>('lab');

  // Completed objectives live in a ref so back-to-back commands never report one twice
  const completedRef = useRef<Set<string>>(new Set(completedObjectiveIds));
  const [completed, setCompleted] = useState<Set<string>>(() => new Set(completedObjectiveIds));

  const moduleRef = useRef(module);
  moduleRef.current = module;
  const onCompleteRef = useRef(onObjectiveComplete);
  onCompleteRef.current = onObjectiveComplete;

  // Checks every open objective against the session a command (or simulator) just produced
  const verify = useCallback((s: ShellSession) => {
    const mod = moduleRef.current;
    const newlyDone: string[] = [];
    for (const obj of mod.objectives) {
      if (completedRef.current.has(obj.id)) continue;
      try {
        if (obj.verifier(s.fs, s.state, s.lastResult)) newlyDone.push(obj.id);
      } catch (err) {
        // A throwing verifier leaves the objective incomplete; surface it in development
        if (import.meta.env.DEV) console.error(`Verifier for "${obj.id}" threw`, err);
      }
    }
    if (newlyDone.length === 0) return;
    newlyDone.forEach(id => completedRef.current.add(id));
    setCompleted(new Set(completedRef.current));
    newlyDone.forEach(id => onCompleteRef.current(mod.id, id));
  }, []);

  const { session, run, setSystemState, clearHistory, reset } = useShellSession(() => freshSession(module), verify);

  // A different module is a different machine
  useEffect(() => {
    completedRef.current = new Set(completedObjectiveIds);
    setCompleted(new Set(completedObjectiveIds));
    setActiveShell(module.defaultShell);
    setActiveTab('tasks');
    setMobilePane('lab');
    reset(freshSession(module));
    // completedObjectiveIds is read once per module; App keeps it in step through onObjectiveComplete
  }, [module.id]);

  const execute = useCallback((lines: string | string[]) => run(lines, activeShell), [run, activeShell]);

  const handleResetLab = () => {
    // Resetting restores the environment; objectives already earned stay earned
    reset(freshSession(module));
  };

  const total = module.objectives.length;
  const done = module.objectives.filter(o => completed.has(o.id)).length;
  const isComplete = total > 0 && done === total;
  const { state } = session;

  const renderSimulator = () => {
    switch (module.simType) {
      case 'active-directory':
        return <ActiveDirectorySim systemState={state} onUpdateState={setSystemState} />;
      case 'group-policy':
        return <GroupPolicySim systemState={state} onRunGpUpdate={() => execute('gpupdate /force')} />;
      case 'diskpart':
        return <DiskpartSim systemState={state} onUpdateState={setSystemState} />;
      case 'network-topology':
        return (
          <NetworkTopologySim
            systemState={state}
            onRunPing={(t) => execute(`ping ${t}`)}
            onRenewDhcp={() => execute('ipconfig /renew')}
            onFlushDns={() => execute('ipconfig /flushdns')}
          />
        );
      case 'permission-matrix':
        return <PermissionMatrixSim onApplyChmod={(octal) => execute(`chmod ${octal} /home/student/finance`)} />;
      default:
        return null;
    }
  };

  const tabs: { id: SideTab; label: string }[] = [
    { id: 'tasks', label: 'Tasks' },
    ...(module.simType !== 'terminal-only' ? [{ id: 'simulator' as const, label: 'Simulator' }] : []),
    { id: 'concepts', label: 'Concepts' },
    { id: 'walkthrough', label: 'Walkthrough' },
  ];
  const currentTab = tabs.some(t => t.id === activeTab) ? activeTab : 'tasks';

  const onTabKeyDown = (e: React.KeyboardEvent, idx: number) => {
    if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
    e.preventDefault();
    const next = tabs[(idx + (e.key === 'ArrowRight' ? 1 : tabs.length - 1)) % tabs.length];
    setActiveTab(next.id);
    document.getElementById(`lab-tab-${next.id}`)?.focus();
  };

  const segment = (selected: boolean) =>
    `px-3 h-10 sm:h-8 text-sm rounded-sm transition-colors whitespace-nowrap ${
      selected ? 'bg-accent-soft text-accent font-medium' : 'text-muted hover:text-text'
    }`;

  return (
    <div className="flex flex-col flex-1 min-h-0 h-full overflow-hidden bg-bg text-text">
      <header className="flex flex-wrap items-start justify-between gap-x-6 gap-y-3 px-4 sm:px-6 py-4 border-b border-line shrink-0">
        <div className="min-w-0">
          <h1 className="text-xl sm:text-2xl font-semibold leading-snug flex flex-wrap items-center gap-x-3 gap-y-1">
            <span>{module.title}</span>
            {isComplete && (
              <span className="inline-flex items-center px-1.5 py-0.5 rounded-sm bg-ok-soft text-ok text-xs font-medium">
                Done
              </span>
            )}
          </h1>
          <p className="text-sm text-muted mt-0.5">
            {module.examCode} · {module.difficulty} · about {module.estimatedMinutes} min
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          {module.allowedShells.length > 1 && (
            <div className="flex items-center gap-0.5 p-0.5 rounded-md border border-line bg-surface" role="group" aria-label="Shell">
              {module.allowedShells.map(sh => (
                <button key={sh} type="button" aria-pressed={activeShell === sh} onClick={() => setActiveShell(sh)} className={segment(activeShell === sh)}>
                  {SHELL_LABELS[sh]}
                </button>
              ))}
            </div>
          )}
          <button
            type="button"
            onClick={handleResetLab}
            className="inline-flex items-center gap-1.5 h-10 sm:h-9 px-3 rounded-md border border-line-strong bg-surface text-sm font-medium hover:bg-surface-2 transition-colors"
          >
            <RotateCcw className="size-4 text-muted" aria-hidden="true" />
            Reset lab
          </button>
        </div>
      </header>

      {/* Phone: one pane at a time */}
      <div className="lg:hidden px-4 pt-3 shrink-0">
        <div className="flex p-0.5 rounded-md border border-line bg-surface" role="group" aria-label="Show">
          {(['lab', 'terminal'] as const).map(pane => (
            <button
              key={pane}
              type="button"
              aria-pressed={mobilePane === pane}
              onClick={() => setMobilePane(pane)}
              className={`flex-1 ${segment(mobilePane === pane)}`}
            >
              {pane === 'lab' ? (
                <>
                  Lab <span className={mobilePane === pane ? 'text-accent' : 'text-subtle'}>· {done} of {total}</span>
                </>
              ) : (
                'Terminal'
              )}
            </button>
          ))}
        </div>
      </div>

      <div className="flex-1 min-h-0 grid grid-cols-1 lg:grid-cols-[minmax(0,5fr)_minmax(0,7fr)] overflow-hidden">
        {/* Left: the lab manual */}
        <section
          aria-label="Lab instructions"
          className={`${mobilePane === 'lab' ? 'flex' : 'hidden'} lg:flex flex-col min-h-0 overflow-hidden lg:border-r border-line`}
        >
          <div role="tablist" aria-label="Lab sections" className="flex gap-1 px-2 sm:px-4 border-b border-line shrink-0 overflow-x-auto">
            {tabs.map((t, idx) => {
              const selected = currentTab === t.id;
              return (
                <button
                  key={t.id}
                  id={`lab-tab-${t.id}`}
                  type="button"
                  role="tab"
                  aria-selected={selected}
                  aria-controls="lab-panel"
                  tabIndex={selected ? 0 : -1}
                  onClick={() => setActiveTab(t.id)}
                  onKeyDown={(e) => onTabKeyDown(e, idx)}
                  className={`relative px-2.5 sm:px-3 h-11 text-sm whitespace-nowrap transition-colors ${
                    selected
                      ? 'text-text font-medium after:absolute after:inset-x-2 after:bottom-0 after:h-0.5 after:bg-accent'
                      : 'text-muted hover:text-text'
                  }`}
                >
                  {t.label}
                </button>
              );
            })}
          </div>

          <div
            id="lab-panel"
            role="tabpanel"
            aria-labelledby={`lab-tab-${currentTab}`}
            tabIndex={0}
            className="flex-1 min-h-0 overflow-y-auto px-4 sm:px-6 py-6"
          >
            {currentTab === 'tasks' && <TasksPanel key={module.id} module={module} completed={completed} />}
            {currentTab === 'simulator' && renderSimulator()}
            {currentTab === 'concepts' && <ConceptsPanel module={module} />}
            {currentTab === 'walkthrough' && <WalkthroughPanel key={module.id} module={module} onRunStep={execute} />}
          </div>
        </section>

        {/* Right: the terminal */}
        <section
          aria-label="Terminal"
          className={`${mobilePane === 'terminal' ? 'flex' : 'hidden'} lg:flex flex-col min-h-0 overflow-hidden p-3 sm:p-4`}
        >
          <TerminalView
            shell={activeShell}
            cwd={session.cwd}
            history={session.history}
            onExecuteCommand={execute}
            onClearHistory={clearHistory}
            isDiskpartActive={session.diskpartActive}
            currentUser={state.currentUser}
            hostname={state.hostname}
          />
        </section>
      </div>
    </div>
  );
};
