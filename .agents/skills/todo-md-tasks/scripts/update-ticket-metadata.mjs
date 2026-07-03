#!/usr/bin/env node
import { promises as fs } from "node:fs";
import { pathToFileURL } from "node:url";

const statuses = ["draft", "ready", "doing", "review", "done"];

export async function updateTicketMetadata(ticketPath, updates, options = {}) {
  if (!ticketPath) {
    throw new Error("Ticket path is required.");
  }

  const contents = await fs.readFile(ticketPath, "utf8");
  const next = updateTicketMetadataText(contents, updates, options);

  if (next !== contents) {
    await fs.writeFile(ticketPath, next);
  }

  return next;
}

export function updateTicketMetadataText(contents, updates, options = {}) {
  const { frontmatter, body, newline } = splitFrontmatter(contents);
  let lines = frontmatter.length ? frontmatter : [];
  const normalizedUpdates = normalizeUpdates(updates);

  for (const [key, value] of Object.entries(normalizedUpdates)) {
    lines = setField(lines, key, value);
  }

  if (options.touch !== false) {
    lines = setField(lines, "updated_at", String(Date.now()));
  }

  return `---${newline}${lines.join(newline)}${newline}---${newline}${body}`;
}

function splitFrontmatter(contents) {
  const match = /^(---)(\r?\n)([\s\S]*?)(\r?\n)---(\r?\n)/.exec(contents);

  if (!match) {
    return { frontmatter: [], body: `\n${contents}`, newline: "\n" };
  }

  return {
    frontmatter: match[3].split(/\r?\n/),
    body: contents.slice(match[0].length),
    newline: match[2]
  };
}

function normalizeUpdates(updates) {
  const normalized = {};

  if (updates.status !== undefined) {
    normalized.status = normalizeStatus(updates.status);
  }

  if (updates.assignee !== undefined) {
    normalized.assignee = cleanOptionalValue(updates.assignee);
  }

  if (updates.prLink !== undefined) {
    normalized.pr_link = cleanOptionalValue(updates.prLink);
  }

  return normalized;
}

function normalizeStatus(status) {
  const normalized = status === "todo" ? "draft" : status;

  if (!statuses.includes(normalized)) {
    throw new Error(`Invalid ticket status: ${status}`);
  }

  return normalized;
}

function cleanOptionalValue(value) {
  const cleaned = value?.trim();
  return cleaned ? cleaned : null;
}

function setField(lines, key, value) {
  let replaced = false;
  const next = [];

  for (const line of lines) {
    const parsed = parseField(line);

    if (parsed?.key !== key) {
      next.push(line);
      continue;
    }

    if (replaced || value === null) {
      continue;
    }

    next.push(`${key}: ${value}`);
    replaced = true;
  }

  if (!replaced && value !== null) {
    next.push(`${key}: ${value}`);
  }

  return next;
}

function parseField(line) {
  const separator = line.indexOf(":");

  if (separator === -1) {
    return null;
  }

  return { key: line.slice(0, separator).trim(), value: line.slice(separator + 1).trim() };
}

function parseArgs(argv) {
  const [ticketPath, ...rest] = argv;
  const updates = {};
  const options = {};

  for (let index = 0; index < rest.length; index += 1) {
    const arg = rest[index];

    if (arg === "--status") {
      updates.status = rest[++index];
    } else if (arg === "--assignee") {
      updates.assignee = rest[++index] ?? "";
    } else if (arg === "--pr-link") {
      updates.prLink = rest[++index] ?? "";
    } else if (arg === "--clear-assignee") {
      updates.assignee = "";
    } else if (arg === "--clear-pr-link") {
      updates.prLink = "";
    } else if (arg === "--no-touch") {
      options.touch = false;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  return { ticketPath, updates, options };
}

async function main() {
  const { ticketPath, updates, options } = parseArgs(process.argv.slice(2));
  await updateTicketMetadata(ticketPath, updates, options);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
