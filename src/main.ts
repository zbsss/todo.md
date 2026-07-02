import { defaultKeymap, history, historyKeymap } from "@codemirror/commands";
import { markdown, markdownKeymap, markdownLanguage } from "@codemirror/lang-markdown";
import {
  bracketMatching,
  defaultHighlightStyle,
  indentOnInput,
  syntaxHighlighting
} from "@codemirror/language";
import { EditorState } from "@codemirror/state";
import type { Range } from "@codemirror/state";
import {
  Decoration,
  type DecorationSet,
  EditorView,
  keymap,
  placeholder,
  ViewPlugin,
  type ViewUpdate,
  WidgetType
} from "@codemirror/view";
import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { confirm, open } from "@tauri-apps/plugin-dialog";
import {
  ArrowDown,
  ArrowUp,
  Check,
  ChevronDown,
  CircleCheck,
  Copy,
  createIcons,
  Folder,
  FolderOpen,
  FolderPlus,
  GripVertical,
  ListTodo,
  LoaderCircle,
  Pencil,
  Plus,
  RefreshCw,
  Save,
  Trash2,
  X
} from "lucide";
import "./styles.css";

type Status = "todo" | "doing" | "done";

type ProjectSummary = {
  id: string;
  name: string;
  path: string;
  ticketCount: number;
};

type WorkspaceInfo = {
  baseDir: string;
  projects: ProjectSummary[];
};

type Ticket = {
  id: string;
  title: string;
  body: string;
  status: Status;
  order: number;
  createdAt: number;
  updatedAt: number;
  filePath: string;
};

type TicketDraft = {
  id: string;
  title: string;
  body: string;
  status: Status;
  pastedImages: string[];
};

type SavedTicketImage = {
  markdownPath: string;
  filePath: string;
  alt: string;
};

type MockStore = {
  workspace: WorkspaceInfo;
  tickets: Record<string, Ticket[]>;
};

type MarkdownRenderOptions = {
  compact?: boolean;
  skipImages?: boolean;
  projectPath?: string;
};

type RenderOptions = {
  preserveScroll?: boolean;
};

type SaveDraftOptions = {
  flush?: boolean;
};

type ScrollSnapshot = {
  windowX: number;
  windowY: number;
  elements: Array<{
    key: string;
    scrollLeft: number;
    scrollTop: number;
  }>;
};

const untitledTicketTitle = "Untitled ticket";
const mockStorageKey = "todo.md-demo";
const columns: Array<{ id: Status; label: string; icon: string }> = [
  { id: "todo", label: "To do", icon: "list-todo" },
  { id: "doing", label: "Doing", icon: "loader-circle" },
  { id: "done", label: "Done", icon: "circle-check" }
];

const app = document.querySelector<HTMLDivElement>("#app");

if (!app) {
  throw new Error("App root not found.");
}

const appRoot = app;
const ticketDragType = "application/x-todo-md-ticket";
const projectDragType = "application/x-todo-md-project";
const maxPastedImageBytes = 25 * 1024 * 1024;

const state: {
  workspace: WorkspaceInfo | null;
  selectedProjectId: string | null;
  tickets: Ticket[];
  selectedTicketId: string | null;
  draft: TicketDraft | null;
  draggingId: string | null;
  draggingProjectId: string | null;
  projectMenu: { projectId: string; x: number; y: number } | null;
  ticketMenu: { ticketId: string; x: number; y: number } | null;
  renamingProjectId: string | null;
  renamingProjectName: string;
  isLoading: boolean;
  error: string | null;
  draftSaveError: string | null;
} = {
  workspace: null,
  selectedProjectId: null,
  tickets: [],
  selectedTicketId: null,
  draft: null,
  draggingId: null,
  draggingProjectId: null,
  projectMenu: null,
  ticketMenu: null,
  renamingProjectId: null,
  renamingProjectName: "",
  isLoading: true,
  error: null,
  draftSaveError: null
};

const isTauriRuntime = "__TAURI_INTERNALS__" in window;
let markdownEditorView: EditorView | null = null;
const pendingImageUploads = new Set<Promise<void>>();
const draftAutosaveDelayMs = 700;
const draftAutosaveRetryDelayMs = 5000;
const closeAutosaveTimeoutMs = 2000;
let draftAutosaveTimer: ReturnType<typeof window.setTimeout> | null = null;
let draftSavePromise: Promise<void> | null = null;
let draftSaveRunId = 0;
let isClosingWindow = false;
const ticketAutoScrollEdge = 72;
const ticketAutoScrollMaxSpeed = 360;
const ticketAutoScroll: {
  frameId: number | null;
  lastTimestamp: number;
  list: HTMLElement | null;
  pointerY: number;
  velocity: number;
} = {
  frameId: null,
  lastTimestamp: 0,
  list: null,
  pointerY: 0,
  velocity: 0
};
let ticketDropCleanupFrameId: number | null = null;

async function main() {
  bindGlobalKeys();
  await bindWindowCloseGuards();
  await loadWorkspace();
}

async function loadWorkspace() {
  state.isLoading = true;
  state.error = null;
  const preferredProjectId = state.selectedProjectId;
  render();

  try {
    const workspace = await api.getWorkspaceInfo();
    state.workspace = workspace;
    state.selectedProjectId =
      preferredProjectId && workspace.projects.some((project) => project.id === preferredProjectId)
        ? preferredProjectId
        : workspace.projects[0]?.id ?? null;

    if (state.selectedProjectId) {
      await loadTickets(state.selectedProjectId);
    } else {
      state.tickets = [];
      render();
    }
  } catch (error) {
    showError(error);
  } finally {
    state.isLoading = false;
    render();
  }
}

async function loadTickets(projectId: string) {
  state.error = null;
  state.tickets = await api.listTickets(projectId);
  state.tickets.sort(sortTickets);
}

function render(options: RenderOptions = {}) {
  const scrollSnapshot = options.preserveScroll ? captureScrollSnapshot() : null;

  destroyMarkdownEditor();

  const workspace = state.workspace;
  const currentProject = workspace?.projects.find(
    (project) => project.id === state.selectedProjectId
  );

  appRoot.innerHTML = `
    <div class="shell">
      <aside class="sidebar">
        <div class="brand">
          <div class="brand-mark">.md</div>
          <div>
            <h1>todo.md</h1>
            <p>${workspace ? escapeHtml(shortPath(workspace.baseDir)) : "Local Markdown boards"}</p>
          </div>
        </div>

        <form class="new-project" data-action="create-project">
          <input name="name" placeholder="New project" autocomplete="off" />
          <button class="icon-button primary" aria-label="Create project" title="Create project">
            ${icon("plus")}
          </button>
        </form>

        <button class="sidebar-action" data-action="import-project" title="Add existing folder">
          ${icon("folder-plus")}
          <span>Add folder</span>
        </button>

        <nav class="project-list" aria-label="Projects">
          ${renderProjects(workspace?.projects ?? [])}
        </nav>
      </aside>

      <section class="workspace">
        <header class="topbar">
          <div>
            <p class="eyebrow">Project</p>
            <h2>${escapeHtml(currentProject?.name ?? "No project")}</h2>
            <p class="project-path">${escapeHtml(currentProject?.path ?? "Create a project to begin")}</p>
          </div>
          <button class="ghost-button" data-action="refresh" title="Refresh board">
            ${icon("refresh-cw")}
            <span>Refresh</span>
          </button>
        </header>

        ${state.error ? `<div class="notice">${escapeHtml(state.error)}</div>` : ""}
        ${state.isLoading ? renderLoadingBoard() : renderBoard()}
      </section>
    </div>

    ${renderProjectMenu()}
    ${renderTicketMenu()}
    ${renderProjectRenameDialog()}
    ${renderEditor()}
  `;

  hydrateIcons();
  bindEvents();
  restoreScrollSnapshot(scrollSnapshot);
}

function renderProjects(projects: ProjectSummary[]) {
  if (!projects.length) {
    return `<p class="empty-state">No projects yet</p>`;
  }

  return projects
    .map((project) => {
      const isActive = project.id === state.selectedProjectId;

      return `
        <button
          class="project-item ${isActive ? "active" : ""}"
          data-project-id="${escapeAttr(project.id)}"
          draggable="true"
        >
          <span class="project-icon">${icon("folder")}</span>
          <span>
            <strong>${escapeHtml(project.name)}</strong>
            <small>${project.ticketCount} ${project.ticketCount === 1 ? "ticket" : "tickets"}</small>
          </span>
          <span class="project-drag-icon">${icon("grip-vertical")}</span>
        </button>
      `;
    })
    .join("");
}

function renderProjectMenu() {
  if (!state.projectMenu || !state.workspace) {
    return "";
  }

  const project = getProject(state.projectMenu.projectId);

  if (!project) {
    return "";
  }

  const index = state.workspace.projects.findIndex((candidate) => candidate.id === project.id);
  const canMoveUp = index > 0;
  const canMoveDown = index >= 0 && index < state.workspace.projects.length - 1;

  return `
    <div class="context-menu-backdrop" data-action="close-project-menu"></div>
    <div
      class="context-menu project-context-menu"
      role="menu"
      style="left: ${state.projectMenu.x}px; top: ${state.projectMenu.y}px;"
      aria-label="${escapeAttr(project.name)} project menu"
    >
      <button data-project-action="rename-project" data-project-id="${escapeAttr(project.id)}" role="menuitem">
        ${icon("pencil")}
        <span>Rename</span>
      </button>
      <button data-project-action="copy-project-path" data-project-id="${escapeAttr(project.id)}" role="menuitem">
        ${icon("copy")}
        <span>Copy path</span>
      </button>
      <button data-project-action="open-project" data-project-id="${escapeAttr(project.id)}" role="menuitem">
        ${icon("folder-open")}
        <span>Open</span>
      </button>
      <button
        data-project-action="move-project-up"
        data-project-id="${escapeAttr(project.id)}"
        role="menuitem"
        ${canMoveUp ? "" : "disabled"}
      >
        ${icon("arrow-up")}
        <span>Move up</span>
      </button>
      <button
        data-project-action="move-project-down"
        data-project-id="${escapeAttr(project.id)}"
        role="menuitem"
        ${canMoveDown ? "" : "disabled"}
      >
        ${icon("arrow-down")}
        <span>Move down</span>
      </button>
      <button
        class="danger"
        data-project-action="remove-project"
        data-project-id="${escapeAttr(project.id)}"
        role="menuitem"
      >
        ${icon("trash-2")}
        <span>Remove</span>
      </button>
    </div>
  `;
}

function renderTicketMenu() {
  if (!state.ticketMenu) {
    return "";
  }

  const ticket = getTicket(state.ticketMenu.ticketId);

  if (!ticket) {
    return "";
  }

  return `
    <div class="context-menu-backdrop" data-action="close-ticket-menu"></div>
    <div
      class="context-menu ticket-context-menu"
      role="menu"
      style="left: ${state.ticketMenu.x}px; top: ${state.ticketMenu.y}px;"
      aria-label="${escapeAttr(ticket.title)} task menu"
    >
      <button data-ticket-action="copy-ticket-path" data-ticket-id="${escapeAttr(ticket.id)}" role="menuitem">
        ${icon("copy")}
        <span>Copy path</span>
      </button>
      <button
        class="danger"
        data-ticket-action="delete-ticket"
        data-ticket-id="${escapeAttr(ticket.id)}"
        role="menuitem"
      >
        ${icon("trash-2")}
        <span>Delete</span>
      </button>
    </div>
  `;
}

function renderProjectRenameDialog() {
  const project = state.renamingProjectId ? getProject(state.renamingProjectId) : null;

  if (!project) {
    return "";
  }

  return `
    <div class="rename-backdrop">
      <form class="rename-panel" data-action="save-project-name" role="dialog" aria-modal="true" aria-labelledby="rename-title">
        <header>
          <p class="eyebrow">Project</p>
          <h3 id="rename-title">Rename project</h3>
        </header>
        <input name="name" value="${escapeAttr(state.renamingProjectName)}" autocomplete="off" />
        <footer class="rename-actions">
          <button type="button" class="ghost-button" data-action="cancel-project-rename">Cancel</button>
          <button class="save-button">
            ${icon("save")}
            <span>Save</span>
          </button>
        </footer>
      </form>
    </div>
  `;
}

function renderBoard() {
  if (!state.selectedProjectId) {
    return `
      <div class="empty-board">
        <h3>Create a project</h3>
      </div>
    `;
  }

  return `
    <div class="board" aria-label="Task board">
      ${columns.map(renderColumn).join("")}
    </div>
  `;
}

function renderLoadingBoard() {
  return `
    <div class="board">
      ${columns
        .map(
          (column) => `
            <section class="column">
              <div class="column-header">
                <span>${icon(column.icon)}</span>
                <h3>${column.label}</h3>
              </div>
              <div class="skeleton"></div>
              <div class="skeleton short"></div>
            </section>
          `
        )
        .join("")}
    </div>
  `;
}

function renderColumn(column: { id: Status; label: string; icon: string }) {
  const tickets = ticketsFor(column.id);

  return `
    <section class="column" data-status="${column.id}">
      <div class="column-header">
        <span class="column-icon">${icon(column.icon)}</span>
        <h3>${column.label}</h3>
        <span class="count">${tickets.length}</span>
      </div>

      <div class="ticket-list" data-status="${column.id}">
        ${tickets.map(renderTicketCard).join("")}
      </div>

      <form class="quick-add" data-action="create-ticket" data-status="${column.id}">
        <input name="title" placeholder="Add ticket" autocomplete="off" />
        <button class="icon-button" aria-label="Add ticket" title="Add ticket">
          ${icon("plus")}
        </button>
      </form>
    </section>
  `;
}

function renderTicketCard(ticket: Ticket) {
  const renderedBody = renderMarkdown(ticket.body, {
    compact: true,
    skipImages: true,
    projectPath: getCurrentProject()?.path
  });

  return `
    <article
      class="ticket-card"
      draggable="true"
      data-ticket-id="${escapeAttr(ticket.id)}"
      tabindex="0"
      aria-label="${escapeAttr(ticket.title)}"
      aria-keyshortcuts="Enter ArrowUp ArrowDown"
    >
      <div class="ticket-topline">
        <h4>${renderTicketTitle(ticket.title)}</h4>
        <span class="drag-handle" title="Drag to reorder">${icon("grip-vertical")}</span>
      </div>
      ${renderedBody ? `<div class="markdown card-markdown">${renderedBody}</div>` : ""}
    </article>
  `;
}

function renderEditor() {
  if (!state.draft) {
    return "";
  }

  const ticket = getSelectedTicket();

  if (!ticket) {
    return "";
  }

  return `
    <div class="modal-backdrop" data-action="close-editor">
      <section class="editor-panel" role="dialog" aria-modal="true" aria-labelledby="editor-title" tabindex="-1">
        <header class="editor-header">
          <div>
            <p class="eyebrow">Ticket</p>
            <input id="editor-title" class="title-input" name="title" value="${escapeAttr(state.draft.title)}" />
          </div>
          <div class="editor-actions">
            ${renderStatusSelector(state.draft.status)}
            <button class="icon-button danger" data-action="delete-ticket" aria-label="Delete ticket" title="Delete ticket">
              ${icon("trash-2")}
            </button>
            <button class="icon-button" data-action="close-editor" aria-label="Close editor" title="Close editor">
              ${icon("x")}
            </button>
          </div>
        </header>

        <div class="editor-body">
          <div class="markdown-editor-shell">
            <div class="markdown-editor" data-editor-root></div>
          </div>
        </div>

        <footer class="editor-footer">
          <div class="editor-footer-info">
            <p>${escapeHtml(shortPath(ticket.filePath))}</p>
            ${state.draftSaveError ? `<p class="editor-save-error">${escapeHtml(state.draftSaveError)}</p>` : ""}
          </div>
        </footer>
      </section>
    </div>
  `;
}

function renderStatusSelector(status: Status) {
  const selected = columnForStatus(status);

  return `
    <div class="status-selector" data-status-selector>
      <button
        type="button"
        class="status-selector-button"
        data-action="toggle-status-selector"
        aria-haspopup="menu"
        aria-expanded="false"
        aria-label="Status: ${selected.label}. Change status"
      >
        <span class="status-current">
          <span class="status-current-icon status-icon-${selected.id}" data-status-current-icon>${icon(selected.icon)}</span>
          <span data-status-current-label>${selected.label}</span>
        </span>
        <span class="status-chevron">${icon("chevron-down")}</span>
      </button>
      <div class="status-menu" role="menu" aria-label="Change status">
        ${columns
          .map(
            (column) => `
              <button
                type="button"
                class="status-option ${column.id === status ? "selected" : ""}"
                data-action="choose-status"
                data-status-value="${column.id}"
                role="menuitemradio"
                aria-checked="${column.id === status ? "true" : "false"}"
              >
                <span class="status-option-icon status-icon-${column.id}">${icon(column.icon)}</span>
                <span>${column.label}</span>
                <span class="status-option-check">${column.id === status ? icon("check") : ""}</span>
              </button>
            `
          )
          .join("")}
      </div>
    </div>
  `;
}

function bindEvents() {
  bindProjectEvents();
  bindTicketEvents();
  bindEditorEvents();
}

function bindProjectEvents() {
  document
    .querySelector<HTMLFormElement>('[data-action="create-project"]')
    ?.addEventListener("submit", async (event) => {
      event.preventDefault();
      const form = event.currentTarget as HTMLFormElement | null;

      if (!form) {
        return;
      }

      const input = form.elements.namedItem("name") as HTMLInputElement;
      const name = input.value.trim();

      if (!name) {
        input.focus();
        return;
      }

      if (!(await confirmDiscardDraft())) {
        return;
      }

      try {
        const project = await api.createProject(name);
        state.workspace?.projects.push(project);
        state.selectedProjectId = project.id;
        state.selectedTicketId = null;
        state.draft = null;
        state.tickets = [];
        input.value = "";
        await loadTickets(project.id);
        render();
      } catch (error) {
        showError(error);
      }
    });

  document.querySelector<HTMLButtonElement>('[data-action="import-project"]')?.addEventListener("click", async () => {
    if (!(await confirmDiscardDraft())) {
      return;
    }

    try {
      const path = isTauriRuntime
        ? await open({
            directory: true,
            multiple: false,
            title: "Add project folder"
          })
        : window.prompt("Project folder name");

      if (typeof path !== "string" || !path.trim()) {
        return;
      }

      const project = await api.importProject(path);
      state.selectedProjectId = project.id;
      state.selectedTicketId = null;
      state.draft = null;
      await loadWorkspace();
    } catch (error) {
      showError(error);
    }
  });

  document.querySelector<HTMLElement>('[data-action="close-project-menu"]')?.addEventListener("click", () => {
    closeProjectMenu();
  });

  document.querySelector<HTMLFormElement>('[data-action="save-project-name"]')?.addEventListener("submit", (event) => {
    event.preventDefault();
    const form = event.currentTarget as HTMLFormElement | null;
    const input = form?.elements.namedItem("name") as HTMLInputElement | null;

    if (input) {
      void saveProjectName(input.value);
    }
  });

  document.querySelector<HTMLButtonElement>('[data-action="cancel-project-rename"]')?.addEventListener("click", () => {
    closeProjectRenameDialog();
  });

  document.querySelector<HTMLInputElement>('.rename-panel input[name="name"]')?.addEventListener("input", (event) => {
    state.renamingProjectName = (event.currentTarget as HTMLInputElement).value;
  });

  document.querySelectorAll<HTMLButtonElement>("[data-project-action]").forEach((button) => {
    button.addEventListener("click", () => {
      const projectId = button.dataset.projectId;
      const action = button.dataset.projectAction;

      if (!projectId || !action) {
        return;
      }

      if (action === "rename-project") {
        openProjectRenameDialog(projectId);
      }

      if (action === "copy-project-path") {
        void copyProjectPath(projectId);
      }

      if (action === "open-project") {
        void openProject(projectId);
      }

      if (action === "move-project-up") {
        void moveProjectBy(projectId, -1);
      }

      if (action === "move-project-down") {
        void moveProjectBy(projectId, 1);
      }

      if (action === "remove-project") {
        void removeProject(projectId);
      }
    });
  });

  document.querySelectorAll<HTMLButtonElement>(".project-item[data-project-id]").forEach((button) => {
    button.addEventListener("click", async () => {
      const projectId = button.dataset.projectId;

      if (!projectId || projectId === state.selectedProjectId) {
        return;
      }

      if (!(await confirmDiscardDraft())) {
        return;
      }

      try {
        state.selectedProjectId = projectId;
        state.selectedTicketId = null;
        state.draft = null;
        state.isLoading = true;
        render();
        await loadTickets(projectId);
      } catch (error) {
        showError(error);
      } finally {
        state.isLoading = false;
        render();
      }
    });

    button.addEventListener("contextmenu", (event) => {
      event.preventDefault();
      const projectId = button.dataset.projectId;

      if (projectId) {
        openProjectMenu(projectId, event.clientX, event.clientY);
      }
    });

    button.addEventListener("dragstart", (event) => {
      const projectId = button.dataset.projectId;

      if (!projectId || !event.dataTransfer) {
        return;
      }

      state.draggingProjectId = projectId;
      event.dataTransfer.effectAllowed = "move";
      event.dataTransfer.setData(projectDragType, projectId);
      button.classList.add("is-project-dragging");
      closeProjectMenu({ shouldRender: false });
    });

    button.addEventListener("dragover", (event) => {
      if (!state.draggingProjectId || state.draggingProjectId === button.dataset.projectId) {
        return;
      }

      event.preventDefault();
      if (event.dataTransfer) {
        event.dataTransfer.dropEffect = "move";
      }
      button.classList.add("is-project-drag-over");
    });

    button.addEventListener("dragleave", () => {
      button.classList.remove("is-project-drag-over");
    });

    button.addEventListener("drop", async (event) => {
      event.preventDefault();
      button.classList.remove("is-project-drag-over");

      const projectId = event.dataTransfer?.getData(projectDragType) || state.draggingProjectId;
      const beforeId = button.dataset.projectId;

      if (!projectId || !beforeId || projectId === beforeId) {
        return;
      }

      await reorderProjectBefore(projectId, beforeId);
    });

    button.addEventListener("dragend", () => {
      state.draggingProjectId = null;
      document
        .querySelectorAll(".is-project-dragging, .is-project-drag-over")
        .forEach((node) => node.classList.remove("is-project-dragging", "is-project-drag-over"));
    });
  });

  document.querySelector<HTMLElement>(".project-list")?.addEventListener("dragover", (event) => {
    if (state.draggingProjectId) {
      event.preventDefault();
    }
  });

  document.querySelector<HTMLElement>(".project-list")?.addEventListener("drop", async (event) => {
    const targetProject = (event.target as HTMLElement).closest<HTMLElement>(".project-item");

    if (targetProject) {
      return;
    }

    event.preventDefault();
    const projectId = event.dataTransfer?.getData(projectDragType) || state.draggingProjectId;

    if (projectId) {
      await reorderProjectBefore(projectId);
    }
  });

  document.querySelector<HTMLButtonElement>('[data-action="refresh"]')?.addEventListener("click", async () => {
    if (!(await confirmDiscardDraft())) {
      return;
    }

    try {
      state.isLoading = true;
      render();
      await loadWorkspace();
    } catch (error) {
      showError(error);
    } finally {
      state.isLoading = false;
      render();
    }
  });
}

function openProjectMenu(projectId: string, x: number, y: number) {
  const menuWidth = 208;
  const menuHeight = 250;

  state.ticketMenu = null;
  state.projectMenu = {
    projectId,
    x: Math.max(8, Math.min(x, window.innerWidth - menuWidth - 8)),
    y: Math.max(8, Math.min(y, window.innerHeight - menuHeight - 8))
  };
  render({ preserveScroll: true });
}

function closeProjectMenu(options: { shouldRender?: boolean } = {}) {
  state.projectMenu = null;

  if (options.shouldRender !== false) {
    render({ preserveScroll: true });
  }
}

function openTicketMenu(ticketId: string, x: number, y: number) {
  const menuWidth = 208;
  const menuHeight = 92;

  state.projectMenu = null;
  state.ticketMenu = {
    ticketId,
    x: Math.max(8, Math.min(x, window.innerWidth - menuWidth - 8)),
    y: Math.max(8, Math.min(y, window.innerHeight - menuHeight - 8))
  };
  render({ preserveScroll: true });
}

function closeTicketMenu(options: { shouldRender?: boolean } = {}) {
  state.ticketMenu = null;

  if (options.shouldRender !== false) {
    render({ preserveScroll: true });
  }
}

function closeContextMenus(options: { shouldRender?: boolean } = {}) {
  state.projectMenu = null;
  state.ticketMenu = null;

  if (options.shouldRender !== false) {
    render({ preserveScroll: true });
  }
}

function openProjectRenameDialog(projectId: string) {
  const project = getProject(projectId);

  if (!project) {
    closeProjectMenu();
    return;
  }

  state.projectMenu = null;
  state.renamingProjectId = project.id;
  state.renamingProjectName = project.name;
  render();
  document.querySelector<HTMLInputElement>('.rename-panel input[name="name"]')?.select();
}

function closeProjectRenameDialog() {
  state.renamingProjectId = null;
  state.renamingProjectName = "";
  render();
}

async function saveProjectName(name: string) {
  const projectId = state.renamingProjectId;
  const nextName = name.trim();

  if (!projectId) {
    return;
  }

  if (!nextName) {
    document.querySelector<HTMLInputElement>('.rename-panel input[name="name"]')?.focus();
    return;
  }

  try {
    const updated = await api.updateProjectName(projectId, nextName);
    state.workspace = updateProjectInWorkspace(state.workspace, updated);
    state.renamingProjectId = null;
    state.renamingProjectName = "";
    render();
  } catch (error) {
    showError(error);
  }
}

async function copyProjectPath(projectId: string) {
  const project = getProject(projectId);

  if (!project) {
    closeProjectMenu();
    return;
  }

  try {
    await copyText(project.path);
    closeProjectMenu();
  } catch (error) {
    showError(error);
  }
}

async function copyTicketPath(ticketId: string) {
  const ticket = getTicket(ticketId);

  if (!ticket) {
    closeTicketMenu();
    return;
  }

  try {
    await copyText(ticket.filePath);
    closeTicketMenu();
  } catch (error) {
    showError(error);
  }
}

async function openProject(projectId: string) {
  try {
    await api.openProject(projectId);
    closeProjectMenu();
  } catch (error) {
    showError(error);
  }
}

async function removeProject(projectId: string) {
  const project = getProject(projectId);

  if (!project) {
    closeProjectMenu();
    return;
  }

  if (state.selectedProjectId === projectId && !(await confirmDiscardDraft())) {
    return;
  }

  const confirmed = await confirmAction(
    `Remove "${project.name}" from the project list? Its Markdown files and .tasks folder will stay on disk.`,
    "Remove project"
  );

  if (!confirmed) {
    return;
  }

  const nextProjectId = findNeighborProjectId(projectId);

  try {
    const workspace = await api.removeProject(projectId);
    state.workspace = workspace;
    state.projectMenu = null;
    state.renamingProjectId = null;

    if (state.selectedProjectId === projectId) {
      state.selectedProjectId =
        (nextProjectId && workspace.projects.some((candidate) => candidate.id === nextProjectId)
          ? nextProjectId
          : workspace.projects[0]?.id) ?? null;
      state.selectedTicketId = null;
      state.draft = null;
      state.tickets = [];

      if (state.selectedProjectId) {
        state.isLoading = true;
        render();
        await loadTickets(state.selectedProjectId);
      }
    }

    state.isLoading = false;
    render();
  } catch (error) {
    showError(error);
  }
}

async function moveProjectBy(projectId: string, delta: -1 | 1) {
  if (!state.workspace) {
    return;
  }

  const fromIndex = state.workspace.projects.findIndex((project) => project.id === projectId);
  const toIndex = fromIndex + delta;

  if (fromIndex < 0 || toIndex < 0 || toIndex >= state.workspace.projects.length) {
    closeProjectMenu();
    return;
  }

  const nextProjects = [...state.workspace.projects];
  const [project] = nextProjects.splice(fromIndex, 1);
  nextProjects.splice(toIndex, 0, project);
  await saveProjectOrder(nextProjects);
}

async function reorderProjectBefore(projectId: string, beforeId?: string) {
  if (!state.workspace || projectId === beforeId) {
    return;
  }

  const project = state.workspace.projects.find((candidate) => candidate.id === projectId);

  if (!project) {
    return;
  }

  const nextProjects = state.workspace.projects.filter((candidate) => candidate.id !== projectId);
  const beforeIndex = beforeId ? nextProjects.findIndex((candidate) => candidate.id === beforeId) : -1;

  if (beforeIndex >= 0) {
    nextProjects.splice(beforeIndex, 0, project);
  } else {
    nextProjects.push(project);
  }

  await saveProjectOrder(nextProjects);
}

async function saveProjectOrder(projects: ProjectSummary[]) {
  const previousWorkspace = state.workspace;

  if (!previousWorkspace) {
    return;
  }

  state.workspace = {
    ...previousWorkspace,
    projects
  };
  state.projectMenu = null;
  render();

  try {
    state.workspace = await api.reorderProjects(projects.map((project) => project.id));
    render();
  } catch (error) {
    state.workspace = previousWorkspace;
    showError(error);
  }
}

function bindTicketEvents() {
  document
    .querySelectorAll<HTMLFormElement>('[data-action="create-ticket"]')
    .forEach((form) => {
      form.addEventListener("submit", async (event) => {
        event.preventDefault();
        const currentForm = event.currentTarget as HTMLFormElement | null;

        if (!state.selectedProjectId || !currentForm) {
          return;
        }

        const status = currentForm.dataset.status as Status;
        const input = currentForm.elements.namedItem("title") as HTMLInputElement;
        const title = input.value.trim();

        if (!title) {
          input.focus();
          return;
        }

        try {
          const ticket = await api.createTicket(state.selectedProjectId, status, title);
          state.tickets.push(ticket);
          state.workspace = updateTicketCount(state.workspace, state.selectedProjectId, 1);
          input.value = "";
          render();
        } catch (error) {
          showError(error);
        }
      });
    });

  document.querySelector<HTMLElement>('[data-action="close-ticket-menu"]')?.addEventListener("click", () => {
    closeTicketMenu();
  });

  document.querySelectorAll<HTMLButtonElement>("[data-ticket-action]").forEach((button) => {
    button.addEventListener("click", () => {
      const ticketId = button.dataset.ticketId;
      const action = button.dataset.ticketAction;

      if (!ticketId || !action) {
        return;
      }

      if (action === "copy-ticket-path") {
        void copyTicketPath(ticketId);
      }

      if (action === "delete-ticket") {
        void deleteTicket(ticketId);
      }
    });
  });

  document.querySelectorAll<HTMLElement>(".ticket-card").forEach((card) => {
    card.addEventListener("click", () => {
      const ticketId = card.dataset.ticketId;

      if (ticketId) {
        openEditor(ticketId);
      }
    });

    card.addEventListener("contextmenu", (event) => {
      event.preventDefault();
      const ticketId = card.dataset.ticketId;

      if (ticketId) {
        openTicketMenu(ticketId, event.clientX, event.clientY);
      }
    });

    card.addEventListener("keydown", (event) => {
      if (event.target !== card) {
        return;
      }

      if (event.key === "Enter") {
        const ticketId = card.dataset.ticketId;

        if (ticketId) {
          openEditor(ticketId);
        }
      }

      if (event.key === "ArrowUp" || event.key === "ArrowDown") {
        const ticketId = card.dataset.ticketId;

        if (ticketId) {
          event.preventDefault();
          void moveFocusedTicket(ticketId, event.key === "ArrowUp" ? "up" : "down");
        }
      }
    });

    card.addEventListener("dragstart", (event) => {
      const ticketId = card.dataset.ticketId;

      if (!ticketId || !event.dataTransfer) {
        return;
      }

      state.draggingId = ticketId;
      event.dataTransfer.effectAllowed = "move";
      event.dataTransfer.setData(ticketDragType, ticketId);
      card.classList.add("is-dragging");
      closeTicketMenu({ shouldRender: false });
    });

    card.addEventListener("dragend", () => {
      state.draggingId = null;
      cancelTicketDropCleanup();
      stopTicketAutoScroll();
      clearDropIndicators();
      document
        .querySelectorAll(".is-dragging, .is-drag-over")
        .forEach((node) => node.classList.remove("is-dragging", "is-drag-over"));
    });
  });

  document.querySelectorAll<HTMLElement>(".column").forEach((column) => {
    column.addEventListener("dragover", (event) => {
      if (!state.draggingId) {
        return;
      }

      event.preventDefault();
      if (event.dataTransfer) {
        event.dataTransfer.dropEffect = "move";
      }

      const list = column.querySelector<HTMLElement>(".ticket-list");
      if (!list) {
        return;
      }

      cancelTicketDropCleanup();
      setActiveDropList(list);
      updateTicketAutoScroll(list, event.clientY);
      updateDropIndicator(list, getInsertionBeforeId(list, event.clientY));
    });

    column.addEventListener("dragleave", (event) => {
      const relatedTarget = event.relatedTarget as Node | null;

      if (relatedTarget && column.contains(relatedTarget)) {
        return;
      }

      if (isPointInsideElement(column, event.clientX, event.clientY)) {
        return;
      }

      if (!relatedTarget && event.clientX === 0 && event.clientY === 0) {
        return;
      }

      scheduleTicketDropCleanup(column);
    });

    column.addEventListener("drop", async (event) => {
      event.preventDefault();
      cancelTicketDropCleanup();
      stopTicketAutoScroll();
      column.querySelector(".ticket-list")?.classList.remove("is-drag-over");

      const ticketId = event.dataTransfer?.getData(ticketDragType) || state.draggingId;
      const status = column.dataset.status as Status;
      const list = column.querySelector<HTMLElement>(".ticket-list");
      const beforeId = list ? getInsertionBeforeId(list, event.clientY) : undefined;

      if (!ticketId || !status) {
        return;
      }

      clearDropIndicators();
      await moveTicket(ticketId, status, beforeId);
    });
  });
}

function bindEditorEvents() {
  const backdrop = document.querySelector<HTMLElement>(".modal-backdrop");
  const panel = document.querySelector<HTMLElement>(".editor-panel");
  const titleInput = document.querySelector<HTMLInputElement>('.editor-panel input[name="title"]');
  const editorRoot = document.querySelector<HTMLElement>("[data-editor-root]");
  const statusSelector = document.querySelector<HTMLElement>("[data-status-selector]");

  if (editorRoot && state.draft) {
    mountMarkdownEditor(editorRoot, state.draft.body);
  }

  backdrop?.addEventListener("click", (event) => {
    if (event.target === backdrop) {
      void requestCloseEditor();
    }
  });

  panel?.addEventListener("click", (event) => {
    const target = event.target as HTMLElement;
    const clickedStatusSelector = target.closest<HTMLElement>("[data-status-selector]");

    if (!clickedStatusSelector) {
      closeStatusSelector(statusSelector);
    }

    const actionButton = target.closest<HTMLButtonElement>("button[data-action]");

    if (!actionButton?.dataset.action) {
      return;
    }

    const action = actionButton.dataset.action;

    if (action === "toggle-status-selector") {
      toggleStatusSelector(actionButton.closest<HTMLElement>("[data-status-selector]"));
      return;
    }

    if (action === "choose-status") {
      chooseDraftStatus(actionButton.dataset.statusValue, actionButton);
      return;
    }

    if (action === "close-editor") {
      void requestCloseEditor();
    }

    if (action === "delete-ticket") {
      void deleteSelectedTicket();
    }
  });

  titleInput?.addEventListener("input", () => {
    if (state.draft) {
      state.draft.title = titleInput.value;
      scheduleDraftSave();
    }
  });

  statusSelector?.addEventListener("keydown", (event) => {
    handleStatusSelectorKeydown(event, statusSelector);
  });

  statusSelector?.addEventListener("focusout", (event) => {
    const nextTarget = event.relatedTarget as Node | null;

    if (!nextTarget || !statusSelector.contains(nextTarget)) {
      closeStatusSelector(statusSelector);
    }
  });
}

function bindGlobalKeys() {
  window.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && state.renamingProjectId) {
      closeProjectRenameDialog();
      return;
    }

    if (event.key === "Escape" && (state.projectMenu || state.ticketMenu)) {
      closeContextMenus();
      return;
    }

    if (event.key === "Escape" && closeStatusSelector()) {
      event.preventDefault();
      return;
    }

    if (event.key === "Escape" && state.draft) {
      void requestCloseEditor();
    }

    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "s" && state.draft) {
      event.preventDefault();
      void saveDraft({ flush: true });
    }
  });
}

function openEditor(ticketId: string) {
  const ticket = state.tickets.find((candidate) => candidate.id === ticketId);

  if (!ticket) {
    return;
  }

  state.selectedTicketId = ticketId;
  state.draft = {
    id: ticket.id,
    title: ticket.title,
    body: ticket.body,
    status: ticket.status,
    pastedImages: []
  };
  state.draftSaveError = null;
  render();
  focusEditorPanel();
}

function focusEditorPanel() {
  const panel = document.querySelector<HTMLElement>(".editor-panel");

  if (!panel) {
    return;
  }

  panel.focus({ preventScroll: true });
}

function closeEditor() {
  clearScheduledDraftSave();
  state.selectedTicketId = null;
  state.draft = null;
  state.draftSaveError = null;
  render();
}

async function requestCloseEditor() {
  if (await saveDraft({ flush: true })) {
    closeEditor();
  }
}

async function confirmDiscardDraft() {
  if (!state.draft) {
    return true;
  }

  return saveDraft({ flush: true });
}

async function confirmAction(message: string, title: string) {
  if (isTauriRuntime) {
    return confirm(message, { title, kind: "warning" });
  }

  return window.confirm(message);
}

function hasUnsavedDraft() {
  const ticket = getSelectedTicket();

  if (!ticket || !state.draft) {
    return false;
  }

  return (
    ticket.title !== normalizeDraftTitle(state.draft.title) ||
    ticket.body !== normalizeDraftBody(state.draft.body) ||
    ticket.status !== state.draft.status ||
    state.draft.pastedImages.length > 0
  );
}

function normalizeDraftTitle(title: string) {
  return title.replace(/[\r\n]/g, " ").split(/\s+/).filter(Boolean).join(" ") || untitledTicketTitle;
}

function normalizeDraftBody(body: string) {
  return body.replace(/\r\n/g, "\n").replace(/\r/g, "\n").trimEnd();
}

function scheduleDraftSave(delayMs = draftAutosaveDelayMs) {
  if (!state.draft) {
    return;
  }

  clearScheduledDraftSave();
  draftAutosaveTimer = window.setTimeout(() => {
    draftAutosaveTimer = null;
    void saveDraft();
  }, delayMs);
}

function clearScheduledDraftSave() {
  if (!draftAutosaveTimer) {
    return;
  }

  window.clearTimeout(draftAutosaveTimer);
  draftAutosaveTimer = null;
}

async function saveDraft(options: SaveDraftOptions = {}) {
  clearScheduledDraftSave();

  await waitForActiveDraftSave();
  clearScheduledDraftSave();

  await waitForPendingImageUploads();

  await waitForActiveDraftSave();
  clearScheduledDraftSave();

  if (!state.selectedProjectId || !state.draft || !hasUnsavedDraft()) {
    return true;
  }

  const savePromise = persistCurrentDraft();
  const saveRunId = ++draftSaveRunId;
  draftSavePromise = savePromise;
  let saved = false;

  try {
    await savePromise;
    saved = true;
  } catch (error) {
    showDraftSaveError(error);
    scheduleDraftSave(draftAutosaveRetryDelayMs);
    return false;
  } finally {
    if (draftSaveRunId === saveRunId) {
      draftSavePromise = null;
    }
  }

  if (saved && state.draft && hasUnsavedDraft()) {
    if (options.flush) {
      return saveDraft(options);
    }

    scheduleDraftSave();
  }

  return true;
}

async function persistCurrentDraft() {
  const projectId = state.selectedProjectId;
  const draft = state.draft;

  if (!projectId || !draft) {
    return;
  }

  const ticketId = draft.id;
  const title = normalizeDraftTitle(draft.title);
  const body = normalizeDraftBody(draft.body);
  const status = draft.status;
  const imagePaths = [...draft.pastedImages];
  const unusedImages = unusedDraftImages(draft);
  await cleanupTicketImages(projectId, unusedImages);

  const updated = await api.updateTicket(projectId, ticketId, title, body, status);

  clearDraftSaveError();
  state.tickets = state.tickets.map((ticket) => (ticket.id === updated.id ? updated : ticket)).sort(sortTickets);

  if (state.draft?.id === ticketId) {
    const savedImages = new Set(imagePaths);
    state.draft.pastedImages = state.draft.pastedImages.filter((imagePath) => !savedImages.has(imagePath));
  }
}

async function waitForActiveDraftSave() {
  await draftSavePromise?.catch(() => undefined);
}

async function bindWindowCloseGuards() {
  if (isTauriRuntime) {
    const appWindow = getCurrentWindow();

    await appWindow.onCloseRequested(async (event) => {
      if (isClosingWindow || !state.draft || !hasUnsavedDraft()) {
        return;
      }

      event.preventDefault();
      isClosingWindow = true;

      try {
        await Promise.race([saveDraft({ flush: true }), wait(closeAutosaveTimeoutMs)]);
      } finally {
        await appWindow.destroy();
      }
    });
  } else {
    window.addEventListener("beforeunload", (event) => {
      if (!state.draft || !hasUnsavedDraft()) {
        return;
      }

      if (persistMockDraftSync()) {
        return;
      }

      void saveDraft({ flush: true });
      event.preventDefault();
      event.returnValue = "";
    });
  }

  window.addEventListener("pagehide", () => {
    if (state.draft && !persistMockDraftSync()) {
      void saveDraft({ flush: true });
    }
  });
}

function wait(ms: number) {
  return new Promise<void>((resolve) => {
    window.setTimeout(resolve, ms);
  });
}

function persistMockDraftSync() {
  if (isTauriRuntime || !state.selectedProjectId || !state.draft) {
    return false;
  }

  if (pendingImageUploads.size > 0 || hasPendingPastePlaceholder(state.draft.body)) {
    return false;
  }

  try {
    const raw = localStorage.getItem(mockStorageKey);

    if (!raw) {
      return false;
    }

    const store = JSON.parse(raw) as MockStore;
    const projectId = state.selectedProjectId;
    const draft = state.draft;
    let updated: Ticket | null = null;

    store.tickets[projectId] = (store.tickets[projectId] ?? []).map((ticket) => {
      if (ticket.id !== draft.id) {
        return ticket;
      }

      updated = {
        ...ticket,
        title: normalizeDraftTitle(draft.title),
        body: normalizeDraftBody(draft.body),
        status: draft.status,
        updatedAt: Date.now()
      };
      return updated;
    });

    if (!updated) {
      return false;
    }

    localStorage.setItem(mockStorageKey, JSON.stringify(store));
    clearScheduledDraftSave();
    clearDraftSaveError();
    state.tickets = state.tickets.map((ticket) => (ticket.id === updated?.id ? updated : ticket)).sort(sortTickets);
    state.draft.pastedImages = [];
    return true;
  } catch {
    return false;
  }
}

function hasPendingPastePlaceholder(body: string) {
  return /todo-md-paste-\d+-[a-z0-9]+/.test(body);
}

async function deleteSelectedTicket() {
  if (!state.selectedTicketId) {
    return;
  }

  await deleteTicket(state.selectedTicketId);
}

async function deleteTicket(ticketId: string) {
  if (!state.selectedProjectId) {
    return;
  }

  const ticket = getTicket(ticketId);

  if (!ticket || !(await confirmAction(`Delete "${ticket.title}"?`, "Delete ticket"))) {
    return;
  }

  try {
    clearScheduledDraftSave();
    await waitForActiveDraftSave();
    await waitForPendingImageUploads();
    await cleanupDraftImages();
    await api.deleteTicket(state.selectedProjectId, ticket.id);
    state.tickets = state.tickets.filter((candidate) => candidate.id !== ticket.id);
    state.workspace = updateTicketCount(state.workspace, state.selectedProjectId, -1);
    state.ticketMenu = null;

    if (state.selectedTicketId === ticket.id) {
      state.selectedTicketId = null;
      state.draft = null;
    }

    render();
  } catch (error) {
    showError(error);
  }
}

async function cleanupDraftImages() {
  if (!state.selectedProjectId || !state.draft?.pastedImages.length) {
    return;
  }

  const projectId = state.selectedProjectId;
  const imagePaths = [...state.draft.pastedImages];

  state.draft.pastedImages = [];

  try {
    await cleanupTicketImages(projectId, imagePaths);
  } catch (error) {
    if (state.draft) {
      state.draft.pastedImages = imagePaths;
    }
    throw error;
  }
}

async function cleanupTicketImages(projectId: string, imagePaths: string[]) {
  await Promise.all(imagePaths.map((imagePath) => api.deleteTicketImage(projectId, imagePath)));
}

function unusedDraftImages(draft: TicketDraft) {
  return draft.pastedImages.filter((imagePath) => !draft.body.includes(`](${imagePath})`));
}

async function moveTicket(ticketId: string, status: Status, beforeId?: string) {
  if (!state.selectedProjectId) {
    return;
  }

  const dragged = state.tickets.find((ticket) => ticket.id === ticketId);

  if (!dragged || beforeId === ticketId) {
    return;
  }

  const remaining = state.tickets.filter((ticket) => ticket.id !== ticketId);
  const nextTicket = { ...dragged, status };
  const nextTickets = insertTicket(remaining, nextTicket, status, beforeId).map((ticket) => ({ ...ticket }));
  const positions = renumberTickets(nextTickets);

  state.tickets = nextTickets.sort(sortTickets);
  render({ preserveScroll: true });

  try {
    state.tickets = await api.reorderTickets(state.selectedProjectId, positions);
    render({ preserveScroll: true });
  } catch (error) {
    showError(error, { preserveScroll: true });
    await loadTickets(state.selectedProjectId);
    render({ preserveScroll: true });
  }
}

type KeyboardMoveDirection = "up" | "down";

async function moveFocusedTicket(ticketId: string, direction: KeyboardMoveDirection) {
  const ticket = state.tickets.find((candidate) => candidate.id === ticketId);

  if (!ticket) {
    return;
  }

  const columnTickets = ticketsFor(ticket.status);
  const index = columnTickets.findIndex((candidate) => candidate.id === ticketId);

  if (index === -1) {
    return;
  }

  if (direction === "up" && index === 0) {
    return;
  }

  if (direction === "down" && index >= columnTickets.length - 1) {
    return;
  }

  const beforeId = direction === "up" ? columnTickets[index - 1]?.id : columnTickets[index + 2]?.id;
  await moveTicket(ticketId, ticket.status, beforeId);
  focusTicket(ticketId);
}

function insertTicket(tickets: Ticket[], ticket: Ticket, status: Status, beforeId?: string) {
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

function getInsertionBeforeId(list: HTMLElement, pointerY: number) {
  const cards = Array.from(list.querySelectorAll<HTMLElement>(".ticket-card:not(.is-dragging)"));

  for (const card of cards) {
    const rect = card.getBoundingClientRect();

    if (pointerY < rect.top + rect.height / 2) {
      return card.dataset.ticketId;
    }
  }

  return undefined;
}

function updateTicketAutoScroll(list: HTMLElement, pointerY: number) {
  const velocity = getTicketAutoScrollVelocity(list, pointerY);

  if (velocity === 0) {
    stopTicketAutoScroll();
    return;
  }

  if (ticketAutoScroll.list !== list) {
    ticketAutoScroll.lastTimestamp = 0;
  }

  ticketAutoScroll.list = list;
  ticketAutoScroll.pointerY = pointerY;
  ticketAutoScroll.velocity = velocity;

  if (ticketAutoScroll.frameId === null) {
    ticketAutoScroll.frameId = requestAnimationFrame(stepTicketAutoScroll);
  }
}

function getTicketAutoScrollVelocity(list: HTMLElement, pointerY: number) {
  const maxScrollTop = Math.max(0, list.scrollHeight - list.clientHeight);

  if (maxScrollTop === 0) {
    return 0;
  }

  const rect = list.getBoundingClientRect();
  const edgeSize = Math.min(ticketAutoScrollEdge, rect.height / 2);
  const topDistance = pointerY - rect.top;
  const bottomDistance = rect.bottom - pointerY;

  if (topDistance < edgeSize && list.scrollTop > 0) {
    return -ticketAutoScrollMaxSpeed * getTicketAutoScrollIntensity(topDistance, edgeSize);
  }

  if (bottomDistance < edgeSize && list.scrollTop < maxScrollTop) {
    return ticketAutoScrollMaxSpeed * getTicketAutoScrollIntensity(bottomDistance, edgeSize);
  }

  return 0;
}

function getTicketAutoScrollIntensity(distance: number, edgeSize: number) {
  return Math.min(1, Math.max(0, edgeSize - distance) / edgeSize);
}

function stepTicketAutoScroll(timestamp: number) {
  const list = ticketAutoScroll.list;

  if (!list || !state.draggingId) {
    stopTicketAutoScroll();
    return;
  }

  const maxScrollTop = Math.max(0, list.scrollHeight - list.clientHeight);
  const elapsed = ticketAutoScroll.lastTimestamp
    ? Math.min(timestamp - ticketAutoScroll.lastTimestamp, 32)
    : 16;
  const nextScrollTop = Math.min(
    maxScrollTop,
    Math.max(0, list.scrollTop + (ticketAutoScroll.velocity * elapsed) / 1000)
  );

  ticketAutoScroll.lastTimestamp = timestamp;

  if (nextScrollTop === list.scrollTop && (nextScrollTop === 0 || nextScrollTop === maxScrollTop)) {
    stopTicketAutoScroll();
    return;
  }

  list.scrollTop = nextScrollTop;
  updateDropIndicator(list, getInsertionBeforeId(list, ticketAutoScroll.pointerY));

  ticketAutoScroll.velocity = getTicketAutoScrollVelocity(list, ticketAutoScroll.pointerY);

  if (ticketAutoScroll.velocity === 0) {
    stopTicketAutoScroll();
    return;
  }

  ticketAutoScroll.frameId = requestAnimationFrame(stepTicketAutoScroll);
}

function stopTicketAutoScroll() {
  if (ticketAutoScroll.frameId !== null) {
    cancelAnimationFrame(ticketAutoScroll.frameId);
  }

  ticketAutoScroll.frameId = null;
  ticketAutoScroll.lastTimestamp = 0;
  ticketAutoScroll.list = null;
  ticketAutoScroll.pointerY = 0;
  ticketAutoScroll.velocity = 0;
}

function scheduleTicketDropCleanup(column: HTMLElement) {
  cancelTicketDropCleanup();
  ticketDropCleanupFrameId = requestAnimationFrame(() => {
    ticketDropCleanupFrameId = null;

    if (!state.draggingId) {
      return;
    }

    stopTicketAutoScroll();
    column.querySelector(".ticket-list")?.classList.remove("is-drag-over");
    clearDropIndicators();
  });
}

function cancelTicketDropCleanup() {
  if (ticketDropCleanupFrameId !== null) {
    cancelAnimationFrame(ticketDropCleanupFrameId);
  }

  ticketDropCleanupFrameId = null;
}

function isPointInsideElement(element: HTMLElement, clientX: number, clientY: number) {
  const rect = element.getBoundingClientRect();

  return clientX >= rect.left && clientX <= rect.right && clientY >= rect.top && clientY <= rect.bottom;
}

function setActiveDropList(list: HTMLElement) {
  document.querySelectorAll<HTMLElement>(".ticket-list.is-drag-over").forEach((candidate) => {
    if (candidate !== list) {
      candidate.classList.remove("is-drag-over");
    }
  });

  list.classList.add("is-drag-over");
}

function updateDropIndicator(list: HTMLElement, beforeId?: string) {
  const currentBefore = document.querySelector<HTMLElement>(".ticket-card.is-drop-before");
  const currentAfter = document.querySelector<HTMLElement>(".ticket-card.is-drop-after");
  const currentEnd = document.querySelector<HTMLElement>(".ticket-list.is-drop-at-end");

  if (beforeId) {
    const nextBefore = findTicketCard(beforeId, list);

    if (nextBefore && currentBefore === nextBefore && !currentAfter && !currentEnd) {
      return;
    }

    clearDropIndicators();
    nextBefore?.classList.add("is-drop-before");
    return;
  }

  const nextAfter = findLastTicketCard(list);

  if (nextAfter) {
    if (currentAfter === nextAfter && !currentBefore && !currentEnd) {
      return;
    }

    clearDropIndicators();
    nextAfter.classList.add("is-drop-after");
    return;
  }

  if (currentEnd === list && !currentBefore && !currentAfter) {
    return;
  }

  clearDropIndicators();
  list.classList.add("is-drop-at-end");
}

function clearDropIndicators() {
  document
    .querySelectorAll(".is-drop-before, .is-drop-after, .is-drop-at-end")
    .forEach((node) => node.classList.remove("is-drop-before", "is-drop-after", "is-drop-at-end"));
}

function findTicketCard(ticketId: string, root: ParentNode = document) {
  return (
    Array.from(root.querySelectorAll<HTMLElement>(".ticket-card")).find(
      (card) => card.dataset.ticketId === ticketId
    ) ?? null
  );
}

function findLastTicketCard(root: ParentNode = document) {
  const cards = Array.from(root.querySelectorAll<HTMLElement>(".ticket-card:not(.is-dragging)"));

  return cards[cards.length - 1] ?? null;
}

function focusTicket(ticketId: string) {
  findTicketCard(ticketId)?.focus();
}

function captureScrollSnapshot(): ScrollSnapshot {
  return {
    windowX: window.scrollX,
    windowY: window.scrollY,
    elements: Array.from(
      document.querySelectorAll<HTMLElement>(".project-list, .workspace, .board, .ticket-list[data-status]")
    ).flatMap((element) => {
      const key = scrollSnapshotKey(element);

      if (!key) {
        return [];
      }

      return [
        {
          key,
          scrollLeft: element.scrollLeft,
          scrollTop: element.scrollTop
        }
      ];
    })
  };
}

function restoreScrollSnapshot(snapshot: ScrollSnapshot | null) {
  if (!snapshot) {
    return;
  }

  snapshot.elements.forEach((position) => {
    const element = scrollSnapshotElement(position.key);

    if (!element) {
      return;
    }

    element.scrollLeft = position.scrollLeft;
    element.scrollTop = Math.min(position.scrollTop, Math.max(0, element.scrollHeight - element.clientHeight));
  });

  window.scrollTo(snapshot.windowX, snapshot.windowY);
}

function scrollSnapshotKey(element: HTMLElement) {
  if (element.classList.contains("ticket-list") && element.dataset.status) {
    return `ticket-list:${element.dataset.status}`;
  }

  if (element.classList.contains("project-list")) {
    return "project-list";
  }

  if (element.classList.contains("workspace")) {
    return "workspace";
  }

  if (element.classList.contains("board")) {
    return "board";
  }

  return null;
}

function scrollSnapshotElement(key: string) {
  if (key.startsWith("ticket-list:")) {
    const status = key.slice("ticket-list:".length);

    return (
      Array.from(document.querySelectorAll<HTMLElement>(".ticket-list[data-status]")).find(
        (element) => element.dataset.status === status
      ) ?? null
    );
  }

  if (key === "project-list") {
    return document.querySelector<HTMLElement>(".project-list");
  }

  if (key === "workspace") {
    return document.querySelector<HTMLElement>(".workspace");
  }

  if (key === "board") {
    return document.querySelector<HTMLElement>(".board");
  }

  return null;
}

function renumberTickets(tickets: Ticket[]) {
  const nextPositions: Array<{ id: string; status: Status; order: number }> = [];

  for (const status of columns.map((column) => column.id)) {
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

function getSelectedTicket() {
  return state.selectedTicketId ? getTicket(state.selectedTicketId) : null;
}

function getTicket(ticketId: string) {
  return state.tickets.find((ticket) => ticket.id === ticketId) ?? null;
}

function getCurrentProject() {
  return state.selectedProjectId ? getProject(state.selectedProjectId) : null;
}

function getProject(projectId: string) {
  return state.workspace?.projects.find((project) => project.id === projectId) ?? null;
}

function findNeighborProjectId(projectId: string) {
  const projects = state.workspace?.projects ?? [];
  const index = projects.findIndex((project) => project.id === projectId);

  if (index < 0) {
    return null;
  }

  return projects[index + 1]?.id ?? projects[index - 1]?.id ?? null;
}

function updateProjectInWorkspace(workspace: WorkspaceInfo | null, updated: ProjectSummary) {
  if (!workspace) {
    return workspace;
  }

  return {
    ...workspace,
    projects: workspace.projects.map((project) => (project.id === updated.id ? updated : project))
  };
}

function ticketsFor(status: Status) {
  return state.tickets.filter((ticket) => ticket.status === status).sort(sortTickets);
}

function sortTickets(a: Ticket, b: Ticket) {
  return statusIndex(a.status) - statusIndex(b.status) || a.order - b.order || a.title.localeCompare(b.title);
}

function statusIndex(status: Status) {
  return columns.findIndex((column) => column.id === status);
}

function columnForStatus(status: Status) {
  return columns.find((column) => column.id === status) ?? columns[0];
}

function isStatus(value: string | undefined): value is Status {
  return columns.some((column) => column.id === value);
}

function toggleStatusSelector(selector: HTMLElement | null) {
  if (!selector) {
    return;
  }

  setStatusSelectorOpen(selector, !selector.classList.contains("is-open"));
}

function closeStatusSelector(selector?: HTMLElement | null) {
  const target = selector ?? document.querySelector<HTMLElement>("[data-status-selector].is-open");

  if (!target?.classList.contains("is-open")) {
    return false;
  }

  setStatusSelectorOpen(target, false);
  return true;
}

function setStatusSelectorOpen(selector: HTMLElement, isOpen: boolean) {
  selector.classList.toggle("is-open", isOpen);
  selector.querySelector<HTMLButtonElement>(".status-selector-button")?.setAttribute("aria-expanded", String(isOpen));

  if (isOpen) {
    focusSelectedStatusOption(selector);
  }
}

function chooseDraftStatus(value: string | undefined, source: HTMLElement) {
  if (!isStatus(value) || !state.draft) {
    return;
  }

  if (state.draft.status !== value) {
    state.draft.status = value;
    scheduleDraftSave();
  }

  const selector = source.closest<HTMLElement>("[data-status-selector]");
  updateStatusSelector(selector, value);
  closeStatusSelector(selector);
  selector?.querySelector<HTMLButtonElement>(".status-selector-button")?.focus();
}

function updateStatusSelector(selector: HTMLElement | null, status: Status) {
  if (!selector) {
    return;
  }

  const selected = columnForStatus(status);
  const currentIcon = selector.querySelector<HTMLElement>("[data-status-current-icon]");
  const currentLabel = selector.querySelector<HTMLElement>("[data-status-current-label]");
  const trigger = selector.querySelector<HTMLButtonElement>(".status-selector-button");

  trigger?.setAttribute("aria-label", `Status: ${selected.label}. Change status`);

  if (currentIcon) {
    currentIcon.className = `status-current-icon status-icon-${selected.id}`;
    currentIcon.innerHTML = icon(selected.icon);
  }

  if (currentLabel) {
    currentLabel.textContent = selected.label;
  }

  selector.querySelectorAll<HTMLButtonElement>(".status-option").forEach((option) => {
    const isSelected = option.dataset.statusValue === status;
    option.classList.toggle("selected", isSelected);
    option.setAttribute("aria-checked", String(isSelected));

    const check = option.querySelector<HTMLElement>(".status-option-check");

    if (check) {
      check.innerHTML = isSelected ? icon("check") : "";
    }
  });

  hydrateIcons();
}

function handleStatusSelectorKeydown(event: KeyboardEvent, selector: HTMLElement) {
  const options = Array.from(selector.querySelectorAll<HTMLButtonElement>(".status-option"));

  if (!options.length) {
    return;
  }

  if (event.key === "Escape" && selector.classList.contains("is-open")) {
    event.preventDefault();
    event.stopPropagation();
    closeStatusSelector(selector);
    selector.querySelector<HTMLButtonElement>(".status-selector-button")?.focus();
    return;
  }

  if (event.key === "ArrowDown" || event.key === "ArrowUp") {
    event.preventDefault();
    event.stopPropagation();

    if (!selector.classList.contains("is-open")) {
      setStatusSelectorOpen(selector, true);
      return;
    }

    focusStatusOption(selector, event.key === "ArrowDown" ? 1 : -1);
    return;
  }

  if (event.key === "Home" || event.key === "End") {
    event.preventDefault();
    event.stopPropagation();
    setStatusSelectorOpen(selector, true);
    options[event.key === "Home" ? 0 : options.length - 1]?.focus();
    return;
  }

  if ((event.key === "Enter" || event.key === " ") && document.activeElement?.classList.contains("status-option")) {
    event.preventDefault();
    event.stopPropagation();
    chooseDraftStatus((document.activeElement as HTMLElement).dataset.statusValue, document.activeElement as HTMLElement);
  }
}

function focusSelectedStatusOption(selector: HTMLElement) {
  (
    selector.querySelector<HTMLButtonElement>(".status-option.selected") ??
    selector.querySelector<HTMLButtonElement>(".status-option")
  )?.focus();
}

function focusStatusOption(selector: HTMLElement, offset: -1 | 1) {
  const options = Array.from(selector.querySelectorAll<HTMLButtonElement>(".status-option"));
  const currentIndex = options.findIndex((option) => option === document.activeElement);
  const selectedIndex = options.findIndex((option) => option.classList.contains("selected"));
  const startIndex = currentIndex >= 0 ? currentIndex : Math.max(0, selectedIndex);
  const nextIndex = (startIndex + offset + options.length) % options.length;

  options[nextIndex]?.focus();
}

type TaggedTicketTitle = {
  tag: string;
  text: string;
};

function renderTicketTitle(title: string) {
  const taggedTitle = parseTicketTitle(title);

  if (!taggedTitle) {
    return escapeHtml(title);
  }

  const tagVariant = ticketTitleTagVariant(taggedTitle.tag);
  const titleText = taggedTitle.text
    ? `<span class="ticket-title-text">${escapeHtml(taggedTitle.text)}</span>`
    : "";

  return `
    <span class="ticket-title">
      <span class="ticket-title-chip ticket-title-chip-${tagVariant}">${escapeHtml(taggedTitle.tag)}</span>
      ${titleText}
    </span>
  `;
}

function parseTicketTitle(title: string): TaggedTicketTitle | null {
  const trimmed = title.trim();
  const bracketTag = /^\[([^\]\r\n]{1,32})\](?:\s+(.*)|$)/.exec(trimmed);

  if (bracketTag) {
    const tag = normalizeTicketTitleTag(bracketTag[1]);

    if (!tag) {
      return null;
    }

    return {
      tag,
      text: bracketTag[2]?.trim() ?? ""
    };
  }

  const colonTag = /^([A-Za-z][A-Za-z0-9 _/-]{0,31}):\s+(.+)$/.exec(trimmed);

  if (!colonTag) {
    return null;
  }

  const tag = normalizeTicketTitleTag(colonTag[1]);

  if (!tag) {
    return null;
  }

  return {
    tag,
    text: colonTag[2].trim()
  };
}

function normalizeTicketTitleTag(tag: string) {
  return tag.split(/\s+/).filter(Boolean).join(" ");
}

function ticketTitleTagVariant(tag: string) {
  let hash = 0;

  for (const character of tag.toLowerCase()) {
    hash = (hash * 31 + character.charCodeAt(0)) >>> 0;
  }

  return hash % 6;
}

function mountMarkdownEditor(parent: HTMLElement, value: string) {
  destroyMarkdownEditor();

  markdownEditorView = new EditorView({
    parent,
    state: EditorState.create({
      doc: value,
      extensions: [
        history(),
        markdown({ base: markdownLanguage, addKeymap: false }),
        indentOnInput(),
        bracketMatching(),
        syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
        keymap.of([...markdownKeymap, ...historyKeymap, ...defaultKeymap]),
        inlineMarkdownDecorations,
        placeholder("Start writing..."),
        EditorView.domEventHandlers({
          paste(event, view) {
            const image = imageFileFromPaste(event);

            if (!image) {
              return false;
            }

            event.preventDefault();
            trackPendingImageUpload(pasteImageIntoEditor(image, view));
            return true;
          }
        }),
        EditorView.lineWrapping,
        EditorView.updateListener.of((update) => {
          if (update.docChanged && state.draft) {
            state.draft.body = update.state.doc.toString();
            scheduleDraftSave();
          }
        })
      ]
    })
  });
}

function destroyMarkdownEditor() {
  markdownEditorView?.destroy();
  markdownEditorView = null;
}

type PastedImage = {
  file: File;
  mimeType: string;
};

function imageFileFromPaste(event: ClipboardEvent): PastedImage | null {
  const clipboardData = event.clipboardData;
  const items = Array.from(clipboardData?.items ?? []);

  for (const item of items) {
    if (item.kind !== "file") {
      continue;
    }

    const file = item.getAsFile();
    const mimeType = file?.type || item.type;

    if (file && mimeType.startsWith("image/") && imageExtensionForMime(mimeType)) {
      return {
        file,
        mimeType
      };
    }
  }

  for (const file of Array.from(clipboardData?.files ?? [])) {
    if (file.type.startsWith("image/") && imageExtensionForMime(file.type)) {
      return {
        file,
        mimeType: file.type
      };
    }
  }

  return null;
}

async function pasteImageIntoEditor(image: PastedImage, view: EditorView) {
  const projectId = state.selectedProjectId;
  const draftId = state.draft?.id;

  if (!projectId || !draftId) {
    return;
  }

  if (image.file.size > maxPastedImageBytes) {
    showError(new Error("Image is too large."));
    return;
  }

  const placeholderMarkdown = `![Pasted image](todo-md-paste-${Date.now()}-${Math.random()
    .toString(36)
    .slice(2)})`;
  insertMarkdownAtSelection(view, placeholderMarkdown);

  try {
    const buffer = await image.file.arrayBuffer();
    const bytes = Array.from(new Uint8Array(buffer));
    const saved = await api.saveTicketImage(projectId, draftId, image.mimeType, bytes);

    if (markdownEditorView !== view || state.selectedProjectId !== projectId || state.draft?.id !== draftId) {
      await api.deleteTicketImage(projectId, saved.markdownPath);
      return;
    }

    const inserted = replaceMarkdownInEditor(
      view,
      placeholderMarkdown,
      `![${saved.alt}](${saved.markdownPath})`
    );

    if (!inserted) {
      await api.deleteTicketImage(projectId, saved.markdownPath);
      return;
    }

    state.draft.pastedImages.push(saved.markdownPath);
  } catch (error) {
    removeMarkdownFromEditor(view, placeholderMarkdown);
    showError(error);
  }
}

function trackPendingImageUpload(upload: Promise<void>) {
  pendingImageUploads.add(upload);
  upload.finally(() => {
    pendingImageUploads.delete(upload);
  });
}

async function waitForPendingImageUploads() {
  while (pendingImageUploads.size) {
    await Promise.allSettled(Array.from(pendingImageUploads));
  }
}

function insertMarkdownAtSelection(view: EditorView, markdown: string) {
  const selection = view.state.selection.main;
  const startsAtLineStart =
    selection.from === 0 || view.state.doc.sliceString(selection.from - 1, selection.from) === "\n";
  const endsAtLineEnd =
    selection.to === view.state.doc.length || view.state.doc.sliceString(selection.to, selection.to + 1) === "\n";
  const prefix = startsAtLineStart ? "" : "\n";
  const suffix = endsAtLineEnd ? "" : "\n";
  const insert = `${prefix}${markdown}${suffix}`;

  view.dispatch({
    changes: {
      from: selection.from,
      to: selection.to,
      insert
    },
    selection: {
      anchor: selection.from + insert.length
    },
    scrollIntoView: true
  });
  view.focus();
}

function replaceMarkdownInEditor(view: EditorView, currentMarkdown: string, nextMarkdown: string) {
  const position = view.state.doc.toString().indexOf(currentMarkdown);

  if (position === -1) {
    return false;
  }

  view.dispatch({
    changes: {
      from: position,
      to: position + currentMarkdown.length,
      insert: nextMarkdown
    },
    selection: {
      anchor: position + nextMarkdown.length
    },
    scrollIntoView: true
  });
  view.focus();
  return true;
}

function removeMarkdownFromEditor(view: EditorView, markdown: string) {
  const position = view.state.doc.toString().indexOf(markdown);

  if (position === -1) {
    return;
  }

  view.dispatch({
    changes: {
      from: position,
      to: position + markdown.length,
      insert: ""
    }
  });
}

const inlineMarkdownDecorations = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;

    constructor(view: EditorView) {
      this.decorations = buildInlineMarkdownDecorations(view.state, view.hasFocus);
    }

    update(update: ViewUpdate) {
      if (update.docChanged || update.selectionSet || update.focusChanged || update.viewportChanged) {
        this.decorations = buildInlineMarkdownDecorations(update.state, update.view.hasFocus);
      }
    }
  },
  {
    decorations: (value) => value.decorations
  }
);

function buildInlineMarkdownDecorations(editorState: EditorState, editorHasFocus: boolean) {
  const decorations: Array<Range<Decoration>> = [];
  const activeLines = editorHasFocus ? activeMarkdownLines(editorState) : new Set<number>();
  let inCodeFence = false;

  for (let lineNumber = 1; lineNumber <= editorState.doc.lines; lineNumber += 1) {
    const line = editorState.doc.line(lineNumber);
    const text = line.text;
    const isActive = activeLines.has(lineNumber);
    const isFence = text.trimStart().startsWith("```");

    if (inCodeFence || isFence) {
      decorations.push(Decoration.line({ class: "cm-md-code-line" }).range(line.from));
      if (isFence) {
        decorations.push(Decoration.mark({ class: "cm-md-code-fence" }).range(line.from, line.to));
      }
      inCodeFence = isFence ? !inCodeFence : inCodeFence;
      continue;
    }

    decorateMarkdownLine(decorations, line.from, line.to, text, isActive);
  }

  return Decoration.set(decorations, true);
}

function activeMarkdownLines(editorState: EditorState) {
  const activeLines = new Set<number>();

  editorState.selection.ranges.forEach((range) => {
    const from = Math.min(range.from, range.to);
    const to = Math.max(range.from, range.to);
    const fromLine = editorState.doc.lineAt(from).number;
    const toLine = editorState.doc.lineAt(to).number;

    for (let lineNumber = fromLine; lineNumber <= toLine; lineNumber += 1) {
      activeLines.add(lineNumber);
    }
  });

  return activeLines;
}

function decorateMarkdownLine(
  decorations: Array<Range<Decoration>>,
  lineFrom: number,
  lineTo: number,
  text: string,
  isActive: boolean
) {
  const heading = /^(#{1,3})(\s+)/.exec(text);
  const quote = /^>\s?/.exec(text);
  const task = /^(\s*)([-*]\s+)(\[[ xX]\])\s+/.exec(text);
  const unordered = /^(\s*)([-*])\s+/.exec(text);
  const ordered = /^(\s*)(\d+\.)\s+/.exec(text);

  if (heading) {
    const level = heading[1].length;
    decorations.push(
      Decoration.line({ class: `cm-md-heading-line cm-md-heading-${level}` }).range(lineFrom)
    );

    if (!isActive) {
      decorations.push(Decoration.replace({}).range(lineFrom, lineFrom + heading[0].length));
    }
  }

  if (quote) {
    decorations.push(Decoration.line({ class: "cm-md-quote-line" }).range(lineFrom));

    if (!isActive) {
      decorations.push(Decoration.replace({}).range(lineFrom, lineFrom + quote[0].length));
    }
  }

  if (task) {
    const markerFrom = lineFrom + task[1].length;
    const checkboxFrom = markerFrom + task[2].length;
    const markerTo = lineFrom + task[0].length;
    const isChecked = task[3].toLowerCase() === "[x]";

    decorations.push(Decoration.line({ class: "cm-md-task-line" }).range(lineFrom));

    if (isChecked && markerTo < lineTo) {
      decorations.push(Decoration.mark({ class: "cm-md-task-done" }).range(markerTo, lineTo));
    }

    if (!isActive) {
      decorations.push(
        Decoration.replace({
          widget: new TaskCheckboxWidget(isChecked, checkboxFrom)
        }).range(markerFrom, markerTo)
      );
    }
  } else if (unordered) {
    decorations.push(Decoration.line({ class: "cm-md-list-line" }).range(lineFrom));

    if (!isActive) {
      const markerFrom = lineFrom + unordered[1].length;
      decorations.push(
        Decoration.replace({
          widget: new BulletWidget()
        }).range(markerFrom, markerFrom + unordered[2].length + 1)
      );
    }
  } else if (ordered) {
    decorations.push(Decoration.line({ class: "cm-md-list-line" }).range(lineFrom));
  }

  decorateInlineMarkdown(decorations, lineFrom, text, isActive);
}

function decorateInlineMarkdown(
  decorations: Array<Range<Decoration>>,
  lineFrom: number,
  text: string,
  isActive: boolean
) {
  const protectedRanges: Array<{ from: number; to: number }> = [];
  const lineContainsOnlyImages = text.replace(/!\[([^\]\n]*)\]\(([^)\s]+)\)/g, "").trim() === "";
  let decoratedImageLine = false;

  for (const match of text.matchAll(/`([^`\n]+)`/g)) {
    const from = lineFrom + (match.index ?? 0);
    const contentFrom = from + 1;
    const contentTo = contentFrom + match[1].length;

    protectedRanges.push({ from, to: contentTo + 1 });
    decorations.push(Decoration.mark({ class: "cm-md-inline-code" }).range(contentFrom, contentTo));
    hideMarkdownRange(decorations, from, contentFrom, isActive);
    hideMarkdownRange(decorations, contentTo, contentTo + 1, isActive);
  }

  for (const match of text.matchAll(/\*\*([^*\n]+)\*\*/g)) {
    const from = lineFrom + (match.index ?? 0);
    const contentFrom = from + 2;
    const contentTo = contentFrom + match[1].length;

    if (overlapsProtectedRange(from, contentTo + 2, protectedRanges)) {
      continue;
    }

    decorations.push(Decoration.mark({ class: "cm-md-strong" }).range(contentFrom, contentTo));
    hideMarkdownRange(decorations, from, contentFrom, isActive);
    hideMarkdownRange(decorations, contentTo, contentTo + 2, isActive);
  }

  for (const match of text.matchAll(/(^|[^*])\*([^*\n]+)\*(?!\*)/g)) {
    const prefixLength = match[1].length;
    const markerFrom = lineFrom + (match.index ?? 0) + prefixLength;
    const contentFrom = markerFrom + 1;
    const contentTo = contentFrom + match[2].length;

    if (overlapsProtectedRange(markerFrom, contentTo + 1, protectedRanges)) {
      continue;
    }

    decorations.push(Decoration.mark({ class: "cm-md-emphasis" }).range(contentFrom, contentTo));
    hideMarkdownRange(decorations, markerFrom, contentFrom, isActive);
    hideMarkdownRange(decorations, contentTo, contentTo + 1, isActive);
  }

  for (const match of text.matchAll(/!\[([^\]\n]*)\]\(([^)\s]+)\)/g)) {
    const from = lineFrom + (match.index ?? 0);
    const labelFrom = from + 2;
    const labelTo = labelFrom + match[1].length;
    const to = from + match[0].length;

    if (overlapsProtectedRange(from, to, protectedRanges)) {
      continue;
    }

    const src = resolveMarkdownImageSrc(match[2], getCurrentProject()?.path);

    if (!src) {
      continue;
    }

    protectedRanges.push({ from, to });

    if (isActive) {
      if (labelFrom < labelTo) {
        decorations.push(Decoration.mark({ class: "cm-md-link" }).range(labelFrom, labelTo));
      }
      continue;
    }

    if (lineContainsOnlyImages && !decoratedImageLine) {
      decorations.push(Decoration.line({ class: "cm-md-image-line" }).range(lineFrom));
      decoratedImageLine = true;
    }

    decorations.push(
      Decoration.replace({
        widget: new MarkdownImageWidget(src, match[1] || "Pasted image")
      }).range(from, to)
    );
  }

  for (const match of text.matchAll(/\[([^\]\n]+)\]\((https?:\/\/[^)\s]+)\)/g)) {
    const from = lineFrom + (match.index ?? 0);
    const labelFrom = from + 1;
    const labelTo = labelFrom + match[1].length;
    const to = from + match[0].length;

    if (overlapsProtectedRange(from, to, protectedRanges)) {
      continue;
    }

    decorations.push(Decoration.mark({ class: "cm-md-link" }).range(labelFrom, labelTo));
    hideMarkdownRange(decorations, from, labelFrom, isActive);
    hideMarkdownRange(decorations, labelTo, to, isActive);
  }
}

function overlapsProtectedRange(from: number, to: number, ranges: Array<{ from: number; to: number }>) {
  return ranges.some((range) => from < range.to && to > range.from);
}

function hideMarkdownRange(
  decorations: Array<Range<Decoration>>,
  from: number,
  to: number,
  isActive: boolean
) {
  if (!isActive && from < to) {
    decorations.push(Decoration.replace({}).range(from, to));
  }
}

class TaskCheckboxWidget extends WidgetType {
  constructor(
    private checked: boolean,
    private from: number
  ) {
    super();
  }

  eq(widget: WidgetType) {
    return widget instanceof TaskCheckboxWidget && widget.checked === this.checked && widget.from === this.from;
  }

  toDOM(view: EditorView) {
    const wrapper = document.createElement("span");
    wrapper.className = "cm-task-checkbox";

    const input = document.createElement("input");
    input.type = "checkbox";
    input.checked = this.checked;
    input.tabIndex = -1;
    input.ariaLabel = this.checked ? "Mark task incomplete" : "Mark task complete";

    input.addEventListener("mousedown", (event) => {
      event.preventDefault();
      event.stopPropagation();
    });

    input.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      view.dispatch({
        changes: {
          from: this.from,
          to: this.from + 3,
          insert: this.checked ? "[ ]" : "[x]"
        }
      });
    });

    wrapper.append(input);
    return wrapper;
  }
}

class BulletWidget extends WidgetType {
  eq(widget: WidgetType) {
    return widget instanceof BulletWidget;
  }

  toDOM() {
    const bullet = document.createElement("span");
    bullet.className = "cm-list-bullet";
    bullet.textContent = "•";
    return bullet;
  }
}

class MarkdownImageWidget extends WidgetType {
  constructor(
    private src: string,
    private alt: string
  ) {
    super();
  }

  eq(widget: WidgetType) {
    return widget instanceof MarkdownImageWidget && widget.src === this.src && widget.alt === this.alt;
  }

  toDOM() {
    const wrapper = document.createElement("span");
    wrapper.className = "cm-markdown-image";

    const image = document.createElement("img");
    image.src = this.src;
    image.alt = this.alt;
    image.loading = "lazy";

    wrapper.append(image);
    return wrapper;
  }
}

function updateTicketCount(workspace: WorkspaceInfo | null, projectId: string, delta: number) {
  if (!workspace) {
    return workspace;
  }

  return {
    ...workspace,
    projects: workspace.projects.map((project) =>
      project.id === projectId
        ? { ...project, ticketCount: Math.max(0, project.ticketCount + delta) }
        : project
    )
  };
}

function renderMarkdown(markdown: string, options: MarkdownRenderOptions = {}) {
  const lines = markdown.trim().split("\n");

  if (!markdown.trim()) {
    return "";
  }

  const html: string[] = [];
  let list: "ul" | "ol" | null = null;
  let paragraph: string[] = [];
  let inCode = false;
  let codeLines: string[] = [];

  const flushParagraph = () => {
    if (!paragraph.length) {
      return;
    }

    const renderedParagraph = renderInline(paragraph.join(" "), options).trim();

    if (renderedParagraph) {
      html.push(`<p>${renderedParagraph}</p>`);
    }

    paragraph = [];
  };

  const closeList = () => {
    if (list) {
      html.push(`</${list}>`);
      list = null;
    }
  };

  for (const line of lines) {
    const trimmed = line.trim();

    if (trimmed.startsWith("```")) {
      if (inCode) {
        html.push(`<pre><code>${escapeHtml(codeLines.join("\n"))}</code></pre>`);
        codeLines = [];
        inCode = false;
      } else {
        flushParagraph();
        closeList();
        inCode = true;
      }
      continue;
    }

    if (inCode) {
      codeLines.push(line);
      continue;
    }

    if (!trimmed) {
      flushParagraph();
      closeList();
      continue;
    }

    const heading = /^(#{1,3})\s+(.+)$/.exec(trimmed);

    if (heading && !options.compact) {
      flushParagraph();
      closeList();
      const level = heading[1].length + 2;
      html.push(`<h${level}>${renderInline(heading[2], options)}</h${level}>`);
      continue;
    }

    const quote = /^>\s+(.+)$/.exec(trimmed);

    if (quote && !options.compact) {
      flushParagraph();
      closeList();
      html.push(`<blockquote>${renderInline(quote[1], options)}</blockquote>`);
      continue;
    }

    const unordered = /^[-*]\s+(.+)$/.exec(trimmed);
    const ordered = /^\d+\.\s+(.+)$/.exec(trimmed);

    if (unordered || ordered) {
      flushParagraph();
      const nextList = unordered ? "ul" : "ol";

      if (list && list !== nextList) {
        closeList();
      }

      if (!list) {
        html.push(`<${nextList}>`);
        list = nextList;
      }

      const renderedItem = renderInline((unordered ?? ordered)?.[1] ?? "", options).trim();

      if (renderedItem) {
        html.push(`<li>${renderedItem}</li>`);
      }

      continue;
    }

    closeList();
    paragraph.push(trimmed.replace(/^#+\s+/, ""));
  }

  flushParagraph();
  closeList();

  if (inCode) {
    html.push(`<pre><code>${escapeHtml(codeLines.join("\n"))}</code></pre>`);
  }

  return options.compact ? html.slice(0, 2).join("") : html.join("");
}

function renderInline(value: string, options: MarkdownRenderOptions = {}) {
  const placeholders: string[] = [];
  let html = escapeHtml(value);

  html = html.replace(/`([^`]+)`/g, (_, code: string) => {
    const token = `@@TOKEN_${placeholders.length}@@`;
    placeholders.push(`<code>${code}</code>`);
    return token;
  });

  html = html
    .replace(/!\[([^\]\n]*)\]\(([^)\s]+)\)/g, (match, alt: string, src: string) => {
      if (options.skipImages) {
        return "";
      }

      const imageSrc = resolveMarkdownImageSrc(src, options.projectPath);

      if (!imageSrc) {
        return match;
      }

      return `<img src="${escapeAttr(imageSrc)}" alt="${alt}" loading="lazy" />`;
    })
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/\*([^*]+)\*/g, "<em>$1</em>")
    .replace(
      /(^|[^!])\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g,
      '$1<a href="$3" target="_blank" rel="noreferrer">$2</a>'
    )
    .replace(/\[ \]\s+/g, '<input type="checkbox" disabled /> ')
    .replace(/\[x\]\s+/gi, '<input type="checkbox" checked disabled /> ');

  placeholders.forEach((replacement, index) => {
    html = html.replace(`@@TOKEN_${index}@@`, replacement);
  });

  return html;
}

function icon(name: string) {
  return `<i data-lucide="${name}" aria-hidden="true"></i>`;
}

function hydrateIcons() {
  createIcons({
    icons: {
      ArrowDown,
      ArrowUp,
      Check,
      ChevronDown,
      CircleCheck,
      Copy,
      Folder,
      FolderOpen,
      FolderPlus,
      GripVertical,
      ListTodo,
      LoaderCircle,
      Pencil,
      Plus,
      RefreshCw,
      Save,
      Trash2,
      X
    }
  });
}

function escapeHtml(value: string) {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function escapeAttr(value: string) {
  return escapeHtml(value);
}

function shortPath(path: string) {
  const normalized = path.replaceAll("\\", "/");
  const parts = normalized.split("/").filter(Boolean);

  if (parts.length <= 3) {
    return normalized;
  }

  return `.../${parts.slice(-3).join("/")}`;
}

function resolveMarkdownImageSrc(src: string, projectPath?: string) {
  const trimmed = src.trim();

  if (/^https?:\/\//i.test(trimmed) || /^data:image\//i.test(trimmed)) {
    return trimmed;
  }

  const relativePath = normalizeTaskImagePath(trimmed);

  if (!relativePath || !projectPath) {
    return null;
  }

  if (!isTauriRuntime) {
    return relativePath;
  }

  return convertFileSrc(joinFilePath(projectPath, ".tasks", relativePath));
}

function normalizeTaskImagePath(path: string) {
  const normalized = path.replaceAll("\\", "/").replace(/^\.\//, "");
  const relativePath = normalized.startsWith(".tasks/images/")
    ? normalized.slice(".tasks/".length)
    : normalized;
  const parts = relativePath.split("/");

  if (parts.length < 2 || parts[0] !== "images") {
    return null;
  }

  if (parts.some((part) => !part || part === "." || part === "..")) {
    return null;
  }

  return relativePath;
}

function joinFilePath(base: string, ...segments: string[]) {
  const separator = base.includes("\\") && !base.includes("/") ? "\\" : "/";
  const normalizedSegments = segments.map((segment) =>
    segment
      .replaceAll("\\", separator)
      .replaceAll("/", separator)
      .replace(/^[\\/]+|[\\/]+$/g, "")
  );

  return [base.replace(/[\\/]+$/, ""), ...normalizedSegments].join(separator);
}

function imageExtensionForMime(mimeType: string) {
  switch (mimeType.split(";")[0].trim().toLowerCase()) {
    case "image/png":
      return "png";
    case "image/jpeg":
      return "jpg";
    case "image/gif":
      return "gif";
    case "image/webp":
      return "webp";
    case "image/bmp":
      return "bmp";
    default:
      return null;
  }
}

function bytesToDataUrl(mimeType: string, bytes: number[]) {
  const chunkSize = 0x8000;
  let binary = "";

  for (let index = 0; index < bytes.length; index += chunkSize) {
    binary += String.fromCharCode(...bytes.slice(index, index + chunkSize));
  }

  return `data:${mimeType};base64,${btoa(binary)}`;
}

async function copyText(value: string) {
  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(value);
      return;
    } catch {
      // Some browser shells expose navigator.clipboard but deny writes.
    }
  }

  const textarea = document.createElement("textarea");
  textarea.value = value;
  textarea.style.position = "fixed";
  textarea.style.opacity = "0";
  document.body.append(textarea);
  textarea.select();

  try {
    if (!document.execCommand("copy")) {
      throw new Error("Could not copy path.");
    }
  } finally {
    textarea.remove();
  }
}

function showDraftSaveError(error: unknown) {
  state.draftSaveError = `Autosave failed. Retrying... ${errorMessage(error)}`;
  render();
}

function clearDraftSaveError() {
  if (!state.draftSaveError) {
    return;
  }

  state.draftSaveError = null;
  document.querySelector<HTMLElement>(".editor-save-error")?.remove();
}

function showError(error: unknown, renderOptions: RenderOptions = {}) {
  state.error = errorMessage(error);
  state.isLoading = false;
  render(renderOptions);
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

const api = {
  async getWorkspaceInfo() {
    if (isTauriRuntime) {
      return invoke<WorkspaceInfo>("get_workspace_info");
    }

    return mockStore.getWorkspaceInfo();
  },
  async createProject(name: string) {
    if (isTauriRuntime) {
      return invoke<ProjectSummary>("create_project", { name });
    }

    return mockStore.createProject(name);
  },
  async importProject(path: string) {
    if (isTauriRuntime) {
      return invoke<ProjectSummary>("import_project", { path });
    }

    return mockStore.importProject(path);
  },
  async updateProjectName(projectId: string, name: string) {
    if (isTauriRuntime) {
      return invoke<ProjectSummary>("update_project_name", { projectId, name });
    }

    return mockStore.updateProjectName(projectId, name);
  },
  async removeProject(projectId: string) {
    if (isTauriRuntime) {
      return invoke<WorkspaceInfo>("remove_project", { projectId });
    }

    return mockStore.removeProject(projectId);
  },
  async reorderProjects(projectIds: string[]) {
    if (isTauriRuntime) {
      return invoke<WorkspaceInfo>("reorder_projects", { projectIds });
    }

    return mockStore.reorderProjects(projectIds);
  },
  async openProject(projectId: string) {
    if (isTauriRuntime) {
      return invoke<void>("open_project_folder", { projectId });
    }

    return mockStore.openProject(projectId);
  },
  async listTickets(projectId: string) {
    if (isTauriRuntime) {
      return invoke<Ticket[]>("list_tickets", { projectId });
    }

    return mockStore.listTickets(projectId);
  },
  async createTicket(projectId: string, status: Status, title: string) {
    if (isTauriRuntime) {
      return invoke<Ticket>("create_ticket", { projectId, status, title });
    }

    return mockStore.createTicket(projectId, status, title);
  },
  async updateTicket(projectId: string, ticketId: string, title: string, body: string, status: Status) {
    if (isTauriRuntime) {
      return invoke<Ticket>("update_ticket", { projectId, ticketId, title, body, status });
    }

    return mockStore.updateTicket(projectId, ticketId, title, body, status);
  },
  async saveTicketImage(projectId: string, ticketId: string, mimeType: string, bytes: number[]) {
    if (isTauriRuntime) {
      return invoke<SavedTicketImage>("save_ticket_image", { projectId, ticketId, mimeType, bytes });
    }

    return mockStore.saveTicketImage(projectId, ticketId, mimeType, bytes);
  },
  async deleteTicketImage(projectId: string, markdownPath: string) {
    if (isTauriRuntime) {
      return invoke<void>("delete_ticket_image", { projectId, markdownPath });
    }

    return mockStore.deleteTicketImage(projectId, markdownPath);
  },
  async reorderTickets(projectId: string, positions: Array<{ id: string; status: Status; order: number }>) {
    if (isTauriRuntime) {
      return invoke<Ticket[]>("reorder_tickets", { projectId, positions });
    }

    return mockStore.reorderTickets(projectId, positions);
  },
  async deleteTicket(projectId: string, ticketId: string) {
    if (isTauriRuntime) {
      return invoke<void>("delete_ticket", { projectId, ticketId });
    }

    return mockStore.deleteTicket(projectId, ticketId);
  }
};

const mockStore = (() => {
  const seed = (): MockStore => {
    const now = Date.now();
    const project: ProjectSummary = {
      id: "inbox",
      name: "Inbox",
      path: "~/todo.md/projects/inbox",
      ticketCount: 3
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
            status: "todo",
            order: 1000,
            createdAt: now,
            updatedAt: now,
            filePath: "~/todo.md/projects/inbox/capture-app-ideas.md"
          },
          {
            id: "sketch-board-columns",
            title: "Sketch board columns",
            body: "Columns are intentionally small for now:\n\n- To do\n- Doing\n- Done",
            status: "doing",
            order: 1000,
            createdAt: now,
            updatedAt: now,
            filePath: "~/todo.md/projects/inbox/sketch-board-columns.md"
          },
          {
            id: "keep-tickets-local",
            title: "Keep tickets local",
            body: "Every card is backed by a plain `.md` file on disk.",
            status: "done",
            order: 1000,
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

    return JSON.parse(raw) as MockStore;
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
        order: (store.tickets[projectId]?.filter((candidate) => candidate.status === status).length ?? 0) * 1000 + 1000,
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
    async updateTicket(projectId: string, ticketId: string, title: string, body: string, status: Status) {
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
    async reorderTickets(projectId: string, positions: Array<{ id: string; status: Status; order: number }>) {
      const store = read();
      const positionById = new Map(positions.map((position) => [position.id, position]));

      store.tickets[projectId] = (store.tickets[projectId] ?? []).map((ticket) => {
        const position = positionById.get(ticket.id);

        return position
          ? {
              ...ticket,
              status: position.status,
              order: position.order,
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
    }
  };
})();

void main();
