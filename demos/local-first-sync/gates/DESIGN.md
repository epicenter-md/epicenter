# Falsification gates: reference model and algorithms

Date: 2026-07-11. Throwaway proof wave extending `demos/local-first-sync/`.
The 12-proof demo stays untouched; everything here lives under `gates/` and
implements the HARDENED protocol (v2) that the decision memo priced in §7.

Goal: make three claims executable and falsifiable:

- **Gate 1** — pending-write rebase: `visible = canonical ⊕ outbox` under
  arbitrary schedules, faults, and crashes.
- **Gate 2** — snapshot/bootstrap + compaction: the server may permanently
  delete old oplog history without stranding any client, including
  years-stale clients holding pending mutations.
- **Gate 3** — mixed-schema preservation: an old client carries unknown
  fields through restart/patch/push/export, and upgrade promotes them into
  typed columns exactly once.

## 0. Method

1. A **pure, deterministic, in-memory reference model** (`reference.ts`) is
   the spec. No I/O, no wall clock, no randomness of its own.
2. A **seeded schedule generator** (`harness.ts`) produces concrete event
   traces (every random choice resolved) across a server and 3 clients,
   including fault events at every durable boundary.
3. The **real SQLite engines** (`engine-client.ts`, `engine-server.ts`,
   bun:sqlite, same table shapes as the browser OPFS worker / demo server)
   implement the same state machine **independently in SQL** — they do not
   import the reference fold. Client crash = close + reopen from file.
4. Reference and real run the SAME trace in **lockstep**: after every event,
   canonical, visible, outbox, and cursor are compared exactly. At flush
   (drain all outboxes, pull to head), all clients ≡ server ≡ reference.
5. Transport faults (drop, duplicate, delay/reorder, crash-between-
   boundaries) are modeled at the message layer; HTTP/WS plumbing was
   already proven by the 12-proof demo. Playwright remains the harness for
   OPFS durability and visible reactivity only (per mission).

Determinism: UUIDv7 mutation IDs use the harness's logical clock (event
counter) + seeded PRNG bits, so identical seeds produce identical traces
byte-for-byte.

## 1. Protocol v2 (gates variant)

### Identity

- `clientId` — **server-assigned** at registration (`register()` returns
  `c<n>` per principal). Persisted durably in the client DB. A crash before
  persisting simply re-registers; the orphaned id has `lastClientSeq = 0`
  and is harmless.
- `mutationId` — UUIDv7, client-generated, globally unique. Server enforces
  a UNIQUE index (defense in depth).
- `clientSeq` — per-client monotone counter (1, 2, 3, …) assigned at
  mutation creation. This, not the UUID, drives dedup and outbox pruning.

### Mutation (the atomic unit)

```
Mutation = { mutationId, clientId, clientSeq, ops: Op[] }
```

All ops of a mutation apply in one transition. The server log stores whole
mutations (one seq per mutation), and pull pages align to mutation
boundaries, so no replica can ever materialize half a mutation.

### Ops and row generations

Rows carry `(gen ≥ 1, alive)`. Every op addresses a generation.

```
Op = { kind: 'row-insert', rowId, rowGen, cells: Record<field, JsonCell> }
   | { kind: 'cell',       rowId, rowGen, field, value }
   | { kind: 'row-delete', rowId, rowGen }
```

**The fold** (pure function `apply(state, mutation) → state`, identical on
server and every client):

- `row-insert`:
  - row unknown ∧ rowGen = 1 → create `{gen: 1, alive, cells}`.
  - row known ∧ alive ∧ rowGen = gen → **merge** cells (each cell as a cell
    write; this is what makes sign-in Add-import idempotent and lets two
    devices import the same stable rowId).
  - row known ∧ ¬alive ∧ rowGen = gen + 1 → **reinsert**: fresh row,
    `gen := rowGen`, old cells do NOT revive.
  - else → no-op.
- `cell`: applied iff row known ∧ alive ∧ rowGen = gen; else no-op.
  A late cell op can never resurrect a deleted row and never bleeds across
  generations. `value = null` is a CLEAR (distinct from absent).
- `row-delete`: applied iff row known ∧ alive ∧ rowGen = gen →
  `alive := false`, cells dropped. The tombstone `(gen, ¬alive)` is
  **permanent canonical state** and travels in snapshots — otherwise a
  fresh bootstrap would fold `insert(gen 1)` differently than the server
  did. (Unbounded tombstone growth is a priced production gap: purging
  requires a database-epoch bump that forces full re-bootstrap.)

There is **no per-op rejection**: the log records accepted mutations
verbatim and the fold decides effects deterministically, so every replica
that folds the same log prefix holds the identical state. Server-side
accept validation covers protocol/schema major, clientSeq contiguity, and
malformedness only.

Clients stamp `rowGen` from their **visible** state at mutation-creation
time (a reinsert after a pending delete sees the pending dead gen and uses
gen + 1).

### Server accept (atomic per mutation)

```
accept(m):                              -- ONE transaction
  if m.clientSeq ≤ lastClientSeq[m.clientId]: skip (duplicate delivery)
  if m.clientSeq > lastClientSeq[m.clientId] + 1: REJECT (gap = client bug)
  seq += 1; log[seq] = m; fold m into materialized state
  lastClientSeq[m.clientId] = m.clientSeq
```

Push = the client's whole outbox in order; retries resend it; dedup makes
that idempotent. Push response returns `lastClientSeq` but **push acks
never prune the outbox** (see below).

### Pull, snapshots, compaction

Server keeps `watermark` (highest compacted seq) and at most one snapshot:

```
snapshot = { snapshotSeq, rows (incl. tombstones), lastClientSeq map, checksum }
compact(upTo): take snapshot at upTo; delete log ≤ upTo; watermark = upTo
pull(cursor, limit):
  if cursor < watermark → { snapshotRequired, snapshot }
  else → { mutations (cursor, cursor+limit], newCursor, hasMore,
           lastClientSeq[requesting client], stateChecksum }
```

Checksum = FNV-1a over a canonical serialization (rows sorted by id, fields
sorted; includes gen/alive). Clients verify after snapshot install and the
harness verifies at flush.

## 2. Client state machine

Durable, in ONE SQLite file: `canonical` rows (id, gen, alive, cells JSON —
schema-blind), `outbox` (clientSeq, mutation JSON), `meta` (clientId,
cursor, dbGen bookkeeping). Volatile: in-flight requests, sync status.

**The Gate-1 invariant, by construction:**

```
visible = fold(canonical, remaining outbox in clientSeq order)
```

`visible` is a derived projection (typed columns + `extra` JSON sidecar for
fields outside the client's known set). The reference recomputes it after
every transition; the SQLite engine rebuilds the projection for affected
rows inside the same transaction as the canonical/outbox change — there is
no durable boundary at which visible disagrees with the formula.

**Prune rule (the crux):** an outbox mutation is removed exactly when its
effect is provably contained in canonical:

1. its echo (`mutation.clientId = me`) arrives in a pulled page — pruned in
   the SAME transaction that folds the page into canonical and advances the
   cursor; or
2. an installed snapshot has `lastClientSeq[me] ≥ its clientSeq` — the
   snapshot state already contains the mutation's effect (snapshotSeq ≥ its
   log seq, because the server had accepted it).

Push acks never prune: pruning on ack while the echo is not yet in
canonical would drop the pending overlay and transiently lose intent —
exactly the demo flaw this gate exists to falsify.

**Pull algorithm** (each numbered step = one atomic transaction = one crash
boundary):

1. request `pull(cursor)` (tagged dbGen/sessionGen).
2. `snapshotRequired` → verify checksum; then atomically: replace canonical
   with snapshot rows, `cursor := snapshotSeq`, prune outbox by
   `lastClientSeq[me]`, rebuild visible (remaining outbox replays on top —
   a years-stale client keeps its pending intent).
3. else per page, atomically: **CAS on cursor** (apply only if
   `response.fromCursor = current cursor` — kills stale/duplicate
   responses), fold mutations, prune echoes, `cursor := newCursor`,
   rebuild visible.
4. `hasMore` → loop from 1.

**Generations:**

- `dbGen` — bumped on profile/database switch and sign-in/sign-out that
  swaps the active DB. Every in-flight response is tagged; mismatch ⇒
  discarded wholesale (no state touch).
- `sessionGen` — bumped on sign-out/sign-in within the same DB; same
  discard rule. (Cursor-CAS already makes stale pulls inert; generations
  make the discard unconditional and cover push acks too.)

**Crash model:** every durable step above is one SQLite transaction. Crash
= lose volatile state, reopen the file; the engine recovers to the last
committed transaction, which is by construction a reference-reachable
state. The reference model mirrors this: its "durable" fields are exactly
the client DB contents; crash resets volatile fields only.

## 3. Schema versions (Gate 3)

- Canonical is schema-blind (verbatim cell maps), so version affects only
  (a) which fields a client can WRITE (v1 never emits `subtitle`) and
  (b) the visible projection (known fields → typed columns; unknown →
  `extra` sidecar, preserved through restart, export, and local patches).
- **Upgrade = projection rebuild** with the new known-field set: the
  subtitle value moves from `extra` to its column and the sidecar key
  disappears, in one transaction, exactly once, with no merge step that
  could overlay stale sidecar data — because the sidecar is derived state,
  not a second source of truth.
- `schemaMajor` mismatch (v3 simulation) ⇒ server refuses push/pull with
  `schema-mismatch`; client pauses sync; local writes continue; nothing
  leaks. Additive minor changes (v1↔v2) sync freely.

## 4. What the harness generates

Weighted random events per step (seeded, 3 clients + 1 server): local
writes (insert / cell patch incl. unknown-field and null-clear / multi-op
atomic mutation / delete / reinsert), start-push, server-processes-request,
deliver-response, drop-request, drop-response, duplicate-response,
client-crash+reboot, server compact(random ≤ head), pull-start /
pull-page-continue, offline/online toggle, sign-out/sign-in, profile
switch, client upgrade (gate 3). Flush phase then drains everything
fault-free and compares all replicas.

Directed traces additionally pin every named scenario: lost ack, duplicate
delivery, crash before/after each of {mutation commit, page apply, snapshot
install, cursor commit}, delete→reinsert races, same/different cell
conflicts, sign-in/out with responses in flight, brand-new and years-stale
bootstrap, compaction cutting a client's unpulled echoes, v1/v2 lifecycle,
major-mismatch pause.

Pass criteria per gate: every directed trace and every seeded schedule
holds lockstep equality reference≡real at each event, plus flush
convergence (all clients ≡ server ≡ reference, outboxes empty, no duplicate
application, no transient loss of pending intent at any step).
