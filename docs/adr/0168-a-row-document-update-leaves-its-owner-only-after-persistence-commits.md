# 0168. A row-document update leaves its owner only after persistence commits

- **Status:** Proposed
- **Date:** 2026-07-19
- **Amends:** [ADR-0144](0144-scalar-rows-and-row-documents-synchronize-through-independent-client-planes.md), [ADR-0146](0146-row-documents-use-one-yjs-14-major-and-runtime-native-update-logs.md), and [ADR-0159](0159-row-documents-persist-in-one-owner-side-sqlite-update-log.md)
- **Relates:** [ADR-0167](0167-row-documents-persist-as-one-compact-baseline-plus-a-bounded-tail.md)

## Context

Yjs invokes persistence and network listeners independently. Attaching a
persistence listener first does not make its asynchronous SQLite append finish
before another listener publishes the same update. A crash can therefore expose
an update to peers that its originating owner never made durable.

Applying an authority-durable inbound update locally creates a second ordering
requirement: no causally later local update may leave the device while that
inbound state is still ahead of the device's persistence tail.

## Decision

Every locally produced row-document update enters one ordered per-document
persistence tail before it becomes eligible for network publication. Every
outbound update-bearing frame, including a deferred handshake response, waits
for the durability cut that contains its state.

Appends remain causally ordered. If one append fails, successors neither persist
nor publish in front of the gap. Local durability failure is a storage failure,
not a network retry condition.

An authority-durable inbound update may render immediately. Its local append
joins the same persistence tail, so every causally later outbound update waits
until that inbound update and the later local update have committed locally.

The authority validates and commits an inbound update before broadcasting its
bytes to any other connection. A failed or refused authority append produces no
broadcast. State-vector requests carry no document update and need no durability
wait.

This ordering adds no remote document acknowledgment, settlement watermark,
dormant-document discovery, or all-device coordination. Scalar settlement
remains independent.

## Consequences

- Peer visibility of a local edit waits for one local SQLite commit. This is the
  latency cost of never publishing state that can disappear from its origin on
  crash.
- A receiving device may display authority-durable state before its own disk
  commit. If that commit fails, it stops publishing successors and reports
  local storage failure.
- A server crash after commit but before broadcast is repaired by the next Yjs
  state-vector exchange.

## Considered alternatives

- **Rely on listener registration order.** Rejected because it orders callbacks,
  not asynchronous commits.
- **Publish first and persist eventually.** Rejected because a crash can strand
  peer-visible state outside its originating durable replica.
- **Wait for every receiver to persist.** Rejected because it creates durable
  document acknowledgments and all-device coordination.
