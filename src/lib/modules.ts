import { ExamModule } from '../types/modules';
import { LPI_MODULES } from '../data/lpiModules';
import { WINDOWS_PBQS } from '../data/windowsPbqs';
import { TrackSection } from './router';

const byTopic = (a: ExamModule, b: ExamModule) =>
  topicLabel(a).localeCompare(topicLabel(b), undefined, { numeric: true });

/** Modules per track, in syllabus order (by topic number). */
export const TRACK_MODULES: Record<TrackSection, ExamModule[]> = {
  linux: [...LPI_MODULES].sort(byTopic),
  windows: [...WINDOWS_PBQS].sort(byTopic),
};

export const ALL_MODULES: ExamModule[] = [...TRACK_MODULES.linux, ...TRACK_MODULES.windows];

export const TRACK_NAMES: Record<TrackSection, string> = {
  linux: 'Linux labs',
  windows: 'Windows labs',
};

/** "Topic 104.5" -> "104.5", "CompTIA PBQ 3" -> "PBQ 3" */
export function topicLabel(mod: ExamModule): string {
  return mod.topicNumber.replace(/^(topic|comptia)\s+/i, '').trim();
}

/**
 * One sentence for the catalog. Uses the scenario text without a leading
 * "Security Audit Warning:"-style label, cut at the first sentence end.
 */
export function moduleSummary(mod: ExamModule): string {
  const text = mod.scenarioDescription.replace(/^[A-Z][\w &/#+()-]{0,48}:\s+/, '').trim();
  const match = text.match(/^.+?[.?](?=\s+[A-Z"(]|$)/);
  return (match ? match[0] : text).trim();
}
