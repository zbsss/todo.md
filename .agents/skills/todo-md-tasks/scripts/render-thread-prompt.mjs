#!/usr/bin/env node
import { promises as fs } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  normalizeSize,
  reasoningEffortForSize,
  requiresPlanForSize,
  splitFrontmatter
} from "./select-ready-tickets.mjs";

export async function renderThreadPrompt(options) {
  const agentPath = path.resolve(options.agentPath ?? ".codex/agents/todo-md-implementer.toml");
  const mainWorkspace = path.resolve(options.mainWorkspace ?? process.cwd());
  const ticketPath = path.isAbsolute(options.ticketPath)
    ? options.ticketPath
    : path.resolve(mainWorkspace, options.ticketPath);
  const ticketMetadata = await readTicketMetadata(ticketPath);
  const size = normalizeSize(options.size) ?? ticketMetadata.size;
  const reasoningEffort = options.reasoningEffort ?? reasoningEffortForSize(size);
  const planningRequired = options.planningRequired ?? requiresPlanForSize(size);
  const agentToml = await fs.readFile(agentPath, "utf8");
  const name = readTomlString(agentToml, "name") ?? "todo-md-implementer";
  const description = readTomlString(agentToml, "description") ?? "";
  const instructions = readTomlString(agentToml, "developer_instructions");

  if (!instructions) {
    throw new Error(`Could not find developer_instructions in ${agentPath}`);
  }

  return [
    `You are starting a visible top-level Codex thread for the project agent role \`${name}\`.`,
    description ? `Role description: ${description}` : "",
    "",
    "This must be a top-level Codex thread running in Worktree mode, not a subagent or local-project delegation.",
    "If your current working directory is the main workspace, stop before editing files and report that the coordinator launched you incorrectly.",
    `Recommended create_thread thinking: ${reasoningEffort}`,
    size ? `Ticket size: ${size}` : "Ticket size: unspecified",
    planningRequired
      ? "This is a large ticket. Start with a /plan-style implementation plan before file edits, then implement from that plan unless the ticket is ambiguous."
      : "This ticket can proceed directly after the required ticket/worktree checks.",
    "",
    "Load and use the repo skill `$todo-md-tasks` from `.agents/skills/todo-md-tasks` before acting.",
    `Ticket file: ${ticketPath}`,
    `Main workspace: ${mainWorkspace}`,
    "",
    "Developer instructions from the role file:",
    instructions.trim(),
    "",
    "Begin by reading the ticket file fully, then follow the role instructions."
  ]
    .filter((line) => line !== "")
    .join("\n");
}

async function readTicketMetadata(ticketPath) {
  try {
    const contents = await fs.readFile(ticketPath, "utf8");
    const { frontmatter } = splitFrontmatter(contents);
    return {
      size: normalizeSize(frontmatter.size)
    };
  } catch (error) {
    if (error?.code === "ENOENT") {
      return {};
    }

    throw error;
  }
}

export function readTomlString(contents, key) {
  const multiline = new RegExp(`^${escapeRegex(key)}\\s*=\\s*"""\\n?([\\s\\S]*?)\\n?"""`, "m").exec(contents);

  if (multiline) {
    return multiline[1];
  }

  const singleLine = new RegExp(`^${escapeRegex(key)}\\s*=\\s*"([^"]*)"`, "m").exec(contents);
  return singleLine?.[1];
}

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function parseArgs(argv) {
  const options = {};

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];

    if (arg === "--agent") {
      options.agentPath = argv[++index];
    } else if (arg === "--ticket") {
      options.ticketPath = argv[++index];
    } else if (arg === "--main-workspace") {
      options.mainWorkspace = argv[++index];
    } else if (arg === "--size") {
      options.size = argv[++index];
    } else if (arg === "--reasoning-effort") {
      options.reasoningEffort = argv[++index];
    } else if (arg === "--plan-first") {
      options.planningRequired = true;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  if (!options.ticketPath) {
    throw new Error("--ticket is required.");
  }

  return options;
}

async function main() {
  process.stdout.write(`${await renderThreadPrompt(parseArgs(process.argv.slice(2)))}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
