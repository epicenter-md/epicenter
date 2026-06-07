# Collapse `column.*` into `field.*`

**Date**: 2026-06-06
**Status**: Implemented (Phases 1-4 landed; `column` namespace deleted; field 59 / workspace 478 / matter 44 tests green; whispering + fuji typecheck clean). Only deferred: the Phase 2.3 cross-package storage consistency test.
**Owner**: Braden
**Branch**: `matter-typed-markdown-editor`
**Relates to**: `20260605T071500` (field-vocabulary convergence), `20260605T214500` (shared SQLite projection primitives), `20260604T223000` (matter field palette and conformance)
**Prompted by**: an audit that traced the workspace `field` / `column` / `schema` layering and found that `column.*` is `field.*` minus the array kinds plus three workspace-only shapes, two of which can fold into the closed vocabulary.

## One Sentence

Promote the two collapsible workspace-only shapes (`column.json` -> a discriminated `field.json` kind that round-trips via an `x-json-schema` carrier; `column.tags`/`multiSelect` by relaxing the array rejection) so `defineTable` authors directly in `field.*`, delete the `column` namespace, and leave only `nullable` as a standalone emptiness-axis helper (because nullability is substrate-determined value-domain widening, not optionality).

## How to read this spec

```
Read first:
  One Sentence
  The decision in one breath
  Current State (the field/column split + the three shapes)
  The field.* catalog (target)
  Verification (already run, green)

Read if executing:
  Implementation Plan (Build / Prove / Remove)
  Call sites: before and after
  Acceptance gates

Read if changing the design:
  Design Decisions
  The nullable reframe
  Open Questions ("anything else")
```

## The decision in one breath

```
TODAY   field.*  = closed portable vocabulary (9 kinds), round-trips via recognize().
        column.* = field.* MINUS arrays (tags/multiSelect rejected) PLUS three workspace shapes:
                     column.json(schema)   -> Type.Unsafe wrapper, recognize() = null (raw lane)
                     column.nullable(inner) -> Type.Union([inner, Null])
                     column.ianaTimeZone()  -> branded pinned-format string, recognize() = null

TARGET  field.*  = closed vocabulary + json (10 kinds), ALL round-trip.
        defineTable authors in field.* DIRECTLY.
        column.* DELETED.
        nullable() survives as a standalone axis helper (matter forbids it; the workspace needs it).
        ianaTimeZone() survives as a standalone helper OR a promoted field kind (open question).

ASYMMETRIC WIN: one addition (field.json) + one constraint relaxation (arrays) collapses a
                10-builder namespace to "import field + one nullable helper". The 10% we refuse
                is folding nullability into the vocabulary; the reframe shows that is correct.
```

## Motivation

### Current State

`column.*` is a thin extension of `field.*` (`packages/workspace/src/document/column/sugar.ts:120`):

```ts
export const column = {
  string: field.string,    url: field.url,       number: field.number,
  integer: field.integer,  boolean: field.boolean, dateTime: field.datetime,
  enum: field.select,                              // 7 portable aliases
  json,                                            // workspace-only
  nullable,                                        // workspace-only
  ianaTimeZone,                                    // workspace-only
};
```

Three frictions:

1. **`column` is not a superset of `field`.** It drops `tags`/`multiSelect` because `FlatJsonTSchema` rejects `~kind:'Array'` (`constraint.ts:44`). So a tags column must launder through `column.json(Type.Array(Type.String()))`. The materializer is already ready for arrays (`serializeValue` JSON-encodes objects/arrays at `core.ts:399`); only the type-level constraint forbids them.

2. **`column.json` does not round-trip.** It wraps the inner schema in `Type.Unsafe` and spreads its keys, so at rest it looks like a raw object/array. `recognize()` returns `null` (the raw lane). An intentional JSON cell is indistinguishable from an accidental nested structure.

3. **Two names for one builder.** `column.enum`/`field.select` and `column.dateTime`/`field.datetime` are the same builder renamed, so a reader maintains two vocabularies.

### Real usage (the ground truth)

Every `column.json` / `nullable` / `ianaTimeZone` call site, classified:

```
column.json(Type.Array(Type.String()))     fuji x2, wiki x2     <- this IS field.tags()
column.json(Type.Array(Type.Any()))        opensidian, zhongwen, tab-manager   <- arbitrary JSON blob
column.json(Type.Record(...))              reddit (defineKv)    <- arbitrary JSON blob
column.json(TransformationRunResult)       whispering x2        <- typed union of objects (genuine nested)

column.ianaTimeZone()                      fuji x1              <- single consumer
column.nullable(...)                       ~40 sites            <- the workspace's emptiness encoding
```

Finding: roughly half of `column.json` is secretly `tags`, the rest is "store a JSON payload" (some typed, some opaque). `nullable` is load-bearing; `ianaTimeZone` is niche.

### Desired State

```ts
import { field, nullable } from '@epicenter/field';

defineTable({
  id:        field.string<NoteId>(),
  title:     field.string({ minLength: 1 }),
  createdAt: field.datetime(),
  tags:      field.tags(),                 // now a real column (JSON TEXT)
  meta:      field.json(),                 // blob, round-trips as json
  result:    field.json(ResultSchema),     // typed authoring + runtime validation, round-trips as json
  deletedAt: nullable(field.datetime()),   // the one surviving composition
});
```

## Research Findings

### field.json: spread inner keywords + an `x-json-schema` marker (verified, supersedes the "carrier" idea)

The blocker for a `json` kind was a recognizable, mutually-exclusive wire-form that ALSO preserves the read-path validation `column.json` has today. An empirical pass against TypeBox v1 killed the first idea (a "carrier" nesting the inner schema under `x-json-schema`) and produced a better one:

```
A. Type.Unsafe carrying {type:object,...}     -> VALIDATES under Value.Check (NOT a pass-through)
B. column.json(Type.Object) TODAY             -> VALIDATES on read: rejects {author:42}   <- must preserve
C. carrier-ONLY Unsafe {x-json-schema:inner}  -> PASSES ANYTHING  <- would REGRESS the workspace read path
D. Schema.Compile(inner) / spread inner        -> VALIDATES
```

So the nested carrier (C) would silently drop the table read-path validation (whispering's
`TransformationRunResult` would stop being checked on read). The shipped design instead **spreads the
payload's own JSON Schema keywords at the top level** (so `Value.Check` and `Schema.Compile` enforce them)
and adds **`x-json-schema: true` as a recognition marker** (a non-standard keyword both ignore). `field.json`
is therefore `column.json` + one marker:

```
field.json()                       -> { "x-json-schema": true }                          Static = JsonValue
field.json(Type.Object({author:Type.String()}))
                                   -> { type:'object', properties:{author:{type:'string'}},
                                        required:['author'], "x-json-schema": true }       Static = {author:string}
```

```
recognize(stored)  matches the OPEN json meta iff the `x-json-schema` marker is present
Value.Check/compile  validate against the SPREAD keywords; the marker is a no-op keyword they ignore
storageOf('json')  = 'TEXT'
```

The json meta (added to `FIELDS`) is the one OPEN meta (it must allow the payload's own keywords); the
closed scalar metas forbid the marker via `additionalProperties:false`, so json stays mutually exclusive:

```ts
export const JSON_SCHEMA_KEYWORD = 'x-json-schema';
json: { storage: 'TEXT', meta: Type.Object({ [JSON_SCHEMA_KEYWORD]: Type.Unknown() }) },  // OPEN
```

**Verification (run 2026-06-06, TypeBox v1 + @epicenter/field, all green; promoted into `field.test.ts`):**

```
[x] field.json() recognizes as json and accepts any JSON value
[x] field.json(typed) recognizes as json AND validates the payload on read:
       ACCEPTS {author:'x'}, REJECTS {author:42}, REJECTS 'garbage'   (column.json behavior preserved)
[x] bare {} / a bare object (no marker) stays raw -> no semantic flip, no data migration
[x] mutual exclusivity holds both directions; a json wire-form matches exactly one meta
[x] compile (unchanged) compiles the spread schema; the marker is ignored
```

The headline: runtime validation is **preserved**, not lost. `compile` needed NO change (it compiles the
spread schema directly), and bare `{}` keeps its current "raw" meaning.

### The nullable reframe: nullability is not optionality

`field.ts` currently bans both in one breath ("There is NO nullable / optional axis"). They are different axes:

```
optionality   the KEY may be ABSENT          Type.Optional(...)   -> dropped from `required`
nullability   the key is PRESENT, value null  Type.Union([X,Null]) -> value domain widens to X|null
```

What each substrate does about "empty":

| Substrate | "empty" is represented as | can a key be absent? | value domain |
| --- | --- | --- | --- |
| matter (markdown file) | ABSENCE (key not in frontmatter) | yes | X only (no null) |
| workspace (CRDT row) | NULL (key present, value null) | no (fixed shape) | X \| null |

Both substrates enforce the **same presence rule**: no absent keys. The workspace bans `Type.Optional` (`constraint.ts:64`, "optional keys aren't safe in CRDT rows"); matter's everything-required break bans optionality too. They differ only in whether "empty" is a representable value, and that is forced by the substrate: a markdown file can omit a key, a fixed-shape CRDT row cannot, so the row must encode emptiness as `null`.

**Implication**: a nullable column is still *required* (key always present); it only widens the value domain. That is fully consistent with "everything required." There is nothing to challenge in matter's break, and nothing to fold into `field` to make the workspace consistent. `nullable` survives as a standalone composition, not a column builder and not a kind.

## Design Decisions

| Decision | Class | Choice | Rationale |
| --- | --- | --- | --- |
| Add a `json` field kind | 2 coherence | marker-discriminated OPEN meta | One entry in `FIELDS`; round-trips; mutually exclusive (verified). |
| json wire-form | 1 evidence | spread inner keywords + `x-json-schema: true` | Verified: a nested "carrier" passes ANYTHING under Value.Check (regression); spreading keeps payload validation. |
| Preserve runtime validation for typed json | 1 evidence | spread keywords; marker is a no-op keyword | Verified: rejects mis-shaped payloads; `compile` unchanged; no validation loss vs `column.json`. |
| Allow array kinds as columns | 2 coherence | relax `FlatJsonTSchema` for `tags`/`multiSelect` | Runtime already JSON-encodes arrays (`core.ts:399`); matter already stores them as TEXT. |
| Delete `column.*` | 2 coherence | author in `field.*` directly | After json + arrays land, the 7 aliases are redundant. |
| Keep `nullable` | 2 coherence | standalone `nullable()` helper | Substrate-determined value-domain widening; matter forbids it, the workspace needs it. NOT a kind, NOT optionality. |
| `nullable` as a recognized axis | Deferred | Deferred | Possible (recognize reports `nullable:true`), but touches `recognize`/`Recognized`/`FieldOf`/matter widgets. Separate decision. |
| `ianaTimeZone` home | Deferred | Deferred | Standalone helper vs promoted `field.ianaTimeZone` kind. One consumer; decide last. |
| `FlatJsonTSchema` stays | 2 coherence | keep the constraint | Still gates raw `Type.*` and rejects nested structures without a carrier; it is the boundary, not the vocabulary. |

## The field.* catalog (target)

```ts
field.string<TBrand?>(s?)         // TEXT (TBrand for branded ids)
field.url(s?)                     // TEXT, format 'uri'
field.datetime(s?)               // TEXT, format 'date-time', branded DateTimeString
field.number(s?)                  // REAL
field.integer(s?)                 // INTEGER
field.boolean(s?)                 // INTEGER 0/1
field.select([...])               // TEXT, native {enum:[...]}
field.multiSelect([...])          // TEXT (JSON array), array of enum     <- now usable as a column
field.tags(s?)                    // TEXT (JSON array), array of string    <- now usable as a column
field.json<S extends TSchema>(s?) // TEXT (JSON), x-json-schema carrier    <- NEW kind, round-trips

// standalone, NOT a kind:
nullable(inner)                   // Type.Union([inner, Type.Null()]) — the emptiness axis
```

### What was considered and rejected

| Candidate | Why rejected |
| --- | --- |
| `field.json` with `{}` wire-form (no carrier) | Works, but loses runtime validation for typed payloads and flips bare `{}` from raw to json. The carrier is strictly better. |
| `field.json` as a catch-all (any non-scalar = json) | Destroys the `null` rejection lane and "typos die at the boundary"; a typo'd `{type:'strng'}` would recognize as json instead of degrading. |
| `field.nullable` as a kind | Nullability is an axis, not a kind; a nullable string still uses the string widget. Cannot be a `FIELDS` entry. |
| Fold `nullable` into the vocabulary so matter adopts it | matter's substrate uses absence for emptiness; `null` in frontmatter is a weird YAML literal. The asymmetry is substrate-correct. |
| `Type.Optional` columns | Banned for CRDT determinism (absent vs present-null sync differently). Unchanged. |

## Architecture

The json round-trip (the load-bearing new path):

```
AUTHOR     field.json(ResultSchema)
             -> Type.Unsafe<Static<ResultSchema>>({ ...ResultSchema keywords, 'x-json-schema': true })
AT REST    { type:'object', properties:{...}, ..., "x-json-schema": true }   (~kind dropped by JSON)
RECOGNIZE  recognize(stored) -> { kind:'json', schema: stored }              (marker present = json)
VALIDATE   Value.Check / compile(stored) validate the SPREAD keywords; the marker is ignored
STORE      storageOf('json') = 'TEXT'; serializeValue JSON-encodes the cell
```

Mutual exclusivity (why json never collides):

```
{ ...inner, "x-json-schema": true }  -> matches the OPEN json meta (marker present). Closed metas forbid the marker.
{ type:'string' } etc.               -> matches its scalar kind, NOT json (json requires the marker)
{} / bare object (no marker)         -> matches NOTHING -> null (raw lane, unchanged)
```

## Call sites: before and after

### fuji tags (a `column.json`-of-array that was secretly `tags`)

**Before** (`apps/fuji/src/lib/workspace/index.ts:64`):

```ts
type: column.json(Type.Array(Type.String())),
tags: column.json(Type.Array(Type.String())),
```

**After**:

```ts
type: field.tags(),
tags: field.tags(),
```

**Semantic shift**: `recognize()` now returns `tags` instead of `null`; matter (if it ever read this folder) renders a chip editor instead of a raw cell. SQL output unchanged (TEXT, JSON array).

### whispering typed result (the genuine nested case)

**Before** (`apps/whispering/src/lib/workspace/definition.ts:150`):

```ts
result: column.json(TransformationRunResult),   // recognize() = null (raw), validates on read
```

**After**:

```ts
result: field.json(TransformationRunResult),    // recognize() = json, STILL validates on read (marker)
```

**Semantic shift**: round-trips as `json` instead of degrading to raw; runtime read-validation preserved (inner keywords spread into the wire-form). No change to stored cell data.

### fuji nullable + the surviving helper

**Before** (`apps/fuji/src/lib/workspace/index.ts:67`):

```ts
deletedAt: column.nullable(column.dateTime()),
```

**After**:

```ts
deletedAt: nullable(field.datetime()),
```

**Semantic shift**: none. `nullable` relocates from `column` to a standalone export; `Type.Union([X, Null])` is identical.

## Implementation Plan

### Phase 1: Build the json kind (additive, no consumer changes) — DONE

- [x] **1.1** Added `json` to `FIELDS` (`field.ts`) with the OPEN marker meta + `JSON_SCHEMA_KEYWORD`, `storage:'TEXT'`.
- [x] **1.2** Added `field.json()` / `field.json<S>(inner)` to `builders.ts` (spread inner keywords + `x-json-schema: true`). No JsonValue gate in the leaf; `FlatJsonTSchema` gates non-JSON inners at `defineTable`.
- [x] **1.3** `compile` UNCHANGED: it compiles the spread schema directly; the marker is a no-op keyword. (The carrier idea that needed a compile change was rejected.)
- [x] **1.4** Promoted verification into `field.test.ts` (json describe block + catalog/round-trip/canonical updated for the 10th kind).
- [x] **1.5** Re-pointed `column.json = field.json` (`sugar.ts`); updated `column.test.ts` / `column.test-d.ts` (the JsonValue gate moved to `FlatJsonTSchema`).

### Phase 1b: matter JsonField widget — DONE

- [x] `JsonField.svelte` (cloned from `JsonRepairEditor`, FieldProps); `registry.ts` `json` entry + stale-comment reword; `FolderGrid` `COLUMN_WIDTH.json`; `sqlite.ts serializeCell` json -> `JSON.stringify`; `model.ts` header reword. matter typecheck + 44 tests green.

### Phase 2: Allow array kinds as columns — DONE

- [x] **2.1** Dropped `'Array'` from `RejectedCompositeKind` in `constraint.ts`; the final `Static<S> extends JsonValue` clause guards element safety (chose the permissive line: `Date[]` still rejects, bare object still nudged to `field.json`).
- [x] **2.2** `column.test-d.ts`: `_AcceptArrayOfScalar` + `_RejectArrayOfNonJson`. Also reworded the 5 `ColumnError` strings `column.* -> field.*` (folded Phase 4's reword in here).
- [ ] **2.3** TODO: cross-package consistency test `deriveStorage(array)` === `storageOf('tags')` (from the projection-primitives spec). Deferred, not blocking.

### Phase 2b: export nullable/ianaTimeZone standalone — DONE

- [x] `nullable` + `ianaTimeZone` exported standalone from `sugar.ts` -> `column/index.ts` -> `@epicenter/workspace` barrel. `column` still works (aliases) until Phase 4.

### Phase 3: Stop importing column — DONE

- [x] **3.1** `nullable` + `ianaTimeZone` exported standalone from `@epicenter/workspace` (NOT `@epicenter/field`: they are substrate policy, the leaf stays kind-only).
- [x] **3.2** Renamed every `column.X` -> `field.X` / `nullable` / `ianaTimeZone` across ALL consumers (~675 call sites, 30 files): the 8 apps PLUS `packages/skills`, `packages/filesystem`, and `packages/workspace` internals (tests, benchmarks, JSDoc). 10 consumer groups done by parallel sub-agents; workspace internals done in-place. `column.json` kept as a mechanical `field.json` rename (the array-of-string -> `field.tags()` UPGRADE deferred as polish).
- [x] **3.3** Per-group typecheck green; `@epicenter/field` added as a direct dep to each consuming package; root `bun install` reconciled.

### Phase 4: Remove — DONE

- [x] **4.1** Deleted the `column` object from `sugar.ts` (kept `nullable` / `ianaTimeZone`); removed `column` from `column/index.ts` and the `@epicenter/workspace` barrel + JSDoc example. `constraint.ts` (`FlatJsonTSchema`) kept; the `column/` dir retained as "column primitives" (constraint + the two substrate builders). Migrated `column.test.ts` (now tests `nullable`/`ianaTimeZone`/cross-substrate) and `column.test-d.ts` (now `field.*` + `nullable`).
- [x] **4.2** Reworded the `field.ts` doctrine (json IS a kind, `null` is the rejection lane; optionality stays banned, nullability is a substrate axis) and the 5 `ColumnError` strings (`column.* -> field.*`).
- [x] **4.3** matter `JsonField.svelte` done in Phase 1b.

### Deferred (not blocking)

- [ ] Phase 2.3 cross-package consistency test (`deriveStorage(array)` === `storageOf('tags')`).
- [ ] Upgrade the array-of-string `field.json(Type.Array(Type.String()))` sites (fuji, wiki) to `field.tags()` for first-class recognition (currently mechanical `field.json`).
- [ ] Stale JSDoc-prose `column.*` references that were perl-swept are done; if any `column`-named directory rename is wanted, that is a separate cosmetic pass.

## Edge Cases

### A schema already stored as bare `{}`

1. Nothing emits `{}` through the blessed builders today (`Type.Any` is constraint-rejected).
2. With the discriminated carrier, `{}` still recognizes as `null` (raw), unchanged.
3. No migration needed. (This is the win of the carrier over the `{}` wire-form.)

### `nullable(field.json())`

1. `field.json()`'s payload already accepts `null` (it is a `JsonValue`), so wrapping is usually redundant.
2. If wrapped, `deriveStorage` recurses the single non-null `anyOf` branch -> TEXT; `isNullable` -> true. Works.

### matter encountering a `json` field

1. `recognize` now returns `json` for a carrier-bearing schema.
2. `registry.ts` requires a `JsonField` widget (compile error until added).
3. Open question: read-only payload view vs editable JSON editor.

## Open Questions ("anything else")

1. **The `x-json-schema` carrier key name.**
   - Options: (a) `x-json-schema` (OpenAPI-style `x-` extension, ignored by other JSON Schema tooling), (b) `x-epicenter-json`, (c) a `$`-prefixed key.
   - **Recommendation**: (a). `$`-prefix collides with reserved JSON Schema keywords; keep it neutral and tool-safe. Leave open.

2. **The array-relaxation boundary (Phase 2.1).**
   - Options: (a) allow only array-of-recognized-scalar (`tags`/`multiSelect`), still reject array-of-object so authors reach for `field.json`; (b) drop the structural composite rejection entirely and lean on `Static<S> extends JsonValue` (any JSON-safe schema is a valid TEXT column, making the carrier the only "intentional json" signal).
   - **Recommendation**: (a). It keeps the "did you mean a blob, or separate columns?" guard rail. (b) is simpler but loses that nudge. Leave open.

3. **`nullable` as a recognized axis (A-max, deferred).**
   - `recognize` could unwrap `anyOf:[X,null]` and return `{kind:X, nullable:true}`, so nullable round-trips and matter can interpret the flag.
   - **Recommendation**: defer. Ship the standalone helper first; revisit if a substrate needs to read nullability from storage.

4. **`ianaTimeZone` home.**
   - Options: (a) standalone `ianaTimeZone()` helper next to `nullable()`; (b) promote to a real `field.ianaTimeZone` kind (matter gets a timezone widget; field owns the `Format.Set` registration); (c) demote to `field.string({ format:'iana-time-zone' })` + app validation.
   - **Recommendation**: (a) for the deletion, revisit (b) if timezone becomes a commonly-modeled field. One consumer today.

5. **Does `defineKv` get the same treatment?**
   - reddit uses `column.json(...)` inside `defineKv`, not `defineTable`.
   - **Recommendation**: yes; `field.json` is the same builder. Confirm `defineKv`'s value schema accepts it.

6. **What renders a json cell, and is it round-trippable for agents?**
   - The `matter.sqlite` read surface stores json cells as TEXT; an agent reading raw SQL sees JSON text. Confirm the carrier does not leak into the cell VALUE (it lives on the schema, not the row).

7. **Does `column` fully die, or become `export { field }` + helpers?**
   - **Recommendation**: fully delete the namespace; apps import `{ field, nullable }`. Keep `FlatJsonTSchema` under its own module. Leave open if a one-line re-export aids migration.

## Decisions Log

- Keep `FlatJsonTSchema` after `column` dies: it still gates raw `Type.*` columns and rejects nested structures lacking a carrier.
  Revisit when: `field.*` becomes the only authoring path AND raw `Type.*` columns are disallowed, at which point the constraint may shrink to "Static extends JsonValue".
- Keep `nullable` as a standalone helper rather than folding into `field`:
  Revisit when: a substrate needs to recognize nullability from stored schemas (then promote to the A-max recognized axis).

## Success Criteria

- [ ] `field.json()` and `field.json(typed)` recognize as `json`; bare `{}` stays raw (test).
- [ ] Typed `field.json` validates its payload on read (accept/reject test); no validation regression vs `column.json`.
- [ ] `field.tags()` / `field.multiSelect()` are valid `defineTable` columns; array-of-object still rejected.
- [ ] Every `column.*` call site migrated; `column` namespace deleted.
- [ ] `nullable` and `ianaTimeZone` available standalone; ~40 nullable sites unchanged in behavior.
- [ ] matter `JsonField` widget exists; `registry.ts` compiles.
- [ ] Emitted SQL unchanged for migrated tables (empty-diff against fixtures).
- [ ] Typecheck + `bun test` green across workspace and all touched apps.

## References

- `packages/field/src/field.ts` - `FIELDS`, `recognize`, `storageOf`, `compile`; add the `json` entry here.
- `packages/field/src/builders.ts` - `field.*`; add `field.json`.
- `packages/workspace/src/document/column/sugar.ts` - the `column` namespace to delete; source of `json`/`nullable`/`ianaTimeZone`.
- `packages/workspace/src/document/column/constraint.ts` - `FlatJsonTSchema`; relax the array rejection (Phase 2).
- `packages/workspace/src/document/materializer/sqlite/ddl.ts` / `core.ts` - `deriveStorage` (array -> TEXT), `serializeValue` (object -> JSON), already array-ready.
- `apps/matter/src/lib/components/fields/registry.ts` - `satisfies Record<Kind, ...>` forces the `JsonField` widget.
- `packages/workspace/src/shared/iana-time-zone.ts` - `IanaTimeZone`, `IANA_TIME_ZONE_FORMAT` (Phase 3 relocation / open question 4).
- Migration call sites: fuji, honeycrisp, opensidian, zhongwen, wiki, whispering, reddit, tab-manager.
```
