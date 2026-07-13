# Apps

Each app under `apps/` owns its hosted UI plus, when needed, one reusable headless mount.

The current center is:

```txt
defineWorkspace()
  app's shared isomorphic definition

open<App>Browser()
<app>()
open<App>Tauri()
  runtime-specific wiring

createWorkspace()
satisfiesWorkspace()
  lower-level primitives for internals, tests, and older app ports
```

## Layout

```
apps/<app>/
├── mount.ts         optional `<app>()` headless mount factory
├── workspace.ts     shared schema, branded IDs, workspace definition, actions
├── src/             SvelteKit app
└── package.json     "exports": { ".": "./workspace.ts", "./mount": "./mount.ts" }
```

Some apps keep the shared workspace contract under `src/lib/workspace.ts`
instead of the package root. Follow the existing package shape. The important
boundary is the same: shared model in the workspace file, runtime wiring in
`browser.ts`, `mount.ts`, or `tauri.ts`.

## Boundaries

The workflow below describes apps still using the production Yjs-record path.
The target SQLite contract replaces `table.docs(...)` declarations with the
single `defineTable({ fields, documents, touchOnDocumentEdit })` shape as each
app migrates; do not mix both record authorities inside one app.

`workspace.ts` is the sync contract. It defines table shapes, KV schemas, branded IDs, actions, child-doc layouts, and the app's `defineWorkspace(...)` value. Forking that file means forking sync compatibility.

`mount.ts` is the reusable mount factory. It opens the shared workspace with Node-only attachments: Yjs persistence, collaboration, SQLite and Markdown materializers, and app-owned background work.

Browser and desktop code open the same definition with runtime-specific composition. Scripts usually skip Yjs entirely: they read materialized files or SQLite. Generic off-process daemon action calls are not part of the app contract.

## Adding a Daemon Mount

1. Add `apps/<app>/workspace.ts` or `apps/<app>/src/lib/workspace.ts`, following the package's existing layout.
2. Point `package.json` `exports["."]` at the workspace contract file.
3. Add an exported `defineWorkspace({ id, tables, kv, actions })` value. Declare row child docs with `table.docs(...)`.
4. Add `apps/<app>/mount.ts` exporting `<app>(opts?)`, a factory that returns `defineSessionMount({ name, open })` (or `defineMount` for a mount that can run signed out).
5. Point `package.json` `exports["./mount"]` at `./mount.ts`.
6. Run `epicenter up -C <epicenter-root>` and confirm the watcher starts, syncs, and materializes the expected files.
