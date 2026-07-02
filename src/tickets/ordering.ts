import type { Status, Ticket } from "../app/types";

export const orderedStatuses: Status[] = ["todo", "doing", "done"];
const rankAlphabet = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
const minRankDigit = rankAlphabet[0];

export type TicketPosition = { id: string; status: Status; rank: string };

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

export function rankForInsertion(tickets: Ticket[], ticketId: string, status: Status) {
  const columnTickets = tickets.filter((ticket) => ticket.status === status);
  const index = columnTickets.findIndex((ticket) => ticket.id === ticketId);

  if (index === -1) {
    throw new Error("Ticket not found in target column.");
  }

  const previousRank = columnTickets[index - 1]?.rank;
  const nextRank = columnTickets[index + 1]?.rank;
  const currentRank = columnTickets[index]?.rank;

  return isRankBetween(currentRank, previousRank, nextRank) ? currentRank : rankBetween(previousRank, nextRank);
}

export function sortTickets(a: Ticket, b: Ticket) {
  return statusIndex(a.status) - statusIndex(b.status) || compareRanks(a.rank, b.rank) || a.title.localeCompare(b.title);
}

export function statusIndex(status: Status) {
  return orderedStatuses.indexOf(status);
}

export function rankBetween(previousRank?: string, nextRank?: string) {
  if (previousRank && !isValidRank(previousRank)) {
    throw new Error("Invalid previous rank.");
  }

  if (nextRank && !isValidRank(nextRank)) {
    throw new Error("Invalid next rank.");
  }

  if (previousRank && nextRank && compareRanks(previousRank, nextRank) >= 0) {
    throw new Error("Previous rank must sort before next rank.");
  }

  return midpoint(previousRank ?? "", nextRank);
}

export function isValidRank(rank: string) {
  return rank.length > 0 && !rank.endsWith(minRankDigit) && Array.from(rank).every((digit) => rankAlphabet.includes(digit));
}

export function rankFromLegacyOrder(order: number, title = "", filePath = "") {
  const normalizedOrder = Number.isFinite(order) ? Math.trunc(order) : 0;
  const shiftedOrder = BigInt(normalizedOrder) + 9223372036854775808n;

  return `U${shiftedOrder.toString().padStart(20, "0")}V${rankTieBreaker(title)}0${rankTieBreaker(filePath)}V`;
}

function isRankBetween(rank: string, previousRank?: string, nextRank?: string) {
  return (!previousRank || compareRanks(previousRank, rank) < 0) && (!nextRank || compareRanks(rank, nextRank) < 0);
}

function compareRanks(a: string, b: string) {
  return a < b ? -1 : a > b ? 1 : 0;
}

function rankTieBreaker(value: string) {
  return Array.from(new TextEncoder().encode(value.toLowerCase()))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function midpoint(previousRank: string, nextRank?: string): string {
  let sharedPrefixLength = 0;

  if (nextRank) {
    while ((previousRank[sharedPrefixLength] ?? minRankDigit) === nextRank[sharedPrefixLength]) {
      sharedPrefixLength += 1;
    }

    if (sharedPrefixLength > 0) {
      return `${nextRank.slice(0, sharedPrefixLength)}${midpoint(
        previousRank.slice(sharedPrefixLength),
        nextRank.slice(sharedPrefixLength)
      )}`;
    }
  }

  const previousDigit = previousRank ? rankAlphabet.indexOf(previousRank[0]) : 0;
  const nextDigit = nextRank ? rankAlphabet.indexOf(nextRank[0]) : rankAlphabet.length;

  if (nextDigit - previousDigit > 1) {
    return rankAlphabet[Math.round((previousDigit + nextDigit) / 2)];
  }

  if (nextRank && nextRank.length > 1) {
    return `${nextRank[0]}${midpoint(previousRank.slice(1), nextRank.slice(1))}`;
  }

  return `${rankAlphabet[previousDigit]}${midpoint(previousRank.slice(1))}`;
}
