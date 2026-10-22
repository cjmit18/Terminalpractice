import React from 'react';
import type { LabTicket } from '../../types/modules';
import { useGameLayer } from '../celebrate/GameLayer';

/**
 * Story notes: each lab as a help-desk ticket from a coworker at Northwind Supplies (a fictional
 * company). They are on unless the learner turns them off with the `storyNotes` preference.
 */
export function useStoryNotes(): boolean {
  const { prefs } = useGameLayer();
  return (prefs as { storyNotes?: unknown }).storyNotes !== false;
}

/** The ask, shown above the lab's scenario. */
export const TicketAsk: React.FC<{ ticket?: LabTicket }> = ({ ticket }) => {
  const on = useStoryNotes();
  if (!ticket || !on) return null;
  return (
    <figure className="border-l-2 border-line-strong pl-3 space-y-1">
      <figcaption className="text-sm text-muted">
        Ticket from {ticket.from}, {ticket.role}
      </figcaption>
      <blockquote className="text-[15px] leading-relaxed">{ticket.ask}</blockquote>
    </figure>
  );
};

/** The thanks, shown with the finished-lab recap. */
export const TicketThanks: React.FC<{ ticket?: LabTicket }> = ({ ticket }) => {
  const on = useStoryNotes();
  if (!ticket || !on) return null;
  return (
    <figure className="mb-4 border-l-2 border-line-strong pl-3 space-y-1">
      <figcaption className="text-sm text-muted">Ticket closed</figcaption>
      <blockquote className="text-[15px] leading-relaxed">
        {ticket.thanks} <span className="text-muted">{ticket.from}, {ticket.role}</span>
      </blockquote>
    </figure>
  );
};
