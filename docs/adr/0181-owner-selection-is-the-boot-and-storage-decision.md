# 0181. Owner selection is the boot and storage decision

- **Status:** Proposed
- **Date:** 2026-07-19
- **Supersedes:** [ADR-0094](0094-the-connection-is-the-boot-decision-one-connect-call.md)
- **Relates:** [ADR-0088](0088-sign-in-is-an-enhancement-never-a-door.md), [ADR-0160](0160-one-principal-owns-exactly-one-epicenter.md), and [ADR-0161](0161-each-local-owner-persists-one-sqlite-database-and-one-blob-directory.md)

## Context

ADR-0094 encoded local versus connected boot as one workspace connection
argument. One Epicenter per selected owner removes workspace construction as
the ownership decision. The runtime must choose the durable owner before any
application lens opens.

## Decision

Owner selection is the boot and storage decision. A known authenticated account
opens its account owner even while offline or awaiting reauthentication. An
explicit logout destroys that account runtime and does not redirect writes into
the local owner. Starting locally is a separate explicit owner selection.

After selection, applications open identity-free lenses over that one owner.
They do not choose local versus account storage independently.

## Consequences

- Sign-in remains an enhancement rather than a door, but local and account data
  never blur together.
- Offline use of a previously opened account continues against its durable
  local replica.
- Logout cannot silently redirect subsequent writes into another owner.

## Considered alternatives

- **Treat signed-out as an automatic local fallback.** Rejected because losing
  credentials must not silently change the destination of durable writes.
- **Let each application choose an owner.** Rejected because several trusted
  lenses must share one selected owner and lifecycle.
