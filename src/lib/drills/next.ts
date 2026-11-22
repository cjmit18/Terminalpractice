// Choosing the next drill question: never the same question twice in a row (#84 review).
import { randomSeed } from '../rotation';
import { generateSubnetQuestion } from './subnet';

/**
 * A seed whose question's prompt differs from `previousPrompt`. Most seeds already do (only small pools,
 * such as "a /27 has how many hosts?" or a port question, come round again), so a few tries are plenty.
 */
export function nextSeed(
  generate: (seed: number) => { prompt: string },
  previousPrompt: string | null,
  makeSeed: () => number = randomSeed,
): number {
  let seed = makeSeed();
  for (let tries = 0; previousPrompt !== null && tries < 20 && generate(seed).prompt === previousPrompt; tries++) {
    seed = makeSeed();
  }
  return seed;
}

/** nextSeed for the subnetting drill */
export const nextSubnetSeed = (previousPrompt: string | null, makeSeed: () => number = randomSeed): number =>
  nextSeed(s => generateSubnetQuestion(s), previousPrompt, makeSeed);
