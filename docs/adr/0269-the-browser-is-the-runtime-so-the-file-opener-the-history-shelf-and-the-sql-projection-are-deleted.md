# 0269. The browser is the runtime, so the file opener, the history shelf, and the SQL projection are deleted

- **Status:** Accepted
- **Date:** 2026-08-26
- **Amends:** [ADR-0229](0229-a-lens-names-the-store-it-opens-and-opening-is-one-call.md) at the set of openers: `open` answers at `@epicenter/data/browser` and nowhere else, and the memory opener is named test support rather than a second runtime.
- **Amends:** [ADR-0214](0214-one-sqlite-file-holds-the-update-log-and-the-projection-and-history-lives-outside-the-crdt.md) by deleting its history half: `history.sqlite3` and the `_history` relation are gone, and collapse simply supersedes.
- **Amends:** [ADR-0241](0241-a-store-is-truth-plus-debts-and-sql-is-a-composed-follower.md) at the shipped follower: SQL is still a composed follower and never a store verb, but the package no longer ships one.
- **Relates:** [ADR-0226](0226-the-host-serves-bundles-and-brokers-credentials-and-owns-no-application-data.md) and [ADR-0227](0227-one-runtime-a-desktop-spa-in-a-webview-over-a-client-owned-store.md) (the runtime bet this record spends), [ADR-0268](0268-a-row-exports-as-one-markdown-file-and-its-codec-is-mandatory.md) (what a person reads instead of SQL).

## Context

ADR-0227 made the runtime one thing: a desktop SPA in a WebView over a client-owned store. The store package had not spent that bet. It still carried three surfaces kept alive for runtimes and habits that no longer exist:

- A **Bun file opener** (`open(definition, { root })`, plus `discard` and a `keepHistory` switch), with no production caller in the repository and none coming. The comment on it said as much and kept it anyway, on the grounds that it was the only opener proving the log survives a real reopen from a real file.
- A **history shelf**: `history.sqlite3` beside the live file, and the `_history` relation inside it, into which collapse copied every update it was about to supersede (ADR-0214). Nothing has ever read a byte of it: no verb, no test, no application, no tool.
- A **SQL projection package** (`@epicenter/data/projection`), an in-memory SQLite rebuilt from the live document at the next read (ADR-0241). Zero application callers since it shipped. It also carried the load of proving the follower seam was complete.

Each was individually defensible and collectively a second store: a second durability path to keep correct, a second write on every collapse, and a second read surface whose vocabulary leaked into the prose of files that do not depend on it.

## Decision

**The browser opener is the only opener.** An application opens `openDevice` or `openAccount` from `@epicenter/data/browser`. A process that needs to open a person's store on disk earns its own named opener at the moment it exists; it does not inherit one kept warm for it.

**Test support is named test support.** `@epicenter/data/memory` gives `openMemory(definition)` and `createMemoryRecord()`. The record is the one thing a file gave a test that memory did not: a close and a reopen of the same stored bytes, which is the shape of a release upgrade (ADR-0240) and of any claim that something survives rather than merely exists. The construction seam at `@epicenter/data/engine` is unchanged and still takes a synchronous SQLite the caller owns, which is what the workerd fixtures and benches run on.

**Collapse supersedes, and keeps no shelf.** A chain that reaches the fold threshold is replaced by one baseline carrying the same state, so what collapse deletes is superseded rather than lost. `DurableOp` loses `takenAt`, which existed only to stamp a shelf entry.

**SQL is a follower nobody has composed, so the package ships none.** The seam is unchanged and the phase-order contract that makes a follower possible (`onCommitted` before table invalidations) is still a contract. What is deleted is the one implementation and its entry point. Its second job, standing as proof that the seam is complete, passes to the export (ADR-0268): the export reads the same public surface, though as a one-shot read rather than a subscription, so with the projection gone `onCommitted` has no in-repo consumer at all. It stays as the documented seam and as the reason the flush is phase-ordered; a follower that wants it does not have to negotiate for it.

**The SQL-safe name grammar stays.** Table and field names remain bare identifiers with the SQLite-keyword refusal intact. It costs a parse rule, it keeps a future follower buildable, and it is what makes the export's folder and frontmatter names safe by construction.

## Consequences

- One durability path in the package instead of two, and one fewer write per collapse.
- Inspecting a workspace outside its application is reading the export: `kv.json` and one Markdown file per row (ADR-0268). That is what the answer to "files or SQL" was.
- The three test files outside the package that opened a store on disk now open a memory record. The invariants the file tests held are ported to the browser opener rather than dropped: a definition that will not parse releases the address it claimed, a corrupt durable record refuses the boot and releases the claim, and a row's document comes back from storage with what was typed into it.
- Reverting any of the three is a revert, not a rewrite. That is the whole reason to delete rather than deprecate.
- `pressure()` stays for now. It is the only instrument that can check a compaction claim, and import (ADR-0267) is about to make one.

## Considered alternatives

- **Keep the file opener for tests.** Rejected: it is a published entry point of an MIT package, so keeping it for test convenience publishes a runtime story that is not true. The reopen it uniquely bought is what `createMemoryRecord` gives without a file.
- **Keep the history shelf behind a default-off switch.** Rejected: an unread relation with a switch is worse than an unread relation, because now there are two states to reason about and still no reader.
- **Deprecate the projection instead of deleting it.** Rejected: a package with no callers has nothing to deprecate for, and Git keeps the body recoverable.
- **Delete the SQL-safe name grammar with the projection.** Rejected: the export's layout depends on those names being path-safe and YAML-safe, and the rule is one parse check.
