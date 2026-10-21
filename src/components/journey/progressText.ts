import { LearningPath } from '../../types/paths';
import { CompletionSource, currentStageIndex, pathPercent } from '../../lib/journey';

/** "Stage 2 of 4 · 40%", or "All 4 stages done · 100%" once finished. */
export function pathProgressText(path: LearningPath, src: CompletionSource): string {
  const percent = pathPercent(path, src);
  const stage = currentStageIndex(path, src);
  const n = path.stages.length;
  if (stage < 0) return n === 1 ? 'Done · 100%' : `All ${n} stages done · 100%`;
  return `Stage ${stage + 1} of ${n} · ${percent}%`;
}

export const stagesText = (n: number) => (n === 1 ? '1 stage' : `${n} stages`);
