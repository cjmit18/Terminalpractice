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
import { useGameLayer } from './celebrate/GameLayer';
import { LabRecap } from './celebrate/LabRecap';
import { TicketThanks } from './lab/Ticket';
import { CHALLENGES } from '../data/challenges';
import { routeHref } from '../lib/router';
import { hintFact, resetFact } from '../lib/activity';

interface ModuleRunnerProps {
  module: ExamModule;
  /** Objectives already completed for this module (persisted by the app) */
  completedObjectiveIds: string[];
  /** Called once per objective, the first time it passes */
  onObjectiveComplete: (moduleId: string, objectiveId: string) => void;
  /** Where to go after this lab, when it is part of a path (shown in the recap once it is done) */
  next?: { href: string; title: string } | null;
  /** Shown under the lab recap once the lab is finished here (a path's stage recap) */
  recap?: React.ReactNode;
}

type SideTab = 'tasks' | 'simulator' | 'concepts' | 'walkthrough';

const startCwd = (module: ExamModule) => (module.track === 'lpi' ? '/home/student' : 'C:\\Users\\Student');
const freshSession = (module: ExamModule) => createSession(module.initialFs, module.initialState, startCwd(module));

export const ModuleRunner: React.FC<ModuleRunnerProps> = ({
  module,
  completedObjectiveIds,
  onObjectiveComplete,
  next,
  recap,
}) => {
  const { record, announce } = useGameLayer();
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
  const announceRef = useRef(announce);
  announceRef.current = announce;

  // For the recap: the command line that passed each task in this visit (null: the simulator did)
  const [passedBy, setPassedBy] = useState<Record<string, string | null>>({});
  // True once the last task passed during this visit, so the recap shows then and not on every visit
  const [finishedHere, setFinishedHere] = useState(false);
  const lastOutcomeRef = useRef<ShellSession['lastOutcome']>(undefined);

  // Objectives another tab reset while they still pass on this machine: earned again only after
  // they stop passing once, so the reset is not undone by the work already on the machine
  const rearmRef = useRef<Set<string>>(new Set());

  const passes = (obj: ExamModule['objectives'][number], s: ShellSession) => {
    try {
      return !!obj.verifier(s.fs, s.state, s.lastResult);
    } catch (err) {
      // A throwing verifier leaves the objective incomplete; surface it in development
      if (import.meta.env.DEV) console.error(`Verifier for "${obj.id}" threw`, err);
      return false;
    }
  };

  // Checks every open objective against the session a command (or simulator) just produced
  const verify = useCallback((s: ShellSession) => {
    const mod = moduleRef.current;
    const newlyDone: string[] = [];
    for (const obj of mod.objectives) {
      if (completedRef.current.has(obj.id)) continue;
      const ok = passes(obj, s);
      if (rearmRef.current.has(obj.id)) {
        if (!ok) rearmRef.current.delete(obj.id);
        continue;
      }
      if (ok) newlyDone.push(obj.id);
    }
    // A new command produced this session; a simulator panel changes state without one
    const byCommand = s.lastOutcome && s.lastOutcome !== lastOutcomeRef.current ? s.lastOutcome.line : null;
    lastOutcomeRef.current = s.lastOutcome;
    if (newlyDone.length === 0) return;
    newlyDone.forEach(id => completedRef.current.add(id));
    setCompleted(new Set(completedRef.current));
    setPassedBy(prev => ({ ...prev, ...Object.fromEntries(newlyDone.map(id => [id, byCommand])) }));
    if (mod.objectives.every(o => completedRef.current.has(o.id))) setFinishedHere(true);
    newlyDone.forEach(id => onCompleteRef.current(mod.id, id));
    const total = mod.objectives.length;
    for (const id of newlyDone) {
      const index = mod.objectives.findIndex(o => o.id === id);
      announceRef.current({ kind: 'task', title: mod.objectives[index].title, index: index + 1, total });
    }
  }, []);

  const { session, run, setSystemState, clearHistory, reset: resetSession } = useShellSession(() => freshSession(module), verify, record);
  // Counts resets, so the terminal knows a fresh machine started (and shows its login banner)
  const [resetCount, setResetCount] = useState(0);
  const reset = useCallback((next: ShellSession) => {
    rearmRef.current = new Set();
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
    setPassedBy({});
    setFinishedHere(false);
    reset(freshSession(module));
    // completedObjectiveIds is read once per module here; changes to it are synced below
  }, [module.id]);

  // Saved completions can change under the running lab (another tab completes or resets tasks):
  // follow them, so the checklist is current and a reset lets tasks be earned again, without
  // restarting the machine. This tab's own completions are already in the saved ids.
  const savedKey = [...completedObjectiveIds].sort().join('\n');
  const savedKeyRef = useRef(savedKey);
  useEffect(() => {
    if (savedKeyRef.current === savedKey) return;
    savedKeyRef.current = savedKey;
    const saved = new Set(completedObjectiveIds);
    // Judge by machine state only: the last command's result is not evidence that outlives the reset,
    // so running that command again counts straight away
    const machine: ShellSession = { ...session, lastResult: undefined };
    for (const obj of module.objectives) {
      if (completedRef.current.has(obj.id) && !saved.has(obj.id) && passes(obj, machine)) rearmRef.current.add(obj.id);
      if (saved.has(obj.id)) rearmRef.current.delete(obj.id);
    }
    completedRef.current = saved;
    setCompleted(new Set(completedObjectiveIds));
  }, [savedKey]);

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
    // Finishing a lab after resetting it earns "Fresh start"; a lab already done does not count
    if (!module.objectives.every(o => completedRef.current.has(o.id))) record([resetFact(module.id)]);
  };

  // A hint opened for a task not done yet: finishing that task afterwards earns "Hints are tools"
  const handleHint = useCallback((objectiveId: string) => {
    if (!completedRef.current.has(objectiveId)) record([hintFact(module.id, objectiveId)]);
  }, [record, module.id]);

  const total = module.objectives.length;
  const done = module.objectives.filter(o => completed.has(o.id)).length;
  const isComplete = total > 0 && done === total;
  // Offered in the recap: a mini challenge that runs on this lab's machine
  const challenge = CHALLENGES.find(c => c.machineFrom === module.id);
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
            <div hidden={currentTab !== 'tasks'}>
              {isComplete && finishedHere && (
                <>
                  <TicketThanks ticket={module.ticket} />
                  {challenge && (
                    <p className="mb-4 text-sm">
                      <span className="text-muted">A short challenge on this machine: </span>
                      <a href={routeHref({ section: 'sandbox', challengeId: challenge.id })} className="font-medium text-accent underline-offset-2 hover:underline rounded-sm">
                        {challenge.title}
                      </a>
                    </p>
                  )}
                  <LabRecap module={module} passedBy={passedBy} next={next ?? null} />
                  {recap}
                </>
              )}
              <TasksPanel key={module.id} module={module} completed={completed} onHint={objectiveId => handleHint(objectiveId)} />
            </div>
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
            onActivity={record}
            resetKey={resetCount}
            isDiskpartActive={session.diskpartActive}
            currentUser={state.currentUser}
            hostname={state.hostname}
            fs={session.fs}
          />
        </section>
      </div>
    </div>
  );
};
