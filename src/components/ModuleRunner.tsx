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
import { PageHeader, ResetButton, segmentClass } from './lab/PageHeader';

interface ModuleRunnerProps {
  module: ExamModule;
  /** Objectives already completed for this module (persisted by the app) */
  completedObjectiveIds: string[];
  /** Called once per objective, the first time it passes */
  onObjectiveComplete: (moduleId: string, objectiveId: string) => void;
}

type SideTab = 'tasks' | 'simulator' | 'concepts' | 'walkthrough';

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

  const { session, run, setSystemState, clearHistory, reset: resetSession } = useShellSession(() => freshSession(module), verify);
  // Counts resets, so the terminal knows a fresh machine started (and shows its login banner)
  const [resetCount, setResetCount] = useState(0);
  const reset = useCallback((next: ShellSession) => {
    resetSession(next);
    setResetCount(n => n + 1);
  }, [resetSession]);

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

  // Walkthrough steps are written for the lab's default shell; switch to it so they never run in the other one
  const runStep = useCallback((lines: string | string[]) => {
    setActiveShell(module.defaultShell);
    run(lines, module.defaultShell);
  }, [run, module.defaultShell]);

  const panelRef = useRef<HTMLDivElement>(null);
  const terminalRef = useRef<HTMLElement>(null);

  // Each tab starts at the top; panels stay mounted so open hints and run marks survive a switch
  useEffect(() => {
    if (panelRef.current) panelRef.current.scrollTop = 0;
  }, [activeTab]);

  const showPane = (pane: 'lab' | 'terminal') => {
    setMobilePane(pane);
    // On phones, opening the terminal should let you type straight away
    if (pane === 'terminal') {
      requestAnimationFrame(() => terminalRef.current?.querySelector<HTMLInputElement>('input[aria-label="Command"]')?.focus());
    }
  };

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
    const target =
      e.key === 'ArrowRight' ? (idx + 1) % tabs.length
      : e.key === 'ArrowLeft' ? (idx + tabs.length - 1) % tabs.length
      : e.key === 'Home' ? 0
      : e.key === 'End' ? tabs.length - 1
      : null;
    if (target === null) return;
    e.preventDefault();
    const next = tabs[target];
    setActiveTab(next.id);
    document.getElementById(`lab-tab-${next.id}`)?.focus();
  };

  return (
    <div className="flex flex-col flex-1 min-h-0 h-full overflow-hidden bg-bg text-text">
      <PageHeader
        title={module.title}
        badge={isComplete ? 'Done' : undefined}
        meta={`${module.examCode} · ${module.difficulty} · about ${module.estimatedMinutes} min`}
        shellSwitch={
          module.allowedShells.length > 1
            ? { shells: module.allowedShells, value: activeShell, onChange: setActiveShell }
            : undefined
        }
        actions={<ResetButton label="Reset lab" onClick={handleResetLab} />}
      />

      {/* Phone: one pane at a time */}
      <div className="lg:hidden px-4 pt-3 shrink-0">
        <div className="flex p-0.5 rounded-md border border-line bg-surface" role="group" aria-label="Show">
          {(['lab', 'terminal'] as const).map(pane => (
            <button
              key={pane}
              type="button"
              aria-pressed={mobilePane === pane}
              onClick={() => showPane(pane)}
              className={`flex-1 ${segmentClass(mobilePane === pane)}`}
            >
              {pane === 'lab' ? (
                <>
                  Lab <span className={mobilePane === pane ? 'text-accent' : 'text-muted'}>· {done} of {total}</span>
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
            ref={panelRef}
            id="lab-panel"
            role="tabpanel"
            aria-labelledby={`lab-tab-${currentTab}`}
            tabIndex={0}
            className="flex-1 min-h-0 overflow-y-auto px-4 sm:px-6 py-6"
          >
            <div hidden={currentTab !== 'tasks'}><TasksPanel key={module.id} module={module} completed={completed} /></div>
            {module.simType !== 'terminal-only' && <div hidden={currentTab !== 'simulator'} className="h-full">{renderSimulator()}</div>}
            <div hidden={currentTab !== 'concepts'}><ConceptsPanel module={module} /></div>
            <div hidden={currentTab !== 'walkthrough'}><WalkthroughPanel key={module.id} module={module} onRunStep={runStep} /></div>
          </div>
        </section>

        {/* Right: the terminal */}
        <section
          ref={terminalRef}
          aria-label="Terminal"
          className={`${mobilePane === 'terminal' ? 'flex' : 'hidden'} lg:flex flex-col min-h-0 overflow-hidden p-3 sm:p-4`}
        >
          <TerminalView
            shell={activeShell}
            cwd={session.cwd}
            history={session.history}
            onExecuteCommand={execute}
            onClearHistory={clearHistory}
            resetKey={resetCount}
            isDiskpartActive={session.diskpartActive}
            currentUser={state.currentUser}
            hostname={state.hostname}
          />
        </section>
      </div>
    </div>
  );
};
