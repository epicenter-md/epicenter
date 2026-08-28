# 0275. A browser store's durable record is SQLite over OPFS, in a worker

- **Status:** Accepted
- **Date:** 2026-08-27
- **Provisional number.** Reconcile this number at merge time according to [the ADR numbering rule](README.md).
- **Amends:** [ADR-0233](0233-a-browser-application-keeps-a-private-document-and-one-workspace-replica-per-account.md) and [ADR-0261](0261-a-local-account-replica-is-addressed-by-its-application-server-url-and-verified-principal.md) at the storage medium only. Both addresses stay exactly as they are; what changes is what holds the bytes at that address.
- **Amends:** [ADR-0238](0238-the-live-document-is-the-truth-while-open-and-persistence-is-a-visible-debt.md) at one clause. Its acceptance-and-durability split, its observable queue, and its whole-queue flush all stand; what it decided and this withdraws is that "browser durability moves into IndexedDB directly."
- **Relates:** [ADR-0227](0227-one-runtime-a-desktop-spa-in-a-webview-over-a-client-owned-store.md) (one target, which is why there is no seam), [ADR-0272](0272-restore-replaces-a-workspace-from-an-artifact-under-a-new-document-identity.md) (the recovery path if a record is ever lost), [ADR-0271](0271-a-workspace-mirrors-continuously-to-the-epicenter-folder-one-way.md) (the projection, which is not the original).
- **Unbuilt.** `packages/data/src/store/browser.ts` still opens IndexedDB. The evidence below was gathered by probe, not by shipping.

## Context

The store does not know what it is stored in. `DurablePort` is three methods,
`commit`, `readDocument`, and `listDocuments`, and `packages/sqlite` already
ships three adapters behind one `SqliteDatabase` interface: Bun, a Durable
Object, and the browser. So the medium is a runtime's choice, not the store's.

The browser opener chose IndexedDB, and it is the only DurablePort
implementation that is not the SQLite log every other runtime uses. That
duplication is the smallest of its three problems.

**IndexedDB permits two writers.** Nothing stops two contexts opening one
database, and two live `Y.Doc`s over one record diverge in memory while both
persist. The store guards this with `claims.ts`, a module-level `Set` claimed
in two openers and released at eight sites; miss one release and the address is
un-openable for the life of the process, with no diagnostic.

**IndexedDB is evictable.** It is browser-managed storage subject to reclamation
under pressure, and the `local` place has no authority to refill from.

**IndexedDB is invisible.** Not a defect on its own, because the readable copy
is the projection (ADR-0271) and the data root is machinery by design. It
matters only in combination with eviction: a record that can vanish and cannot
be inspected or backed up is a worse original than one that cannot vanish.

## Decision

**A browser store's durable record is a SQLite database over OPFS, opened
through the `opfs-sahpool` VFS inside a dedicated worker.**

`packages/sqlite`'s browser adapter drives it, so the store runs the same
`log.ts` DurablePort implementation the Bun and Durable Object runtimes already
use. `openIdbBacking`, `openIndexedDb`, the version-upgrade path, the
`onblocked` handling, and the IndexedDB half of `deleteSupersededStorage` are
deleted.

**The worker is not optional and it is not COOP/COEP.** Measured:
`FileSystemFileHandle.prototype.createSyncAccessHandle` is `undefined` on the
main thread and a function inside a dedicated worker. What `opfs-sahpool`
avoids is `SharedArrayBuffer`, and with it the cross-origin-isolation headers
the async `opfs` VFS would impose on the whole Epicenter origin that every app
window shares.

**Exclusivity stops being a convention and becomes a filesystem fact.** A sync
access handle is an exclusive lock, so a second context cannot open the same
record. `claims.ts`, `StoreError.AlreadyOpen`, and all eight release sites are
deleted, and what replaces them is the operating system refusing a handle.

**No platform seam.** ADR-0227 refused the browser as a product target, so a
`#platform/*` split here would build and maintain a second implementation for a
runtime that does not ship. One adapter, chosen because it is the one that
runs. A Tauri-native SQLite would be a fourth adapter behind the same
`SqliteDatabase` interface on the day a second target earns one.

## Evidence

Probed on both engines through Playwright, in a dedicated worker, against
`@sqlite.org/sqlite-wasm@3.53.0-build1`. The script is
`.context/probe/opfs-probe.ts`.

```txt
                                Chromium            WebKit
                                (~ WebView2)        (~ WKWebView, macOS)

  createSyncAccessHandle        function            function      in a worker
                                undefined           undefined     on the main thread
  installOpfsSAHPoolVfs         installed           installed
  survives a full relaunch      rows 1 -> 2         rows 1 -> 2
  a second context              REFUSED             REFUSED
                                "another open        "The object is in
                                 Access Handle"       an invalid state"
  navigator.storage.persist()   false               false         see below
```

Durability was measured by writing a row, closing the persistent context
entirely, relaunching it against the same profile, and finding the row still
there.

## The one fact this record does not have

`persist()` returned false on both engines, in a headless automation profile
with no engagement history. That is the expected answer there and it says
nothing about a packaged application, which browsers grant persistence to on
engagement or installed-app heuristics. It is one line to check in a real Tauri
window and it has not been checked.

Its consequence is bounded, and both branches are acceptable:

```txt
  granted   OPFS is exempt from reclamation.
            `~/Epicenter` stays a pure projection and `rm -rf` on it
            loses nothing, exactly as ADR-0271 says.

  denied    a record can be reclaimed under storage pressure.
            the projection is then also the recovery path, through the
            restore ADR-0272 already defines, and that promotion must be
            said out loud rather than discovered: a person deleting
            `~/Epicenter` would be removing a safety net nobody told them
            about.
```

Check it before the switch, and if it is denied, record the promotion in
ADR-0271 rather than leaving the folder quietly load-bearing.

## Consequences

- One DurablePort implementation across every runtime. The browser stops being
  the exception.
- One writer per record, enforced by the filesystem. The refusal a second
  context gets is a specific, catchable error, so the application can say
  "Honeycrisp is already open in another window" instead of failing generically.
- SQLite moves off the main thread, which the previous design did not do.
- `packages/sqlite/src/browser.ts` documents an assumption that dies here:
  *"The one database this adapter ever wraps is a `:memory:` projection cache
  with a single connection for its whole life."* Its `transaction` reasoning
  rests on that sentence and must be revisited with it.
- The switch reads every existing IndexedDB chain once and writes it through
  the port. That is the only step in this record that can lose data, and the
  projection gives it an unusual check: `~/Epicenter/local/<databaseId>/` already
  holds every row as Markdown rendered from that same store, so a migration can
  be verified against it rather than trusted.
- `bun dev:<app>:ui` is unaffected, because nothing here needs a host. This is
  the one respect in which OPFS beats moving durability to the host.

## Considered alternatives

- **Host SQLite over a loopback route.** Genuinely durable, inspectable, and the
  host would hold the file descriptor, so single-writer would be OS-enforced
  there too. Refused for three reasons: it needs a transport where this needs
  none; it adds the one HTTP route that carries a person's original data rather
  than a rendering of it, which is a write path with a real blast radius; and
  the visibility it buys is already provided by the projection, which is what
  the data root and the folder root exist to separate. Reconsider only if
  `persist()` is denied and eviction turns out to be reachable in practice.
- **The async `opfs` VFS.** Multi-context and SQLite does its own locking, at
  the price of `SharedArrayBuffer` and therefore COOP/COEP headers on the shared
  Epicenter origin. Refused: a storage decision must not impose a header policy
  on every app window, and multi-context is a capability this runtime does not
  want.
- **A SharedWorker owning the database.** A whole message protocol, plus uneven
  WebView support, to permit two windows of one application. One window per
  application is already the model.
- **Web Locks so a second context waits instead of failing.** Reconsider only if
  two windows of one application ever becomes a product goal. Today the second
  context should fail, loudly, before anything is edited.
- **Keep IndexedDB.** Zero work, and it keeps two implementations, silent
  divergence between two writers, and a record that can be reclaimed. The status
  quo is the least safe option in the list.
