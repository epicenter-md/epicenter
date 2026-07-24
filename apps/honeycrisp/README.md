# Honeycrisp

Honeycrisp is a local-first notes app. Folder and note metadata live as canonical SQLite rows. Each note body is a Yjs document that can sync and merge independently.

Part of the [Epicenter](https://github.com/EpicenterHQ/epicenter) monorepo. AGPL-3.0 licensed.

---

## How it works

### Layout

Single-route SvelteKit app with a three-pane layout: sidebar (folders) → note list → editor. SSR is disabled; the app runs entirely in the browser as a static site.

### Data layer

Honeycrisp defines one inert workspace contract (`id: "epicenter-honeycrisp"`) and opens it through a page-owned runtime:

```txt
honeycrispDefinitions
  shared isomorphic definition: id and release-local row lenses

openHoneycrispBrowserEpicenter()
  browser runtime: device or account SQLite ownership and sync
```

The Svelte app chooses its authority once at boot. Signed out, it opens the device database. Signed in, it opens the account database and attaches the account transport. Row changes invalidate app-owned reactive arrays; the state layer refreshes them through the async table API.

This was a clean break from the legacy root-Yjs and IndexedDB model. Honeycrisp does not probe, import, restore, or delete legacy data. The old database is untouched and unreachable from the new app.

### Rich-text editing

Each note row owns one document. `NoteBodyPane.svelte` opens it through `honeycrisp.openNoteDocument(noteId)`, reads the application-owned `body` root, and disposes the handle when the pane unmounts. ProseMirror binds to that Yjs 14 type through `@y/prosemirror`.

User edits extract the title, preview, and word count and write them back to the note row with an explicit `updatedAt`. Binding-origin transactions do not update metadata, so opening or remotely hydrating a note does not make it look newly edited.

### Soft deletion

Normal deletion is soft deletion: the note row gets a `deletedAt` timestamp and appears in Recently Deleted. Permanent deletion removes the canonical row and revokes its document lease.

### Auth

Google sign-in is optional. The app opens immediately against device storage. A principal change reloads the page so the next boot can choose the account or device runtime. There is no legacy sign-in migration or restore prompt.

---

## Workspace schema

**Workspace ID:** `epicenter-honeycrisp`

### Tables

**`folders`**
| Field | Type |
|---|---|
| `id` | `string` (runtime-minted) |
| `name` | `string` |
| `icon` | `string` (optional) |
| `sortOrder` | `number` |

**`notes`**
| Field | Type |
|---|---|
| `id` | `string` (runtime-minted) |
| `folderId` | `FolderId` (optional) |
| `title` | `string` |
| `preview` | `string` |
| `pinned` | `boolean` |
| `createdAt` | `InstantString` |
| `updatedAt` | `InstantString` |
| `deletedAt` | `InstantString` (optional, soft delete) |
| `wordCount` | `number` (optional) |

Each note's body lives in a row-owned document opened by `honeycrisp.openNoteDocument(noteId)`. The editor owns the `body` root name and the handle's lifecycle.

Honeycrisp currently has no workspace KV schema. View selection, sorting, and URL state live in the Svelte state layer.

---

## Other features

- **Pin/unpin**: pinned notes sort to the top of the list.
- **Folder deletion**: re-parents all notes in the folder to unfiled, keeping data intact.
- **Sorting**: by date edited, date created, or title.
- **Search**: filters by title and preview content.
- **Keyboard shortcuts**: `Cmd+N` (new note), `Cmd+Shift+N` (new folder).
- **Context menus**: per-note actions: pin, move to folder, delete, restore.

---

## Development

Prerequisites: [Bun](https://bun.sh).

```bash
git clone https://github.com/EpicenterHQ/epicenter.git
cd epicenter
bun install
bun dev:honeycrisp
```

This starts the desktop app on port 5175 alongside the local API on `localhost:8787`, which auth and sync expect. `bun dev:honeycrisp:ui` runs the browser UI without the API or Tauri shell.

### Two-client sync demo

One command boots a disposable self-hosted authority, serves this app once, and
converges two independent browser replicas through that authority:

```bash
bun run --cwd apps/honeycrisp demo:two-client
```

It holds the origin fixed and varies only the browser storage partition, which
is what makes the two replicas independent (ADR-0177). So it proves both halves
of that boundary at once: a second tab in the *same* partition is refused
immediately by the Web Lock, while a client in a *different* partition on the
same origin opens fine and converges only by synchronizing through the
authority. Two isolated browser profiles are just how the run obtains a second
partition; that is a proof recipe, not a supported topology.

Development exercises the production contract rather than a development-only
one. The pages reach the authority at its own origin, so the run asserts that
no request took a same-origin `/api` path, that every response carried
`Access-Control-Allow-Origin` for exactly this origin, that the instance bearer
authenticated every request, and that ETag revision headers were exercised.
There is deliberately no Vite proxy: the authority trusts this one exact origin
through `TRUSTED_BROWSER_ORIGINS`, exactly as a deployed instance does.

The instance data and both browser profiles live in a temporary directory that
is removed on success and kept on failure.

---

## Tech stack

- [SvelteKit](https://kit.svelte.dev): UI framework (static adapter, SSR disabled)
- [ProseMirror](https://prosemirror.net) + `@y/prosemirror`: collaborative rich-text editing
- `@y/y` 14: row-owned note body documents
- [Tailwind CSS](https://tailwindcss.com): styling
- [Better Auth](https://better-auth.com): authentication
- `@epicenter/data`: canonical SQLite rows, values, and local row documents
- `@epicenter/document-sync`: network synchronization for open row documents
- `@epicenter/svelte`: auth and browser lifecycle helpers
- `@epicenter/ui`: shadcn-svelte component library

---

## License

AGPL-3.0
