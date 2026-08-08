# 0223. A synchronous store needs a runtime that can write durably without awaiting, and a browser page is not one

- **Status:** Accepted
- **Date:** 2026-08-08
- **Provisional number.** `main` ends at ADR-0205; 0206 through 0223 land with
  this branch. Reconcile at merge time (`docs/adr/README.md`).
- **Relates:** [ADR-0215](0215-an-application-is-one-document-and-a-row-owns-a-nested-container.md)
  (the synchronous surface this constrains),
  [ADR-0214](0214-one-sqlite-file-holds-the-update-log-and-the-projection-and-history-lives-outside-the-crdt.md)
  (the SQLite file a store needs),
  [ADR-0177](0177-a-browser-replica-is-owned-by-a-storage-partition-and-origin-pair.md)
  (a WebView is a storage partition and origin pair like any other).
- Evidence: `packages/data/evidence/browser/sync-access-handle.ts`.

## Context

ADR-0215 made the store synchronous end to end, and the reason is sound: the
application is one `Y.Doc` that was replayed in full before any handle existed,
so there is nothing left to load and no I/O to await. `packages/data/src/store`
delivers that. Nothing in its surface returns a promise.

Durability comes from a `SqliteDatabase` whose `run` and `transaction` RETURN
rather than resolve, and a failed write poisons the store, because memory and
storage have diverged and continuing would publish work that was never
committed. On Bun that contract is `bun:sqlite` and it holds trivially.

The plan to move Honeycrisp assumed a browser store was a matter of writing one,
and treated ADR-0214's deferral of it as a scheduling question. It is not. In a
browser, the only durable backing sqlite-wasm has is the origin private file
system, reached through `FileSystemFileHandle.createSyncAccessHandle`. Measured
in a real Chromium, on a secure origin, with the dedicated-worker arm as a
control that must succeed:

```txt
context           available  detail
main thread       false      createSyncAccessHandle is not a function
dedicated worker  true       9 bytes written
```

This repository already behaved as though that were true without having measured
it: `src/browser/worker.ts` installs the OPFS SAH pool inside a worker, and
`src/browser.ts` is the entirely asynchronous page proxy that arrangement forces.

A Tauri WebView is a browser (ADR-0177), so it is the same answer, not a way
around it.

## Decision

**A store runs where its durable storage can be written without awaiting.** That
is a property of the runtime, not a gap in the library, and it is the reason
there is one opener per runtime rather than one `epicenter.open({ path })` in
front of all of them.

**`openBunStore` is the only opener there will be until something decides how a
page gets a durable log.** Writing an `openBrowserStore` that opens `:memory:`
and calls it a store is refused: it would satisfy every type and lose a person's
notes on reload, which is the worst available failure because nothing reports it.

**A page that wants the synchronous surface must be a REPLICA of a durable store,
not an owner of one.** This is the one shape that keeps ADR-0215's surface
intact, and it needs no new machinery: a page holds `createStore` over an
in-memory SQLite and a `createSyncConnection` (ADR-0222) to a host that owns the
durable file. The page's SQLite is a cache of a document the host has, so losing
it on reload costs a re-sync rather than data, and every read stays synchronous
because reads come from the `Y.Doc` and the in-page projection.

Recording it as the shape rather than as the implementation, because it has not
been built and the thing it needs from a host has not been designed.

## Consequences

Honeycrisp cannot move onto the new store by swapping its opener, which is what
its plan assumed. What it needs first is a decision about who owns its durable
file on the desktop, and that is a host question rather than a store question.

Whispering, vocab, tab-manager and skills are all browser-surface applications on
the superseded stack, so the same constraint governs every one of their moves.
The superseded stack's asynchronous page proxy is not an accident of its age; it
is what owning durable browser storage costs.

`@epicenter/data`'s main export keeps pointing at the superseded stack for now.
Narrowing it to the new store would make the package's front door name something
no application in this repository can open.

The measurement is a property of the platform and belongs in a browser rather
than in a unit test, so it is a script with a control rather than a test. If a
browser ever exposes sync access handles to a page, that script says so and this
decision is worth reopening.
