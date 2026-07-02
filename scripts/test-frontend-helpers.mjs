import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";

const repoRoot = resolve(import.meta.dirname, "..");
const outDir = await mkdtemp(join(tmpdir(), "todo-md-frontend-helpers-"));

await writeFile(join(outDir, "package.json"), JSON.stringify({ type: "commonjs" }));

execFileSync(
  resolve(repoRoot, "node_modules/.bin/tsc"),
  [
    "--target",
    "ES2022",
    "--module",
    "CommonJS",
    "--moduleResolution",
    "Node",
    "--ignoreDeprecations",
    "6.0",
    "--ignoreConfig",
    "--rootDir",
    resolve(repoRoot, "src"),
    "--outDir",
    outDir,
    "--noEmit",
    "false",
    "--strict",
    "--skipLibCheck",
    resolve(repoRoot, "src/tickets/ordering.ts"),
    resolve(repoRoot, "src/markdown/render.ts"),
    resolve(repoRoot, "src/markdown/title.ts"),
    resolve(repoRoot, "src/markdown/images.ts")
  ],
  { stdio: "inherit" }
);

const ordering = await import(pathToFileURL(join(outDir, "tickets/ordering.js")).href);
const markdown = await import(pathToFileURL(join(outDir, "markdown/render.js")).href);
const title = await import(pathToFileURL(join(outDir, "markdown/title.js")).href);
const images = await import(pathToFileURL(join(outDir, "markdown/images.js")).href);

function ticket(overrides) {
  return {
    id: overrides.id,
    title: overrides.title ?? overrides.id,
    body: "",
    status: overrides.status ?? "todo",
    order: overrides.order ?? 1000,
    createdAt: 1,
    updatedAt: 1,
    filePath: `${overrides.id}.md`,
    ...overrides
  };
}

test("sortTickets orders by board column, order, then title", () => {
  const tickets = [
    ticket({ id: "done", status: "done", order: 1000 }),
    ticket({ id: "doing", status: "doing", order: 1000 }),
    ticket({ id: "todo-b", title: "B", status: "todo", order: 1000 }),
    ticket({ id: "todo-a", title: "A", status: "todo", order: 1000 })
  ];

  assert.deepEqual(tickets.sort(ordering.sortTickets).map((item) => item.id), [
    "todo-a",
    "todo-b",
    "doing",
    "done"
  ]);
});

test("insertTicket inserts before the requested ticket in the target status", () => {
  const existing = [
    ticket({ id: "done", status: "done", order: 1000 }),
    ticket({ id: "todo-b", status: "todo", order: 2000 }),
    ticket({ id: "todo-a", status: "todo", order: 1000 })
  ];
  const inserted = ordering.insertTicket(existing, ticket({ id: "todo-new", status: "todo" }), "todo", "todo-b");

  assert.deepEqual(inserted.map((item) => item.id), ["todo-a", "todo-new", "todo-b", "done"]);
});

test("renumberTickets assigns stable 1000-spaced orders within each status", () => {
  const tickets = [
    ticket({ id: "todo-a", status: "todo", order: 500 }),
    ticket({ id: "todo-b", status: "todo", order: 9000 }),
    ticket({ id: "doing-a", status: "doing", order: 100 })
  ];

  assert.deepEqual(ordering.renumberTickets(tickets), [
    { id: "todo-a", status: "todo", order: 1000 },
    { id: "todo-b", status: "todo", order: 2000 },
    { id: "doing-a", status: "doing", order: 1000 }
  ]);
  assert.deepEqual(tickets.map((item) => item.order), [1000, 2000, 1000]);
});

test("renderMarkdown escapes HTML and protects inline code from markdown formatting", () => {
  const html = markdown.renderMarkdown('Hello <script>alert("x")</script> and `*literal*`');

  assert.equal(
    html,
    '<p>Hello &lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt; and <code>*literal*</code></p>'
  );
});

test("renderMarkdown supports headings, lists, checkboxes, and compact previews", () => {
  assert.equal(
    markdown.renderMarkdown("# Plan\n\n- **Ship** it\n- [x] done"),
    '<h3>Plan</h3><ul><li><strong>Ship</strong> it</li><li><input type="checkbox" checked disabled /> done</li></ul>'
  );

  assert.equal(markdown.renderMarkdown("First\n\nSecond\n\nThird", { compact: true }), "<p>First</p><p>Second</p>");
});

test("renderMarkdown resolves and skips task images according to options", () => {
  assert.equal(
    markdown.renderMarkdown("![Screenshot](images/one.png)", { projectPath: "/project" }),
    '<p><img src="images/one.png" alt="Screenshot" loading="lazy" /></p>'
  );
  assert.equal(
    markdown.renderMarkdown("Before ![Screenshot](images/one.png) after", {
      projectPath: "/project",
      skipImages: true
    }),
    "<p>Before  after</p>"
  );
  assert.equal(
    markdown.renderMarkdown("![Screenshot](images/one.png)", {
      projectPath: "/project",
      fileSrcConverter: (path) => `asset://${path}`
    }),
    '<p><img src="asset:///project/.tasks/images/one.png" alt="Screenshot" loading="lazy" /></p>'
  );
});

test("parseTicketTitle recognizes bracket and colon tags", () => {
  assert.deepEqual(title.parseTicketTitle(" [Bug Fix]  Escape HTML "), {
    tag: "Bug Fix",
    text: "Escape HTML"
  });
  assert.deepEqual(title.parseTicketTitle("Feature/UI: Polish cards"), {
    tag: "Feature/UI",
    text: "Polish cards"
  });
  assert.equal(title.parseTicketTitle("No tag here"), null);
});

test("renderTicketTitle escapes tag and text content", () => {
  assert.match(
    title.renderTicketTitle("[Bug] Fix <script>"),
    /<span class="ticket-title-chip ticket-title-chip-\d">Bug<\/span><span class="ticket-title-text">Fix &lt;script&gt;<\/span>/
  );
  assert.equal(title.titleDisplayValue("  "), "Untitled ticket");
});

test("image helpers normalize task image paths and reject path traversal", () => {
  assert.equal(images.normalizeTaskImagePath(".tasks/images/a.png"), "images/a.png");
  assert.equal(images.normalizeTaskImagePath("images/nested/a.png"), "images/nested/a.png");
  assert.equal(images.normalizeTaskImagePath("images/../a.png"), null);
  assert.equal(images.resolveMarkdownImageSrc("https://example.com/a.png"), "https://example.com/a.png");
  assert.equal(images.resolveMarkdownImageSrc("images/a.png"), null);
  assert.equal(images.resolveMarkdownImageSrc("images/a.png", "C:\\Project", (path) => path), "C:\\Project\\.tasks\\images\\a.png");
  assert.equal(images.imageExtensionForMime("image/jpeg; charset=binary"), "jpg");
  assert.equal(images.imageExtensionForMime("application/pdf"), null);
});
