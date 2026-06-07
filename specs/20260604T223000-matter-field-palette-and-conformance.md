# Matter: the closed field palette, meta-schema validation, and everything-required conformance

**Date**: 2026-06-04
**Status**: Draft (greenfield; co-designed across a long grilling thread)
**Owner**: Braden
**Branch**: `matter-typed-markdown-editor`
**Revises**: `20260604T120000-typed-markdown-grid-editor.md` (supersedes its `KINDS registry`, `Requiredness and emptiness`, and `Conformance` sections; the live-vault watcher, canonical write-back, and routes are unchanged)
**Confines**: `20260602T200000-vault-read-only-projection-agent-mutation.md`

## One Sentence

Model a folder's frontmatter as a flat map of names to one of nine closed JSON-Schema shapes, validate each field schema against a TypeBox meta-schema so kind recognition is total, require every modeled field by refusing optionality outright, and project the valid rows into a `matter.sqlite` next to `matter.json` so a coding agent can query the typed folder with raw SQL.

## How to read this spec

```
Read first:
  One Sentence
  The model in one breath
  The nine shapes (the catalog)
  The meta-schema: why deriveKind is total
  Everything-required (the axis we deleted)
  Implementation Plan

Read if changing the architecture:
  Design Decisions
  The field.* builders and the column.* relationship
  matter.sqlite: the agent read surface
  Edge Cases

Deferred (designed, not built in v1):
  the field.* authoring builders + model-editing UI
  column.* convergence (packages/field extraction)
  board / calendar views, the TS DSL, relations
```

## The model in one breath

```
matter.json   model    Record<fieldName, FieldSchema>   each value is one of 9 closed JSON-Schema shapes
markdown      data     the truth; sparse; never mangled; the model NEVER gates a write
matter.sqlite index    derived, disposable, read-only; the VALID rows as a typed table for raw SQL (agents)

a field IS a JSON Schema.  kind, storage, widget are DERIVED from its shape, never stored.
every modeled field is REQUIRED.  there is no optional, no nullable, no `Type.Optional`, no null branch.
conformance per cell:   absent -> NEEDS_VALUE  |  present + valid -> OK  |  present + invalid -> INVALID
"ready to publish" == every modeled field present and valid == the row projects into matter.sqlite
```

## Overview

Matter already ships read, model, conformance, and edit (increments 1 to 3 of the prior spec). This spec is a greenfield rework of the field-type core that sits under all of it. Three moves:

1. **Replace the predicate recognizers with a meta-schema.** The nine kinds become nine closed TypeBox object schemas. Their union is `FieldSchema`, the schema-of-schemas. `validateModel` checks each field against it at the boundary, so `deriveKind` becomes a total function with no `supported: false` and no `json` floor.
2. **Delete optionality.** Every modeled field is required. Presence becomes a validation question, not a model axis. The four conformance states collapse to three. `nullable`, `isNullable`, `Type.Optional`, the `EMPTY` state, and the `required`-vs-`optional` UI all disappear.
3. **Keep SQLite, repurpose it.** A read-only `matter.sqlite` sits next to `matter.json`, holding only valid rows as a typed table, rebuilt from files, so coding agents (and an optional in-app SQL console) can run arbitrary SQL. The live grid stays reactive JS over the in-memory projection; SQLite is the external read surface, not the app's query engine.

## Motivation

### Current State

Two recognizers walk the same JSON Schema with different outputs, and `deriveKind` carries a failure case.

```ts
// apps/matter/src/lib/model/schema.ts  (today: predicate recognizers + a partial result)
const KINDS = [
  { kind: 'select', match: (s) => s.enum !== undefined },
  { kind: 'string', match: (s) => s.type === 'string' },
  // ...nine entries, ordered (uri before string, multiSelect before tags)...
  { kind: 'json',   match: (_s) => true },          // the catch-all floor
] as const;

export function deriveKind(schema) {
  const { inner, nullable } = unwrapNullable(schema);  // peels the anyOf-null wrapper
  return { kind: matchKind(inner), nullable };         // {kind, nullable}: two axes bundled
}
```

```ts
// apps/matter/src/lib/model/model.ts  (today: json is a kind, and it nukes the whole model)
const derived = deriveKind(fieldSchema);
if (derived.kind === 'json') return MatterModelError.UnsupportedShape({ field: name });
fields.push({ name, schema: fieldSchema, derived });   // ModelField { name, schema, derived:{kind,nullable} }
```

```ts
// apps/matter/src/lib/model/conformance.ts  (today: four states, nullable re-extracted)
export type CellState = 'OK' | 'EMPTY' | 'NEEDS_VALUE' | 'INVALID';
// compileColumns copies field.derived.nullable into CompiledColumn.nullable (a second home for the same fact)
// classify: v == null ? (nullable ? EMPTY : NEEDS_VALUE) : check(v) ? OK : INVALID
```

This creates problems:

1. **`deriveKind` does two jobs.** It both decides "is this a legal palette shape" (returning `json`/unsupported) and "which kind is it." The `json` member of `Kind` is unreachable at render time (`model.ts` rejects it) yet sits in `FIELD_COMPONENTS` as a dead entry "for exhaustiveness."
2. **Unsupported is all-or-nothing.** One field whose shape falls outside the palette errors the whole model and drops the entire folder to the raw view.
3. **The optionality axis is heavy for a rare need.** `nullable` is derived once, then copied into `CompiledColumn`; it splits `EMPTY` from `NEEDS_VALUE`, gates the clear-option in `SelectField`/`BooleanField`, and forces an `anyOf`-null shape and `unwrapNullable` peeling. All of it exists to express "this field may be blank," which in sparse markdown is mostly "I have not filled it in yet."
4. **The recognizers are implicit.** "What schemas are legal" is the emergent behavior of nine `match` lambdas plus an order contract, not a declared, inspectable value.

### Desired State

```ts
// the palette is ONE table; the union of its metas IS the validator; deriveKind is total
const FieldSchema = Type.Union(PALETTE.map((p) => p.meta));   // the schema-of-schemas

function deriveKind(s /* already validated against FieldSchema */): Kind {
  return PALETTE.find((p) => Value.Check(p.meta, s))!.kind;    // total: the boundary guaranteed a match
}

// classify: three states, no optionality
// v == null ? NEEDS_VALUE : check(v) ? OK : INVALID
```

## Research Findings

### TypeBox: native `enum` validates, and `Type.Unsafe` decouples wire form from static type (Class 1, verified)

Asked DeepWiki against `sinclairzx81/typebox`:

| Question | Answer |
| --- | --- |
| Does `Value.Check` / `Schema.Compile().Check` honor the native JSON Schema `enum` keyword? | Yes. `{type:'string', enum:['a','b']}` rejects `'c'`, accepts `'a'`. |
| Does `Type.Unsafe<'a'\|'b'>({type:'string', enum:['a','b']})` carry `Static<> = 'a'\|'b'` and serialize to clean native-`enum` JSON (no `anyOf`, no symbol-only keys)? | Yes. `Type.Unsafe` is the supported way to express a native JSON Schema form while informing the static type via the generic. |

**Key finding**: the at-rest wire form and the compile-time static type are independent. A field can serialize to readable native `{type:'string', enum:[...]}` (agent-editable, standard JSON Schema) AND, when authored through a builder, narrow `Static<>` to the literal union.

**Implication**: the enum "dialect fork" that justified keeping Matter and `column.*` apart was a false constraint. Matter stores native `enum`; a future `field.select([...])` builder can emit the same native `enum` via `Type.Unsafe` and still give the workspace its narrowed row types. The palette is convergeable; the convergence is deferred, not blocked.

### Closed palettes are the norm; nobody co-locates all three projections (Class 2)

| System | Palette | Validate | Store | Render |
| --- | --- | --- | --- | --- |
| Notion / Airtable | closed property-type menu | built-in | hosted | hosted widget |
| Drizzle | `text()/integer()/...` | no | SQL type + TS type | none (UI is app-side) |
| TanStack Table | `columnDef.cell` | no | none | the widget |
| Zod / TypeBox | `z.string()` | the validator + TS type | no | no |

**Key finding**: the best-in-class tools all draw the same line: storage/validation live in a Svelte-free builder; rendering lives app-side. No single literal holds all three.

**Implication**: the palette's single source can hold `kind + meta + storage` (Svelte-free); the widget attaches by kind name in the app, guarded by `satisfies Record<Kind, Component>`. This is the existing model/UI seam in `registry.ts`, kept.

## The nine shapes (the catalog)

The palette is the **closed recognized subset of JSON Schema**. JSON Schema is the open substrate (any schema is writable; agents edit it; it round-trips with no eval). The palette is a closed lens: nine shapes given a name, a widget, and a storage class. A shape outside the lens does not corrupt the format; that one field degrades to raw.

The spine is `base type + optional format + optional enum + optional array wrapper`. No nullability (deleted). The axis rule: an attribute earns a recognizer only where it is meaningful; `format` and `enum` cross-cut and are recognized; multiplicity is curated into two named list kinds, never a recursive `array`.

```
kind          at-rest JSON Schema                                     widget         SQLite
------------  ------------------------------------------------------  -------------  --------
string        { "type":"string" }                                     TextCell       TEXT
url           { "type":"string", "format":"uri" }                     UrlField       TEXT
datetime      { "type":"string", "format":"date-time" }               DateTimeField  TEXT
select        { "enum":[...], "type"?:"string"|"number"|"integer" }   SelectField    TEXT
integer       { "type":"integer" }                                    NumericField   INTEGER
number        { "type":"number" }                                     NumericField   REAL
boolean       { "type":"boolean" }                                    BooleanField   INTEGER (0/1)
tags          { "type":"array", "items":{ "type":"string" } }         ChipListField  TEXT (JSON)
multiSelect   { "type":"array", "items":{ "enum":[...] } }            ChipListField  TEXT (JSON)
```

The free/closed x single/list structure that proves these are coherent, not arbitrary:

```
            single        list           string -> tags is the same move as select -> multiSelect
free        string        tags
closed      select        multiSelect
```

Each shape carries optional, whitelisted refinement keywords (the "free validation" win): `string` allows `minLength/maxLength/pattern`; `integer`/`number` allow `minimum/maximum`; `tags`/`multiSelect` allow `minItems/maxItems/uniqueItems`. Every shape allows shared annotations (`title`, `description`). The kind decides what it looks like and how it stores; the rest of the schema decides what is valid. A "rating" is `{type:'integer', minimum:1, maximum:5}`: still kind `integer`, still `NumericField`, but `Schema.Compile` rejects 0 and 6, for zero new kinds.

### What was considered and rejected

| Candidate | Why rejected |
| --- | --- |
| `json` kind / floor | Not a field type; it is the rejection lane. An unsupported shape degrades that one field to raw (Edge Case below), so `Kind` is exactly the renderable set. |
| `nullable` / `optional` | Deleted wholesale (see Everything-required). Presence is validation, not a kind axis. |
| a general recursive `array` kind | Refused in commit `26382ff3c`; reintroduces recursion (a list-of-X needs X's widget/validator/storage). Two flat named list kinds instead. |
| `relation` / `ref` | A pointer, not a value; Matter folders are not a graph yet. Deferred; the future shape is a branded id string + annotation, not a new base type. |
| `date` (calendar, no time) | Deferred with the calendar view; a bare `date:` infers/validates as `string` until then (a bare date is not RFC 3339). |
| merging `integer` into `number` | They already share `NumericField`; the split is free and the storage class (INTEGER vs REAL) is honest. Keep both. |
| `x:widget` override annotation | Refused permanently: if one shape needs two widgets, add a `format` or a kind. Keeps `deriveKind` a pure function of shape with no override branch. |
| rich text / body as a kind | The body is the one rich field, not a frontmatter column. Correct as-is. |
| computed / formula field | Needs eval; JSON must not. Belongs to the deferred TS DSL, never to stored JSON. |

## The meta-schema: why `deriveKind` is total

There are two distinct uses of TypeBox here, which the current code conflates:

```
validate a VALUE    Schema.Compile(fieldSchema).Check(cellValue)     "is 'draft' a valid status?"        (exists)
validate a SCHEMA   Value.Check(FieldSchema, theFieldSchemaItself)   "is {type:'string'} a legal shape?"  (NEW)
```

Each palette entry carries a **closed** TypeBox object meta-schema (`additionalProperties: false`). Closure makes the nine variants mutually exclusive, so at most one matches any legal schema, so order stops mattering and typos die at the boundary.

```ts
// apps/matter/src/lib/model/palette.ts  (illustrative; typebox only, no Svelte)
const ANNOT = { title: Type.Optional(Type.String()), description: Type.Optional(Type.String()) };
const CLOSED = { additionalProperties: false };
const JsonPrimitive = Type.Union([Type.String(), Type.Number(), Type.Integer(), Type.Boolean()]);

const STRING_META = Type.Object({ type: Type.Literal('string') }, CLOSED);     // items meta (no annotations)
const SELECT_INNER = Type.Object({ enum: Type.Array(JsonPrimitive, { minItems: 1 }),
                                   type: Type.Optional(Type.Union([Type.Literal('string'), Type.Literal('number'), Type.Literal('integer')])) }, CLOSED);

const PALETTE = [
  { kind: 'select',      storage: 'TEXT',    meta: Type.Object({ ...SELECT_INNER.properties, ...ANNOT }, CLOSED) },
  { kind: 'url',         storage: 'TEXT',    meta: Type.Object({ type: Type.Literal('string'), format: Type.Literal('uri'), ...ANNOT }, CLOSED) },
  { kind: 'datetime',    storage: 'TEXT',    meta: Type.Object({ type: Type.Literal('string'), format: Type.Literal('date-time'), ...ANNOT }, CLOSED) },
  { kind: 'integer',     storage: 'INTEGER', meta: Type.Object({ type: Type.Literal('integer'), minimum: Type.Optional(Type.Number()), maximum: Type.Optional(Type.Number()), ...ANNOT }, CLOSED) },
  { kind: 'number',      storage: 'REAL',    meta: Type.Object({ type: Type.Literal('number'),  minimum: Type.Optional(Type.Number()), maximum: Type.Optional(Type.Number()), ...ANNOT }, CLOSED) },
  { kind: 'boolean',     storage: 'INTEGER', meta: Type.Object({ type: Type.Literal('boolean'), ...ANNOT }, CLOSED) },
  { kind: 'string',      storage: 'TEXT',    meta: Type.Object({ type: Type.Literal('string'), minLength: Type.Optional(Type.Integer()), maxLength: Type.Optional(Type.Integer()), pattern: Type.Optional(Type.String()), ...ANNOT }, CLOSED) },
  { kind: 'multiSelect', storage: 'TEXT',    meta: Type.Object({ type: Type.Literal('array'), items: SELECT_INNER, minItems: Type.Optional(Type.Integer()), maxItems: Type.Optional(Type.Integer()), uniqueItems: Type.Optional(Type.Boolean()), ...ANNOT }, CLOSED) },
  { kind: 'tags',        storage: 'TEXT',    meta: Type.Object({ type: Type.Literal('array'), items: STRING_META,  minItems: Type.Optional(Type.Integer()), maxItems: Type.Optional(Type.Integer()), uniqueItems: Type.Optional(Type.Boolean()), ...ANNOT }, CLOSED) },
] as const;

export type Kind = (typeof PALETTE)[number]['kind'];
export const FieldSchema = Type.Union(PALETTE.map((p) => p.meta));      // "every supported combination"
export const storageOf = (kind: Kind) => PALETTE.find((p) => p.kind === kind)!.storage;

export function deriveKind(s: object): Kind {                            // TOTAL over a validated schema
  return PALETTE.find((p) => Value.Check(p.meta, s))!.kind;
}
```

Discrimination check (must be proven first, see Phase 1.1): `string` forbids `format`/`enum`, so `{type:'string',format:'uri'}` matches only `url` and `{type:'string',enum:[...]}` matches only `select`; `tags.items` forbids `enum`, so an enum-item array matches only `multiSelect`. Every legal schema matches exactly one meta.

The boundary, in `validateModel`:

```ts
for (const [name, raw] of Object.entries(model.fields)) {
  if (!Value.Check(FieldSchema, raw)) { unmodeled.push(name); continue; }  // per-field degrade, NOT a model error
  fields.push({ name, schema: raw, kind: deriveKind(raw), check: compile(raw) });   // one flat Column, computed once
}
```

`supported: false` is gone: rejection happens at the boundary; past it, `deriveKind` cannot fail. There is no separate `derived: {kind, nullable}` bag and no second `CompiledColumn`; one flat `Column { name, schema, kind, check }` is computed once and flows to conformance, the grid, and the SQLite projector.

## Everything-required (the axis we deleted)

There is no optional and no nullable. If a field is in the model, it must be present and valid for the row to be valid. This is a deliberate asymmetric win: refuse one rare combo to delete an entire axis.

```
the encoding of "must have content" moves INTO the value schema, where it belongs:
  may be blank      { "type":"string" }                accepts ""        (an empty string is a valid value)
  must have content { "type":"string", "minLength":1 } rejects ""        (a real constraint, not a model flag)

conformance per cell collapses 4 states -> 3:
  v == null    -> NEEDS_VALUE     absent OR explicit null (nullish); "not done yet"; the publish checklist
  check(v)     -> OK
  !check(v)    -> INVALID         raw text + badge, fix in place

row valid  == every cell OK     == the row projects into matter.sqlite     == ready to publish
extras     == unmodeled keys    == shown in the "..." expander, never affect validity
```

What this deletes: `unwrapNullable` / `peelNull`, the `nullable` flag on every column, the `EMPTY` state, `isNullable` in storage (every SQLite column is `NOT NULL`), the nullable wrap in `FieldSchema`, the `column.nullable` dependency in Matter, the clear-vs-required UI, and the "required by default" rule itself (it becomes "required, full stop").

### The one honest cost (and why it is acceptable)

A field that is both typed/validated AND legitimately absent on some rows of the same folder (e.g. `canonicalUrl` on a folder mixing originals and cross-posts) has no first-class home. But that case is two types sharing one folder, which violates Matter's "folder = one type" premise. So everything-required punishes heterogeneous folders, which pushes you to split them, which is the model you wanted. The escape hatch is already built: a genuinely-optional field is just an unmodeled extra (preserved byte-for-byte, editable in the expander, never blocking validity). You never lose data by refusing optionality, so the refusal is reversible and lossless. Revisit only if a real homogeneous folder needs a typed-optional field in practice.

### `required` default and the checklist framing

Putting a field in the model is a statement that it matters; "ready to publish" is "every modeled field filled and valid." The needs-attention list IS the pre-publish checklist. The risk (a noisy checklist on early drafts) is a UX tuning question, not a correctness one; the axis stays deleted either way.

## The `field.*` builders and the `column.*` relationship

Reading `matter.json` needs only the meta-schemas (validate) and recognizers (kind). Authoring needs builders. The `field.*` builders are the authoring on-ramp for the model-editing UI (deferred increment 3.3 of the prior spec) and the optional TS DSL; they emit the same canonical JSON Schema the meta-schemas validate.

```ts
field.string()            // { type:'string' }                       Static string
field.url()               // { type:'string', format:'uri' }          Static string
field.dateTime()          // { type:'string', format:'date-time' }    Static branded DateTimeString
field.integer() / number() / boolean()
field.select(['a','b'])   // Type.Unsafe<'a'|'b'>({type:'string', enum:['a','b']})   native enum + narrowed type
field.tags()              // { type:'array', items:{type:'string'} }
field.multiSelect(['a'])  // { type:'array', items:{type:'string', enum:['a']} }
```

A round-trip test asserts `Value.Check(FieldSchema, field.X(...))` for every builder, so the authoring set and the recognized set cannot drift.

**Relationship to `packages/workspace` `column.*` (`sugar.ts`): untouched in v1.** Workspace CRDT rows are rectangular and `column.nullable` is genuinely real there, so the kind set is shared in spirit but the emptiness policy is per-substrate (workspace keeps nullable; Matter refuses it). The convergence (extract a Svelte-free `packages/field`, point `column.*` at it, switch `column.enum` to native enum via `Type.Unsafe`, update `deriveCheck` to read `s.enum`) is a named future wave, not v1. Build the palette as a self-contained, dependency-clean module (`typebox` + `wellcrafted` only, no Yjs, no Svelte) so extraction to `packages/field` is trivial when a second consumer is real.

## `matter.sqlite`: the agent read surface

Two query surfaces, with different jobs:

```
in-app live grid    SvelteMap projection + $derived JS filter/sort     reactive, in-memory, the UI uses this
agent / external    matter.sqlite (a real file next to matter.json)    arbitrary raw SQL; agents + optional in-app console
```

The live grid cannot be SQL: it must react to the watcher and re-classify on every delta, which is a `$derived` over a `SvelteMap`, not a re-query. `matter.sqlite` is the disposable mirror an out-of-process agent can actually open and query.

```
folder/
  matter.json        the model (committed)
  matter.sqlite      DERIVED, disposable, READ-ONLY, gitignored; rebuilt from files
  post-1.md ...      the data

table = the folder; one row per VALID file; INVALID/UNPARSEABLE files are absent by definition (valid == projects)

CREATE TABLE "<folder>" (
  path     TEXT PRIMARY KEY,           -- the file, the row identity
  "<field>" <STORAGE> NOT NULL,        -- every column NOT NULL: valid rows have every required field present
  ...,
  _extra   TEXT                        -- JSON of unmodeled keys, so agents can see extras too
);
-- NO CHECK constraint: read-only, inserts only rows that already passed Value.Check (validation lives once, at classify)
-- storage per column = storageOf(kind); boolean -> INTEGER 0/1; tags/multiSelect -> TEXT (JSON); select -> TEXT
```

Rebuild policy: full drop-and-recreate from the current valid projection, on a debounced settle after the watcher quiets (the same debounce the grid uses). Disposable means correctness is "delete the file, reopen the folder, get the identical table." For a folder of dozens to hundreds of drafts this is instant; do not build incremental sync. The writer is a thin matter-owned emitter (Rust `rusqlite` command or `tauri-plugin-sql`); reuse only the storage-class derivation idea from `packages/workspace/.../column/derive.ts`, not the Yjs-coupled materializer.

`getValid()` for the app is the JS `projection.filter(rowValid)`; `getValid()` for an agent is `SELECT * FROM "<folder>"`. They agree by construction.

## Architecture

```
matter.json (disk)
  -> parseModel -> validateModel
       Value.Check(FieldSchema, raw)  ── fail ─►  field is UNMODELED (raw column, like an extra)
                    │ pass
                    ▼
       Column { name, schema, kind: deriveKind(raw), check: compile(raw) }   // one flat record, once

native watcher (Rust, byte-streamer) ── FileDelta ─► SvelteMap projection ── $derived ─► classify per cell
                                                            │                                  │
                                                            │                          OK / NEEDS_VALUE / INVALID
                                                            ▼                                  ▼
                                              debounced settle                          FolderGrid
                                                            ▼                          ModeledCell -> FIELD_COMPONENTS[kind]
                                              project valid rows -> matter.sqlite        (Svelte, by name; satisfies Record<Kind,_>)
                                              (Rust emitter; NOT NULL; no CHECK)
```

The palette module (`palette.ts`: metas, `FieldSchema`, `deriveKind`, `storageOf`, `compile`) is Svelte-free and Yjs-free. The widget map (`registry.ts`) is the only Svelte half, keyed by the shared `Kind`.

## Design Decisions

| Decision | Class | Choice | Rationale |
| --- | --- | --- | --- |
| Recognition mechanism | 2 | closed TypeBox meta-schemas; their union is `FieldSchema` | makes recognition declarative + inspectable; mutual exclusivity removes the order contract; typos die at the boundary |
| `deriveKind` totality | 2 | validate against `FieldSchema` at the boundary; `deriveKind` is total | `deriveKind` does one job; no `supported:false`; no `json` member of `Kind` |
| Native `enum` + `Type.Unsafe` | 1 | store native `enum`; `field.select` uses `Type.Unsafe` | DeepWiki-verified: `Value.Check` honors `enum`; `Type.Unsafe` gives clean JSON + narrowed `Static<>` |
| Optionality | 2 | deleted; every modeled field required; "must have content" = `minLength`/constraints | one axis not two; presence becomes validation; reversible via the extras hatch; lossless |
| Conformance states | 2 | three: `NEEDS_VALUE` / `OK` / `INVALID` | falls out of everything-required; `v == null` is the genuine absent split |
| Unsupported field | 2 | degrade that one field to raw (like an extra); do NOT error the model | per-field graceful degradation; one weird field never nukes the folder |
| `json` kind | 2 | removed from `Kind`; it is the rejection lane | `Kind` is exactly the renderable set; the `JsonRepairEditor` (for INVALID values) is unrelated and stays |
| SQLite | 3 | keep; read-only `matter.sqlite` next to `matter.json`; valid rows only; rebuilt | agent/external raw-SQL read surface; the live grid stays JS. Constraint: out-of-process agents cannot query app memory |
| SQLite CHECK / nullable | 2 | none; every column `NOT NULL`, no CHECK | valid rows have every field present; read-only insert is pre-validated; validation lives once at classify |
| Palette location | 3 | Matter-local, dependency-clean, extraction-ready | building a shared `packages/field` with one consumer is premature; extract when workspace converges |
| `column.*` / `sugar.ts` | 2 | untouched in v1 | emptiness policy is per-substrate; convergence is a deliberate later wave |
| `field.*` builders | Deferred | designed; built with the model-editing UI | reading needs only metas; authoring needs builders |
| Inference | Deferred | model-first; the on-ramp scaffolds an empty/example `matter.json`, never guesses | deletes the inference-vs-validate consistency surface; matches the shipped "no model -> raw" behavior |
| relations / date / `x:widget` | Deferred / Refused | per the rejected-candidates table | keep the palette flat and `deriveKind` a pure shape function |

## Call sites: before and after

### `schema.ts`: predicate recognizers -> meta-schema palette

**Before** (`apps/matter/src/lib/model/schema.ts`): a `KINDS` array of `{kind, match}` predicates, ordered, with a `json` floor; `deriveKind` returns `{kind, nullable}` via `unwrapNullable`.

**After**: a `PALETTE` of `{kind, meta, storage}`; `FieldSchema = Type.Union(metas)`; `deriveKind(s): Kind` total; no `unwrapNullable`, no `nullable`, no `json`. `Kind` still derives from the table (`(typeof PALETTE)[number]['kind']`).

**Semantic shift to flag**: a field schema with an extra/typo key (`{type:'string', minLgth:1}`) previously passed `s.type === 'string'` and rendered as `string`; now it fails `FieldSchema` and degrades to a raw column. This is intended (typo-catching), but grep `matter.json` fixtures for non-whitelisted keys before shipping.

### `model.ts`: model-level rejection -> per-field degrade

**Before** (`apps/matter/src/lib/model/model.ts`): `if (derived.kind === 'json') return MatterModelError.UnsupportedShape(...)` errors the whole model.

**After**: a field failing `Value.Check(FieldSchema, raw)` is pushed to an `unmodeled` list and rendered raw; the rest of the model loads. `ModelField` flattens from `{ name, schema, derived:{kind,nullable} }` to `Column { name, schema, kind, check }`.

**Semantic shift to flag**: folders that previously dropped entirely to raw because of one bad field now show every other column typed. Update `model.test.ts` cases asserting whole-model rejection.

### `conformance.ts`: four states -> three

**Before**: `CellState = 'OK' | 'EMPTY' | 'NEEDS_VALUE' | 'INVALID'`; `CompiledColumn { name, nullable, check }`; classify branches on `nullable`.

**After**: `CellState = 'OK' | 'NEEDS_VALUE' | 'INVALID'`; no `CompiledColumn` (use the flat `Column`); classify is `v == null ? NEEDS_VALUE : check(v) ? OK : INVALID`.

**Semantic shift to flag**: `SelectField` and `BooleanField` drop their "(clear)" option (it existed only for nullable fields); clearing a cell is still available as the empty action (delete the key) but is no longer a "set to null" affordance. `FieldEmpty` renders one state (`NEEDS_VALUE`) instead of two.

## Implementation Plan

Build the new path, prove it, then remove the old, per clean-break wave ordering.

### Phase 1: the meta-schema palette (build)

- [ ] **1.1** Write `palette.ts` with the nine closed metas, `FieldSchema`, `Kind`, `storageOf`, `compile`, `registerFormats`. First, a focused test proving discrimination: every builder output and every hand-fixture matches exactly one meta; a typo'd or extra-key schema matches none. This test gates the rest.
- [ ] **1.2** `deriveKind(s): Kind` total via `PALETTE.find`. Delete `unwrapNullable`, `matchKind`, the `json` recognizer, and `DerivedKind`.
- [ ] **1.3** Flatten `ModelField` to `Column { name, schema, kind, check }`; compute it once in `validateModel`.

### Phase 2: everything-required + per-field degrade

- [ ] **2.1** `validateModel`: `Value.Check(FieldSchema, raw)` boundary; failing fields go to `unmodeled` (raw column), not a model error. Remove `MatterModelError.UnsupportedShape` whole-model rejection.
- [ ] **2.2** `conformance.ts`: `CellState` to three states; classify `v == null ? NEEDS_VALUE : check(v) ? OK : INVALID`; delete `nullable`/`CompiledColumn`.
- [ ] **2.3** UI: drop the clear/required affordances tied to `nullable` in `SelectField`/`BooleanField`; collapse `FieldEmpty` to one state. The `json` entry leaves `FIELD_COMPONENTS`.

### Phase 3: `matter.sqlite` agent read surface

- [ ] **3.1** A Rust command (`rusqlite` or `tauri-plugin-sql`) that, given DDL + valid rows, writes `<folder>/matter.sqlite` atomically; gitignore it.
- [ ] **3.2** JS projector: build DDL from `storageOf(kind)` (NOT NULL, no CHECK, `path` PK, `_extra` JSON); project `projection.filter(rowValid)`; serialize values per storage class (boolean 0/1, arrays JSON).
- [ ] **3.3** Wire a debounced rebuild on watcher settle; prove "delete the file, reopen, identical table".
- [ ] **3.4** (Optional) an in-app read-only SQL console querying the same file.

### Phase 4: prove, then remove

- [ ] **4.1** Typecheck + `model.test.ts` / `schema.test.ts` / `conformance.test.ts` updated and green; smoke the dogfood drafts folder.
- [ ] **4.2** Delete the old `schema.ts` recognizers, `unwrapNullable`, `DerivedKind`, `EMPTY` state, and any `nullable` plumbing left unused.

### Deferred (designed, not scheduled)

- [ ] the `field.*` authoring builders + the model-editing UI (add/retype a field; `enum` harvests distinct values)
- [ ] `packages/field` extraction + `column.*` convergence (native enum via `Type.Unsafe`, `deriveCheck` reads `s.enum`)
- [ ] board / calendar views; the `date` kind; the TS DSL; relations

## Edge Cases

### A field schema with a typo or extra key
`{type:'string', minLgth:1}` matches no meta (closed objects reject unknown keys) -> that field degrades to a raw column with a nudge ("unrecognized field shape"); the rest of the folder stays typed. The data is untouched.

### A bare `key:` (empty YAML scalar)
Parses to `null` -> `v == null` -> `NEEDS_VALUE`. Same as an omitted key (the nullish contract). Clearing a cell deletes the key; it never writes `key: null`.

### An empty string on a plain `string` field
`title: ""` is present and `Value.Check({type:'string'}, "")` passes -> `OK`. To forbid blank titles, model `{type:'string', minLength:1}`; then `""` is `INVALID`. Presence-as-validation is the whole point.

### A select over non-string values
`{type:'integer', enum:[1,2,3]}` matches the `select` meta (which allows `type: 'integer'` with `enum`) -> kind `select`, rendered as a dropdown of the integer set. Preserves the `11c9e7bf8` "enum value types" behavior.

### A value leaves the kind's domain after a model change
`duration` retyped to `integer` while a row holds `"1240s"` -> reclassifies to `INVALID`, kept verbatim, routed to `JsonRepairEditor`. The file did not change; the model did.

### An invalid or unparseable file and `matter.sqlite`
Absent from the table by definition (valid == projects). Agents needing the broken rows read the markdown directly (grep). The table is the publish-ready set.

## Open Questions

1. **`matter.sqlite` rebuild cadence.**
   - Options: (a) debounced rebuild on every watcher settle, (b) lazy rebuild on first SQL access / app focus, (c) a manual "refresh index" action.
   - **Recommendation**: (a) for v1 (simplest, eventually-consistent, instant at this scale); add (c) if a user reports staleness. Leave open.

2. **`matter.sqlite` placement and visibility.**
   - Options: (a) `<folder>/matter.sqlite` (discoverable by agents, gitignored), (b) a hidden `<folder>/.matter/index.sqlite`.
   - **Recommendation**: (a). The entire point is agent-discoverability next to `matter.json`. Gitignore the binary.

3. **`required` default UX.**
   - Everything-required can make early drafts a long needs-attention list.
   - **Recommendation**: ship required-full-stop; tune the needs-attention surface (collapse/group) before reconsidering any per-field knob. The axis stays deleted.

4. **Refinement-keyword whitelist breadth.**
   - How many JSON Schema validation keywords to whitelist per kind (just the common set, or the full draft vocabulary).
   - **Recommendation**: start with the common set named in the catalog; add per real need. The whitelist is the spec of what each kind supports, so grow it deliberately.

## Adjacent Work

- `packages/field` extraction + `column.*` convergence: not required now; brought back when a second consumer (workspace) is ready to adopt the native-enum palette.
- Fuji adopting the `Kind` -> widget registry: acceptable later; would move `registry.ts` into a shared Svelte package keyed by the shared `Kind`.

## Decisions Log

- Keep `integer` distinct from `number`: shared widget, honest storage split (INTEGER vs REAL), free to keep.
  Revisit when: a real model conflates them and the split causes friction.
- Keep SQLite (against the earlier "defer it" candy): the agent raw-SQL read surface is the use case, and it is concrete (coding agents reading the typed folder).
  Revisit when: no agent or console ever queries `matter.sqlite` in practice; then it is dead weight and `storageOf` can go.

## Success Criteria

- [ ] `FieldSchema` discriminates: every builder output and fixture matches exactly one meta; typo'd/extra-key schemas match none (Phase 1.1 test green).
- [ ] `deriveKind` is total (no `supported:false`, no `json` kind) and `Kind` is exactly the renderable set.
- [ ] A field outside the palette degrades that one column to raw; the rest of the folder stays typed.
- [ ] No optionality anywhere: no `nullable`, no `Type.Optional`, no `EMPTY` state; conformance is three states; classify is `v == null ? NEEDS_VALUE : check(v) ? OK : INVALID`.
- [ ] `matter.sqlite` materializes next to `matter.json` with valid rows as a `NOT NULL` typed table; `SELECT *` returns the publish-ready set; delete-and-rebuild yields an identical table; the file is gitignored.
- [ ] Typecheck + all `model`/`schema`/`conformance` tests green; the dogfood drafts folder classifies and projects correctly.

## References

- `apps/matter/src/lib/model/schema.ts` - the predicate `KINDS` + `deriveKind` this replaces with the meta-schema palette
- `apps/matter/src/lib/model/model.ts` - `validateModel`; whole-model rejection becomes per-field degrade; `ModelField` flattens to `Column`
- `apps/matter/src/lib/model/conformance.ts` - four states -> three; `CompiledColumn`/`nullable` removed
- `apps/matter/src/lib/components/fields/registry.ts` - `FIELD_COMPONENTS satisfies Record<Kind, FieldComponent>`; `json` entry removed
- `packages/workspace/src/document/column/sugar.ts` - `column.*` (untouched in v1); the `field.*` builders mirror it, emitting native-enum canonical JSON Schema
- `packages/workspace/src/document/column/derive.ts` - `deriveStorage` idea reused for the `matter.sqlite` DDL (storage class only; no CHECK, no nullable)
- `packages/workspace/src/document/column/constraint.ts` - `FlatJsonTSchema`; the convergence target that `Type.Unsafe<union>` already satisfies via the `Static<> extends JsonValue` fallback
- `specs/20260604T120000-typed-markdown-grid-editor.md` - the prior spec this revises (watcher, write-back, routes unchanged)
- DeepWiki `sinclairzx81/typebox` - native `enum` validation + `Type.Unsafe` static/wire decoupling (Class 1 verification)
