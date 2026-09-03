# Honeycrisp App

Local-first notes SPA. Folders and notes are rows in one Yjs document, and each
note's body is the node on its note row inside that same document
(ADR-0295, ADR-0309). The one application running on the store today, so it is also the
reference for how an app is built.

Design authority: [ADR-0339](../../docs/adr/0339-an-application-creates-one-epicenter-and-an-account-is-what-adds-a-store.md) (an application creates one epicenter, and an account is what adds a store), [ADR-0226](../../docs/adr/0226-a-host-serves-bundles-and-brokers-credentials-it-owns-no-application-data.md) (a host serves bundles and brokers credentials and owns no application data), [ADR-0225](../../docs/adr/0225-a-store-authority-is-one-durable-object-per-principal-and-application-and-being-signed-in-is-the-sharing-model.md) (one authority per principal and application; being signed in is the sharing model), [ADR-0295](../../docs/adr/0295-a-database-is-one-yjs-document-and-a-row-holds-its-rich-content.md) (a database is one Yjs document and a row holds its rich content), [ADR-0292](../../docs/adr/0292-a-database-opens-an-exact-generation-cache-first-and-bootstraps-account-misses.md) (a database opens an exact generation cache-first), [ADR-0336](../../docs/adr/0336-an-authority-mints-every-generation-so-every-store-has-an-account.md) (an authority mints every generation, so every store has an account), [ADR-0324](../../docs/adr/0324-a-database-address-is-its-data-id-and-generation-and-the-definition-declares-its-authority.md) (the address is the application, the data id, and the generation), [ADR-0256](../../docs/adr/0256-automatic-folding-is-the-current-maintenance-path-and-manual-workspace-compaction-is-deferred.md) (automatic folding is current; manual workspace compaction is deferred).

## One handle, one URL, and the generation is nobody's to choose

`#platform/epicenter` is where this application's notes come from
(ADR-0339). Its two leaves differ in one line, the runtime subpath:

```ts
export const honeycrisp = fromEpicenter(
	createEpicenter({ definition: honeycrispDefinition, account: auth }),
);
```

`definition` and `account` arrive together, which IS the store: an authority
mints every generation (ADR-0336), so there is no accountless notebook.
Nothing opens at construction. `epicenter.data` is a lazy getter, so a
signed-out person meeting the gate pays no Web Lock, no IndexedDB, and no
round trip, and reading it twice joins one open.

```text
epicenter/v4/so.epicenter.honeycrisp/so.epicenter.honeycrisp/<n>
```

The first segment after the version is the OPENING application and the second
is the data id (ADR-0324). They are the same string here and nothing writes the
first one down: it defaults to `honeycrispDefinition.id`, because this
application holds its own notes and nobody else's. An application that opened
another's data would state it, and would then hold two stores, which ADR-0339
refuses until something needs it.

**The generation is not in the URL and there is no picker.** `data` takes the
newest copy this device holds, else the account's newest, else mints, and
nothing stores the choice. It creates one only when the account's list comes
back EMPTY, which is a first run: a device that could not SEE what the account
has must not invent a history for it. `/account` and `/account/[generation]`
are gone; the notes are at `/`.

Opening is cache-first and never waits on a socket. A device holding a copy is
usable offline; one that holds none fetches the generation whole before
returning, so a fresh account never renders empty while its state is arriving.

The leaf exports ONE name, `honeycrisp`, which is `fromEpicenter` composed over
the handle: `signed-out | opening | ready | failed`, with the store on `ready`
and the error and the erase on `failed`. Signed-out is answered before anything
opens, and it is a state rather than a failure, so the gate never sniffs an
error to choose between "sign in" and "something broke". Both halves are lazy,
so importing the leaf opens nothing: `/auth/callback` never reads `state` and
never claims a lock.

`createHoneycrisp` turns that one opened store into the reactive application
object the UI consumes. It adapts the document into Svelte-reactive named
tables with `fromData`, layers Honeycrisp's domain operations, search, and URL
navigation on top, and exposes no database identity or fallback. Components
reach it through `getHoneycrisp()`; raw stores never cross that boundary. The
sidebar's status line reads `data.sync.status()` off the store itself
(ADR-0340).

A permanent credential refusal costs sync, not the notes: the store opened
from local state before a socket was attempted, and the sidebar's status line
goes quiet.

## The folder is a working copy, and a person fills it

`~/Epicenter/so.epicenter.honeycrisp/` holds these notes as files, and nothing
puts them there by itself (ADR-0337). `PullToFolder.svelte` is the button; the
verb is `pull` from `src/lib/folder.ts`, which is the library's verb with this
application's definition supplied. It needs nothing else, because the store
states its own address and that is what the manifest records (ADR-0340).

A pull refuses a folder holding edits nobody sent back, and shows them. Sending
them back or discarding them are both second deliberate acts. It also refuses
where there is no folder at all, which is every ordinary browser tab: a page
has no filesystem, and the copy says so rather than offering a retry.

A pull also writes an `AGENTS.md` at the folder root, generated from the
compiled definition (ADR-0330): the tables, their fields, and which edits come
back. Every pull replaces it, and it says so on its first line, so a person
keeping notes to themselves keeps them under another name.

`SendFolderEdits.svelte` is the other direction: `diff` shows what a push would
do, and `push` applies it and re-renders. **The folder wins, and a push is one
approval** (ADR-0338). Nothing is asked per item and nothing is validated on the
way in: a value goes in whatever it says, a body replaces the note's text, a new
file becomes a note, and a deleted file deletes one. To change any of it, cancel,
edit the file, and push again.

The dialog is the overview, ranked by what is still reachable afterwards, and it
renders as one block of plain text so a person can paste it to the agent that
made the mess. Two buttons, and Enter reaches Push all.

A push writes rows this release cannot read, on purpose, from a text editor.
`NoteList.svelte` is where they show up, beside the readable notes rather than
only in the empty state.

Deleting a file deletes the note, for good, without passing through Recently
Deleted. Trashing a note through the folder is the other gesture: set
`deletedAt` in the frontmatter, which is an ordinary value edit. No table
declares a trash field and none should.

A file an agent wrote becomes a note and **is renamed**, because a note's id is
minted rather than chosen. That is in the overview before a person approves it,
and in the `AGENTS.md` a pull writes, so an agent knows to re-read the folder
after a push.

One thing is not a plan at all: a folder nothing ever wrote. `pull` and `push`
both answer it with `FolderUnwritten`, and the surface says so once for the
folder rather than once per file.

## Three builds, one store shape

| Build | Command |
|---|---|
| Web | `bun run build` |
| Standalone desktop | `bun run tauri build` |
| Epicenter-hosted | `bun run build:epicenter` |

**They differ in nothing that concerns data.** Every build opens the same
client-owned store through the same handle and owns it; the desktop host serves
the bundle and brokers the credential and owns none of it (ADR-0226). What
`#platform/epicenter` selects is the runtime the handle's SQLite and secrets are
built over, which Honeycrisp uses neither of.
There used to be a platform seam where the hosted build reached the host's
shared `epicenter.sqlite3`, and ADR-0226 refused it.

What remains behind `#platform/*` is auth and instance only: how a build gets a
bearer, not where its data lives. `src/lib/platform-selection.test.ts` reads the
declarations and names a broken seam. `typecheck` runs all three conditions;
only the default one is checked by an editor.

## Don'ts

- Do not render a store error to a person as the message. `src/lib/boot-failure.ts`
  picks the sentence someone reads; the library's own wording goes underneath as
  detail, so a bug report keeps it and a wrong arm stays visible. Give a new
  failure a `name` before giving it an arm, and only add an arm when the repair
  is specific enough to be worth saying.
- Do not put `workspace`, `replica`, `authority`, `document`, or `sync cursor`
  in anything a person reads. They are the right words in this file and in
  `packages/data`, and the wrong ones in a tooltip.
- Do not detect the host at runtime. The build already answered.
- Do not migrate, import, or delete data belonging to another build. The
  standalone bundle and the hosted build are two stores on one machine, and
  nothing moves between them. Two devices converge by signing into the same
  account, not by copying a file.
- Do not reintroduce a second notebook. There is one store, because an
  authority mints every generation (ADR-0336); a signed-out person meets the
  sign-in gate rather than an empty local notebook, and `bootFailure`
  writes one set of sentences rather than choosing between two.
- Do not soften a boot failure into one message. A generation that is missing
  and one that is unreachable say which, because a retry fixes the second and
  never the first (`boot-failure.ts`).
- Do not put the generation back in the URL, and do not add a picker. Nobody
  chose that number and no link carries it. When importing a replica ships, an
  import ends in a document reload and a device holding an older number is told
  a newer one exists (ADR-0281); neither is a route parameter.
- Do not add a `#platform/*` seam for data. `#platform/epicenter` selects the
  RUNTIME the handle is built over, which is a keychain and a Bun-owned file;
  every build opens its own store either way, and a seam over the data is the
  thing ADR-0226 refused.
- Do not write a note's `title` or `updatedAt` from anywhere but
	  `notes.openContent`'s subscription. The store writes no derived fields and no
	  timestamps (ADR-0297), so those are Honeycrisp's, hung on the content node's
	  own edit signal and coalesced. A second writer would fight it.
- Do not leave `openContent`'s `close` uncalled. Nothing is loaded any more, so
  there is no document to leak; what leaks is the derivation subscription, and
  two of them on one note write the row twice per keystroke.
