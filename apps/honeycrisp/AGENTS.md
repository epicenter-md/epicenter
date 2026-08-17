# Honeycrisp App

Local-first notes SPA. Folders and notes are rows in one Yjs document, and each
note's prose is an application-named root inside that note's own container. The
one application running on the store today, so it is also the reference for how
an app is built.

Design authority: [ADR-0226](../../docs/adr/0226-a-host-serves-bundles-and-brokers-credentials-it-owns-no-application-data.md) (a host serves bundles and brokers credentials and owns no application data), [ADR-0225](../../docs/adr/0225-a-store-authority-is-one-durable-object-per-principal-and-application-and-being-signed-in-is-the-sharing-model.md) (one authority per principal and application; being signed in is the sharing model), [ADR-0215](../../docs/adr/0215-an-application-is-one-document-and-a-row-owns-a-nested-container.md) (an application is one document and a row owns a nested container), [ADR-0233](../../docs/adr/0233-a-browser-application-keeps-a-private-document-and-one-workspace-replica-per-account.md) (a device document and one account replica per account, chosen by auth at boot), [ADR-0231](../../docs/adr/0231-rebuilding-replaces-a-workspaces-current-yjs-document.md) (rebuild replaces the workspace's current Yjs document).

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
`{ device, account: { data, syncStatus, rebuild } }`, and they stop at the
layout's provider. `createHoneycrisp` (`src/lib/honeycrisp/index.ts`) turns
one generation's databases into the reactive application object the UI
consumes: it makes the document choice (`account?.data ?? device`) visible
once, adapts that document into Svelte-reactive named tables with
`fromWorkspace` (from `@epicenter/svelte`), layers Honeycrisp's domain
operations, search, and `view` navigation on top, and exposes only the narrow
capabilities the UI needs (`pressure()`, `account.syncStatus`,
`account.rebuild`). Components reach it through `getHoneycrisp()`; the raw
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
- Do not reach a root inside a note's document lazily. Root names are declared
  at `create` time, because two devices first-opening one note would otherwise
  each mint their own and lose one.
