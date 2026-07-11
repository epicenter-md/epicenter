# Gate 1 evidence: typed tables do not need a canonical client shadow

Date: 2026-07-11

## Result

Candidate B passes Gate 1. No tested schedule required a schema-blind canonical
shadow on the client. The selected client shape is:

```txt
typed application tables
__epicenter_outbox
__epicenter_state
__epicenter_tombstones
__epicenter_quarantine
```

An accepted pull page is applied directly to typed/quarantined state in one
SQLite transaction. Exact own echoes are removed from the outbox, then the
remaining assignment-only outbox is replayed. Terminal tombstones make every
late patch a no-op. The cursor advances in that same transaction.

## Evidence run

Commands:

```sh
bun x tsc -p demos/local-first-sync/tsconfig.json --noEmit
bun test demos/local-first-sync/gates/gate1.test.ts
bun test ./demos/local-first-sync/gates/__benchmarks__/gate1-physical.bench.ts
```

Result: 9 tests passed, 0 failed. The suite ran:

- successful push with lost acknowledgement and acknowledgement before echo;
- both same-cell acceptance orders while local intent is pending;
- duplicate and reordered pull pages;
- crash before and after local commit, midway through a multi-operation server
  mutation, and during pull-page application;
- database-session generation fencing for stale responses;
- terminal delete against late patches;
- one atomic mutation spanning multiple rows and tables;
- actor-sequence duplicate and gap handling plus schema-identity refusal;
- collision-free internal comparison keys for arbitrary table and row ids;
- partial-row quarantine, completing-patch promotion, pending replay, reopen,
  patch, and delete;
- 16 deterministic 80-event schedules across three replicas, compared after
  every event and fully drained to convergence;
- a delta-debug minimizer that runs if a generated schedule fails.

The reference model, Bun SQLite server, Candidate A pull applier, and Candidate
B pull applier are separate implementations. Lockstep comparison covers server
canonical state/log/high-waters and each client's visible rows, quarantine,
tombstones, outbox, next actor sequence, and pull cursor.

## Physical comparison

Measured after the same 50-row workload and a WAL checkpoint:

| Measure | A: canonical + projection | B: typed only | Difference |
| --- | ---: | ---: | ---: |
| SQLite tables | 8 | 7 | B removes 1 table |
| SQLite bytes | 69,632 | 61,440 | B removes 8,192 bytes (11.8%) |
| Formatted implementation lines | 442 | 460 | B adds 18 lines (4.1%) |

SQLite byte counts are page-quantized proof-workload measurements, not a scale
benchmark. The line count is also deliberately unflattering to B: its targeted
direct applier is a little longer than A's rebuild-all projection. B still wins
the ownership and first-read comparison:

```txt
A: accepted canonical rows -> replay outbox -> rebuild typed projection -> query
B: typed rows + pending overlay already materialized                 -> query
```

A owns three representations of live values (canonical, projection, outbox).
B owns one live representation plus pending intent and exceptional deletion or
quarantine state. Both give application queries ordinary typed SQLite tables.

## What this does not prove

The current measurements include Gate 2's identical client staging table and
snapshot methods in both candidates. Gate 1 by itself did not prove snapshots;
that later evidence is in [`GATE2-EVIDENCE.md`](GATE2-EVIDENCE.md). Epoch
transition/import, browser OPFS behavior, Durable Object parity, scale
performance, limits, and reactive invalidation remain later work. Candidate A
remains in this proof directory only as the tested control; it is not selected
production design.
