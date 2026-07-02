---
id: 1782685332860-fix-refactor-codebase
title: Fix: refactor codebase
status: done
order: 13000
created_at: 1782685332861
updated_at: 1783015729924
---

## Goal
Split the code into smaller files. Reading large files is not good for AI context.
We also run into a lot of merge conflicts.

There are two parallel streams:
1. Before refactoring we should increases the unit test coverage (fortned and backend) so we can validate the refactoring changes and catch issues.
2. The actual refactoring

This is a bigger project, so it's important that instead of doing the work yourself, you delegate individual design, and implementation task to other agents.
## Testing
Run an agent that will do quick research on what makes good unit tests, pass on this guidance to two separate agent for frontend and backend to increase the unit test coverage to help with future refactoring.
## Refactoring 
Design how to split and structure the code. First, launch a separate agent to research best practices.
Then, create a refactoring plan. Split the refactoring work between couple agents (2?).

Your job is to coordinate this work. Whenever possible parallelize the work.
