# 0165. Export captures the complete durable state of one selected owner

- **Status:** Proposed
- **Date:** 2026-07-19
- **Supersedes:** the export and cross-plane completeness provisions of [ADR-0147](0147-cross-plane-transfer-and-recovery-use-logical-coordination-not-atomic-snapshots.md); ADR-0166 and ADR-0169 replace its import and stale-recovery provisions.
- **Relates:** [ADR-0144](0144-scalar-rows-and-row-documents-synchronize-through-independent-client-planes.md), [ADR-0162](0162-portability-is-a-frozen-editable-projection-of-one-selected-owner.md), and [ADR-0164](0164-accepted-membership-gates-immutable-s3-blobs.md)

## Context

"Complete export" can mean complete accepted server state, complete durable
state of one local owner, or every pending edit and never-uploaded blob across
all devices. The first two have a concrete owner and durability boundary. The
third would require reaching every device, acknowledging document updates,
discovering dormant documents, and automatically synchronizing blobs.

Lazy documents and explicit blob transfer make that distinction visible. A
device can hold durable content the server has never accepted, while the server
can hold accepted documents and blobs the selected device has never opened.

## Decision

Export captures the complete durable current state of exactly one selected
owner into the artifact defined by ADR-0162.

A local-owner export captures that local Epicenter's durable rows, typed KV,
row-document states, and every blob in its private owner store at the export
durability cut. It includes unreferenced and never-uploaded local blobs and
device-only durable document edits. It does not ask a server or another device
to complete the result.

A server-owner export captures exactly the scalar rows, typed KV, compact row
documents, and blobs that the selected server authority has accepted and still
stores. It enumerates private `accepted_blobs` membership rather than scanning
application citations, `uploadedAt`, Yjs content, or object-store presence. It
excludes upload grants, physical orphans, device-only document edits, pending
scalar changes, and blobs that no device uploaded and confirmed.

Export stages a consistent logical cut and publishes an artifact only after
every manifest entry and byte has been written and validated. A missing
accepted object, concurrent owner replacement, or other inability to honor the
cut fails without publishing a partial artifact. The implementation must prove
that its transaction, generation, staging, or retry mechanism produces that
outcome; this decision does not require one cross-plane lock or pause writes
while multi-gigabyte blobs copy.

Export performs no all-device coordination, remote document settlement, dormant
document discovery, or automatic blob synchronization. The selected-owner
boundary is the portability promise.

## Consequences

- Server and local exports are both complete, but complete for different
  explicitly selected owners.
- A server export may omit valuable durable work still present on a device. A
  local export may contain work the server has never accepted.
- Public blob APIs can remain address-only while privileged owner export uses
  private enumeration.
- Users who need all-device recovery must preserve the relevant device exports;
  Epicenter does not synthesize a global artifact.

## Considered alternatives

- **Coordinate every device before export.** Rejected because offline devices
  would make export open-ended and would turn documents and blobs into one
  global settlement protocol.
- **Let a device silently fetch missing server state.** Rejected because that
  would change a local-owner export into a different owner selection and hide
  network work inside portability.
- **Best-effort export with omissions.** Rejected because a published artifact
  must be structurally complete for the owner and cut it claims.
- **Infer server blobs from rows.** Rejected because lenses are release-local,
  documents are opaque, and lost citations are not deletion authority.
