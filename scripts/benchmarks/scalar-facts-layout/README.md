# scalar-facts-layout

A diagnostic instrument for one narrow question in Wave 2b: how might the
**confirmed scalar-facts table(s)** of the local replica and the server
authority store their structured coordinates and relation split, measured on
Bun `bun:sqlite` with a legacy initial-payload stress profile. It is never a
logical-state proxy or a frozen conformance run; see the qualification note
below.

It records conformance, storage, and workload observations. It never selects,
ranks, recommends, or freezes a layout.

Implementation status: only the exact analytical trace and its tests are
modular today. The parent `scalar-facts-layout.ts` still owns the older corpus
and runner. The parent remains a legacy conformance and storage diagnostic until
the exact trace, owner-specific auxiliary states, layouts, and measurement
method are connected behind one CLI.

## Scope (deliberately narrow)

This tool compares four candidate layouts of the **confirmed-facts table only**,
across two axes:

- relation layout: one unified `facts` table, or separate `row_facts` /
  `value_facts` tables;
- coordinate layout: inline structured coordinates, or a normalized
  `coordinates` dictionary keyed by `(kind, namespace, local_key)`.

It compares those four candidates against two owners with distinct workloads:
the **replica** (monotonic install, point reads, traversal, overlay,
tombstone-driven document cleanup) and the **authority** (ordered feed,
submission settlement, exact-retry, fold reads).

### What this instrument does NOT decide

The spec's physical-format break carries structured identity through confirmed
facts, pending intents, sealed submission state, parked diagnostics, and
document-liveness joins (spec Wave 2b, lines 847-864). Whether the
inline-vs-normalized coordinate *encoding* is a schema-wide choice binding every
address-bearing table is **source-silent**, and the non-facts stores
(sealed-submission ledger, document publication, blob publication, blob bytes,
metadata) are not yet designed in detail.

Therefore this instrument:

- measures **only** the confirmed-facts table layout;
- scopes its storage metric to the **candidate-varying tables** (`facts`, plus
  `coordinates` for the normalized candidates), so the normalized-vs-inline
  delta is not diluted or biased by fixture tables hard-wired to one encoding;
- **refuses to freeze** the schema-wide coordinate encoding or the layout of any
  non-facts store, and says so in its own report.

If Wave 2b intends a single schema-wide coordinate representation across every
address-bearing table, this instrument is the wrong shape and must be extended
(candidates, workloads, and constraint proofs) across those tables before any
freeze. That is an open ownership fork returned to Codex.

## Legacy diagnostic by construction

Bun can decide native schema and query-plan evidence but cannot qualify OPFS,
storage quota, WebKit, worker locks, mobile memory, backgrounding, or Durable
Object SQLite. Per ADR-0161 (65-68) and ADR-0163 (305-307), the exact V1
constants and the physical layout must be chosen by the browser, Bun, and
Cloudflare scale proof before ADR-0163 is Accepted. This tool reports a
`legacy-bun-diagnostic` summary with `decisionEligible: false`; it does not emit
the frozen classifier's `invalid`, `incomplete`, `provisional`, or
`ready-for-ADR-review` statuses. The live diagnostic report uses schema version
4.

### The 512 MiB / 1,000,000-live-address target is not a portability guarantee

No fixed 512 MiB portability guarantee is defensible. Treat it as a
**conditional normal-profile qualification** where runtime quota admits, with
peak headroom and quota-refusal atomic recovery measured. The tiers are:

- Legacy smoke diagnostic: 5,000 current facts / approximately 1 MiB initial
  payload.
- physical mobile floor: 250k / 128 MiB (physical iOS Safari and Android).
- conditional normal profile: 1,000,000 live addresses / 512 MiB where quota
  admits.
- informational desktop stress: 2M / 1 GiB.
- private/incognito is a **negative** compatibility/refusal test (persistence
  denied), never a durable qualification cell.

### Why the 512 MiB *logical* target cannot be claimed here

ADR-0161 states the target as 1,000,000 live scalar addresses and 512 MiB of
canonical encoded **logical state**. ADR-0167 defines logical state as present
rows and values only, explicitly excluding authority sequences and terminal
tombstones, but it leaves the exact canonical logical-state encoding an unfrozen
implementation decision ("the exact container, seal, and physical filename
encoding remain implementation decisions until a round-trip proof chooses
them"). This legacy parent therefore **cannot claim the 512 MiB logical
qualification**. Its `initialPayloadBytes` field sums payload strings while the
initial facts are installed, before aging introduces rewrites, tombstones, and
unsets. It is only a workload-size diagnostic, not final-present logical state
or current protocol-fact bytes. The modular `trace.ts` owns those two exact byte
measures.

## Measurement honesty

The legacy report retains three distinct diagnostics:

1. **initial payload bytes**: payload-string bytes generated for the initial
   facts before the aged workload. This is neither canonical logical-state size
   nor protocol size.
2. **steady physical DB footprint**: on-disk page bytes after checkpoint/settle.
3. **phase WAL sizes**: bounded file-size observations around declared phases,
   not cumulative write amplification.

The parent prints no logical-state amplification or protocol-overhead ratio.
Those require the exact modular trace and the predeclared measurement method.

## Diagnostic summary only

The parent runner retains each owner, candidate, repetition, metric, and storage
observation. It checks matrix completeness and correctness, then reports a
non-decision-eligible legacy diagnostic summary. Missing cells and failed
conformance remain visible. No materiality band, Pareto filter, candidate
ordering, or fallback tie-break is part of this runner.

## Oracle boundary

The modular `trace.ts` defines the analytical streaming oracle required by a
future maintained runner. Its final current fact is a closed-form function of
the address index, and its three-part witness contains the exact current-fact
count, exact current-protocol-fact bytes, and one ordered SHA-256 over facts in
ascending sequence. `trace.test.ts` validates that oracle against a small
map-backed fold, including row tombstone non-resurrection and every declared
lifecycle.

The legacy parent does not import that trace or reproduce its witness. It checks
physical constraints, SQLite integrity, close/reopen stability, and
cross-candidate semantic-hash agreement over its own deterministic corpus.
Cross-candidate agreement is not an independent oracle, which is another reason
the diagnostic is not decision-eligible. The parent reports its own namespace,
table, value, and lifecycle cardinalities only as legacy fixture diagnostics.

## Determinism

Seeded PRNG only; no wall-clock or `Math.random`. Namespace and table are chosen
by two independently salted hashes (never one correlated modulo). Paired
candidates within one repetition see exactly the same trace; each repetition
draws an independent data seed. The legacy full diagnostic uses five builds, but
it is not the four-seed measurement-method pilot. Short operations retain raw
samples.

## Files

- `scalar-facts-layout.ts` (legacy parent): CLI, profiles, argument parsing,
  conformance/storage report, and a non-decision-eligible diagnostic summary.
- `trace.ts`: deterministic corpus, aging events, and the independent oracle.
- `trace.test.ts`: analytical-oracle, determinism, and exact-byte tests.
