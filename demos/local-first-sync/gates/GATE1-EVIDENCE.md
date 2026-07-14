# Gate 1 evidence: typed tables do not need a canonical client shadow

Date: 2026-07-11 (re-proved on the three-verb protocol, no tombstones)

## Result

Candidate B passes Gate 1 under the three-verb protocol (`createRow`,
`updateRow`, `deleteRow`) with no tombstone state anywhere. No tested schedule
required a schema-blind canonical shadow on the client. The selected client
shape is:

```txt
typed application tables
__epicenter_outbox
__epicenter_state
__epicenter_quarantine
```

An accepted pull page is applied directly to typed/quarantined state in one
SQLite transaction: rows that exist only as optimistic pending creations are
removed first, the page folds strictly, exact own echoes leave the outbox, and
the remaining outbox replays through the same fold. Deletion is physical.
A delayed `updateRow` or `deleteRow` against an absent row folds to an
accepted deterministic no-op, so nothing resurrects and no tombstone record is
needed to block resurrection. The cursor advances in that same transaction.

## Evidence run

Commands:

```sh
bun x tsc -p demos/local-first-sync/tsconfig.json --noEmit
bun test demos/local-first-sync/gates/gate1.test.ts
bun test ./demos/local-first-sync/gates/__benchmarks__/gate1-physical.bench.ts
```

Result: 13 tests passed, 0 failed. The suite ran:

- successful push with lost acknowledgement and acknowledgement before echo;
- both same-cell acceptance orders while local intent is pending;
- physical delete racing a late update: the delayed update is accepted, folds
  to a no-op on every replica, and the row stays absent everywhere;
- a create retried after a lost acknowledgement: sequence dedup absorbs it
  with no `create-conflict` refusal;
- a duplicate `createRow` from a corrupt replica: the whole push (including a
  fresh row smuggled in the same batch) is refused with `create-conflict`,
  the actor's high-water never advances, retries converge to the same
  refusal, and the replica recovers by discarding state, rebootstrapping from
  the current snapshot, and continuing past its frozen high-water;
- folding an accepted duplicate `createRow` locally throws a distinct fatal
  replica-corruption error in the reference and both SQLite candidates, with
  the failed transaction rolled back;
- duplicate and reordered pull pages;
- crash before and after local commit, midway through a multi-operation server
  mutation, and during pull-page application;
- database-session generation fencing for stale responses;
- one atomic mutation spanning multiple rows and tables;
- actor-sequence duplicate and gap handling plus records-schema refusal;
- collision-free internal comparison keys for arbitrary table and row ids;
- partial-row quarantine via incomplete `createRow`, completing-update
  promotion, pending replay, reopen, update, and physical delete;
- 16 deterministic 80-event schedules across three replicas with fresh
  identities for every create and delayed updates/deletes against possibly
  deleted rows, compared after every event and fully drained to convergence;
- a delta-debug minimizer that runs if a generated schedule fails.

The reference model, Bun SQLite server, Candidate A pull applier, and Candidate
B pull applier are separate implementations. Lockstep comparison covers server
canonical state/log/high-waters and each client's visible rows, quarantine,
outbox, next actor sequence, and pull cursor.

## Physical comparison

Measured after the same 50-row workload and a WAL checkpoint:

| Measure | A: canonical + projection | B: typed only | Difference |
| --- | ---: | ---: | ---: |
| SQLite tables | 7 | 6 | B removes 1 table |
| SQLite bytes | 61,440 | 53,248 | B removes 8,192 bytes (13.3%) |
| Formatted implementation lines | 421 | 439 | B adds 18 lines (4.3%) |

SQLite byte counts are page-quantized proof-workload measurements, not a scale
benchmark. The line count is also deliberately unflattering to B: its targeted
direct applier is a little longer than A's rebuild-all projection. B still wins
the ownership and first-read comparison:

```txt
A: accepted canonical rows -> replay outbox -> rebuild typed projection -> query
B: typed rows + pending overlay already materialized                 -> query
```

A owns three representations of live values (canonical, projection, outbox).
B owns one live representation plus pending intent and exceptional quarantine
state. Both give application queries ordinary typed SQLite tables, and neither
retains any deletion history.

## What this does not prove

The current measurements include Gate 2's identical client staging table and
snapshot methods in both candidates. Gate 1 by itself did not prove snapshots;
that later evidence is in [`GATE2-EVIDENCE.md`](GATE2-EVIDENCE.md).
Records-epoch replacement, browser OPFS behavior, Durable Object parity, scale
performance, limits, and reactive invalidation remain later work. Candidate A
remains in this proof directory only as the tested control; it is not selected
production design.
