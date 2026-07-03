import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";

const repoRoot = resolve(import.meta.dirname, "..");
const outDir = await mkdtemp(join(tmpdir(), "todo-md-task-selector-close-"));

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
    resolve(repoRoot, "src/taskSelectorClose.ts")
  ],
  { stdio: "inherit" }
);

const { findTaskSelectorFromTarget } = await import(pathToFileURL(join(outDir, "taskSelectorClose.js")).href);

test("finds a task selector from an element target inside the selector", () => {
  const selector = {};
  const option = {
    closest(query) {
      return query === "[data-task-selector]" ? selector : null;
    }
  };

  assert.equal(findTaskSelectorFromTarget(option), selector);
});

test("finds a task selector from a text-node target inside the selector", () => {
  const selector = {};
  const textNode = {
    parentElement: {
      closest(query) {
        return query === "[data-task-selector]" ? selector : null;
      }
    }
  };

  assert.equal(findTaskSelectorFromTarget(textNode), selector);
});

test("returns null for targets outside task selectors", () => {
  const outside = {
    closest() {
      return null;
    }
  };

  assert.equal(findTaskSelectorFromTarget(outside), null);
  assert.equal(findTaskSelectorFromTarget(null), null);
});
