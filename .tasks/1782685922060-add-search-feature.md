---
id: 1782685922060-add-search-feature
title: Design search feature
status: todo
order: 10000
created_at: 1782685922060
updated_at: 1783008951067
---

- We want to allow to search tasks in project. When typing, the tasks should be filtered out live from the board, and the matched text shoud be highlighted (even if it's deep in the description of the task, it should show up highlighted below the title). It should use full text search, including title, description, and metadata of the task.
- Depending on how complex that would be, but it would be nice if the search worked even if you made a small typo.
- We want to keep the app small and fast, so don't overengineer this search.
- Consider if this should be done on frontend or backend.

Note for why backend could be a good choice: in the future we plan to add a CLI that will allow AI Agnets to work with tasks. If search is on the backend, the CLI could use the same search functionality as the App.

Research the problem and write a design for it.
