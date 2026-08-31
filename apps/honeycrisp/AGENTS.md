# Honeycrisp App

Local-first notes SPA. Folders and notes are rows in one Yjs document, and each
note's body is the node on its note row inside that same document
(ADR-0295, ADR-0309). The one application running on the store today, so it is also the
reference for how an app is built.

Design authority: [ADR-0226](../../docs/adr/0226-a-host-serves-bundles-and-brokers-credentials-it-owns-no-application-data.md) (a host serves bundles and brokers credentials and owns no application data), [ADR-0225](../../docs/adr/0225-a-store-authority-is-one-durable-object-per-principal-and-application-and-being-signed-in-is-the-sharing-model.md) (one authority per principal and application; being signed in is the sharing model), [ADR-0295](../../docs/adr/0295-a-database-is-one-yjs-document-and-a-row-holds-its-rich-content.md) (a database is one Yjs document and a row holds its rich content), [ADR-0292](../../docs/adr/0292-a-database-opens-an-exact-generation-cache-first-and-bootstraps-account-misses.md) (a database opens an exact generation cache-first), [ADR-0261](../../docs/adr/0261-a-local-account-replica-is-addressed-by-its-application-server-url-and-verified-principal.md) (a retained replica is qualified by its application, server URL, and verified principal), [ADR-0256](../../docs/adr/0256-automatic-folding-is-the-current-maintenance-path-and-manual-workspace-compaction-is-deferred.md) (automatic folding is current; manual workspace compaction is deferred).

## A generation is the address, and a route resolves it once

`src/lib/databases.ts` is the only place that opens a store, and every open
takes an EXACT generation (ADR-0292). `/device` and `/account` resolve one and
redirect; `/device/[generation]` and `/account/[generation]` open it.

```text
epicenter/v3/so.epicenter.honeycrisp/local/gen/<n>
epicenter/v3/so.epicenter.honeycrisp/account/<base URL>/<principal id>/gen/<n>
```

`resolveLocalGeneration` takes the newest copy this device holds and imports an
empty one if it holds none; `resolveAccountGeneration` takes the newest local
copy and otherwise asks the account which exist. Only the local resolver ever
CREATES one: an account generation is the account's, and a device arriving
second must not invent a history for it.

Opening is cache-first and never waits on a socket. A device holding a copy is
usable offline; one that holds none of an account's fetches the generation
whole before returning, so a fresh account never renders empty while its state
is arriving.

`createHoneycrisp` turns the one route-owned data capability into the reactive
application object the UI consumes. It adapts that document into
Svelte-reactive named tables with `fromData` (from `@epicenter/svelte`), layers
Honeycrisp's domain operations, search, and URL navigation on top, and exposes
no database identity or fallback. Components reach it through
`getHoneycrisp()`; raw stores never cross that boundary. Account sync status is
passed separately by the account route for the sidebar's status line.

A permanent credential refusal costs sync, not the notes: the store opened
from local state before a socket was attempted, and the sidebar's status line
goes quiet. It never falls back to device data. Importing between the local
and account databases is deliberately deferred as a future explicit feature.

## Three builds, one store shape

| Build | Command |
|---|---|
| Web | `bun run build` |
| Standalone desktop | `bun run tauri build` |
| Epicenter-hosted | `bun run build:epicenter` |

**They differ in nothing that concerns data.** Every build calls
`openDatabase` from `@epicenter/data/browser` and owns its databases; the
desktop host serves the bundle and brokers the credential and owns none of it
(ADR-0226).
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
- Do not copy, merge, or promote the local document into an account replica,
  in either direction. Nothing in sync may name the local document; a copy
  action, if the product ever wants one, is an explicit application feature.
- Do not fall back to the local database when an account one cannot open. A
  signed-in generation with no usable principal says so; one that is missing
  or unreachable says which, because a retry fixes the second and never the
  first (`boot-failure.ts`).
- Do not open a generation the route did not resolve. A number in a URL is an
  address, not an instruction to allocate: `openDatabase` refuses a miss with
  `GenerationNotFound` rather than inventing an empty database at whatever
  somebody typed.
- Do not add a `#platform/*` seam for storage. Every build opens its own store;
  a seam there is the thing ADR-0226 refused.
- Do not write a note's `title` or `updatedAt` from anywhere but
	  `notes.openContent`'s subscription. The store writes no derived fields and no
	  timestamps (ADR-0297), so those are Honeycrisp's, hung on the content node's
	  own edit signal and coalesced. A second writer would fight it.
- Do not leave `openContent`'s `close` uncalled. Nothing is loaded any more, so
  there is no document to leak; what leaks is the derivation subscription, and
  two of them on one note write the row twice per keystroke.
