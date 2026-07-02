---
id: 1782956934256-fix-all-tasks-updated-at-changes-when-single-task-is-moved
title: Fix: all tasks `updated_at` changes when single task is moved
status: doing
order: 3000
created_at: 1782956934256
updated_at: 1783008951070
---

I'm not 100% sure this is correct. But i noticed that sometimes when i move a single task (changer order, or column) a bunch of other tasks get their `updated_at` metadata updated, even though they should be unchanged.
Try to reproduce this issue and fix it.

------
Problem is that with the current fix the `order` field is still edited, so there's still going to be a diff in Git.
How can we do it, so it doens't generate a diff?
Make big gaps between `order` values initially. WHen moving something in-between, choose in-between value?
But then we'll run out of values at some point and stuff will break.
