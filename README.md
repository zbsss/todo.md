# Todo MD

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

Todo MD creates new projects under the app data directory by default, and you can add an existing folder as a project from the sidebar. Each ticket is a `.md` file with small frontmatter for board metadata and normal Markdown content beneath it.
