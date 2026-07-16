# Apps

Each app under `apps/` owns its hosted UI plus, when needed, one reusable headless mount.

Apps currently use one of two workspace lanes. New canonical SQLite work starts
from an inert definition and an authority-bound runtime:

```txt
defineWorkspace({ id, tables, documents })
  release-local table lenses and top-level parameterized documents

runtime.open(definition)
  borrowed tables, documents, and read-only SQL handles
```

Several apps still use the transitional root-Yjs lane:

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
├── workspace.ts     shared workspace definition and domain types
├── src/             SvelteKit app
└── package.json     "exports": { ".": "./workspace.ts", "./mount": "./mount.ts" }
```

Some apps keep the shared workspace contract under `src/lib/workspace.ts`
instead of the package root. Follow the existing package shape. The important
boundary is the same: shared model in the workspace file, runtime wiring in
`browser.ts`, `mount.ts`, or `tauri.ts`.

## Boundaries

The daemon workflow below describes apps still using the production root-Yjs
record path. Its definition-owned `create/connect/mount`, `defineKv`, `.docs`,
and `_v` APIs remain compatibility surfaces until those apps migrate.

The canonical SQLite lane uses `defineTable({ fields, optional })` only for
release-local record validation and projection. It declares every Yjs resource
at workspace top level with `document.*`, using typed parameters such as
`{ skillId }` when a document has a domain relationship to a record. It has no
workspace KV plane, nested table documents, user-data migration API, schema
hash, or successor database.

Do not mix the two record authorities inside one app. Compose several canonical
workspaces by opening their imported definitions through one runtime and passing
the borrowed handles to ordinary application services.

For a transitional root-Yjs app, `workspace.ts` remains the sync contract. It
defines table shapes, KV schemas, branded IDs, actions, child-document layouts,
and the app's `defineWorkspace(...)` value. Forking that file means forking sync
compatibility.

For that same lane, `mount.ts` is the reusable mount factory. It opens the
shared workspace with Node-only attachments: Yjs persistence, collaboration,
SQLite and Markdown materializers, and app-owned background work.

Browser and desktop code open the same definition with runtime-specific composition. Scripts usually skip Yjs entirely: they read materialized files or SQLite. Generic off-process daemon action calls are not part of the app contract.

## Adding a transitional daemon mount

1. Add `apps/<app>/workspace.ts` or `apps/<app>/src/lib/workspace.ts`, following the package's existing layout.
2. Point `package.json` `exports["."]` at the workspace contract file.
3. Add an exported `defineWorkspace({ id, tables, kv, actions })` value. Declare
   row child documents with `table.docs(...)`. This step applies only to the
   transitional root-Yjs lane; do not copy it into a canonical SQLite app.
4. Add `apps/<app>/mount.ts` exporting `<app>(opts?)`, a factory that returns `defineSessionMount({ name, open })` (or `defineMount` for a mount that can run signed out).
5. Point `package.json` `exports["./mount"]` at `./mount.ts`.
6. Run `epicenter up -C <epicenter-root>` and confirm the watcher starts, syncs, and materializes the expected files.
