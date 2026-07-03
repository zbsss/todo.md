import type {
  MockStore,
  ProjectSummary,
  Status,
  TaskPriority,
  TaskSize,
  Ticket,
  TicketDraft
} from "../app/types";
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
            size: "M"
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
            size: "S"
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
            assignee: "codex://threads/019f239d-dd6d-7451-856c-3847cadaf912"
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
            assignee: "codex://threads/019f239d-dd6d-7451-856c-3847cadaf913"
          },
          {
            id: "keep-tickets-local",
            title: "Keep tickets local",
            body: "Every card is backed by a plain `.md` file on disk.",
            status: "done",
            rank: rankBetween(),
            createdAt: now,
            updatedAt: now,
            filePath: "~/todo.md/projects/inbox/keep-tickets-local.md"
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
        filePath: `~/todo.md/projects/${projectId}/${id}.md`
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
          rank: ticket.rank ?? rankFromLegacyOrder(order ?? 0, ticket.title, ticket.filePath)
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
