# Honeycrisp

Honeycrisp is a local-first notes app. The whole application is one Yjs document: folders and notes are rows in it, and each note's prose is a rich-text type inside the row that merges per character.

Part of the [Epicenter](https://github.com/EpicenterHQ/epicenter) monorepo. AGPL-3.0 licensed.

---

## How it works

### Layout

Single-route SvelteKit app with a three-pane layout: sidebar (folders) → note list → editor. SSR is disabled; the app runs entirely in the browser as a static site.

### Data layer

Honeycrisp declares one inert Lens over `so.epicenter.honeycrisp` (`src/lib/workspace/index.ts`) and binds it to a store the surface owns:

```txt
open(honeycrispLens, { owner: 'device' })            sqlite-wasm in the page,
open(honeycrispLens, { owner: 'account',             durable relations in
                       principalId })               IndexedDB, one database
                                                    per document
db.tables.notes.list()                              synchronous from here on
```

The lens names the application and the caller names which durable document it
means and whose it is (ADR-0229 as amended by ADR-0233): one device document
that never syncs, and one retained replica per account. Auth
picks one at boot, in `src/lib/application.ts`, and nothing else opens a store.

Every build opens its own store, with no platform seam, and reaches one
authority per signed-in account (ADR-0225/0226). The desktop host serves
Honeycrisp's bundle and brokers its credential; it owns none of its data.

**The surface is synchronous.** Opening the store is the only asynchronous thing
the application does: it replays a durable log into one `Y.Doc` and everything
after that is a property access. `db.notes.list()` returns rows, not a promise.

**Nothing polls and nothing refreshes.** `db.notes.subscribe(...)` reports which
rows a commit touched, and it fires for a local write, for prose typed into a
note, and for bytes that arrived from another device alike (ADR-0221). The state
modules re-read on that signal; there is no generation counter and no manual
refresh anywhere.

### Rich-text editing

A note's prose is a live type at the `body` root inside the note's own document,
allocated when the row is created (`{ document: ['body'] }`) so two devices
first-opening one note cannot each mint their own and lose one. `NoteBodyPane.svelte`
reads it with `db.notes.document(noteId).get('body')` and hands it straight to
ProseMirror through `@y/prosemirror`. There is no handle to open, nothing to
await, and nothing to dispose.

User edits extract the title, preview, and word count and write them back to the note row with an explicit `updatedAt`. Binding-origin transactions do not update metadata, so opening or remotely hydrating a note does not make it look newly edited.

### Soft deletion

Normal deletion is soft deletion: the note row gets a `deletedAt` timestamp and appears in Recently Deleted. Permanent deletion removes the canonical row and revokes its document lease.

### Auth and sync

Sign-in is optional and never a door: the app opens against local storage and
works completely signed out. Signing in attaches sync, and that is the whole of
the sharing model. Every device signed into one account dials one authority
(`principals/<id>/stores/so.epicenter.honeycrisp`) and converges; there is
nothing to pair, invite, or approve.

`src/lib/sync.ts` is Honeycrisp's entire share of the transport: a URL.
Reconnecting on close, reconnecting when the client is stuck behind a gap,
putting the cursor in the URL and watching for a submission nobody answers are
all the library's, because every one of them is correctness rather than
transport (ADR-0222).

---

## Workspace schema

**Workspace ID:** `epicenter-honeycrisp`

### Tables

**`folders`**
| Field | Type |
|---|---|
| `id` | `string` (runtime-minted) |
| `name` | `string` |
| `icon` | `string \| null` |
| `sortOrder` | `number` |

**`notes`**
| Field | Type |
|---|---|
| `id` | `string` (runtime-minted) |
| `folderId` | `string \| null` |
| `title` | `string` |
| `preview` | `string` |
| `pinned` | `boolean` |
| `createdAt` | `string.date.iso` |
| `updatedAt` | `string.date.iso` |
| `deletedAt` | `string.date.iso \| null` (soft delete) |
| `wordCount` | `number \| null` |

A Lens has no optional fields: a field has to be one type through the CRDT
attribute, the projection column and the row alike, and "absent" is not a SQL
type. So what would have been optional is nullable with a `= null` default,
which a read applies and a write never stores.

Each note's prose lives at the `body` root inside that note's document. The
application names the root and picks its format; Epicenter allocates the
container with the row, collects it with the row, and never looks inside.

Honeycrisp has no KV schema. View selection, sorting, and URL state live in the Svelte state layer.

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

### Checking it actually works

```bash
bun run --cwd apps/honeycrisp evidence:runs   # against a running dev:web
```

Drives the real app in a real browser: make a note, type prose into it, reload,
and assert both survived. The reload is the point, since the page holds an
in-memory SQLite and IndexedDB holds what has to outlive it.

### Manual two-client check

Open the Honeycrisp web UI in two isolated browser profiles and sign both into
the same account. Do not use two ordinary tabs in one profile: they share a
storage partition (ADR-0177), so they are one device rather than two.

---

## Tech stack

- [SvelteKit](https://kit.svelte.dev): UI framework (static adapter, SSR disabled)
- [ProseMirror](https://prosemirror.net) + `@y/prosemirror`: collaborative rich-text editing
- `@y/y` 14: row-owned note body documents
- [Tailwind CSS](https://tailwindcss.com): styling
- [Better Auth](https://better-auth.com): authentication
- `@epicenter/data`: the store, its transport, and the Lens vocabulary
- `@epicenter/sync`: the bearer-in-subprotocol handshake the upgrade uses
- `@epicenter/svelte`: auth and browser lifecycle helpers
- `@epicenter/ui`: shadcn-svelte component library

---

## License

AGPL-3.0
