---
id: 1783106545867-feature-automatic-refresh
title: Feature: Automatic refresh
status: review
rank: k
created_at: 1783106545867
updated_at: 1783108049746
priority: P0
size: M
assignee: codex://threads/019f297a-53ed-7d73-8765-62b984f6650f
pr_link: https://github.com/zbsss/todo.md/pull/35
---

Right now there's a `Refresh` button above the Board. I want to leave it there, but there should also be an automatic sync running in the background every couple seconds.
There will be ~3 agents running at a time working on different tickets (outside of the app, ie. editing the .md files directly), we want to get the updates "live".
