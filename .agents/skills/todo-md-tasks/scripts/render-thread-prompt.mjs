#!/usr/bin/env node
import { promises as fs } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

export async function renderThreadPrompt(options) {
  const agentPath = path.resolve(options.agentPath ?? ".codex/agents/todo-md-implementer.toml");
  const mainWorkspace = path.resolve(options.mainWorkspace ?? process.cwd());
  const ticketPath = path.isAbsolute(options.ticketPath)
    ? options.ticketPath
    : path.resolve(mainWorkspace, options.ticketPath);
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
