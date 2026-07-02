import type { TaskPriority, TaskSize, Ticket } from "../app/types";
import { sortTickets, statusIndex } from "./ordering";

export type TableColumn = "title" | "status" | "assignee" | "priority" | "size" | "pr";
export type SortDirection = "asc" | "desc";
export type TableSort = {
  column: TableColumn;
  direction: SortDirection;
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

export function tableColumns(): TableColumn[] {
  return ["title", "status", "priority", "size", "assignee", "pr"];
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

  return compareStrings(tableColumnText(a, column), tableColumnText(b, column));
}

function rankOptionalValue<T extends string>(value: T | undefined, order: T[]) {
  const index = value ? order.indexOf(value) : -1;

  return index >= 0 ? index : order.length;
}

function tableColumnText(ticket: Ticket, column: TableColumn) {
  if (column === "title") {
    return ticket.title.toLowerCase();
  }

  if (column === "priority") {
    return (ticket.priority ?? "none").toLowerCase();
  }

  if (column === "size") {
    return (ticket.size ?? "none").toLowerCase();
  }

  if (column === "pr") {
    return (ticket.prLink ?? "").toLowerCase();
  }

  return (ticket.assignee ?? "").toLowerCase();
}

function compareStrings(a: string, b: string) {
  return a.localeCompare(b, undefined, {
    numeric: true,
    sensitivity: "base"
  });
}
