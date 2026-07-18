# 0147. Cross-plane transfer and recovery use logical coordination, not atomic snapshots

- **Status:** Proposed
- **Date:** 2026-07-17
- **Amends:** [ADR-0122](0122-logical-records-are-portable-sqlite-files-and-views-are-runtime-state.md), [ADR-0142](0142-bootstrap-history-gaps-and-lineage-mismatches-have-distinct-recovery.md), [ADR-0143](0143-account-open-never-consumes-device-data.md)

## Context

Scalar rows and row documents now have independent client persistence owners.
The existing recovery and Device Add contracts describe one SQLite capture and
one atomic admission of document-bearing row intents, which no longer exists.
Users still need safe logical export, explicit Device-to-Account consent, and a
non-destructive response to divergent restored scalar replicas.

## Decision

Account open still never consumes Device data automatically. Add, Delete, and
Keep remain explicit product actions. Scalar rows and KV transfer through
ordinary scalar intents. Documents transfer through the document provider under
the same row addresses only after the destination row is locally admitted. The
destination first persists both planes locally, then scalar synchronization
settles and canonical installation proves every destination row remains live.
Only then may the source be deleted. A permanently tombstoned destination
address is a terminal import conflict: Epicenter reports it and preserves the
Device source and its document bytes.

Logical export and recovery coordinate the two planes but do not claim one exact
cross-plane instant. An export captures one scalar cut plus one compact state for
each included document and records which documents were unavailable. It contains
no SQLite pages, replica identity, receipt, checkpoint, provider database, or
network state.

A scalar lineage mismatch still stops scalar networking while preserving local
reading and editing. Recovery exports the visible scalar replica and every
locally available document into a separate reviewable copy, starts a fresh
scalar lineage only after that copy is preserved, and recreates selected content
through ordinary scalar and document operations. Epicenter never merges private
SQLite histories or provider databases automatically.

Fresh scalar acquisition and long-offline scalar rebuilding remain automatic.
They do not acquire every row document. A document becomes locally offline-ready
when opened or explicitly downloaded. An export that requires a document absent
from the device must fetch it while online or report it as unavailable.

## Consequences

- No global transaction or settlement barrier spans SQLite rows and every lazy
  document provider.
- Device Add is crash-safe through source preservation and idempotent logical
  retries, not one destination SQLite transaction.
- Local destination durability alone never authorizes Device deletion; canonical
  scalar liveness is the deletion gate.
- A device may hold a complete scalar workspace without holding every document.
- Complete offline export of never-opened documents is refused; the export
  result reports incompleteness instead of silently omitting it.
- Restored runtime stores remain internal artifacts rather than portable backup
  formats.

## Considered alternatives

- **Hydrate every document on every device.** Rejected because it recreates a
  document acquisition protocol and defeats lazy document storage.
- **Present export as an atomic snapshot.** Rejected because independent
  persistence and network owners cannot provide that promise without freezing
  editing or adding distributed snapshot machinery.
- **Copy provider databases during Add or recovery.** Rejected because it
  transfers private lifecycle and format state rather than logical content.
- **Delete Device data after local destination admission.** Rejected because a
  tombstoned row address can make the canonical create a permanent no-op while
  leaving only orphaned destination document bytes.
