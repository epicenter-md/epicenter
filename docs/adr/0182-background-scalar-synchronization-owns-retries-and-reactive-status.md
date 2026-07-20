# 0182. Background scalar synchronization owns retries and reactive status

- **Status:** Proposed
- **Date:** 2026-07-19
- **Supersedes:** the background supervisor and status provisions of [ADR-0140](0140-open-workspaces-synchronize-automatically-and-callers-settle-one-watermark.md)
- **Relates:** [ADR-0169](0169-scalar-convergence-retains-one-bounded-deletion-and-retry-horizon.md) and [ADR-0170](0170-scalar-settlement-is-a-lower-bound-result.md)

## Context

Applications should observe synchronization health without manually driving
push, pull, acquisition, or retry. Conflating reactive status with one
`settle()` call makes temporary retries look like caller-owned failures and
duplicates the supervisor's lifecycle in every application.

## Decision

An opened synchronized Epicenter owns one background scalar synchronization
supervisor. Applications do not invoke push, pull, enrollment, acquisition, or
retry operations.

The reactive status is:

```ts
type SyncStatus =
  | 'caught-up'
  | 'syncing'
  | 'retrying'
  | 'offline'
  | 'authentication-required'
  | 'storage-limit'
  | 'upgrade-required'
  | 'recovery-required';
```

The supervisor owns retry. `retrying` is observable status, not a settlement
error or an instruction for the application to call synchronization again.

## Consequences

- Applications render synchronization health without reimplementing protocol
  scheduling.
- Background retry can continue independently from any one settlement call.
- Local-only Epicenters expose no remote synchronization supervisor or
  fabricated caught-up state.

## Considered alternatives

- **Expose push, pull, and retry controls.** Rejected because they leak protocol
  scheduling into every application.
- **Return retrying from `settle()`.** Rejected because retry remains active and
  does not require caller action.
