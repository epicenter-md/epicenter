# 0170. Scalar settlement is a lower-bound Result

- **Status:** Proposed
- **Date:** 2026-07-19
- **Supersedes:** the settlement provisions of [ADR-0140](0140-open-workspaces-synchronize-automatically-and-callers-settle-one-watermark.md)
- **Relates:** [ADR-0169](0169-scalar-convergence-retains-one-bounded-deletion-and-retry-horizon.md) and [ADR-0182](0182-background-scalar-synchronization-owns-retries-and-reactive-status.md)

## Context

One caller's settlement attempt is distinct from background synchronization
status. The previous settlement outcome union duplicates Wellcrafted `Result`,
exposes internal retry state, and makes `caught-up` sound like an exact
authority snapshot.

## Decision

The public barrier is:

```ts
settle(): Promise<Result<void, SyncSettleError>>;
```

`SyncSettleError` is one flat Wellcrafted error namespace with actionable
`Offline`, `AuthenticationRequired`, `StorageLimit`, `UpgradeRequired`, and
`RecoveryRequired` variants. It does not wrap another outcome or pending-reason
union.

`settle()` synchronously captures the scalar admission cut visible at
invocation. It returns `Ok(undefined)` only after every scalar mutation in that
cut has been accepted and the replica has installed authority state through the
acceptance lower bound. Later local or remote changes do not extend the cut,
although their state may already be included when settlement succeeds.

Transient retry does not return an error merely because another attempt is in
progress. Offline, authentication, storage allowance, upgrade, and recovery
conditions return their typed errors.

Local SQLite corruption, programming defects, and same-version protocol defects
reject the promise. They are not ordinary synchronization results.

Settlement covers scalar rows and KV only. It does not settle row documents,
blobs, every device, or one exact historical database checkpoint. Row documents
expose local `whenDurable()` and reactive connection state.

## Consequences

- Callers consume one ordinary `Result<void, SyncSettleError>` instead of a
  second outcome envelope.
- Success means a fixed lower bound, never global quiescence or cross-row atomic
  visibility.
- Transient retry no longer becomes a settlement failure branch. Fatal defects
  remain loud.
- A local-only Epicenter has no remote sync capability; it does not fabricate a
  trivially settled implementation.

## Considered alternatives

- **Retain the settlement outcome union.** Rejected because it duplicates
  `Result` and splits the repository's failure vocabulary.
- **Return retrying immediately.** Rejected because a transient background
  attempt is not a settlement outcome.
- **Wait for global quiescence.** Rejected because continuous editing moves the
  target forever.
- **Include row documents or blobs.** Rejected because they have independent
  durability and transfer contracts.
