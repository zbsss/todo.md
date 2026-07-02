import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";

const repoRoot = resolve(import.meta.dirname, "..");
const outDir = join(tmpdir(), `todo-md-editor-backdrop-close-${process.pid}`);

await rm(outDir, { recursive: true, force: true });
await mkdir(outDir, { recursive: true });

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
    resolve(repoRoot, "src/editorBackdropClose.ts")
  ],
  { stdio: "inherit" }
);

const {
  createBackdropDismissState,
  recordBackdropPointerDown,
  shouldDismissEditorOnBackdropPointerUp
} = await import(pathToFileURL(join(outDir, "editorBackdropClose.js")).href);

test("dismisses the editor when the pointer starts and ends on the backdrop", () => {
  const state = createBackdropDismissState();
  const backdrop = new EventTarget();

  recordBackdropPointerDown(state, backdrop, backdrop);

  assert.equal(shouldDismissEditorOnBackdropPointerUp(state, backdrop, backdrop), true);
});

test("keeps the editor open when title selection is released over the backdrop", () => {
  const state = createBackdropDismissState();
  const backdrop = new EventTarget();
  const titleInput = new EventTarget();

  recordBackdropPointerDown(state, titleInput, backdrop);

  assert.equal(shouldDismissEditorOnBackdropPointerUp(state, backdrop, backdrop), false);
});

test("resets the backdrop dismiss guard after a non-dismissed pointer sequence", () => {
  const state = createBackdropDismissState();
  const backdrop = new EventTarget();
  const titleInput = new EventTarget();

  recordBackdropPointerDown(state, titleInput, backdrop);
  shouldDismissEditorOnBackdropPointerUp(state, backdrop, backdrop);

  assert.equal(state.pointerStartedOnBackdrop, false);
});
