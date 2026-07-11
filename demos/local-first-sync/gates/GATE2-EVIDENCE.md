# Gate 2 evidence: current-head snapshots permit permanent log deletion

Date: 2026-07-11

## Result

Gate 2 passes. The server can permanently delete every accepted mutation
through snapshot sequence `S` while new, stale, and pending clients retain the
same visible intent as the pure model.

```txt
server transaction at head S
  canonical rows + tombstones + actor high-waters
                         |
                         v
              immutable manifest (SHA-256)
                         |
              fixed logical row chunks
                         |
       publish watermark S + delete log <= S

client
  stage chunks durably -> verify all -> one install transaction
  replace accepted state -> prune own high-water -> replay outbox -> cursor S
```

The selected lifecycle keeps one published generation. Publishing a replacement
is atomic: old readers see the old generation until commit; afterwards old chunk
requests receive `snapshot-replaced` and restart against the current manifest.
There is no historical snapshot API or compatibility reader.

## Evidence run

Commands:

```sh
bun x tsc -p demos/local-first-sync/tsconfig.json --noEmit
bun test demos/local-first-sync/gates/
```

Result: 17 tests passed, 0 failed across Gates 1 and 2. Gate 2 specifically
proves:

- new and stale bootstrap across multiple chunks while later writes continue;
- response loss and duplicate chunk delivery;
- publication replacement during abandoned bootstrap;
- rollback on a server publication crash and client install crash;
- durable reopen after successful installation;
- cursor-before-watermark routing to a snapshot;
- frozen actor high-water pruning an accepted pending mutation;
- preservation and replay of a never-accepted pending mutation;
- actor high-water persistence after the mutation prefix is deleted;
- quarantine reclassification and later completing-patch promotion;
- terminal tombstones rejecting every post-compaction resurrection patch;
- invalid manifest, in-flight chunk corruption, and post-stage SQLite corruption
  refusing installation without changing visible state;
- stale manifests refusing rollback after a newer cursor is installed;
- eight deterministic seeds, each running eight write/compact/drain rounds
  across three replicas in lockstep.

## Wire and durable shape

```txt
SnapshotManifest
  generation
  snapshotSequence
  chunkChecksums[]
  actorHighWater{actorId: sequence}
  checksum

SnapshotChunk
  generation
  index
  rows[]                 live rows and tombstones use one logical encoding
  checksum
```

Server SQLite owns current canonical rows, actor high-waters, one manifest, one
chunk set, the watermark, and only the mutation tail newer than the watermark.
Client SQLite adds one staging table; the manifest lives temporarily in replica
metadata. Staging never changes application-visible state.

## What this does not prove

Gate 2 proves logical snapshot semantics, not physical SQLite backup/restore,
browser OPFS resource behavior, Durable Object adapter parity, production byte
limits, snapshot throughput, or epoch transition. Gate 3 still owns exact-schema
cutover and logical import across database incarnations.
