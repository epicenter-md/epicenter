# Shared SQLite projection primitives (not a shared projection engine)

**Date**: 2026-06-05
**Status**: DEFERRED (2026-06-06), gated on the wiki ECS rebuild. See "Deferral" below.
**Owner**: Braden
**Branch**: `matter-typed-markdown-editor`
**Relates to**: `20260605T145734-matter-live-projection-lifecycle.md` (matter's seed/sync/reconcile lifecycle), the field-vocabulary convergence (`20260605T071500`), `20260602T120000-wiki-core-collections-traits-and-curation.md` (the wiki ECS rebuild that owns the wiki side of this)
**Prompted by**: the collapse pass that deleted the unused typed Drizzle mirror layer and inlined `deriveStorage` into `ddl.ts`, which exposed that three apps hand-roll the same projection primitives.

## Deferral (2026-06-06)

This extraction was re-examined after the `column.* -> field.*` collapse and is now **DEFERRED** until the wiki ECS rebuild (`20260602T120000`), because its premise no longer holds:

```
The spec's motivation was "wiki hand-copied deriveStorage; extract so it stops drifting."
But apps/wiki is the original VERTICAL SLICE, and today it is:
  - BROKEN      markdown.ts imports the deleted attachMarkdownMaterializer (4 TS errors, 1 file)
  - TEST-ONLY   projection.ts is consumed only by wiki.test.ts; zero live app code calls projectWiki
  - SUPERSEDED  the ECS redesign (pages + table-per-tag) will REWRITE projection.ts

Pull the wiki consumer out and count who is left for deriveStorage / serializeValue:
  workspace ddl.ts/core.ts   the definition + only LIVE consumer
  matter sqlite.ts           does NOT use them (closed palette: storageOf + serializeCell)
  wiki projection.ts         test-only, broken, about to be rewritten

With no live second consumer, extracting deriveStorage/serializeValue to a "shared" module is
RELOCATION, not collapse. A shared leaf earns itself when two real consumers pull on it; the
second (the rebuilt ECS wiki) does not exist yet in its final shape. Designing the module's
surface around the soon-deleted vertical-slice projection.ts would bake in its assumptions.
```

**Revised direction:** let the wiki ECS rebuild be the forcing function. When wiki is rebuilt
(pages + table-per-tag), that code is the real second consumer and should drive the extraction,
shaping the shared module to fit workspace + ECS-wiki. The `quoteIdentifier` triplication (3
identical one-liners) is the only substrate-agnostic leaf, ~6 lines, not worth a cross-package
export on its own; fold it into whatever the rebuild needs. Do NOT pre-extract, do NOT polish or
write a removal spec for the paused vertical slice (git preserves it; `20260602T120000` is its plan).

## One Sentence

Three SQLite projections (matter folder tables, the workspace materializer, the wiki ECS index) genuinely differ in table model and lifecycle and must NOT be merged into one engine, but they each re-implement the same three leaf primitives (`deriveStorage`, `serializeValue`, quote-identifier), and wiki copied them by hand because the workspace never exported them; the move is to extract those leaves into one shared module, not to unify the engines.

## How to read this spec

```
Read first:
  One Sentence
  The decision in one breath
  Current State (three projections, side by side)
  What is genuinely different vs what is duplicated
  Recommendation

Read if executing:
  The shared module shape
  Acceptance gate (empty diff)
  Risk and blast radius
  Do-not-resurrect note
```

## The decision in one breath

```
REFUSE:  one projection engine that all three call.
         The table models are different shapes, not parameters of one shape:
           matter   one table per folder, closed palette, every column NOT NULL, `_extra`
           workspace one table per defineTable, open palette, nullable, INCREMENTAL + FTS
           wiki     ECS: pages + membership edges + one side table per type, physical `c_<colId>`
         Forcing these into one engine means a config flag per axis (closed/open,
         rebuild/incremental, IPC/in-process, folder/defineTable/ECS). That is a
         mode-discriminator soup, not a simplification.

EXTRACT: the three leaf primitives all three already re-implement:
           deriveStorage(schema)   lenient JSON-Schema -> 'TEXT'|'INTEGER'|'REAL'
           serializeValue(value)   JS value -> SQLite binding (bool->0/1, object->JSON)
           quoteIdentifier(name)   double-quote a SQL identifier
         wiki literally copied deriveStorage with a comment saying it could not import it.

ASYMMETRIC WIN: refuse the 10% (one engine) to collapse the 90% (three copies of the leaves).
```

## Current State: three projections, side by side

```
                matter/core/sqlite.ts        workspace materializer        wiki/workspace/projection.ts
                (apps/matter)                (packages/workspace)          (apps/wiki)
--------------  ---------------------------  ----------------------------  ----------------------------
table model     1 table / folder             1 table / defineTable          ECS: wiki_pages + edges +
                + `_extra` JSON col                                          wiki_type_<id> side tables
palette         CLOSED (storageOf by kind)   OPEN (deriveStorage)           OPEN (deriveStorage, COPIED)
nullability     every column NOT NULL        nullable (isNullable)          nullable
lifecycle       DROP + CREATE (reconcile)    INCREMENTAL upsert/delete       DROP + CREATE (reconcile)
                                             + FTS + `rebuild` reconcile
runtime         Tauri: JS builds SQL,        in-process bun:sqlite          in-process bun:sqlite
                Rust executes over IPC        (daemon)                       (script)
storage helper  storageOf(kind)  (field)     deriveStorage (ddl.ts, private) deriveStorage (HAND COPY)
serialize       serializeCell (closed kinds) serializeValue (core.ts)        serializeValue (HAND COPY)
quote           quoteIdent                   quoteIdentifier                 q
```

The "COPIED" / "HAND COPY" cells are the whole motivation. From `apps/wiki/src/lib/workspace/projection.ts`:

```ts
/**
 * SQLite storage class for a column schema. Mirrors the workspace materializer's
 * `deriveStorage` (which is not exported from the package) ...
 */
function deriveStorage(schema: TSchema): 'TEXT' | 'INTEGER' | 'REAL' { ... }
```

That comment is a standing request for an export that never came, so the author duplicated ~30 lines instead. The risk is silent drift: a fix to one `deriveStorage` does not reach the copies.

## What is genuinely different vs what is duplicated

```
GENUINELY DIFFERENT (keep separate; do not parameterize)
  table model     folder-table | defineTable-table | ECS side-tables   -> three shapes, not one
  lifecycle       Tauri reconcile | incremental+FTS | in-process reconcile
  palette policy  closed (matter) vs open (workspace, wiki)
  runtime seam    JS-builds/Rust-executes (matter) vs in-process (others)

DUPLICATED (extract; one home)
  deriveStorage   identical lenient JSON-Schema -> storage class (workspace == wiki copy)
  serializeValue  near-identical JS value -> SQLite binding (workspace ~ wiki copy)
  quoteIdentifier identical 1-liner in all three (quoteIdent | quoteIdentifier | q)
```

matter is the odd one for storage: it derives storage from the *closed* `storageOf(kind)`
(`@epicenter/field`), not from `deriveStorage`. That is correct and stays. matter would only
share the `quoteIdentifier` leaf, if anything; its closed serializer (`serializeCell`) is a
different function. So the shared module's real consumers are the **workspace materializer and
wiki**, with matter an optional taker of `quoteIdentifier` only.

## Recommendation

```
1. Extract a tiny module of OPEN-substrate projection leaves and export it from @epicenter/workspace:
     deriveStorage(schema)    lenient JSON-Schema -> storage class
     serializeValue(value)    JS value -> SQLite binding
     quoteIdentifier(name)    double-quote identifier
2. The workspace materializer (ddl.ts / core.ts) imports them from that module.
3. wiki imports them from @epicenter/workspace and DELETES its hand copies.
4. matter stays on the CLOSED storageOf + serializeCell; optionally imports quoteIdentifier.
5. Do NOT touch the table models or lifecycles. No shared engine.
```

Two open sub-questions for whoever executes:

- **Home and name.** A new subpath export (e.g. `@epicenter/workspace/projection` -> a
  `document/sqlite-projection-primitives.ts`) keeps it out of the main barrel and names it
  honestly. It is published surface, so name it once and mean it.
- **Does wiki want more than the leaves?** wiki's ECS rebuild is structurally close to a
  generic "DROP + CREATE + INSERT-all from an open schema." If, after extracting the leaves,
  wiki's `projectTypeTable` is mostly leaves + a table-name convention, a second tiny helper
  (`buildCreateTable(name, columns)`) might also factor. Decide after the leaves land, not before.

## The shared module shape (proposed)

```ts
// packages/workspace/src/document/sqlite-projection-primitives.ts
//
// Leaf primitives for OPEN-substrate SQLite projection: schema -> storage class,
// value -> binding, identifier quoting. Shared by the workspace materializer and
// by app-side projections (wiki). matter uses the CLOSED storageOf instead.

export type SqliteStorage = 'TEXT' | 'INTEGER' | 'REAL';
export function deriveStorage(schema: TSchema): SqliteStorage { ... }   // from ddl.ts
export function isNullable(schema: TSchema): boolean { ... }            // from ddl.ts
export function serializeValue(value: unknown): SQLQueryBindings { ... } // from core.ts
export function quoteIdentifier(name: string): string { ... }           // from ddl.ts
```

```
Subpath export in packages/workspace/package.json:
  "./projection": "./src/document/sqlite-projection-primitives.ts"
```

## Acceptance gate (the empty-diff rule)

This refactor must change ZERO emitted SQL. The gate is a before/after snapshot per consumer:

```
[ ] workspace: generateDdl() over the existing fixtures -> byte-identical DDL strings.
[ ] workspace: a materialize + dump of a seeded table -> identical rows (serializeValue unchanged).
[ ] wiki:      projectWiki() over wiki.test.ts fixtures -> identical typeTableDdl + identical
               row contents (wiki's deriveStorage/serializeValue copies were already "mirrors",
               so identical output is the proof they were equivalent).
[ ] matter:    untouched (does not use the open leaves). bun test apps/matter green.
```

If any diff is non-empty, the copies had already drifted; treat that as a found bug and reconcile
to the canonical leaf, noting the drift in the PR.

## Risk and blast radius

```
@epicenter/workspace   new published subpath. Additive: existing imports unchanged.
workspace materializer  ddl.ts/core.ts import the leaves instead of defining them. In-package.
wiki                    deletes ~50 lines of copied helpers; imports from @epicenter/workspace.
                        OUT OF SCOPE for the current collapse pass; this spec only proposes it.
matter                  no change (or a one-line quoteIdentifier import). Lowest risk.
```

This is a Class 2 (coherence) change, not a Class 1 (correctness) one: the output is provably
unchanged (empty-diff gate), and the win is single-source + drift-proofing, not behavior.

## Do-not-resurrect note

The collapse pass that prompted this spec just **inlined `deriveStorage`/`isNullable` into
`ddl.ts`** (deleting `column/derive.ts`) because, after the Drizzle layer was removed, `ddl.ts`
was the only consumer. That was correct for the one-consumer state. If this spec is adopted:

```
- RE-EXTRACT the leaves into document/sqlite-projection-primitives.ts (a PROJECTION home).
- Do NOT resurrect column/derive.ts: storage derivation is a materializer/projection concern,
  not part of the column.* authoring layer. The old location was the mistake the inline fixed.
```

## Decision Log

- Refuse a unified projection engine: the three table models (folder / defineTable / ECS) are
  different shapes, and the lifecycles (Tauri-IPC reconcile / incremental+FTS / in-process
  reconcile) are different runtimes. Unifying needs a flag per axis. Revisit only if two of the
  three models converge for a real product reason.
- Extract the three leaf primitives: identical or near-identical in all three; wiki copied them
  by hand with a comment requesting the export. Single-source kills drift.
- matter stays on the closed `storageOf`: it derives storage from the closed palette kind, a
  different (and correct) policy than the open `deriveStorage`.

## References

- `packages/workspace/src/document/materializer/sqlite/ddl.ts` - `deriveStorage`, `isNullable`,
  `quoteIdentifier` (canonical leaves, currently private after the inline).
- `packages/workspace/src/document/materializer/sqlite/core.ts` - `serializeValue` (the open serializer).
- `apps/wiki/src/lib/workspace/projection.ts` - the hand copies to delete; ECS table model stays.
- `apps/matter/src/lib/core/sqlite.ts` - closed-palette projection; uses `storageOf`, not the leaves.
- `apps/matter/src/lib/core/field.ts` was deleted; matter now imports the closed vocabulary from
  `@epicenter/field` directly.
- `specs/20260605T145734-matter-live-projection-lifecycle.md` - matter's projection lifecycle.
