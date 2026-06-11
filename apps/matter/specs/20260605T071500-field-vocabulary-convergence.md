# Field Vocabulary Convergence (`packages/field`)

**Date**: 2026-06-05
**Status**: Shipped (the plan below is superseded in two places, see "Shipped")
**Owner**: Braden
**Branch**: matter-typed-markdown-editor
**Depends on**: matter's `field.ts` (the recognition reference shape, already shipped)

## One Sentence

Extract one closed field-type vocabulary into `packages/field` that the workspace authoring side (`column.*` builders) and the matter recognition side (`recognize`) both derive from, so a builder and a recognizer are inverses over a single wire-form, with emptiness/json policy layered per substrate instead of baked into the vocabulary.

## Shipped (supersedes the Implementation Plan and Open Question 1)

`packages/field` and the re-homing landed as planned. Two things diverged from the plan below, both for the better:

1. **The enum wire-form is native `Type.Enum`, not a `Type.Unsafe<union>({type,enum})` hand-build.** TypeBox v1's `Type.Enum(['a','b'])` emits the native `{enum:['a','b']}` keyword `recognize` reads, infers `Static` as the literal union, and carries `enum` at the type level. So `column.enum = field.select` is a typed narrowing of `Type.Enum` (cast-free), and closed sets are STRING-ONLY (a numeric range is `integer` + `minimum`/`maximum`).

2. **OQ1 resolved to a HARD SWITCH, not the recommended dual-read.** `deriveCheck` had zero callers and there were zero persisted `anyOf`-const schemas, so a dual-read path would have been born dead. `deriveCheck` is deleted; the drizzle mirror reads native `enum` (and no longer special-cases `anyOf`-of-const). The decision rule going forward: closed scalar sets use `Type.Enum`/`field.select`/`column.enum`; `Type.Union` is for composition (nullability, object/result/error/JSON-payload unions).

The narrative below (Current State, Call Sites, Implementation Plan, Open Questions) is kept as the design record; read it as history, not as the current contract.

## How to read this spec

```
Read first:        One Sentence · Current State · The Core Insight · Target Shape · Open Questions
Read for design:   Research Findings · Design Decisions · Architecture · The field.* catalog
Read to execute:   Call Sites · Implementation Plan · Edge Cases · Success Criteria
```

The single load-bearing decision is the **`enum` wire-form** (Open Question 1). Everything else is downstream of it.

## Overview

Today Matter recognizes a stored JSON Schema and classifies it into one of nine kinds; the workspace's `column.*` sugar builds a TypeBox schema for a table column. These are inverse operations over what should be the same artifact, but their wire-forms diverge (`enum` is the sharpest case). This spec converges them onto one vocabulary so authoring and recognition round-trip, and the divergence stops costing two parallel dialects.

## Motivation

### Current State: two dialects, one artifact

**Recognition** (`apps/matter/src/lib/core/field.ts`): read a stored JSON Schema, classify it.

```ts
recognize({ type: 'string', enum: ['draft', 'published'] })  // -> { kind: 'select', schema }
recognize({ type: 'string', format: 'uri' })                 // -> { kind: 'url', schema }
recognize({ type: 'object' })                                // -> null (rejection lane)
```

**Authoring** (`packages/workspace/src/document/column/sugar.ts`): call a builder, get a TypeBox `TSchema`.

```ts
column.string<NoteId>()              // TUnsafe<NoteId>, wire = { type: 'string' }
column.url()                         // TString, wire = { type: 'string', format: 'uri' }
column.enum(['draft', 'published'])  // TUnion, wire = { anyOf: [{const:'draft'}, {const:'published'}] }
column.nullable(column.number())     // Type.Union([number, null])
```

The decisive fact: **`wiki/schema.ts` already stores `column.*` output as `ColumnSpec.schema: TSchema` and re-validates it with `Value.Check` after a Yjs round-trip** (`apps/wiki/src/lib/workspace/schema.ts:57`). That is byte-for-byte the same thing Matter does with a frontmatter field schema, on a different substrate (Yjs table vs markdown file). One app *authors* these schemas; the other *recognizes* them. They are two directions over one artifact.

This creates problems:

1. **Wire-forms diverge for the same concept.** `column.enum` emits `anyOf`-of-`const`; Matter's `select` reads the native `enum` keyword. A `column.enum` schema does **not** `recognize` as `select`. Authoring and recognition cannot round-trip.
2. **Two vocabularies drift.** `string`/`url`/`number`/`integer`/`boolean`/`datetime` exist in both, defined twice, free to diverge. `multiSelect`/`tags` exist only in Matter; `json`/`literal`/`ianaTimeZone`/`nullable` only in `column.*`.
3. **No shared home.** A fix to "what is a url field" has to land in two places. New apps that want Matter-style recognition over `column.*`-authored tables (the wiki is already one) have no single vocabulary to lean on.

### Desired State

One vocabulary in `packages/field`. A `field.*` builder emits a schema in the recognized wire-form; `recognize` classifies it back. They round-trip by construction, proven by one test:

```ts
for (const k of KINDS) expect(recognize(canonical(field[k](...)))?.kind).toBe(k);
```

Substrate policy (emptiness, arbitrary json) layers on top: the workspace keeps `nullable` and `json`; Matter forbids both. The vocabulary itself has neither.

## The Core Insight

```
                       packages/field  (the closed vocabulary, one wire-form)
                       ┌───────────────────────────────────────────────┐
   AUTHOR ──────────►  │  field.select(['a','b'])  ──►  {type:'string', │  ──────────► RECOGNIZE
   field.* builders    │                                 enum:['a','b']}│   recognize() -> kind
   (Static via Unsafe) │  recognize({...enum...})  ◄──  classify         │   (structural read)
                       └───────────────────────────────────────────────┘
                                  inverses over ONE wire-form

   workspace substrate │ matter substrate
   column.nullable(x)  │ everything-required (no nullable)
   column.json(x)      │ json = rejection lane
   brands (NoteId...)  │ structural (brands ignored on read)
```

`field.*` and `recognize` are the two directions; the `FIELDS` metas are the contract both obey. Emptiness and json are NOT part of the vocabulary, they are wrappers/policy each substrate applies at its own edge.

## Research Findings

### The two dialects, mapped

| concept | `column.*` (author) | `field.ts` (recognize) | converge? |
| --- | --- | --- | --- |
| string | `column.string<T>()` | `string` | same wire (`{type:'string'}`); brand via Unsafe |
| url | `column.url()` | `url` | **already same wire** (`format:'uri'`) |
| datetime | `column.dateTime()` | `datetime` | **already same wire** (`format:'date-time'`); brand via Unsafe |
| number | `column.number` | `number` | same |
| integer | `column.integer` | `integer` | same |
| boolean | `column.boolean` | `boolean` | same |
| closed set | `column.enum([...])` → `anyOf`-const | `select` → native `enum` | **WIRE DIVERGES** (OQ1) |
| literal | `column.literal(v)` | (none; = select-of-one) | fold into select or keep |
| array-of-enum | (none; `column.json(...)`) | `multiSelect` | new shared builder |
| array-of-string | (none; `column.json(...)`) | `tags` | new shared builder |
| arbitrary json | `column.json(schema)` | rejected (raw lane) | **workspace-only** policy |
| nullable | `column.nullable(inner)` | deleted (required) | **per-substrate** policy |
| iana zone | `column.ianaTimeZone()` | (none) | workspace-only brand builder |

**Key finding**: six of the nine Matter kinds already share `column.*`'s wire-form (or trivially can). The convergence is not "rewrite everything", it is "align the **one** keyword that diverges (`enum`) and decide where the substrate-only builders live."

**Implication**: the migration risk is concentrated in exactly one place, `column.enum`'s wire-form and the SQLite materializer's `deriveCheck` that reads it. Everything else is a rename + a re-home.

### Branding survives the move (the unblock)

`Type.Unsafe<T>(schema)` lets the emitted JSON Schema (wire-form) and the inferred `Static<T>` be set independently. `column.*` already uses this (`dateTime` → `TUnsafe<DateTimeString>`, `string<NoteId>` → `TUnsafe<NoteId>`). So a shared `field.select(['a','b'])` can emit native `{enum:['a','b']}` for recognition AND carry `Static = 'a' | 'b'` for authoring. This is what makes one vocabulary serve both directions; it is the documented unblock (verified against TypeBox docs in prior work).

## Design Decisions

| Decision | Class | Choice | Rationale |
| --- | --- | --- | --- |
| Where the vocabulary lives | 2 coherence | `packages/field` (leaf) | both `workspace` and `matter` depend on it; no cycle (today neither depends on the other) |
| Builder ↔ recognizer relationship | 2 coherence | inverses over one wire-form, proven by a round-trip test | the thesis; if they don't round-trip the convergence failed |
| `enum` wire-form | 2 coherence | native `{enum:[...]}` (see OQ1) | one wire-form per concept; Matter already reads native `enum` |
| Branding | 1 evidence | keep `Type.Unsafe` in `field.*` | TypeBox decouples wire from `Static<>`; `column.*` already relies on it |
| Optionality | 2 coherence | NOT in the vocabulary; `nullable` is a workspace wrapper | "emptiness is per-substrate" (Matter deleted it, workspace kept it) |
| `json` | 2 coherence | workspace-only builder; Matter rejects | Matter's rejection lane is a substrate policy, not a missing kind |
| `multiSelect` / `tags` | 3 taste | shared builders in `packages/field` | both substrates can store them (Matter renders; workspace = JSON TEXT array) |
| `column.*` after extraction | 2 coherence | thin: re-export `field.*` + workspace-only wrappers (`nullable`, `json`, `ianaTimeZone`) | one blessed builder namespace per the existing `column` doc; just sourced from the shared leaf |
| Dependency on the recognition half | 3 taste | workspace need NOT import `recognize` | authoring doesn't classify; only Matter (and future recognizers) need `recognize`. `packages/field` can export both halves; consumers import the half they use |

## Architecture

```
packages/field/                         the closed vocabulary (leaf, no app deps)
  field.ts        FIELDS metas · Kind · SchemaOf<K> · Recognized · recognize() · compile()
  builders.ts     field.string<T>() · field.select([...]) · field.multiSelect([...]) · ...
  field.test.ts   discrimination invariant + ROUND-TRIP (field.X recognizes back to X)

packages/workspace/document/column/
  sugar.ts        column = { ...field, nullable, json, ianaTimeZone }   ← thin extension
                  (the SQLite-safe authoring menu; substrate wrappers added here)

apps/matter/src/lib/core/
  field.ts        re-exports recognize/compile/Kind from packages/field;
                  matter substrate policy (everything-required, no json) stays here
```

Round-trip contract (the spine):

```
field.select(['draft','published'])
   │  emits
   ▼
{ type: 'string', enum: ['draft','published'] }      ← one wire-form (stored on disk / in Yjs)
   │  recognize()
   ▼
{ kind: 'select', schema }                            ← classified back; Static = 'draft'|'published'
```

## The `field.*` catalog

```ts
// shared vocabulary (packages/field): authoring half
field.string<TBrand?>(refine?)   // {type:'string', ...minLength/maxLength/pattern}   Static = string|TBrand
field.url(refine?)               // {type:'string', format:'uri'}
field.datetime(refine?)          // {type:'string', format:'date-time'}               Static = DateTimeString (brand)
field.integer(refine?)           // {type:'integer', ...minimum/maximum}
field.number(refine?)            // {type:'number', ...minimum/maximum}
field.boolean()                  // {type:'boolean'}
field.select([...] as const)     // {type:'string', enum:[...]}   ← NATIVE enum   Static = union of members
field.multiSelect([...] as const)// {type:'array', items:{type:'string', enum:[...]}}
field.tags(refine?)              // {type:'array', items:{type:'string'}}

// recognition half (packages/field)
recognize(schema): Recognized | null
compile(schema): (v: unknown) => boolean
KINDS, META_BY_KIND, SchemaOf<K>, FieldOf<K>, Field

// workspace-only wrappers (stay in column.ts, re-export field.* + these)
column.nullable(inner)           // Type.Union([inner, Type.Null()])   ← emptiness policy, workspace substrate
column.json<S>(schema)           // arbitrary JSON TEXT cell           ← Matter rejects this shape
column.ianaTimeZone()            // {type:'string', format:'iana-time-zone'}  Static = IanaTimeZone (brand)
```

### Considered and rejected

| candidate | why rejected |
| --- | --- |
| Put `nullable` in `packages/field` | emptiness is per-substrate; Matter deleted it. The vocabulary stays policy-free. |
| Make Matter import `column.*` directly | wrong direction (Matter would pull in workspace + SQLite-safety). Both import the leaf instead. |
| Keep two `enum` wire-forms recognized | weakens "one wire-form per concept"; the discrimination metas get a second shape to walk. Pick one (OQ1). |
| `field.literal(v)` as its own kind | a single-value `select`; fold into `field.select([v])` unless a real call site needs the narrower Static. |
| `field.json` in the shared leaf | json is the workspace substrate's escape hatch and Matter's rejection lane; it is not a recognized kind, so it does not belong in the closed vocabulary. |

## Call Sites: before and after

### wiki types/pages tables

**Before** (`apps/wiki/src/lib/workspace/schema.ts:102`):

```ts
export const typesTable = defineTable({
  id: column.string<TypeId>(),
  name: column.string(),
  icon: column.nullable(column.string()),
  columns: columnsCell,
  createdAt: column.dateTime(),
  updatedAt: column.dateTime(),
});
```

**After** (identical surface; `column.*` is now sourced from `field.*` + workspace wrappers):

```ts
// no call-site change: column.string/dateTime/nullable still exist, now thin over field.*
export const typesTable = defineTable({
  id: column.string<TypeId>(),         // = field.string<TypeId>()
  name: column.string(),               // = field.string()
  icon: column.nullable(column.string()), // nullable stays a workspace wrapper over field.string()
  columns: columnsCell,                // Type.Unsafe escape hatch, unchanged
  createdAt: column.dateTime(),        // = field.datetime() (brand preserved)
  updatedAt: column.dateTime(),
});
```

**Semantic shift to flag**: NONE for these columns, the convergence is source-compatible for `string`/`url`/`number`/`boolean`/`datetime`/`nullable`/`json`. The shift is isolated to **`column.enum` call sites** (next).

### A `column.enum` call site (the only breaking one)

**Before** (any `column.enum(['a','b'])`): wire = `{ anyOf: [{const:'a'}, {const:'b'}] }`.

**After** (`field.select(['a','b'])` via `column.enum` → native enum): wire = `{ type:'string', enum:['a','b'] }`.

**Semantic shift to flag**: stored schemas change shape, and the SQLite materializer's `deriveCheck` (which emits `col IN ('a','b')` from the `anyOf`-const shape) must read the native `enum` shape instead. Any persisted `ColumnSpec.schema` carrying the old `anyOf`-const must be migrated or dual-read. **This is the migration, grep `deriveCheck` and every stored type registry.** (Investigate `packages/workspace/src/document/column/constraint.ts` and the SQLite materializer.)

## Implementation Plan

### Phase 1: Build the leaf (no consumer changes)

- [ ] **1.1** Create `packages/field` with `field.ts` = a move of matter's `core/field.ts` (FIELDS, recognize, compile, SchemaOf, FieldOf, Field, Kind, KINDS, META_BY_KIND). Verify it builds standalone.
- [ ] **1.2** Add `builders.ts`: `field.*` authoring builders that emit the recognized wire-forms, `Static<>` via `Type.Unsafe` where branding/precision is needed (`select`, `datetime`).
- [ ] **1.3** Add the **round-trip test**: every `field.X(...)` output `recognize`s back to kind `X`, and `Static<>` matches the intended TS type (`expectTypeOf`). This test IS the convergence proof.

### Phase 2: Re-home `column.*` onto the leaf (source-compatible)

- [ ] **2.1** `column` = `{ ...field, nullable, json, ianaTimeZone }`. Keep the existing `FlatJsonTSchema` safety gate. Remove the duplicated `string`/`url`/`number`/etc. definitions (now from `field.*`).
- [ ] **2.2** Decide `column.enum`: alias to `field.select` (native enum) OR keep both during migration (OQ1). If switching, update `deriveCheck` to read native `enum`.
- [ ] **2.3** Typecheck the ~10 consumers (`fuji`, `wiki`, `whispering`, `reddit`, `honeycrisp`, `opensidian`, `zhongwen`, `tab-manager`). Source-compatible except `enum` call sites.

### Phase 3: Re-home matter onto the leaf

- [ ] **3.1** `apps/matter/src/lib/core/field.ts` re-exports `recognize`/`compile`/`Kind`/`SchemaOf`/`FieldOf`/`Field` from `packages/field`. Matter substrate policy (everything-required, no json, the per-kind widgets) stays in matter.
- [ ] **3.2** Typecheck + test matter. The grid, conformance, sqlite projector unchanged (they consume the same exports).

### Phase 4: Prove, then migrate enum

- [ ] **4.1** With both wire-forms readable (if 2.2 chose dual-read), migrate persisted `anyOf`-const schemas in stored type registries to native `enum`. Then drop the dual-read.
- [ ] **4.2** Verify: every consumer green; round-trip test green; a real wiki type with an enum column renders in matter's grid (the cross-substrate smoke test).

### Phase 5: Remove

- [ ] **5.1** Delete any transitional dual-read in `deriveCheck`. Delete dead `column.*` definitions superseded by `field.*`.

## Edge Cases

### A workspace table column matter would reject

1. `column.json(Type.Record(...))` or `column.nullable(...)` stored as a `ColumnSpec`.
2. Matter `recognize`s it.
3. `recognize` returns `null` (nullable wrapper / object shape is outside the palette) → the field degrades to raw. This is correct and already the contract; the convergence does not change it. Substrate policy differs on purpose.

### A branded field round-tripping through recognition

1. `field.datetime()` emits `{type:'string', format:'date-time'}`, `Static = DateTimeString`.
2. Stored, then `recognize`d in matter: matter reads it structurally as `kind: 'datetime'`, `Static = SchemaOf<'datetime'>` (plain string, no brand).
3. Expected: the brand is an authoring-side affordance; recognition is structural. The brand is lost on the recognition read, which is fine, Matter never had it. Document that brands are author-side only.

### `enum` of non-strings

1. `field.select([1, 2, 3])` (numeric enum).
2. Wire = `{type:'integer'|'number'?, enum:[1,2,3]}`; matter's `select` meta is base-agnostic (`enum` of primitives, optional `type` pin). Recognizes as `select`. ✓ (already tested in matter).

## Open Questions

1. **`enum` wire-form migration strategy** (the load-bearing one).
   - Options: (a) hard switch `column.enum` → native `enum`, migrate `deriveCheck` + stored schemas in one wave; (b) dual-read `deriveCheck` (accept both `anyOf`-const and native `enum`), switch the builder, migrate stored data lazily, then drop the dual-read; (c) leave `column.enum` as `anyOf`-const and teach matter's `select` meta to ALSO recognize `anyOf`-const (two wire-forms).
   - **Recommendation**: (b). It de-risks the breaking change behind a transitional dual-read and keeps every app green throughout, while still converging on native `enum` as the one wire-form. Reject (c): it permanently doubles the recognition surface, which is the opposite of the thesis. Leave open: the count and location of persisted `anyOf`-const schemas decides whether (a) is cheap enough to skip the dual-read.

2. **Does `column.enum`'s `Static` need to stay a literal union under native enum?**
   - Native `{enum:[...]}` with `Type.Unsafe<'a'|'b'>` preserves the union Static. Verify TypeBox emits/validates a native `enum` the SQLite layer and `Value.Check` both accept (it should; matter already validates native-enum schemas).
   - **Recommendation**: verify in Phase 1.3's round-trip test before committing 2.2.

3. **Should `multiSelect`/`tags` get `column.*` aliases, or stay matter-render-only?**
   - The workspace has no list-of-enum / list-of-string builder today (apps use `column.json(Type.Array(...))`). Adding `column.multiSelect`/`column.tags` gives workspace tables a recognized list shape.
   - **Recommendation**: add them to the shared leaf (so matter recognizes them) but defer exposing `column.multiSelect` until a workspace app needs it; `field.multiSelect` exists regardless. Defer the `column.*` alias.

4. **Repo location of the spec / package name.** `packages/field` vs folding into `packages/workspace`.
   - **Recommendation**: standalone `packages/field` (leaf, importable by matter without pulling workspace + SQLite-safety). Confirm against the monorepo's package conventions.

## Adjacent Work

- Matter's `core/` rename (`model/` → `core/`, `palette.ts` → `field.ts`) and the `ChipListField` → `MultiSelectField`/`TagsField` fork are in flight in matter; let them land before Phase 3 so the move targets a settled file.
- `column.literal` folding into `field.select([v])`: not required; only if a real call site wants the narrower Static. Opportunistic.

## Decisions Log

- Keep `column.nullable` and `column.json` in the workspace layer (not the shared leaf): emptiness and arbitrary-json are substrate policy, and ~10 apps author with them.
  Revisit when: a second recognition substrate wants nullable/json semantics, at which point "policy per substrate" needs a shared representation.
- Keep `column.ianaTimeZone` workspace-only: it is a brand builder with no matter kind.
  Revisit when: Matter grows a timezone field kind.

## Success Criteria

- [ ] `packages/field` builds standalone; matter and workspace both depend on it, no cycle.
- [ ] Round-trip test green: `recognize(field.X(...))` is kind `X` for every kind, with matching `Static<>`.
- [ ] `column.*` is source-compatible for all non-`enum` call sites across the ~10 consumers (typecheck green).
- [ ] A wiki type authored with `column.*` (including an enum column) `recognize`s and renders in matter's grid (cross-substrate smoke test).
- [ ] One wire-form per concept; `deriveCheck` reads exactly one `enum` shape after migration.
- [ ] No duplicated `string`/`url`/`number`/`datetime` definitions across `field`/`column`.

## References

- `apps/matter/src/lib/core/field.ts`: the recognition reference shape (FIELDS, recognize, SchemaOf, compile) to move into `packages/field`.
- `packages/workspace/src/document/column/sugar.ts`: the `column.*` authoring dialect to re-home onto the leaf.
- `packages/workspace/src/document/column/constraint.ts`: `FlatJsonTSchema` + (find) the `deriveCheck` that reads `enum` wire-form; the migration's blast center.
- `apps/wiki/src/lib/workspace/schema.ts`: proof that `column.*` output is already stored-and-`Value.Check`'d as a per-column schema (the same artifact matter recognizes).
- Prior spec `20260604T223000` (matter typed grid): established the closed palette, everything-required, and "native enum + Type.Unsafe decouples wire from Static" that unblocks this.
