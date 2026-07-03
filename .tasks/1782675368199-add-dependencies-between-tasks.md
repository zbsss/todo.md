---
id: 1782675368199-add-dependencies-between-tasks
title: Add dependencies between tasks
status: ready
rank: 4
created_at: 1782675368200
updated_at: 1783118472745
priority: P0
size: XL
---

This is a large task, plan this out before implementing. Don't implement yourself, run separate agents to do the implementaiton, manual testing and review. Your job is to plan and coordinate this task.
## Overview
There should be two types of relationships:
- subtask/parent
- blocks/blocked
A relationship should show up in the frontmatter in both Tasks.
## Ticket view > Dependencies tab
Add a new "tab" when you open a Task (currently there's only the "markdown description tab"). The new tab should show both types of relationships, show small preview of the other tasks, highlight eg. 1/3 are completed etc. There should be option to link new tasks, this should use the existing search feature to find tasks.
## Board view
When task is blocked it shoud show a blocked icon (with count) on the task card on the board. If it has child depndencies it should show some icon with count on the task card on the board. Eg. highlight eg. 1/3 are completed 
Clicking on either of these icons should open the dependencies tab for that task.
## Table view
There should be a column for depedencies (blockers or child deps, both in one column is fine). Rest of features same as on Board view.
## Common
All views should use the same chip component to show dependencies/blockers.
When one of the tasks is closed, the chips should be updated.
