# 0174. Applications own row-and-blob aggregate deletion

- **Status:** Proposed
- **Date:** 2026-07-19
- **Relates:** [ADR-0150](0150-whispering-uploads-operator-readable-audio.md), [ADR-0164](0164-accepted-membership-gates-immutable-s3-blobs.md), [ADR-0171](0171-tables-mutate-rows-through-create-update-and-delete.md), and [ADR-0173](0173-remote-blob-transfer-is-explicit-create-only-and-one-shot.md)

## Context

Rows and blobs are independent platform resources. Inferring blob ownership from
row fields, document contents, filenames, or reachability would require every
application schema to become platform lifecycle policy. Yet a product operation
such as deleting a recording is incomplete if it leaves its local or remote
audio behind.

## Decision

Blob purge owns only the addressed blob capability. Raw row deletion owns the
row and its latent row document, never independently addressed blobs.

The application aggregate that binds them owns the user-facing workflow. For
example, Whispering's recording namespace deletes remote audio, local audio, and
the recording row. Calling raw table `delete` alone is not a complete recording
delete and must not be used by that product workflow.

Remote purge revokes accepted authority membership first, attempts physical
deletion synchronously, and remains idempotently retriable and sweepable under
ADR-0164. Application code does not implement a second remote inventory.

Fields such as `uploadedAt` are application-level historical evidence only.
They never establish current remote acceptance, availability, ownership, or
export truth. Private accepted membership is the sole authority for those facts.

## Consequences

- Applications can provide complete aggregate deletion without teaching the
  platform their schemas.
- A trusted caller can still delete a raw row and leave a cited blob. This is the
  cost of refusing a generic reachability and refcount system.
- Recording deletion can report partial infrastructure failure and safely retry
  without making `uploadedAt` or row presence into remote truth.

## Considered alternatives

- **Cascade from every row deletion.** Rejected because blobs may have zero,
  one, or many application citations, none of which defines authority ownership.
- **Scan rows and documents for reachability.** Rejected because lenses are
  release-local and Yjs documents are opaque to the platform.
- **Treat `uploadedAt` as inventory.** Rejected because it is stale historical
  evidence after purge, failed cleanup, or remote repair.
