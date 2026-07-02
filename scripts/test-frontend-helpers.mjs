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
    resolve(repoRoot, "src/tickets/table.ts"),
    resolve(repoRoot, "src/markdown/render.ts"),
    resolve(repoRoot, "src/markdown/title.ts"),
    resolve(repoRoot, "src/markdown/images.ts")
  ],
  { stdio: "inherit" }
);

const ordering = await import(pathToFileURL(join(outDir, "tickets/ordering.js")).href);
const table = await import(pathToFileURL(join(outDir, "tickets/table.js")).href);
const markdown = await import(pathToFileURL(join(outDir, "markdown/render.js")).href);
const title = await import(pathToFileURL(join(outDir, "markdown/title.js")).href);
const images = await import(pathToFileURL(join(outDir, "markdown/images.js")).href);

function ticket(overrides) {
  return {
    id: overrides.id,
    title: overrides.title ?? overrides.id,
    body: "",
    status: overrides.status ?? "todo",
    rank: overrides.rank ?? "V",
    createdAt: 1,
    updatedAt: 1,
    filePath: `${overrides.id}.md`,
    ...overrides
  };
}

test("sortTickets orders by board column, rank, then title", () => {
  const tickets = [
    ticket({ id: "done", status: "done", rank: "V" }),
    ticket({ id: "doing", status: "doing", rank: "V" }),
    ticket({ id: "todo-c", status: "todo", rank: "l" }),
    ticket({ id: "todo-b", title: "B", status: "todo", rank: "V" }),
    ticket({ id: "todo-a", title: "A", status: "todo", rank: "V" })
  ];

  assert.deepEqual(tickets.sort(ordering.sortTickets).map((item) => item.id), [
    "todo-a",
    "todo-b",
    "todo-c",
    "doing",
    "done"
  ]);
});

test("insertTicket inserts before the requested ticket in the target status", () => {
  const existing = [
    ticket({ id: "done", status: "done", rank: "V" }),
    ticket({ id: "todo-b", status: "todo", rank: "l" }),
    ticket({ id: "todo-a", status: "todo", rank: "V" })
  ];
  const inserted = ordering.insertTicket(existing, ticket({ id: "todo-new", status: "todo" }), "todo", "todo-b");

  assert.deepEqual(inserted.map((item) => item.id), ["todo-a", "todo-new", "todo-b", "done"]);
});

test("rankBetween creates sortable ranks between neighbors", () => {
  const middle = ordering.rankBetween("V", "l");
  const crowded = ordering.rankBetween("V", "VV");

  assert.equal(ordering.isValidRank(middle), true);
  assert.equal(ordering.isValidRank(crowded), true);
  assert.equal("V" < middle && middle < "l", true);
  assert.equal("V" < crowded && crowded < "VV", true);
});

test("rankForInsertion reuses the current rank when placement is unchanged", () => {
  const tickets = [
    ticket({ id: "todo-a", rank: "V" }),
    ticket({ id: "todo-b", rank: "l" }),
    ticket({ id: "todo-c", rank: "t" })
  ];

  assert.equal(ordering.rankForInsertion(tickets, "todo-b", "todo"), "l");
});

test("rankForInsertion creates a rank for the moved ticket without changing neighbors", () => {
  const tickets = [
    ticket({ id: "todo-a", rank: "V" }),
    ticket({ id: "todo-new", rank: "z" }),
    ticket({ id: "todo-b", rank: "l" })
  ];
  const rank = ordering.rankForInsertion(tickets, "todo-new", "todo");

  assert.equal("V" < rank && rank < "l", true);
  assert.deepEqual(tickets.map((item) => item.rank), ["V", "z", "l"]);
});

test("rankFromLegacyOrder preserves numeric order lexicographically", () => {
  const ranks = [10000, 1000, -5, 0].map((order) => ordering.rankFromLegacyOrder(order));

  assert.deepEqual([...ranks].sort(), [ranks[2], ranks[3], ranks[1], ranks[0]]);
});

test("rankFromLegacyOrder creates stable tie-breakers for duplicate orders", () => {
  const first = ordering.rankFromLegacyOrder(1000, "A first", "/tasks/first.md");
  const second = ordering.rankFromLegacyOrder(1000, "B second", "/tasks/second.md");
  const missingOrder = ordering.rankFromLegacyOrder(0, "No order", "/tasks/no-order.md");

  assert.equal(first < second, true);
  assert.equal(missingOrder < first, true);
});

test("sortTicketsForTable defaults to status then priority", () => {
  const tickets = [
    ticket({ id: "done-p0", status: "done", priority: "P0" }),
    ticket({ id: "todo-p3", status: "todo", priority: "P3" }),
    ticket({ id: "todo-none", status: "todo" }),
    ticket({ id: "todo-p0", status: "todo", priority: "P0" }),
    ticket({ id: "doing-p1", status: "doing", priority: "P1" })
  ];

  assert.deepEqual(table.sortTicketsForTable(tickets, null).map((item) => item.id), [
    "todo-p0",
    "todo-p3",
    "todo-none",
    "doing-p1",
    "done-p0"
  ]);
});

test("sortTicketsForTable sorts by an explicit table column", () => {
  const tickets = [
    ticket({ id: "small", size: "S" }),
    ticket({ id: "xl", size: "XL" }),
    ticket({ id: "medium", size: "M" })
  ];

  assert.deepEqual(
    table.sortTicketsForTable(tickets, { column: "size", direction: "desc" }).map((item) => item.id),
    ["xl", "medium", "small"]
  );
});

test("filterTicketsForTable matches column values and labels", () => {
  const tickets = [
    ticket({ id: "with-pr", status: "todo", prLink: "https://github.com/zbsss/todo.md/pull/178" }),
    ticket({ id: "doing-task", status: "doing", assignee: "codex://threads/019f239d-dd6d-7451-856c-3847cadaf912" }),
    ticket({ id: "done-task", status: "done" })
  ];

  assert.deepEqual(
    table.filterTicketsForTable(tickets, { status: "doing", assignee: "019f239d" }).map((item) => item.id),
    ["doing-task"]
  );
  assert.deepEqual(table.filterTicketsForTable(tickets, { pr: "#178" }).map((item) => item.id), ["with-pr"]);
  assert.deepEqual(table.filterTicketsForTable(tickets, { assignee: "empty", pr: "empty" }).map((item) => item.id), [
    "done-task"
  ]);
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
