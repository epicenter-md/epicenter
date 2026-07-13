# Gate 3 evidence: records epochs keep histories separate

Date: 2026-07-13

## Result

Gate 3 passes through production tests. One records epoch carries one records
schema hash and one sequence space. Push, pull, snapshot publication, and chunk
reads reject work after the authority selects another epoch. A replica that
discovers the mismatch before or during synchronization durably freezes later
writes, preserves its local rows and outbox across restart, and requires
explicit recovery.

Gate 3 has no standalone transition harness. The earlier harness modeled online
database succession with candidates and activation. ADR-0130 rejects that
product. Schema changes, restore, and wholesale replacement are deployment
administration; the shared sync engine owns only the epoch fence.

## Evidence

- [authority-open.test.ts](../../../packages/record-sync/src/authority-open.test.ts)
  proves that a stored epoch change fences stale writes, cursors, snapshot
  publication, and chunk reads. It also proves that a partial administrative
  transition which changes only the schema hash fails closed.
- [conformance.test.ts](../../../packages/record-sync/src/conformance.test.ts)
  runs the same authority contract through Bun SQLite, browser SQLite OO1, and
  Durable Object SQLite.
- [replica.test.ts](../../../packages/workspace/src/sqlite/replica.test.ts)
  proves that an epoch mismatch during discovery, push, pull, or snapshot
  download freezes edits while preserving pending local work across restart,
  and that a fresh replica bootstraps the current epoch.
- [bun.test.ts](../../../packages/server/src/records/bun.test.ts) and
  [cloudflare.test.ts](../../../packages/server/src/records/cloudflare.test.ts)
  prove that both deployments persist and descriptively report the current
  epoch and schema hash.
- Route and export searches prove the absence of candidate, stage, upload,
  seal, activate, discard, and succession surfaces in the shared protocol.

Run the focused proof with:

```sh
bun test packages/record-sync/src/authority-open.test.ts \
  packages/record-sync/src/conformance.test.ts
bun test packages/workspace/src/sqlite/replica.test.ts
bun test packages/server/src/records/bun.test.ts \
  packages/server/src/records/cloudflare.test.ts \
  packages/server/src/routes/records.test.ts
```

## Limit

This gate does not prove how an administrator uploads, validates, rolls back, or
retains replacement data. Those are deployment-owned operations. If a concrete
hosted or self-hosted workflow earns shared behavior later, it must be designed
without weakening the epoch fence.
