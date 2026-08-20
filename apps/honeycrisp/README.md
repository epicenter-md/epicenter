# Honeycrisp

Honeycrisp is a local-first notes app. The scalar application state is one Yjs
document: folders and notes are rows in it. Each note's prose is a rich-text
type in an independent row document that merges per character.

Part of the [Epicenter](https://github.com/EpicenterHQ/epicenter) monorepo. AGPL-3.0 licensed.

---

## How it works

### Layout

Single-SPA SvelteKit app with `/device` and `/account` destinations. Both use
the same three-pane layout: sidebar (folders) → note list → editor. SSR is
disabled; the app runs entirely in the browser as a static site.

### Data layer

Honeycrisp declares one inert data definition over `so.epicenter.honeycrisp` (`src/lib/workspace/index.ts`) and opens it as a store the app owns:

```txt
openDeviceDatabase()                                      device database
openAccountDatabase({ auth })                             account replica
data.tables.notes.list()                                  synchronous from here on
```

The definition names the application and the route-owned opener names which
durable document it means (ADR-0229 as amended by ADR-0233). `/device` opens
the device database. `/account` gates auth and opens one retained account
replica. Each route owns one store, and nothing falls back to the other route's
data.
The scalar document shape is the shared `app`/`kv`/`tables:<name>` grammar in
[ADR-0257](../../docs/adr/0257-the-application-document-has-named-kv-and-table-roots.md).

Every build opens its own store, with no platform seam, and reaches one
authority per signed-in account (ADR-0225/0226). The desktop host serves
Honeycrisp's bundle and brokers its credential; it owns none of its data.

**Reads are synchronous after opening.** A route opens its store by replaying a
durable log into one `Y.Doc`, then `data.tables.notes.list()` returns rows, not
a promise. An account route may wait for a fresh replica's first binding while
the device route remains independently usable.

**Nothing polls and nothing refreshes.** `data.tables.notes.subscribe(...)` reports which
rows a commit touched, and it fires for a local write, for prose typed into a
note, and for bytes that arrived from another device alike (ADR-0221). The state
modules re-read on that signal; there is no generation counter and no manual
refresh anywhere.

### Rich-text editing

A note's prose is a live type at the `body` root inside the note's own
independent document. `NoteBodyPane.svelte` opens that document through
`data.tables.notes.document.open(noteId)`, receives a fully hydrated handle, and
hands `handle.get('body')` straight to ProseMirror through `@y/prosemirror`.
Opening is awaited and the handle is disposed when the editor closes; two
devices first-opening the same named root converge because it is name-addressed.

User edits extract the title, preview, and word count and write them back to the note row with an explicit `updatedAt`. Binding-origin transactions do not update metadata, so opening or remotely hydrating a note does not make it look newly edited.

### Soft deletion

Normal deletion is soft deletion: the note row gets a `deletedAt` timestamp and appears in Recently Deleted. Permanent deletion removes the canonical row and revokes its document lease.

### Auth and sync

The device destination works completely signed out. The account destination
requires sign-in and shows its own gate; it never silently shows device data.
Signing in opens the account replica and attaches sync, and that is the whole
of the sharing model. Every device signed into one account dials one authority
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

A data definition has no optional fields: a field has to be one type through the CRDT
attribute, the projection column and the row alike, and "absent" is not a SQL
type. So what would have been optional is nullable, and the application writes
or recovers `null` explicitly.

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
- `@epicenter/data`: the store, its transport, and the data-definition vocabulary
- `@epicenter/sync`: the bearer-in-subprotocol handshake the upgrade uses
- `@epicenter/svelte`: auth and browser lifecycle helpers
- `@epicenter/ui`: shadcn-svelte component library

---

## License

AGPL-3.0
