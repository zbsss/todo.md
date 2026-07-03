export type Status = "draft" | "ready" | "doing" | "review" | "done";

export type TaskPriority = "P0" | "P1" | "P2" | "P3" | "P4";

export type TaskSize = "XS" | "S" | "M" | "L" | "XL";

export type TicketDependencyRelationship = "parent" | "subtask" | "blocks" | "blockedBy";

export type ProjectSummary = {
  id: string;
  name: string;
  path: string;
  ticketCount: number;
};

export type WorkspaceInfo = {
  baseDir: string;
  projects: ProjectSummary[];
};

export type Ticket = {
  id: string;
  title: string;
  body: string;
  status: Status;
  rank: string;
  createdAt: number;
  updatedAt: number;
  filePath: string;
  priority?: TaskPriority;
  size?: TaskSize;
  prLink?: string;
  assignee?: string;
  parent: string[];
  subtasks: string[];
  blocks: string[];
  blockedBy: string[];
};

export type TicketSearchField =
  | "title"
  | "body"
  | "status"
  | "priority"
  | "size"
  | "prLink"
  | "assignee"
  | "id"
  | "filePath"
  | "rank"
  | "createdAt"
  | "updatedAt";

export type TicketSearchSegment = {
  text: string;
  matched: boolean;
};

export type TicketSearchMatch = {
  field: TicketSearchField;
  segments: TicketSearchSegment[];
  snippetSegments?: TicketSearchSegment[];
  snippet_segments?: TicketSearchSegment[];
};

export type TicketSearchResult = {
  ticket: Ticket;
  score: number;
  matches: TicketSearchMatch[];
};

export type TicketDraft = {
  id: string;
  title: string;
  body: string;
  status: Status;
  priority?: TaskPriority;
  size?: TaskSize;
  pastedImages: string[];
};

export type SavedTicketImage = {
  markdownPath: string;
  filePath: string;
  alt: string;
};

export type MockStore = {
  workspace: WorkspaceInfo;
  tickets: Record<string, Ticket[]>;
};

export type MarkdownRenderOptions = {
  compact?: boolean;
  skipImages?: boolean;
  projectPath?: string;
  fileSrcConverter?: (path: string) => string;
};

export type RenderOptions = {
  preserveScroll?: boolean;
  revealTicket?: {
    id: string;
    block?: "nearest" | "end";
  };
};

export type SaveDraftOptions = {
  flush?: boolean;
};

export type ScrollSnapshot = {
  windowX: number;
  windowY: number;
  elements: Array<{
    key: string;
    scrollLeft: number;
    scrollTop: number;
  }>;
};
