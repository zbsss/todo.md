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
    resolve(repoRoot, "src/tickets/paths.ts"),
    resolve(repoRoot, "src/tickets/table.ts"),
    resolve(repoRoot, "src/api/mockStore.ts"),
    resolve(repoRoot, "src/markdown/escape.ts"),
    resolve(repoRoot, "src/markdown/render.ts"),
    resolve(repoRoot, "src/markdown/title.ts"),
    resolve(repoRoot, "src/markdown/images.ts"),
    resolve(repoRoot, "src/tickets/quickAdd.ts"),
    resolve(repoRoot, "src/projects/ordering.ts"),
    resolve(repoRoot, "src/quickAddTextarea.ts"),
    resolve(repoRoot, "src/settings/appearance.ts")
  ],
  { stdio: "inherit" }
);

const ordering = await import(pathToFileURL(join(outDir, "tickets/ordering.js")).href);
const paths = await import(pathToFileURL(join(outDir, "tickets/paths.js")).href);
const table = await import(pathToFileURL(join(outDir, "tickets/table.js")).href);
const search = await import(pathToFileURL(join(outDir, "api/mockStore.js")).href);
const markdown = await import(pathToFileURL(join(outDir, "markdown/render.js")).href);
const title = await import(pathToFileURL(join(outDir, "markdown/title.js")).href);
const images = await import(pathToFileURL(join(outDir, "markdown/images.js")).href);
const quickAdd = await import(pathToFileURL(join(outDir, "tickets/quickAdd.js")).href);
const projectOrdering = await import(pathToFileURL(join(outDir, "projects/ordering.js")).href);
const quickAddTextarea = await import(pathToFileURL(join(outDir, "quickAddTextarea.js")).href);
const appearance = await import(pathToFileURL(join(outDir, "settings/appearance.js")).href);

function ticket(overrides) {
  return {
    id: overrides.id,
    title: overrides.title ?? overrides.id,
    body: "",
    status: overrides.status ?? "draft",
    rank: overrides.rank ?? "V",
    createdAt: 1,
    updatedAt: 1,
    filePath: `${overrides.id}.md`,
    ...overrides
  };
}

function project(id) {
  return {
    id,
    name: id,
    path: `/projects/${id}`,
    ticketCount: 0
  };
}

test("sortTickets orders by board column, rank, then title", () => {
  const tickets = [
    ticket({ id: "done", status: "done", rank: "V" }),
    ticket({ id: "review", status: "review", rank: "V" }),
    ticket({ id: "doing", status: "doing", rank: "V" }),
    ticket({ id: "ready", status: "ready", rank: "V" }),
    ticket({ id: "draft-c", status: "draft", rank: "l" }),
    ticket({ id: "draft-b", title: "B", status: "draft", rank: "V" }),
    ticket({ id: "draft-a", title: "A", status: "draft", rank: "V" })
  ];

  assert.deepEqual(tickets.sort(ordering.sortTickets).map((item) => item.id), [
    "draft-a",
    "draft-b",
    "draft-c",
    "ready",
    "doing",
    "review",
    "done"
  ]);
});

test("insertTicket inserts before the requested ticket in the target status", () => {
  const existing = [
    ticket({ id: "done", status: "done", rank: "V" }),
    ticket({ id: "draft-b", status: "draft", rank: "l" }),
    ticket({ id: "draft-a", status: "draft", rank: "V" })
  ];
  const inserted = ordering.insertTicket(existing, ticket({ id: "draft-new", status: "draft" }), "draft", "draft-b");

  assert.deepEqual(inserted.map((item) => item.id), ["draft-a", "draft-new", "draft-b", "done"]);
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
    ticket({ id: "draft-a", rank: "V" }),
    ticket({ id: "draft-b", rank: "l" }),
    ticket({ id: "draft-c", rank: "t" })
  ];

  assert.equal(ordering.rankForInsertion(tickets, "draft-b", "draft"), "l");
});

test("rankForInsertion creates a rank for the moved ticket without changing neighbors", () => {
  const tickets = [
    ticket({ id: "draft-a", rank: "V" }),
    ticket({ id: "draft-new", rank: "z" }),
    ticket({ id: "draft-b", rank: "l" })
  ];
  const rank = ordering.rankForInsertion(tickets, "draft-new", "draft");

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
    ticket({ id: "draft-p3", status: "draft", priority: "P3" }),
    ticket({ id: "draft-none", status: "draft" }),
    ticket({ id: "draft-p0", status: "draft", priority: "P0" }),
    ticket({ id: "ready-p2", status: "ready", priority: "P2" }),
    ticket({ id: "doing-p1", status: "doing", priority: "P1" })
  ];

  assert.deepEqual(table.sortTicketsForTable(tickets, null).map((item) => item.id), [
    "draft-p0",
    "draft-p3",
    "draft-none",
    "ready-p2",
    "doing-p1",
    "done-p0"
  ]);
});

test("normalizeStatus maps legacy todo to draft", () => {
  assert.equal(ordering.normalizeStatus("todo"), "draft");
  assert.equal(ordering.normalizeStatus("ready"), "ready");
  assert.equal(ordering.normalizeStatus("missing"), "draft");
});

test("reorderProjectsForInsertion moves a project before a target", () => {
  const projects = ["one", "two", "three"].map(project);

  assert.deepEqual(
    projectOrdering.reorderProjectsForInsertion(projects, "three", "one", "before").map((item) => item.id),
    ["three", "one", "two"]
  );
});

test("reorderProjectsForInsertion moves a project after a target", () => {
  const projects = ["one", "two", "three"].map(project);

  assert.deepEqual(
    projectOrdering.reorderProjectsForInsertion(projects, "one", "two", "after").map((item) => item.id),
    ["two", "one", "three"]
  );
});

test("reorderProjectsForInsertion appends a project at the end", () => {
  const projects = ["one", "two", "three"].map(project);

  assert.deepEqual(
    projectOrdering.reorderProjectsForInsertion(projects, "one").map((item) => item.id),
    ["two", "three", "one"]
  );
});

test("reorderProjectsForInsertion reuses the current order when placement is unchanged", () => {
  const projects = ["one", "two", "three"].map(project);

  assert.equal(projectOrdering.reorderProjectsForInsertion(projects, "two", "three", "before"), projects);
});

test("ticketPathRelativeToProject returns a project-relative ticket path", () => {
  assert.equal(
    paths.ticketPathRelativeToProject("/Users/example/project/.tasks/ticket.md", "/Users/example/project"),
    ".tasks/ticket.md"
  );
  assert.equal(
    paths.ticketPathRelativeToProject("C:\\Users\\example\\project\\.tasks\\ticket.md", "C:\\Users\\example\\project"),
    ".tasks\\ticket.md"
  );
  assert.equal(
    paths.ticketPathRelativeToProject("C:\\Users\\Example\\Project\\.tasks\\ticket.md", "c:\\users\\example\\project"),
    ".tasks/ticket.md"
  );
  assert.equal(
    paths.ticketPathRelativeToProject("/Users/example/other/.tasks/ticket.md", "/Users/example/project"),
    "/Users/example/other/.tasks/ticket.md"
  );
});

test("canQuickAddTicket only allows the draft column", () => {
  assert.equal(quickAdd.canQuickAddTicket("draft"), true);
  assert.equal(quickAdd.canQuickAddTicket("ready"), false);
  assert.equal(quickAdd.canQuickAddTicket("doing"), false);
  assert.equal(quickAdd.canQuickAddTicket("review"), false);
  assert.equal(quickAdd.canQuickAddTicket("done"), false);
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

test("parseAppearanceSettings falls back to defaults for invalid stored settings", () => {
  assert.deepEqual(appearance.parseAppearanceSettings(null), appearance.defaultAppearanceSettings);
  assert.deepEqual(appearance.parseAppearanceSettings("{broken"), appearance.defaultAppearanceSettings);
  assert.deepEqual(
    appearance.parseAppearanceSettings(
      JSON.stringify({
        colorScheme: "unknown",
        fontFamily: "display",
        fontSize: "large"
      })
    ),
    appearance.defaultAppearanceSettings
  );
});

test("normalizeAppearanceSettings preserves supported appearance settings", () => {
  assert.deepEqual(
    appearance.normalizeAppearanceSettings({
      colorScheme: "dark",
      fontFamily: "mono",
      fontSize: 17
    }),
    {
      colorScheme: "dark",
      fontFamily: "mono",
      fontSize: 17
    }
  );
});

test("normalizeAppearanceSettings clamps font size", () => {
  assert.equal(appearance.normalizeAppearanceSettings({ fontSize: 2 }).fontSize, appearance.minFontSize);
  assert.equal(appearance.normalizeAppearanceSettings({ fontSize: 99 }).fontSize, appearance.maxFontSize);
  assert.equal(appearance.normalizeAppearanceSettings({ fontSize: "17.4" }).fontSize, 17);
});

test("serializeAppearanceSettings stores normalized values", () => {
  assert.equal(
    appearance.serializeAppearanceSettings({
      colorScheme: "gruvbox",
      fontFamily: "serif",
      fontSize: 200
    }),
    JSON.stringify({
      colorScheme: "gruvbox",
      fontFamily: "serif",
      fontSize: appearance.maxFontSize
    })
  );
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

test("quick-add textarea expands to its content height", () => {
  const textarea = {
    scrollHeight: 92,
    style: { height: "38px" }
  };

  quickAddTextarea.resizeAutosizeTextarea(textarea);

  assert.equal(textarea.style.height, "92px");
});

test("renderTicketSearchSegments escapes text before marking matches", () => {
  assert.equal(
    search.renderTicketSearchSegments([
      { text: "<img src=x onerror=alert(1)> ", matched: false },
      { text: "& match", matched: true }
    ]),
    "&lt;img src=x onerror=alert(1)&gt; <mark>&amp; match</mark>"
  );
});

test("filterTicketsBySearchResults applies active search and restores unfiltered order", () => {
  const tickets = [
    ticket({ id: "first" }),
    ticket({ id: "second" }),
    ticket({ id: "third" })
  ];
  const results = [{ ticket: tickets[1], score: 10, matches: [] }];

  assert.deepEqual(search.filterTicketsBySearchResults(tickets, results, true).map((item) => item.id), ["second"]);
  assert.deepEqual(search.filterTicketsBySearchResults(tickets, results, false).map((item) => item.id), [
    "first",
    "second",
    "third"
  ]);
});

test("filterTicketsBySearchResults shows no stale tickets after active search results clear", () => {
  const tickets = [ticket({ id: "stale" })];

  assert.deepEqual(search.filterTicketsBySearchResults(tickets, [], true), []);
});

test("active search disables reorder and marks mutations for rerun", () => {
  assert.equal(search.shouldDisableSearchReorder("ready work"), true);
  assert.equal(search.shouldDisableSearchReorder("   "), false);
  assert.equal(search.shouldRerunTicketSearchAfterMutation("P1"), true);
  assert.equal(search.shouldRerunTicketSearchAfterMutation(""), false);
});

test("mock search returns body snippets with escaped highlighted segments", () => {
  const result = search.searchTicketsForMock(
    [
      ticket({
        id: "body-match",
        title: "Body match",
        body: "Before <script> alert </script> after"
      }),
      ticket({
        id: "other",
        title: "Other",
        body: "No matching text"
      })
    ],
    "script"
  );

  assert.equal(result.length, 1);
  assert.equal(result[0].ticket.id, "body-match");

  const bodyMatch = result[0].matches.find((match) => match.field === "body");
  assert.ok(bodyMatch);
  assert.equal(
    search.renderTicketSearchSegments(bodyMatch.snippetSegments),
    "Before &lt;<mark>script</mark>&gt; alert &lt;/<mark>script</mark>&gt; after"
  );
});
