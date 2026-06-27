# Todo MD

A lightweight Tauri task board where projects are folders and tickets are local Markdown files.

## Development

```sh
npm install
npm run tauri dev
```

Ticket files are stored in the app data directory under a `projects` folder. Each ticket is a `.md` file with small frontmatter for board metadata and normal Markdown content beneath it.
