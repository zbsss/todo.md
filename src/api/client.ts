import { invoke } from "@tauri-apps/api/core";
import type {
  ProjectSummary,
  SavedTicketImage,
  Status,
  Ticket,
  TicketDraft,
  WorkspaceInfo
} from "../app/types";
import { createMockStore, type BrowserMockStore } from "./mockStore";

export type PersistDraftSyncOptions = {
  projectId: string;
  draft: TicketDraft;
  title: string;
  body: string;
};

export type TodoApi = {
  getWorkspaceInfo(): Promise<WorkspaceInfo>;
  createProject(name: string): Promise<ProjectSummary>;
  importProject(path: string): Promise<ProjectSummary>;
  updateProjectName(projectId: string, name: string): Promise<ProjectSummary>;
  removeProject(projectId: string): Promise<WorkspaceInfo>;
  reorderProjects(projectIds: string[]): Promise<WorkspaceInfo>;
  openProject(projectId: string): Promise<void>;
  listTickets(projectId: string): Promise<Ticket[]>;
  createTicket(projectId: string, status: Status, title: string): Promise<Ticket>;
  updateTicket(projectId: string, ticketId: string, title: string, body: string, status: Status): Promise<Ticket>;
  saveTicketImage(projectId: string, ticketId: string, mimeType: string, bytes: number[]): Promise<SavedTicketImage>;
  deleteTicketImage(projectId: string, markdownPath: string): Promise<void>;
  reorderTickets(projectId: string, positions: Array<{ id: string; status: Status; order: number }>): Promise<Ticket[]>;
  deleteTicket(projectId: string, ticketId: string): Promise<void>;
  persistDraftSync(options: PersistDraftSyncOptions): Ticket | null;
};

export type CreateApiOptions = {
  isTauriRuntime: boolean;
  mockStore?: BrowserMockStore;
};

export function createApi({ isTauriRuntime, mockStore = createMockStore() }: CreateApiOptions): TodoApi {
  return {
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
    },
    persistDraftSync(options: PersistDraftSyncOptions) {
      if (isTauriRuntime) {
        return null;
      }

      return mockStore.persistDraftSync(options);
    }
  };
}
