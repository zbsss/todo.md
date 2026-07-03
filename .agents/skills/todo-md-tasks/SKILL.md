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
- Pick higher-priority work first: `P0`, `P1`, `P2`, `P3`, `P4`, then unprioritized tickets.
- Count only `doing` against the coordinator's max active implementation slots.
- Move a ticket to `review` only after a PR exists and is ready for human review.
- Do not merge PRs unless the user explicitly asks.

## Worktree Rules

- Run `git worktree list` before changing ticket metadata.
- Identify the main workspace for the current project from the `main` worktree line.
- Update ticket metadata in the main workspace, not in an implementation worktree.
- Implement code and run tests in the assigned Codex worktree.
- If an implementer starts in the main workspace instead of a separate Codex worktree, it must stop before editing files and report the launch failure.
- Preserve ticket Markdown bodies and unrelated frontmatter fields when updating metadata.

## Automation Shape

- Use one persistent coordinator thread with a 15-minute heartbeat automation.
- Do not use a standalone cron automation that creates a new coordinator thread for every run.
- The coordinator may create implementer threads, but it must not create replacement coordinator threads.

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

   The selector sorts eligible tickets by priority, then rank, title, and id. Each selected ticket includes `reasoningEffort` (`medium`, `high`, or `xhigh`) and `planningRequired` derived from task `size`.

3. For each selected ticket, render an implementer prompt with:

   ```bash
   node .agents/skills/todo-md-tasks/scripts/render-thread-prompt.mjs --ticket "$PWD/.tasks/example.md" --main-workspace "$PWD"
   ```

4. Create a visible top-level Codex thread in worktree mode for each selected ticket with the Codex app `create_thread` tool. Pass the rendered prompt, target the same project, set `target.environment.type` to `worktree`, and set `thinking` from `selected[].reasoningEffort`.
5. Never use subagents, custom-agent launchers, or local-project delegation as a fallback for implementation. `.codex/agents/todo-md-implementer.toml` is prompt source material only.
6. If the `create_thread` tool is not available, stop and report the blocker without assigning tickets.
7. Use `xhigh` reasoning for `L` and `XL` tickets; those prompts require a /plan-style plan before file edits. Use `high` for `M` tickets and `medium` for `XS`, `S`, or unspecified size.
8. Immediately update the main-workspace ticket to `status: doing` and `assignee: codex://threads/<thread-id>`.
9. Report created threads and skipped work; do not implement tickets in the coordinator run.

## Implementer Procedure

1. Read the ticket fully.
2. Run `git worktree list`, identify the main workspace, and confirm the current working directory is a separate implementation worktree.
3. If the current working directory is the main workspace, stop before editing files and report the incorrect launch.
4. Verify or repair `status: doing` and `assignee` in the main workspace when the thread id is available.
5. For `L` or `XL` tickets, create a /plan-style implementation plan before file edits.
6. Implement the requested change in the Codex worktree.
7. Run relevant tests and a separate review agent for new features.
8. Commit, push, and open a PR when implementation is complete.
9. Check PR status. If checks pass, request review when possible.
10. Update the main-workspace ticket to `status: review` and set `pr_link`.
11. Leave the ticket in `doing` and explain the blocker if implementation or PR creation cannot complete.
