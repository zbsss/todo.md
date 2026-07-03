import type { Ticket } from "../app/types";

export type DependencyLookup = Map<string, Ticket>;

export type DependencyReference = {
  id: string;
  ticket: Ticket | null;
  isMissing: boolean;
  isDone: boolean;
};

export type DependencyCompletionSummary = {
  total: number;
  completed: number;
  missing: number;
};

export type DependencyChipSummary = {
  blockers: {
    active: number;
    total: number;
    missing: number;
  };
  subtasks: DependencyCompletionSummary;
};

export function createDependencyLookup(tickets: Ticket[]): DependencyLookup {
  return new Map(tickets.map((ticket) => [ticket.id, ticket]));
}

export function dependencyReferences(ids: string[], ticketsById: DependencyLookup): DependencyReference[] {
  return uniqueDependencyIds(ids).map((id) => {
    const ticket = ticketsById.get(id) ?? null;

    return {
      id,
      ticket,
      isMissing: !ticket,
      isDone: ticket?.status === "done"
    };
  });
}

export function dependencyCompletionSummary(ids: string[], ticketsById: DependencyLookup): DependencyCompletionSummary {
  const references = dependencyReferences(ids, ticketsById);

  return {
    total: references.length,
    completed: references.filter((reference) => reference.isDone).length,
    missing: references.filter((reference) => reference.isMissing).length
  };
}

export function dependencyChipSummary(ticket: Ticket, ticketsById: DependencyLookup): DependencyChipSummary {
  const blockers = dependencyReferences(ticket.blockedBy, ticketsById);

  return {
    blockers: {
      active: blockers.filter((reference) => !reference.isDone).length,
      total: blockers.length,
      missing: blockers.filter((reference) => reference.isMissing).length
    },
    subtasks: dependencyCompletionSummary(ticket.subtasks, ticketsById)
  };
}

export function hasDependencyLinks(ticket: Ticket) {
  return (
    ticket.parent.length > 0 ||
    ticket.subtasks.length > 0 ||
    ticket.blocks.length > 0 ||
    ticket.blockedBy.length > 0
  );
}

export function uniqueDependencyIds(ids: string[]) {
  return Array.from(new Set(ids.map((id) => id.trim()).filter(Boolean)));
}
