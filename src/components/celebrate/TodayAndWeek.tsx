import React from 'react';
import { Check } from 'lucide-react';
import { DayRecap, dayKey, dayRecap, recapIsEmpty, weekGoal } from '../../lib/activity';
import { useGameLayer } from './GameLayer';

const MAX_NAMES = 8;
const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

const localDate = (day: string) => {
  const [y, m, d] = day.split('-').map(Number);
  return new Date(y, m - 1, d);
};

const weekdayName = (day: string, style: 'narrow' | 'long') => {
  try {
    return localDate(day).toLocaleDateString(undefined, { weekday: style });
  } catch {
    return day;
  }
};

/** "6 tasks, 1 checkpoint passed, 4 new commands" and the command names, from what was new today */
function recapParts(r: DayRecap): string[] {
  const parts: string[] = [];
  if (r.tasks) parts.push(plural(r.tasks, 'task', 'tasks'));
  if (r.labs) parts.push(`${plural(r.labs, 'lab', 'labs')} finished`);
  if (r.lessons) parts.push(`${plural(r.lessons, 'lesson', 'lessons')} read`);
  if (r.checkpoints) parts.push(`${plural(r.checkpoints, 'checkpoint', 'checkpoints')} passed`);
  if (r.commands.length) parts.push(plural(r.commands.length, 'new command', 'new commands'));
  return parts;
}

/**
 * On the Learn page: what you did today (only when something happened), and this week against
 * the weekly goal (only when the goal is on). Nothing here is ever negative: days without practice
 * are plain empty marks, and the one total, weeks you met your goal, never goes down.
 */
export const TodayAndWeek: React.FC = () => {
  const { activity, weekStart } = useGameLayer();
  const today = dayKey();
  const recap = dayRecap(activity, today);
  const week = weekGoal(activity, today, weekStart);
  if (recapIsEmpty(recap) && !week) return null;

  const parts = recapParts(recap);
  const names = recap.commands.slice(0, MAX_NAMES);
  const more = recap.commands.length - names.length;

  return (
    <section aria-label="Today and this week" className="mt-8 space-y-5 max-w-prose">
      {!recapIsEmpty(recap) && (
        <p data-testid="today-recap" className="text-[15px]">
          <span className="font-medium">Today:</span> {parts.join(', ')}
          {names.length > 0 && (
            <>
              {' ('}
              {names.map((n, i) => (
                <React.Fragment key={n}>
                  {i > 0 && ', '}
                  <code className="font-mono text-[0.95em]">{n}</code>
                </React.Fragment>
              ))}
              {more > 0 && `, and ${more} more`}
              {')'}
            </>
          )}
          .
        </p>
      )}

      {week && (
        <div className="space-y-2" data-testid="weekly-goal">
          <h2 className="text-base font-semibold text-text">This week</h2>
          <ol aria-label="Days this week" className="flex gap-1.5">
            {week.days.map((d, i) => {
              const done = week.practised[i];
              const isToday = d === today;
              return (
                <li key={d} className="flex flex-col items-center gap-1 w-9">
                  <span
                    aria-hidden="true"
                    className={`inline-flex items-center justify-center size-7 rounded-sm ${
                      done ? 'bg-ok-soft text-ok' : 'border border-line-strong'
                    }`}
                  >
                    {done && <Check className="size-4" />}
                  </span>
                  <span aria-hidden="true" className={`text-xs ${isToday ? 'font-semibold text-text' : 'text-muted'}`}>
                    {weekdayName(d, 'narrow')}
                  </span>
                  <span className="sr-only">
                    {weekdayName(d, 'long')}
                    {isToday ? ', today' : ''}
                    {done ? ', practised' : ''}
                  </span>
                </li>
              );
            })}
          </ol>
          <p className="text-sm text-text">
            {week.met
              ? 'You met this week’s goal.'
              : week.count === 0
                ? `Your goal: practise on ${plural(week.goal, 'day', 'days')} this week. Rest days are fine.`
                : `${week.count} of ${plural(week.goal, 'day', 'days')} so far. Rest days are fine.`}
          </p>
          {week.weeksMet > 0 && (
            <p className="text-sm text-muted">Weeks you met your goal: {week.weeksMet}</p>
          )}
        </div>
      )}
    </section>
  );
};
