import React, { useState, useEffect } from 'react';
import { ExamModule, CommandContext } from '../types/modules';
import { TerminalShell, HistoryItem, FileNode, SystemState } from '../types/terminal';
import { executeLinuxLine } from '../terminal/linuxEngine';
import { executeWindowsLine } from '../terminal/windowsEngine';
import { TerminalView } from './TerminalView';
import { ActiveDirectorySim } from './ActiveDirectorySim';
import { GroupPolicySim } from './GroupPolicySim';
import { DiskpartSim } from './DiskpartSim';
import { NetworkTopologySim } from './NetworkTopologySim';
import { PermissionMatrixSim } from './PermissionMatrixSim';
import { 
  CheckCircle2, 
  Circle, 
  HelpCircle, 
  BookOpen, 
  RotateCcw, 
  Eye, 
  Terminal, 
  Layers, 
  Award,
  ChevronRight,
  ShieldCheck,
  AlertCircle
} from 'lucide-react';

interface ModuleRunnerProps {
  module: ExamModule;
  onCompleteModule?: (moduleId: string) => void;
}

export const ModuleRunner: React.FC<ModuleRunnerProps> = ({
  module,
  onCompleteModule,
}) => {
  const [activeShell, setActiveShell] = useState<TerminalShell>(module.defaultShell);
  const [fs, setFs] = useState<FileNode>(module.initialFs);
  const [state, setState] = useState<SystemState>(module.initialState);
  const [cwd, setCwd] = useState<string>(
    module.track === 'lpi' ? '/home/student' : 'C:\\Users\\Student'
  );
  const [history, setHistory] = useState<HistoryItem[]>([]);
  const [isDiskpartActive, setIsDiskpartActive] = useState(false);
  const [completedObjectives, setCompletedObjectives] = useState<{ [key: string]: boolean }>({});
  const [activeSideTab, setActiveSideTab] = useState<'objectives' | 'visualizer' | 'concepts' | 'solution'>('objectives');
  const [revealedHints, setRevealedHints] = useState<{ [key: string]: boolean }>({});
  const [mobilePane, setMobilePane] = useState<'lab' | 'terminal'>('lab');
  const [lastResult, setLastResult] = useState<CommandContext | undefined>(undefined);

  // Reset state when module changes
  useEffect(() => {
    setFs(module.initialFs);
    setState(module.initialState);
    setActiveShell(module.defaultShell);
    setCwd(module.track === 'lpi' ? '/home/student' : 'C:\\Users\\Student');
    setHistory([]);
    setIsDiskpartActive(false);
    setCompletedObjectives({});
    setRevealedHints({});
    setLastResult(undefined);
    setActiveSideTab('objectives');
    setMobilePane('lab');
  }, [module.id]);

  // Live Objective Verification Evaluation
  useEffect(() => {
    const updated: { [key: string]: boolean } = { ...completedObjectives };
    let hasChanges = false;

    module.objectives.forEach(obj => {
      if (!updated[obj.id]) {
        try {
          const pass = obj.verifier(fs, state, lastResult);
          if (pass) {
            updated[obj.id] = true;
            hasChanges = true;
          }
        } catch (err) {
          // A throwing verifier leaves the objective incomplete; surface it in development
          if (import.meta.env.DEV) console.error(`Verifier for "${obj.id}" threw`, err);
        }
      }
    });

    if (hasChanges) {
      setCompletedObjectives(updated);
      const allPassed = module.objectives.every(o => updated[o.id]);
      if (allPassed) {
        onCompleteModule?.(module.id);
      }
    }
  }, [fs, state, lastResult, module]);

  const handleExecuteCommand = (rawCmd: string) => {
    if (activeShell === 'bash') {
      const res = executeLinuxLine(rawCmd, cwd, fs, state);
      setFs(res.newFs);
      setState(res.newState);
      setCwd(res.newCwd);

      const ctx: CommandContext = {
        command: rawCmd,
        exitCode: res.exitCode,
        stdout: res.stdout,
      };
      setLastResult(ctx);

      const newItem: HistoryItem = {
        id: Math.random().toString(),
        command: rawCmd,
        output: [res.stdout, res.stderr].filter(Boolean).join('\n'),
        errorOutput: res.stderr || undefined,
        isError: res.exitCode !== 0,
        timestamp: new Date().toLocaleTimeString(),
        cwd: res.newCwd,
        shell: 'bash',
      };
      setHistory(prev => [...prev, newItem]);
    } else {
      // CMD or PowerShell
      const res = executeWindowsLine(rawCmd, cwd, fs, state, activeShell, isDiskpartActive);
      setFs(res.newFs);
      setState(res.newState);
      setCwd(res.newCwd);
      setIsDiskpartActive(!!res.diskpartActive);

      const ctx: CommandContext = {
        command: rawCmd,
        exitCode: res.exitCode,
        stdout: res.stdout,
      };
      setLastResult(ctx);

      const newItem: HistoryItem = {
        id: Math.random().toString(),
        command: rawCmd,
        output: [res.stdout, res.stderr].filter(Boolean).join('\r\n'),
        errorOutput: res.stderr || undefined,
        isError: res.exitCode !== 0,
        timestamp: new Date().toLocaleTimeString(),
        cwd: res.newCwd,
        shell: activeShell,
      };
      setHistory(prev => [...prev, newItem]);
    }
  };

  const handleResetLab = () => {
    setFs(module.initialFs);
    setState(module.initialState);
    setCwd(module.track === 'lpi' ? '/home/student' : 'C:\\Users\\Student');
    setHistory([]);
    setIsDiskpartActive(false);
    setCompletedObjectives({});
    setLastResult(undefined);
  };

  const totalObjectives = module.objectives.length;
  const passedObjectives = module.objectives.filter(o => completedObjectives[o.id]).length;
  const isModuleComplete = totalObjectives > 0 && passedObjectives === totalObjectives;

  // Render appropriate domain visualizer component
  const renderVisualizer = () => {
    switch (module.simType) {
      case 'active-directory':
        return <ActiveDirectorySim systemState={state} onUpdateState={setState} />;
      case 'group-policy':
        return <GroupPolicySim systemState={state} onRunGpUpdate={() => handleExecuteCommand('gpupdate /force')} />;
      case 'diskpart':
        return <DiskpartSim systemState={state} onUpdateState={setState} />;
      case 'network-topology':
        return (
          <NetworkTopologySim 
            systemState={state} 
            onRunPing={(t) => handleExecuteCommand(`ping ${t}`)} 
            onRenewDhcp={() => handleExecuteCommand('ipconfig /renew')}
            onFlushDns={() => handleExecuteCommand('ipconfig /flushdns')}
          />
        );
      case 'permission-matrix':
        return <PermissionMatrixSim onApplyChmod={(octal) => handleExecuteCommand(`chmod ${octal} /home/student/finance`)} />;
      case 'terminal-only':
      default:
        return (
          <div className="flex flex-col items-center justify-center h-full p-8 text-center text-slate-400 bg-slate-900/40 rounded-xl border border-slate-800">
            <Terminal className="w-10 h-10 text-slate-500 mb-3" />
            <h4 className="text-sm font-semibold text-slate-300">Terminal-Centric Lab Module</h4>
            <p className="text-xs text-slate-400 max-w-sm mt-1 leading-relaxed">
              This official certification objective is evaluated through interactive command-line stream manipulation, filters, and system files.
            </p>
          </div>
        );
    }
  };

  return (
    <div className="flex flex-col flex-1 min-h-0 h-full overflow-hidden bg-slate-950 font-sans">
      {/* Module Sub-Header Banner */}
      <div className="flex flex-wrap items-center justify-between gap-2 sm:gap-4 px-3 sm:px-6 py-2 sm:py-3 bg-slate-900/60 border-b border-slate-800 shrink-0">
        <div className="flex items-center gap-3">
          <span className={`hidden sm:inline px-2.5 py-0.5 rounded text-xs font-mono font-bold uppercase tracking-wider ${
            module.track === 'lpi' 
              ? 'bg-amber-500/20 text-amber-300 border border-amber-500/30' 
              : 'bg-blue-500/20 text-blue-300 border border-blue-500/30'
          }`}>
            {module.topicNumber}
          </span>
          <div>
            <h1 className="text-sm sm:text-base font-bold text-white tracking-tight flex items-center gap-2">
              <span>{module.title}</span>
              {isModuleComplete && (
                <span className="flex items-center gap-1 px-2 py-0.5 rounded bg-emerald-500/20 text-emerald-300 text-xs font-medium border border-emerald-500/40">
                  <ShieldCheck className="w-3.5 h-3.5" /> Complete
                </span>
              )}
            </h1>
            <div className="text-[11px] text-slate-400 flex items-center gap-2">
              <span>{module.examCode}</span>
              <span>·</span>
              <span>{module.difficulty}</span>
              <span>·</span>
              <span>~{module.estimatedMinutes} mins</span>
            </div>
          </div>
        </div>

        {/* Action controls */}
        <div className="flex items-center gap-3">
          {/* Shell switcher if multiple shells allowed */}
          {module.allowedShells.length > 1 && (
            <div className="flex items-center bg-slate-900 border border-slate-800 rounded-lg p-0.5 text-xs font-medium">
              {module.allowedShells.map(sh => (
                <button
                  key={sh}
                  onClick={() => setActiveShell(sh)}
                  className={`px-2.5 py-1 rounded transition-colors uppercase ${
                    activeShell === sh
                      ? 'bg-blue-600 text-white font-semibold'
                      : 'text-slate-400 hover:text-slate-200'
                  }`}
                >
                  {sh}
                </button>
              ))}
            </div>
          )}

          <button
            onClick={handleResetLab}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-300 text-xs font-medium border border-slate-700 transition-colors"
          >
            <RotateCcw className="w-3.5 h-3.5" />
            <span>Reset Lab</span>
          </button>
        </div>
      </div>

      {/* Main Split Grid (Scenario/Visualizer vs Live Terminal) */}
      {/* Phone-only switch between the lab panel and the terminal */}
      <div className="lg:hidden flex shrink-0 gap-1 p-2 pb-0" role="tablist" aria-label="Lab view">
        {(['lab', 'terminal'] as const).map(pane => (
          <button
            key={pane}
            role="tab"
            aria-selected={mobilePane === pane}
            onClick={() => setMobilePane(pane)}
            className={`flex-1 py-2 rounded-lg text-xs font-semibold transition-colors ${
              mobilePane === pane ? 'bg-cyan-500/20 text-cyan-200 border border-cyan-500/40' : 'bg-slate-900 text-slate-400 border border-slate-800'
            }`}
          >
            {pane === 'lab' ? `Lab (${passedObjectives}/${totalObjectives})` : 'Terminal'}
          </button>
        ))}
      </div>

      <div className="flex-1 min-h-0 grid grid-cols-1 lg:grid-cols-12 gap-4 p-2 sm:p-4 overflow-hidden">
        {/* Left Panel: Scenario, Visualizer, Concepts & Solution (5 cols) */}
        <div className={`${mobilePane === 'lab' ? 'flex' : 'hidden'} lg:flex lg:col-span-5 flex-col h-full min-h-0 overflow-hidden bg-slate-900/60 rounded-xl border border-slate-800`}>
          {/* Side Tabs Bar */}
          <div className="flex items-center border-b border-slate-800 bg-slate-950/70 px-2 pt-2 gap-1 shrink-0 overflow-x-auto">
            <button
              onClick={() => setActiveSideTab('objectives')}
              className={`flex items-center gap-1.5 px-3 py-2 text-xs font-medium rounded-t-lg transition-colors whitespace-nowrap border-t border-x ${
                activeSideTab === 'objectives'
                  ? 'bg-slate-900 text-white border-slate-800 font-semibold'
                  : 'text-slate-400 hover:text-slate-200 border-transparent'
              }`}
            >
              <span>Scenario & Objectives</span>
              <span className="px-1.5 py-0.2 rounded-full text-[10px] font-mono bg-cyan-500/20 text-cyan-300">
                {passedObjectives}/{totalObjectives}
              </span>
            </button>

            {module.simType !== 'terminal-only' && (
              <button
                onClick={() => setActiveSideTab('visualizer')}
                className={`flex items-center gap-1.5 px-3 py-2 text-xs font-medium rounded-t-lg transition-colors whitespace-nowrap border-t border-x ${
                  activeSideTab === 'visualizer'
                    ? 'bg-slate-900 text-white border-slate-800 font-semibold'
                    : 'text-slate-400 hover:text-slate-200 border-transparent'
                }`}
              >
                <Layers className="w-3.5 h-3.5 text-emerald-400" />
                <span>Interactive Sim</span>
              </button>
            )}

            <button
              onClick={() => setActiveSideTab('concepts')}
              className={`flex items-center gap-1.5 px-3 py-2 text-xs font-medium rounded-t-lg transition-colors whitespace-nowrap border-t border-x ${
                activeSideTab === 'concepts'
                  ? 'bg-slate-900 text-white border-slate-800 font-semibold'
                  : 'text-slate-400 hover:text-slate-200 border-transparent'
              }`}
            >
              <BookOpen className="w-3.5 h-3.5 text-blue-400" />
              <span>Exam Concepts</span>
            </button>

            <button
              onClick={() => setActiveSideTab('solution')}
              className={`flex items-center gap-1.5 px-3 py-2 text-xs font-medium rounded-t-lg transition-colors whitespace-nowrap border-t border-x ${
                activeSideTab === 'solution'
                  ? 'bg-slate-900 text-white border-slate-800 font-semibold'
                  : 'text-slate-400 hover:text-slate-200 border-transparent'
              }`}
            >
              <Eye className="w-3.5 h-3.5 text-amber-400" />
              <span>Walkthrough</span>
            </button>
          </div>

          {/* Left Panel Body */}
          <div className="flex-1 p-4 overflow-y-auto space-y-4">
            {activeSideTab === 'objectives' && (
              <div className="space-y-4">
                {/* Scenario Brief */}
                <div className="p-3.5 rounded-lg bg-slate-950 border border-slate-800 space-y-2">
                  <div className="flex items-center justify-between text-xs font-bold text-slate-200">
                    <span>Performance-Based Question Scenario</span>
                    <span className="text-[11px] font-mono text-slate-400">Target: Pass</span>
                  </div>
                  <p className="text-xs text-slate-300 leading-relaxed">
                    {module.scenarioDescription}
                  </p>
                  <div className="p-2 rounded bg-slate-900 text-[11px] font-mono text-slate-400 border border-slate-800/80">
                    {module.systemContext}
                  </div>
                </div>

                {/* Live Objectives Checklist */}
                <div className="space-y-2">
                  <div className="flex items-center justify-between text-xs font-bold text-slate-200">
                    <span>Task Objectives Checklist</span>
                    <span className="text-[11px] font-mono text-cyan-400">
                      {Math.round((passedObjectives / totalObjectives) * 100)}% Verified
                    </span>
                  </div>

                  <div className="space-y-2">
                    {module.objectives.map((obj, idx) => {
                      const isDone = completedObjectives[obj.id];
                      const hintVisible = revealedHints[obj.id];

                      return (
                        <div
                          key={obj.id}
                          className={`p-3 rounded-lg border transition-all ${
                            isDone
                              ? 'bg-emerald-950/20 border-emerald-500/40'
                              : 'bg-slate-950 border-slate-800'
                          }`}
                        >
                          <div className="flex items-start gap-2.5">
                            {isDone ? (
                              <CheckCircle2 className="w-4 h-4 text-emerald-400 shrink-0 mt-0.5" />
                            ) : (
                              <Circle className="w-4 h-4 text-slate-500 shrink-0 mt-0.5" />
                            )}
                            <div className="flex-1 space-y-1">
                              <div className="flex items-center justify-between">
                                <span className={`font-semibold text-xs ${isDone ? 'text-emerald-200' : 'text-slate-200'}`}>
                                  {idx + 1}. {obj.title}
                                </span>
                                <button
                                  onClick={() => setRevealedHints({ ...revealedHints, [obj.id]: !hintVisible })}
                                  className="text-[11px] text-cyan-400 hover:text-cyan-300 flex items-center gap-1 font-medium"
                                >
                                  <HelpCircle className="w-3 h-3" />
                                  <span>{hintVisible ? 'Hide Hint' : 'Hint'}</span>
                                </button>
                              </div>
                              <p className="text-[11px] text-slate-400 leading-relaxed">
                                {obj.description}
                              </p>

                              {hintVisible && (
                                <div className="mt-2 p-2 rounded bg-cyan-950/40 border border-cyan-500/30 text-[11px] text-cyan-200 font-mono">
                                  {obj.hint}
                                </div>
                              )}
                            </div>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>

                {/* Exam Tips Box */}
                {module.examTips.length > 0 && (
                  <div className="p-3.5 rounded-lg bg-amber-500/10 border border-amber-500/20 space-y-2">
                    <div className="font-bold text-xs text-amber-300 flex items-center gap-1.5">
                      <Award className="w-3.5 h-3.5 text-amber-400" />
                      <span>Exam Trap & Scoring Advice</span>
                    </div>
                    <ul className="space-y-1.5 text-[11px] text-amber-200/90 leading-relaxed list-disc list-inside">
                      {module.examTips.map((tip, i) => (
                        <li key={i}>{tip}</li>
                      ))}
                    </ul>
                  </div>
                )}
              </div>
            )}

            {activeSideTab === 'visualizer' && (
              <div className="h-full">
                {renderVisualizer()}
              </div>
            )}

            {activeSideTab === 'concepts' && (
              <div className="space-y-4 text-xs">
                <div className="p-3.5 rounded-lg bg-slate-950 border border-slate-800 space-y-3">
                  <h3 className="font-bold text-slate-100 text-sm">Underlying System Architecture & Concepts</h3>
                  {module.solutionWalkthrough.map((step, idx) => (
                    <div key={idx} className="space-y-1 border-b border-slate-800/80 pb-3 last:border-b-0">
                      <div className="font-semibold text-cyan-300">
                        {idx + 1}. {step.title}
                      </div>
                      <p className="text-slate-300 text-[11px] leading-relaxed">
                        {step.underlyingConcept}
                      </p>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {activeSideTab === 'solution' && (
              <div className="space-y-3 text-xs">
                <div className="font-bold text-slate-200 text-xs">Verified Exam Solution Walkthrough</div>
                {module.solutionWalkthrough.map((step) => (
                  <div key={step.step} className="p-3 rounded-lg bg-slate-950 border border-slate-800 space-y-2">
                    <div className="flex items-center justify-between font-semibold text-slate-200">
                      <span>Step {step.step}: {step.title}</span>
                      <button
                        onClick={() => handleExecuteCommand(step.command.split('\n')[0])}
                        className="px-2 py-0.5 rounded bg-blue-600/30 hover:bg-blue-600/50 text-blue-300 font-mono text-[10px] border border-blue-500/30"
                      >
                        Run in Shell
                      </button>
                    </div>
                    <pre className="p-2 rounded bg-slate-900 border border-slate-800 font-mono text-cyan-300 text-[11px] whitespace-pre-wrap">
                      {step.command}
                    </pre>
                    <p className="text-slate-400 text-[11px] leading-relaxed">
                      {step.explanation}
                    </p>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>

        {/* Right Panel: Interactive Terminal Console (7 cols) */}
        <div className={`${mobilePane === 'terminal' ? 'flex' : 'hidden'} lg:flex lg:col-span-7 flex-col h-full min-h-0 overflow-hidden`}>
          <TerminalView
            shell={activeShell}
            cwd={cwd}
            history={history}
            onExecuteCommand={handleExecuteCommand}
            onClearHistory={() => setHistory([])}
            isDiskpartActive={isDiskpartActive}
            currentUser={state.currentUser}
            hostname={state.hostname}
            suggestedCommands={module.solutionWalkthrough.map(s => s.command.split('\n')[0])}
          />
        </div>
      </div>
    </div>
  );
};
