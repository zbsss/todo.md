export type Status = "todo" | "doing" | "done";

export type TaskPriority = "P0" | "P1" | "P2" | "P3" | "P4";

export type TaskSize = "XS" | "S" | "M" | "L" | "XL";

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
  tags?: string[];
  prLink?: string;
  assignee?: string;
};

export type TicketDraft = {
  id: string;
  title: string;
  body: string;
  status: Status;
  priority?: TaskPriority;
  size?: TaskSize;
  tags: string[];
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
