# Decision memo: Epicenter record storage and synchronization

Date: 2026-07-11. Cold-start adversarial investigation; primary-source
research on five external systems plus a field sweep, a working end-to-end
demo (12/12 contract proofs passing), and a same-browser benchmark.

## 1. Executive decision

**Build the minimal Epicenter protocol on plain SQLite: OPFS in the browser,
one authoritative per-principal SQLite oplog on the server, cell-level
operations, conflicts resolved by server acceptance order. Keep Yjs exactly
where it earns its memory: lazy child documents for authored bodies, stored
as update frames inside the same local SQLite database.**

Do not adopt Turso Sync, ElectricSQL, Zero, PowerSync, or LiveStore as the
foundation. Every one of them fails at least one non-negotiable line of the
product contract *today* (§3). The protocol's core is small — push
named-cell ops, pull the accepted log, poke over WebSocket; this
investigation built a working version in one afternoon and the demo proves
all 12 contract properties end-to-end (§4). The production system is NOT
small (§7 prices it honestly, including contracts an adversarial review
surfaced in §9); the claim is that its complexity is better-shaped than any
candidate's operator stack or semantics, not that it is free.

This ratifies and extends the prior investigation's direction (per-cell
conflict boundary, SQLite-owned records, engine-portable semantic contract)
with one deliberate contract change the mission authorized: **the server may
be authoritative and schema-aware.** Same-field conflicts resolve by
acceptance order on the server log, not wall-clock LWW and not CRDT
tiebreak. That single decision deletes the entire distributed-conflict
problem for record metadata: the client's materialization converges to the
log by construction, old clients cannot erase fields they cannot name
through cell writes (row deletion is the one whole-row verb and needs the
tombstone/generation treatment in §7 — an adversary correctly caught the
demo hand-waving this), and "who won" is always answerable by reading the
log.

## 2. One-sentence product explanation

> Your app starts with a real database on your device that works forever
> without an account; signing in just points it at a server that keeps the
> ordered history of everyone's changes, so every device ends up with the
> same rows — and note bodies merge like Google Docs while everything else
> merges like a spreadsheet, cell by cell.

## 3. Comparison matrix

Contract lines: **A** born-local + indefinite anonymous use, **B** offline
writes durable, **C** attach-later without server as migration destination,
**D** different-field edits compose, **E** same-field by server order, **F**
old client can't erase unknown fields, **G** browser WASM/OPFS + Safari +
multi-tab, **H** live local queries without polling, **I** transparent
self-host (light operator stack), **J** local schema migration + mixed
versions, **K** license/maturity, **L** Yjs child docs beside it.

| | A | B | C | D | E | F | G | H | I | J | K | L |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| **Zero** | ✗ by design | ✗ rejected offline | ✗ | mutator-dependent | ✓ | mutator-dependent | partial | ✓ IVM | heavy (PG+cache+your API) | server-owned | 1.0, Apache | ✗ awkward |
| **Electric** | ✗ shape cache | outbox add-on | ✗ | your API's job | your API | your API | young persistence | ✓ TanStack DB | heavy | 409 = full resync | 1.0, Apache | ✗ |
| **Turso Sync** | ~broken today (#6363/#6673) | ✓ | ✗ pre-existing DB won't sync | undocumented impl artifact | "last push wins" | ✓ (test-only) | single-tab, COOP/COEP | ✗ no change API | dev-grade server | young, open bugs | beta 0.x, MIT | ✗ |
| **PowerSync** | ✓ documented | ✓ | ✗ upload-queue → your API → source DB | ✓ PATCH cols | ✓ server order | ✓ | ✓ incl. Safari VFS | ✓ watched | heavy (source DB + service + storage DB + your API) | ✓ views | GA, FSL | awkward |
| **LiveStore** | ✓ | ✓ | ✓ event replay | ✓ via materializers | ✓ rebase | ✓ unknown events | full DB in RAM/tab | ✓ | CF DO or DIY | ✓ rematerialize | pre-1.0, bus factor ~1 | ✗ second engine |
| **Per-cell Yjs (baseline)** | ✓ | ✓ | ✓ | ✓ | ✗ client-ID tiebreak | ✓ | ✓ | ✓ | ✓ existing relay | contract lock | in-house | ✓ native |
| **SQLite + minimal protocol (chosen)** | ✓ | ✓ | ✓ proven | ✓ proven | ✓ proven | ✓ proven | ✓ (multi-tab = gap, §7) | ✓ proven | **one Bun file / one DO** | ✓ proven | in-house | ✓ proven |

Sweep verdicts (one line each): **Evolu** — column-LWW SQLite, maintained,
MIT, but mandatory E2EE/blind relay contradicts the schema-aware server and
ADR-0004's trust-the-relay posture. **TinyBase** — cell-level CRDT merge and
a DO sync server, but fully in-memory and peer-symmetric (no server
authority). **cr-sqlite** — dormant since 2024. **Automerge 3** — memory
fixed, but a second CRDT runtime duplicating Yjs. **Jazz** — whole-worldview
buy-in (identity/permissions/E2EE). **Triplit** — acqui-hired, community
stewardship. **RxDB** — paid OPFS plugin, doc-level conflicts.
**PouchDB/CouchDB** — doc-revision conflicts, no field merge. **Fireproof,
Verdant, WatermelonDB, DXOS, Ditto, InstantDB, Graft, SQLSync** — each fails
maturity, field-merge, self-host, or born-local (details in research notes).

Why the two nearest misses lose:

- **PowerSync** is the strongest external validation that the chosen shape
  is right — born-local + attach-later, changed-columns-only PATCH,
  schemaless-JSON-plus-views mixed-version safety are all *documented,
  shipped* versions of what we want. But adopting it means: your operator
  story becomes source-DB + PowerSync service + storage DB + your write API
  (vs. one Bun file); the server becomes the migration destination on
  attach; rejected writes silently revert; FSL license; alpha Tauri; and
  DB-per-principal isn't the native topology. We'd be running three services
  to get a protocol whose demo core is ~600 lines and whose production
  version §7 prices honestly. One symmetric-cost admission the adversary
  forced: PowerSync's write-API/validation/rejection work is work we pay
  too; the *asymmetric* differences that decide are the operator stack, the
  server-as-migration-destination attach, and FSL.
- **Turso Sync** is the one to *watch*: MIT end-to-end, real browser OPFS
  database, CDC-based logical mutations, per-column replay in the current
  implementation, and a platform built for millions of tiny DBs. Today it
  fails born-local→attach (open issues #6363, #6673), documents only "last
  push wins," exposes no change-notification API (reactivity would poll),
  locks to a single tab, and its self-host sync server is a dev-grade
  harness. Re-evaluate at 1.0; the semantic contract here is deliberately
  engine-portable so Turso could later replace the storage/transport layer
  without touching app code.

## 4. What the demo proved (12/12)

`bun proofs.ts` — two isolated browser clients (separate Playwright
contexts), canonical Bun server started mid-run:

1. Client A created and queried notes before any server process existed
   (zero requests observed).
2. Reload restored the complete local database from OPFS.
3. Local mutation updated the UI in <250ms with zero network traffic.
4. Sign-in ran the Add migration **while offline**: typed cell-level import
   plan applied into the principal's *local* database; server had 0 rows
   until sync later drained the outbox (server ≠ migration destination).
5. A's offline `title` edit and B's offline `subtitle` edit to the same row
   both survived on both clients.
6. Same-field offline conflict, discriminating interleaving: B edited
   FIRST in wall-clock time, A edited 300ms later, but A pushed first and B
   pushed second — B (older timestamp, later acceptance) won everywhere.
   Wall-clock LWW would have picked A; only acceptance order picks B.
7. A v1 client (no `subtitle` in its schema) received newer-field data into
   an `extra` JSON column, carried it, edited `title`, and erased nothing.
8. Zero requests during 3s idle; a remote insert appeared in A's DOM via
   WS poke → pull → change event (no polling anywhere).
9. Yjs bodies: zero frames loaded until a body was opened; concurrent
   offline appends from A and B merged to identical text on both.
10. Killing the server never blocked local reads/writes; the outbox drained
    after restart.
11. A schema-major-mismatched client got 409, paused sync, and kept a fully
    usable local database; nothing leaked to the server.
12. The same client code path synced against `--mode selfhost`, where every
    bearer resolves to the literal `instance` principal (ADR-0075 shape).

Two bugs found *by* the proofs, both instructive for production: local
writes must schedule a push (outbox ≠ transport), and clients must apply
pulled ops in log order **including their own echoes** or same-field
convergence breaks (echo-skip re-derives the stale-writer wound in
miniature). A third came from the adversarial review: the original proof 6
interleaving could not distinguish acceptance order from wall-clock LWW;
the discriminating version above replaced it.

## 5. Benchmark (same browser, Honeycrisp's 9-field notes shape)

Playwright Chromium 143, macOS, cross-origin isolated; Yjs legs =
y-indexeddb; SQLite = wasm 3.53 + opfs-sahpool, per-cell clock table
included (the honest sync-metadata cost). Raw: `bench-results.json`.

| 50,000 rows | seed | cold open | settled mem | query100 | search | edit1 | remote500 | churn 20k | restart | disk |
|---|---|---|---|---|---|---|---|---|---|---|
| whole-row YKV | 249ms | 273ms | 57.5MB | 3.0ms | 1.5ms | 0.7ms | 7.2ms | **12.0s** | 442ms | 2.6MB |
| per-cell Yjs | 359ms | 463ms | **98.2MB** | 8.3ms | 6.9ms | 0.1ms | 1.8ms | 67ms | 534ms | 2.4MB |
| SQLite + per-cell clocks | 2.4s | **64ms** | **17.5MB** | 3.0ms | 105ms | 5.0ms | 565ms | 10.7s | 75ms | 27.6MB |
| SQLite, chosen shape (no clocks) | 696ms | 67ms | 17.5MB | 3.3ms | 108ms | 4.0ms | 298ms | 4.6s | 78ms | 14.2MB |

The fourth row exists because the adversarial review caught an asymmetry:
the clock table models sync metadata a *client-merge* engine needs, but the
chosen server-acceptance-order protocol needs only an outbox and a cursor.
Both are reported; the chosen shape is the honest comparison row (its churn
cost is durable-commit page traffic, and its own omission — outbox rows
during offline periods — is bounded by outbox drain, unlike the clock
table's permanent rows-times-fields growth).

At 10k: memory 16.3 / 28.0 / 17.5MB; cold open 61 / 101 / 40ms. At 1k all
three are effectively free.

Reading it honestly:

- **Memory is the verdict.** SQLite is flat (~17.5MB including WASM heap and
  an 8MB page-cache cap) at every scale; both Yjs layouts scale linearly
  with rows × cells (per-cell ≈ 2KB/row here, matching the prior
  investigation's 1.2KB/cell-entry finding). This is the disk-backed-vs-
  materialized distinction, measured in one browser.
- **Cold open is the second verdict:** 64ms vs 463ms at 50k, and SQLite's
  number doesn't grow with history.
- **Where SQLite loses, the loss is either tunable or a harness artifact.**
  Seed/churn times include full transactional durability to OPFS on every
  batch (the Yjs legs return before y-indexeddb finishes flushing —
  their `persist` wait is a fixed 250ms courtesy, not a durability barrier);
  the churn workload spends most of its time upserting the 450k-row
  per-cell clock table, which a production engine would fold into the row
  or batch differently; `search` is un-indexed LIKE — FTS5 exists for
  exactly this. Single-cell edit at 5ms *durable* vs 0.1-0.7ms *in-memory*
  is the honest price of commit-on-write.
- **TinyBase was not benchmarked**: it fell at the same fence as the Yjs
  legs by construction (fully in-memory materialization), so a number would
  not have changed the decision.

Limitations, stated plainly: one browser (Chromium headless) on one machine;
`performance.memory` + WASM-heap accounting rather than
`measureUserAgentSpecificMemory` (refused in headless); no real
Safari/iPhone run — automation for those was unavailable in this
environment. A manual device harness ships in the demo
(`bench/<engine>.html?autorun&rows=10000`) and should be run on the oldest
supported iPhone before the production wave; the *relative* memory/cold-open
story cannot invert (it is object-count vs page-cache scaling), but absolute
numbers and Safari OPFS behavior (single SAH-pool tab, eviction policy,
private-mode failure) must be measured, not assumed.

## 6. Recommendation detail: adopt / wrap / build / retain

- **Build** the record plane: cell-op protocol, per-principal server oplog
  with acceptance-order authority, client outbox + pull cursor + poke.
  The demo's ~600 lines are the spec; production hardening is §7.
- **Retain** Yjs for what it is uniquely good at: child documents (bodies),
  which stay lazy, merge independently, and now persist inside the same
  local SQLite file (one durable store per profile, not three).
  KV preference state can stay on its current path.
- **Retain** the current relay/room plane for live collaboration where it
  exists today. The record plane is a *second* server surface (log + poke),
  not a replacement for Yjs doc sync; ADR-0079's sync plane is unchanged
  for docs. Whether record-poke and doc-sync share one WebSocket is a
  production-wave decision, not a contract one.
- **Wrap nothing.** PowerSync remains the fallback if building stalls: it
  is the only external system whose documented behavior covers the
  contract's hard lines, at the cost of its operator stack, server-as-
  destination attach, and FSL.
- **Watch Turso** for 1.0: if born-local→attach and documented column merge
  land, it becomes a candidate *storage/transport* under the same semantic
  contract.
- **Retire the per-cell Yjs record layout as the general foundation.** The
  prior session's contract work (permanent keys, required/optional, issues
  lane, additive evolution) survives intact — it was written
  engine-portable, and this is the engine decision. Per-cell Yjs remains a
  valid bounded-scale bridge for existing workspace tables until the
  production wave lands; nothing regresses in the meantime.

## 7. Production-gap list (demo → real)

- **Delete semantics (adversary finding, blocker-class).** The demo's
  `row-delete` physically deletes; a late cell op resurrects a blank row,
  and delete is the one verb through which an old client CAN erase newer
  fields. Production: row generation / causal-length tombstone (cr-sqlite's
  odd/even counter is the reference design); a cell op addressed to a dead
  generation parks as an orphan, exactly like the per-cell Yjs contract's
  orphan-cell rule. This is required, not optional.
- **Session/database generation isolation (adversary finding,
  blocker-class).** In-flight pulls/pushes must be aborted or
  generation-checked across sign-in/sign-out so a delayed response can
  never apply to the wrong database or clear the wrong outbox.
- **Op identity.** Demo opIds are time+counter with 6-char client suffix;
  a collision plus INSERT-OR-IGNORE idempotency silently drops a mutation.
  Production: UUIDv7 opIds, server-assigned clientIds.
- **Server-side validation.** The demo server JSON-casts ops. Production
  validates the op union, sizes, and field names against the schema
  contract, and rejects per-op with a typed reason (this is exactly what
  "the server may understand schemas" buys; it is also the write-API work
  PowerSync would have made us do anyway).
- **`extra`→column promotion.** When an upgraded client adds a column that
  previously landed in `extra`, promote and clear the JSON copy on open;
  otherwise a later export overlays stale values. One migration function,
  but it must exist.
- **Doc lifecycle.** `doc` ops carry no parent-row link; deleting a row
  should (at minimum) garbage-collect its body log locally and tombstone
  it in the oplog compaction pass.
- **Poke fan-out cost.** Every push wakes every connected device of the
  principal for a pull; fine at personal-device counts, but the hosted DO
  should coalesce pokes and the pull is already cursor-bounded.
- **Pending-op rebase / optimistic overlay.** The demo applies pulled ops
  over local pending state and reconverges after push (transient flicker).
  Production wants the Replicache/LiveStore shape: materialize = log ∪
  outbox, rebase outbox on pull. Client-side only; protocol unchanged.
- **Synchronous `scan()`.** `fromTable` requires sync reads; a worker-owned
  async SQLite cannot serve it directly. Options: page-side materialized
  view of active queries (invalidation-driven, like the demo's list), OPFS
  in a SharedWorker with sync page-side cache, or relaxing the contract to
  async for record tables. This is the largest *client architecture*
  decision left.
- **Multi-tab.** `opfs-sahpool` is one handle per origin: the demo is
  single-tab per profile. Production: SharedWorker owns the DB (LiveStore/
  PowerSync shape) with Web-Locks leader election; Android WebView has no
  SharedWorker (single-tab fallback).
- **Bootstrap + compaction.** New device currently replays the whole oplog;
  production needs snapshot-then-cursor bootstrap, which is also the log
  truncation mechanism (one mechanism, two jobs). Doc frames need periodic
  Yjs-merge compaction (`Y.mergeUpdates` is doc-free).
- **Auth.** Demo bearer == principal. Production: existing Epicenter OAuth
  session → principal resolver on the hosted DO; instance bearer on
  self-host (both resolvers already exist in `packages/server`).
- **Schema/version policy.** Demo has one major + additive fields + `extra`
  carry. Production needs the contract lock from the prior investigation
  (permanent keys, additive-only, retired-keys ledger) applied to the
  SQLite DDL generator, plus the pause-UX for major mismatches.
- **Conflict UX.** Acceptance order is silent; same-field losers just
  converge. Whispering/Honeycrisp-scale apps likely never need more; if a
  surface ever does, the log contains everything needed to show "your edit
  was superseded."
- **Durability/eviction.** `navigator.storage.persist()`, quota monitoring,
  Safari 7-day ITP for non-persisted origins, backup/export (the DB is one
  SQLite file — export is trivial, and that's a feature).
- **Server hardening + honest DO port.** Pull pagination loop (demo caps
  at 2000), oplog indices, WAL checkpointing, rate limits. "One Bun file"
  is the self-host story; the hosted path is a real port: routing Worker +
  DO class + migrations, `ctx.storage.sql` instead of `bun:sqlite`,
  hibernatable WebSockets with restore-on-wake for pokes, per-principal DO
  addressing. Same protocol, nontrivial packaging.
- **Snapshot bootstrap protocol, not just a fast path.** Pull needs a log
  generation/watermark and a `snapshot-required` response so compaction can
  never silently skip a stale offline client's missed ops.
- **Tauri/iOS.** Native SQLite via Rust/Swift with the same protocol; the
  WASM layer is browser-only by design. This is a port, not a redesign.

## 8. Smallest next implementation wave (no production migration)

1. Decide the synchronous-read seam (§7 item 2) — it shapes the client.
2. Extract the demo protocol into a real spec'd module with the contract
   lock applied; add snapshot bootstrap + pull pagination.
3. Run the manual device harness on the oldest supported iPhone + Safari
   macOS; record absolute numbers.
4. Wire ONE table of ONE app (Whispering recordings is the natural pilot:
   insert-heavy, delete-heavy, already has retention) behind the existing
   `ReadonlyTable` contract, feature-flagged, no data migration.

Explicitly not now: migrating Honeycrisp, touching ADR-0079's doc-sync
plane, multi-tab SharedWorker work, Tauri port.

## 9. Adversarial review and ruling

A fresh-context adversary (Codex, reading only the memo and demo code)
returned 17 findings and the verdict that the build recommendation "falls
as a build-vs-buy decision as currently argued." Full findings are in the
session transcript; every code-level finding was accepted and either fixed
in the demo (discriminating proof 6; no-clock benchmark variant) or folded
into §7 as named production contracts (delete generations, session
isolation, op identity, validation, extra-promotion, doc lifecycle,
snapshot watermark, DO port, poke cost).

Ruling on the verdict itself: the recommendation stands, because the
adversary's findings raise the price of BUILD without lowering the price of
any BUY. Zero and Electric are disqualified by their own documentation, not
by our demo's quality. Turso's born-local attach is broken upstream and its
reactivity gap is architectural. LiveStore's full-database-in-RAM is the
exact failure this investigation exists to escape. PowerSync survives the
findings untouched — but every serious finding (validation, rejection UX,
delete semantics, session isolation) is work PowerSync also demands of its
integrator, on top of its three-service operator stack and
server-as-destination attach. What the adversary genuinely changed: the
"~600 lines" framing, the delete-immunity claim, proof 6's evidentiary
value, the benchmark's metadata assumption, and the size of §7. Those
amendments are in this revision. The correct reading of this memo is now:
the semantic contract is proven, the moving parts are demonstrated
end-to-end, and the production system is a priced, bounded engineering
project whose shape no external candidate currently sells.

---

*Evidence trail: four primary-source research reports (Turso, Electric +
PowerSync, Zero, LiveStore + 18-system sweep) with URLs and confidence
levels in the session transcript; repo seam evidence from
`packages/sync`/`packages/server`/Honeycrisp boot/`fromTable` (Codex sweep,
file:line cited); `proofs.ts` and `bench/` in this directory are runnable.*
