# Search Feature Plan

## Goal

Add live project search for todo.md tasks without making the app heavier. Search should filter the board and table while the user types, highlight matching text, and be reusable by the future CLI and dependency/blocker picker.

## Research Summary

- Tickets are already parsed on the Rust side by `list_tickets_from_disk` in `src-tauri/src/tickets.rs`; each returned `Ticket` includes title, body, status, rank, timestamps, file path, priority, size, PR link, and assignee.
- The frontend keeps all loaded tickets in `state.tickets` and derives board/table views locally through `ticketsFor` and `tableTickets` in `src/main.ts`.
- Card previews currently render compact Markdown with `renderMarkdown(ticket.body, { compact: true })`. Search snippets need their own plain-text rendering path so highlights are safe and so matches deep in the body can appear below the title even when the normal compact preview would not show them.
- Backend search is the better primary home because the same command can serve the app, the mock API shape, and a future CLI. A frontend-only filter would be faster to bolt on, but it would duplicate search rules later.
- A persistent index is not justified yet. Projects are local folders of Markdown files and `listTickets` already reads the full project. A per-query in-memory scan keeps implementation small and should be fast enough for typical project sizes.

## Proposed Architecture

Implement a backend-first search API:

```rust
search_tickets(app, project_id, query) -> Vec<TicketSearchResult>
```

`TicketSearchResult` should contain:

- `ticket: Ticket`
- `score: i64`
- `matches: Vec<TicketSearchMatch>`

`TicketSearchMatch` should avoid byte offsets because the frontend slices JavaScript strings. Prefer pre-split text segments:

- `field: "title" | "body" | "status" | "priority" | "size" | "prLink" | "assignee" | "id" | "filePath" | "rank" | "createdAt" | "updatedAt"`
- `segments: Vec<TicketSearchSegment>` for short fields such as title and compact metadata
- `snippet_segments: Vec<TicketSearchSegment>` for body and long metadata fields
- `TicketSearchSegment { text: String, matched: bool }`

The frontend should escape each segment before rendering and wrap matched segments in `<mark>`. If ranges are ever needed instead of segments, they must be UTF-16 code-unit indexes so they can be used safely with JavaScript strings. Do not return Rust byte offsets to the UI.

Keep `list_tickets` unchanged. Search becomes an additional command used only when the query is non-empty. This avoids changing the existing board load path and keeps drag, edit, and sort behavior stable when no filter is active.

The browser mock store should expose the same `searchTickets(projectId, query)` method and can reuse a TypeScript search helper with the same visible behavior. Exact scoring does not need to be byte-identical to Rust, but filtering, field coverage, and highlighted segments should match test cases.

## Search Semantics

Normalize query and field text before matching:

- Lowercase.
- Collapse repeated whitespace.
- Trim punctuation at token edges.
- Keep the original field text for snippets and highlights.

Search these fields:

- Title.
- Markdown body as plain text.
- Status.
- Priority and size.
- PR link and assignee.
- Ticket id.
- File path.
- Rank.
- Created and updated timestamps, both raw milliseconds and a stable ISO-like date string.

The timestamp and rank fields are lower priority than human-authored content. They are included because they are task metadata, but they should not make common numeric queries swamp title/body matches.

Rust should build body search text with a small Markdown-to-text helper instead of reusing the TypeScript renderer:

- Normalize newlines first.
- Strip heading markers, list markers, blockquote markers, emphasis markers, and fenced-code delimiters while keeping the readable text.
- Keep inline-code contents without the backticks.
- Convert links to `label url` so either the visible label or URL can match.
- Convert images to `alt path` so pasted image references remain searchable without rendering images.
- Convert checkbox markers to `checked` or `unchecked` plus the list text.
- Collapse whitespace after conversion and retain a mapping from generated plain text to snippet text only at segment boundaries. If exact source offsets become complex, return generated plain-text snippets instead of trying to highlight inside original Markdown.

Ranking should stay simple:

- Exact title phrase match: highest.
- Title token match.
- Metadata token match.
- Body phrase match.
- Body token match.
- Fuzzy token match.
- Newer `updatedAt` as a weak tie-breaker.
- Existing board/table ordering as the final tie-breaker in the UI.

Typo tolerance should be intentionally narrow:

- Only apply fuzzy matching to query tokens with length >= 4.
- Allow edit distance 1 for tokens of length 4-7.
- Allow edit distance 2 for tokens of length >= 8.
- Use a bounded edit-distance function that exits once the threshold is exceeded.
- Do not add a fuzzy-search dependency unless this proves too slow or hard to maintain.

For multi-word queries, require every query token to match somewhere. Phrase matches improve score but should not be required.

## Frontend Behavior

Add a search control to the topbar next to the `Refresh` button:

- Use a compact input with a search icon and clear button.
- Debounce backend calls by about 120-180 ms.
- Track a monotonically increasing request id so stale search responses cannot overwrite newer results.
- Empty query clears search state and restores `state.tickets`.
- Show a small result count near the input, for example `7 matches`.

Rendering changes:

- Board columns should use filtered tickets when a query is active.
- Column counts should reflect the filtered count.
- Table view should use filtered tickets before applying table sort.
- Cards should highlight matching title text.
- If the match is in body or metadata, show a dedicated search snippet below the title with highlighted segments, even if the normal compact Markdown preview would not include that text.
- Table rows should highlight title matches and can expose the best snippet in the title cell below the title.
- Use escaped text segments for snippets. Do not inject raw Markdown or unsanitized HTML into highlights.

Interaction constraints:

- Disable all reordering while search is active. Reordering a filtered subset is ambiguous because hidden tickets affect neighboring ranks.
- This includes pointer drag/drop and keyboard `ArrowUp`/`ArrowDown` moves on cards.
- Keep card open/edit behavior available.
- Keep quick-add available; after creation, the new ticket appears only if it matches the current query.
- Refresh should preserve the current query and rerun search after tickets reload.

Mutation freshness:

- Treat backend search results as derived state from `state.tickets`.
- After create, save, delete, status changes, priority changes, or size changes, update `state.tickets` as today and then rerun the current search query.
- For delete, remove the ticket from visible results immediately and still rerun search so counts and snippets stay correct.
- Ignore stale rerun responses with the same request sequence guard used for live typing.
- Reordering does not need active-search reconciliation because reordering is disabled while search is active.

Empty states:

- No project: keep the existing empty project state.
- Empty query: keep the existing empty board/table state.
- Active query with no matches: show `No matches` in the board/table content area.

## Reuse for Dependencies and Blockers

The dependency/blocker picker should call the same `searchTickets` API and render a smaller result row:

- Title.
- Status chip.
- Priority/size chips when present.
- Best snippet.

It should pass an exclusion list on the frontend at first to hide the current ticket and already-linked tickets. If dependency search later needs backend-enforced exclusions, add an optional filter object then.

## Implementation Steps

1. Add Rust search models to `src-tauri/src/models.rs`.
2. Add a search module or helpers near `src-tauri/src/tickets.rs` that accept parsed `Ticket` values and return scored results.
3. Add `search_tickets` in `src-tauri/src/commands.rs` and register it in `src-tauri/src/main.rs`.
4. Extend `TodoApi` in `src/api/client.ts` with `searchTickets`.
5. Add mock-store search support in `src/api/mockStore.ts`.
6. Add frontend search state: query, pending flag, result map or result array, and request sequence.
7. Add the topbar search input and event binding in `src/main.ts`.
8. Update `ticketsFor` and `tableTickets` to use active search results.
9. Add snippet/highlight render helpers with tests.
10. Add Rust Markdown-to-plain-text helpers for body matching and snippets.
11. Disable drag and keyboard reorder handlers while search is active.
12. Rerun active search after ticket mutations.
13. Add CSS for the search input, result count, snippets, highlights, and empty match state.

## Regression Tests

Rust tests:

- Title, body, and metadata fields all match.
- Body snippets include text around a deep match.
- Fuzzy typo matching works within the configured threshold and rejects larger typos.
- Multi-token queries require all tokens.
- Result ordering prefers title matches over body matches.
- Markdown body text extraction handles links, images, checkboxes, code, headings, and lists.
- Returned match segments are Unicode-safe and do not split multi-byte characters.

Frontend/helper tests:

- Highlight renderer escapes HTML before adding mark elements.
- Board/table ticket selectors use filtered results when search is active.
- Search clear restores unfiltered ordering.
- Drag and keyboard reordering are unavailable while search is active.
- Active search reruns after create, save, delete, and metadata/status changes.

Manual checks:

- Type a title match and verify live filtering.
- Type a body-only phrase and verify the snippet appears below the title.
- Type a metadata value such as `P1`, `XL`, a PR number, or a Codex thread prefix.
- Clear search and verify all tickets and drag behavior return.
- Switch between board and table while search is active.

## Performance Guardrails

- Debounce input and ignore stale responses.
- Cap query length at 200 characters.
- Cap stored matches per ticket, for example 5 matches and 2 rendered snippets.
- Avoid reading files twice: `search_tickets` should call `list_tickets_from_disk` once and search the parsed tickets.
- Defer persistent indexing until there is measured latency on real projects.

## Acceptance Criteria

- Searching filters both board and table live.
- Matches are highlighted in titles and in body/metadata snippets.
- Search covers title, description/body, status, priority, size, PR link, assignee, id, file path, rank, and timestamps.
- Small typos still find likely tasks without broad false positives.
- Search is available through a backend command suitable for a future CLI.
- The app remains dependency-light and does not introduce a search index.
