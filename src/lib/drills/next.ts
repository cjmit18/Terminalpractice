// Choosing the next drill question: never the same question twice in a row (#84 review).
import { randomSeed } from '../rotation';
import { generateSubnetQuestion } from './subnet';

/**
 * A seed for the next subnetting question whose prompt differs from `previousPrompt`. Most seeds already
 * do (only small questions like "a /27 has how many hosts?" come round again), so a few tries are plenty.
 */
export function nextSubnetSeed(previousPrompt: string | null, makeSeed: () => number = randomSeed): number {
  let seed = makeSeed();
  for (let tries = 0; previousPrompt !== null && tries < 20 && generateSubnetQuestion(seed).prompt === previousPrompt; tries++) {
    seed = makeSeed();
  }
  return seed;
}
