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
import { getCurrentWindow } from "@tauri-apps/api/window";
import { confirm, open } from "@tauri-apps/plugin-dialog";
import {
  Archive,
  ArrowDown,
  ArrowUp,
  Check,
  ChevronDown,
  CircleCheck,
  Copy,
  createIcons,
  Eye,
  Folder,
  FolderOpen,
  FolderPlus,
  GripVertical,
  ListTodo,
  LoaderCircle,
  Moon,
  Palette,
  Pencil,
  Plus,
  RefreshCw,
  Save,
  Search,
  Settings,
  Sun,
  Table2,
  Trash2,
  Type,
  X
} from "lucide";
import { createApi } from "./api/client";
import {
  createTicketSearchResultMap,
  filterTicketsBySearchResults,
  isTicketSearchActive,
  maxTicketSearchQueryLength,
  renderTicketSearchSegments,
  shouldDisableSearchReorder,
  shouldRerunTicketSearchAfterMutation
} from "./api/mockStore";
import { detectAppRuntime } from "./api/runtime";
import {
  createBackdropDismissState,
  recordBackdropPointerDown,
  resetBackdropDismissState,
  shouldDismissEditorOnBackdropPointerUp
} from "./editorBackdropClose";
import type {
  ProjectSummary,
  RenderOptions,
  SaveDraftOptions,
  ScrollSnapshot,
  Status,
  TaskPriority,
  TaskSize,
  Ticket,
  TicketDraft,
  TicketSearchField,
  TicketSearchMatch,
  TicketSearchResult,
  TicketSearchSegment,
  WorkspaceInfo
} from "./app/types";
import {
  automaticRefreshIntervalMs,
  canRunAutomaticRefresh,
  ticketsChanged,
  workspaceInfoChanged
} from "./app/autoRefresh";
import { escapeAttr, escapeHtml } from "./markdown/escape";
import { imageExtensionForMime, resolveMarkdownImageSrc } from "./markdown/images";
import { renderMarkdown } from "./markdown/render";
import {
  parseTicketTitle,
  renderTicketTitle,
  titleDisplayValue,
  untitledTicketTitle
} from "./markdown/title";
import { reorderProjectsForInsertion } from "./projects/ordering";
import { bindQuickAddTextarea } from "./quickAddTextarea";
import { findTaskSelectorFromTarget } from "./taskSelectorClose";
import {
  appFontCss,
  appFontOptions,
  appearanceStorageKey,
  colorSchemeOptions,
  defaultAppearanceSettings,
  maxFontSize,
  minFontSize,
  normalizeAppearanceSettings,
  parseAppearanceSettings,
  serializeAppearanceSettings,
  type AppearanceSettings,
  type AppFont,
  type ColorScheme
} from "./settings/appearance";
import { insertTicket, rankForInsertion, sortTickets } from "./tickets/ordering";
import { ticketPathRelativeToProject } from "./tickets/paths";
import { canQuickAddTicket } from "./tickets/quickAdd";
import {
  defaultTableSorts,
  sortTicketsForTable,
  type TableColumn,
  type TableSort
} from "./tickets/table";
import "./styles.css";
const columns: Array<{ id: Status; label: string; icon: string }> = [
  { id: "draft", label: "Draft", icon: "pencil" },
  { id: "ready", label: "Ready", icon: "list-todo" },
  { id: "doing", label: "Doing", icon: "loader-circle" },
  { id: "review", label: "Review", icon: "eye" },
  { id: "done", label: "Done", icon: "circle-check" }
];
const priorities: TaskPriority[] = ["P0", "P1", "P2", "P3", "P4"];
const taskSizes: TaskSize[] = ["XS", "S", "M", "L", "XL"];
const taskDateTimeFormatter = new Intl.DateTimeFormat(undefined, {
  dateStyle: "medium",
  timeStyle: "short"
});

const app = document.querySelector<HTMLDivElement>("#app");

if (!app) {
  throw new Error("App root not found.");
}

const appRoot = app;
const ticketDragType = "application/x-todo-md-ticket";
const projectDragType = "application/x-todo-md-project";
const maxPastedImageBytes = 25 * 1024 * 1024;
const projectViewModeStorageKey = "todo.md.project-view-modes";

type ActivePage = "project" | "settings";

type ProjectViewMode = "board" | "table";

type ProjectTableState = {
  sort: TableSort | null;
};

type SearchFocusSnapshot = {
  start: number | null;
  end: number | null;
} | null;

const state: {
  activePage: ActivePage;
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
  appearance: AppearanceSettings;
  projectViewModes: Record<string, ProjectViewMode>;
  projectTableStates: Record<string, ProjectTableState>;
  searchQuery: string;
  searchPending: boolean;
  searchResults: TicketSearchResult[];
  searchResultMap: Map<string, TicketSearchResult>;
  searchRequestSeq: number;
} = {
  activePage: "project",
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
  draftSaveError: null,
  appearance: readAppearanceSettings(),
  projectViewModes: readProjectViewModes(),
  projectTableStates: {},
  searchQuery: "",
  searchPending: false,
  searchResults: [],
  searchResultMap: new Map(),
  searchRequestSeq: 0
};

const runtime = detectAppRuntime();
const isTauriRuntime = runtime.isTauri;
const api = createApi({ isTauriRuntime });

applyAppearanceSettings(state.appearance);

document.addEventListener("pointerdown", (event) => {
  if (!findTaskSelectorFromTarget(event.target)) {
    closeTaskSelector();
  }
});

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
const ticketSearchDebounceMs = 150;
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
let automaticRefreshTimer: ReturnType<typeof window.setInterval> | null = null;
let ticketSearchDebounceTimer: ReturnType<typeof window.setTimeout> | null = null;
let isAutomaticRefreshRunning = false;
let pendingLocalMutationCount = 0;

async function main() {
  bindGlobalKeys();
  bindLayoutGuards();
  await bindWindowCloseGuards();
  await loadWorkspace();
  startAutomaticRefresh();
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
      clearTicketSearchResults();
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
  await rerunActiveTicketSearch({ preserveScroll: true });
}

function startAutomaticRefresh() {
  if (automaticRefreshTimer) {
    return;
  }

  automaticRefreshTimer = window.setInterval(() => {
    void refreshWorkspaceInBackground();
  }, automaticRefreshIntervalMs);
}

async function refreshWorkspaceInBackground() {
  if (isAutomaticRefreshRunning || !canRunAutomaticRefresh(currentAutomaticRefreshState())) {
    return;
  }

  const selectedProjectId = state.selectedProjectId;
  isAutomaticRefreshRunning = true;

  try {
    const workspace = await api.getWorkspaceInfo();
    const nextSelectedProjectId =
      selectedProjectId && workspace.projects.some((project) => project.id === selectedProjectId)
        ? selectedProjectId
        : workspace.projects[0]?.id ?? null;
    const nextTickets = nextSelectedProjectId ? await api.listTickets(nextSelectedProjectId) : [];
    nextTickets.sort(sortTickets);

    if (
      state.selectedProjectId !== selectedProjectId ||
      !canRunAutomaticRefresh(currentAutomaticRefreshState())
    ) {
      return;
    }

    const nextSelectedTicketId =
      state.selectedTicketId && nextTickets.some((ticket) => ticket.id === state.selectedTicketId)
        ? state.selectedTicketId
        : null;
    const shouldRender =
      workspaceInfoChanged(state.workspace, workspace) ||
      state.selectedProjectId !== nextSelectedProjectId ||
      state.selectedTicketId !== nextSelectedTicketId ||
      ticketsChanged(state.tickets, nextTickets) ||
      state.error !== null;

    if (!shouldRender) {
      return;
    }

    state.workspace = workspace;
    state.selectedProjectId = nextSelectedProjectId;
    state.selectedTicketId = nextSelectedTicketId;
    state.tickets = nextTickets;
    state.error = null;

    if (await rerunActiveTicketSearch({ preserveScroll: true })) {
      return;
    }

    render({ preserveScroll: true });
  } catch (error) {
    console.warn("Automatic refresh failed.", error);
  } finally {
    isAutomaticRefreshRunning = false;
  }
}

function currentAutomaticRefreshState() {
  return {
    isLoading: state.isLoading,
    hasDraft: state.draft !== null,
    hasTicketDrag: state.draggingId !== null,
    hasProjectDrag: state.draggingProjectId !== null,
    hasProjectMenu: state.projectMenu !== null,
    hasTicketMenu: state.ticketMenu !== null,
    hasProjectRename: state.renamingProjectId !== null,
    hasOpenTaskSelector: document.querySelector("[data-task-selector].is-open") !== null,
    hasLocalMutation: pendingLocalMutationCount > 0,
    hasPendingImageUploads: pendingImageUploads.size > 0,
    hasActiveDraftSave: draftSavePromise !== null
  };
}

async function trackLocalMutation<T>(mutation: Promise<T>) {
  pendingLocalMutationCount += 1;

  try {
    return await mutation;
  } finally {
    pendingLocalMutationCount = Math.max(0, pendingLocalMutationCount - 1);
  }
}

function render(options: RenderOptions = {}) {
  const scrollSnapshot = options.preserveScroll ? captureScrollSnapshot() : null;
  const searchFocusSnapshot = captureSearchFocusSnapshot();

  destroyMarkdownEditor();

  const workspace = state.workspace;
  const currentProject = workspace?.projects.find(
    (project) => project.id === state.selectedProjectId
  );
  const isSettingsPage = state.activePage === "settings";

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

        <button
          class="sidebar-action settings-nav ${isSettingsPage ? "active" : ""}"
          data-action="open-settings"
          title="Settings"
          aria-pressed="${isSettingsPage}"
        >
          ${icon("settings")}
          <span>Settings</span>
        </button>
      </aside>

      <section class="workspace ${isSettingsPage ? "workspace-settings" : ""}">
        <header class="topbar">
          <div>
            <p class="eyebrow">${isSettingsPage ? "Preferences" : "Project"}</p>
            <h2>${escapeHtml(isSettingsPage ? "Settings" : (currentProject?.name ?? "No project"))}</h2>
            <p class="project-path">${escapeHtml(
              isSettingsPage ? "Appearance and typography" : (currentProject?.path ?? "Create a project to begin")
            )}</p>
          </div>
          <div class="topbar-actions">
            ${
              isSettingsPage
                ? ""
                : `
                  ${renderTicketSearchControl()}
                  ${renderViewSwitcher()}
                  <button class="ghost-button" data-action="refresh" title="Refresh board">
                    ${icon("refresh-cw")}
                    <span>Refresh</span>
                  </button>
                `
            }
          </div>
        </header>

        ${isSettingsPage ? renderSettingsPage() : renderProjectWorkspace()}
      </section>
    </div>

    ${renderProjectMenu()}
    ${renderTicketMenu()}
    ${renderProjectRenameDialog()}
    ${renderEditor()}
  `;

  hydrateIcons();
  bindEvents();
  applyCardPreviewPrecedence();
  restoreSearchFocusSnapshot(searchFocusSnapshot);
  restoreScrollSnapshot(scrollSnapshot);

  if (options.revealTicket) {
    revealTicketInList(options.revealTicket.id, options.revealTicket.block ?? "nearest");
  }
}

function renderProjectWorkspace() {
  return `
    ${state.error ? `<div class="notice">${escapeHtml(state.error)}</div>` : ""}
    ${state.isLoading ? renderLoadingBoard() : renderBoard()}
  `;
}

function renderProjects(projects: ProjectSummary[]) {
  if (!projects.length) {
    return `<p class="empty-state">No projects yet</p>`;
  }

  return projects
    .map((project) => {
      const isActive = state.activePage === "project" && project.id === state.selectedProjectId;

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

function renderViewSwitcher() {
  const viewMode = currentProjectViewMode();

  return `
    <div class="view-switcher" role="group" aria-label="Project view">
      <button
        type="button"
        class="view-switcher-button ${viewMode === "board" ? "active" : ""}"
        data-action="set-project-view"
        data-view-mode="board"
        aria-pressed="${viewMode === "board"}"
        title="Board view"
      >
        ${icon("list-todo")}
        <span>Board</span>
      </button>
      <button
        type="button"
        class="view-switcher-button ${viewMode === "table" ? "active" : ""}"
        data-action="set-project-view"
        data-view-mode="table"
        aria-pressed="${viewMode === "table"}"
        title="Table view"
      >
        ${icon("table-2")}
        <span>Table</span>
      </button>
    </div>
  `;
}

function renderTicketSearchControl() {
  const isActive = hasActiveTicketSearch();
  const countText = ticketSearchCountText();

  return `
    <div class="ticket-search ${isActive ? "is-active" : ""} ${state.searchPending ? "is-pending" : ""} ${state.searchQuery ? "has-query" : ""}" role="search">
      <span class="ticket-search-icon">${icon("search")}</span>
      <input
        data-search-input
        type="search"
        value="${escapeAttr(state.searchQuery)}"
        placeholder="Search tickets"
        aria-label="Search tickets"
        autocomplete="off"
        maxlength="${maxTicketSearchQueryLength}"
        ${state.selectedProjectId ? "" : "disabled"}
      />
      <span class="ticket-search-count" data-search-count aria-live="polite">${escapeHtml(countText)}</span>
      <button
        type="button"
        class="ticket-search-clear"
        data-action="clear-search"
        aria-label="Clear search"
        title="Clear search"
        ${state.searchQuery ? "" : "hidden"}
      >
        ${icon("x")}
      </button>
    </div>
  `;
}

function renderSettingsPage() {
  const settings = state.appearance;
  const selectedFont = appFontOptions.find((option) => option.value === settings.fontFamily) ?? appFontOptions[0];

  return `
    <main class="settings-page" aria-label="Settings">
      <section class="settings-panel" aria-labelledby="settings-appearance-title">
        <header class="settings-section-header">
          <span class="settings-section-icon">${icon("palette")}</span>
          <div>
            <h3 id="settings-appearance-title">Color scheme</h3>
          </div>
        </header>

        <div class="settings-segmented" role="group" aria-label="Color scheme">
          ${colorSchemeOptions
            .map((option) => {
              const isSelected = option.value === settings.colorScheme;

              return `
                <button
                  type="button"
                  class="settings-segment ${isSelected ? "active" : ""}"
                  data-action="set-color-scheme"
                  data-color-scheme="${escapeAttr(option.value)}"
                  aria-pressed="${isSelected}"
                >
                  ${icon(option.icon)}
                  <span>${escapeHtml(option.label)}</span>
                </button>
              `;
            })
            .join("")}
        </div>
      </section>

      <section class="settings-panel" aria-labelledby="settings-typography-title">
        <header class="settings-section-header">
          <span class="settings-section-icon">${icon("type")}</span>
          <div>
            <h3 id="settings-typography-title">Typography</h3>
          </div>
        </header>

        <div class="settings-fields">
          <label class="settings-field">
            <span>Font</span>
            <select name="fontFamily" data-action="set-font-family">
              ${appFontOptions
                .map(
                  (option) => `
                    <option value="${escapeAttr(option.value)}" ${option.value === settings.fontFamily ? "selected" : ""}>
                      ${escapeHtml(option.label)}
                    </option>
                  `
                )
                .join("")}
            </select>
          </label>

          <label class="settings-field settings-font-size-field">
            <span>Font size</span>
            <div class="settings-font-size-control">
              <input
                type="range"
                name="fontSizeRange"
                data-action="set-font-size"
                min="${minFontSize}"
                max="${maxFontSize}"
                step="1"
                value="${settings.fontSize}"
                aria-label="Font size"
              />
              <input
                type="number"
                name="fontSize"
                data-action="set-font-size"
                min="${minFontSize}"
                max="${maxFontSize}"
                step="1"
                value="${settings.fontSize}"
                aria-label="Font size in pixels"
              />
            </div>
          </label>
        </div>
      </section>

      <section class="settings-panel settings-preview-panel" aria-labelledby="settings-preview-title">
        <header class="settings-section-header">
          <span class="settings-section-icon">${icon("eye")}</span>
          <div>
            <h3 id="settings-preview-title">Preview</h3>
          </div>
        </header>

        <div class="settings-preview">
          <article class="ticket-card settings-preview-card" aria-label="Preview ticket">
            <div class="ticket-topline">
              <h4><span class="ticket-title"><span class="ticket-title-chip ticket-title-chip-0">Design</span><span class="ticket-title-text">Tune the task board</span></span></h4>
              <span class="drag-handle">${icon("grip-vertical")}</span>
            </div>
            <div class="ticket-task-metadata">
              <span class="task-chip task-chip-priority task-priority-p2">P2</span>
              <span class="task-chip task-chip-size task-size-xl">XL</span>
            </div>
            <div class="markdown card-markdown">
              <p>Review active tickets, tune contrast, and ship a calm theme.</p>
            </div>
          </article>

          <div class="settings-preview-stack" aria-hidden="true">
            <button class="ghost-button" type="button" tabindex="-1">
              ${icon("refresh-cw")}
              <span>Refresh</span>
            </button>
            <div class="status-selector settings-preview-selector">
              <button class="status-selector-button" type="button" tabindex="-1">
                <span class="status-current">
                  <span class="status-current-icon status-icon-doing">${icon("loader-circle")}</span>
                  <span>Doing</span>
                </span>
                <span class="status-chevron">${icon("chevron-down")}</span>
              </button>
            </div>
            <p class="settings-preview-type" style="font-family: ${escapeAttr(selectedFont.css)};">
              ${escapeHtml(selectedFont.label)} / ${settings.fontSize}px
            </p>
          </div>
        </div>

        <footer class="settings-actions">
          <button class="ghost-button" type="button" data-action="reset-appearance">
            ${icon("refresh-cw")}
            <span>Reset</span>
          </button>
        </footer>
      </section>
    </main>
  `;
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
      <button data-ticket-action="copy-ticket-absolute-path" data-ticket-id="${escapeAttr(ticket.id)}" role="menuitem">
        ${icon("copy")}
        <span>Copy absolute path</span>
      </button>
      <button data-ticket-action="copy-ticket-relative-path" data-ticket-id="${escapeAttr(ticket.id)}" role="menuitem">
        ${icon("copy")}
        <span>Copy relative path</span>
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

  if (currentProjectViewMode() === "table") {
    return renderTableView();
  }

  return renderKanbanBoard();
}

function renderKanbanBoard() {
  const hasNoMatches = hasNoTicketSearchMatches();

  return `
    <div class="board-shell ${hasNoMatches ? "has-search-empty" : ""}">
      ${hasNoMatches ? renderNoSearchMatches() : ""}
      <div class="board" aria-label="Task board">
        ${columns.map(renderColumn).join("")}
      </div>
    </div>
  `;
}

function renderLoadingBoard() {
  if (state.selectedProjectId && currentProjectViewMode() === "table") {
    return `
      <div class="table-view">
        <div class="task-table-scroll">
          <table class="task-table" aria-label="Loading task table">
            <thead>
              <tr>
                ${tableColumnConfigs().map((column) => `<th scope="col">${escapeHtml(column.label)}</th>`).join("")}
              </tr>
            </thead>
            <tbody>
              ${Array.from({ length: 5 })
                .map(
                  () => `
                    <tr>
                      ${tableColumnConfigs().map(() => `<td><div class="skeleton table-cell-skeleton"></div></td>`).join("")}
                    </tr>
                  `
                )
                .join("")}
            </tbody>
          </table>
        </div>
      </div>
    `;
  }

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
  const quickAdd = canQuickAddTicket(column.id)
    ? `
      <form class="quick-add" data-action="create-ticket" data-status="${column.id}">
        <textarea name="title" placeholder="Add ticket" rows="1" spellcheck="true"></textarea>
        <button class="icon-button" aria-label="Add ticket" title="Add ticket">
          ${icon("plus")}
        </button>
      </form>
    `
    : "";
  const action =
    column.id === "done"
      ? `
        <div class="column-actions">
          <span class="count">${tickets.length}</span>
          <button
            class="icon-button column-action"
            data-action="archive-done"
            type="button"
            aria-label="Archive done tasks"
            title="Archive done tasks"
            ${tickets.length === 0 ? "disabled" : ""}
          >
            ${icon("archive")}
          </button>
        </div>
      `
      : `<span class="count">${tickets.length}</span>`;

  return `
    <section class="column" data-status="${column.id}">
      <div class="column-header">
        <span class="column-icon">${icon(column.icon)}</span>
        <h3>${column.label}</h3>
        ${action}
      </div>

      <div class="ticket-list" data-status="${column.id}">
        ${tickets.map(renderTicketCard).join("")}
      </div>

      ${quickAdd}
    </section>
  `;
}

function renderTableView() {
  const tickets = tableTickets();
  const tableState = currentProjectTableState();

  return `
    <div class="table-view" aria-label="Task table">
      <div class="task-table-scroll">
        <table class="task-table">
          <thead>
            <tr>
              ${tableColumnConfigs().map((column) => renderTableHeaderCell(column, tableState.sort)).join("")}
            </tr>
          </thead>
          <tbody>
            ${tickets.length ? tickets.map((ticket) => renderTableRow(ticket)).join("") : renderEmptyTableRow()}
          </tbody>
        </table>
      </div>
    </div>
  `;
}

function tableColumnConfigs(): Array<{ id: TableColumn; label: string }> {
  return [
    { id: "title", label: "Title" },
    { id: "status", label: "Status" },
    { id: "priority", label: "Priority" },
    { id: "size", label: "Size" },
    { id: "assignee", label: "Assignee" },
    { id: "pr", label: "PR" }
  ];
}

function renderTableHeaderCell(column: { id: TableColumn; label: string }, sort: TableSort | null) {
  const defaultSortIndex = sort ? -1 : defaultTableSortIndex(column.id);
  const isActive = sort?.column === column.id || defaultSortIndex >= 0;
  const direction = sort?.column === column.id ? sort.direction : "asc";
  const isPrimarySort = sort ? sort.column === column.id : defaultSortIndex === 0;
  const ariaSort = isPrimarySort ? (direction === "asc" ? "ascending" : "descending") : "none";

  return `
    <th scope="col" class="task-table-heading task-table-heading-${column.id}" aria-sort="${ariaSort}">
      <button
        type="button"
        class="table-heading-button ${isActive ? "active" : ""}"
        data-action="sort-table"
        data-table-column="${column.id}"
        title="Sort by ${escapeAttr(column.label)}"
      >
        <span>${escapeHtml(column.label)}</span>
        ${renderTableSortIndicator(isActive, direction, defaultSortIndex)}
      </button>
    </th>
  `;
}

function renderTableSortIndicator(isActive: boolean, direction: "asc" | "desc", defaultSortIndex: number) {
  if (!isActive) {
    return `<span class="table-sort-indicator"></span>`;
  }

  return `
    <span class="table-sort-indicator active" aria-hidden="true">
      ${icon(direction === "asc" ? "arrow-up" : "arrow-down")}
      ${defaultSortIndex >= 0 ? `<span>${defaultSortIndex + 1}</span>` : ""}
    </span>
  `;
}

function renderTableRow(ticket: Ticket) {
  const displayTitle = titleDisplayValue(ticket.title);

  return `
    <tr
      class="task-table-row"
      data-ticket-id="${escapeAttr(ticket.id)}"
      tabindex="0"
      aria-label="${escapeAttr(ticketCardAriaLabel(ticket))}"
      aria-keyshortcuts="Enter"
    >
      <td class="task-table-cell task-table-title-cell">
        <div class="table-title-stack">
          <button
            type="button"
            class="table-title-button"
            data-action="open-table-ticket"
            title="${escapeAttr(displayTitle)}"
          >
            ${renderSearchAwareTicketTitle(ticket)}
          </button>
          ${renderTicketSearchSnippet(ticket, "table")}
        </div>
      </td>
      <td class="task-table-cell task-table-status-cell">
        ${renderTaskSelector("status", ticket.status, {
          owner: "table",
          ticketId: ticket.id,
          className: "table-selector"
        })}
      </td>
      <td class="task-table-cell task-table-priority-cell">
        ${renderTaskSelector("priority", ticket.priority, {
          owner: "table",
          ticketId: ticket.id,
          className: "table-selector table-selector-compact"
        })}
      </td>
      <td class="task-table-cell task-table-size-cell">
        ${renderTaskSelector("size", ticket.size, {
          owner: "table",
          ticketId: ticket.id,
          className: "table-selector table-selector-compact"
        })}
      </td>
      <td class="task-table-cell task-table-assignee-cell">
        ${renderTableLinkCell(ticket.assignee, "assignee")}
      </td>
      <td class="task-table-cell task-table-pr-cell">
        ${renderTableLinkCell(ticket.prLink, "pr")}
      </td>
    </tr>
  `;
}

function renderTableLinkCell(value: string | undefined, kind: "assignee" | "pr") {
  const metadata = metadataValue(value);

  if (!metadata) {
    return `<span class="table-muted">Empty</span>`;
  }

  const href = kind === "pr"
    ? safeMetadataHref(metadata, ["https:", "http:"])
    : safeMetadataHref(metadata, ["codex:", "https:", "http:"]);
  const label = kind === "pr" ? formatPullRequestLabel(metadata) : formatAssigneeLabel(metadata);

  if (!href) {
    return `<span class="table-link-label">${renderTableLinkLabel(kind, label)}</span>`;
  }

  return `
    <a class="table-link-label is-link" href="${escapeAttr(href)}" rel="noreferrer" data-table-link>
      ${renderTableLinkLabel(kind, label)}
    </a>
  `;
}

function renderTableLinkLabel(kind: "assignee" | "pr", label: string) {
  if (kind !== "assignee") {
    return escapeHtml(label);
  }

  return `
    <span class="table-link-prefix">Codex</span>
    <span class="table-link-text">${escapeHtml(label)}</span>
  `;
}

function renderEmptyTableRow() {
  const label = hasNoTicketSearchMatches() ? "No matches" : "No tasks";

  return `
    <tr class="task-table-empty-row">
      <td colspan="${tableColumnConfigs().length}">
        <div class="empty-board">
          <h3>${label}</h3>
        </div>
      </td>
    </tr>
  `;
}

function renderNoSearchMatches() {
  return `
    <div class="empty-board search-empty-state">
      <h3>No matches</h3>
    </div>
  `;
}

function renderTicketCard(ticket: Ticket) {
  const renderedBody = renderMarkdown(ticket.body, {
    compact: true,
    skipImages: true,
    projectPath: getCurrentProject()?.path,
    fileSrcConverter: runtime.fileSrcConverter
  });

  return `
    <article
      class="ticket-card ${isTicketReorderDisabled() ? "is-reorder-disabled" : ""}"
      draggable="${isTicketReorderDisabled() ? "false" : "true"}"
      data-ticket-id="${escapeAttr(ticket.id)}"
      tabindex="0"
      aria-label="${escapeAttr(ticketCardAriaLabel(ticket))}"
      aria-keyshortcuts="${isTicketReorderDisabled() ? "Enter" : "Enter ArrowUp ArrowDown"}"
    >
      <div class="ticket-topline">
        <h4>${renderSearchAwareTicketTitle(ticket)}</h4>
        <span class="drag-handle" title="${isTicketReorderDisabled() ? "Reordering disabled while search is active" : "Drag to reorder"}">${icon("grip-vertical")}</span>
      </div>
      ${renderTicketSearchSnippet(ticket, "card")}
      ${renderTicketTaskMetadata(ticket)}
      ${renderTicketMetadata(ticket)}
      ${renderedBody ? `<div class="markdown card-markdown">${renderedBody}</div>` : ""}
    </article>
  `;
}

function ticketCardAriaLabel(ticket: Ticket) {
  const parts = [ticket.title];

  if (ticket.priority) {
    parts.push(`Priority ${ticket.priority}`);
  }

  if (ticket.size) {
    parts.push(`Size ${ticket.size}`);
  }

  return parts.join(". ");
}

function applyCardPreviewPrecedence() {
  document.querySelectorAll<HTMLElement>(".ticket-card").forEach((card) => {
    const metadata = card.querySelector<HTMLElement>(".ticket-task-metadata");
    const preview = card.querySelector<HTMLElement>(".card-markdown");

    if (!metadata || !preview) {
      return;
    }

    preview.hidden = taskMetadataWraps(metadata);
  });
}

function taskMetadataWraps(metadata: HTMLElement) {
  const firstChip = metadata.querySelector<HTMLElement>(".task-chip");

  if (!firstChip) {
    return false;
  }

  const metadataHeight = metadata.getBoundingClientRect().height;
  const chipHeight = firstChip.getBoundingClientRect().height;
  const rowGap = parseFloat(window.getComputedStyle(metadata).rowGap || "0") || 0;

  return metadataHeight > chipHeight + rowGap + 2;
}

function renderTicketTaskMetadata(ticket: Ticket) {
  const chips = [
    ticket.priority
      ? `<span class="task-chip task-chip-priority task-priority-${ticket.priority.toLowerCase()}" title="Priority ${ticket.priority}">${escapeHtml(ticket.priority)}</span>`
      : "",
    ticket.size
      ? `<span class="task-chip task-chip-size task-size-${ticket.size.toLowerCase()}" title="Size ${ticket.size}">${escapeHtml(ticket.size)}</span>`
      : ""
  ].filter(Boolean);

  if (!chips.length) {
    return "";
  }

  return `<div class="ticket-task-metadata" aria-label="Task priority and size">${chips.join("")}</div>`;
}

type TicketMetadataItem = {
  label: string;
  text: string;
  title: string;
  href?: string;
};

function renderTicketMetadata(ticket: Ticket) {
  const items = ticketMetadataItems(ticket);

  if (!items.length) {
    return "";
  }

  return `
    <div class="ticket-metadata" aria-label="Task metadata">
      ${items.map(renderTicketMetadataItem).join("")}
    </div>
  `;
}

function renderTicketMetadataItem(item: TicketMetadataItem) {
  const contents = `
    <span class="ticket-metadata-label">${escapeHtml(item.label)}</span>
    <span class="ticket-metadata-text">${escapeHtml(item.text)}</span>
  `;

  if (item.href) {
    return `
      <a
        class="ticket-metadata-item is-link"
        href="${escapeAttr(item.href)}"
        rel="noreferrer"
        title="${escapeAttr(item.title)}"
      >${contents}</a>
    `;
  }

  return `<span class="ticket-metadata-item" title="${escapeAttr(item.title)}">${contents}</span>`;
}

function ticketMetadataItems(ticket: Ticket): TicketMetadataItem[] {
  const items: TicketMetadataItem[] = [];
  const prLink = metadataValue(ticket.prLink);
  const assignee = metadataValue(ticket.assignee);

  if (prLink) {
    items.push({
      label: "PR",
      text: formatPullRequestLabel(prLink),
      title: `Pull request: ${prLink}`,
      href: safeMetadataHref(prLink, ["https:", "http:"])
    });
  }

  if (assignee) {
    items.push({
      label: "Codex",
      text: formatAssigneeLabel(assignee),
      title: `Assignee: ${assignee}`,
      href: safeMetadataHref(assignee, ["codex:", "https:", "http:"])
    });
  }

  return items;
}

function metadataValue(value: string | undefined) {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

function safeMetadataHref(value: string, allowedProtocols: string[]) {
  try {
    const url = new URL(value);
    return allowedProtocols.includes(url.protocol) ? value : undefined;
  } catch {
    return undefined;
  }
}

function formatPullRequestLabel(value: string) {
  const pullRequest = value.match(/\/pull\/(\d+)(?:[/?#]|$)/i);

  if (pullRequest) {
    return `#${pullRequest[1]}`;
  }

  return shortLinkLabel(value);
}

function formatAssigneeLabel(value: string) {
  const codexThread = value.match(/^codex:\/\/threads\/([^/?#]+)/i);

  if (codexThread) {
    return codexThread[1].slice(0, 8);
  }

  return shortLinkLabel(value);
}

function shortLinkLabel(value: string) {
  try {
    const url = new URL(value);
    const path = url.pathname.replace(/^\/+|\/+$/g, "");
    return path ? `${url.hostname}/${path}` : url.hostname;
  } catch {
    return value;
  }
}

function renderEditor() {
  if (!state.draft) {
    return "";
  }

  const ticket = getSelectedTicket();

  if (!ticket) {
    return "";
  }

  const displayTitle = titleDisplayValue(state.draft.title);

  return `
    <div class="modal-backdrop" data-action="close-editor">
      <section class="editor-panel" role="dialog" aria-modal="true" aria-label="Ticket editor" tabindex="-1">
        <header class="editor-header">
          <div>
            <p class="eyebrow">Ticket</p>
            <button
              id="editor-title"
              type="button"
              class="title-display"
              data-action="edit-title"
              aria-label="Edit title: ${escapeAttr(displayTitle)}"
            >${renderTicketTitle(displayTitle)}</button>
            <input
              class="title-input"
              name="title"
              value="${escapeAttr(state.draft.title)}"
              aria-label="Title"
              hidden
            />
            ${renderTicketTimestamps(ticket)}
            ${renderTicketMetadata(ticket)}
            <div class="editor-metadata-controls" aria-label="Task metadata">
              <div class="editor-metadata-field editor-selector-field editor-priority-field">
                <span>Priority</span>
                ${renderTaskSelector("priority", state.draft.priority)}
              </div>
              <div class="editor-metadata-field editor-selector-field editor-size-field">
                <span>Size</span>
                ${renderTaskSelector("size", state.draft.size)}
              </div>
            </div>
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

function renderTicketTimestamps(ticket: Ticket) {
  return `
    <div class="ticket-timestamps" aria-label="Task timestamps">
      <span>Created ${escapeHtml(formatTicketTimestamp(ticket.createdAt))}</span>
      <span>Updated ${escapeHtml(formatTicketTimestamp(ticket.updatedAt))}</span>
    </div>
  `;
}

function renderStatusSelector(status: Status) {
  return renderTaskSelector("status", status);
}

type TaskSelectorKind = "status" | "priority" | "size";

type TaskSelectorOption = {
  value: string;
  label: string;
  icon?: string;
};

type RenderTaskSelectorOptions = {
  owner?: "editor" | "table";
  ticketId?: string;
  className?: string;
};

function renderTaskSelector(kind: TaskSelectorKind, value: string | undefined, options: RenderTaskSelectorOptions = {}) {
  const config = taskSelectorConfig(kind);
  const selected = selectedTaskSelectorOption(kind, value);
  const isCompactCurrentValue = isCompactTaskSelectorCurrentValue(kind);
  const currentLabel = taskSelectorCurrentLabel(kind, selected, config.placeholder);
  const owner = options.owner ?? "editor";
  const ticketAttribute = options.ticketId ? ` data-ticket-id="${escapeAttr(options.ticketId)}"` : "";
  const extraClass = options.className ? ` ${escapeAttr(options.className)}` : "";

  return `
    <div
      class="status-selector task-selector task-selector-${kind}${extraClass}"
      data-task-selector
      data-selector-kind="${kind}"
      data-selector-owner="${owner}"
      ${ticketAttribute}
    >
      <button
        type="button"
        class="status-selector-button"
        data-action="toggle-task-selector"
        aria-haspopup="menu"
        aria-expanded="false"
        aria-label="${escapeAttr(`${config.label}: ${selected.label}. Change ${config.label.toLowerCase()}`)}"
      >
        <span class="status-current ${isCompactCurrentValue ? "is-chip-only" : ""}">
          <span class="${escapeAttr(taskSelectorMarkClass(kind, selected.value))}" data-task-current-mark>${renderTaskSelectorMark(kind, selected)}</span>
          <span data-task-current-label ${isCompactCurrentValue ? "hidden" : ""}>${escapeHtml(currentLabel)}</span>
        </span>
        <span class="status-chevron">${icon("chevron-down")}</span>
      </button>
      <div class="status-menu" role="menu" aria-label="${escapeAttr(`Change ${config.label.toLowerCase()}`)}">
        ${config.options
          .map((option) => {
            const isSelected = option.value === selected.value;
            const isChipOnlyOption = isCompactTaskSelectorCurrentValue(kind);

            return `
              <button
                type="button"
                class="status-option ${isSelected ? "selected" : ""}"
                data-action="choose-task-selector"
                data-selector-value="${escapeAttr(option.value)}"
                role="menuitemradio"
                aria-checked="${isSelected ? "true" : "false"}"
              >
                <span class="${escapeAttr(taskSelectorMarkClass(kind, option.value))}">${renderTaskSelectorMark(kind, option)}</span>
                <span ${isChipOnlyOption ? "hidden" : ""}>${escapeHtml(option.label)}</span>
                <span class="status-option-check">${isSelected ? icon("check") : ""}</span>
              </button>
            `;
          })
          .join("")}
      </div>
    </div>
  `;
}

function taskSelectorConfig(kind: TaskSelectorKind): {
  label: string;
  placeholder: string;
  options: TaskSelectorOption[];
} {
  if (kind === "status") {
    return {
      label: "Status",
      placeholder: "Status",
      options: columns.map((column) => ({
        value: column.id,
        label: column.label,
        icon: column.icon
      }))
    };
  }

  if (kind === "priority") {
    return {
      label: "Priority",
      placeholder: "Priority",
      options: [{ value: "", label: "None" }, ...priorities.map((priority) => ({ value: priority, label: priority }))]
    };
  }

  return {
    label: "Size",
    placeholder: "Size",
    options: [{ value: "", label: "None" }, ...taskSizes.map((size) => ({ value: size, label: size }))]
  };
}

function selectedTaskSelectorOption(kind: TaskSelectorKind, value: string | undefined) {
  const config = taskSelectorConfig(kind);
  const selected = config.options.find((option) => option.value === (value ?? ""));

  return selected ?? config.options[0];
}

function isCompactTaskSelectorCurrentValue(kind: TaskSelectorKind) {
  return kind !== "status";
}

function taskSelectorCurrentLabel(kind: TaskSelectorKind, option: TaskSelectorOption, placeholder: string) {
  if (isCompactTaskSelectorCurrentValue(kind)) {
    return "";
  }

  return option.value ? option.label : option.label || placeholder;
}

function renderTaskSelectorMark(kind: TaskSelectorKind, option: TaskSelectorOption) {
  if (option.icon) {
    return icon(option.icon);
  }

  if (kind === "priority") {
    return escapeHtml(option.value || "None");
  }

  if (kind === "size") {
    return escapeHtml(option.value || "None");
  }

  return "";
}

function taskSelectorMarkClass(kind: TaskSelectorKind, value: string) {
  const classes = ["status-current-icon", "status-option-icon", `task-selector-mark-${kind}`];

  if (kind === "status" && value) {
    classes.push(`status-icon-${value}`);
  }

  if (kind === "priority" && value) {
    classes.push(`task-priority-${value.toLowerCase()}`);
  }

  if (kind === "size" && value) {
    classes.push(`task-size-${value.toLowerCase()}`);
  }

  if (kind !== "status" && !value) {
    classes.push("task-selector-mark-none");
  }

  return classes.join(" ");
}

function bindEvents() {
  bindSettingsEvents();
  bindProjectEvents();
  bindViewEvents();
  bindTicketSearchEvents();
  bindTicketEvents();
  bindMetadataEvents();
  bindEditorEvents();
}

function bindSettingsEvents() {
  document.querySelector<HTMLButtonElement>('[data-action="open-settings"]')?.addEventListener("click", async () => {
    if (state.activePage === "settings") {
      return;
    }

    if (!(await confirmDiscardDraft())) {
      return;
    }

    closeContextMenus({ shouldRender: false });
    state.activePage = "settings";
    state.selectedTicketId = null;
    state.draft = null;
    render();
  });

  document.querySelectorAll<HTMLButtonElement>('[data-action="set-color-scheme"]').forEach((button) => {
    button.addEventListener("click", () => {
      const colorScheme = button.dataset.colorScheme;

      if (isColorSchemeSetting(colorScheme)) {
        updateAppearanceSettings({ colorScheme });
      }
    });
  });

  document.querySelector<HTMLSelectElement>('select[data-action="set-font-family"]')?.addEventListener("change", (event) => {
    const fontFamily = (event.currentTarget as HTMLSelectElement).value;

    if (isAppFontSetting(fontFamily)) {
      updateAppearanceSettings({ fontFamily });
    }
  });

  document.querySelectorAll<HTMLInputElement>('input[data-action="set-font-size"]').forEach((input) => {
    input.addEventListener("input", () => {
      if (!input.value.trim()) {
        return;
      }

      const fontSize = Number(input.value);

      if (input.type === "range" || isFontSizeInRange(fontSize)) {
        updateAppearanceSettings({ fontSize }, { shouldRender: false });
        syncFontSizeControls();
      }
    });

    input.addEventListener("change", () => {
      if (!input.value.trim()) {
        syncFontSizeControls();
        return;
      }

      updateAppearanceSettings({ fontSize: Number(input.value) }, { shouldRender: false });
      syncFontSizeControls();
    });
  });

  document.querySelector<HTMLButtonElement>('[data-action="reset-appearance"]')?.addEventListener("click", () => {
    updateAppearanceSettings(defaultAppearanceSettings);
  });
}

function bindViewEvents() {
  document.querySelectorAll<HTMLButtonElement>('[data-action="set-project-view"]').forEach((button) => {
    button.addEventListener("click", () => {
      const viewMode = button.dataset.viewMode;

      if (viewMode === "board" || viewMode === "table") {
        setCurrentProjectViewMode(viewMode);
      }
    });
  });

  document.querySelectorAll<HTMLButtonElement>('[data-action="sort-table"]').forEach((button) => {
    button.addEventListener("click", () => {
      const column = button.dataset.tableColumn;

      if (isTableColumn(column)) {
        toggleTableSort(column);
      }
    });
  });

  document.querySelector<HTMLButtonElement>('[data-action="archive-done"]')?.addEventListener("click", () => {
    void archiveDoneTickets();
  });
}

function bindTicketSearchEvents() {
  const input = document.querySelector<HTMLInputElement>("[data-search-input]");

  input?.addEventListener("input", () => {
    const nextQuery = input.value.slice(0, maxTicketSearchQueryLength);

    if (input.value !== nextQuery) {
      input.value = nextQuery;
    }

    setTicketSearchQuery(nextQuery);
  });

  document.querySelector<HTMLButtonElement>('[data-action="clear-search"]')?.addEventListener("click", () => {
    setTicketSearchQuery("");
    document.querySelector<HTMLInputElement>("[data-search-input]")?.focus({ preventScroll: true });
  });
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
        const project = await trackLocalMutation(api.createProject(name));
        state.workspace?.projects.push(project);
        state.activePage = "project";
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

      const project = await trackLocalMutation(api.importProject(path));
      state.activePage = "project";
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

      if (!projectId) {
        return;
      }

      const isCurrentProject = projectId === state.selectedProjectId;

      if (isCurrentProject && state.activePage === "project") {
        return;
      }

      if (!(await confirmDiscardDraft())) {
        return;
      }

      try {
        state.activePage = "project";
        state.selectedProjectId = projectId;
        state.selectedTicketId = null;
        state.draft = null;

        if (isCurrentProject) {
          render();
          return;
        }

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
      if (!state.draggingProjectId) {
        return;
      }

      event.preventDefault();
      if (event.dataTransfer) {
        event.dataTransfer.dropEffect = "move";
      }
      const list = button.closest<HTMLElement>(".project-list");

      if (list) {
        updateProjectDropIndicator(list, getProjectInsertionBeforeId(list, event.clientY));
      }
    });

    button.addEventListener("drop", async (event) => {
      event.preventDefault();

      const projectId = event.dataTransfer?.getData(projectDragType) || state.draggingProjectId;
      const list = button.closest<HTMLElement>(".project-list");
      const beforeId = list ? getProjectInsertionBeforeId(list, event.clientY) : button.dataset.projectId;

      if (!projectId || projectId === beforeId) {
        return;
      }

      await reorderProject(projectId, beforeId);
    });

    button.addEventListener("dragend", () => {
      state.draggingProjectId = null;
      clearDropIndicators();
      document
        .querySelectorAll(".is-project-dragging")
        .forEach((node) => node.classList.remove("is-project-dragging"));
    });
  });

  document.querySelector<HTMLElement>(".project-list")?.addEventListener("dragover", (event) => {
    if (state.draggingProjectId) {
      event.preventDefault();
      const list = event.currentTarget as HTMLElement;
      updateProjectDropIndicator(list, getProjectInsertionBeforeId(list, event.clientY));
    }
  });

  document.querySelector<HTMLElement>(".project-list")?.addEventListener("drop", async (event) => {
    const targetProject = (event.target as HTMLElement).closest<HTMLElement>(".project-item");

    if (targetProject) {
      return;
    }

    event.preventDefault();
    const projectId = event.dataTransfer?.getData(projectDragType) || state.draggingProjectId;
    const beforeId = getProjectInsertionBeforeId(event.currentTarget as HTMLElement, event.clientY);

    if (projectId && projectId !== beforeId) {
      await reorderProject(projectId, beforeId);
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
    const updated = await trackLocalMutation(api.updateProjectName(projectId, nextName));
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

async function copyTicketPath(ticketId: string, pathKind: "absolute" | "relative") {
  const ticket = getTicket(ticketId);

  if (!ticket) {
    closeTicketMenu();
    return;
  }

  try {
    await copyText(ticketPathForCopy(ticket, pathKind));
    closeTicketMenu();
  } catch (error) {
    showError(error);
  }
}

function ticketPathForCopy(ticket: Ticket, pathKind: "absolute" | "relative") {
  if (pathKind === "absolute") {
    return ticket.filePath;
  }

  const project = state.selectedProjectId ? getProject(state.selectedProjectId) : null;
  return project ? ticketPathRelativeToProject(ticket.filePath, project.path) : ticket.filePath;
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
    const workspace = await trackLocalMutation(api.removeProject(projectId));
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

async function reorderProject(projectId: string, targetId?: string) {
  if (!state.workspace || projectId === targetId) {
    return;
  }

  const nextProjects = reorderProjectsForInsertion(state.workspace.projects, projectId, targetId);

  if (nextProjects === state.workspace.projects) {
    return;
  }

  await saveProjectOrder(nextProjects);
}

function getProjectInsertionBeforeId(list: HTMLElement, pointerY: number) {
  const projects = Array.from(list.querySelectorAll<HTMLElement>(".project-item:not(.is-project-dragging)"));

  for (const project of projects) {
    const rect = project.getBoundingClientRect();

    if (pointerY < rect.top + rect.height / 2) {
      return project.dataset.projectId;
    }
  }

  return undefined;
}

function updateProjectDropIndicator(list: HTMLElement, beforeId?: string) {
  const currentBefore = document.querySelector<HTMLElement>(".project-item.is-drop-before");
  const currentAfter = document.querySelector<HTMLElement>(".project-item.is-drop-after");
  const currentEnd = document.querySelector<HTMLElement>(".project-list.is-drop-at-end");

  if (beforeId) {
    const nextBefore = findProjectItem(beforeId, list);

    if (nextBefore && currentBefore === nextBefore && !currentAfter && !currentEnd) {
      return;
    }

    clearDropIndicators();
    nextBefore?.classList.add("is-drop-before");
    return;
  }

  const nextAfter = findLastProjectItem(list);

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
    state.workspace = await trackLocalMutation(api.reorderProjects(projects.map((project) => project.id)));
    render();
  } catch (error) {
    state.workspace = previousWorkspace;
    showError(error);
  }
}

function bindMetadataEvents() {
  document.querySelectorAll<HTMLAnchorElement>("a.ticket-metadata-item[href]").forEach((link) => {
    link.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      void openMetadataLink(link.href);
    });
  });
}

async function openMetadataLink(url: string) {
  try {
    await api.openExternalLink(url);
  } catch (error) {
    showError(error);
  }
}

function bindTicketEvents() {
  document
    .querySelectorAll<HTMLFormElement>('[data-action="create-ticket"]')
    .forEach((form) => {
      const textarea = form.elements.namedItem("title") as HTMLTextAreaElement | null;
      if (textarea) {
        bindQuickAddTextarea(textarea);
      }

      form.addEventListener("submit", async (event) => {
        event.preventDefault();
        const currentForm = event.currentTarget as HTMLFormElement | null;

        if (!state.selectedProjectId || !currentForm) {
          return;
        }

        const status = currentForm.dataset.status as Status;
        const input = currentForm.elements.namedItem("title") as HTMLTextAreaElement;
        const title = input.value.trim();

        if (!title) {
          input.focus();
          return;
        }

        try {
          const ticket = await trackLocalMutation(api.createTicket(state.selectedProjectId, status, title));
          state.tickets.push(ticket);
          state.workspace = updateTicketCount(state.workspace, state.selectedProjectId, 1);
          input.value = "";
          if (await rerunActiveTicketSearch({ preserveScroll: true, revealTicket: { id: ticket.id, block: "end" } })) {
            return;
          }
          render({ preserveScroll: true, revealTicket: { id: ticket.id, block: "end" } });
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

      if (action === "copy-ticket-absolute-path") {
        void copyTicketPath(ticketId, "absolute");
      }

      if (action === "copy-ticket-relative-path") {
        void copyTicketPath(ticketId, "relative");
      }

      if (action === "delete-ticket") {
        void deleteTicket(ticketId);
      }
    });
  });

  bindTableTicketEvents();

  document.querySelectorAll<HTMLElement>(".ticket-card").forEach((card) => {
    card.addEventListener("click", (event) => {
      if ((event.target as HTMLElement).closest("a.ticket-metadata-item")) {
        return;
      }

      const ticketId = card.dataset.ticketId;

      if (ticketId) {
        openEditor(ticketId);
      }
    });

    card.addEventListener("contextmenu", (event) => {
      if ((event.target as HTMLElement).closest("a.ticket-metadata-item")) {
        return;
      }

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
        if (isTicketReorderDisabled()) {
          event.preventDefault();
          return;
        }

        const ticketId = card.dataset.ticketId;

        if (ticketId) {
          event.preventDefault();
          void moveFocusedTicket(ticketId, event.key === "ArrowUp" ? "up" : "down");
        }
      }
    });

    card.addEventListener("dragstart", (event) => {
      if (isTicketReorderDisabled()) {
        event.preventDefault();
        return;
      }

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
      if (isTicketReorderDisabled() || !state.draggingId) {
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
      if (isTicketReorderDisabled()) {
        event.preventDefault();
        return;
      }

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

function bindTableTicketEvents() {
  const table = document.querySelector<HTMLElement>(".task-table");

  table?.addEventListener("click", (event) => {
    const target = event.target as HTMLElement;
    const tableLink = target.closest<HTMLAnchorElement>("a[data-table-link]");

    if (tableLink) {
      event.preventDefault();
      event.stopPropagation();
      void openMetadataLink(tableLink.href);
      return;
    }

    const clickedTaskSelector = target.closest<HTMLElement>("[data-task-selector]");
    closeTaskSelectorsExcept(clickedTaskSelector);

    const actionButton = target.closest<HTMLButtonElement>("button[data-action]");

    if (!actionButton?.dataset.action) {
      return;
    }

    const action = actionButton.dataset.action;

    if (action === "open-table-ticket") {
      const ticketId = actionButton.closest<HTMLElement>(".task-table-row")?.dataset.ticketId;

      if (ticketId) {
        openEditor(ticketId);
      }
      return;
    }

    if (action === "toggle-task-selector") {
      toggleTaskSelector(actionButton.closest<HTMLElement>("[data-task-selector]"));
      return;
    }

    if (action === "choose-task-selector") {
      void chooseTableSelectorValue(actionButton.dataset.selectorValue, actionButton);
    }
  });

  table?.addEventListener("contextmenu", (event) => {
    const target = event.target as HTMLElement;

    if (target.closest("a[data-table-link]")) {
      return;
    }

    const row = target.closest<HTMLElement>(".task-table-row");
    const ticketId = row?.dataset.ticketId;

    if (!row || !ticketId) {
      return;
    }

    event.preventDefault();
    closeTaskSelector();
    openTicketMenu(ticketId, event.clientX, event.clientY);
  });

  document.querySelectorAll<HTMLElement>(".task-table-row").forEach((row) => {
    row.addEventListener("keydown", (event) => {
      if (event.target !== row) {
        return;
      }

      const ticketId = row.dataset.ticketId;

      if (!ticketId) {
        return;
      }

      if (event.key === "Enter") {
        openEditor(ticketId);
      }
    });
  });

  document.querySelector<HTMLElement>(".task-table-scroll")?.addEventListener("scroll", () => {
    closeTaskSelector();
  });
}

function bindEditorEvents() {
  const backdrop = document.querySelector<HTMLElement>(".modal-backdrop");
  const panel = document.querySelector<HTMLElement>(".editor-panel");
  const titleInput = document.querySelector<HTMLInputElement>('.editor-panel input[name="title"]');
  const editorRoot = document.querySelector<HTMLElement>("[data-editor-root]");
  const taskSelectors = Array.from(document.querySelectorAll<HTMLElement>("[data-task-selector]"));

  if (editorRoot && state.draft) {
    mountMarkdownEditor(editorRoot, state.draft.body);
  }

  const backdropDismissState = createBackdropDismissState();

  backdrop?.addEventListener("pointerdown", (event) => {
    recordBackdropPointerDown(backdropDismissState, event.target, backdrop);
  });

  backdrop?.addEventListener("pointerup", (event) => {
    if (shouldDismissEditorOnBackdropPointerUp(backdropDismissState, event.target, backdrop)) {
      void requestCloseEditor();
    }
  });

  backdrop?.addEventListener("pointercancel", () => {
    resetBackdropDismissState(backdropDismissState);
  });

  panel?.addEventListener("click", (event) => {
    const target = event.target as HTMLElement;
    const clickedTaskSelector = target.closest<HTMLElement>("[data-task-selector]");

    closeTaskSelectorsExcept(clickedTaskSelector);

    const actionButton = target.closest<HTMLButtonElement>("button[data-action]");

    if (!actionButton?.dataset.action) {
      return;
    }

    const action = actionButton.dataset.action;

    if (action === "toggle-task-selector") {
      toggleTaskSelector(actionButton.closest<HTMLElement>("[data-task-selector]"));
      return;
    }

    if (action === "choose-task-selector") {
      chooseDraftSelectorValue(actionButton.dataset.selectorValue, actionButton);
      return;
    }

    if (action === "close-editor") {
      void requestCloseEditor();
    }

    if (action === "delete-ticket") {
      void deleteSelectedTicket();
    }

    if (action === "edit-title") {
      showEditorTitleInput(
        event.detail > 0
          ? {
              click: {
                clientX: event.clientX,
                clientY: event.clientY
              }
            }
          : { select: true }
      );
    }
  });

  titleInput?.addEventListener("input", () => {
    if (state.draft) {
      state.draft.title = titleInput.value;
      scheduleDraftSave();
    }
  });

  titleInput?.addEventListener("blur", () => {
    showEditorTitleDisplay();
  });

  titleInput?.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      showEditorTitleDisplay({ focus: true });
    }
  });

  taskSelectors.forEach((selector) => {
    selector.addEventListener("keydown", (event) => {
      handleTaskSelectorKeydown(event, selector);
    });

    selector.addEventListener("focusout", (event) => {
      const nextTarget = event.relatedTarget as Node | null;

      if (!nextTarget || !selector.contains(nextTarget)) {
        closeTaskSelector(selector);
      }
    });
  });
}

function showEditorTitleInput(
  options: { click?: { clientX: number; clientY: number }; select?: boolean } = {}
) {
  const titleDisplay = document.querySelector<HTMLButtonElement>(".title-display");
  const titleInput = document.querySelector<HTMLInputElement>('.editor-panel input[name="title"]');

  if (!titleDisplay || !titleInput) {
    return;
  }

  const caretIndex = options.click
    ? titleInputCaretIndexFromDisplayClick(titleDisplay, titleInput.value, options.click.clientX, options.click.clientY)
    : null;

  titleDisplay.hidden = true;
  titleInput.hidden = false;
  titleInput.focus();

  if (caretIndex !== null) {
    titleInput.setSelectionRange(caretIndex, caretIndex);
    return;
  }

  if (options.select) {
    titleInput.select();
    return;
  }

  const end = titleInput.value.length;
  titleInput.setSelectionRange(end, end);
}

function titleInputCaretIndexFromDisplayClick(
  titleDisplay: HTMLElement,
  inputValue: string,
  clientX: number,
  clientY: number
) {
  const hit = caretHitFromPoint(clientX, clientY);

  if (!hit || !titleDisplay.contains(hit.node)) {
    return null;
  }

  const displayOffset = textOffsetWithin(titleDisplay, hit.node, hit.offset);

  if (displayOffset === null) {
    return null;
  }

  return mapTitleDisplayOffsetToInputOffset(inputValue, displayOffset);
}

function caretHitFromPoint(clientX: number, clientY: number) {
  const caretDocument = document as Document & {
    caretPositionFromPoint?: (x: number, y: number) => { offsetNode: Node; offset: number } | null;
    caretRangeFromPoint?: (x: number, y: number) => ReturnType<Document["createRange"]> | null;
  };

  const position = caretDocument.caretPositionFromPoint?.(clientX, clientY);

  if (position) {
    return {
      node: position.offsetNode,
      offset: position.offset
    };
  }

  const range = caretDocument.caretRangeFromPoint?.(clientX, clientY);

  if (!range) {
    return null;
  }

  return {
    node: range.startContainer,
    offset: range.startOffset
  };
}

function textOffsetWithin(container: HTMLElement, node: Node, offset: number) {
  try {
    const range = document.createRange();
    range.setStart(container, 0);
    range.setEnd(node, clampNodeOffset(node, offset));

    return range.toString().length;
  } catch {
    return null;
  }
}

function clampNodeOffset(node: Node, offset: number) {
  const length = node.nodeType === Node.TEXT_NODE ? (node.textContent?.length ?? 0) : node.childNodes.length;

  return clampNumber(offset, 0, length);
}

function mapTitleDisplayOffsetToInputOffset(inputValue: string, displayOffset: number) {
  if (!inputValue) {
    return 0;
  }

  const taggedTitle = parseTicketTitle(inputValue);

  if (!taggedTitle) {
    return clampNumber(displayOffset, 0, inputValue.length);
  }

  const tagStart = inputValue.indexOf(taggedTitle.tag);
  const textStart = taggedTitle.text ? inputValue.lastIndexOf(taggedTitle.text) : -1;

  if (tagStart < 0 || textStart < 0 || textStart <= tagStart) {
    return clampNumber(displayOffset, 0, inputValue.length);
  }

  if (displayOffset <= taggedTitle.tag.length) {
    return clampNumber(tagStart + displayOffset, 0, inputValue.length);
  }

  return clampNumber(textStart + displayOffset - taggedTitle.tag.length, 0, inputValue.length);
}

function clampNumber(value: number, min: number, max: number) {
  return Math.min(Math.max(value, min), max);
}

function showEditorTitleDisplay(options: { focus?: boolean } = {}) {
  const titleDisplay = document.querySelector<HTMLButtonElement>(".title-display");
  const titleInput = document.querySelector<HTMLInputElement>('.editor-panel input[name="title"]');

  if (!titleDisplay || !titleInput || !state.draft) {
    return;
  }

  const displayTitle = titleDisplayValue(state.draft.title);

  titleDisplay.innerHTML = renderTicketTitle(displayTitle);
  titleDisplay.setAttribute("aria-label", `Edit title: ${displayTitle}`);
  titleInput.hidden = true;
  titleDisplay.hidden = false;

  if (options.focus) {
    titleDisplay.focus();
  }
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

    if (event.key === "Escape" && closeTaskSelector()) {
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

function bindLayoutGuards() {
  window.addEventListener("resize", () => {
    applyCardPreviewPrecedence();
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
    priority: ticket.priority,
    size: ticket.size,
    pastedImages: []
  };
  state.draftSaveError = null;
  render({ preserveScroll: true });
  document.querySelector<HTMLButtonElement>(".title-display")?.focus({ preventScroll: true });
}

function closeEditor() {
  clearScheduledDraftSave();
  state.selectedTicketId = null;
  state.draft = null;
  state.draftSaveError = null;
  render({ preserveScroll: true });
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
    ticket.priority !== state.draft.priority ||
    ticket.size !== state.draft.size ||
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
  const priority = normalizeDraftPriority(draft.priority) ?? null;
  const size = normalizeDraftSize(draft.size) ?? null;
  const imagePaths = [...draft.pastedImages];
  const unusedImages = unusedDraftImages(draft);
  await cleanupTicketImages(projectId, unusedImages);

  const updated = await trackLocalMutation(api.updateTicket(projectId, ticketId, title, body, status, priority, size));

  clearDraftSaveError();
  state.tickets = state.tickets.map((ticket) => (ticket.id === updated.id ? updated : ticket)).sort(sortTickets);
  await rerunActiveTicketSearch({ preserveScroll: true });

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
    const updated = api.persistDraftSync({
      projectId: state.selectedProjectId,
      draft: state.draft,
      title: normalizeDraftTitle(state.draft.title),
      body: normalizeDraftBody(state.draft.body)
    });

    if (!updated) {
      return false;
    }

    clearScheduledDraftSave();
    clearDraftSaveError();
    state.tickets = state.tickets.map((ticket) => (ticket.id === updated?.id ? updated : ticket)).sort(sortTickets);
    state.draft.pastedImages = [];
    void rerunActiveTicketSearch({ preserveScroll: true });
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
    await trackLocalMutation(api.deleteTicket(state.selectedProjectId, ticket.id));
    state.tickets = state.tickets.filter((candidate) => candidate.id !== ticket.id);
    state.workspace = updateTicketCount(state.workspace, state.selectedProjectId, -1);
    state.ticketMenu = null;
    removeTicketFromSearchResults(ticket.id);

    if (state.selectedTicketId === ticket.id) {
      state.selectedTicketId = null;
      state.draft = null;
    }

    if (hasActiveTicketSearch()) {
      render({ preserveScroll: true });
    }

    if (await rerunActiveTicketSearch({ preserveScroll: true })) {
      return;
    }

    render();
  } catch (error) {
    showError(error);
  }
}

async function archiveDoneTickets() {
  if (!state.selectedProjectId) {
    return;
  }

  const doneTickets = state.tickets.filter((ticket) => ticket.status === "done");

  if (doneTickets.length === 0) {
    return;
  }

  if (!(await saveDraft({ flush: true }))) {
    return;
  }

  const confirmed = await confirmAction(
    `Archive ${doneTickets.length} done ${doneTickets.length === 1 ? "task" : "tasks"}?`,
    "Archive done tasks"
  );

  if (!confirmed) {
    return;
  }

  try {
    clearScheduledDraftSave();
    state.tickets = (await api.archiveDoneTickets(state.selectedProjectId)).sort(sortTickets);
    state.workspace = updateTicketCount(state.workspace, state.selectedProjectId, -doneTickets.length);

    if (state.selectedTicketId && !state.tickets.some((ticket) => ticket.id === state.selectedTicketId)) {
      state.selectedTicketId = null;
      state.draft = null;
    }

    if (await rerunActiveTicketSearch({ preserveScroll: true })) {
      return;
    }

    render({ preserveScroll: true });
  } catch (error) {
    showError(error, { preserveScroll: true });
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
  await Promise.all(imagePaths.map((imagePath) => trackLocalMutation(api.deleteTicketImage(projectId, imagePath))));
}

function unusedDraftImages(draft: TicketDraft) {
  return draft.pastedImages.filter((imagePath) => !draft.body.includes(`](${imagePath})`));
}

async function moveTicket(ticketId: string, status: Status, beforeId?: string) {
  if (!state.selectedProjectId || isTicketReorderDisabled()) {
    return;
  }

  const dragged = state.tickets.find((ticket) => ticket.id === ticketId);

  if (!dragged || beforeId === ticketId) {
    return;
  }

  const remaining = state.tickets.filter((ticket) => ticket.id !== ticketId);
  const insertedTickets = insertTicket(remaining, { ...dragged, status }, status, beforeId);
  const rank = rankForInsertion(insertedTickets, ticketId, status);

  if (dragged.status === status && dragged.rank === rank) {
    return;
  }

  const nextTicket = { ...dragged, status, rank };
  const nextTickets = insertTicket(remaining, nextTicket, status, beforeId).map((ticket) => ({ ...ticket }));
  const positions = [{ id: ticketId, status, rank }];

  state.tickets = nextTickets.sort(sortTickets);
  render({ preserveScroll: true });

  try {
    state.tickets = await trackLocalMutation(api.reorderTickets(state.selectedProjectId, positions));
    render({ preserveScroll: true });
  } catch (error) {
    showError(error, { preserveScroll: true });
    await loadTickets(state.selectedProjectId);
    render({ preserveScroll: true });
  }
}

type KeyboardMoveDirection = "up" | "down";

async function moveFocusedTicket(ticketId: string, direction: KeyboardMoveDirection) {
  if (isTicketReorderDisabled()) {
    return;
  }

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

function findProjectItem(projectId: string, root: ParentNode = document) {
  return (
    Array.from(root.querySelectorAll<HTMLElement>(".project-item")).find(
      (project) => project.dataset.projectId === projectId
    ) ?? null
  );
}

function findTableRow(ticketId: string, root: ParentNode = document) {
  return (
    Array.from(root.querySelectorAll<HTMLElement>(".task-table-row")).find(
      (row) => row.dataset.ticketId === ticketId
    ) ?? null
  );
}

function findLastTicketCard(root: ParentNode = document) {
  const cards = Array.from(root.querySelectorAll<HTMLElement>(".ticket-card:not(.is-dragging)"));

  return cards[cards.length - 1] ?? null;
}

function findLastProjectItem(root: ParentNode = document) {
  const projects = Array.from(root.querySelectorAll<HTMLElement>(".project-item:not(.is-project-dragging)"));

  return projects[projects.length - 1] ?? null;
}

function focusTicket(ticketId: string) {
  (findTicketCard(ticketId) ?? findTableRow(ticketId))?.focus();
}

function revealTicketInList(ticketId: string, block: "nearest" | "end" = "nearest") {
  const card = findTicketCard(ticketId);
  const list = card?.closest<HTMLElement>(".ticket-list");

  if (!card || !list) {
    return;
  }

  const listRect = list.getBoundingClientRect();
  const cardRect = card.getBoundingClientRect();
  const cardTop = cardRect.top - listRect.top + list.scrollTop;
  const cardBottom = cardTop + cardRect.height;
  const visibleTop = list.scrollTop;
  const visibleBottom = visibleTop + list.clientHeight;
  const maxScrollTop = Math.max(0, list.scrollHeight - list.clientHeight);
  let nextScrollTop = visibleTop;

  if (block === "end" || cardBottom > visibleBottom) {
    nextScrollTop = cardBottom - list.clientHeight;
  } else if (cardTop < visibleTop) {
    nextScrollTop = cardTop;
  }

  list.scrollTop = Math.min(maxScrollTop, Math.max(0, nextScrollTop));
}

function captureScrollSnapshot(): ScrollSnapshot {
  return {
    windowX: window.scrollX,
    windowY: window.scrollY,
    elements: Array.from(
      document.querySelectorAll<HTMLElement>(
        ".project-list, .workspace, .board, .task-table-scroll, .ticket-list[data-status]"
      )
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

  if (element.classList.contains("task-table-scroll")) {
    return "task-table";
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

  if (key === "task-table") {
    return document.querySelector<HTMLElement>(".task-table-scroll");
  }

  return null;
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

function readAppearanceSettings() {
  try {
    return parseAppearanceSettings(localStorage.getItem(appearanceStorageKey));
  } catch {
    return { ...defaultAppearanceSettings };
  }
}

function persistAppearanceSettings() {
  try {
    localStorage.setItem(appearanceStorageKey, serializeAppearanceSettings(state.appearance));
  } catch {
    return;
  }
}

function applyAppearanceSettings(settings: AppearanceSettings) {
  const normalized = normalizeAppearanceSettings(settings);
  const root = document.documentElement;

  root.dataset.colorScheme = normalized.colorScheme;
  root.style.setProperty("--app-font-family", appFontCss(normalized.fontFamily));
  root.style.setProperty("--app-font-size", `${normalized.fontSize}px`);
}

function updateAppearanceSettings(
  settings: Partial<AppearanceSettings>,
  options: { shouldRender?: boolean } = {}
) {
  state.appearance = normalizeAppearanceSettings({
    ...state.appearance,
    ...settings
  });
  applyAppearanceSettings(state.appearance);
  persistAppearanceSettings();

  if (options.shouldRender !== false) {
    render({ preserveScroll: true });
  }
}

function isColorSchemeSetting(value: string | undefined): value is ColorScheme {
  return colorSchemeOptions.some((option) => option.value === value);
}

function isAppFontSetting(value: string | undefined): value is AppFont {
  return appFontOptions.some((option) => option.value === value);
}

function isFontSizeInRange(value: number) {
  return Number.isFinite(value) && value >= minFontSize && value <= maxFontSize;
}

function syncFontSizeControls() {
  const value = String(state.appearance.fontSize);

  document.querySelectorAll<HTMLInputElement>('input[data-action="set-font-size"]').forEach((input) => {
    input.value = value;
  });

  const selectedFont = appFontOptions.find((option) => option.value === state.appearance.fontFamily) ?? appFontOptions[0];
  const previewType = document.querySelector<HTMLElement>(".settings-preview-type");

  if (previewType) {
    previewType.textContent = `${selectedFont.label} / ${state.appearance.fontSize}px`;
  }
}

function currentProjectViewMode(): ProjectViewMode {
  const projectId = state.selectedProjectId;

  return projectId ? state.projectViewModes[projectId] ?? "board" : "board";
}

function setCurrentProjectViewMode(viewMode: ProjectViewMode) {
  const projectId = state.selectedProjectId;

  if (!projectId || currentProjectViewMode() === viewMode) {
    return;
  }

  state.projectViewModes = {
    ...state.projectViewModes,
    [projectId]: viewMode
  };
  persistProjectViewModes();
  render({ preserveScroll: true });
}

function readProjectViewModes(): Record<string, ProjectViewMode> {
  try {
    const raw = localStorage.getItem(projectViewModeStorageKey);
    const parsed = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};

    return Object.fromEntries(
      Object.entries(parsed).filter((entry): entry is [string, ProjectViewMode] =>
        entry[1] === "board" || entry[1] === "table"
      )
    );
  } catch {
    return {};
  }
}

function persistProjectViewModes() {
  try {
    localStorage.setItem(projectViewModeStorageKey, JSON.stringify(state.projectViewModes));
  } catch {
    return;
  }
}

function currentProjectTableState(): ProjectTableState {
  const projectId = state.selectedProjectId ?? "__default";

  state.projectTableStates[projectId] ??= {
    sort: null
  };

  return state.projectTableStates[projectId];
}

function tableTickets() {
  const tableState = currentProjectTableState();

  return sortTicketsForTable(searchFilteredTickets(), tableState.sort);
}

function defaultTableSortIndex(column: TableColumn) {
  return defaultTableSorts.findIndex((sort) => sort.column === column);
}

function isTableColumn(value: string | undefined): value is TableColumn {
  return tableColumnConfigs().some((column) => column.id === value);
}

function toggleTableSort(column: TableColumn) {
  const tableState = currentProjectTableState();
  const currentSort = tableState.sort;
  const defaultIndex = defaultTableSortIndex(column);

  if (!currentSort && defaultIndex >= 0) {
    tableState.sort = { column, direction: "desc" };
  } else if (currentSort?.column === column && currentSort.direction === "asc") {
    tableState.sort = { column, direction: "desc" };
  } else if (currentSort?.column === column) {
    tableState.sort = null;
  } else {
    tableState.sort = { column, direction: "asc" };
  }

  render({ preserveScroll: true });
}

function ticketsFor(status: Status) {
  return searchFilteredTickets().filter((ticket) => ticket.status === status).sort(sortTickets);
}

function searchFilteredTickets() {
  return filterTicketsBySearchResults(state.tickets, state.searchResults, hasActiveTicketSearch());
}

function hasActiveTicketSearch() {
  return isTicketSearchActive(state.searchQuery);
}

function hasNoTicketSearchMatches() {
  return hasActiveTicketSearch() && !state.searchPending && state.searchResults.length === 0;
}

function isTicketReorderDisabled() {
  return shouldDisableSearchReorder(state.searchQuery);
}

function ticketSearchCountText() {
  if (!hasActiveTicketSearch()) {
    return "";
  }

  if (state.searchPending) {
    return "Searching";
  }

  const count = state.searchResults.length;
  return `${count} ${count === 1 ? "match" : "matches"}`;
}

function setTicketSearchQuery(query: string) {
  const nextQuery = query.slice(0, maxTicketSearchQueryLength);

  if (state.searchQuery === nextQuery) {
    return;
  }

  state.searchQuery = nextQuery;

  if (!hasActiveTicketSearch()) {
    cancelTicketSearchDebounce();
    state.searchRequestSeq += 1;
    state.searchPending = false;
    clearTicketSearchResults();
    render({ preserveScroll: true });
    return;
  }

  state.searchPending = true;
  updateTicketSearchControl();
  scheduleTicketSearch();
}

function scheduleTicketSearch() {
  cancelTicketSearchDebounce();
  ticketSearchDebounceTimer = window.setTimeout(() => {
    ticketSearchDebounceTimer = null;
    void runTicketSearch(state.searchQuery, { preserveScroll: true });
  }, ticketSearchDebounceMs);
}

function cancelTicketSearchDebounce() {
  if (!ticketSearchDebounceTimer) {
    return;
  }

  window.clearTimeout(ticketSearchDebounceTimer);
  ticketSearchDebounceTimer = null;
}

async function rerunActiveTicketSearch(renderOptions: RenderOptions = {}) {
  if (!shouldRerunTicketSearchAfterMutation(state.searchQuery)) {
    return false;
  }

  cancelTicketSearchDebounce();
  return runTicketSearch(state.searchQuery, renderOptions);
}

async function runTicketSearch(query: string, renderOptions: RenderOptions = {}) {
  const projectId = state.selectedProjectId;

  if (!projectId || !isTicketSearchActive(query)) {
    clearTicketSearchResults();
    state.searchPending = false;
    updateTicketSearchControl();
    return false;
  }

  const requestSeq = ++state.searchRequestSeq;
  state.searchPending = true;
  updateTicketSearchControl();

  try {
    const results = await api.searchTickets(projectId, query);

    if (!isCurrentTicketSearchRequest(requestSeq, projectId, query)) {
      return false;
    }

    applyTicketSearchResults(results);
    state.searchPending = false;
    render(renderOptions);
    return true;
  } catch (error) {
    if (!isCurrentTicketSearchRequest(requestSeq, projectId, query)) {
      return false;
    }

    state.searchPending = false;
    clearTicketSearchResults();
    showError(error, renderOptions);
    return false;
  }
}

function isCurrentTicketSearchRequest(requestSeq: number, projectId: string, query: string) {
  return (
    requestSeq === state.searchRequestSeq &&
    state.selectedProjectId === projectId &&
    state.searchQuery === query &&
    hasActiveTicketSearch()
  );
}

function applyTicketSearchResults(results: TicketSearchResult[]) {
  state.searchResults = results;
  state.searchResultMap = createTicketSearchResultMap(results);
}

function clearTicketSearchResults() {
  applyTicketSearchResults([]);
}

function removeTicketFromSearchResults(ticketId: string) {
  if (!hasActiveTicketSearch()) {
    return;
  }

  applyTicketSearchResults(state.searchResults.filter((result) => result.ticket.id !== ticketId));
}

function updateTicketSearchControl() {
  const container = document.querySelector<HTMLElement>(".ticket-search");
  const input = document.querySelector<HTMLInputElement>("[data-search-input]");
  const clearButton = document.querySelector<HTMLButtonElement>('[data-action="clear-search"]');
  const count = document.querySelector<HTMLElement>("[data-search-count]");

  container?.classList.toggle("is-active", hasActiveTicketSearch());
  container?.classList.toggle("is-pending", state.searchPending);
  container?.classList.toggle("has-query", state.searchQuery.length > 0);

  if (input && input.value !== state.searchQuery) {
    input.value = state.searchQuery;
  }

  if (clearButton) {
    clearButton.hidden = state.searchQuery.length === 0;
  }

  if (count) {
    count.textContent = ticketSearchCountText();
  }
}

function renderSearchAwareTicketTitle(ticket: Ticket) {
  const match = ticketTitleSearchMatch(ticket);

  if (!match) {
    return renderTicketTitle(ticket.title);
  }

  return `<span class="ticket-title ticket-title-search">${renderTicketSearchSegments(match.segments)}</span>`;
}

function ticketTitleSearchMatch(ticket: Ticket) {
  return ticketSearchResult(ticket.id)?.matches.find(
    (match) => match.field === "title" && hasMatchedSearchSegment(match.segments)
  ) ?? null;
}

function renderTicketSearchSnippet(ticket: Ticket, placement: "card" | "table") {
  const snippet = bestTicketSearchSnippet(ticket);

  if (!snippet) {
    return "";
  }

  const label = ticketSearchFieldLabel(snippet.field);
  const labelHtml = label ? `<span class="search-snippet-label">${escapeHtml(label)}</span>` : "";

  return `
    <div class="search-snippet search-snippet-${placement}">
      ${labelHtml}
      <span class="search-snippet-text">${renderTicketSearchSegments(snippet.segments)}</span>
    </div>
  `;
}

function bestTicketSearchSnippet(ticket: Ticket): { field: TicketSearchField; segments: TicketSearchSegment[] } | null {
  const result = ticketSearchResult(ticket.id);

  if (!result) {
    return null;
  }

  const match = result.matches.find((candidate) => {
    if (candidate.field === "title") {
      return false;
    }

    return hasMatchedSearchSegment(ticketSearchSnippetSegments(candidate));
  });

  if (!match) {
    return null;
  }

  return {
    field: match.field,
    segments: ticketSearchSnippetSegments(match)
  };
}

function ticketSearchResult(ticketId: string) {
  return hasActiveTicketSearch() ? state.searchResultMap.get(ticketId) ?? null : null;
}

function ticketSearchSnippetSegments(match: TicketSearchMatch) {
  return match.snippetSegments ?? match.snippet_segments ?? match.segments;
}

function hasMatchedSearchSegment(segments: TicketSearchSegment[]) {
  return segments.some((segment) => segment.matched);
}

function ticketSearchFieldLabel(field: TicketSearchField) {
  if (field === "body") {
    return "";
  }

  const labels: Record<TicketSearchField, string> = {
    title: "Title",
    body: "",
    status: "Status",
    priority: "Priority",
    size: "Size",
    prLink: "PR",
    assignee: "Assignee",
    id: "ID",
    filePath: "Path",
    rank: "Rank",
    createdAt: "Created",
    updatedAt: "Updated"
  };

  return labels[field];
}

function captureSearchFocusSnapshot(): SearchFocusSnapshot {
  const input = document.activeElement;

  if (!(input instanceof HTMLInputElement) || !input.matches("[data-search-input]")) {
    return null;
  }

  return {
    start: input.selectionStart,
    end: input.selectionEnd
  };
}

function restoreSearchFocusSnapshot(snapshot: SearchFocusSnapshot) {
  if (!snapshot) {
    return;
  }

  const input = document.querySelector<HTMLInputElement>("[data-search-input]");

  if (!input) {
    return;
  }

  input.focus({ preventScroll: true });

  if (snapshot.start !== null && snapshot.end !== null) {
    input.setSelectionRange(snapshot.start, snapshot.end);
  }
}

function columnForStatus(status: Status) {
  return columns.find((column) => column.id === status) ?? columns[0];
}

function isStatus(value: string | undefined): value is Status {
  return columns.some((column) => column.id === value);
}

function isTaskSelectorKind(value: string | undefined): value is TaskSelectorKind {
  return value === "status" || value === "priority" || value === "size";
}

function isTaskPriority(value: string | undefined): value is TaskPriority {
  return priorities.some((priority) => priority === value);
}

function isTaskSize(value: string | undefined): value is TaskSize {
  return taskSizes.some((size) => size === value);
}

function normalizeDraftPriority(value: string | undefined): TaskPriority | undefined {
  const normalized = value?.toUpperCase();

  return isTaskPriority(normalized) ? normalized : undefined;
}

function normalizeDraftSize(value: string | undefined): TaskSize | undefined {
  const normalized = value?.toUpperCase();

  return isTaskSize(normalized) ? normalized : undefined;
}

function formatTicketTimestamp(value: number) {
  const date = new Date(value);

  if (Number.isNaN(date.getTime())) {
    return "Unknown";
  }

  return taskDateTimeFormatter.format(date);
}

function toggleTaskSelector(selector: HTMLElement | null) {
  if (!selector) {
    return;
  }

  closeTaskSelectorsExcept(selector);
  setTaskSelectorOpen(selector, !selector.classList.contains("is-open"));
}

function closeTaskSelector(selector?: HTMLElement | null) {
  const target = selector ?? document.querySelector<HTMLElement>("[data-task-selector].is-open");

  if (!target?.classList.contains("is-open")) {
    return false;
  }

  setTaskSelectorOpen(target, false);
  return true;
}

function closeTaskSelectorsExcept(activeSelector: HTMLElement | null) {
  document.querySelectorAll<HTMLElement>("[data-task-selector].is-open").forEach((selector) => {
    if (selector !== activeSelector) {
      setTaskSelectorOpen(selector, false);
    }
  });
}

function setTaskSelectorOpen(selector: HTMLElement, isOpen: boolean) {
  selector.classList.toggle("is-open", isOpen);
  selector.querySelector<HTMLButtonElement>(".status-selector-button")?.setAttribute("aria-expanded", String(isOpen));

  if (isOpen) {
    positionTaskSelectorMenu(selector);
    focusSelectedTaskSelectorOption(selector);
  } else {
    resetTaskSelectorMenuPosition(selector);
  }
}

function positionTaskSelectorMenu(selector: HTMLElement) {
  if (selector.dataset.selectorOwner !== "table") {
    return;
  }

  const trigger = selector.querySelector<HTMLElement>(".status-selector-button");
  const menu = selector.querySelector<HTMLElement>(".status-menu");

  if (!trigger || !menu) {
    return;
  }

  const triggerRect = trigger.getBoundingClientRect();
  const menuRect = menu.getBoundingClientRect();
  const menuWidth = Math.max(menuRect.width, triggerRect.width);
  const menuHeight = menuRect.height;
  const left = Math.max(8, Math.min(triggerRect.left, window.innerWidth - menuWidth - 8));
  const preferredTop = triggerRect.bottom + 7;
  const top =
    preferredTop + menuHeight <= window.innerHeight - 8
      ? preferredTop
      : Math.max(8, triggerRect.top - menuHeight - 7);

  menu.style.position = "fixed";
  menu.style.right = "auto";
  menu.style.left = `${left}px`;
  menu.style.top = `${top}px`;
  menu.style.width = `${menuWidth}px`;
}

function resetTaskSelectorMenuPosition(selector: HTMLElement) {
  const menu = selector.querySelector<HTMLElement>(".status-menu");

  if (!menu) {
    return;
  }

  menu.style.removeProperty("position");
  menu.style.removeProperty("right");
  menu.style.removeProperty("left");
  menu.style.removeProperty("top");
  menu.style.removeProperty("width");
}

function chooseDraftSelectorValue(value: string | undefined, source: HTMLElement) {
  const selector = source.closest<HTMLElement>("[data-task-selector]");
  const kind = selector?.dataset.selectorKind as TaskSelectorKind | undefined;

  if (!selector || !isTaskSelectorKind(kind) || !state.draft) {
    return;
  }

  const updated = updateDraftSelectorValue(kind, value ?? "");

  if (updated) {
    scheduleDraftSave();
  }

  updateTaskSelector(selector, kind, selectorValueForKind(kind));
  closeTaskSelector(selector);
  selector?.querySelector<HTMLButtonElement>(".status-selector-button")?.focus();
}

async function chooseTableSelectorValue(value: string | undefined, source: HTMLElement) {
  const selector = source.closest<HTMLElement>("[data-task-selector]");
  const kind = selector?.dataset.selectorKind as TaskSelectorKind | undefined;
  const ticketId = selector?.dataset.ticketId;

  if (!selector || !isTaskSelectorKind(kind) || !ticketId || !state.selectedProjectId) {
    return;
  }

  const projectId = state.selectedProjectId;
  const previousTickets = state.tickets;
  const ticket = getTicket(ticketId);
  const nextTicket = ticket ? ticketWithSelectorValue(ticket, kind, value ?? "") : null;

  if (!ticket || !nextTicket) {
    closeTaskSelector(selector);
    selector.querySelector<HTMLButtonElement>(".status-selector-button")?.focus();
    return;
  }

  state.tickets = state.tickets.map((candidate) => (candidate.id === nextTicket.id ? nextTicket : candidate));
  updateTaskSelector(selector, kind, tableSelectorValueForKind(nextTicket, kind));
  closeTaskSelector(selector);
  render({ preserveScroll: true });
  focusTicket(nextTicket.id);

  try {
    const updated = await trackLocalMutation(api.updateTicket(
      projectId,
      nextTicket.id,
      nextTicket.title,
      nextTicket.body,
      nextTicket.status,
      nextTicket.priority ?? null,
      nextTicket.size ?? null
    ));
    state.tickets = state.tickets.map((candidate) => (candidate.id === updated.id ? updated : candidate)).sort(sortTickets);
    if (await rerunActiveTicketSearch({ preserveScroll: true })) {
      focusTicket(updated.id);
      return;
    }
    render({ preserveScroll: true });
    focusTicket(updated.id);
  } catch (error) {
    state.tickets = previousTickets;
    showError(error, { preserveScroll: true });
    focusTicket(ticketId);
  }
}

function ticketWithSelectorValue(ticket: Ticket, kind: TaskSelectorKind, value: string) {
  if (kind === "status") {
    if (!isStatus(value) || ticket.status === value) {
      return null;
    }

    return { ...ticket, status: value };
  }

  if (kind === "priority") {
    const priority = normalizeDraftPriority(value);

    if (ticket.priority === priority) {
      return null;
    }

    return { ...ticket, priority };
  }

  const size = normalizeDraftSize(value);

  if (ticket.size === size) {
    return null;
  }

  return { ...ticket, size };
}

function tableSelectorValueForKind(ticket: Ticket, kind: TaskSelectorKind) {
  if (kind === "status") {
    return ticket.status;
  }

  if (kind === "priority") {
    return ticket.priority ?? "";
  }

  return ticket.size ?? "";
}

function updateDraftSelectorValue(kind: TaskSelectorKind, value: string) {
  if (!state.draft) {
    return false;
  }

  if (kind === "status") {
    if (!isStatus(value) || state.draft.status === value) {
      return false;
    }

    state.draft.status = value;
    return true;
  }

  if (kind === "priority") {
    const priority = normalizeDraftPriority(value);

    if (state.draft.priority === priority) {
      return false;
    }

    state.draft.priority = priority;
    return true;
  }

  const size = normalizeDraftSize(value);

  if (state.draft.size === size) {
    return false;
  }

  state.draft.size = size;
  return true;
}

function selectorValueForKind(kind: TaskSelectorKind) {
  if (!state.draft) {
    return "";
  }

  if (kind === "status") {
    return state.draft.status;
  }

  if (kind === "priority") {
    return state.draft.priority ?? "";
  }

  return state.draft.size ?? "";
}

function updateTaskSelector(selector: HTMLElement | null, kind: TaskSelectorKind, value: string) {
  if (!selector) {
    return;
  }

  const config = taskSelectorConfig(kind);
  const selected = selectedTaskSelectorOption(kind, value);
  const isCompactCurrentValue = isCompactTaskSelectorCurrentValue(kind);
  const current = selector.querySelector<HTMLElement>(".status-current");
  const currentMark = selector.querySelector<HTMLElement>("[data-task-current-mark]");
  const currentLabel = selector.querySelector<HTMLElement>("[data-task-current-label]");
  const trigger = selector.querySelector<HTMLButtonElement>(".status-selector-button");

  trigger?.setAttribute("aria-label", `${config.label}: ${selected.label}. Change ${config.label.toLowerCase()}`);
  current?.classList.toggle("is-chip-only", isCompactCurrentValue);

  if (currentMark) {
    currentMark.className = taskSelectorMarkClass(kind, selected.value);
    currentMark.innerHTML = renderTaskSelectorMark(kind, selected);
  }

  if (currentLabel) {
    currentLabel.hidden = isCompactCurrentValue;
    currentLabel.textContent = taskSelectorCurrentLabel(kind, selected, config.placeholder);
  }

  selector.querySelectorAll<HTMLButtonElement>(".status-option").forEach((option) => {
    const isSelected = option.dataset.selectorValue === selected.value;
    option.classList.toggle("selected", isSelected);
    option.setAttribute("aria-checked", String(isSelected));

    const check = option.querySelector<HTMLElement>(".status-option-check");

    if (check) {
      check.innerHTML = isSelected ? icon("check") : "";
    }
  });

  hydrateIcons();
}

function handleTaskSelectorKeydown(event: KeyboardEvent, selector: HTMLElement) {
  const options = Array.from(selector.querySelectorAll<HTMLButtonElement>(".status-option"));

  if (!options.length) {
    return;
  }

  if (event.key === "Escape" && selector.classList.contains("is-open")) {
    event.preventDefault();
    event.stopPropagation();
    closeTaskSelector(selector);
    selector.querySelector<HTMLButtonElement>(".status-selector-button")?.focus();
    return;
  }

  if (event.key === "ArrowDown" || event.key === "ArrowUp") {
    event.preventDefault();
    event.stopPropagation();

    if (!selector.classList.contains("is-open")) {
      setTaskSelectorOpen(selector, true);
      return;
    }

    focusTaskSelectorOption(selector, event.key === "ArrowDown" ? 1 : -1);
    return;
  }

  if (event.key === "Home" || event.key === "End") {
    event.preventDefault();
    event.stopPropagation();
    setTaskSelectorOpen(selector, true);
    options[event.key === "Home" ? 0 : options.length - 1]?.focus();
    return;
  }

  if ((event.key === "Enter" || event.key === " ") && document.activeElement?.classList.contains("status-option")) {
    event.preventDefault();
    event.stopPropagation();
    chooseTaskSelectorValue(
      (document.activeElement as HTMLElement).dataset.selectorValue,
      document.activeElement as HTMLElement
    );
  }
}

function chooseTaskSelectorValue(value: string | undefined, source: HTMLElement) {
  const owner = source.closest<HTMLElement>("[data-task-selector]")?.dataset.selectorOwner;

  if (owner === "table") {
    void chooseTableSelectorValue(value, source);
    return;
  }

  chooseDraftSelectorValue(value, source);
}

function focusSelectedTaskSelectorOption(selector: HTMLElement) {
  (
    selector.querySelector<HTMLButtonElement>(".status-option.selected") ??
    selector.querySelector<HTMLButtonElement>(".status-option")
  )?.focus();
}

function focusTaskSelectorOption(selector: HTMLElement, offset: -1 | 1) {
  const options = Array.from(selector.querySelectorAll<HTMLButtonElement>(".status-option"));
  const currentIndex = options.findIndex((option) => option === document.activeElement);
  const selectedIndex = options.findIndex((option) => option.classList.contains("selected"));
  const startIndex = currentIndex >= 0 ? currentIndex : Math.max(0, selectedIndex);
  const nextIndex = (startIndex + offset + options.length) % options.length;

  options[nextIndex]?.focus();
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
    const saved = await trackLocalMutation(api.saveTicketImage(projectId, draftId, image.mimeType, bytes));

    if (markdownEditorView !== view || state.selectedProjectId !== projectId || state.draft?.id !== draftId) {
      await trackLocalMutation(api.deleteTicketImage(projectId, saved.markdownPath));
      return;
    }

    const inserted = replaceMarkdownInEditor(
      view,
      placeholderMarkdown,
      `![${saved.alt}](${saved.markdownPath})`
    );

    if (!inserted) {
      await trackLocalMutation(api.deleteTicketImage(projectId, saved.markdownPath));
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

    const src = resolveMarkdownImageSrc(
      match[2],
      getCurrentProject()?.path,
      runtime.fileSrcConverter
    );

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

function icon(name: string) {
  return `<i data-lucide="${name}" aria-hidden="true"></i>`;
}

function hydrateIcons() {
  createIcons({
    icons: {
      Archive,
      ArrowDown,
      ArrowUp,
      Check,
      ChevronDown,
      CircleCheck,
      Copy,
      Eye,
      Folder,
      FolderOpen,
      FolderPlus,
      GripVertical,
      ListTodo,
      LoaderCircle,
      Moon,
      Palette,
      Pencil,
      Plus,
      RefreshCw,
      Save,
      Search,
      Settings,
      Sun,
      Table2,
      Trash2,
      Type,
      X
    }
  });
}

function shortPath(path: string) {
  const normalized = path.replaceAll("\\", "/");
  const parts = normalized.split("/").filter(Boolean);

  if (parts.length <= 3) {
    return normalized;
  }

  return `.../${parts.slice(-3).join("/")}`;
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

void main();
