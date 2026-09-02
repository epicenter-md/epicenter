# Honeycrisp

Honeycrisp is a local-first notes app. The whole database is one Yjs document:
folders and notes are rows in it, and each note's body is the node
nested on its note row, merging per character.

Part of the [Epicenter](https://github.com/EpicenterHQ/epicenter) monorepo. AGPL-3.0 licensed.

---

## How it works

### Layout

Single-SPA SvelteKit app with one destination, `/account`. Three panes:
sidebar (folders) → note list → editor. SSR is disabled; the app runs entirely
in the browser as a static site.

### Data layer

Honeycrisp declares one inert data definition over `so.epicenter.honeycrisp` (`src/lib/data/index.ts`) and opens it as a store the app owns:

```txt
resolveAccountGeneration(auth, principalId)               which number, once
openAccountDatabase({ auth, generation })                 the store
eraseNotesOnThisDevice()                                  the one deleting verb
data.tables.notes.rows                                    synchronous from here on
```

The definition names the application and the route names which exact generation
of it (ADR-0229, ADR-0292). `/account` resolves a number and redirects;
`/account/[generation]` opens it. The store lives at
`epicenter/v4/so.epicenter.honeycrisp/so.epicenter.honeycrisp/<n>`: the opening
application, the data id, then the number (ADR-0324).
The document shape is the shared `app`/`kv`/`tables:<name>` grammar in
[ADR-0257](../../docs/adr/0257-the-application-document-has-named-kv-and-table-roots.md).

Every build opens its own store, with no platform seam, and reaches one
authority per signed-in account (ADR-0225/0226). The desktop host serves
Honeycrisp's bundle and brokers its credential; it owns none of its data.

**Reads are synchronous after opening.** The route opens its store by replaying
a durable log into one `Y.Doc`, then `data.tables.notes.rows` returns rows, not
a promise.

**Nothing polls and nothing refreshes.** `data.tables.notes.subscribe(...)`
reports which rows a commit touched, for a local write and for bytes that
arrived from another device alike (ADR-0221). It does NOT fire for an edit
inside a note's content node: that reaches the list only because this app hangs
its own `title`/`updatedAt` write on the node's own signal, and that write is a
row change like any other. The state modules re-read on the signal; there is no generation
counter and no manual refresh anywhere.

### Rich-text editing

A note's body is the `content` node on its note row, declared with a content
codec and minted with the row. `NoteBodyPane.svelte` reaches it through
`notes.openContent(noteId)` and hands the type straight to ProseMirror through
`@y/prosemirror`. Nothing is awaited and nothing is loaded: the type is in the
document the store already holds.

`openContent` also subscribes to that node's own edit signal and writes the
note's `title` and `updatedAt` back onto the row, coalesced to one write per
burst. The store writes no derived fields and no timestamps
(ADR-0297), so this is Honeycrisp's job; `close` stops it.

### Soft deletion

Normal deletion is soft deletion: the note row gets a `deletedAt` timestamp and appears in Recently Deleted. Permanent deletion removes the row, and its node goes with it: the whole nested subtree is reclaimed in the same removal.

### Auth and sync

Signing in comes before the notes, because an authority mints every generation
(ADR-0336): there is no signed-out notebook to fall back to, and `AccountGate`
is what a signed-out person meets. Signing in opens the store and attaches
sync, and that is the whole of the sharing model. Every device signed into one
account dials one authority
(`principals/<id>/data/so.epicenter.honeycrisp`) and converges; there is
nothing to pair, invite, or approve.

A store records the account it was created for and refuses to open as anybody
else (ADR-0325). When somebody else's notes are still on the device,
`AccountGate` says so and offers two ways out: sign in as that account, or
erase this device's copy. Nothing is deleted until a person confirms it.

`src/lib/sync.ts` is Honeycrisp's entire share of the transport: a URL.
Reconnecting on close, reconnecting when the client is stuck behind a gap,
putting the cursor in the URL and watching for a submission nobody answers are
all the library's, because every one of them is correctness rather than
transport (ADR-0222).

---

## Workspace schema

**Data ID:** `so.epicenter.honeycrisp`

### Tables

**`folders`**
| Field | Type |
|---|---|
| `id` | `string` (runtime-minted) |
| `name` | `string` |
| `icon` | `string \| null` |

**`notes`**
| Field | Type |
|---|---|
| `id` | `string` (runtime-minted) |
| `folderId` | `string \| null` |
| `title` | `string` |
| `pinned` | `boolean` |
| `createdAt` | `string.date.iso` |
| `updatedAt` | `string.date.iso` |
| `deletedAt` | `string.date.iso \| null` (soft delete) |
| `content` | live `Y.Type` (Markdown codec) |

A data definition has no optional fields: a field has to be one type through the CRDT
attribute, the exported frontmatter value and the row alike, and "absent" is not a
type. So what would have been optional is nullable, and the application writes
or recovers `null` explicitly.

Each note's body lives at the reserved `content` key on its note row, nested in
the one application document. The table picks its format through a codec;
Epicenter mints the node with the row, collects it with the row, and never looks
inside.

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

This starts the browser UI on port 5175 alongside the local API on `localhost:8787`, which auth and sync expect. `bun dev:honeycrisp:ui` runs the UI alone, without the API.

To run Honeycrisp the way it ships, start the host: `bun dev:epicenter`. Honeycrisp has no desktop shell of its own.

### Checking it actually works

There is no browser evidence script here. The two that existed drove a fresh
Chromium at `/device` and `/account` and asserted a note survived a reload;
both stop at the sign-in gate now, and neither can hold an account. What still
proves the durability claim is `packages/data/evidence/browser/durable-store/`,
which drives the store itself across a real reload.

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
