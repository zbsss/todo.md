import type { ProjectSummary, Ticket, WorkspaceInfo } from "./types";

export const automaticRefreshIntervalMs = 2000;

export type AutomaticRefreshState = {
  isLoading: boolean;
  hasDraft: boolean;
  hasTicketDrag: boolean;
  hasProjectDrag: boolean;
  hasProjectMenu: boolean;
  hasTicketMenu: boolean;
  hasProjectRename: boolean;
  hasOpenTaskSelector: boolean;
  hasLocalMutation: boolean;
  hasPendingImageUploads: boolean;
  hasActiveDraftSave: boolean;
};

export function canRunAutomaticRefresh(state: AutomaticRefreshState) {
  return (
    !state.isLoading &&
    !state.hasDraft &&
    !state.hasTicketDrag &&
    !state.hasProjectDrag &&
    !state.hasProjectMenu &&
    !state.hasTicketMenu &&
    !state.hasProjectRename &&
    !state.hasOpenTaskSelector &&
    !state.hasLocalMutation &&
    !state.hasPendingImageUploads &&
    !state.hasActiveDraftSave
  );
}

export function workspaceInfoChanged(current: WorkspaceInfo | null, next: WorkspaceInfo) {
  if (!current || current.baseDir !== next.baseDir || current.projects.length !== next.projects.length) {
    return true;
  }

  return current.projects.some((project, index) => projectChanged(project, next.projects[index]));
}

export function ticketsChanged(current: Ticket[], next: Ticket[]) {
  if (current.length !== next.length) {
    return true;
  }

  return current.some((ticket, index) => ticketChanged(ticket, next[index]));
}

function projectChanged(current: ProjectSummary, next: ProjectSummary) {
  return (
    current.id !== next.id ||
    current.name !== next.name ||
    current.path !== next.path ||
    current.ticketCount !== next.ticketCount
  );
}

function ticketChanged(current: Ticket, next: Ticket) {
  return (
    current.id !== next.id ||
    current.title !== next.title ||
    current.body !== next.body ||
    current.status !== next.status ||
    current.rank !== next.rank ||
    current.createdAt !== next.createdAt ||
    current.updatedAt !== next.updatedAt ||
    current.filePath !== next.filePath ||
    current.priority !== next.priority ||
    current.size !== next.size ||
    current.prLink !== next.prLink ||
    current.assignee !== next.assignee
  );
}
