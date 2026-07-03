import type {
  MockStore,
  ProjectSummary,
  Status,
  TaskPriority,
  TaskSize,
  Ticket,
  TicketDependencyRelationship,
  TicketDraft,
  TicketSearchField,
  TicketSearchMatch,
  TicketSearchResult,
  TicketSearchSegment
} from "../app/types";
import { escapeHtml } from "../markdown/escape";
import { bytesToDataUrl, imageExtensionForMime } from "../markdown/images";
import { normalizeStatus, rankBetween, rankFromLegacyOrder } from "../tickets/ordering";

const mockStorageKey = "todo.md-demo";

export type PersistMockDraftOptions = {
  projectId: string;
  draft: TicketDraft;
  title: string;
  body: string;
};

export type BrowserMockStore = ReturnType<typeof createMockStore>;

export const maxTicketSearchQueryLength = 200;

export function createMockStore() {
  const seed = (): MockStore => {
    const now = Date.now();
    const project: ProjectSummary = {
      id: "inbox",
      name: "Inbox",
      path: "~/todo.md/projects/inbox",
      ticketCount: 5
    };

    return {
      workspace: {
        baseDir: "~/todo.md/projects",
        projects: [project]
      },
      tickets: {
        inbox: [
          {
            id: "capture-app-ideas",
            title: "Capture app ideas",
            body: "Use **Markdown** for notes, links, and checklists.\n\n- Keep tickets portable\n- Make project folders easy to inspect",
            status: "draft",
            rank: rankBetween(),
            createdAt: now,
            updatedAt: now,
            filePath: "~/todo.md/projects/inbox/capture-app-ideas.md",
            priority: "P2",
            size: "M",
            parent: [],
            subtasks: [],
            blocks: [],
            blockedBy: []
          },
          {
            id: "prep-ai-ready-ticket",
            title: "Prep AI-ready ticket",
            body: "Move well-scoped work into Ready when an agent can pick it up.",
            status: "ready",
            rank: rankBetween(),
            createdAt: now,
            updatedAt: now,
            filePath: "~/todo.md/projects/inbox/prep-ai-ready-ticket.md",
            priority: "P1",
            size: "S",
            parent: [],
            subtasks: ["sketch-board-columns"],
            blocks: [],
            blockedBy: []
          },
          {
            id: "sketch-board-columns",
            title: "Sketch board columns",
            body: "Columns track the agent workflow:\n\n- Draft\n- Ready\n- Doing\n- Review\n- Done",
            status: "doing",
            rank: rankBetween(),
            createdAt: now,
            updatedAt: now,
            filePath: "~/todo.md/projects/inbox/sketch-board-columns.md",
            priority: "P1",
            size: "S",
            prLink: "https://github.com/zbsss/todo.md/pull/22",
            assignee: "codex://threads/019f239d-dd6d-7451-856c-3847cadaf912",
            parent: ["prep-ai-ready-ticket"],
            subtasks: [],
            blocks: ["review-agent-pr"],
            blockedBy: []
          },
          {
            id: "review-agent-pr",
            title: "Review agent PR",
            body: "A PR is open and waiting for human review.",
            status: "review",
            rank: rankBetween(),
            createdAt: now,
            updatedAt: now,
            filePath: "~/todo.md/projects/inbox/review-agent-pr.md",
            priority: "P2",
            size: "M",
            prLink: "https://github.com/zbsss/todo.md/pull/23",
            assignee: "codex://threads/019f239d-dd6d-7451-856c-3847cadaf913",
            parent: [],
            subtasks: [],
            blocks: [],
            blockedBy: ["sketch-board-columns"]
          },
          {
            id: "keep-tickets-local",
            title: "Keep tickets local",
            body: "Every card is backed by a plain `.md` file on disk.",
            status: "done",
            rank: rankBetween(),
            createdAt: now,
            updatedAt: now,
            filePath: "~/todo.md/projects/inbox/keep-tickets-local.md",
            parent: [],
            subtasks: [],
            blocks: [],
            blockedBy: []
          }
        ]
      }
    };
  };

  const read = (): MockStore => {
    const raw = localStorage.getItem(mockStorageKey);

    if (!raw) {
      const next = seed();
      write(next);
      return next;
    }

    return normalizeStore(JSON.parse(raw) as MockStore);
  };

  const write = (store: MockStore) => localStorage.setItem(mockStorageKey, JSON.stringify(store));
  const slugify = (value: string) =>
    value
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "") || "untitled";

  return {
    async getWorkspaceInfo() {
      return read().workspace;
    },
    async createProject(name: string) {
      const store = read();
      const id = `${Date.now()}-${slugify(name)}`;
      const project: ProjectSummary = {
        id,
        name,
        path: `~/todo.md/projects/${id}`,
        ticketCount: 0
      };

      store.workspace.projects.push(project);
      store.tickets[id] = [];
      write(store);

      return project;
    },
    async importProject(path: string) {
      const store = read();
      const name = path.trim();
      const id = `${Date.now()}-${slugify(name)}`;
      const project: ProjectSummary = {
        id,
        name,
        path: `~/todo.md/projects/${id}`,
        ticketCount: 0
      };

      store.workspace.projects.push(project);
      store.tickets[id] = [];
      write(store);

      return project;
    },
    async updateProjectName(projectId: string, name: string) {
      const store = read();
      let updated: ProjectSummary | null = null;

      store.workspace.projects = store.workspace.projects.map((project) => {
        if (project.id !== projectId) {
          return project;
        }

        updated = {
          ...project,
          name
        };
        return updated;
      });
      write(store);

      if (!updated) {
        throw new Error("Project not found.");
      }

      return updated;
    },
    async removeProject(projectId: string) {
      const store = read();

      store.workspace.projects = store.workspace.projects.filter((project) => project.id !== projectId);
      write(store);

      return store.workspace;
    },
    async reorderProjects(projectIds: string[]) {
      const store = read();
      const requested = new Set(projectIds);
      const byId = new Map(store.workspace.projects.map((project) => [project.id, project]));
      const ordered = projectIds.map((id) => byId.get(id)).filter((project): project is ProjectSummary => Boolean(project));
      const remaining = store.workspace.projects.filter((project) => !requested.has(project.id));

      store.workspace.projects = [...ordered, ...remaining];
      write(store);

      return store.workspace;
    },
    async openProject(projectId: string) {
      const project = read().workspace.projects.find((candidate) => candidate.id === projectId);

      if (!project) {
        throw new Error("Project not found.");
      }
    },
    async listTickets(projectId: string) {
      return read().tickets[projectId] ?? [];
    },
    async searchTickets(projectId: string, query: string) {
      return searchTicketsForMock(read().tickets[projectId] ?? [], query);
    },
    async createTicket(projectId: string, status: Status, title: string) {
      const store = read();
      const now = Date.now();
      const id = `${now}-${slugify(title)}`;
      const ticket: Ticket = {
        id,
        title,
        body: "",
        status,
        rank: nextRank(store.tickets[projectId] ?? [], status),
        createdAt: now,
        updatedAt: now,
        filePath: `~/todo.md/projects/${projectId}/${id}.md`,
        parent: [],
        subtasks: [],
        blocks: [],
        blockedBy: []
      };

      store.tickets[projectId] = [...(store.tickets[projectId] ?? []), ticket];
      store.workspace.projects = store.workspace.projects.map((project) =>
        project.id === projectId ? { ...project, ticketCount: project.ticketCount + 1 } : project
      );
      write(store);

      return ticket;
    },
    async updateTicket(
      projectId: string,
      ticketId: string,
      title: string,
      body: string,
      status: Status,
      priority: TaskPriority | null,
      size: TaskSize | null
    ) {
      const store = read();
      let updated: Ticket | null = null;

      store.tickets[projectId] = (store.tickets[projectId] ?? []).map((ticket) => {
        if (ticket.id !== ticketId) {
          return ticket;
        }

        updated = {
          ...ticket,
          title,
          body,
          status,
          priority: priority ?? undefined,
          size: size ?? undefined,
          updatedAt: Date.now()
        };
        return updated;
      });
      write(store);

      if (!updated) {
        throw new Error("Ticket not found.");
      }

      return updated;
    },
    async setTicketDependency(
      projectId: string,
      ticketId: string,
      relatedTicketId: string,
      relationship: TicketDependencyRelationship,
      linked: boolean
    ) {
      const store = read();
      const tickets = store.tickets[projectId] ?? [];
      const ticketIndex = tickets.findIndex((ticket) => ticket.id === ticketId);
      const relatedIndex = tickets.findIndex((ticket) => ticket.id === relatedTicketId);

      if (ticketIndex < 0 || (linked && relatedIndex < 0)) {
        throw new Error("Ticket not found.");
      }

      if (ticketId === relatedTicketId) {
        throw new Error("A ticket cannot depend on itself.");
      }

      const now = Date.now();
      const nextTickets = tickets.map((ticket) => ({ ...ticket }));
      const { changedRelated, changedTicket } = applyMockDependencyChange(
        nextTickets[ticketIndex],
        relatedIndex >= 0 ? nextTickets[relatedIndex] : null,
        relationship,
        relatedTicketId,
        linked
      );

      if (changedTicket) {
        nextTickets[ticketIndex].updatedAt = now;
      }

      if (changedRelated && relatedIndex >= 0) {
        nextTickets[relatedIndex].updatedAt = now;
      }
      store.tickets[projectId] = nextTickets;
      write(store);

      return nextTickets;
    },
    async saveTicketImage(projectId: string, ticketId: string, mimeType: string, bytes: number[]) {
      const store = read();
      const project = store.workspace.projects.find((candidate) => candidate.id === projectId);
      const ticket = store.tickets[projectId]?.find((candidate) => candidate.id === ticketId);
      const extension = imageExtensionForMime(mimeType);

      if (!project || !ticket) {
        throw new Error("Ticket not found.");
      }

      if (!extension) {
        throw new Error("Unsupported image type.");
      }

      const fileName = `${Date.now()}-${ticketId}.${extension}`;

      return {
        markdownPath: bytesToDataUrl(mimeType, bytes),
        filePath: `${project.path}/.tasks/images/${fileName}`,
        alt: "Pasted image"
      };
    },
    async deleteTicketImage(_projectId: string, _markdownPath: string) {
      return;
    },
    async reorderTickets(projectId: string, positions: Array<{ id: string; status: Status; rank: string }>) {
      const store = read();
      const positionById = new Map(positions.map((position) => [position.id, position]));

      store.tickets[projectId] = (store.tickets[projectId] ?? []).map((ticket) => {
        const position = positionById.get(ticket.id);

        return position && (ticket.status !== position.status || ticket.rank !== position.rank)
          ? {
              ...ticket,
              status: position.status,
              rank: position.rank,
              updatedAt: Date.now()
            }
          : ticket;
      });
      write(store);

      return store.tickets[projectId];
    },
    async deleteTicket(projectId: string, ticketId: string) {
      const store = read();
      store.tickets[projectId] = (store.tickets[projectId] ?? []).filter((ticket) => ticket.id !== ticketId);
      store.workspace.projects = store.workspace.projects.map((project) =>
        project.id === projectId ? { ...project, ticketCount: Math.max(0, project.ticketCount - 1) } : project
      );
      write(store);
    },
    async archiveDoneTickets(projectId: string) {
      const store = read();
      const tickets = store.tickets[projectId] ?? [];
      const archivedCount = tickets.filter((ticket) => ticket.status === "done").length;

      store.tickets[projectId] = tickets.filter((ticket) => ticket.status !== "done");
      store.workspace.projects = store.workspace.projects.map((project) =>
        project.id === projectId
          ? { ...project, ticketCount: Math.max(0, project.ticketCount - archivedCount) }
          : project
      );
      write(store);

      return store.tickets[projectId];
    },
    persistDraftSync({ projectId, draft, title, body }: PersistMockDraftOptions) {
      const raw = localStorage.getItem(mockStorageKey);

      if (!raw) {
        return null;
      }

      const store = normalizeStore(JSON.parse(raw) as MockStore);
      let updated: Ticket | null = null;

      store.tickets[projectId] = (store.tickets[projectId] ?? []).map((ticket) => {
        if (ticket.id !== draft.id) {
          return ticket;
        }

        updated = {
          ...ticket,
          title,
          body,
          status: draft.status,
          priority: draft.priority,
          size: draft.size,
          updatedAt: Date.now()
        };
        return updated;
      });

      if (!updated) {
        return null;
      }

      write(store);
      return updated;
    }
  };
}

export function isTicketSearchActive(query: string) {
  return normalizeTicketSearchQuery(query).length > 0;
}

export function shouldDisableSearchReorder(query: string) {
  return isTicketSearchActive(query);
}

export function shouldRerunTicketSearchAfterMutation(query: string) {
  return isTicketSearchActive(query);
}

export function createTicketSearchResultMap(results: TicketSearchResult[]) {
  return new Map(results.map((result) => [result.ticket.id, result]));
}

export function filterTicketsBySearchResults(
  tickets: Ticket[],
  results: TicketSearchResult[],
  isActive: boolean
) {
  if (!isActive) {
    return tickets;
  }

  const matchingIds = new Set(results.map((result) => result.ticket.id));
  return tickets.filter((ticket) => matchingIds.has(ticket.id));
}

export function renderTicketSearchSegments(segments: TicketSearchSegment[]) {
  return segments
    .map((segment) => {
      const text = escapeHtml(segment.text);

      return segment.matched ? `<mark>${text}</mark>` : text;
    })
    .join("");
}

export function searchTicketsForMock(tickets: Ticket[], query: string): TicketSearchResult[] {
  const normalizedQuery = normalizeTicketSearchQuery(query);
  const queryTokens = ticketSearchTokens(query);

  if (!normalizedQuery || queryTokens.length === 0) {
    return [];
  }

  return tickets
    .flatMap((ticket) => {
      const fields = searchableTicketFields(ticket);

      if (!queryTokens.every((token) => fields.some((field) => fieldContainsSearchToken(field.text, token)))) {
        return [];
      }

      const fieldMatches = fields.flatMap((field) => {
        const match = buildTicketSearchMatch(field, normalizedQuery, queryTokens);

        return match ? [match] : [];
      });

      if (!fieldMatches.length) {
        return [];
      }

      const score =
        fieldMatches.reduce((total, match) => total + match.score, 0) +
        Math.floor(Math.max(0, ticket.updatedAt) / 1_000_000_000_000);
      const matches = fieldMatches
        .sort((first, second) => second.score - first.score)
        .slice(0, 5)
        .map((match) => match.match);

      return [
        {
          ticket,
          score,
          matches
        }
      ];
    })
    .sort((first, second) => {
      const scoreComparison = second.score - first.score;

      if (scoreComparison !== 0) {
        return scoreComparison;
      }

      const updatedComparison = second.ticket.updatedAt - first.ticket.updatedAt;

      return updatedComparison !== 0 ? updatedComparison : sortTicketIds(first.ticket, second.ticket);
    });
}

export function normalizeTicketSearchQuery(query: string) {
  return normalizeTicketSearchText(query.slice(0, maxTicketSearchQueryLength));
}

type SearchableTicketField = {
  field: TicketSearchField;
  text: string;
  weight: number;
  useSnippet: boolean;
};

type BuiltSearchMatch = {
  match: TicketSearchMatch;
  score: number;
};

type SearchRange = {
  start: number;
  end: number;
};

function searchableTicketFields(ticket: Ticket): SearchableTicketField[] {
  const fields: SearchableTicketField[] = [
    { field: "title", text: ticket.title, weight: 1000, useSnippet: false },
    { field: "body", text: markdownToTicketSearchText(ticket.body), weight: 120, useSnippet: true },
    { field: "status", text: ticket.status, weight: 360, useSnippet: false },
    { field: "priority", text: ticket.priority ?? "", weight: 340, useSnippet: false },
    { field: "size", text: ticket.size ?? "", weight: 330, useSnippet: false },
    { field: "prLink", text: ticket.prLink ?? "", weight: 260, useSnippet: true },
    { field: "assignee", text: ticket.assignee ?? "", weight: 260, useSnippet: true },
    { field: "id", text: ticket.id, weight: 220, useSnippet: false },
    { field: "filePath", text: ticket.filePath, weight: 180, useSnippet: true },
    { field: "rank", text: ticket.rank, weight: 60, useSnippet: false },
    { field: "createdAt", text: timestampSearchText(ticket.createdAt), weight: 35, useSnippet: false },
    { field: "updatedAt", text: timestampSearchText(ticket.updatedAt), weight: 40, useSnippet: false }
  ];

  return fields.filter((field) => field.text.trim().length > 0);
}

function buildTicketSearchMatch(
  field: SearchableTicketField,
  normalizedQuery: string,
  queryTokens: string[]
): BuiltSearchMatch | null {
  const phraseRanges = normalizedQuery.includes(" ")
    ? findCaseInsensitiveRanges(field.text, normalizedQuery)
    : [];
  const tokenRanges = queryTokens.flatMap((token) => exactTokenRanges(field.text, token));
  const exactRanges = mergeSearchRanges([...phraseRanges, ...tokenRanges]);
  const fuzzyRanges =
    exactRanges.length > 0
      ? []
      : mergeSearchRanges(queryTokens.flatMap((token) => fuzzyTokenRanges(field.text, token)));
  const ranges = mergeSearchRanges([...exactRanges, ...fuzzyRanges]);

  if (!ranges.length) {
    return null;
  }

  const segments = field.useSnippet
    ? snippetSegmentsFromRanges(field.text, ranges)
    : segmentsFromRanges(field.text, ranges);
  const match: TicketSearchMatch = {
    field: field.field,
    segments
  };

  if (field.useSnippet) {
    match.snippetSegments = segments;
  }

  const score =
    field.weight * (phraseRanges.length ? 4 : 1) +
    field.weight * exactRanges.length +
    Math.floor(field.weight / 3) * fuzzyRanges.length;

  return {
    match,
    score
  };
}

function fieldContainsSearchToken(text: string, token: string) {
  return exactTokenRanges(text, token).length > 0 || fuzzyTokenRanges(text, token).length > 0;
}

function ticketSearchTokens(query: string) {
  return normalizeTicketSearchQuery(query).split(" ").filter(Boolean);
}

function normalizeTicketSearchText(value: string) {
  return value
    .toLocaleLowerCase()
    .replace(/\s+/g, " ")
    .split(" ")
    .map(trimSearchTokenEdges)
    .filter(Boolean)
    .join(" ");
}

function trimSearchTokenEdges(value: string) {
  return value
    .replace(/^[^\p{L}\p{N}]+/u, "")
    .replace(/[^\p{L}\p{N}]+$/u, "");
}

function markdownToTicketSearchText(markdown: string) {
  return markdown
    .replace(/\r\n?/g, "\n")
    .replace(/```/g, " ")
    .replace(/!\[([^\]\n]*)\]\(([^)\s]+)\)/g, " $1 $2 ")
    .replace(/\[([^\]\n]+)\]\(([^)\s]+)\)/g, " $1 $2 ")
    .replace(/`([^`\n]+)`/g, " $1 ")
    .split("\n")
    .map((line) =>
      line
        .replace(/^\s{0,3}#{1,6}\s+/, "")
        .replace(/^\s{0,3}>\s?/, "")
        .replace(/^\s*[-*+]\s+\[[xX]\]\s+/, "checked ")
        .replace(/^\s*[-*+]\s+\[[ ]\]\s+/, "unchecked ")
        .replace(/^\s*[-*+]\s+/, "")
        .replace(/^\s*\d+\.\s+/, "")
    )
    .join(" ")
    .replace(/[*_~#]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function timestampSearchText(value: number) {
  const raw = String(value);
  const date = new Date(value);

  if (Number.isNaN(date.getTime())) {
    return raw;
  }

  const iso = date.toISOString();
  return `${raw} ${iso} ${iso.slice(0, 10)}`;
}

function findCaseInsensitiveRanges(text: string, needle: string): SearchRange[] {
  const normalizedNeedle = needle.toLocaleLowerCase();

  if (!normalizedNeedle) {
    return [];
  }

  const ranges: SearchRange[] = [];
  const lowerText = text.toLocaleLowerCase();
  let index = lowerText.indexOf(normalizedNeedle);

  while (index >= 0) {
    ranges.push({ start: index, end: index + normalizedNeedle.length });
    index = lowerText.indexOf(normalizedNeedle, index + normalizedNeedle.length);
  }

  return ranges;
}

function exactTokenRanges(text: string, token: string): SearchRange[] {
  return findCaseInsensitiveRanges(text, token);
}

function fuzzyTokenRanges(text: string, token: string): SearchRange[] {
  const maxDistance = fuzzyDistanceForToken(token);

  if (maxDistance === null) {
    return [];
  }

  const ranges: SearchRange[] = [];

  for (const match of text.matchAll(/[\p{L}\p{N}]+/gu)) {
    const word = match[0];
    const index = match.index ?? 0;
    const normalizedWord = normalizeTicketSearchText(word);

    if (
      normalizedWord &&
      normalizedWord !== token &&
      boundedEditDistance(normalizedWord, token, maxDistance) <= maxDistance
    ) {
      ranges.push({ start: index, end: index + word.length });
    }
  }

  return ranges;
}

function fuzzyDistanceForToken(token: string) {
  if (token.length < 4) {
    return null;
  }

  return token.length >= 8 ? 2 : 1;
}

function boundedEditDistance(first: string, second: string, maxDistance: number) {
  if (Math.abs(first.length - second.length) > maxDistance) {
    return maxDistance + 1;
  }

  let previous = Array.from({ length: second.length + 1 }, (_, index) => index);

  for (let firstIndex = 1; firstIndex <= first.length; firstIndex += 1) {
    const current = [firstIndex];
    let rowMinimum = current[0];

    for (let secondIndex = 1; secondIndex <= second.length; secondIndex += 1) {
      const cost = first[firstIndex - 1] === second[secondIndex - 1] ? 0 : 1;
      const value = Math.min(
        previous[secondIndex] + 1,
        current[secondIndex - 1] + 1,
        previous[secondIndex - 1] + cost
      );

      current[secondIndex] = value;
      rowMinimum = Math.min(rowMinimum, value);
    }

    if (rowMinimum > maxDistance) {
      return maxDistance + 1;
    }

    previous = current;
  }

  return previous[second.length];
}

function mergeSearchRanges(ranges: SearchRange[]) {
  return ranges
    .filter((range) => range.end > range.start)
    .sort((first, second) => first.start - second.start || first.end - second.end)
    .reduce<SearchRange[]>((merged, range) => {
      const previous = merged.at(-1);

      if (!previous || range.start > previous.end) {
        merged.push({ ...range });
        return merged;
      }

      previous.end = Math.max(previous.end, range.end);
      return merged;
    }, []);
}

function snippetSegmentsFromRanges(text: string, ranges: SearchRange[]) {
  const firstRange = ranges[0];
  const contextBefore = 44;
  const contextAfter = 92;
  const start = Math.max(0, firstRange.start - contextBefore);
  const end = Math.min(text.length, firstRange.end + contextAfter);
  const snippet = `${start > 0 ? "... " : ""}${text.slice(start, end)}${end < text.length ? " ..." : ""}`;
  const prefixLength = start > 0 ? 4 : 0;
  const snippetRanges = ranges
    .map((range) => ({
      start: Math.max(range.start, start) - start + prefixLength,
      end: Math.min(range.end, end) - start + prefixLength
    }))
    .filter((range) => range.end > range.start);

  return segmentsFromRanges(snippet, snippetRanges);
}

function segmentsFromRanges(text: string, ranges: SearchRange[]): TicketSearchSegment[] {
  const segments: TicketSearchSegment[] = [];
  let cursor = 0;

  mergeSearchRanges(ranges).forEach((range) => {
    if (range.start > cursor) {
      segments.push({ text: text.slice(cursor, range.start), matched: false });
    }

    segments.push({ text: text.slice(range.start, range.end), matched: true });
    cursor = range.end;
  });

  if (cursor < text.length) {
    segments.push({ text: text.slice(cursor), matched: false });
  }

  return segments.length ? segments : [{ text, matched: false }];
}

function sortTicketIds(first: Ticket, second: Ticket) {
  return first.id.localeCompare(second.id);
}

function applyMockDependencyChange(
  ticket: Ticket,
  relatedTicket: Ticket | null,
  relationship: TicketDependencyRelationship,
  relatedTicketId: string,
  linked: boolean
) {
  const [field, inverseField] = dependencyFieldsForRelationship(relationship);
  const changedTicket = applyMockDependencyId(ticket, field, relatedTicketId, linked);
  const changedRelated = relatedTicket ? applyMockDependencyId(relatedTicket, inverseField, ticket.id, linked) : false;

  return { changedTicket, changedRelated };
}

type DependencyFieldName = "parent" | "subtasks" | "blocks" | "blockedBy";

function dependencyFieldsForRelationship(
  relationship: TicketDependencyRelationship
): [DependencyFieldName, DependencyFieldName] {
  if (relationship === "parent") {
    return ["parent", "subtasks"];
  }

  if (relationship === "subtask") {
    return ["subtasks", "parent"];
  }

  if (relationship === "blocks") {
    return ["blocks", "blockedBy"];
  }

  return ["blockedBy", "blocks"];
}

function applyMockDependencyId(ticket: Ticket, field: DependencyFieldName, id: string, linked: boolean) {
  const before = normalizeDependencyIds(ticket[field], ticket.id);
  const next = linked
    ? normalizeDependencyIds([...before, id], ticket.id)
    : before.filter((candidate) => candidate !== id);

  ticket[field] = next;

  return dependencyIdsChanged(before, next);
}

function normalizeDependencyIds(value: unknown, selfId?: string): string[] {
  if (Array.isArray(value)) {
    return Array.from(
      new Set(
        value
          .filter((item): item is string => typeof item === "string")
          .map((item) => item.trim())
          .filter((item) => isSafeDependencyId(item) && item !== selfId)
      )
    );
  }

  if (typeof value === "string" && value.trim()) {
    return normalizeDependencyIds(parseDependencyIdString(value), selfId);
  }

  return [];
}

function parseDependencyIdString(value: string) {
  const cleaned = value.trim().replace(/^\[/, "").replace(/\]$/, "").trim();
  return cleaned.split(/[,\s]+/).map((id) => id.trim().replace(/^['"]|['"]$/g, ""));
}

function isSafeDependencyId(value: string) {
  return /^[A-Za-z0-9_-]+$/.test(value);
}

function dependencyIdsChanged(current: string[], next: string[]) {
  return current.length !== next.length || current.some((id, index) => id !== next[index]);
}

function nextRank(tickets: Ticket[], status: Status) {
  const previousRank = tickets
    .filter((ticket) => ticket.status === status)
    .map((ticket) => ticket.rank)
    .sort()
    .at(-1);

  return rankBetween(previousRank);
}

function normalizeStore(store: MockStore) {
  store.tickets = Object.fromEntries(
    Object.entries(store.tickets).map(([projectId, tickets]) => [
      projectId,
      tickets.map((ticket) => {
        const { order, tags: _tags, ...ticketWithoutTags } = ticket as Ticket & { order?: number; tags?: unknown };

        return {
          ...ticketWithoutTags,
          status: normalizeStatus(ticket.status as string | undefined),
          priority: isTaskPriority(ticket.priority) ? ticket.priority : undefined,
          size: isTaskSize(ticket.size) ? ticket.size : undefined,
          rank: ticket.rank ?? rankFromLegacyOrder(order ?? 0, ticket.title, ticket.filePath),
          parent: normalizeDependencyIds(ticket.parent, ticket.id),
          subtasks: normalizeDependencyIds(ticket.subtasks, ticket.id),
          blocks: normalizeDependencyIds(ticket.blocks, ticket.id),
          blockedBy: normalizeDependencyIds(ticket.blockedBy, ticket.id)
        };
      })
    ])
  );

  return store;
}

function isTaskPriority(value: unknown): value is TaskPriority {
  return value === "P0" || value === "P1" || value === "P2" || value === "P3" || value === "P4";
}

function isTaskSize(value: unknown): value is TaskSize {
  return value === "XS" || value === "S" || value === "M" || value === "L" || value === "XL";
}
