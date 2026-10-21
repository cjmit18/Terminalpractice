import { FileNode, SystemState, TerminalShell } from './terminal';

export type ExamTrack = 'lpi' | 'comptia-windows';

export type InteractiveSimType = 
  | 'terminal-only'
  | 'active-directory'
  | 'group-policy'
  | 'diskpart'
  | 'network-topology'
  | 'permission-matrix';

export interface CommandContext {
  command: string;
  exitCode: number;
  stdout: string;
}

export interface ModuleObjective {
  id: string;
  title: string;
  description: string;
  /** Hint ladder, gentlest first: a nudge toward the concept, then the command's shape with blanks, then `hint` (the answer). */
  nudge?: string;
  shape?: string;
  hint: string;
  verifier: (fs: FileNode, state: SystemState, ctx?: CommandContext) => boolean;
}

export interface ExamModule {
  id: string;
  track: ExamTrack;
  examCode: string;
  topicNumber: string; // e.g. "Topic 101.1" or "PBQ 1"
  title: string;
  /** One plain sentence for the lab list */
  summary: string;
  difficulty: 'Beginner' | 'Intermediate' | 'Advanced';
  estimatedMinutes: number;
  scenarioDescription: string;
  systemContext: string; // context box (e.g. "Host: web01.corp.internal | Role: System Administrator")
  defaultShell: TerminalShell;
  allowedShells: TerminalShell[];
  simType: InteractiveSimType;
  objectives: ModuleObjective[];
  initialFs: FileNode;
  initialState: SystemState;
  solutionWalkthrough: {
    step: number;
    title: string;
    command: string;
    explanation: string;
    underlyingConcept: string;
  }[];
  examTips: string[];
  /**
   * Optional story note: the lab as a help-desk ticket from a coworker at Northwind Supplies, a
   * fictional small company. `ask` shows above the scenario, `thanks` in the finished-lab recap.
   * One or two plain sentences each. The learner (the admin) is "you" and never given a gender.
   */
  ticket?: LabTicket;
}

export interface LabTicket {
  /** Coworker's name */
  from: string;
  /** Their team or job, e.g. "Finance" */
  role: string;
  ask: string;
  thanks: string;
}
