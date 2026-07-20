# 0173. Remote blob transfer is explicit, create-only, and one-shot

- **Status:** Proposed
- **Date:** 2026-07-19
- **Supersedes:** [ADR-0089](0089-the-blob-store-is-a-presigned-s3-kernel-and-the-bucket-is-its-only-index.md) and [ADR-0149](0149-local-blob-stores-are-canonical-and-remote-replication-is-explicit.md)
- **Relates:** [ADR-0066](0066-runtime-portability-is-per-concern-injection-not-a-runtime-object.md), [ADR-0148](0148-blobs-use-opaque-identifiers-rather-than-content-hashes.md), and [ADR-0164](0164-accepted-membership-gates-immutable-s3-blobs.md)

## Context

Local durability and remote availability are different product operations. A
presigned PUT is also a reusable bearer capability until expiry, so an upload
URL that permits overwrite can violate immutable blob identity after retry or
purge. Multipart transfer would add a second durable protocol before a product
workflow has earned it.

## Decision

Local recording completion never waits for remote upload. A product explicitly
copies selected local bytes to the selected owner's remote store. The blob layer
does not turn that action into automatic synchronization, an upload queue, a
download queue, or a claim that every device has the bytes.

Remote upload uses the authority grant and confirmation boundary in ADR-0164.
The short-lived SigV4 URL authorizes exactly one create-only `PutObject` to the
active owner-generation key. Its signature binds `If-None-Match: *`; this header
is correctness-critical because a still-valid URL must never overwrite immutable
bytes. The payload is unsigned and travels directly to object storage.

Hosted R2 and self-hosted storage implement one S3-compatible subset:
create-only `PutObject`, `HeadObject`, short `GetObject`, `DeleteObject`, and
private `ListObjectsV2`. The shared server does not add a separate R2 binding
path.

V1 accepts only one-shot objects up to 5 GiB. Multipart, resumable transfer,
provider upload sessions, parts, completion manifests, abort recovery, automatic
retry, and background blob synchronization are refused.

`BlobId` is opaque, immutable, and distinct from application aggregate IDs such
as `RecordingId`. Live APIs never intentionally mint the same ID twice or reuse
it for different bytes. Whole-owner replacement may preserve an artifact's ID
under the new owner generation; that is lifecycle transfer, not live ID reuse.

## Consequences

- A completed local recording remains safe even when upload fails or never
  starts.
- Blobs larger than 5 GiB are unsupported, and an interrupted upload restarts
  from byte zero.
- The loss deletes multipart handles, part and ETag maps, URL renewal,
  completion and abort endpoints, resume persistence, and provider-specific
  conditional completion.
- Hosted R2 and each supported self-host object store must pass the same narrow
  S3 conformance suite before that deployment claims support.

## Considered alternatives

- **Automatically synchronize every local blob.** Rejected because recording
  durability must not acquire a hidden remote queue and all-device transfer
  state.
- **Permit ordinary overwriting PUTs.** Rejected because a reusable signed URL
  could change immutable bytes after acceptance or deletion.
- **Support multipart in v1.** Rejected because ordinary recordings and
  attachments accept a complete retry and do not earn durable transfer sessions.
- **Use an R2-only binding path.** Rejected because hosted and self-hosted
  authorities should share one storage protocol.
