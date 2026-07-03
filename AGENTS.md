## Development Workflow

If you're implementing a new feature, check your work by running a separate review agent. Once you finish commit your changes and create a pull request. Check if the pull request passes all checks and if it does, request a review. Make sure to address any feedback provided before merging the pull request into the main branch.

If you identify a bug and fix it, consider creating a regression test to catch it in the future.

## Tasks

If you're given a task from `.tasks` folder to work on you MUST read task description fully and understand it before starting to work on it. If you have any questions, ask for clarification, don't make assumptions.

If you're working in a Git workspace run `git worktree list` to find the `main` workspace path. When changing ticket status or metadata, do it in the `main` workspace, not in the agent workspace.

When you start working on a task, update the `status` to `doing`, and add your Codex thread deep link to the `assignee` field such as `codex://threads/<thread-id>`

If you have a pull request that implements the task, add the link in the `pr_link` field.
