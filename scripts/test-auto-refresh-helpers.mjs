import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";

const repoRoot = resolve(import.meta.dirname, "..");
const outDir = await mkdtemp(join(tmpdir(), "todo-md-auto-refresh-"));

execFileSync(
  resolve(repoRoot, "node_modules/.bin/tsc"),
  [
    "--target",
    "ES2022",
    "--module",
    "ES2022",
    "--moduleResolution",
    "Bundler",
    "--ignoreConfig",
    "--rootDir",
    resolve(repoRoot, "src"),
    "--outDir",
    outDir,
    "--noEmit",
    "false",
    "--strict",
    "--skipLibCheck",
    resolve(repoRoot, "src/app/autoRefresh.ts")
  ],
  { stdio: "inherit" }
);

const autoRefresh = await import(pathToFileURL(join(outDir, "app/autoRefresh.js")).href);

function refreshState(overrides = {}) {
  return {
    isLoading: false,
    hasDraft: false,
    hasTicketDrag: false,
    hasProjectDrag: false,
    hasProjectMenu: false,
    hasTicketMenu: false,
    hasProjectRename: false,
    hasConfirmationDialog: false,
    hasOpenTaskSelector: false,
    hasLocalMutation: false,
    hasPendingImageUploads: false,
    hasActiveDraftSave: false,
    ...overrides
  };
}

function ticket(overrides = {}) {
  return {
    id: "ticket-1",
    title: "Ticket",
    body: "Body",
    status: "ready",
    rank: "V",
    createdAt: 1,
    updatedAt: 1,
    filePath: "/project/.tasks/ticket-1.md",
    ...overrides
  };
}

test("automatic refresh is allowed when the board is idle", () => {
  assert.equal(autoRefresh.canRunAutomaticRefresh(refreshState()), true);
});

test("automatic refresh is blocked during active local interactions", () => {
  for (const key of [
    "isLoading",
    "hasDraft",
    "hasTicketDrag",
    "hasProjectDrag",
    "hasProjectMenu",
    "hasTicketMenu",
    "hasProjectRename",
    "hasConfirmationDialog",
    "hasOpenTaskSelector",
    "hasLocalMutation",
    "hasPendingImageUploads",
    "hasActiveDraftSave"
  ]) {
    assert.equal(autoRefresh.canRunAutomaticRefresh(refreshState({ [key]: true })), false, key);
  }
});

test("workspaceInfoChanged detects project metadata and ordering changes", () => {
  const current = {
    baseDir: "/project",
    projects: [
      { id: "one", name: "One", path: "/project/one", ticketCount: 1 },
      { id: "two", name: "Two", path: "/project/two", ticketCount: 2 }
    ]
  };

  assert.equal(autoRefresh.workspaceInfoChanged(current, structuredClone(current)), false);
  assert.equal(
    autoRefresh.workspaceInfoChanged(current, {
      ...current,
      projects: [current.projects[1], current.projects[0]]
    }),
    true
  );
  assert.equal(
    autoRefresh.workspaceInfoChanged(current, {
      ...current,
      projects: [{ ...current.projects[0], ticketCount: 3 }, current.projects[1]]
    }),
    true
  );
});

test("ticketsChanged detects content and metadata changes", () => {
  const current = [ticket(), ticket({ id: "ticket-2", title: "Second" })];

  assert.equal(autoRefresh.ticketsChanged(current, structuredClone(current)), false);
  assert.equal(autoRefresh.ticketsChanged(current, [current[1], current[0]]), true);
  assert.equal(autoRefresh.ticketsChanged(current, [ticket({ updatedAt: 2 }), current[1]]), true);
  assert.equal(autoRefresh.ticketsChanged(current, [ticket({ assignee: "codex://threads/1" }), current[1]]), true);
});
