// The drills on the Drills tab: each makes a question from a seed and checks a typed answer.
import { checkPortAnswer, generatePortQuestion } from './ports';
import { checkSubnetAnswer, generateSubnetQuestion } from './subnet';

/** What every drill question has, whatever the drill */
export interface DrillQuestion {
  seed: number;
  prompt: string;
  answer: string;
  explanation: string;
  /** A nudge that does not give the answer away */
  hint: string;
}

export interface Drill {
  id: 'subnet' | 'ports';
  /** The choice's label and the section heading */
  title: string;
  /** One line under the heading */
  blurb: string;
  generate: (seed: number) => DrillQuestion;
  check: (question: DrillQuestion, typed: string) => boolean;
  /** The activity fact kept once a question of this drill is answered right */
  fact: string;
  /** Answers are addresses and numbers (shown in monospace) rather than names */
  mono: boolean;
}

export const DRILLS: readonly Drill[] = [
  {
    id: 'subnet',
    title: 'Subnetting',
    blurb: 'Network and broadcast addresses, host ranges, masks and prefix lengths, on private addresses from /16 to /30.',
    generate: seed => generateSubnetQuestion(seed),
    check: (q, typed) => checkSubnetAnswer(q as ReturnType<typeof generateSubnetQuestion>, typed),
    fact: 'drill:subnet',
    mono: true,
  },
  {
    id: 'ports',
    title: 'Ports and protocols',
    blurb: 'The 20 ports and protocols on the Network+ (N10-009) objectives: port numbers, which protocol uses a port, and TCP or UDP.',
    generate: seed => generatePortQuestion(seed),
    check: (q, typed) => checkPortAnswer(q as ReturnType<typeof generatePortQuestion>, typed),
    fact: 'drill:ports',
    mono: false,
  },
];
