# 0177. The generic Room actor is withdrawn

- **Status:** Proposed
- **Date:** 2026-07-19
- **Supersedes:** [ADR-0095](0095-websocket-room-auth-uses-route-owned-subprotocol-bearers.md)
- **Amends:** [ADR-0066](0066-runtime-portability-is-per-concern-injection-not-a-runtime-object.md) and [ADR-0092](0092-identity-is-the-partition.md) by removing the generic Room runtime, binding, and route.
- **Relates:** [ADR-0144](0144-scalar-rows-and-row-documents-synchronize-through-independent-client-planes.md), [ADR-0160](0160-one-principal-owns-exactly-one-epicenter.md), and [ADR-0175](0175-one-epicenter-durable-object-owns-one-principals-accepted-state.md)

## Context

The generic Room actor predates row-owned Yjs documents. The accepted Epicenter
model now gives each ordinary row one latent document synchronized through the
selected owner's actor. Tab Manager, Vocab, Opensidian, and the legacy workspace
API still produce Room traffic, but none requires Room as a distinct product
concept; they are inherited consumers that must leave before deletion. The Tab
Manager and Opensidian daemon mounts have no live repository caller and are
deleted rather than ported.
Cross-principal collaboration would require new ownership and authorization
semantics that the current Room does not provide.

## Decision

Delete the generic Room actor, `/api/rooms/:roomId`, its current Cloudflare
binding, both runtime backends, public contracts, tests, and documentation. Add
a new Cloudflare migration that deletes the deployed class; retain historical
migrations as deployment history. Do not preserve a compatibility route, alias,
or room registry.

Stop every legacy client from producing Room traffic before deleting the
server. Applications synchronize collaborative content through row-owned
documents. A future cross-principal collaboration product must begin with an
explicit ownership and authorization decision rather than reviving the generic
Room.

## Consequences

- Hosted and self-hosted deployments lose one actor family and one WebSocket
  composition branch.
- There is one durable collaboration address: table key, row ID, and document.
- Existing generic-room imports and tests are deleted rather than redirected.
- Tab Manager, Vocab, Opensidian, and the legacy Yjs 13 workspace family must
  leave the Room route before its actor is removed.
- The unused Tab Manager and Opensidian daemon mounts disappear instead of
  earning a second canonical runtime.

## Considered alternatives

- **Keep Room as a general primitive.** Rejected because it has no distinct
  final product role and duplicates the row-document plane.
- **Use Room for future sharing.** Rejected because future sharing needs
  cross-principal policy that the current principal-scoped room cannot express.
