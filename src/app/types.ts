export type Status = "todo" | "doing" | "done";

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
  order: number;
  createdAt: number;
  updatedAt: number;
  filePath: string;
};

export type TicketDraft = {
  id: string;
  title: string;
  body: string;
  status: Status;
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
