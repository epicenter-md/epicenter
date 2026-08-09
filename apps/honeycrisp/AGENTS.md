# Honeycrisp App

Local-first notes SPA. Folders and notes are rows in one Yjs document, and each
note's prose is an application-named root inside that note's own container. The
one application running on the store today, so it is also the reference for how
an app is built.

Design authority: [ADR-0226](../../docs/adr/0226-a-host-serves-bundles-and-brokers-credentials-it-owns-no-application-data.md) (a host serves bundles and brokers credentials and owns no application data), [ADR-0225](../../docs/adr/0225-a-store-authority-is-one-durable-object-per-principal-and-application-and-being-signed-in-is-the-sharing-model.md) (one authority per principal and application; being signed in is the sharing model), [ADR-0215](../../docs/adr/0215-an-application-is-one-document-and-a-row-owns-a-nested-container.md) (an application is one document and a row owns a nested container).

## Three builds, one store shape

| Build | Command |
|---|---|
| Web | `bun run build` |
| Standalone desktop | `bun run tauri build` |
| Epicenter-hosted | `bun run build:epicenter` |

**They differ in nothing that concerns data.** Every build calls
`openBrowserStore` and owns its replica; the desktop host serves the bundle and
brokers the credential and owns none of it (ADR-0226). There used to be a
platform seam where the hosted build reached the host's shared
`epicenter.sqlite3`, and ADR-0226 refused it.

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
- Do not add a `#platform/*` seam for storage. Every build opens its own store;
  a seam there is the thing ADR-0226 refused.
- Do not reach a root inside a note's document lazily. Root names are declared
  at `create` time, because two devices first-opening one note would otherwise
  each mint their own and lose one.
