// Generated subnetting drills (docs/CONTENT_PLAN.md, section 1; LPIC-1 109.1 and Network+ 1.0).
// A question is made from a seed, and its answer is worked out from the same numbers, so there is no
// answer key to memorise: a new seed is a new question. Nothing here touches the page or storage.
import { seededRandom } from '../rotation';

export type SubnetQuestionKind =
  | 'network' // the network address of the subnet an address is in
  | 'broadcast' // that subnet's broadcast address
  | 'first-host' // its first usable host address
  | 'last-host' // its last usable host address
  | 'host-count' // how many usable host addresses it has
  | 'mask' // the dotted mask for a prefix length
  | 'prefix' // the prefix length for a dotted mask
  | 'same-subnet'; // whether two addresses are in one subnet

export const SUBNET_KINDS: readonly SubnetQuestionKind[] = [
  'network', 'broadcast', 'first-host', 'last-host', 'host-count', 'mask', 'prefix', 'same-subnet',
];

export interface SubnetQuestion {
  seed: number;
  kind: SubnetQuestionKind;
  /** The question, in one plain sentence */
  prompt: string;
  /** The answer in its usual written form: a dotted address, a number, "/26", or "yes" / "no" */
  answer: string;
  /** How the answer is reached, shown after answering */
  explanation: string;
  /** Exam objective ids this practises (src/data/examObjectives.ts) */
  objectives: string[];
}

const OBJECTIVES = ['109.1', 'n10-009:1.0'];

// ---- Address arithmetic: addresses are unsigned 32-bit numbers ----

export const toDotted = (n: number): string => [24, 16, 8, 0].map(shift => (n >>> shift) & 255).join('.');

/** A dotted address as a number, or null when it is not four numbers from 0 to 255 */
export function parseDotted(text: string): number | null {
  const parts = text.trim().split('.');
  if (parts.length !== 4 || !parts.every(p => /^\d{1,3}$/.test(p) && Number(p) <= 255)) return null;
  return parts.reduce((n, p) => n * 256 + Number(p), 0);
}

/** The mask for a prefix length from 0 to 32 */
export const maskOf = (prefix: number): number => (prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0);
export const networkOf = (address: number, prefix: number): number => (address & maskOf(prefix)) >>> 0;
export const broadcastOf = (address: number, prefix: number): number => (networkOf(address, prefix) | ~maskOf(prefix)) >>> 0;
/** Usable host addresses in a subnet with this prefix (for /30 and shorter: all but the network and broadcast) */
export const hostCount = (prefix: number): number => 2 ** (32 - prefix) - 2;

// ---- Making a question ----

/** Private (RFC 1918) blocks, so every address in a drill is one a learner might really be given */
const PRIVATE_BLOCKS: [base: number, prefix: number][] = [
  [parseDotted('10.0.0.0')!, 8],
  [parseDotted('172.16.0.0')!, 12],
  [parseDotted('192.168.0.0')!, 16],
];

/** Prefix lengths a drill uses: mostly /24 to /30, the sizes worked by hand, with some shorter ones */
const PREFIXES = [16, 18, 20, 21, 22, 23, 24, 24, 25, 25, 26, 26, 27, 27, 28, 28, 29, 29, 30, 30];

export function generateSubnetQuestion(seed: number, kind?: SubnetQuestionKind): SubnetQuestion {
  const random = seededRandom(seed);
  const pick = <T,>(list: readonly T[]): T => list[Math.floor(random() * list.length)];
  // Drawn in a fixed order, so the same seed always gives the same question
  const drawnKind = pick(SUBNET_KINDS);
  const [base, blockPrefix] = pick(PRIVATE_BLOCKS);
  const prefix = pick(PREFIXES.filter(p => p >= blockPrefix));
  const within = Math.floor(random() * 2 ** (32 - blockPrefix));
  const offset = 1 + Math.floor(random() * hostCount(prefix));
  const other = Math.floor(random() * 2 ** (32 - prefix) * 2);
  const k = kind ?? drawnKind;

  // A host address (never the network or broadcast address) inside a random subnet of the block
  const network = networkOf((base + within) >>> 0, prefix);
  const address = (network + offset) >>> 0;
  const broadcast = broadcastOf(address, prefix);
  const cidr = `${toDotted(address)}/${prefix}`;
  const size = 2 ** (32 - prefix);
  const range = `${toDotted(network)} to ${toDotted(broadcast)}`;
  const block = `A /${prefix} leaves ${32 - prefix} host bits, so each subnet holds ${size} addresses. ${toDotted(address)} falls in ${range}.`;
  const make = (prompt: string, answer: string, explanation: string): SubnetQuestion => ({ seed, kind: k, prompt, answer, explanation, objectives: OBJECTIVES });

  switch (k) {
    case 'network':
      return make(`What is the network address of ${cidr}?`, toDotted(network), `${block} The first address of that range is the network address.`);
    case 'broadcast':
      return make(`What is the broadcast address of ${cidr}?`, toDotted(broadcast), `${block} The last address of that range is the broadcast address.`);
    case 'first-host':
      return make(`What is the first usable host address in the subnet of ${cidr}?`, toDotted(network + 1), `${block} The first usable host is one above the network address.`);
    case 'last-host':
      return make(`What is the last usable host address in the subnet of ${cidr}?`, toDotted(broadcast - 1), `${block} The last usable host is one below the broadcast address.`);
    case 'host-count':
      return make(
        `How many usable host addresses does a /${prefix} subnet have?`,
        String(hostCount(prefix)),
        `A /${prefix} leaves ${32 - prefix} host bits: 2 to the power ${32 - prefix} is ${size} addresses. Take away the network and broadcast addresses: ${hostCount(prefix)}.`,
      );
    case 'mask':
      return make(
        `What is the subnet mask for a /${prefix} network, in dotted form?`,
        toDotted(maskOf(prefix)),
        `A /${prefix} mask has ${prefix} one bits followed by ${32 - prefix} zero bits, which is ${toDotted(maskOf(prefix))}.`,
      );
    case 'prefix':
      return make(
        `What prefix length (CIDR notation) is the subnet mask ${toDotted(maskOf(prefix))}?`,
        `/${prefix}`,
        `${toDotted(maskOf(prefix))} has ${prefix} one bits before its first zero bit, so it is /${prefix}.`,
      );
    case 'same-subnet': {
      // The second address comes from this subnet or the one after it, so both answers turn up
      let second = (network + other) >>> 0;
      // Stay inside the private block, and never ask about the same address twice
      if (networkOf(second, blockPrefix) !== base) second = (second - size) >>> 0;
      if (second === address) second = address === broadcast - 1 ? address - 1 : address + 1;
      const same = networkOf(second, prefix) === network;
      return make(
        `Are ${toDotted(address)} and ${toDotted(second)} in the same /${prefix} subnet? Answer yes or no.`,
        same ? 'yes' : 'no',
        `${block} ${toDotted(second)} is ${same ? 'inside' : 'outside'} that range${same ? '' : `: it is in ${toDotted(networkOf(second, prefix))}/${prefix}`}.`,
      );
    }
  }
}

// ---- Checking an answer ----

/** True when what the learner typed means the same as the question's answer */
export function checkSubnetAnswer(question: SubnetQuestion, input: string): boolean {
  const typed = input.trim().toLowerCase();
  if (typed === '') return false;
  switch (question.kind) {
    case 'host-count':
      // 1,022 and 1 022 are the same number as 1022
      return /^\d[\d, ]*$/.test(typed) && Number(typed.replace(/[, ]/g, '')) === Number(question.answer);
    case 'prefix':
      // /26 and 26 both name the prefix
      return /^\/?\d{1,2}$/.test(typed) && Number(typed.replace('/', '')) === Number(question.answer.slice(1));
    case 'same-subnet':
      return (typed === 'y' ? 'yes' : typed === 'n' ? 'no' : typed) === question.answer;
    default: {
      // An address: 192.168.001.010 is the same address as 192.168.1.10
      const address = parseDotted(typed);
      return address !== null && address === parseDotted(question.answer);
    }
  }
}
