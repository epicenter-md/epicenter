# Column DSL and `defineTable` Refactor

**Date**: 2026-04-29
**Status**: Draft (with reconciliation notes from implementation, see below)
**Author**: AI-assisted (extensive design dialogue)
**Branch**: `braden-w/column-dsl-spec`

## Reconciliation log (2026-05-24)

Nine decisions diverged from the original draft during implementation and have been retconned in place. The notes here are normative; older passages elsewhere in this file should be read through this lens.

1. **`column.json` signature**: schema is required (no implicit `Type.Any()`), and the static type derives from `Static<S>` instead of an independent generic `<T>`. The old `<T extends JsonValue>` generic let type and runtime drift (e.g. `column.json<string[]>(column.string())` compiled while validating only strings). The new signature `json<S extends TSchema>(schema: S, opts?)` returns `TUnsafe<Static<S>>` gated by `Static<S> extends JsonValue ? Static<S> : ColumnError<...>` so the schema is the single source of truth.

2. **Options surface is TypeBox-native**: the audited `Common` / `StringOpts` / `NumberOpts` types were dropped in favor of TypeBox's `TSchemaOptions` / `TStringOptions` / `TNumberOptions`. Re-audited the originally rejected keys (`default`, `readOnly`, `writeOnly`, `title`, `$id`, `$schema`, `$comment`, `contentEncoding`, `contentMediaType`): all are inert in our pipeline (we don't call `Value.Default`; SQLite materializer doesn't read them; MCP/CLI pass them through as descriptive JSON Schema metadata, which is fine). The lockdown was theoretical and was leaking anyway because raw `Type.X()` is explicitly allowed in table definitions.

3. **DateTime is `column.dateTime()` plus `column.ianaTimeZone()`, not `DateTimeString.schema()`**: the proprietary `<UTC ISO>|<IANA TZ>` pipe format is gone. `column.dateTime()` uses TypeBox's built-in `date-time` format (RFC 3339, brand `DateTimeString`); pair it with `column.ianaTimeZone()` as a separate `<field>Zone` column when origination zone matters (calendar events, reminders). Lex-sort across rows is chronological iff every writer emits the Z form; `new Date().toISOString()` and `Temporal.Now.instant().toString()` both do this.

4. **Version ordering is unordered, matched by `_v` value**: dropped the "unique, ascending, contiguous from 1" runtime guard. The only objective check left is "no duplicate `_v` literal". `parseRow` looks up the schema via `Map<number, TObject>` keyed by `_v` value, so `defineTable(v2, v1)` and `defineTable(v1, v2)` behave identically at read time, and `defineTable(v1, v3)` (skipping v2) is allowed (orphaned stored rows of skipped versions surface as `UnknownVersion` parse errors). The earlier "by value" framing was always the intent; the old guard contradicted it.

5. **`as const` is only required without a contextual sink**: the blanket "every write call site keeps `_v: N as const`" rule overstated the TypeScript requirement. The schema side still requires `column.literal(N)` (that's where the literal type lives). On the *write* side, `as const` is only mandatory when the object literal has no contextual type to infer against. With a contextual sink (`satisfies SomeType`, an assignment to a typed variable, a return from a typed function, or passing into a typed parameter), TS narrows `_v: N` to the literal `N` on its own.

   ```ts
   // Contextual sink: `_v: 2` is fine, no `as const` needed.
   tables.notes.set({ id, title, _v: 2 })            // arg of typed parameter
   const row: NoteRowV2 = { id, title, _v: 2 }       // typed binding
   function nextNote(): NoteRowV2 { return { id, title, _v: 2 } } // typed return

   // No contextual sink: `as const` is required so the literal survives.
   const themeDefault = () => ({ mode: 'light' as const })
   //                                          ^^^^^^^^ without this, mode widens to string
   defineKv({ schema: ThemeSchema, defaultValue: themeDefault() })
   ```

   Existing examples in this spec that still write `_v: N as const` are not wrong (extra `as const` is a no-op when the contextual type already narrows), they're just no longer mandatory. Treat the `as const` form as a defensive default for free-standing literals.

6. **`defineKv` accepts vanilla `TSchema`; `column.*` in KV is sugar, not required**: `defineKv<S extends TSchema>` accepts any TypeBox schema, not just `FlatJsonTSchema`. `column.*` helpers continue to work for symmetry with `defineTable`, but they aren't required. KV values serialize through Yjs (not `JSON.stringify`), so the `JsonValue` gate inside `column.json` doesn't perfectly model KV's storage anyway. **Recommendation**: prefer vanilla `Type.X(...)` in new `defineKv` definitions and in docs/examples; the column DSL is most useful inside `defineTable`, where row-flatness and SQLite-storage derivation actually depend on it. Existing `column.*` usage in KV is back-compat; no force-rename.

   ```ts
   // Preferred for new KV definitions:
   defineKv({
     schema: Type.Object({ mode: Type.Union([Type.Literal('light'), Type.Literal('dark')]) }),
     defaultValue: { mode: 'light' },
   })

   // Still valid (back-compat):
   defineKv({
     schema: Type.Object({ mode: column.enum(['light', 'dark']) }),
     defaultValue: { mode: 'light' },
   })
   ```

7. **Discriminated unions via `column.json` with a discriminant key**: the flat-row constraint from `FlatJsonTSchema` applies to top-level *row* columns, not to schemas embedded inside `column.json(...)`. Status-tagged sub-shapes are expressed as a discriminated union *inside* a single JSON column:

   ```ts
   result: column.json(Type.Union([
     Type.Object({ status: Type.Literal('running') }),
     Type.Object({ status: Type.Literal('completed'), completedAt: column.dateTime(), output: column.string() }),
     Type.Object({ status: Type.Literal('failed'),    completedAt: column.dateTime(), error:  column.string() }),
   ]))
   ```

   Callers narrow with `Extract<Row, { result: { status: 'completed' } }>`. The canonical example lives at `apps/whispering/src/lib/workspace/definition.ts` (`transformationRuns.result`). This pattern is preferred over splitting the discriminant + payload across separate top-level columns when the variant fields only make sense together.

8. **Public error surface: `TableParseError` and `KvError` are exported**: both are part of the public surface. They are returned by `parse`, `get`, `getAll`, `update`, and the matching KV operations, and re-exported from `@epicenter/workspace`. Consumers building custom loggers, toast handlers, or error-routing layers should import them from the barrel rather than reconstructing the shape. Treat their variant names and payload fields as part of the API contract; widening or renaming variants is a breaking change.

9. **Materializer `BaseRow` shape: widened to `Record<string, unknown>`**: the SQLite materializer iterates arbitrary keys on a row to emit `INSERT` columns and bind values. To support that, `BaseRow` (or the materializer's local parameter type) is widened to `{ id: string; _v: number } & Record<string, unknown>`. The strict `JsonObject` framing remains the *spec* of what callers may write, but the materializer's runtime parameter is intentionally looser so it can walk unknown columns generically. Note for future contributors: don't re-narrow this type without auditing `packages/workspace/src/materializer/sqlite/sqlite.ts` first; tightening it will break the materializer's `for (const key in row)` loop.

## Overview

Replace arktype-as-input in `defineTable` with a small first-party column DSL (`column.string()`, `column.number()`, etc.) that compiles to TypeBox schemas internally. **The "column" is the TypeBox schema**: no wrapper, no metadata extension, no parallel state. Constructors take options objects (no method chaining). Storage class, primary-key designation, and CHECK constraints are all derived from the schema structure at the consumer (e.g. SQLite materializer), not stored as separate fields.

`_v` stays explicit at every schema declaration and at every write call site (no library magic): it is declared as `_v: column.literal(N)` per version and passed as `_v: N as const` on `set()`/`update()`. Delete `ARKTYPE_FALLBACK` and the per-node fallback layer in the standard-schema converter. Drop arktype as a workspace package dependency entirely.

> (See updated reconciliation note 5: `as const` is only required at write sites without a contextual sink; `_v: N` is sufficient when calling `set()`/`update()` because the typed parameter provides the contextual type.)

This preserves the prior "no magic, what you see is what you store" decision documented in `docs/articles/api-design-decisions-definetable-definekv.md`. The change is the schema input format (column DSL replaces raw arktype) and the underlying schema library (TypeBox replaces arktype, internally).

## Motivation

### Current state

`defineTable` accepts arktype schemas directly:

```ts
const notesTable = defineTable(
  type({
    id: NoteId,
    title: 'string',
    'folderId?': FolderId.or('undefined'),
    createdAt: DateTimeString,
    updatedAt: DateTimeString,
    _v: '1',
  }),
  type({
    id: NoteId,
    title: 'string',
    'folderId?': FolderId.or('undefined'),
    'deletedAt?': DateTimeString.or('undefined'),
    'wordCount?': 'number | undefined',
    createdAt: DateTimeString,
    updatedAt: DateTimeString,
    _v: '2',
  }),
).migrate((row) => {
  switch (row._v) {
    case 1: return { ...row, deletedAt: undefined, wordCount: undefined, _v: 2 as const }
    case 2: return row
  }
})
```

Every read goes through `standardSchemaToJsonSchema()` which uses `ARKTYPE_FALLBACK` to paper over types JSON Schema cannot represent:

```ts
const ARKTYPE_FALLBACK = {
  unit: (ctx) => {
    if (ctx.unit === undefined) return {}
    log.warn(StandardSchemaError.UnitFallback({ unit: ctx.unit }))
    return ctx.base
  },
  default: (ctx) => {
    log.warn(StandardSchemaError.DefaultFallback({ code: ctx.code, base: ctx.base }))
    return ctx.base
  },
}
```

This creates problems:

1. **Best-effort JSON Schema**: when a schema contains a morph, `.narrow()` predicate, `instanceof` proto type, or value-level `| undefined`, the converter silently drops the field's schema. Downstream consumers (MCP tool definitions, CLI codegen, RPC contracts) get incorrect or partial schemas without surfacing an error to the table author.
2. **No type-level rejection of bad columns**: under the default `exactOptionalPropertyTypes: false`, optional keys widen to `T | undefined` and slip past the `JsonObject` constraint at the row level. The fallback handler exists to compensate.
3. **Storage type inference goes through JSON Schema**: when the SQLite materializer is wired up, it has to infer storage classes from JSON Schema types. The prior implementation (`columnDef` in `ddl.ts`, since deleted) was a switch over JSON-Schema `type` and was incomplete enough to be removed. Direct column-to-storage mapping would eliminate this inference layer.
4. **Library lock-in**: arktype is currently a contract. Migrating off arktype would be a breaking change for every table definition.

`_v` boilerplate (the `_v: 'N'` literal in schemas and `_v: N as const` at write sites) is *not* in this list of problems. It is a deliberate "no magic" choice from the prior API design decision and is preserved.

### Desired state

```ts
const notesTable = defineTable(
  // v1
  {
    _v: column.literal(1),
    id: column.string<NoteId>(),
    title: column.string({ minLength: 1, maxLength: 200 }),
    folderId: column.nullable(column.string<FolderId>()),
    createdAt: DateTimeString.schema(),
    updatedAt: DateTimeString.schema(),
  },
  // v2
  {
    _v: column.literal(2),
    id: column.string<NoteId>(),
    title: column.string({ minLength: 1, maxLength: 200 }),
    folderId: column.nullable(column.string<FolderId>()),
    deletedAt: column.nullable(DateTimeString.schema({ description: 'Soft delete timestamp' })),
    wordCount: column.nullable(column.number({ minimum: 0 })),
    createdAt: DateTimeString.schema(),
    updatedAt: DateTimeString.schema(),
  },
).migrate((row) => {
  switch (row._v) {
    case 1: return { ...row, deletedAt: null, wordCount: null, _v: 2 as const }
    case 2: return row
  }
})

// Write site
tables.notes.set({
  id, title, folderId, createdAt, updatedAt,
  _v: 2 as const,  // explicit
})
```

Each `column.X(opts)` returns a vanilla TypeBox `TSchema`. The schema *is* the JSON Schema (passable directly to MCP tool definitions, Ajv, codegen). TypeBox's `Static<>` provides the static row type. There is no separate `Column<T>` wrapper, no `'x-epicenter'` metadata extension, no method chaining. Storage class is derived from the schema structure at the SQLite materializer (when wired up). `_v` is declared explicitly per version (`column.literal(N)`) and passed explicitly at write sites: no library injection or stripping. `ARKTYPE_FALLBACK` is deleted along with the rest of the standard-schema converter.

## Research findings

### Drizzle's SQLite column surface (verified via DeepWiki)

Drizzle exposes 6 constructors for the entire SQLite dialect:

| Constructor | Modes |
|---|---|
| `text()` | `text` (default), `json`; `enum: readonly string[]` config |
| `integer()` | `number` (default), `timestamp`, `timestamp_ms`, `boolean` |
| `real()` | none |
| `blob()` | `json` (default), `buffer`, `bigint` |
| `numeric()` | `string` (default), `number`, `bigint` |
| `customType()` | user-defined |

There is no dedicated `boolean()`, `bigint()`, `enum()`, `array()`, `object()`, `json()`, `timestamp()`, or `literal()` constructor. Everything is mode flags + `.$type<T>()` for branding. **Implication**: a column DSL more elaborate than Drizzle's surface is purely an ergonomics layer, not a Drizzle-mapping artifact. We do not need to mirror Drizzle 1:1.

### Existing CRDT content-doc pattern (verified across 3 apps)

In `fuji`, `honeycrisp`, and `opensidian`, per-row collaborative content uses a `createDisposableCache` keyed by `row.id`:

```ts
// fuji/browser.ts:27 (verbatim)
const entryContentDocs = createDisposableCache(
  (entryId: EntryId) => createEntryContentDoc({ entryId, ... }),
  { gcTime: 5_000 },
)
// EntryEditor.svelte:39
const contentDoc = fromDisposableCache(fuji.entryContentDocs, () => entry.id)
```

**Implication**: there is no separate "content guid field" in any row. `row.id` doubles as the cache key. A `column.docRef(cache)` primitive would have zero existing call sites. Branded IDs (`EntryId`, `NoteId`, `FileId`) already provide the type safety via the cache builder's signature. **Drop `column.docRef` from consideration.**

### Embedding nested CRDT types in rows is architecturally rejected

`attach-table.ts:91`:

```ts
export type BaseRow = { id: string; _v: number } & JsonObject
```

`JsonObject` from `wellcrafted/json` is strict (no `Date`, `bigint`, `undefined`). `attach-table.ts:109-114` documents the architectural intent verbatim:

> "For per-row content (rich text, long-form body), keep the row lean (ids, metadata, a content-doc guid) and pair the table with a separate `createDisposableCache(builder)` keyed on that content guid."

**Implication**: `column.yText()`, `column.yArray()` would invert the documented architecture. **Drop both.**

### Optional vs nullable in JSON Schema

JSON Schema represents optional keys via the `required[]` array, not via a value-level `undefined`. Three storage facts independent of TypeScript:

```ts
JSON.stringify({ name: undefined })  // '{}'  silent key drop
yMap.set('name', undefined)          // throws or no-ops
// JSON Schema spec has no `undefined` keyword, only `null`
```

Optional keys (`"key?": "T"`) are JSON-safe (the key is simply absent). Value-level `| undefined` is not. **Implication**: ban value-level `| undefined`; allow nullable values via `.nullable()`. Optional keys can be banned at the table layer without losing expressiveness; users use `.nullable()` instead.

### TypeScript compiler-flag dependency

`exactOptionalPropertyTypes: false` (the default) widens `?: T` to `T | undefined`. This means `JsonObject = { [k: string]: JsonValue }` (no `| undefined` in the index signature) rejects optional-key syntax under loose mode, but accepts it under strict mode. Library types must work under either consumer flag setting.

**Implication**: the type-level constraint cannot fully enforce "no value-level undefined" without depending on consumer tsconfig. The DSL's typed surface (`column.json<T extends JsonValue>`) closes the gap by restricting what users can express in the first place, independent of the flag.

### Prior column-DSL attempts in this codebase

Two prior attempts found in git history, both deleted:

| Attempt | Lifetime | Why removed |
|---|---|---|
| `columnDef` in `ddl.ts` (switch over JSON Schema `type` -> raw SQL DDL strings) | `a44b344a7` (2026-04-06) -> `d82481611` (2026-04-21) | Materializer became dead code; consumers did not need a generic mirror |
| `vault/src/core/columns.ts` (typed wrappers around Drizzle column builders with `BuildColumns` inference) | `dfdc30895` (2025-09-18) -> `c49ad478e` (vault scrap) | Vault package was scrapped wholesale; column DSL was not the failure mode |

**Implication**: the failure mode for prior column DSLs in this codebase has been consumer-side (no one needed the indirection), not implementation-side. Tables are alive and central; the pattern fits this time.

## Design decisions

| Decision | Choice | Rationale |
|---|---|---|
| Schema input format | Record of TypeBox `TSchema`s, produced by `column.X(opts)` constructors | The schema *is* the JSON Schema (zero conversion). `Static<typeof schema>` gives the TS row type. No wrapper, no parallel state. |
| Schema library | TypeBox internally; arktype dropped from the workspace package | TypeBox emits valid JSON Schema natively (no conversion layer). One library across `defineTable` and `defineKv`. Built-in fast validator (`Compile()`). Eliminates `ARKTYPE_FALLBACK` and the entire standard-schema converter. |
| Refinement syntax | Options object on each constructor (`column.string({ format: 'email', minLength: 5 })`) | Matches TypeBox's own `Type.X(options)` pattern. Single call site. Restricts to JSON-Schema-encodable refinements only (no morphs, no JS predicates). |
| Modifier API | None on constructors. `description`/`examples`/`deprecated` are options. Nullability is composition: `column.nullable(inner)` per TypeBox issue #989. | Helper-function nullability matches TypeBox author's explicit guidance and lets the options object stay pure TypeBox passthrough (no `splitOpts` machinery, no facade-vs-native option mixing). |
| Branded types | `Brand<'Name'>` from `wellcrafted/brand` | Codebase's canonical brand helper. Uses a unique symbol (nominal, invisible at runtime). Composable across hierarchies. Already in use across `packages/workspace/src/shared/{id,types,datetime-string}.ts`. |
| Allowed JSON Schema keywords | TypeBox-native: `TSchemaOptions` / `TStringOptions` / `TNumberOptions`. See reconciliation note 2: rejected keys (`default`, `readOnly`, `writeOnly`, `title`, `$id`, `$schema`, `$comment`, `contentEncoding`, `contentMediaType`) re-audited as inert in our pipeline. | Wrapping options would have killed TypeBox's JSDoc/overload passthrough and leaked anyway through raw `Type.X()` usage. The "audited subset" was theoretical purity. |
| Per-column metadata storage | Derived at the consumer from the schema structure; no `'x-epicenter'` extension | Storage class, primary-key designation, CHECK constraints are all derivable from `type`/`anyOf`/`const` plus the field name. Storing them separately invites drift. |
| DDL generation library | Hand-rolled walker (~30 lines) over the TypeBox schema. Drizzle ORM rejected. | Drizzle's runtime API exposes `getTableConfig` (metadata) but not DDL emission. The actual `CREATE TABLE` generator lives in `drizzle-kit` (the CLI), which isn't a runtime library. Using Drizzle would require building Drizzle-table-from-TypeBox AND a custom DDL emitter on top of `getTableConfig`. More code, plus a dep. |
| Migration API shape | Keep existing `(v1, v2, ..., vN).migrate(unionRow => currentRow)` | A-style discriminated union. Codebase already uses it. Renames and field-removals favor "any stored version -> current row" framing over per-version arrows. |
| `_v` management | Explicit at every boundary: `_v: column.literal(N)` per schema, `_v: N as const` at write sites, `row._v` at migrate | Preserves "no magic, what you see is what you store" decision from `docs/articles/api-design-decisions-definetable-definekv.md`. Auto-injection was considered (would eliminate 19 write-site boilerplate) and rejected to keep storage shape visible at every boundary. (See updated reconciliation note 5: `as const` at write sites is only required without a contextual sink.) |
| Version numbering | Variadic, unordered. Each schema self-identifies via `_v: column.literal(N)`; the library indexes by `_v` value at read time (`Map<number, TObject>`). The only objective check is "no duplicate `_v` literal"; ascending/contiguous is NOT enforced. See reconciliation note 4. | Variadic preserves clean single-version case (`defineTable(cols)`). Reorder/insert/gap are harmless: parse routes by `_v` value, not arg index. Stored rows of skipped versions surface as `UnknownVersion` parse errors. |
| Foreign-key references | Branded `column.string<TStringSubtype>()` | No CRDT integrity guarantees possible; brand carries type safety. Reject a `column.ref(table)` primitive. |
| Per-row Y.Doc references | Continue using `createDisposableCache` keyed by `row.id` | Documented architecture; zero existing call sites would use a `column.docRef`. |
| Container types (`array`, `object`) | Subsumed by `column.json(schema)`. Schema required; Static derives from `Static<S>` (reconciliation note 1). | One source of truth for type and runtime. No free `<T>` generic to drift from the schema. |
| Timestamp materialization | `column.dateTime()` (RFC 3339 Z or offset, brand `DateTimeString`) for the instant; `column.ianaTimeZone()` as a separate `<field>Zone` when origination zone matters. See reconciliation note 3. | Standard ISO format travels through every consumer (SQLite TEXT, MCP, RPC) with no driver overhead. Lex-sort across rows is chronological iff every writer emits the Z form. Apps that need ms-epoch use `column.integer()` directly. |
| Integer storage option | `column.integer()` separate from `column.number()` | Preserves opensidian's ms-epoch convention (`createdAt: 'number'`). Mirrors Drizzle's `integer` vs `real`. |
| Namespace prefix | Keep `column.` prefix | Avoids global shadowing (`String`, `Number`, `enum`). Keeps autocomplete discoverable. 3 chars per call is cheap. |
| Naming for `enum_` internally | Exposed as `column.enum`, internal symbol may be `enum_` to avoid reserved-word collision | Standard pattern. |

## The Column Catalog

Each constructor returns a vanilla TypeBox `TSchema`. Options are JSON-Schema-encodable keywords plus `nullable` and `description`. There are **no methods on the returned schemas** beyond what TypeBox provides natively.

```ts
column.string<T extends string = string>(opts?) // TEXT. T may be a branded string subtype.
column.number(opts?)                  // REAL. Refinements: minimum, maximum, multipleOf, etc.
column.integer(opts?)                 // INTEGER. Same options as number, plus integer-only constraint.
column.boolean(opts?)                 // INTEGER (0/1). Description-only options.
column.enum([...], opts?)             // TEXT, native enum keyword (= field.select). Static is the literal union.
column.json<T extends JsonValue>(schema?, opts?)  // TEXT JSON-encoded. T must satisfy JsonValue.
```

The generic on `column.string<T>()` is for branded string subtypes such as `Id & Brand<'NoteId'>`. Plain `column.string()` returns `string`. Literal string types are intentionally rejected because `column.string<'draft'>()` would validate any string at runtime while pretending the static type is only `'draft'`; use `column.literal('draft')` for that.

`DateTimeString.schema(opts?)` is a companion schema helper, not a `column` constructor. It returns a TypeBox string schema typed as `DateTimeString` and stores the existing `${UTC ISO}|${IANA TZ}` format as TEXT.

All constructors accept an options object with these common fields:

| Option | On which constructors | Effect |
|---|---|---|
| `description: string` | All | Sets `schema.description`, surfaces in MCP tool defs and CLI help. |
| `examples: unknown[]` | All | Example payloads for MCP tools, CLI codegen. |
| `deprecated: boolean` | All | Marks the column as deprecated; propagates to MCP/CLI. |

Plus per-constructor JSON Schema keywords (e.g. `format`, `pattern`, `minLength` on string; `minimum`, `maximum` on number).

**Nullability is composition, not configuration.** Wrap any column in `column.nullable(...)`:

```ts
column.nullable(column.string({ minLength: 1 }))
// Returns Type.Union([Type.String({minLength:1}), Type.Null()])
// Static<> = string | null
```

This matches TypeBox's [issue #989 author guidance](https://github.com/sinclairzx81/typebox/issues/989): there's no native `Type.Nullable` because composition with `Type.Union` is the canonical pattern. We expose the helper as `column.nullable(inner)` so users don't import TypeBox directly for this common case.

Every primitive justified by 3+ existing call sites in the codebase audit, except `column.enum` (1 confirmed call site in opensidian's `role` and `trust` fields, but the right primitive for the long tail) and `column.literal` (specifically for `_v` markers, justified by every versioned table).

### `column.literal(value)` for `_v` markers

```ts
function literal<const V extends string | number | boolean>(
  value: V,
  opts?: Common,
): TLiteral<V>
// Underlying: Type.Literal(value)
// Schema: { const: value }
// Static<>: V (literal type, e.g. `1` not `number`)
// Primary use: _v: column.literal(1), _v: column.literal(2), ...
```

`column.literal()` was previously rejected on the assumption that `_v` would be auto-managed. Once `_v` stays explicit at the schema declaration site, `column.literal()` earns its slot for that exact use. It's also available for any future "this column is always exactly value X" need, but `_v` is the dominant case.

Type inference: `column.literal(1)` returns a TypeBox schema whose `Static<>` is `1` (literal type, not widened to `number`), so `_v: column.literal(1)` contributes `_v: 1` to the row type. The migrate switch narrows on `row._v` exactly as it does today.

### `DateTimeString.schema()` represents an instant in time, with origination zone preserved

`DateTimeString.schema()` stores the codebase's existing proprietary `DateTimeString` format:

```
"2024-01-01T20:00:00.000Z|America/New_York"
 └─────── UTC ISO ──────┘ └─── IANA timezone ───┘
```

This is *not* standard ISO 8601. The `|` separator is proprietary; the IANA timezone name preserves the user's origination zone (so DST changes and "9am Tokyo time" semantics survive). See `docs/articles/datetime-string-intermediate-representation.md` for the rationale.

```ts
function DateTimeString.schema(opts?: Common): TUnsafe<DateTimeString>
// Underlying:
// Type.Refine(
//   Type.Unsafe<DateTimeString>(Type.String({ pattern: '...' })),
//   DateTimeString.is,
// )
// Schema: { type: 'string', pattern: '<UTC ISO>|<IANA TZ>' }
// Static<>: DateTimeString = `${DateIsoString}|${TimezoneId}` & Brand<'DateTimeString'>
// Companion DateTimeString.parse() returns Temporal.ZonedDateTime when math is needed
// (DateTimeString already uses Brand<'DateTimeString'> from wellcrafted/brand internally)
```

Use `pattern` as the portable contract and `Type.Refine()` as the TypeBox runtime backstop. `format` requires a TypeBox process-local `Format.Set()` registration; if that registration does not run, TypeBox treats the unknown format as valid. Other JSON Schema consumers may also ignore custom formats. `Type.Refine()` is useful inside TypeBox, but the predicate is executable code, not portable JSON Schema. Once the schema is serialized for MCP tools, CLI codegen, RPC contracts, or a non-TypeBox validator, the refinement cannot travel with it. A string `pattern` is less expressive, but it is the constraint every downstream consumer can see. The order matters: wrap the string schema with `Type.Unsafe<DateTimeString>(...)` first, then call `Type.Refine(...)`; wrapping a refined schema in `Type.Unsafe()` drops the runtime refinement.

Named `DateTimeString.schema` (not `dateTime`, not `timestamp`, not `zonedDateTime`):
- "timestamp" conventionally implies Unix integer in database land, which is misleading here
- "dateTime" implies standard ISO 8601, but this format has the proprietary `|IANA` suffix
- "zonedDateTime" collides conceptually with `Temporal.ZonedDateTime`; this value is a branded storage string, not a Temporal object
- `DateTimeString.schema()` keeps the schema helper beside the parser, stringifier, and type guard that already define the format

### `DateTimeString` vs Temporal API storage formats

Epicenter's `DateTimeString` is a branded string in the form `"<ISO 8601 UTC>|<IANA timezone>"`, e.g. `"2024-01-01T20:00:00.000Z|America/New_York"`. The pipe separator is non-standard: the Temporal proposal uses bracketed IANA suffixes like `2024-01-01T15:00:00-05:00[America/New_York]`. Epicenter's choice predates broad Temporal serialization support and optimizes for SQLite text storage and direct JSON wire transit.

| Axis | `DateTimeString` (Epicenter) | `Temporal.Instant` | `Temporal.ZonedDateTime` | `Temporal.PlainDateTime` |
|---|---|---|---|---|
| Wire format | Plain text, ~44 chars (`24 + 1 + tz`) | Plain text ISO+`Z`, ~24 chars | Plain text ISO+offset+`[IANA]`, ~40 chars | Plain text ISO, ~19-23 chars |
| Round-trip fidelity | Byte-identical (no normalization) | Byte-identical | Byte-identical per Temporal spec (not verified for all calendars) | Byte-identical |
| JSON-native | Yes, it's already a string | Needs `.toString()` / `.toJSON()` | Needs `.toString()` / `.toJSON()` | Needs `.toString()` / `.toJSON()` |
| Cross-language portability | High: any language can `split('|')` | High: ISO instant is universal | Lower: bracketed IANA suffix is a Temporal-era extension, many parsers reject it | High: ISO local datetime is universal |
| Drizzle/SQLite efficiency | Stored as `TEXT` with no `fromDriver` per row (article calls out avoiding "thousands of synchronous `fromDriver` calls") | Same if stored as text, but loses zone | Same if stored as text, but parsing back requires Temporal polyfill | Same if stored as text, but loses zone entirely |
| Comparability (lex sort) | Yes: UTC instant is the prefix, so lexicographic order = chronological order | Yes | No: leading local time + offset breaks naive lex sort across zones | Yes within a single zone, ambiguous across zones |
| Origination-zone preservation | Yes: IANA name kept verbatim | No: UTC instant only | Yes: IANA name kept verbatim | No: no zone at all |

**When to use which:**

- **`DateTimeString` (`DateTimeString.schema()`)**: default for workspace table columns (`createdAt`, `updatedAt`, scheduled fields). Sortable as text, JSON-native, zone-preserving, no driver overhead.
- **`Temporal.ZonedDateTime`**: at the moment you need date math, calendar arithmetic, or UI rendering. Produced lazily via `DateTimeString.parse()` (the article describes parse as the "last responsible moment").
- **`Temporal.Instant`**: only when the origination zone is genuinely irrelevant (e.g. monotonic event ordering across users). Prefer `DateTimeString` so you don't have to migrate later if you ever need the zone back.
- **`Temporal.PlainDateTime`**: for "wall clock" values with no zone (birthdays, daily reminders that fire at "9am local wherever you are"). Don't use it for moments in time.

### Date/time storage: when to use which primitive

| Need | How to express it | Storage | Notes |
|---|---|---|---|
| Instant in time, zone-preserving | `DateTimeString.schema()` | TEXT | Proprietary `${UTC ISO}\|${IANA TZ}`; `DateTimeString` brand |
| Standard ISO datetime with `Z` (no IANA) | `column.string({ format: 'date-time' })` | TEXT | Loses origination TZ. Cheaper bytes |
| Date only (no time, no TZ) | `column.string({ format: 'date' })` | TEXT | E.g. birthdays, due dates, calendar entries |
| Unix ms epoch | `column.integer()` | INTEGER | Compact, sortable as int. Opensidian's existing convention |
| Unix seconds | `column.integer()` | INTEGER | Same primitive, app picks ms vs s by convention |

Only `DateTimeString.schema()` gets sugar because it's the most common case (8+ call sites across fuji, honeycrisp, opensidian for `createdAt`/`updatedAt`/`date`). The other forms each have <3 call sites and read fine via `column.string({ format: ... })` directly.

**Do not add** `column.date()`, `column.unixMs()`, or `column.unixSeconds()`. Each one is a single line via the column primitives plus a `format` option. Bloating the surface for marginal sugar is the failure mode the catalog is trying to avoid.

### What was considered and rejected

| Candidate | Why rejected |
|---|---|
| `column.array(of)` / `column.object(shape)` | Subsumed by `column.json<T>(s?)`. Storage is JSON-encoded TEXT in either case; schema parameter carries element typing. |
| `column.bigint()` | JSON has no bigint. Use `column.string()` with branded type if needed. |
| `column.url()` / `column.email()` / `column.uuid()` | Use `column.string({ format: 'email' })`, `column.string({ format: 'uri' })`, or `column.string({ format: 'uuid' })`. Don't bloat surface. |
| `column.date()` | Use `column.string({ format: 'date' })` for date-only fields. <3 audit call sites. |
| `column.unixMs()` / `column.unixSeconds()` | Use `column.integer()` directly. Apps pick the convention; a primitive doesn't add safety. |
| `column.timestamp()` and `column.dateTime()` (as names) | Use `DateTimeString.schema()` instead. "timestamp" implies Unix integer in DB convention. "dateTime" implies standard ISO 8601, but this format is proprietary. Keeping the helper on `DateTimeString` avoids pretending this is a general date/time column primitive. |
| `column.binary()` / `column.bytes()` | Binary in CRDT rows is anti-pattern (bloats updates). Use `@epicenter/filesystem` instead. |
| `column.encrypted(of)` | App-specific concern. Wrap a column at app level. |
| `column.computed()` / `column.derived()` | SQL `GENERATED` columns are out of scope for v1. Compute at read time. |
| `column.docRef(cache)` | Zero call sites would use it; `column.string<EntryId>()` + cache builder signature already provide the typing. |
| `column.ref(otherTable)` | CRDTs cannot enforce referential integrity. `column.string<OtherRowId>()` provides the type-level brand. |
| `column.timestamps()` (auto createdAt/updatedAt) | Premature convention; apps differ on which timestamps they want. |
| `column.set()` / `column.map()` / `column.tuple()` | Not JSON-native. Use `column.json` or `column.array`. |
| `.default(value \| () => value)` modifier | CRDT `set()` is replace-row, `update()` is partial-merge. "When does default fire?" is ambiguous and easy to get wrong (e.g. `set({id, title})` after initial create would re-fire `createdAt` default and clobber existing data). Cost of the alternative (writing values explicitly at create sites) is ~3 lines per call. |
| `.unique()` modifier | CRDT operations are commutative and always succeed; uniqueness cannot be enforced because two peers offline can both write rows with the same value. A SQLite-mirror-only hint would silently diverge from the CRDT source of truth (mirror enforces locally, CRDT below has duplicates). Users would assume SQL-style enforcement and ship code that quietly accepts duplicates. The honest place for uniqueness is *above* the CRDT (server arbitration boundary), not at the column. |
| `.index()` modifier | Pure performance hint with no consumer in v1: the CRDT layer scans `Y.Map` directly, and the SQLite materializer was deleted (`d82481611`). YAGNI; re-add when there's a real consumer reading the metadata. Adding modifiers later is non-breaking; removing shipped modifiers is breaking. |

## No modifier API; nullability is composition

There are no `.nullable()`, `.describe()`, `.unique()`, `.index()`, `.default()`, or `.optional()` methods on column schemas. Metadata is set via the constructor's options argument; nullability is composed via a separate transformation helper:

```ts
// Metadata via options
column.string({ description: 'User email', format: 'email' })
column.string({ minLength: 1, maxLength: 200, description: 'Title' })

// Nullability via composition (TypeBox issue #989 author guidance)
column.nullable(column.string({ minLength: 1 }))
// Equivalent to Type.Union([Type.String({ minLength: 1 }), Type.Null()])
// Static<> = string | null
```

Why this shape:

- Helper-function nullability matches TypeBox's [author guidance](https://github.com/sinclairzx81/typebox/issues/989): no native `Type.Nullable` exists because composition with `Type.Union` is canonical.
- Constructor options stay pure TypeBox passthrough; no facade-vs-native key separation needed (no `splitOpts`).
- Constructors return ~2-line implementations: `Type.X(opts)` plus optional `Type.Unsafe<Brand>` for phantom branding. No conditional return types based on options.
- Reads as "wrap this column in nullable" which is exactly what the runtime does.

**Notably absent**: `.optional()`, `.default()`, `.unique()`, `.index()`.

- `optional` keys are banned because they aren't safe in CRDTs. Use `column.nullable(...)` if "intentionally empty" is a state.
- `default` interacts ambiguously with CRDT `set()`/`update()` semantics. IDs, timestamps, and other creation-time values stay explicit at write sites.
- `unique` cannot be enforced in a CRDT. Operations are commutative and always succeed; two peers offline can both write rows with the same "unique" value and merge to duplicates. A SQLite-mirror-only hint would silently diverge from the CRDT source of truth. Drop until the constraint can be enforced honestly (probably above the CRDT, at a server arbitration boundary).
- `index` is a pure performance hint with no consumer in v1: the CRDT layer scans Y.Map directly, and the SQLite materializer was deleted (`d82481611`). YAGNI; re-add when there's a real consumer to read the metadata.

## What the column DSL actually returns

Each `column.X(opts)` returns a vanilla TypeBox `TSchema`. The schema *is* the JSON Schema, the validator input, and the static-type carrier. There is no wrapper object.

```ts
const titleCol = column.string({ minLength: 1, maxLength: 200, description: 'Note title' })

// titleCol's runtime shape:
// {
//   type: 'string',
//   minLength: 1,
//   maxLength: 200,
//   description: 'Note title',
//   '~kind': 'String'
// }
//
// Static<typeof titleCol> = string
// JSON.stringify(titleCol) = valid JSON Schema
// Value.Check(titleCol, 'hello') = true
```

For `column.nullable(column.string())`:

```ts
{
  anyOf: [
    { type: 'string' },
    { type: 'null' }
  ],
  '~kind': 'Union'  // TypeBox 1.0+ uses non-enumerable `~kind`
}
// Static<> = string | null
// JSON.stringify(...) skips the non-enumerable `~kind`, so output is pure JSON Schema
```

The column DSL is a constraining facade: each constructor is shorthand for a specific `Type.X(...)` invocation, restricted to JSON-safe + SQL-mappable shapes, with phantom branding via `Type.Unsafe<T>` where needed. After construction, the schema flows through every consumer (validator, JSON Schema codegen, SQLite materializer) as a normal TypeBox schema.

## Storage class derived from schema structure

When the SQLite materializer is wired up (deleted in `d82481611`, future work), it derives the SQL storage class deterministically from each column's TypeBox schema. No `'x-epicenter'` metadata extension is needed.

```ts
function deriveStorage(schema: TSchema): 'TEXT' | 'INTEGER' | 'REAL' {
  if (schema.type === 'integer') return 'INTEGER'
  if (schema.type === 'number') return 'REAL'
  if (schema.type === 'boolean') return 'INTEGER'   // SQLite convention: 0/1
  if (schema.type === 'string') return 'TEXT'
  if (schema.type === 'array' || schema.type === 'object') return 'TEXT'  // JSON-encoded
  if (schema.const !== undefined) {
    return typeof schema.const === 'number' && Number.isInteger(schema.const) ? 'INTEGER' : 'TEXT'
  }
  if (schema.anyOf) {
    const nonNull = schema.anyOf.filter((s: TSchema) => s.type !== 'null')
    if (nonNull.length === 1) return deriveStorage(nonNull[0])
    return 'TEXT'  // mixed union → JSON-encoded
  }
  return 'TEXT'  // default fallback
}

function isNullable(schema: TSchema): boolean {
  return Boolean(schema.anyOf?.some((s: TSchema) => s.type === 'null'))
}

function deriveCheck(schema: TSchema, columnName: string): string | undefined {
  // For column.enum(['a', 'b']), the schema is anyOf-of-const.
  // Generate `column IN ('a', 'b')`.
  if (schema.anyOf?.every((s: TSchema) => s.const !== undefined)) {
    const values = schema.anyOf.map((s: TSchema) => `'${s.const}'`).join(', ')
    return `${columnName} IN (${values})`
  }
  return undefined
}

// PK convention: the field named `id` is the primary key.
// BaseRow already enforces `id` and `_v` as required across every table.
function deriveDDL(name: string, columns: Record<string, TSchema>): string {
  const lines = Object.entries(columns).map(([col, schema]) => {
    const sqlType = deriveStorage(schema)
    const nullable = isNullable(schema)
    const pk = col === 'id' ? 'PRIMARY KEY' : ''
    const check = deriveCheck(schema, col)
    return [col, sqlType, nullable ? '' : 'NOT NULL', pk, check ? `CHECK (${check})` : '']
      .filter(Boolean)
      .join(' ')
  })
  return `CREATE TABLE ${name} (\n  ${lines.join(',\n  ')}\n)`
}
```

The materializer reads the schema; it does not consult any column wrapper or extension keyword. Storage, nullability, primary-key designation, and CHECK constraints all fall out of the schema structure plus the established convention that the field named `id` is the PK.

## The `JsonValue` constraint

```ts
// Imported from wellcrafted/json (already strict in the codebase)
export type JsonValue =
  | string | number | boolean | null
  | JsonValue[]
  | { [k: string]: JsonValue }    // strict: no `| undefined`, no `?:` keys
```

Used as the upper bound on `column.json<T>`:

```ts
function json<T extends JsonValue, O extends Common = {}>(
  schema?: TSchema,
  opts?: O,
): WithNullable<TSchema, O>
```

**Accepts:**
- `column.json(Type.Object({ name: Type.String() }))` -> required key, string value
- `column.json(Type.Object({ name: Type.Union([Type.String(), Type.Null()]) }))` -> required key, nullable value
- `column.json(Type.Object({ tags: Type.Array(Type.String()) }))` -> required key, array value
- `column.json(Type.Object({ nested: Type.Object({ x: Type.Number(), y: Type.Number() }) }))` -> nested object
- `column.json<{ flexible: string }>()` -> TS-level type, defaults to `Type.Any()` runtime

**Rejects:**
- `column.json<{ created: Date }>()` -> `Date` not in `JsonValue` (TS error)
- `column.json<{ id: bigint }>()` -> `bigint` not in `JsonValue` (TS error)
- `column.json<{ name: string | undefined }>()` -> `undefined` not in `JsonValue` (TS error)
- `column.json<{ name?: string }>()` -> optional key widens to `string | undefined` under `exactOptionalPropertyTypes: false` (TS error)

The same constraint applies at the row level via `BaseRow & JsonObject`. With TypeBox internal, JSON Schema is total by construction; there's no fallback layer because there's no conversion.

## Architecture

### Type relationships

```
┌──────────────────────────────────────────────┐
│ TSchema (TypeBox)                            │
│   { type: 'string',                          │
│     minLength: 1,                            │
│     description: 'Title',                    │
│     [Kind]: 'String' }                       │
│                                              │
│   * Static<typeof schema> = TS row type      │
│   * JSON.stringify(schema) = JSON Schema     │
│   * Value.Check(schema, x) = validator       │
│   * column.X(opts) is the construction site  │
└──────────────────────────────────────────────┘
                     │
                     │ Record<string, TSchema>
                     ▼
┌──────────────────────────────────────────────┐
│ TableDefinition<TVersions>                   │
│   versions: TVersions                        │
│   columns: current version columns           │
│   schema.row: current row TObject            │
│   schema.union: all version union            │
│   input.{get,set,update,delete}              │
│   migrate: (unionRow) => current row         │
└──────────────────────────────────────────────┘
                     │
                     │ attachTables(ydoc, { name: def, ... })
                     ▼
┌──────────────────────────────────────────────┐
│ Table<TRow>                                  │
│   get(id), getAll(), set(row), update(...)   │
│   filter(...), find(...), observe(...)       │
│   columns, schema, input                     │
└──────────────────────────────────────────────┘
```

### Read flow

```
STEP 1: Reader calls table.get(id)
────────────────────────────────────
Storage holds raw bytes including _v: N (written by the user explicitly).

STEP 2: parseRow validates against version union
────────────────────────────────────
Read _v from storage. Find the schema where column.literal(N) matches.
Validate the row against that schema. If invalid, reject.

Note: schemas are matched by _v value via a Map<number, TObject>, NOT by
argument position. Reordering or skipping versions does not change which
schema matches a given stored row.

STEP 3: migrate function runs lazily per read
────────────────────────────────────
switch (row._v) { case 1: ... case 2: return row }
Returns the current version shape. _v field present in returned row, typed as
the literal version.

STEP 4: Return row to consumer
────────────────────────────────────
Consumer never sees raw storage. Always sees the current schema.
```

### Write flow

```
STEP 1: Writer calls table.set({ id, title, ..., _v: N as const })
────────────────────────────────────
User passes _v explicitly. TS checks _v matches the current schema's literal.

STEP 2: defineTable validates against current version's schema
────────────────────────────────────
No injection. The row already carries _v. Validate, then store.

STEP 3: ykv.set(row.id, row)
────────────────────────────────────
Storage holds the row exactly as written, _v included.
```

### Conversion flow (no conversion at all)

```
column.X(opts)
  │
  ▼
TSchema (TypeBox; valid JSON Schema by construction)
  │
  ▼
Type.Object(versionRecord) → TObject (the table's row schema, also valid JSON Schema)
  │
  ├──> MCP tool definitions (identity; pass the TObject through)
  ├──> CLI flag generation (identity)
  ├──> RPC server contracts (identity)
  ├──> Validator (Value.Check or Compile() for fast-path)
  └──> SQLite DDL (deriveStorage walks the schema; no metadata extension needed)
```

There is no `standardSchemaToJsonSchema()` step. There is no `ARKTYPE_FALLBACK`. The schema flows through every consumer as-is.

### Table schema and action helpers

The same TypeBox schemas should be available at the table boundary. This is the practical payoff for making the column DSL TypeBox all the way down: table helpers, custom workspace actions, RPC manifests, CLI inputs, and AI tools can all reuse the exact same schema objects.

Do not make callers reach through `table.definition.schemas`. That shape is too deep for day-to-day code. Keep `definition` for introspection and compatibility, but mirror the useful schema pieces directly on both the table definition and the attached table:

```ts
const notesTable = defineTable({
  _v: column.literal(1),
  id: column.string<NoteId>(),
  title: column.string({ minLength: 1 }),
  archivedAt: column.nullable(DateTimeString.schema()),
})

notesTable.columns.id
notesTable.schema.row
notesTable.schema.union
notesTable.input.get
notesTable.input.set
notesTable.input.update
notesTable.input.delete
```

After attachment, the same surface is available from the runtime table:

```ts
const tables = attachTables(ydoc, { notes: notesTable })

tables.notes.columns.id
tables.notes.schema.row
tables.notes.input.update
```

That makes the best standard action call site small:

```ts
const actions = {
  notes: tableActions(tables.notes),
}
```

`tableActions(table)` returns the normal CRUD action tree:

```ts
const actions = {
  notes: {
    get: defineQuery({
      input: tables.notes.input.get,
      handler: ({ id }) => tables.notes.get(id),
    }),
    set: defineMutation({
      input: tables.notes.input.set,
      handler: (row) => tables.notes.set(row),
    }),
    update: defineMutation({
      input: tables.notes.input.update,
      handler: ({ id, patch }) => tables.notes.update(id, patch),
    }),
    delete: defineMutation({
      input: tables.notes.input.delete,
      handler: ({ id }) => tables.notes.delete(id),
    }),
  },
}
```

Custom actions compose with the same surface:

```ts
const actions = {
  notes: {
    ...tableActions(tables.notes),
    archive: defineMutation({
      input: Type.Object({ id: tables.notes.columns.id }),
      handler: ({ id }) =>
        tables.notes.update(id, { archivedAt: DateTimeString.now() }),
    }),
  },
}
```

`schema.row` is the current row schema, not "latest row" in public naming. "Latest" is an implementation detail of versioned parsing. Callers work with the current row shape, so the public name should be `row`.

`schema.union` exists for parse and migration internals, plus rare tooling that needs every stored version. Most user code should use `schema.row` or the operation-oriented `input.*` schemas.

## Call sites: before and after

### fuji entries table

**Before** (`apps/fuji/src/lib/workspace.ts:57`):

```ts
const entriesTable = defineTable(
  type({
    id: EntryId,
    title: 'string',
    subtitle: 'string',
    type: 'string[]',
    tags: 'string[]',
    pinned: 'boolean',
    'deletedAt?': DateTimeString.or('undefined'),
    date: DateTimeString,
    createdAt: DateTimeString,
    updatedAt: DateTimeString,
    _v: '1',
  }),
  type({
    id: EntryId,
    title: 'string',
    subtitle: 'string',
    type: 'string[]',
    tags: 'string[]',
    pinned: 'boolean',
    rating: 'number',
    'deletedAt?': DateTimeString.or('undefined'),
    date: DateTimeString,
    createdAt: DateTimeString,
    updatedAt: DateTimeString,
    _v: '2',
  }),
).migrate((row) => {
  switch (row._v) {
    case 1: return { ...row, rating: 0, _v: 2 as const }
    case 2: return row
  }
})
```

**After**:

```ts
const entriesTable = defineTable(
  // v1
  {
    _v: column.literal(1),
    id: column.string<EntryId>(),
    title: column.string(),
    subtitle: column.string(),
    type: column.json<string[]>(),
    tags: column.json<string[]>(),
    pinned: column.boolean(),
    deletedAt: column.nullable(DateTimeString.schema()),
    date: DateTimeString.schema(),
    createdAt: DateTimeString.schema(),
    updatedAt: DateTimeString.schema(),
  },
  // v2 adds rating
  {
    _v: column.literal(2),
    id: column.string<EntryId>(),
    title: column.string(),
    subtitle: column.string(),
    type: column.json<string[]>(),
    tags: column.json<string[]>(),
    pinned: column.boolean(),
    rating: column.number(),
    deletedAt: column.nullable(DateTimeString.schema()),
    date: DateTimeString.schema(),
    createdAt: DateTimeString.schema(),
    updatedAt: DateTimeString.schema(),
  },
).migrate((row) => {
  switch (row._v) {
    case 1: return { ...row, rating: 0, _v: 2 as const }
    case 2: return row
  }
})
```

**Diff**: schemas become column records of TypeBox schemas; `_v: '1'` (arktype literal) becomes `_v: column.literal(1)`; `'deletedAt?': X.or('undefined')` becomes `column.nullable(DateTimeString.schema())`. Migrate still returns `_v: 2 as const` to preserve the discriminator. Defaults like `[]` and `0` are no longer expressed on the column; pass them explicitly at write sites.

### honeycrisp notes table

**Before** (`apps/honeycrisp/src/lib/workspace.ts:78`):

```ts
const notesTable = defineTable(
  type({
    id: NoteId,
    'folderId?': FolderId.or('undefined'),
    title: 'string',
    preview: 'string',
    pinned: 'boolean',
    createdAt: DateTimeString,
    updatedAt: DateTimeString,
    _v: '1',
  }),
  type({
    id: NoteId,
    'folderId?': FolderId.or('undefined'),
    title: 'string',
    preview: 'string',
    pinned: 'boolean',
    'deletedAt?': DateTimeString.or('undefined'),
    'wordCount?': 'number | undefined',
    createdAt: DateTimeString,
    updatedAt: DateTimeString,
    _v: '2',
  }),
).migrate((row) => {
  switch (row._v) {
    case 1: return { ...row, deletedAt: undefined, wordCount: undefined, _v: 2 as const }
    case 2: return row
  }
})
```

**After**:

```ts
const notesTable = defineTable(
  // v1
  {
    _v: column.literal(1),
    id: column.string<NoteId>(),
    folderId: column.nullable(column.string<FolderId>()),
    title: column.string(),
    preview: column.string(),
    pinned: column.boolean(),
    createdAt: DateTimeString.schema(),
    updatedAt: DateTimeString.schema(),
  },
  // v2 adds deletedAt and wordCount
  {
    _v: column.literal(2),
    id: column.string<NoteId>(),
    folderId: column.nullable(column.string<FolderId>()),
    title: column.string(),
    preview: column.string(),
    pinned: column.boolean(),
    deletedAt: column.nullable(DateTimeString.schema()),
    wordCount: column.nullable(column.number()),
    createdAt: DateTimeString.schema(),
    updatedAt: DateTimeString.schema(),
  },
).migrate((row) => {
  switch (row._v) {
    case 1: return { ...row, deletedAt: null, wordCount: null, _v: 2 as const }
    case 2: return row
  }
})
```

**Semantic shift to flag**: `'wordCount?': 'number | undefined'` collapses to `column.nullable(column.number())`. Existing rows with `wordCount` key absent will now be read as `null` instead of `undefined`. Affects app code doing `if (row.wordCount === undefined)`. Needs a one-time codemod or `??`-based read site update.

### opensidian conversations table (uses ms-epoch numbers, not ISO strings)

**Before** (`apps/opensidian/src/lib/workspace/definition.ts:63`):

```ts
const conversationsTable = defineTable(type({
  id: ConversationId,
  title: 'string',
  'parentId?': ConversationId.or('undefined'),
  'sourceMessageId?': ChatMessageId.or('undefined'),
  'systemPrompt?': 'string | undefined',
  provider: 'string',
  model: 'string',
  createdAt: 'number',
  updatedAt: 'number',
  _v: '1',
}))
```

**After**:

```ts
const conversationsTable = defineTable({
  _v: column.literal(1),
  id: column.string<ConversationId>(),
  title: column.string(),
  parentId: column.nullable(column.string<ConversationId>()),
  sourceMessageId: column.nullable(column.string<ChatMessageId>()),
  systemPrompt: column.nullable(column.string()),
  provider: column.string(),
  model: column.string(),
  createdAt: column.integer(),    // ms-epoch, NOT DateTimeString.schema()
  updatedAt: column.integer(),
})
```

**Note**: `DateTimeString.schema()` would silently change wire format from int to ISO string. `column.integer()` preserves the existing convention. This is exactly the case the date/time alternatives table is designed to make obvious.

### Write call sites: `_v` stays explicit

**Before**:

```ts
// apps/fuji/src/lib/workspace.ts:155
tables.entries.set({
  id: entryId,
  title: '',
  subtitle: '',
  type: [],
  tags: [],
  pinned: false,
  rating: 0,
  date: now,
  createdAt: now,
  updatedAt: now,
  _v: 2 as const,
})
```

**After**:

```ts
tables.entries.set({
  id: entryId,
  title: '',
  subtitle: '',
  type: [],
  tags: [],
  pinned: false,
  rating: 0,
  date: now,
  createdAt: now,
  updatedAt: now,
  _v: 2 as const,    // unchanged: still explicit
})
```

`_v` stays at every write call site by design. The 19 instances across `apps/fuji`, `apps/honeycrisp`, `apps/tab-manager`, `apps/zhongwen`, `apps/breddit`, `apps/whispering`, and `packages/skills` are preserved. The discriminator in storage matches the discriminator at the call site, with no library-side injection or stripping.

When bumping a table to a new version, every write call site needs its `_v: N as const` updated to the new current version (or grep-and-replace if the codebase uses a shared `CURRENT_V` constant). This is a deliberate cost: explicit > magic.

> (See updated reconciliation note 5: write sites may write `_v: N` (no `as const`) when the call has a contextual sink such as `tables.notes.set({...})`. `as const` is only required for free-standing literals with no inferred contextual type.)

## Type signatures (sketch)

```ts
import { Type, type TSchema, type Static, type TString, type TInteger, type TNumber, type TBoolean, type TLiteral, type TUnsafe, type TUnion, type TNull, type TObject, type TPartial, type TOmit } from 'typebox'
import type { Brand } from 'wellcrafted/brand'

// ============================================================
// Standard JSON Schema string formats
// ============================================================
// TypeBox doesn't export this as a type. We narrow `format` to this union
// for autocomplete; `string & {}` keeps the union open for custom formats
// registered via Format.Set() at runtime.

export type StandardFormat =
  | 'date-time' | 'date' | 'time' | 'duration'
  | 'email' | 'idn-email'
  | 'hostname' | 'idn-hostname'
  | 'ipv4' | 'ipv6'
  | 'uri' | 'uri-reference' | 'uri-template'
  | 'iri' | 'iri-reference'
  | 'uuid' | 'url' | 'regex'
  | 'json-pointer' | 'relative-json-pointer'

// ============================================================
// Audited common metadata: what we actually want from JSON Schema
// ============================================================
// We intentionally do NOT extend TypeBox's TSchemaOptions (which has
// [key: string]: any). The audited subset below is everything we have
// a real consumer for. See "considered and rejected" for what's excluded
// (default, readOnly, writeOnly, title, $id, $schema, $comment,
// contentEncoding, contentMediaType).

type Common = {
  /** Surfaces in MCP tool docs, CLI flag help, RPC contract documentation. */
  description?: string
  /** Example payloads for MCP tools and codegen. */
  examples?: unknown[]
  /** Mark column as deprecated; propagates to MCP/CLI. */
  deprecated?: boolean
}

type StringOpts = Common & {
  format?: StandardFormat | (string & {})
  pattern?: string
  minLength?: number
  maxLength?: number
}

type NumberOpts = Common & {
  minimum?: number
  maximum?: number
  exclusiveMinimum?: number
  exclusiveMaximum?: number
  multipleOf?: number
}

type BrandedString = string & Brand<any>

// ============================================================
// Constructors: each returns a vanilla TypeBox TSchema
// ============================================================
// No facade-only options on the constructors. Nullability is composed via
// column.nullable(inner) per TypeBox author's recommendation in issue #989
// (https://github.com/sinclairzx81/typebox/issues/989).
//
// Branded string subtypes use `Brand<'Name'>` from wellcrafted/brand, often
// composed with the shared `Id` type, e.g. `type NoteId = Id & Brand<'NoteId'>`.

namespace column {
  export function string<T extends string = string>(
    opts?: StringOpts,
  ): string extends T
    ? TString
    : T extends BrandedString
      ? TUnsafe<T>
      : never

  export function number(opts?: NumberOpts): TNumber

  export function integer(opts?: NumberOpts): TInteger

  export function boolean(opts?: Common): TBoolean

  export function enum_<const T extends readonly string[]>(
    values: T,
    opts?: Common,
  ): TUnion<{ [K in keyof T]: TLiteral<T[K]> }>
  // exposed as column.enum

  export function literal<const V extends string | number | boolean>(
    value: V,
    opts?: Common,
  ): TLiteral<V>
  // Static<TLiteral<V>> = V (literal preserved). Primary use: _v markers.

  export function json<T extends JsonValue>(
    schema?: TSchema,
    opts?: Common,
  ): TUnsafe<T>
  // T constrains the static side via JsonValue. Pass schema for nested structure.

  // Transformations
  // Per TypeBox issue #989: nullability is composed, not configured.

  export function nullable<S extends TSchema>(schema: S): TUnion<[S, TNull]>
  // Wraps a column in Type.Union([schema, Type.Null()]).
  // Static<column.nullable(column.string())> = string | null
}

declare const DateTimeString: {
  schema(opts?: Common): TUnsafe<DateTimeString>
  // Underlying schema:
  // Type.Refine(
  //   Type.Unsafe<DateTimeString>(Type.String({ pattern: DATE_TIME_STRING_PATTERN, ...opts })),
  //   DateTimeString.is,
  // )
  // Pattern is the portable JSON Schema constraint; Refine is the TypeBox runtime backstop.
}

// ============================================================
// defineTable
// ============================================================

// Each version is a record of TSchemas that includes `id` and `_v`.
// The library reads the literal _v value from each schema; arg position is metadata.
type VersionedColumns = Record<string, TSchema> & {
  id: TString | TUnsafe<string>
  _v: TLiteral<number>
}

// Row inference is identity over Static<>; no parallel inference machinery
type RowOf<TCols extends Record<string, TSchema>> = {
  [K in keyof TCols]: Static<TCols[K]>
}

type TableSchema<TVersions extends readonly VersionedColumns[]> = {
  row: TObject<LastOf<TVersions>>
  union: TSchema
}

type TableInput<TVersions extends readonly VersionedColumns[]> = {
  get: TObject<{ id: LastOf<TVersions>['id'] }>
  set: TObject<LastOf<TVersions>>
  update: TObject<{
    id: LastOf<TVersions>['id']
    patch: TPartial<TOmit<TObject<LastOf<TVersions>>, ['id']>>
  }>
  delete: TObject<{ id: LastOf<TVersions>['id'] }>
}

interface TableDefinition<TVersions extends readonly VersionedColumns[]> {
  versions: TVersions
  columns: LastOf<TVersions>
  schema: TableSchema<TVersions>
  input: TableInput<TVersions>
  migrate: (row: AnyVersionRow<TVersions>) => RowOf<LastOf<TVersions>>
}

type MigrationRequired<TVersions extends readonly VersionedColumns[]> = {
  /**
   * Multiple table versions require `.migrate(fn)` before this can be used
   * as a TableDefinition.
   */
  migrate(
    fn: (row: AnyVersionRow<TVersions>) => RowOf<LastOf<TVersions>>,
  ): TableDefinition<TVersions>
}

// Single version
export function defineTable<TCols extends VersionedColumns>(
  v1: TCols,
): TableDefinition<[TCols]>

// Multi-version
export function defineTable<
  const TVersions extends readonly [VersionedColumns, VersionedColumns, ...VersionedColumns[]],
>(...versions: TVersions): MigrationRequired<TVersions>

// ============================================================
// attachTables (unchanged in shape)
// ============================================================

export function attachTables<T extends Record<string, TableDefinition<any>>>(
  ydoc: Y.Doc,
  defs: T,
): {
  [K in keyof T]: Table<RowOf<LastOf<T[K]['versions']>>> & {
    columns: T[K]['columns']
    schema: T[K]['schema']
    input: T[K]['input']
  }
}

// ============================================================
// tableActions
// ============================================================

export function tableActions<TRow extends BaseRow>(
  table: Table<TRow> & {
    input: {
      get: TSchema
      set: TSchema
      update: TSchema
      delete: TSchema
    }
  },
): {
  get: Query<typeof table.input.get, Result<TRow | null, TableParseError>>
  set: Mutation<typeof table.input.set, void>
  update: Mutation<typeof table.input.update, Result<TRow | null, TableParseError>>
  delete: Mutation<typeof table.input.delete, void>
}
```

## Implementation plan

### Phase 1: Column DSL foundation

- [ ] **1.1** Verify the existing `typebox` dependency in `packages/workspace/package.json` and use imports from `typebox`, not deprecated `@sinclair/typebox`.
- [ ] **1.2** Create `packages/workspace/src/document/column/` folder structure
- [ ] **1.3** Implement 7 column constructors as facades over TypeBox primitives: `string`, `number`, `integer`, `boolean`, `enum`, `literal`, `json`. Each takes an options object and returns a vanilla `TSchema`.
- [ ] **1.4** Add `DateTimeString.schema()` as a companion schema helper implemented as `Type.Refine(Type.Unsafe<DateTimeString>(Type.String({ pattern: DATE_TIME_STRING_PATTERN })), DateTimeString.is)`. Use `pattern` for the portable JSON Schema contract and `Type.Refine` for TypeBox runtime validation.
- [ ] **1.5** Wire `column.json<T extends JsonValue>` constraint and verify it rejects `Date`, `bigint`, `undefined`, optional keys at the type level
- [ ] **1.6** Type test: branded IDs from `column.string<AId>()` and `column.string<BId>()` are mutually unassignable; `Static<>` on each preserves the exact string subtype
- [ ] **1.7** Type test: `column.literal(1)` returns a schema where `Static<>` is `1` (literal preserved, not widened); `_v: column.literal(1)` contributes `_v: 1` to the row type
- [ ] **1.8** Type test: variadic version inference produces correct `_v: 1 | 2 | ... | N` literal union by reading each schema's `_v` literal via `Static<>`
- [ ] **1.9** Type test: `column.nullable(column.string())` resolves to `Static<>` of `string | null`; `column.nullable(column.string<NoteId>())` resolves to `NoteId | null`
- [ ] **1.10** Verify TypeBox internal `~kind` metadata is preserved through the constructor chain so `Static<>` continues to infer correctly
- [ ] **1.11** Export `column` namespace and `JsonValue` from `packages/workspace`

### Phase 2: `defineTable` integration

- [ ] **2.1** Update `defineTable` generic constraint to `VersionedColumns` (`Record<string, TSchema> & { id: TString | TUnsafe<string>; _v: TLiteral<number> }`)
- [ ] **2.2** Row inference: `RowOf<TCols> = { [K in keyof TCols]: Static<TCols[K]> }`, direct delegation to TypeBox
- [ ] **2.3** Read `_v` from storage in `parseRow` and look up the matching schema by `_v` value (not by arg position). Walk the variadic versions and check each `_v` schema's `const` value.
- [ ] **2.4** Validate matched row using `Value.Check(schema, row)` (or `Compile()` cached for hot path); on failure use `Value.Errors()` for structured error messages
- [ ] **2.5** Verify migrate function still receives the discriminated union and returns the current row type, including the current `_v: N as const` in returns
- [ ] **2.6** No write-side injection: `_v` arrives from the user; library validates it matches the current schema's literal but does not insert it
- [ ] **2.7** Update `BaseRow` type to require `_v: number` at the type level (matches existing tightening per PR #1366)
- [ ] **2.8** Return `MigrationRequired<TVersions>` from multi-version `defineTable(...)` until `.migrate(fn)` is called. The intermediate builder must be unassignable to `TableDefinition`.
- [ ] **2.9** Runtime guard: every version must declare an `_v: column.literal(N)` field, and no two versions may declare the same `N`. Ascending/contiguous is NOT required (reconciliation note 4).
- [ ] **2.10** Store the reusable schema surfaces on each `TableDefinition`: `columns`, `schema.row`, `schema.union`, and `input.{get,set,update,delete}`.
- [ ] **2.11** Mirror `columns`, `schema`, and `input` onto the attached `Table` returned by `attachTable` and `attachTables`, so custom actions can use `tables.notes.input.update` without reaching through `table.definition`.
- [ ] **2.12** Add `tableActions(table)` as an opt-in helper that returns CRUD `defineQuery` and `defineMutation` actions using the table's `input.*` schemas.

### Phase 3: Converter deletion (was: cleanup)

The standard-schema converter exists to translate arktype/zod/etc. to JSON Schema. With TypeBox, the schema *is* the JSON Schema. The entire converter goes away.

- [ ] **3.1** Delete `packages/workspace/src/shared/standard-schema.ts` (the entire file): `standardSchemaToJsonSchema()`, `ARKTYPE_FALLBACK`, the outer `trySync`, and helper types
- [ ] **3.2** Delete `StandardSchemaError.UnitFallback`, `DefaultFallback`, `ConversionFailed` variants from the error file
- [ ] **3.3** Update every consumer of `standardSchemaToJsonSchema()` (MCP codegen, CLI codegen, RPC server, etc.) to consume TypeBox `TSchema`s directly
- [ ] **3.4** Drop `arktype` from `packages/workspace/package.json` `dependencies`
- [ ] **3.5** Verify MCP tool definitions, CLI codegen, RPC server schemas all produce correct output for column-based tables (regression check)

### Phase 4: Migrate apps

- [ ] **4.1** `apps/fuji`: translate `entriesTable`. Schemas use `_v: column.literal(N)`; write call sites keep `_v: N as const`.
- [ ] **4.2** `apps/honeycrisp`: translate `foldersTable` and `notesTable`. Same `_v` treatment. One-time codemod for `wordCount === undefined` -> `wordCount === null`.
- [ ] **4.3** `apps/opensidian`: translate `conversationsTable`, `chatMessagesTable`, `toolTrustTable`. Use `column.integer()` for ms-epoch fields.
- [ ] **4.4** `apps/tab-manager`, `apps/zhongwen`, `apps/breddit`, `apps/whispering`, `packages/skills`: mechanical translation of remaining tables. `_v` stays at every write.
- [ ] **4.5** `packages/filesystem`: translate `filesTable` if present.
- [ ] **4.6** Run full type check across the monorepo. Verify no regressions in MCP/CLI generation.

### Phase 5: Documentation

- [ ] **5.1** Update `packages/workspace/README.md` with column DSL examples
- [ ] **5.2** Add JSDoc on `column.json` documenting "no optional keys, use `column.nullable(...)` for intentionally empty values" with example
- [ ] **5.3** Add JSDoc on `defineTable` documenting positional version convention
- [ ] **5.4** Document `DateTimeString.schema()` storage format (proprietary `${UTC ISO}|${IANA TZ}`, brand `DateTimeString`) and the date/time alternatives table for cases the primitive doesn't cover. Cross-reference `docs/articles/datetime-string-intermediate-representation.md` and `docs/articles/api-design-decisions-definetable-definekv.md` (the latter is partially outdated; either update it or note the divergence).

## Edge cases

### Reading old rows after schema upgrade

1. App ships with v1 schema. Users write rows with `_v: 1`.
2. App updates to v2 schema. Existing v1 rows still in IndexedDB.
3. On read: `parseRow` reads `_v: 1` from storage, validates against versions[0] (v1 schema), passes the v1-shaped row to `migrate()`, gets the v2-shaped row back.
4. v1 storage bytes never rewritten unless the row is updated.

**Expected**: works identically to today's behavior.

### Concurrent writes from peers on different schema versions

1. Peer A on v1 writes a row with `_v: 1`.
2. Peer B on v2 reads, applies `migrate()`, edits a field, writes back with `_v: 2`.
3. Peer A on v1 reads the v2 row, validation fails against v1 schema.
4. The LWW map's last-write-wins semantics mean Peer B's v2 write becomes the canonical version.

**Expected**: peer A's v1 client gets a parse failure for that row. The row is "ahead of" peer A's known schema. Behavior is identical to today.

### Renaming a field across versions

1. v1 has `body: column.string()`.
2. v2 renames to `content: column.string()`.
3. Migration: `case 1: return { ...omit(row, 'body'), content: row.body }`.

**Expected**: works as today. The migrate function expresses the rename directly.

### Adding then removing a field

1. v1: no extra field.
2. v2: adds `cachedHash: column.string()`.
3. v3: removes `cachedHash`.
4. Migration:
   ```ts
   switch (row._v) {
     case 1: return row              // already lacks the field
     case 2: return omit(row, 'cachedHash')
     case 3: return row
   }
   ```

**Expected**: Option A's "any version -> current row in one step" framing handles this correctly. A v1 row is never given `cachedHash` and never has it removed.

### `column.json` with consumer's `exactOptionalPropertyTypes: false`

1. Consumer writes `column.json(type({ "name?": "string" }))`.
2. Under loose mode, the inferred type widens to `{ name?: string | undefined }`.
3. `T extends JsonValue` rejects this because `JsonValue` index signature has no `undefined`.
4. Type error at the `column.json()` call site.

**Expected**: rejection is correct (optional keys aren't allowed in JSON columns). Error message should be clear. JSDoc on `column.json` should document the rule with an example pointing to `column.nullable(...)`.

## Open questions

1. **TypeBox `~kind` preservation through wrapping**: `column.nullable(inner)` calls `Type.Union([inner, Type.Null()])`. Does this preserve `Static<>` inference correctly across deep nesting (e.g. nullable + branded)? The implementation should write a type test that asserts `Static<typeof column.nullable(column.string<NoteId>())>` is exactly `NoteId | null` and verify it actually compiles.
   - **Recommendation**: add a dedicated type-test file (`column.type-test.ts`) and run it as part of CI. If TypeBox's `~kind` non-enumerable property is ever broken across our composition, the test fails loud.

2. **Dev/debug write sites that intentionally write old version data**: `apps/fuji/src/routes/stress-test/+page.svelte:140` and `apps/whispering/.../debug/+page.svelte:161` write `_v` from outside the action layer. Since `_v` stays explicit, these sites continue to write whatever literal they currently write. Worth confirming none of them need to write a version that no longer has a matching schema.
   - **Recommendation**: leave them alone unless they reference a deleted version. If they do, they're broken regardless of this refactor.

3. **`DateTimeString.schema()` storage format**: proprietary `${UTC ISO}|${IANA TZ}` (chosen) or standard Temporal-style bracketed IANA?
   - **Decision**: proprietary format. Drop-in for existing `DateTimeString` brand and existing rows on disk. Switching to bracketed IANA would break every stored row across every workspace. Document the format clearly in `DateTimeString.schema()` JSDoc and in the spec's "DateTimeString vs Temporal API" comparison.

4. **Schema library for `defineKv`**: `defineKv` currently uses raw arktype, intentionally asymmetric with `defineTable`. Now that arktype is being dropped, should `defineKv` switch to TypeBox?
   - **Decision**: yes. With arktype dropped, asymmetry no longer pays back. `defineKv` accepts a TypeBox `TSchema` plus a default value. KV value is `Static<typeof schema>`. Migration is mechanical: `type({ ... })` → `Type.Object({ ... })`. The "tabular vs blob" distinction collapses because TypeBox handles nested objects identically to arktype.

5. **Runtime fingerprint check on schema drift?**
   - Context: explicit `_v: column.literal(N)` makes reorder/insert harmless (the library matches by `_v` value, not arg position). The remaining hazard is *editing* a shipped version's schema in place: adding/removing/retyping a column on v1 after rows with `_v: 1` exist in storage.
   - Phase-1 requirement: enforce version literals are unique (no two versions declaring the same `N`) and present (every version has `_v: column.literal(N)`). Ascending/contiguous-from-1 was originally required and was dropped during implementation; see reconciliation note 4. Skipping a version (`defineTable(v1, v3)`) is now allowed and stored rows of skipped versions surface as `UnknownVersion` parse errors.
   - Deferred option: compute a stable column-shape hash per `_v` and store it in document metadata. That catches editing a shipped version in place, but it adds state, hashing rules, and document upgrade behavior. Defer until the simpler duplicate-only guard proves insufficient.

## Success criteria

- [ ] `column` namespace with 7 constructors plus `column.nullable` transformation helper exported from `@epicenter/workspace`. No method-chaining API; all metadata via constructor options.
- [ ] `column.dateTime()` (RFC 3339, brand `DateTimeString`) and `column.ianaTimeZone()` (separate field, brand `IanaTimeZone`) exported. The proprietary pipe format is gone per reconciliation note 3.
- [ ] Branded string subtypes use `Brand<'Name'>` from `wellcrafted/brand`, never inline `{ __brand: ... }` shapes
- [ ] `defineTable` accepts `VersionedColumns` (a record of TypeBox `TSchema`s with required string `id` and `_v: TLiteral<number>`) per version
- [ ] Multi-version `defineTable(v1, v2, ...)` returns a `MigrationRequired` builder that is unassignable to `TableDefinition` until `.migrate(fn)` is called
- [ ] Version literals are validated as unique (no duplicate `_v`); ascending/contiguous is NOT enforced per reconciliation note 4
- [ ] `TableDefinition` exposes `columns`, `schema.row`, `schema.union`, and `input.{get,set,update,delete}` without requiring callers to reach through `definition.schemas`
- [ ] Attached `Table` mirrors `columns`, `schema`, and `input` directly, so custom actions can use `tables.notes.input.update`
- [ ] `tableActions(table)` returns opt-in CRUD actions built from `table.input.*` schemas and existing table methods
- [ ] Every translated schema declares `_v: column.literal(N)` per version
- [ ] Every translated write call site keeps `_v: N as const` (See updated reconciliation note 5: `as const` only required without a contextual sink; `_v: N` is acceptable when calling a typed `set()`/`update()`.)
- [ ] Library does NOT inject or strip `_v` at any boundary
- [ ] `parseRow` looks up the matching schema by `_v` value via `Map<number, TObject>` (not by arg position): swapping `defineTable(v2, v1)` parses a stored `_v: 1` row against v1's schema; skipping a version (`defineTable(v1, v3)`) parses stored `_v: 1` and `_v: 3` rows correctly and surfaces stored `_v: 2` rows as `UnknownVersion`
- [ ] `arktype` removed from `packages/workspace/package.json`
- [ ] `packages/workspace/src/shared/standard-schema.ts` deleted; all consumers consume TypeBox `TSchema` directly
- [ ] `StandardSchemaError.UnitFallback`, `DefaultFallback`, `ConversionFailed` deleted
- [ ] `defineKv` accepts a TypeBox `TSchema` and a default value (migrated from arktype)
- [ ] All apps in `apps/*` migrate without changes to `attachTables` or to `tables.x.get/set/update` semantics
- [ ] MCP tool definitions, CLI codegen, and RPC server schemas produce identical or improved output for translated tables
- [ ] Type-test asserts: branded IDs from different brands are mutually unassignable; `Static<>` preserves brand
- [ ] Type-test asserts: `column.json(schema)` derives static from `Static<S>` and rejects schemas whose static contains `Date`, `bigint`, value-level `undefined`, or optional keys (via `ColumnError` template-literal in the return type)
- [ ] Type-test asserts: `column.literal(N)` resolves `Static<>` to `N` (literal preserved), contributing `_v: N` to the row type
- [ ] Type-test asserts: `column.nullable(column.string())` resolves `Static<>` to `string | null`; `column.nullable(column.string<NoteId>())` resolves to `NoteId | null`
- [ ] Type-test asserts: variadic version inference produces correct `_v: 1 | 2 | ... | N` for up to 10 versions
- [ ] Type-test asserts: TypeBox internal `~kind` metadata is preserved through constructor + nullable wrapping; `Static<>` continues to infer correctly
- [ ] All existing workspace package tests pass
- [ ] Bun typecheck passes across the monorepo
- [ ] No regression in observable `Table<T>` API; consumer code reading rows is unchanged

## References

### Files to create

- `packages/workspace/src/document/column/index.ts` - Column DSL public API (re-exports)
- `packages/workspace/src/document/column/constructors.ts` - 9 constructor functions, each a thin facade over `Type.X(opts)`
- `packages/workspace/src/document/column/types.ts` - shared option types (`Common`, `StringOptions`, `NumberOptions`, `WithNullable`, `Brand`)
- `packages/workspace/src/document/column/derive.ts` - `deriveStorage`, `isNullable`, `deriveCheck` helpers (for future SQLite materializer)

### Files to modify

- `packages/workspace/src/document/define-table.ts` - swap generic constraint to `Record<string, TSchema>`-based, parse-by-`_v`-value
- `packages/workspace/src/document/attach-table.ts` - validate via `Value.Check`/`Compile`; no `_v` injection; mirror `columns`, `schema`, and `input` onto attached table handles
- `packages/workspace/src/shared/actions.ts` or a new `packages/workspace/src/document/table-actions.ts` - add `tableActions(table)` CRUD action helper
- `packages/workspace/src/document/define-kv.ts` - migrate from arktype to TypeBox `TSchema`
- `packages/workspace/src/index.ts` - export `column` namespace and `JsonValue`
- `packages/workspace/package.json` - keep `typebox`, drop `arktype`

### Files to delete

- `packages/workspace/src/shared/standard-schema.ts` - the entire converter, including `ARKTYPE_FALLBACK`, `standardSchemaToJsonSchema`, the outer `trySync`

### Files to consult

- `packages/workspace/src/cache/disposable-cache.ts:121` - `createDisposableCache` (the per-row content-doc pattern)
- `packages/workspace/src/document/attach-table.ts:91` - `BaseRow` type definition
- `packages/workspace/src/document/attach-table.ts:109-114` - documented architecture for per-row content
- `apps/fuji/src/lib/workspace.ts:57` - reference table for migration translation
- `apps/honeycrisp/src/lib/workspace.ts:78` - reference table with multi-version migration
- `apps/opensidian/src/lib/workspace/definition.ts:63` - reference table with ms-epoch numbers
- `wellcrafted/json` - source of `JsonValue` and `JsonObject`

### Prior art (deleted)

- `packages/workspace/src/extensions/materializer/sqlite/ddl.ts` (commit `a44b344a7` -> `d82481611`) - prior switch-based JSON Schema -> DDL string generation
- `packages/vault/src/core/columns.ts` (commit `dfdc30895` -> `c49ad478e`) - prior typed wrappers around Drizzle column builders

### External

- Drizzle SQLite column docs: https://orm.drizzle.team/docs/column-types/sqlite
- Standard Schema spec: https://standardschema.dev
- arktype `toJsonSchema` docs: https://arktype.io/docs/json-schema
