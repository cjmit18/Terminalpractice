/**
 * Wording for the quiet celebrations. Pure, so the batching rules can be tested: several things
 * that happen together (a walkthrough step that finishes three tasks, the badge it earns) become
 * one message, so a screen reader hears one sentence group instead of a burst.
 */

export type Announcement =
  /** A lab task passed: `index` is its 1-based position among the lab's tasks */
  | { kind: 'task'; title: string; index: number; total: number }
  /** A badge was earned */
  | { kind: 'badge'; name: string; description: string }
  /** A lab, checkpoint, stage or path was finished */
  | { kind: 'milestone'; text: string; confetti?: boolean };

export interface Batch {
  text: string;
  /** Contains a badge or milestone: the note stays until dismissed */
  lasting: boolean;
  confetti: boolean;
}

const sentence = (s: string) => (/[.?]$/.test(s.trim()) ? s.trim() : `${s.trim()}.`);

export function batchMessage(items: Announcement[]): Batch | null {
  if (items.length === 0) return null;
  const parts: string[] = [];

  const tasks = items.filter((i): i is Extract<Announcement, { kind: 'task' }> => i.kind === 'task');
  // The same task can be reported twice when two copies of a lab are open; say it once
  const uniqueTasks = tasks.filter((t, i) => tasks.findIndex(u => u.title === t.title) === i);
  if (uniqueTasks.length === 1) {
    const t = uniqueTasks[0];
    parts.push(sentence(`Task ${t.index} of ${t.total} done: ${t.title}`));
  } else if (uniqueTasks.length > 1) {
    parts.push(sentence(`${uniqueTasks.length} tasks done: ${uniqueTasks.map(t => t.title).join('; ')}`));
  }

  const milestones = items.filter((i): i is Extract<Announcement, { kind: 'milestone' }> => i.kind === 'milestone');
  for (const m of milestones) if (!parts.includes(sentence(m.text))) parts.push(sentence(m.text));

  const badges = items.filter((i): i is Extract<Announcement, { kind: 'badge' }> => i.kind === 'badge');
  if (badges.length === 1) {
    parts.push(`Badge earned: ${sentence(badges[0].name)} ${sentence(badges[0].description)}`);
  } else if (badges.length > 1) {
    parts.push(sentence(`${badges.length} badges earned: ${badges.map(b => b.name).join('; ')}`));
  }

  return {
    text: parts.join(' '),
    lasting: milestones.length > 0 || badges.length > 0,
    confetti: milestones.some(m => m.confetti),
  };
}
