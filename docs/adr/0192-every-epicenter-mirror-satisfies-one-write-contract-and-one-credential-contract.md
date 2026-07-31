# 0192. Every Epicenter mirror satisfies one write contract and one credential contract

- **Status:** Accepted
- **Date:** 2026-07-31
- **Relates:** [ADR-0063](0063-the-local-books-mirror-is-a-multi-writer-cache-made-safe-by-one-monotonic-write-door.md) (the monotonic write door this generalizes), [ADR-0062](0062-local-books-stores-oauth-tokens-in-a-single-0600-file.md) (the credential file this generalizes), [ADR-0064](0064-the-local-books-mirror-keeps-one-realm-cdc-cursor-table-existence-is-the-per-entity-init-latch.md) (cursor and init-latch discipline), [ADR-0061](0061-local-books-reads-facts-from-the-mirror-reports-live-and-writes-through-one-approved-verb.md) (facts from the mirror, opinions live, one approved write verb), [ADR-0098](0098-local-mail-state-round-trips-through-gmail.md) (upstream owns truth; the mirror is disposable), [ADR-0082](0082-local-mail-syncs-by-push-free-history-list-polling.md) (poll-only, write-through), [ADR-0081](0081-per-upstream-oauth-concurrency-decides-mirror-topology.md) (per-device grant and mirror), [ADR-0188](0188-gmail-app-identity-belongs-to-the-distribution-and-no-epicenter-server-enters-the-gmail-path.md) (device-only credential boundary, generalized in clause F), [ADR-0072](0072-local-books-ships-as-a-standalone-cli-the-daemon-surface-is-deferred.md) (a mirror need not run inside Epicenter), [ADR-0191](0191-the-epicenter-host-process-owns-the-mail-engine-and-its-sync-loop.md) (a mirror may be opened by the Epicenter host)

## Context

Epicenter has two upstream mirrors, Local Mail and Local Books, built about a month apart, and a third is planned. They converged independently on the same shape: thirteen source files share a name and a role, `token-manager.ts` exports the same three symbols on both sides, and `interruptibleSleep` is byte-identical.

They did not converge on the same invariants. Local Books learned a monotonic write door from two real concurrency bugs (ADR-0063): a `SQLITE_BUSY` that reported an already-committed upstream write as a failure, and a stale fold-back silently regressing a row the sync had just refreshed. Local Mail has the same pragmas and the same immediate transactions, but no such door, and its write-through fold takes no lock.

That is the actual cost of running two mirrors: not duplicated lines but **duplicated decisions, unevenly applied**. An expensive lesson learned in one mirror did not reach the other, and nothing in the tree said it should have.

Extracting a shared package would not by itself have prevented this. The divergence is about what the contract requires, not about who owns the function. The contract is also the smaller and more durable artifact: roughly 400 to 600 lines are genuinely common across two apps of 56 and 58 TypeScript files, while the rest is irreducibly provider-specific (Gmail history folding and MIME extraction; QuickBooks entity definitions, reports, and per-entity required update fields).

So this record decides the contract. Whether a package implements it is a separate decision, deliberately not made here.

## Decision

**A mirror is a disposable local projection of an upstream that owns truth. Every Epicenter mirror satisfies the following, whichever process opens it and whether or not that process is Epicenter.**

**A. The mirror is disposable.** Nothing human-meaningful exists only in it. It can be deleted and rebuilt from the upstream at any time. A schema change is a version bump that rebuilds; there are no migration readers, because there is no data to preserve.

**B. One write contract.** WAL, a non-zero `busy_timeout`, and `synchronous = NORMAL`. Write transactions begin immediate. Every upsert passes a monotonic door keyed on a per-record version the upstream supplies, and **degrades explicitly to last-writer-wins when the upstream supplies none**. A read-only connection never migrates, never drops, and never writes.

**C. Write-through, never write-to-mirror.** The durable effect goes upstream first; its response folds back best-effort. A failed fold defers to the next sync and is never reported to the caller as a failed write, because the write succeeded. The mirror is never the write authority.

**D. One sync owner per principal.** Reads are lock-free, because WAL admits many readers. A second sync attempt yields rather than racing a bulk pull against a shared cursor.

**E. One credential contract.** One `0600` file at the data-dir root, never inside a mirror directory, so a read-only SQL surface cannot read credentials. Validation happens at the file-read boundary; memory holds a typed store. Refresh is coalesced, rotated tokens persist, and a dead grant surfaces as one `ReauthRequired` regardless of how the upstream reveals it.

**F. No Epicenter server in the upstream path.** Authorization, exchange, refresh, API calls, and tokens are device-local. This generalizes ADR-0188 clause 5 from Gmail to every upstream.

**G. One directory per upstream principal.** `0700` directories, `0600` files. What a principal is (a mailbox, a realm, a company) is the provider's to name; that there is exactly one mirror and one credential entry per principal is not.

### The asymmetric refusals

- **Refuse migration readers.** Clause A makes them unnecessary, and they are the single largest source of long-lived complexity in local stores: every past shape stays alive in a reader forever. A version bump that drops and re-pulls costs one sync and deletes that entire family.
- **Refuse a mirror-first write.** It is the one shortcut that would make the mirror an authority, and every reconciliation bug downstream follows from it. Writing upstream first is what keeps the mirror disposable and keeps a failed fold self-healing.
- **Refuse provider quirk flags in the shared contract.** Where two upstreams differ, the difference is expressed as data or as a provider decision, never as a branch the contract has to know. The two live examples: a missing per-record version is an absent ordering key, which clause B already degrades on; a refresh token that dies silently versus one with a declared expiry is the provider choosing when to answer `ReauthRequired`, not a mode the kernel selects.
- **Refuse a shared credential store across principals.** Per-principal grants are what make ADR-0081's independent-per-device topology work; one store keyed by many principals invites cross-principal replay.

## Consequences

- **The third mirror is correct by review, not by inheritance.** Photos, Plaid, or anything else can be written against this list before a line of shared code exists.
- **Known non-conformance, tracked rather than quietly fixed: Local Mail does not satisfy clause B's monotonic door.** Its message upsert has no conflict guard, and its write-through fold is lock-free, so a fold can regress a row the sync just refreshed, with the cursor already advanced past the reconfirming event. The fix is not a copy of Local Books': QuickBooks exposes a per-record `SyncToken` and `LastUpdatedTime`, and **Gmail exposes no per-record version at all** (`internalDate` is receipt time and does not move when a label changes). So Mail must either store an explicit ordering key or take the sync lock for the fold. That is a real design question and it belongs in its own change.
- **This costs a document, not a migration.** Local Books has been through four collapse passes and is at floor; nothing here asks it to move.
- **Downstream and not decided here:** whether an `@epicenter/mirror` package implements this contract. That decision should wait for a third provider, because the two present ones disagree on the hardest question in the design (per-record versioning), and a two-sample abstraction would encode that disagreement as configuration.

### Conformance check for a new mirror

A mirror conforms when all of these are observably true:

1. Deleting the store and re-syncing loses nothing a human authored.
2. A schema-version mismatch rebuilds; no code reads an older shape.
3. Two concurrent writers cannot regress a row, or the store documents that its upstream offers nothing to order on.
4. Killing the process mid-sync leaves a store that the next sync repairs without a flag.
5. An upstream write that succeeds is reported as success even when the local fold fails.
6. Two sync attempts for one principal never both pull.
7. Credentials are unreadable from the mirror's own read-only SQL surface.
8. No request to the upstream carries an Epicenter origin.

## Considered alternatives

- **Extract `@epicenter/mirror` now.** Rejected for the moment: two samples, and they disagree precisely where the abstraction is hardest. The contract is the part that is stable today; the code is not. Revisit at the third provider.
- **Make mirroring a capability of the Epicenter host, beside recording and transcription.** Rejected: ADR-0072 made Local Books a standalone dependency-light CLI on purpose, and ADR-0073 chose stdio MCP precisely so financial data never reaches the relay. Host-owned mirroring would trade a product decision for an implementation convenience. Local Mail being host-opened (ADR-0191) is a property of Mail, not of mirrors.
- **Fold mirrors into the Epicenter replica plane.** Rejected: the replica converges edits between peers, while a mirror has one upstream owner and is disposable (ADR-0098). Adding a convergence model to data with a single authority buys nothing and costs a great deal.
- **Do nothing and let each mirror choose.** Rejected: that is the status quo, and it already produced a divergence in the one invariant that protects against silent data loss.
