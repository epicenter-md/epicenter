# Honeycrisp App

Local-first notes SPA. Folders and notes are rows in one Yjs document, and each
note's prose lives in that note's own independent Yjs document, opened on
demand at the row's derived address (ADR-0248). The one application running on
the store today, so it is also the reference for how an app is built.

Design authority: [ADR-0226](../../docs/adr/0226-a-host-serves-bundles-and-brokers-credentials-it-owns-no-application-data.md) (a host serves bundles and brokers credentials and owns no application data), [ADR-0225](../../docs/adr/0225-a-store-authority-is-one-durable-object-per-principal-and-application-and-being-signed-in-is-the-sharing-model.md) (one authority per principal and application; being signed in is the sharing model), [ADR-0248](../../docs/adr/0248-a-row-owns-an-independent-yjs-document-at-a-derived-address.md) (a row owns an independent Yjs document at a derived address), [ADR-0233](../../docs/adr/0233-a-browser-application-keeps-a-private-document-and-one-workspace-replica-per-account.md) (a device document and one account replica per account, chosen by auth at boot), [ADR-0256](../../docs/adr/0256-automatic-folding-is-the-current-maintenance-path-and-manual-workspace-compaction-is-deferred.md) (automatic folding is current; manual workspace compaction is deferred).

## Two durable documents, and the root opens them

`src/lib/databases.ts` is the only place that opens a store. Every page
lifetime eagerly opens the device document, and a generation whose boot auth
carries a principal (`signed-in` or `reauth-required`) also opens that
account's retained replica and attaches sync to it alone (ADR-0233):

```text
epicenter/so.epicenter.honeycrisp/device                     never syncs, always open
epicenter/so.epicenter.honeycrisp/account/<principal id>     one per account
```

A generation's opened databases (`HoneycrispDatabases`) have exactly two
shapes: `{ device }` and
`{ device, account: { data, syncStatus } }`, and they stop at the
layout's provider. `createHoneycrisp` (`src/lib/honeycrisp/index.ts`) turns
one generation's databases into the reactive application object the UI
consumes: it makes the document choice (`account?.data ?? device`) visible
once, adapts that document into Svelte-reactive named tables with
`fromWorkspace` (from `@epicenter/svelte`), layers Honeycrisp's domain
operations, search, and `view` navigation on top, and exposes only the narrow
capability the UI needs (`account.syncStatus`). Components reach it through `getHoneycrisp()`; the raw
databases, store, and sync plane never cross that boundary. A page lifetime is one auth generation (ADR-0232),
so the composition never changes while the app lives; `reloadOnAuthChange`
starts the next one.

A signed-in account is unavailable until its first bootstrap binds it to an
authority document, so the layout's boot gate holds the whole app while it
waits, device data included; a partial-ready local-drafts state is refused,
and signing out (a new generation) is the way back to device-only use.
Signing out closes a replica and keeps it, so signing back in finds the same
account's work.

## Three builds, one store shape

| Build | Command |
|---|---|
| Web | `bun run build` |
| Standalone desktop | `bun run tauri build` |
| Epicenter-hosted | `bun run build:epicenter` |

**They differ in nothing that concerns data.** Every build calls
`openDevice` and `openAccount` from `@epicenter/data/browser` and owns its
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
- Do not copy, merge, or promote the device document into an account replica,
  in either direction. Nothing in sync may name the device document; a copy
  action, if the product ever wants one, is an explicit application feature.
- Do not fall back to the device document when a workspace cannot open.
  A signed-in generation with no usable principal, or one whose dial is
  permanently denied before its first bootstrap, is unavailable and says so.
- Do not add a `#platform/*` seam for storage. Every build opens its own store;
  a seam there is the thing ADR-0226 refused.
- Do not hold a note's document open past the surface that opened it. The pane
  owns the handle: dispose on note switch and unmount, so the store can unload
  the document. Minting the `body` root on first open is safe (a top-level
  root is addressed by its name, ADR-0248); leaking handles is the hazard now.
