# 0133. Ordinary record sync requests carry only the records epoch

- **Status:** Accepted
- **Date:** 2026-07-13
- **Amends:** [ADR-0119](0119-complete-metadata-replicas-sync-through-schema-blind-server-ordered-mutations.md), [ADR-0130](0130-records-replacement-starts-a-new-epoch-without-an-online-succession-protocol.md)

## Context

The authority open boundary exchanges the canonical records descriptor and its
hash, then binds one immutable schema to one newly minted records epoch. Local
SQLite files and the authority persist all three facts. Push, pull, and snapshot
requests nevertheless repeated both the epoch and the schema hash.

Those two wire fields claimed the same identity. Supporting disagreement between
them required another refusal, branch, parser field, and client recovery case,
even though Epicenter refuses multiple schemas inside one epoch.

## Decision

An ordinary push, pull, or snapshot request carries the protocol major and one
opaque records epoch. The epoch is the complete synchronization fence for its
immutable history and schema.

The descriptor and hash remain explicit at authority provisioning and
discovery, in durable authority and replica metadata, in local SQLite identity,
and in recovery checkpoints. A replica verifies descriptor and hash when it
discovers the authority before binding the epoch. They do not ride ordinary
synchronization requests.

Changing a stored descriptor or hash without minting a new epoch is authority
corruption. The running authority fails closed; it does not report a client
schema mismatch that the client could repair inside the same epoch.

## Consequences

- There is one ordinary currentness test: protocol compatibility plus epoch
  equality.
- The `records-schema-mismatch` wire refusal is deleted.
- A schema change still requires a new epoch. Removing the repeated hash does
  not weaken that boundary because epoch provisioning binds the hash durably.
- Descriptor and hash remain inspectable where they convey meaning instead of
  acting as a second per-request generation token.

## Considered alternatives

- **Keep both fields as defense in depth.** Rejected: two representations of one
  invariant create disagreement states and recovery branches without admitting
  any valid additional behavior.
- **Put the full descriptor on every request.** Rejected: application meaning is
  verified during discovery and persisted with the data; ordinary sync remains
  schema-blind.
- **Use the schema hash as the sole fence.** Rejected: restore and wholesale
  replacement can start a new history under the same schema, so the epoch is
  the stronger generation identity.
