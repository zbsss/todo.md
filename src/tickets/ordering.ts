import type { Status, Ticket } from "../app/types";

export const orderedStatuses: Status[] = ["todo", "doing", "done"];

export function insertTicket(tickets: Ticket[], ticket: Ticket, status: Status, beforeId?: string) {
  const next: Ticket[] = [];
  let inserted = false;

  for (const candidate of [...tickets].sort(sortTickets)) {
    if (candidate.status === status && beforeId && candidate.id === beforeId) {
      next.push(ticket);
      inserted = true;
    }

    next.push(candidate);
  }

  if (!inserted) {
    next.push(ticket);
  }

  return next;
}

export function renumberTickets(tickets: Ticket[]) {
  const nextPositions: Array<{ id: string; status: Status; order: number }> = [];

  for (const status of orderedStatuses) {
    tickets
      .filter((ticket) => ticket.status === status)
      .forEach((ticket, index) => {
        ticket.order = (index + 1) * 1000;
        nextPositions.push({
          id: ticket.id,
          status: ticket.status,
          order: ticket.order
        });
      });
  }

  return nextPositions;
}

export function sortTickets(a: Ticket, b: Ticket) {
  return statusIndex(a.status) - statusIndex(b.status) || a.order - b.order || a.title.localeCompare(b.title);
}

export function statusIndex(status: Status) {
  return orderedStatuses.indexOf(status);
}
