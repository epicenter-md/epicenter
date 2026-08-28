# Honeycrisp App

Local-first notes SPA. Folders and notes are rows in one Yjs document, and each
note's prose lives in that note's own independent Yjs document, opened on
demand at the row's derived address (ADR-0248). The one application running on
the store today, so it is also the reference for how an app is built.

Design authority: [ADR-0226](../../docs/adr/0226-a-host-serves-bundles-and-brokers-credentials-it-owns-no-application-data.md) (a host serves bundles and brokers credentials and owns no application data), [ADR-0225](../../docs/adr/0225-a-store-authority-is-one-durable-object-per-principal-and-application-and-being-signed-in-is-the-sharing-model.md) (one authority per principal and application; being signed in is the sharing model), [ADR-0248](../../docs/adr/0248-a-row-owns-an-independent-yjs-document-at-a-derived-address.md) (a row owns an independent Yjs document at a derived address), [ADR-0261](../../docs/adr/0261-a-local-account-replica-is-addressed-by-its-application-server-url-and-verified-principal.md) (a retained replica is qualified by its application, server URL, and verified principal), [ADR-0256](../../docs/adr/0256-automatic-folding-is-the-current-maintenance-path-and-manual-workspace-compaction-is-deferred.md) (automatic folding is current; manual workspace compaction is deferred).

## Two durable documents, and routes open one

`src/lib/databases.ts` is the only place that opens a store. The `/device`
route opens the local database, while `/account` gates auth and opens the
account replica. Each route owns exactly one store lifetime (ADR-0261):

```text
epicenter/so.epicenter.honeycrisp/device                     never syncs, always open
epicenter/so.epicenter.honeycrisp/account/<base URL>/<principal id> one per server identity
```

`createHoneycrisp` turns the one route-owned data capability into the reactive
application object the UI consumes. It adapts that document into
Svelte-reactive named tables with `fromData` (from `@epicenter/svelte`), layers
Honeycrisp's domain operations, search, and URL navigation on top, and exposes
no database identity or fallback. Components reach it through
`getHoneycrisp()`; raw stores never cross that boundary. Account sync status is
passed separately by the account route for the sidebar's status line.

A fresh account replica is unavailable until its first bootstrap binds it to an
authority document, so `/account` shows its loading gate while it waits. The
device route is independent and never waits on account binding. A permanent
credential refusal stays on `/account` and offers reconnection; it never falls
back to device data. Importing between the two documents is deliberately
deferred as a future explicit application feature.

## Three builds, one store shape

| Build | Command |
|---|---|
| Web | `bun run build` |
| Standalone desktop | `bun run tauri build` |
| Epicenter-hosted | `bun run build:epicenter` |

**They differ in nothing that concerns data.** Every build calls
`openLocal` and `openAccount` from `@epicenter/data/browser` and owns its
documents; the desktop host
serves the bundle and brokers the credential and owns none of it (ADR-0226).
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
- Do not fall back to the local document when a workspace cannot open.
  A signed-in generation with no usable principal, or one whose dial is
  permanently denied before its first bootstrap, is unavailable and says so.
- Do not add a `#platform/*` seam for storage. Every build opens its own store;
  a seam there is the thing ADR-0226 refused.
- Do not hold a note's document open past the surface that opened it. The pane
  owns the handle: dispose on note switch and unmount, so the store can unload
  the document. Minting the `body` root on first open is safe (a top-level
  root is addressed by its name, ADR-0248); leaking handles is the hazard now.
