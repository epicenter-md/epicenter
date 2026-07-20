# 0175. One Epicenter Durable Object owns one principal's accepted state

- **Status:** Proposed
- **Date:** 2026-07-19
- **Amends:** [ADR-0160](0160-one-principal-owns-exactly-one-epicenter.md) by fixing the hosted actor and authority vocabulary.
- **Relates:** [ADR-0145](0145-one-account-authority-owns-every-workspace-and-one-socket-per-open-row-document.md), [ADR-0164](0164-accepted-membership-gates-immutable-s3-blobs.md), [ADR-0167](0167-row-documents-persist-as-one-compact-baseline-plus-a-bounded-tail.md), and [ADR-0169](0169-scalar-convergence-retains-one-bounded-deletion-and-retry-horizon.md)

## Context

The current Cloudflare class is named
`CurrentStateRowAuthorityDurableObject`, while it already owns scalar rows,
row-document sockets, and whole-owner deletion. The accepted destination adds
typed KV, accepted blob membership, export, and generation replacement. A name
centered on current-state rows no longer describes the actor, while
`AccountAuthority` incorrectly excludes the self-hosted `instance` principal
and sounds responsible for authentication and billing.

## Decision

Cloudflare stores each hosted principal's accepted Epicenter state in one
`EpicenterDurableObject`, reached through the plural `EPICENTERS` namespace.
Authentication resolves the principal before selecting that actor. The actor
stores and serializes accepted rows, typed KV, row documents, bounded replica
state, blob grants and accepted membership, export cuts, and owner generation
replacement.

An Epicenter is the domain aggregate. "Authority" remains a lowercase protocol
role: the hosted or self-hosted Epicenter accepts or refuses synchronized
changes and orders accepted state. There is no public `EpicenterAuthority`,
`AccountAuthority`, `PrincipalStore`, or `SyncCoordinator` product noun.

The self-hosted deployment implements the same role against its instance-owned
SQLite database without pretending to be a Cloudflare Durable Object.

## Consequences

- One actor name survives future additions to the accepted owner state.
- `env.EPICENTERS.get(...)` names a namespace of Epicenter actors rather than a
  table-specific implementation.
- Authentication, billing, inference, and hosted account records remain outside
  the Epicenter actor.
- Durable Object migrations must rename the class and binding deliberately;
  compatibility aliases do not remain after the clean break.

## Considered alternatives

- **`EpicenterAuthority`.** Rejected as the runtime class because authority is a
  role, not the aggregate or Cloudflare substrate.
- **`AccountAuthority`.** Rejected because self-host has an instance principal
  and the actor owns no account policy.
- **`ReplicaHub`, `SyncCoordinator`, or `PrincipalStore`.** Rejected because
  each names only one responsibility of an actor that also owns durable state,
  blob acceptance, export, and replacement.
