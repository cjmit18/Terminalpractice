import type { ExamModule } from '../../types/modules';
import type { LearningPath } from '../../types/paths';
import type { Badge } from '../../data/badges';
import { Activity, prefsOf } from '../../lib/activity';
import { Journey, labCheck, pathStarted, stageComplete } from '../../lib/journey';

export interface SummaryInputs {
  activity: Activity;
  badges: Badge[];
  progress: Record<string, string[]>;
  journey: Journey;
  paths: LearningPath[];
  modules: ExamModule[];
  /** Weeks the goal was met (0 when the goal is off or never met) */
  weeksMet: number;
  date?: Date;
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/**
 * "Copy my progress summary": plain text the learner pastes wherever they like. Only what they
 * finished, no scores, no times, no name. Badges are left out while badges are hidden.
 */
export function progressSummaryText(inp: SummaryInputs): string {
  const src = { journey: inp.journey, labComplete: labCheck(inp.progress, inp.modules) };
  let date = '';
  try {
    date = (inp.date ?? new Date()).toLocaleDateString(undefined, { day: 'numeric', month: 'long', year: 'numeric' });
  } catch {
    date = '';
  }
  const lines = [date ? `My progress in Terminus CertSim, ${date}` : 'My progress in Terminus CertSim', ''];

  const started = inp.paths.filter(p => pathStarted(p, src));
  if (started.length === 0) lines.push('Learning paths: none started yet');
  else {
    lines.push('Learning paths:');
    for (const p of started) {
      const done = p.stages.filter(st => stageComplete(p.id, st, src)).length;
      const n = p.stages.length;
      const status = done === n ? (n === 1 ? 'done' : `all ${n} stages done`) : `${done} of ${plural(n, 'stage', 'stages')} done`;
      lines.push(`- ${p.title} (${p.exam}): ${status}`);
    }
  }

  const labs = inp.modules.filter(m => src.labComplete(m.id)).length;
  lines.push(`Labs finished: ${labs} of ${inp.modules.length}`);

  if (prefsOf(inp.activity).showBadges) {
    const earned = inp.badges
      .filter(b => b.id in inp.activity.badges)
      .sort((a, b) => inp.activity.badges[a.id] - inp.activity.badges[b.id]);
    if (earned.length) lines.push(`Badges (${earned.length}): ${earned.map(b => b.name).join('; ')}`);
  }
  if (inp.weeksMet > 0) lines.push(`Weeks I met my practice goal: ${inp.weeksMet}`);
  return lines.join('\n');
}
