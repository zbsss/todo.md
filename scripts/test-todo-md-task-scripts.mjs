import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

import {
  selectReadyTickets
} from "../.agents/skills/todo-md-tasks/scripts/select-ready-tickets.mjs";
import {
  updateTicketMetadataText
} from "../.agents/skills/todo-md-tasks/scripts/update-ticket-metadata.mjs";
import {
  renderThreadPrompt
} from "../.agents/skills/todo-md-tasks/scripts/render-thread-prompt.mjs";

async function tempProject(name) {
  const dir = await mkdtemp(join(tmpdir(), `todo-md-${name}-`));
  await mkdir(join(dir, ".tasks"));
  return dir;
}

async function writeTicket(projectDir, fileName, frontmatter, body = "Body") {
  const lines = Object.entries(frontmatter).map(([key, value]) => `${key}: ${value}`);
  await writeFile(join(projectDir, ".tasks", fileName), `---\n${lines.join("\n")}\n---\n\n${body}\n`);
}

test("selectReadyTickets fills doing slots from unassigned ready tickets in priority order", async () => {
  const projectDir = await tempProject("select-ready");

  await writeTicket(projectDir, "p2.md", { id: "p2", title: "P2", status: "ready", rank: "b", priority: "P2", size: "M" });
  await writeTicket(projectDir, "p0.md", { id: "p0", title: "P0", status: "ready", rank: "z", priority: "P0", size: "XL" });
  await writeTicket(projectDir, "assigned.md", {
    id: "assigned",
    title: "Assigned",
    status: "ready",
    rank: "a",
    assignee: "codex://threads/assigned"
  });
  await writeTicket(projectDir, "doing.md", { id: "doing", title: "Doing", status: "doing", rank: "a" });
  await writeTicket(projectDir, "review.md", { id: "review", title: "Review", status: "review", rank: "a" });
  await writeTicket(projectDir, "legacy.md", { id: "legacy", title: "Legacy", status: "todo", rank: "a" });

  const result = await selectReadyTickets({ projectDir, maxDoing: 3 });

  assert.equal(result.doingCount, 1);
  assert.equal(result.slots, 2);
  assert.deepEqual(result.selected.map((ticket) => ticket.id), ["p0", "p2"]);
  assert.deepEqual(
    result.selected.map((ticket) => [ticket.id, ticket.size, ticket.reasoningEffort, ticket.planningRequired]),
    [
      ["p0", "XL", "xhigh", true],
      ["p2", "M", "high", false]
    ]
  );
});

test("task scripts handle CRLF ticket frontmatter", async () => {
  const projectDir = await tempProject("crlf");
  const ticketPath = join(projectDir, ".tasks", "ready.md");

  await writeFile(
    ticketPath,
    "---\r\nid: ready\r\ntitle: Ready\r\nstatus: ready\r\nrank: V\r\nupdated_at: 1\r\n---\r\n\r\nBody\r\n"
  );

  const selected = await selectReadyTickets({ projectDir, maxDoing: 3 });
  assert.deepEqual(selected.selected.map((ticket) => ticket.id), ["ready"]);

  const updated = updateTicketMetadataText(
    await readFile(ticketPath, "utf8"),
    { status: "doing", assignee: "codex://threads/crlf" },
    { touch: false }
  );

  assert.match(updated, /^---\r\nid: ready\r\n/m);
  assert.match(updated, /\r\nstatus: doing\r\n/);
  assert.match(updated, /\r\nassignee: codex:\/\/threads\/crlf\r\n/);
  assert.equal(updated.endsWith("\r\nBody\r\n"), true);
});

test("updateTicketMetadataText preserves body and updates canonical metadata", () => {
  const input = "---\nid: task\ntitle: Task\nstatus: ready\nupdated_at: 1\nassignee: old\n---\n\n## Body\n\n- keep me\n";
  const output = updateTicketMetadataText(
    input,
    { status: "doing", assignee: "codex://threads/new", prLink: "https://github.com/acme/repo/pull/1" },
    { touch: false }
  );

  assert.equal(
    output,
    "---\nid: task\ntitle: Task\nstatus: doing\nupdated_at: 1\nassignee: codex://threads/new\npr_link: https://github.com/acme/repo/pull/1\n---\n\n## Body\n\n- keep me\n"
  );
});

test("renderThreadPrompt includes implementer role instructions and ticket context", async () => {
  const projectDir = await tempProject("render-prompt");
  const agentPath = join(projectDir, "agent.toml");
  const ticketPath = join(projectDir, ".tasks", "example.md");

  await writeFile(
    agentPath,
    'name = "todo-md-implementer"\ndescription = "Implements one task."\ndeveloper_instructions = """\nUse the shared task skill.\n"""\n'
  );
  await writeTicket(projectDir, "example.md", {
    id: "example",
    title: "Example",
    status: "ready",
    priority: "P1",
    size: "XL"
  });

  const prompt = await renderThreadPrompt({
    agentPath,
    ticketPath,
    mainWorkspace: projectDir
  });

  assert.match(prompt, /todo-md-implementer/);
  assert.match(prompt, new RegExp(`${escapeRegex(resolve(ticketPath))}`));
  assert.match(prompt, /Use the shared task skill/);
  assert.match(prompt, /top-level Codex thread running in Worktree mode, not a subagent/);
  assert.match(prompt, /current working directory is the main workspace, stop before editing files/);
  assert.match(prompt, /Recommended create_thread thinking: xhigh/);
  assert.match(prompt, /Ticket size: XL/);
  assert.match(prompt, /\/plan-style implementation plan/);
});

test("coordinator instructions require create_thread and forbid subagent fallback", async () => {
  const instructions = await readFile(".codex/agents/todo-md-coordinator.toml", "utf8");

  assert.match(instructions, /create_thread/);
  assert.match(instructions, /environment\.type = "worktree"/);
  assert.match(instructions, /If the `create_thread` tool is unavailable, stop/);
  assert.match(instructions, /Never use subagents/);
});

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
