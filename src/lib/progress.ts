import { ExamModule } from '../types/modules';
import { readStorage, writeStorage } from './storage';

/** moduleId -> ids of the objectives completed in that module */
export type Progress = Record<string, string[]>;

export const PROGRESS_KEY = 'certsim:progress:v1';

/**
 * Keep only known modules and objectives from untrusted data, deduplicated and
 * in the module's own objective order. Anything malformed is dropped.
 */
export function sanitizeProgress(raw: unknown, modules: ExamModule[]): Progress {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const data = raw as Record<string, unknown>;
  const clean: Progress = {};
  for (const mod of modules) {
    const ids = data[mod.id];
    if (!Array.isArray(ids)) continue;
    const done = mod.objectives.map(o => o.id).filter(id => ids.includes(id));
    if (done.length > 0) clean[mod.id] = done;
  }
  return clean;
}

export function loadProgress(modules: ExamModule[]): Progress {
  const text = readStorage(PROGRESS_KEY);
  if (!text) return {};
  try {
    return sanitizeProgress(JSON.parse(text), modules);
  } catch {
    return {};
  }
}

export function saveProgress(progress: Progress): void {
  writeStorage(PROGRESS_KEY, Object.keys(progress).length ? JSON.stringify(progress) : null);
}

export function countDone(progress: Progress, modules: ExamModule[]) {
  let done = 0;
  let total = 0;
  for (const mod of modules) {
    total += mod.objectives.length;
    done += (progress[mod.id] ?? []).filter(id => mod.objectives.some(o => o.id === id)).length;
  }
  return { done, total };
}
