# 0178. Live remote Home control is deferred until it has a shipped workflow

- **Status:** Accepted
- **Date:** 2026-07-19
- **Supersedes:** [ADR-0115](0115-super-chat-remote-attach-rides-an-endpoint-addressed-trusted-relay.md)
- **Relates:** [ADR-0079](0079-cross-device-is-two-planes-epicenter-syncs-the-crdt-the-box-is-reached-directly.md), [ADR-0080](0080-the-super-app-is-a-desktop-host-cross-device-is-remote-access-to-the-session-not-a-per-app-capability-plane.md), [ADR-0113](0113-super-chat-session-commands-are-host-owned-transports-only-frame-them.md), and [ADR-0160](0160-one-principal-owns-exactly-one-epicenter.md)

## Context

AttachRelay has a complete hosted and self-hosted transport, but the shipped
desktop never attaches its Home host and the shipped UI never creates a remote
client. Host discovery and device connection remain unfinished. The relay does
not enumerate conversations or synchronize durable chat history; it only
forwards commands and snapshots for one currently running desktop Home session.

## Decision

Delete AttachRelay, its Durable Object and binding, self-hosted grants and host
directory, desktop host and client adapters, routes, tests, smoke scripts, and
unfinished implementation spec.

Durable conversations remain ordinary rows and row documents in the selected
Epicenter. Another device enumerates and reads them through normal row and
document synchronization.

Live remote control of desktop-local tools is deferred. If a complete phone or
browser workflow later earns that promise, it returns as a separate ephemeral
`HomeSessionRelay` keyed by principal and host. It must not become a generic
app-to-app relay or share the durable Epicenter actor. No route or public API is
reserved before that workflow exists.

## Consequences

- The current product loses no shipped workflow.
- Epicenter retains no speculative device grant, host directory, attach ID, or
  transient relay actor family.
- Future live remote control must justify its discovery, authorization, UI,
  liveness, and transport together.

## Considered alternatives

- **Rename and keep AttachRelay.** Rejected because a better name would turn an
  unfinished proof into a permanent platform commitment.
- **Merge relay sockets into `EpicenterDurableObject`.** Rejected because
  transient high-volume session traffic has a different lifecycle from durable
  accepted owner state.
- **Use the generic Room actor.** Rejected because persistent collaborative Yjs
  state is not an ephemeral host-command channel.
