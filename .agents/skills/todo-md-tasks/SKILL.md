---
name: todo-md-tasks
description: Work with todo.md `.tasks` ticket files and Codex agent coordination metadata. Use when assigning tickets to Codex threads, selecting Ready tickets for automation, updating ticket frontmatter status/assignee/pr_link, or implementing work from a todo.md ticket.
---

# todo.md Tasks

Use this skill whenever a Codex thread coordinates or implements work from local todo.md ticket files.

## Ticket Workflow

- Treat `.tasks/*.md` as the source of truth for project tickets.
- Read the full ticket file before implementing or assigning work.
- Use these statuses only: `draft`, `ready`, `doing`, `review`, `done`.
- Treat legacy `todo` frontmatter as `draft`.
- Pick work only from `ready`.
- Count only `doing` against the coordinator's max active implementation slots.
- Move a ticket to `review` only after a PR exists and is ready for human review.
- Do not merge PRs unless the user explicitly asks.

## Worktree Rules

- Run `git worktree list` before changing ticket metadata.
- Identify the main workspace for the current project from the `main` worktree line.
- Update ticket metadata in the main workspace, not in an implementation worktree.
- Implement code and run tests in the assigned Codex worktree.
- Preserve ticket Markdown bodies and unrelated frontmatter fields when updating metadata.

## Metadata Updates

Use `scripts/update-ticket-metadata.mjs` for deterministic frontmatter edits:

```bash
node .agents/skills/todo-md-tasks/scripts/update-ticket-metadata.mjs .tasks/example.md --status doing --assignee codex://threads/<thread-id>
node .agents/skills/todo-md-tasks/scripts/update-ticket-metadata.mjs .tasks/example.md --status review --pr-link https://github.com/owner/repo/pull/123
```

The script updates canonical `status`, `assignee`, and `pr_link` keys, touches `updated_at`, and preserves the body.

## Coordinator Procedure

1. Confirm the current working directory is the project main workspace.
2. Select work with:

   ```bash
   node .agents/skills/todo-md-tasks/scripts/select-ready-tickets.mjs --max-doing 3
   ```

3. For each selected ticket, render an implementer prompt with:

   ```bash
   node .agents/skills/todo-md-tasks/scripts/render-thread-prompt.mjs --ticket "$PWD/.tasks/example.md" --main-workspace "$PWD"
   ```

4. Create a visible top-level Codex thread in worktree mode for each selected ticket. Pass the absolute main-workspace ticket path from `selected[].filePath`.
5. Immediately update the main-workspace ticket to `status: doing` and `assignee: codex://threads/<thread-id>`.
6. Report created threads and skipped work; do not implement tickets in the coordinator run.

## Implementer Procedure

1. Read the ticket fully.
2. Verify or repair `status: doing` and `assignee` in the main workspace when the thread id is available.
3. Implement the requested change in the Codex worktree.
4. Run relevant tests and a separate review agent for new features.
5. Commit, push, and open a PR when implementation is complete.
6. Check PR status. If checks pass, request review when possible.
7. Update the main-workspace ticket to `status: review` and set `pr_link`.
8. Leave the ticket in `doing` and explain the blocker if implementation or PR creation cannot complete.
