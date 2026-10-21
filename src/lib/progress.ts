import { ExamModule } from '../types/modules';
import type { SyncedCodec } from './syncedStorage';

/** moduleId -> ids of the objectives completed in that module */
export type Progress = Record<string, string[]>;

export const PROGRESS_KEY = 'certsim:progress:v1';

/**
 * What is saved under PROGRESS_KEY: the completed objectives plus a reset tombstone per module.
 *
 * Several tabs can have the app open at once, and each keeps its own copy in memory. A save never
 * writes that copy as it is: it reads storage again and merges (mergeProgress), and every tab
 * merges what another tab wrote as soon as the `storage` event arrives (useSyncedStorage).
 *
 * Reset rule: a reset does not just delete a module's entries, because a union merge with another
 * tab's copy would bring them straight back. It records `resetAt[moduleId] = time of the reset`.
 * When two copies are merged, the newest reset time of each module wins, and a copy whose own reset
 * time for that module is older has not seen that reset yet, so its entries for the module are
 * dropped. A reset therefore reaches every tab and is never undone by one. The one cost: an
 * objective a tab completes in the few milliseconds before another tab's reset reaches it is
 * dropped with the rest.
 *
 * Forward compatibility: the record keeps modules and objectives this build does not know (saved by
 * a newer build, e.g. in another tab after a deploy) through parse, merge and save, so an older tab
 * never deletes them. Only what is shown and counted is cleaned, with sanitizeProgress.
 */
export interface ProgressRecord {
  done: Progress;
  /** moduleId -> time (ms since epoch) of the last reset of that module */
  resetAt: Record<string, number>;
}

export const EMPTY_PROGRESS: ProgressRecord = { done: {}, resetAt: {} };

/** Field of the saved object that holds the tombstones. It is not a module id, so older builds ignore it. */
const RESET_FIELD = '#resetAt';

const isTime = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v > 0;

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

const isId = (v: unknown): v is string => typeof v === 'string' && v.length > 0 && v.length <= 200;

/** Ids in canonical order: the known modules in module order, then any others sorted. */
function canonicalKeys(keys: Iterable<string>, modules: ExamModule[]): string[] {
  const all = new Set(keys);
  const known = modules.map(m => m.id).filter(id => all.has(id));
  const knownSet = new Set(known);
  return [...known, ...[...all].filter(k => !knownSet.has(k)).sort()];
}

/**
 * The saved object (completed objectives and tombstones), well-formed and in canonical order, keeping
 * modules and objectives this build does not know (see the note on ProgressRecord). Known
 * objectives come first in the module's own order, unknown ones after them, sorted.
 */
export function sanitizeProgressRecord(raw: unknown, modules: ExamModule[]): ProgressRecord {
  const data = raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  const byId = new Map(modules.map(m => [m.id, m]));
  const done: Progress = {};
  for (const id of canonicalKeys(Object.keys(data).filter(k => k !== RESET_FIELD && isId(k)), modules)) {
    const ids = data[id];
    if (!Array.isArray(ids)) continue;
    const given = new Set(ids.filter(isId));
    const order = byId.get(id)?.objectives.map(o => o.id) ?? [];
    const list = [...order.filter(o => given.has(o)), ...[...given].filter(o => !order.includes(o)).sort()];
    if (list.length > 0) done[id] = list;
  }
  const resetAt: Record<string, number> = {};
  const tombs = data[RESET_FIELD];
  if (tombs && typeof tombs === 'object' && !Array.isArray(tombs)) {
    const t = tombs as Record<string, unknown>;
    for (const id of canonicalKeys(Object.keys(t).filter(isId), modules)) if (isTime(t[id])) resetAt[id] = t[id] as number;
  }
  return { done, resetAt };
}

export function parseProgress(text: string | null, modules: ExamModule[]): ProgressRecord {
  if (!text) return EMPTY_PROGRESS;
  try {
    return sanitizeProgressRecord(JSON.parse(text), modules);
  } catch {
    return EMPTY_PROGRESS;
  }
}

/** Null (remove the key) only when there is nothing to keep, not even a tombstone. */
export function serializeProgress(r: ProgressRecord): string | null {
  const hasTombs = Object.keys(r.resetAt).length > 0;
  if (Object.keys(r.done).length === 0 && !hasTombs) return null;
  return JSON.stringify(hasTombs ? { ...r.done, [RESET_FIELD]: r.resetAt } : r.done);
}

/**
 * Merge two copies of the progress record (see the reset rule on ProgressRecord): per module, the
 * union of the objectives of each copy that has seen the newest reset of that module.
 */
export function mergeProgress(a: ProgressRecord, b: ProgressRecord, modules: ExamModule[]): ProgressRecord {
  const raw: Record<string, unknown> = {};
  const resetAt: Record<string, number> = {};
  // Every module either copy mentions, known to this build or not
  const ids = new Set([a.done, b.done, a.resetAt, b.resetAt].flatMap(o => Object.keys(o)));
  for (const id of ids) {
    const ra = a.resetAt[id] ?? 0;
    const rb = b.resetAt[id] ?? 0;
    const r = Math.max(ra, rb);
    if (r > 0) resetAt[id] = r;
    const objs = [...(ra >= r ? (a.done[id] ?? []) : []), ...(rb >= r ? (b.done[id] ?? []) : [])];
    if (objs.length) raw[id] = objs;
  }
  return sanitizeProgressRecord({ ...raw, [RESET_FIELD]: resetAt }, modules);
}

export function completeObjective(r: ProgressRecord, moduleId: string, objectiveId: string): ProgressRecord {
  const done = r.done[moduleId] ?? [];
  return done.includes(objectiveId) ? r : { ...r, done: { ...r.done, [moduleId]: [...done, objectiveId] } };
}

/** Forget these modules' progress, in every tab, by writing a tombstone for each (see ProgressRecord). */
export function resetModules(r: ProgressRecord, moduleIds: string[], now: number = Date.now()): ProgressRecord {
  const done = { ...r.done };
  const resetAt = { ...r.resetAt };
  for (const id of moduleIds) {
    delete done[id];
    // Strictly newer than any earlier reset, even if the clock went back
    resetAt[id] = Math.max(now, (resetAt[id] ?? 0) + 1);
  }
  return { done, resetAt };
}

/** How useSyncedStorage reads, merges and writes the progress record. */
export function progressCodec(modules: ExamModule[]): SyncedCodec<ProgressRecord> {
  return {
    parse: text => parseProgress(text, modules),
    merge: (stored, mine) => mergeProgress(stored, mine, modules),
    serialize: serializeProgress,
  };
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
