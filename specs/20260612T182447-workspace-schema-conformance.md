# Workspace schema conformance: visible queue + write guard

**Date**: 2026-06-12
**Status**: Draft
**Owner**: braden
**Handoff**: `specs/20260612T182447-workspace-schema-conformance.handoff.md`

## One Sentence

Workspace tables surface nonconforming rows as a visible conformance queue (two causes: schema changed under the row, or a newer app version wrote it) and refuse whole-row writes over rows stamped by a newer schema version, while `defineTable(v1, v2).migrate()` stays exactly as it is.

## How to read this spec

```txt
Read first:
  One Sentence
  Motivation (Current State)
  Implementation Plan (the five waves)
  Success Criteria

Read if challenging the direction:
  Research Findings
  Design Decisions
  Rejected Alternatives
  Edge Cases (especially "The guard is local-knowledge only")

Historical context (do not relitigate without new facts):
  Rejected Alternatives table, memory note
  epicenter_schema_evolution_direction.md in Claude project memory
```

## Overview

Adds read-side visibility (a conformance surface derived from parse errors the library already computes) and a write-side guard (refuse `set`/`bulkSet` over rows whose stored `_v` exceeds the binary's latest version) to `packages/workspace`. No schema API changes, no storage format changes, no new protocol.

## Motivation

### Current State

`parseRow` (`packages/workspace/src/document/table.ts:390`) computes precise per-row verdicts: `UnknownVersion` (stored `_v` matches no registered version, carries the stored version), `ValidationFailed` (carries the raw row), `MigrationFailed`. Then the read surface swallows them:

```ts
// table.ts: getAllValid() silently skips rows that fail parseRow.
getAllValid(): TRow[] {
  const rows: TRow[] = [];
  for (const [key, entry] of ykv.entries()) {
    const { data, error } = parseRow(key, entry.val);
    if (!error) rows.push(data);   // error -> row simply vanishes from the UI
  }
  return rows;
}
```

`getAllInvalid()` exists (`table.ts:450`) and has zero callers in any app. On the write side, `set()` (`table.ts:517`) never reads the stored row before replacing it:

```ts
set(row: TRow): void {
  ykv.set(row.id, stamp(row));  // whole-row LWW replace, stamps OWN latest _v
}
```

This creates problems:

1. **Silent disappearance**: edit a schema in place (the natural dev workflow; zero `.migrate()` calls exist in any app) and old rows vanish from every list view with no signal. Indistinguishable from data loss; the data is intact at rest.
2. **Old-binary clobber**: a stale binary's `set()` whole-row-overwrites a newer-schema row with a fresh LWW timestamp, destroying newer-only columns everywhere. `update()` is accidentally safe (routes through `get()`, which errors on unparseable rows); `set()`/`bulkSet()` are not.
3. **`count()` desync**: `count()` returns `ykv.size` (`table.ts:486`), which includes nonconforming rows that `getAllValid()` hides. Any "N items" UI next to a filtered list disagrees with itself today.
4. **No "update the app" signal**: a v1 binary reading v2 rows gets `UnknownVersion` per row, but no app aggregates it, so users on stale binaries see rows evaporate instead of a banner.

### Desired State

```ts
// Read side: the queue. Derived from what parseRow already computes.
const c = workspace.tables.entries.conformance();
// { valid: 12, nonconforming: TableParseError[], newerWriter: TableParseError[] }

// Write side: the guard. O(1) stored-_v check before replace.
const { error } = workspace.tables.entries.set(row);
// Err(NewerWriterRefusal) when stored _v > this binary's latest version.

// Repair is app code, not API: fix or discard queued rows deliberately.
// Every parse error carries `row` (the raw stored value), so all three
// nonconforming causes repair from it.
for (const err of table.conformance().nonconforming) {
  table.set(rebuildFrom(err.row)); // refusal surfaces at this call site
}
```

## Research Findings

Grounded against Jazz (garden-co/jazz via DeepWiki, 2026-06-12), Matter (`apps/matter`), and a fresh-context adversarial review of a proposed single-schema redesign.

| System | Version marker | Old-shape handling | Nonconforming data | Breaking changes |
| --- | --- | --- | --- | --- |
| Jazz | user-managed `version: z.number().optional()` | `withMigration()` on every load, idempotent, writes back | silently tolerated (optional-everything) | none; docs punt to app-level discriminated unions |
| Matter | none | none; schema is data (`matter.json`) | classified per cell, shown raw, human repairs | edit schema + fix files |
| Epicenter today | library-managed `_v`, positional tuple | typed `migrate` on read, never writes back | computed precisely, then hidden | none (epoch pattern archived) |
| Epicenter target | unchanged | unchanged | visible queue, two causes | unchanged (epochs stay deferred) |

**Key findings**:

- Nobody in the ecosystem has an authority/rollout protocol. Jazz's whole story is a version field plus additive discipline plus idempotent load-time migration. Epicenter's `_v` is the same strategy with better hygiene (library-managed, validated, typed).
- Jazz's write-back-on-load ("drain") is safe only because CoMaps are field-level CRDTs. Over Epicenter's whole-row LWW it requires a timestamp-preserving write verb that breaks the `YKeyValueLww` monotonic-clock invariant and creates a set-vs-repair misuse class. Refused.
- The fresh-context review blocked the single-schema + `recover` redesign: with no supervised migration moment, read-time transform code ships forever regardless of name, so "throwaway repair code" is false; and a manual `version` int decouples shape-change from version-bump, dying exactly on the forgotten-bump case the positional tuple structurally prevents.
- The same review contributed the write guard, which neither the status quo nor the redesign had, and identified the `count()` desync.

**Implication**: the reachable improvement is read-side visibility plus write-side guarding on the existing API. Everything larger loses to a named invariant (see Rejected Alternatives).

## Design Decisions

| Decision | Class | Choice | Rationale |
| --- | --- | --- | --- |
| Keep `defineTable(v1, v2).migrate()` unchanged | 1 evidence | keep | Positional tuple couples shape-change to version-bump; type system forces migrate. Fresh-eyes review verified the alternative's forgotten-bump failure mode against `table.ts`/`define-table.ts`. |
| Queue derivation | 2 coherence | derive from existing `parseRow` errors; no new storage, no new protocol | `UnknownVersion` with `version > versions.length` = newerWriter; `ValidationFailed`/`MigrationFailed` = nonconforming. All facts already computed. |
| Guard placement | 2 coherence | `set`/`bulkSet` check stored `_v` via `ykv.get` before replace | `update()` already safe via `get()`; the guard closes the symmetric hole at the same owner. |
| `set()` failure channel | 3 taste | return `Result<void, ...>` (wellcrafted), matching `update()` | Existing call sites discard the return value, so call sites compile unchanged. Silent no-op disqualified: silence is the disease this spec treats. Open Question 1 records the alternative. |
| `count()` | 3 taste | keep O(1) over raw entries; fix JSDoc; UIs use `conformance().valid` | Making `count()` validate is O(n) on a hot path. Revisit logged below. |
| Repair | 1 evidence | app-code loop over `getAllInvalid()` + `set()`; no library `repair()` API | Fresh-ts is correct for deliberate fixes (a repair IS an edit). ts-preservation needs `setWithTs`, which breaks the LWW monotonic-clock invariant. |
| Drain (write-back on read) | 1 evidence | refuse | Unsafe over whole-row LWW (timestamp matrix), reentrancy in reactive reads, `ReadonlyTable` consumers cannot drain (at-rest state would depend on which runtime read last). |
| KV evolution | Deferred | schema-widening only (union old and new) | KV is validate-or-default with no version routing; skew ping-pongs settings to defaults. Bring back when a KV shape actually needs a breaking change. |

## Rejected Alternatives

Each loses to a named invariant, not to taste. Do not reopen without new facts.

| Candidate | Killing invariant |
| --- | --- |
| In-doc `schemaVersion` write gate | Unenforceable: relay is byte-blind (E2E-ish), offline writers diverge before observing any marker. Advisory-but-authoritative-feeling is the worst combination. |
| Epoch protocol + device registry + consent | No first-party app has needed a breaking change. New-guid doc is the only real write fence; archived HeadDoc pattern stays the designated future surface. Trigger: first table rename/split or encryption-format change in a shipped app. |
| Single-schema `defineTable` + `recover(raw)` | Manual version int dies on forgotten bumps; old schemas migrate into hand-maintained unvalidated copies; transform ships forever anyway (no supervised moment). |
| Jazz-style drain | Whole-row LWW makes write-back either clobber-prone (fresh ts) or invariant-breaking (preserved ts). Safe for Jazz's field-level CRDTs only. |
| Field-level CRDT rows (Y.Map per row) | Kills versioned-row model and the measured `YKeyValueLww` storage wins; the write guard buys the load-bearing 10 percent for 1 percent of the cost. |
| Per-user Durable Object SQLite + intent updates | Deletes the local-first substrate (daemon, materializers, offline); the offline outbox rebuilds a worse sync engine. Server-side SQLite as a read-only projection inside the existing room DO remains a future option. |

## Grill round 2: read-surface consolidation (2026-06-12, post-wave-3)

A second adversarial pass (Codex + the implementer, after waves 1 to 3 landed) asked whether `conformance()` earns a separate method at all. The honest answer is that from scratch it would not: `get`, `getAll`, `getAllValid`, `getAllInvalid`, `filter`, `find`, and `conformance` all walk the same `ykv.entries() -> parseRow` boundary, and a list-plus-banner view now scans twice (`fromTable` reads `getAllValid`, `fromTableConformance` reads `conformance`). The ideal shape is a single classified scan:

```ts
table.scan(): { rows: TRow[]; nonconforming: TableParseError[]; newerWriter: TableParseError[]; storedCount: number }
```

with `getAll`, `getAllValid`, `getAllInvalid`, and `conformance` deleted, `filter`/`find` kept only if their short-circuit (find) or one-pass-predicate (filter) earns it, and `count`/`has` renamed to `storedCount`/`hasStored` to stop implying a parsed read.

**Why this is NOT folded into this spec's waves**: `@epicenter/workspace` is a published package (v0.2.0, not private) and `getAllValid()` / `getAllInvalid()` are documented in `packages/workspace/README.md`. `getAllValid()` alone has ~26 production callers across 8 apps plus the materializers and daemon. Collapsing the read surface is a deliberate semver-major migration of a published contract, a different product decision from "make nonconforming rows visible." Bundling it would turn a focused, already-clean visibility fix into a 30-plus-caller breaking sweep. It belongs in its own spec and its own build-prove-remove wave sequence (see `greenfield-clean-breaks` wave ordering).

**What round 2 DID change here (cheap, additive, in-scope)**:
- Every `TableParseError` variant now carries `row` (the raw stored value including `_v`), not just `ValidationFailed`. Before this, the repair UI could only repair one of three nonconforming causes; now all three (failed validation, failed migration, corrupt stamp) repair from the same raw value. Committed as `feat(workspace): carry the raw stored value on every table parse error`.

**Recorded for the follow-up spec** (do not silently drift toward it):
- Collapse the bulk read surface into `table.scan()`; delete `getAll`/`getAllValid`/`getAllInvalid`/`conformance`; migrate the 26+ `getAllValid()` callers; delete `fromTableConformance` (the single scan feeds `fromTable` directly).
- Rename `count()`/`has()` to `storedCount()`/`hasStored()`.
- Consider `bulkSet`/`clear` returning `{ refused: TableWriteError[] }` (carrying `storedVersion`) instead of `string[]`, so import banners can show the version skew.

## Architecture

Read path with the queue (no new computation, new aggregation):

```txt
ykv.entries()
  -> parseRow(id, raw)
       -> Ok(row)                                   -> conformance.valid
       -> ValidationFailed / MigrationFailed        -> conformance.nonconforming
       -> UnknownVersion, version > known latest    -> conformance.newerWriter
       -> UnknownVersion, version <= known latest   -> conformance.nonconforming (corrupt stamp)
```

Write path with the guard:

```txt
set(row)
  -> ykv.get(row.id)                  O(1) in-memory map
       -> absent                      -> stamp own latest _v, replace (today's behavior)
       -> stored _v <= own latest     -> stamp own latest _v, replace (today's behavior)
       -> stored _v >  own latest     -> Err(NewerWriterRefusal); row untouched
```

## Implementation Plan

Each wave is a standalone commit (see `standalone-commits`); wave claims included.

### Wave 0: make the docs stop lying

Claim: docs(workspace): correct the stale multi-version reference in the workspace-api skill.

- [ ] **0.1** Fix `.claude/skills/workspace-api/references/table-migrations.md:108`: it cites a Whispering multi-version migration; `apps/whispering/src/lib/workspace/definition.ts` contains five single-version tables (zero `.migrate()` calls exist in any app). Point to the test suite (`packages/workspace/src/document/create-table.test.ts`, `define-table.test.ts`) instead.
- [ ] **0.2** (Grill finding) The same file's Reference Implementations block cites two paths that do not exist: `apps/honeycrisp/workspace.ts` (now `apps/honeycrisp/honeycrisp.ts`) and `apps/fuji/src/lib/workspace.ts` (now `apps/fuji/src/lib/workspace/index.ts`). Fix in the same commit.

### Wave 1: the write guard (correctness before UX)

Claim: fix(workspace): refuse whole-row writes over rows stamped by a newer schema version.

- [ ] **1.1** Test first (two synced docs): old-tuple table `set()`s over a row stamped with a higher `_v`; assert refusal and that the newer row's columns survive. This is the clobber test gap named in review.
- [ ] **1.2** Add the guard to `set()` and `bulkSet()` in `createTable` (`table.ts`). Stored-`_v` lookup via `ykv.get(row.id)`; do not parse the row. Refusal predicate: stored value is an object whose `_v` is a number strictly greater than `versions.length`; anything else (absent, corrupt, non-numeric `_v`) passes through and the write repairs it. Verified (grill): `ykv.get()` reads `pendingDeletes` then `pending` then `map`, which is exactly the merged view the subsequent LWW replace displaces; observers fire synchronously at transaction end, so there is no stale window, and the monotonic clock (adopts max seen ts) means a local `set` always wins LWW locally, confirming the guard is the only local protection.
- [ ] **1.3** Failure channel: `set()` returns `Result<void, TableWriteError>`; `bulkSet()` returns `Promise<{ refused: string[] }>`, filtering refused rows per chunk at write time (not once up front: awaited chunk boundaries let a remote sync land a newer-stamped row mid-import). The `onProgress` percent contract stays over the input length, unchanged. New `TableWriteError` via `defineErrors` (see `define-errors` skill).
- [ ] **1.4** Decide and document `clear()` behavior (Open Question 2). `delete(id)` stays unguarded: deletion intent is shape-independent.
- [ ] **1.5** Typecheck all app packages: call sites discard `set()`'s return today, so this should be compile-clean; verify, don't assume. (Grill finding) Every surveyed call site silently discards the new Result, including agent-facing mutation handlers (`apps/fuji/src/lib/workspace/index.ts` `entries_create`/`entries_upsert` return `{ id }` regardless) and the Whispering state modules. Strictly better than today (refusal beats clobber), but wave 3's repair tool must surface refusals at its own call sites, and a follow-up sweep should propagate the Result through app action handlers.

### Wave 2: the conformance surface

Claim: feat(workspace): expose per-table conformance built from existing parse errors.

- [ ] **2.1** `table.conformance()` returning `{ valid: number; nonconforming: TableParseError[]; newerWriter: TableParseError[] }`, classified per the architecture diagram. Pull-based; consumers recompute on the existing `observe()` signal. No new event machinery. (Grill decision) It lands on `ReadonlyTable`, not `Table`: it is a pure read derived from `parseRow`, `createTable` spreads the readonly surface so writers get it for free, and read-only consumers (materializers call `getAllValid()` today; daemon projections) need queue visibility to report even though they cannot repair.
- [ ] **2.2** Fold wave-1 refusals into visibility: refused writes are diagnosable (at minimum, the `TableWriteError` carries id + stored version; consider a per-table refusal log only if an app needs it; do not build speculative surface).
- [ ] **2.3** Fix `count()` JSDoc to state it counts stored entries including nonconforming rows; point "N items" UIs at `conformance().valid`. (Grill nuance) `ykv.size` is the observer-confirmed map: it lags `pending` writes inside an open transaction, and the encrypted store's `size` additionally subtracts undecryptable entries. The JSDoc should say "observer-confirmed stored entries" rather than promising exact mid-transaction reads.
- [ ] **2.4** Tests: queue classification for each parse-error cause; `count()` vs `valid` documented divergence.

### Wave 3: svelte exposure plus one real consumer

Claim: feat(svelte): surface table conformance in fromTable and render the banner in one app.

- [ ] **3.1** Add a reactive conformance helper next to `fromTable` (`packages/svelte-utils/src/from-table.svelte.ts`; the handoff's `packages/svelte` path does not exist). `fromTable` returns a bare disposable `SvelteMap`, so grafting counts onto it would change its return shape; a sibling `fromTableConformance(table)` with its own observe subscription and debounce is the cleaner shape.
- [ ] **3.2** One app (fuji recommended) renders: a "N rows do not match the current schema" banner, a "written by a newer version of this app, update to edit" banner, and a minimal queue view with fix/discard actions implemented as the userland `getAllInvalid()` + `set()`/`delete()` loop. The view IS the repair tool; load `ui-design` and `writing-voice` for the surface.
- [ ] **3.3** Library helper and first consumer ship in the same wave (a helper without a call site is a teaser commit).

### Wave 4: record the contract

Claim: docs(workspace): record the schema-evolution contract and refusals.

- [ ] **4.1** `packages/workspace/src/document/README.md` design decisions: additive-within-doc discipline; editing a single-version schema in place is supported (old rows surface in the queue); the version tuple is for shipped apps whose users cannot run a repair; KV changes must be schema-widening.
- [ ] **4.2** Two ADRs (first entries in `docs/adr/`): "no in-doc schema write gates; epochs (new doc guid) are the only enforceable fence" and "conformance queue over silent skipping; repair is app code".
- [ ] **4.3** Update the `workspace-api` skill to teach `conformance()`, the guard, and the two-tier workflow.

## Edge Cases

### The guard is local-knowledge only (accepted residual risk)

1. Old binary is offline and never received the v2 row.
2. It writes a v1 row for the same id; the guard cannot fire (nothing newer is locally visible).
3. On sync, LWW resolves by timestamp; the clobber can still happen.

This is unfixable inside one Y.Doc (no supervised moment, byte-blind relay). The guard closes the common case (newer row locally present); the residual case is bounded by additive-discipline (within an epoch, v2 rows that lose to v1 writes lose only added-column values) and is recorded here deliberately.

### `bulkSet` partial refusal

1. Import of 10k rows hits 3 newer-stamped rows.
2. Expected: 9,997 written, 3 refused and reported; no throw, no partial-chunk ambiguity. Chunked loop already exists (`table.ts:521`); refusal filtering happens per chunk at write time (grill amendment: the loop awaits between chunks, so a remote sync can land a newer-stamped row for a later chunk's id after an up-front filter would have passed it).

### Encrypted stores: undecryptable rows are invisible to both the guard and the queue (accepted residual risk)

1. The guard reads stored `_v` through the store's `get()`. On `createEncryptedYkvLww`, decryption is synchronous (verified), so the guard works unchanged for readable rows.
2. But an entry whose key version is missing from the active keyring decrypts to `undefined`: `get()` and `has()` report it absent, `entries()` skips it, `size` subtracts it. The guard therefore treats it as an empty slot and overwrites it; `conformance()` cannot count it either.
3. This is a different axis (key material, not schema) and is no worse than today, but it has the same silent-disappearance shape this spec treats. The wrapper already exposes `unreadableEntryCount`; no table-layer surface consumes it. Closing it would mean widening `ObservableKvStore` with a stored-but-unreadable probe, which is speculative surface until an encrypted app adopts the queue. Recorded deliberately; revisit then.

### `update()` refuses newer-writer rows with a different error type (accepted asymmetry)

1. `update()` routes through `get()`, so a newer-stamped row already fails as `TableParseError.UnknownVersion` (which carries the stored version), while `set()` will fail as `TableWriteError.NewerWriterRefusal`.
2. Keep the asymmetry: `update()`'s failure channel is parse-shaped because it must read before merging. Both are classifiable as "newer writer" by the same `version > versions.length` discriminator the conformance queue uses; the classifier should be one shared function inside `table.ts`.

### Newer-writer rows and destructive ops

1. v1 binary calls `clear()` on a table containing v2 rows it cannot read.
2. Today: everything deleted blind. See Open Question 2.

### Conformance cost on large tables

1. 25k-row table; `conformance()` is a full scan + validate, same cost as `getAllValid()`.
2. Acceptable pull-based; recompute on observe-signal with debounce in the svelte layer. Do not cache in the library (invalidation owner is unclear; the svelte layer already owns reactive recompute).

## Open Questions

1. **`set()` failure channel shape**
   - Options: (a) `Result<void, TableWriteError>`, (b) keep `void` and emit refusals only through a conformance/refusal observer, (c) throw.
   - **Recommendation**: (a). Matches `update()`, call sites compile unchanged, refusal is locally actionable. (b) makes the refusal invisible at the call site that caused it; (c) is hostile in reactive contexts.
   - **Decided (implementation, 2026-06-12)**: (a), as recommended. Call-site survey confirmed compile-clean discard everywhere (see 1.5).

2. **Should `clear()` and `delete()` be guarded?**
   - Options: (a) guard `clear()` (skip newer-writer rows, report), leave `delete(id)` unguarded; (b) guard both; (c) guard neither.
   - **Recommendation**: (a). `clear()` is bulk-blind and the only realistic mass-destruction path from a stale binary; `delete(id)` expresses shape-independent intent about a known row.
   - **Decided (implementation, 2026-06-12)**: (a). `clear()` skips newer-writer rows and returns `{ refused: string[] }` (compile-clean: the only app caller, Whispering's migration dialog, discards the return). `delete(id)` and `bulkDelete` stay unguarded.

3. **Where does workspace-level aggregation live?**
   - Per-table `conformance()` is settled. Is there a `workspace.conformance()` aggregating all tables for a single app banner?
   - **Recommendation**: yes, as a trivial fold over tables, but only in wave 3 when the consumer proves the shape. Defer if the fuji banner ends up per-table.

4. **Whispering adoption timing**
   - Whispering is the shipped tier; the guard protects its users most. Does wave 3's consumer need to be Whispering instead of fuji?
   - **Recommendation**: fuji first (lower stakes, faster iteration), Whispering immediately after as a follow-up wave; the library work is identical.

## Decisions Log

- Keep `count()` as O(1) raw entry count: validating would make a hot path O(n).
  Revisit when: an app needs a cheap valid-count badge and profiling shows `conformance().valid` recompute is too slow on observe-signal.

## Success Criteria

- [ ] Two-doc clobber test passes: a newer-stamped row survives an older binary's `set()`.
- [ ] A schema edited in place produces a visible nonconforming count in fuji, and the queue view can fix and discard rows; counts return to zero.
- [ ] A table containing rows stamped above the binary's known version shows the "update the app" cause, and `update()`/`set()` against those rows refuse.
- [ ] `count()` JSDoc states its contract; no app renders `count()` next to a `getAllValid()` list.
- [ ] `bun run typecheck` and workspace package tests pass after every wave (each wave is a standalone commit).
- [ ] README + 2 ADRs + workspace-api skill updated (wave 4).

## References

- `packages/workspace/src/document/table.ts` - parseRow, getAllValid/getAllInvalid, set/bulkSet/update, count; every behavioral change in this spec lands here.
- `packages/workspace/src/document/define-table.ts` - unchanged; cited to anchor "the tuple stays".
- `packages/workspace/src/document/y-keyvalue/y-keyvalue-lww.ts` - whole-row LWW + monotonic clock; why ts-preserving writes were refused.
- `packages/workspace/src/document/README.md` - design decisions section extended in wave 4.
- `apps/matter/src/lib/core/conformance.ts` - prior art for classification-not-gating; the queue's spiritual parent.
- `docs/articles/archived-head-registry-patterns.md` - the deferred epoch surface, unchanged by this spec.
- `.claude/skills/workspace-api/references/table-migrations.md` - wave 0 target.
