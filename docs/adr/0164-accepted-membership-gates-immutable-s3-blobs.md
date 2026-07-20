# 0164. Accepted membership gates immutable S3 blobs

- **Status:** Proposed
- **Date:** 2026-07-19
- **Supersedes:** [ADR-0091](0091-blobs-trade-a-file-for-a-durable-content-addressed-url-documents-are-the-only-manifest.md) and [ADR-0154](0154-blob-access-is-address-only.md)
- **Relates:** [ADR-0066](0066-runtime-portability-is-per-concern-injection-not-a-runtime-object.md), [ADR-0090](0090-the-blob-layer-stays-plaintext-confidentiality-belongs-to-the-encrypting-consumer.md), [ADR-0092](0092-identity-is-the-partition.md), [ADR-0137](0137-hosted-storage-is-one-eventually-enforced-physical-account-allowance.md), [ADR-0148](0148-blobs-use-opaque-identifiers-rather-than-content-hashes.md), [ADR-0150](0150-whispering-uploads-operator-readable-audio.md), and [ADR-0162](0162-portability-is-a-frozen-editable-projection-of-one-selected-owner.md)

## Context

Object presence cannot say whether an owner accepted a blob. A presigned PUT is
a reusable bearer capability until expiry, so a PUT that lands after purge can
recreate bytes. Object metadata has the same race, R2 does not implement object
tags, and a sidecar object would not be transactional with the bytes.

Selected-owner server export must include accepted blobs even after every
application citation is lost, while excluding abandoned uploads and physical
orphans. Release-local schemas and opaque Yjs documents cannot supply that
inventory.

## Decision

Blob IDs are opaque, caller-minted, immutable, owner-scoped capabilities.
Different owners never share physical blob identity or deduplication state.
Public application operations remain address-only; there is no public listing
API.

A server owner's authority SQLite stores one active owner generation and two
conceptual sets within each generation:

```txt
owner_state(active_generation)
blob_upload_grants(generation, blob_id, confirm_until)
accepted_blobs(generation, blob_id)
```

The physical schema may encode them differently. Live correctness state stores
no size, content type, digest, filename, provider handle, citation, owning row,
or reference count.

Physical object keys derive from `(owner, generation, BlobId)`, while `BlobId`
remains the stable logical identity exposed to applications and artifacts.
Generation scope lets whole-owner replacement preserve that identity beside the
live generation without overwriting accepted bytes. A replacement that retains
a BlobId retains the same logical resource; live APIs never mint the ID again
for unrelated bytes.

`begin` persists a bounded upload grant in the active generation before
returning a transfer capability. `confirm` requires a live grant, performs
`HeadObject`, verifies presence and the platform maximum, then atomically
replaces grant membership with accepted membership. Repeated confirmation after
acceptance is idempotent. `confirm_until` is the authority upload-session
deadline, not blob expiry; it may outlive an individual transfer capability so
a completed request can still confirm.

Expired grants are removed by ordinary authority maintenance and cannot confirm.
The orphan sweep removes their physical objects. Grant rows therefore remain
bounded by their deadline rather than accumulating for the owner lifetime.

Reads and server export require accepted membership. A server export enumerates
only `accepted_blobs`, then reads every object or fails the unpublished export.
It obtains size and content type through `HeadObject` and computes artifact
SHA-256 while streaming.

Purge first removes grant and accepted membership, then deletes the derived
object key. It attempts physical deletion even on an idempotent retry after
membership is already absent, and returns success only after object storage
accepts deletion. Membership removal immediately prevents new reads and exports.
A previously issued short GET remains a bearer capability until expiry if byte
deletion is interrupted.

A stale PUT after purge may recreate physical bytes, but it cannot recreate a
grant or accepted membership. The object is inaccessible and absent from export.
A private idempotent sweep lists owner-generation prefixes and removes objects
belonging to neither accepted membership nor an unexpired grant. It also removes
all objects in inactive generations after replacement recovery policy permits.
Old-generation membership never authorizes reads after the active-generation
flip. IDs are never intentionally reused within a generation, so no permanent
blob tombstone is required.

## Consequences

- Accepted inventory is one authority fact instead of an inference from bucket
  contents or application citations.
- Delete remains supported and logically immediate. A failed physical delete is
  reported and retriable; it cannot resurrect Epicenter-visible data.
- Hosted physical metering may count temporary orphan bytes without promoting
  size into correctness state.
- Whole-owner replacement can stage the same logical BlobIds under a new
  physical generation, flip authority atomically, and sweep the old objects.

## Considered alternatives

- **Treat object presence as acceptance.** Rejected because abandoned and stale
  uploads become indistinguishable from accepted state.
- **Derive inventory from citations.** Rejected because lost citations must not
  silently remove accepted bytes from export.
- **Store acceptance in metadata, tags, or a sidecar.** Rejected because none
  provides an atomic authority transition with the object bytes across the
  supported providers.
- **Store size, type, or digest in live authority state.** Rejected because HEAD
  supplies object metadata and export computes its own integrity digest.
