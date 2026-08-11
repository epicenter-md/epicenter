# Honeycrisp App

Local-first notes SPA. Folders and notes are rows in one Yjs document, and each
note's prose is an application-named root inside that note's own container. The
one application running on the store today, so it is also the reference for how
an app is built.

Design authority: [ADR-0226](../../docs/adr/0226-a-host-serves-bundles-and-brokers-credentials-it-owns-no-application-data.md) (a host serves bundles and brokers credentials and owns no application data), [ADR-0225](../../docs/adr/0225-a-store-authority-is-one-durable-object-per-principal-and-application-and-being-signed-in-is-the-sharing-model.md) (one authority per principal and application; being signed in is the sharing model), [ADR-0215](../../docs/adr/0215-an-application-is-one-document-and-a-row-owns-a-nested-container.md) (an application is one document and a row owns a nested container), [ADR-0233](../../docs/adr/0233-a-browser-application-keeps-a-private-document-and-one-workspace-replica-per-account.md) (a device document and one account replica per account, chosen by auth at boot), [ADR-0231](../../docs/adr/0231-rebuilding-replaces-a-workspaces-current-yjs-document.md) (rebuild replaces the workspace's current Yjs document).

## Two durable documents, and auth picks one at boot

`src/lib/application.ts` is the only place that opens a store, and it opens
exactly one (ADR-0233):

```text
epicenter/so.epicenter.honeycrisp/device                     signed out, never syncs
epicenter/so.epicenter.honeycrisp/account/<principal id>     one per account
```

Signed out (or a build with no auth) opens the device document and attaches no
sync. A known principal, `signed-in` or `reauth-required`, opens that account's
own replica and attaches sync. A page lifetime is one auth generation
(ADR-0232), so the choice never changes while the app lives; `reloadOnAuthChange`
starts the next one.

A signed-in workspace is unavailable until its first bootstrap binds it to an
authority document, so the layout's boot gate holds while it waits. Signing out
closes a replica and keeps it, so signing back in finds the same account's work.

## Three builds, one store shape

| Build | Command |
|---|---|
| Web | `bun run build` |
| Standalone desktop | `bun run tauri build` |
| Epicenter-hosted | `bun run build:epicenter` |

**They differ in nothing that concerns data.** Every build calls
`open` from `@epicenter/data/browser` and owns its replica; the desktop host
serves the bundle and brokers the credential and owns none of it (ADR-0226).
There used to be a platform seam where the hosted build reached the host's
shared `epicenter.sqlite3`, and ADR-0226 refused it.

What remains behind `#platform/*` is auth and instance only: how a build gets a
bearer, not where its data lives. `src/lib/platform-selection.test.ts` reads the
declarations and names a broken seam, and
`../epicenter/scripts/build-applications.test.ts` runs the real build and reads
the emitted bytes. `typecheck` runs all three conditions; only the default one
is checked by an editor.

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
