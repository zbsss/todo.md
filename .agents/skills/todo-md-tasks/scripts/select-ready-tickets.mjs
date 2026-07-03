#!/usr/bin/env node
import { promises as fs } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

export const statuses = ["draft", "ready", "doing", "review", "done"];
const priorityOrder = ["P0", "P1", "P2", "P3", "P4"];

export function normalizeStatus(value) {
  if (value === "todo") {
    return "draft";
  }

  return statuses.includes(value) ? value : "draft";
}

export function splitFrontmatter(contents) {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n/.exec(contents);

  if (!match) {
    return { frontmatter: {}, body: contents };
  }

  const frontmatter = {};
  for (const line of match[1].split(/\r?\n/)) {
    const separator = line.indexOf(":");
    if (separator === -1) {
      continue;
    }

    frontmatter[line.slice(0, separator).trim()] = line.slice(separator + 1).trim();
  }

  return { frontmatter, body: contents.slice(match[0].length) };
}

export async function readTickets(projectDir = process.cwd()) {
  const tasksDir = path.join(projectDir, ".tasks");
  let entries;

  try {
    entries = await fs.readdir(tasksDir, { withFileTypes: true });
  } catch (error) {
    if (error?.code === "ENOENT") {
      return [];
    }

    throw error;
  }

  const tickets = [];
  for (const entry of entries) {
    if (!entry.isFile() || path.extname(entry.name) !== ".md") {
      continue;
    }

    const filePath = path.join(tasksDir, entry.name);
    const contents = await fs.readFile(filePath, "utf8");
    const { frontmatter } = splitFrontmatter(contents);
    const id = frontmatter.id || path.basename(entry.name, ".md");
    const title = frontmatter.title || id;
    const priority = normalizePriority(frontmatter.priority);

    tickets.push({
      id,
      title,
      status: normalizeStatus(frontmatter.status),
      rank: frontmatter.rank || "",
      priority,
      assignee: metadataValue(frontmatter, ["assignee", "codex_thread", "codex_link"]),
      prLink: metadataValue(frontmatter, ["pr_link", "pr_url", "pull_request"]),
      filePath: path.resolve(filePath)
    });
  }

  return tickets;
}

export async function selectReadyTickets(options = {}) {
  const projectDir = path.resolve(options.projectDir ?? process.cwd());
  const maxDoing = options.maxDoing ?? 3;
  const tickets = await readTickets(projectDir);
  const doingCount = tickets.filter((ticket) => ticket.status === "doing").length;
  const slots = Math.max(0, maxDoing - doingCount);
  const eligible = tickets
    .filter((ticket) => ticket.status === "ready" && !ticket.assignee && !ticket.prLink)
    .sort(compareTickets);

  return {
    projectDir,
    tasksDir: path.join(projectDir, ".tasks"),
    maxDoing,
    doingCount,
    slots,
    readyCount: eligible.length,
    selected: eligible.slice(0, slots)
  };
}

function compareTickets(a, b) {
  return (
    priorityRank(a.priority) - priorityRank(b.priority) ||
    compareStrings(a.rank, b.rank) ||
    compareStrings(a.title, b.title) ||
    compareStrings(a.id, b.id)
  );
}

function priorityRank(priority) {
  const index = priority ? priorityOrder.indexOf(priority) : -1;
  return index >= 0 ? index : priorityOrder.length;
}

function compareStrings(a, b) {
  return a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" });
}

function normalizePriority(value) {
  const normalized = value?.trim().toUpperCase();
  return priorityOrder.includes(normalized) ? normalized : undefined;
}

function metadataValue(frontmatter, keys) {
  for (const key of keys) {
    const value = frontmatter[key]?.trim();
    if (value) {
      return value;
    }
  }

  return undefined;
}

function parseArgs(argv) {
  const options = { projectDir: process.cwd(), maxDoing: 3 };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];

    if (arg === "--project-dir") {
      options.projectDir = argv[++index];
    } else if (arg === "--max-doing") {
      options.maxDoing = Number.parseInt(argv[++index], 10);
    } else if (!arg.startsWith("--")) {
      options.projectDir = arg;
    }
  }

  if (!Number.isInteger(options.maxDoing) || options.maxDoing < 0) {
    throw new Error("--max-doing must be a non-negative integer.");
  }

  return options;
}

async function main() {
  const result = await selectReadyTickets(parseArgs(process.argv.slice(2)));
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
