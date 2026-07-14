# Gate 2 evidence: current-head snapshots permit permanent log deletion

Date: 2026-07-11 (re-proved on the three-verb protocol, no tombstones)

## Result

Gate 2 passes. The server can permanently delete every accepted mutation
through snapshot sequence `S` while new, stale, and pending clients retain the
same visible intent as the pure model. Snapshots carry LIVE ROWS ONLY:
deletion survives compaction as absence, and the fold's accepted no-op for
`updateRow`/`deleteRow` against an absent row replaces the tombstone record
the previous protocol carried.

```txt
server transaction at head S
  live canonical rows + actor high-waters frozen at the same read state
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

Historical result on 2026-07-11: 27 tests passed, 0 failed across the then-live
Gates 1 through 3. That aggregate included the deleted Gate 3 harness and is not
current epoch-fence evidence. Gate 2 specifically proves:

- new and stale bootstrap across multiple chunks while later writes continue;
- response loss and duplicate chunk delivery;
- publication replacement during abandoned bootstrap;
- rollback on a server publication crash and client install crash;
- durable reopen after successful installation;
- cursor-before-watermark routing to a snapshot;
- frozen actor high-water pruning an accepted pending mutation;
- preservation and replay of a never-accepted pending mutation;
- a stale retry of an already-accepted create after compaction is absorbed by
  sequence dedup, not refused as a create conflict;
- actor high-water persistence after the mutation prefix is deleted;
- a row deleted before compaction is absent from every snapshot chunk, and a
  stale replica's pending update to it survives bootstrap, replays as a local
  no-op, is accepted by the server as a deterministic no-op, and never
  resurrects the row on any replica;
- quarantine reclassification and later completing-update promotion;
- invalid manifest, in-flight chunk corruption, and post-stage SQLite corruption
  refusing installation without changing visible state;
- stale manifests refusing rollback after a newer cursor is installed;
- eight deterministic seeds, each running eight write/compact/drain rounds
  across three replicas in lockstep, with fresh create identities and delayed
  updates/deletes against possibly compacted-away rows.

Snapshot install also raises the replica's next actor sequence past the frozen
high-water, so a rebootstrapped replica can never reuse an accepted sequence
and silently lose a mutation to dedup.

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
  rows[]                 live rows only: {table, rowId, cells}
  checksum
```

Server SQLite owns current canonical rows, actor high-waters, one manifest, one
chunk set, the watermark, and only the mutation tail newer than the watermark.
Client SQLite adds one staging table; the manifest lives temporarily in replica
metadata. Staging never changes application-visible state.

## What this does not prove

Gate 2 proves logical snapshot semantics, not physical SQLite backup/restore,
browser OPFS resource behavior, Durable Object adapter parity, production byte
limits, snapshot throughput, or records-epoch replacement. ADR-0130 assigns the
portable protocol only the epoch fence; deployment administration owns
replacement.
