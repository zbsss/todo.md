# todo.md

A lightweight Tauri task board where projects are folders and tickets are local Markdown files.

## Development

```sh
npm install
npm run tauri dev
```

## Build

```sh
npm run tauri build
```

The default bundle target is the runnable macOS `.app` bundle.

## Storage

todo.md creates new projects under the app data directory by default, and you can add an existing folder as a project from the sidebar. When you add an existing folder, todo.md creates a `.tasks` directory inside it and stores ticket `.md` files there. Each ticket file has small frontmatter for board metadata and normal Markdown content beneath it.
