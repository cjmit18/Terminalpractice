import { FileNode, SystemState, TerminalShell } from './terminal';

export type ExamTrack = 'lpi' | 'comptia-windows';

export type InteractiveSimType = 
  | 'terminal-only'
  | 'active-directory'
  | 'group-policy'
  | 'diskpart'
  | 'network-topology'
  | 'permission-matrix';

export interface ModuleObjective {
  id: string;
  title: string;
  description: string;
  hint: string;
  verifier: (fs: FileNode, state: SystemState, lastCommand?: string) => boolean;
}

export interface ExamModule {
  id: string;
  track: ExamTrack;
  examCode: string;
  topicNumber: string; // e.g. "Topic 101.1" or "PBQ 1"
  title: string;
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
}
