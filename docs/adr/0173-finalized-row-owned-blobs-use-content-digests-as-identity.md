# 0173. Finalized row-owned blobs use content digests as identity

- **Status:** Proposed
- **Date:** 2026-07-20
- **Supersedes:** [ADR-0148](0148-blobs-use-opaque-identifiers-rather-than-content-hashes.md)
- **Amends:** [ADR-0154](0154-blob-access-is-address-only.md)
- **Relates:** [ADR-0171](0171-every-durable-local-write-leaves-an-automatic-authority-obligation.md), [ADR-0172](0172-sqlite-stores-convergent-facts-and-documents-raw-files-store-blob-bytes.md)

## Context

Opaque blob IDs allow permanent naming before bytes are complete, but require
a separate checksum, collision rule, remote key, and recovery-artifact
integrity field. A global content address would collapse those concepts but
would also let unrelated rows accidentally share one deletion lifecycle.

## Decision

Every durable blob belongs to exactly one live row. Its permanent logical
address is the pair `(row address, SHA-256 digest)`. The row address supplies
lifecycle namespacing; the digest supplies immutable byte identity and
integrity.

Incomplete production has a temporary capture handle, never a permanent blob
identity. Finalization hashes the completed byte stream and atomically places
it at the row-scoped digest path. Identical bytes in one row have one address.
Identical bytes in different rows may occupy separate files and always have
independent lifecycle:

```txt
blobs/<namespace>/<table>/<row-a>/<sha256>
blobs/<namespace>/<table>/<row-b>/<sha256>
```

The digest is also the integrity proof, deterministic filename, transfer key,
and idempotent authority acceptance key. Epicenter has no opaque blob ID,
separate checksum identity, ID-to-digest mapping, or collision-replacement
protocol. Application rows or documents cite the row-scoped digest and own all
interpretation of the bytes.

The logical address excludes the opaque authority-lifetime identity so a
portable Epicenter remains identity-free. Physical authority storage is still
partitioned by principal and active lifetime. Restore constructs new physical
storage from the portable row addresses and bytes rather than reconnecting old
replicas to the previous lifetime.

## Consequences

- A permanent address is unavailable until capture or import finalizes.
- Changing one byte creates a new digest and therefore a new blob address.
- Deleting one row cannot remove another row's copy of identical bytes.
- Equality is visible within the same row and may be visible within one
  principal's physical storage, but the design requires no global or
  cross-principal deduplication.
- Recovery artifacts can verify every blob without a separate mapping or
  integrity manifest. Self-contained Backups may still duplicate identical
  bytes across rows and Backups.
- Authority publication is idempotent by row address and digest, but remains a
  separate blob transfer from scalar and document synchronization.

## Considered alternatives

- **Opaque permanent IDs.** Rejected because early naming does not justify a
  second identity and integrity system for finalized immutable bytes.
- **A principal-global digest address.** Rejected because deleting one row
  would require reference counting or tracing every other row before deleting
  shared bytes.
- **Both opaque and content identities.** Rejected because the mapping recreates
  the machinery content addressing removes.
- **Embed blobs in Yjs updates or scalar payloads.** Rejected because large
  immutable bytes have different bounds, streaming behavior, and convergence
  semantics.
