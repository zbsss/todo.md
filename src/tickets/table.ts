import type { Status, TaskPriority, TaskSize, Ticket } from "../app/types";
import { sortTickets, statusIndex } from "./ordering";

export type TableColumn = "title" | "status" | "assignee" | "priority" | "size" | "pr";
export type SortDirection = "asc" | "desc";
export type TableSort = {
  column: TableColumn;
  direction: SortDirection;
};
export type TableFilters = Partial<Record<TableColumn, string>>;

const statusLabels: Record<Status, string> = {
  todo: "To do",
  doing: "Doing",
  done: "Done"
};
const priorityOrder: TaskPriority[] = ["P0", "P1", "P2", "P3", "P4"];
const sizeOrder: TaskSize[] = ["XS", "S", "M", "L", "XL"];

export const defaultTableSorts: TableSort[] = [
  { column: "status", direction: "asc" },
  { column: "priority", direction: "asc" }
];

export function sortTicketsForTable(tickets: Ticket[], sort: TableSort | null) {
  const sorts = sort ? [sort] : defaultTableSorts;

  return [...tickets].sort((a, b) => compareTicketsForSorts(a, b, sorts) || sortTickets(a, b));
}

export function filterTicketsForTable(tickets: Ticket[], filters: TableFilters) {
  const activeFilters = tableColumns()
    .map((column) => ({ column, value: filters[column]?.trim().toLowerCase() ?? "" }))
    .filter((filter) => filter.value.length > 0);

  if (!activeFilters.length) {
    return tickets;
  }

  return tickets.filter((ticket) =>
    activeFilters.every((filter) => tableFilterText(ticket, filter.column).includes(filter.value))
  );
}

export function hasActiveTableFilters(filters: TableFilters) {
  return tableColumns().some((column) => Boolean(filters[column]?.trim()));
}

export function tableColumns(): TableColumn[] {
  return ["title", "status", "assignee", "priority", "size", "pr"];
}

function compareTicketsForSorts(a: Ticket, b: Ticket, sorts: TableSort[]) {
  for (const sort of sorts) {
    const compared = compareTicketsByColumn(a, b, sort.column);

    if (compared !== 0) {
      return sort.direction === "asc" ? compared : -compared;
    }
  }

  return 0;
}

function compareTicketsByColumn(a: Ticket, b: Ticket, column: TableColumn) {
  if (column === "status") {
    return statusIndex(a.status) - statusIndex(b.status);
  }

  if (column === "priority") {
    return rankOptionalValue(a.priority, priorityOrder) - rankOptionalValue(b.priority, priorityOrder);
  }

  if (column === "size") {
    return rankOptionalValue(a.size, sizeOrder) - rankOptionalValue(b.size, sizeOrder);
  }

  return compareStrings(tableFilterText(a, column), tableFilterText(b, column));
}

function rankOptionalValue<T extends string>(value: T | undefined, order: T[]) {
  const index = value ? order.indexOf(value) : -1;

  return index >= 0 ? index : order.length;
}

function tableFilterText(ticket: Ticket, column: TableColumn) {
  if (column === "title") {
    return ticket.title.toLowerCase();
  }

  if (column === "status") {
    return `${ticket.status} ${statusLabels[ticket.status]}`.toLowerCase();
  }

  if (column === "priority") {
    return (ticket.priority ?? "none").toLowerCase();
  }

  if (column === "size") {
    return (ticket.size ?? "none").toLowerCase();
  }

  if (column === "pr") {
    return formatPrFilterText(ticket.prLink);
  }

  return formatAssigneeFilterText(ticket.assignee);
}

function compareStrings(a: string, b: string) {
  return a.localeCompare(b, undefined, {
    numeric: true,
    sensitivity: "base"
  });
}

function formatPrFilterText(value: string | undefined) {
  if (!value?.trim()) {
    return "empty";
  }

  const pullRequest = value.match(/\/pull\/(\d+)(?:[/?#]|$)/i);
  const label = pullRequest ? `#${pullRequest[1]}` : "";

  return `${value} ${label}`.toLowerCase();
}

function formatAssigneeFilterText(value: string | undefined) {
  if (!value?.trim()) {
    return "empty";
  }

  const codexThread = value.match(/^codex:\/\/threads\/([^/?#]+)/i);
  const label = codexThread ? codexThread[1].slice(0, 8) : "";

  return `${value} ${label}`.toLowerCase();
}
