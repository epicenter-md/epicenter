# Variadic `defineTable` / `defineKv`: Replace `.version()` Chaining with Rest Parameters

**Date:** 2026-03-03
**Status:** Implemented
**Author:** braden
**Branch:** `braden-w/variadic-define-table-kv`

## Overview

Replace the `.version()` builder chain on `defineTable()` and `defineKv()` with variadic rest parameters. The chaining gives no type inference benefit over rest params and adds unnecessary API surface (a `TableBuilder` / `KvBuilder` intermediate type).

## Motivation

### Current State

```typescript
const posts = defineTable()
  .version(type({ id: 'string', title: 'string', _v: '1' }))
  .version(type({ id: 'string', title: 'string', views: 'number', _v: '2' }))
  .migrate((row) => {
    switch (row._v) {
      case 1: return { ...row, views: 0, _v: 2 as const };
      case 2: return row;
    }
  });
```

### Problems

1. **`.version()` chaining builds a tuple one element at a time, but TypeScript can infer the full tuple from a variadic rest parameter.** The sequential chaining gives zero type inference advantage: each `.version()` call is independent (it doesn't constrain the next call).

2. **The `TableBuilder` / `KvBuilder` types exist only to collect schemas.** This is exactly what rest parameters do natively. The builder types are extra API surface to maintain, export, and document.

3. **The `defineTable()` zero-arg overload returns a builder, not a definition.** This creates a confusing state where `defineTable()` on its own is incomplete: you must chain `.version().migrate()` to get a usable definition. With variadic, every call to `defineTable(...)` returns something meaningful.

### Desired State

```typescript
const posts = defineTable(
  type({ id: 'string', title: 'string', _v: '1' }),
  type({ id: 'string', title: 'string', views: 'number', _v: '2' }),
).migrate((row) => {
  switch (row._v) {
    case 1: return { ...row, views: 0, _v: 2 as const };
    case 2: return row;
  }
});
```

Or with pre-declared schemas (recommended style for readability):

```typescript
const postV1 = type({ id: 'string', title: 'string', _v: '1' });
const postV2 = type({ id: 'string', title: 'string', views: 'number', _v: '2' });

const posts = defineTable(postV1, postV2).migrate((row) => {
  switch (row._v) {
    case 1: return { ...row, views: 0, _v: 2 as const };
    case 2: return row;
  }
});
```

## Design Decisions

| Decision | Choice | Rationale |
|---|---|---|
| `_v` management | User-managed (no change) | `_v` is already a convention, not infrastructure. Users include it in their schemas. No auto-injection. |
| Single-version shorthand | Keep `defineTable(schema)` returning a complete definition | This is the most common pattern (100% of production code). No `.migrate()` needed. |
| Multi-version API | `defineTable(s1, s2, ...sN).migrate(fn)` | Rest params give identical tuple inference. Eliminates `TableBuilder`/`KvBuilder` types. |
| `.withDocument()` chaining | Keep as-is on the result of both shorthand and `.migrate()` | Orthogonal to versioning. Already works well. |
| Zero-arg `defineTable()` | Remove | No longer needed. The zero-arg call was only the entry point for the builder chain. |
| Minimum version count for `.migrate()` | 2+ schemas required for the variadic overload | If you pass 1 schema, use the shorthand (no `.migrate()` needed). If you pass 2+, `.migrate()` is required. |

## Architecture

### Overload Structure for `defineTable`

```
defineTable(schema)                    → TableDefinitionWithDocBuilder<[TSchema], {}>
defineTable(s1, s2, ...sN)             → { migrate(fn) → TableDefinitionWithDocBuilder<TVersions, {}> }
```

```
┌─────────────────────────────────────────────────────┐
│ defineTable(schema)                                 │
│   1 arg → complete definition                       │
│   Returns: TableDefinitionWithDocBuilder             │
│            (has .withDocument())                     │
├─────────────────────────────────────────────────────┤
│ defineTable(s1, s2, ...sN)                          │
│   2+ args → needs .migrate()                        │
│   Returns: { migrate(fn) → TableDefinitionWithDocBuilder }│
│                                                     │
│   migrate(fn) receives union of all version outputs  │
│   migrate(fn) must return the last version's output  │
└─────────────────────────────────────────────────────┘
```

### Overload Structure for `defineKv`

Identical pattern, but without `BaseRow` constraint and without `.withDocument()`:

```
defineKv(schema)                       → KvDefinition<[TSchema]>
defineKv(s1, s2, ...sN)                → { migrate(fn) → KvDefinition<TVersions> }
```

### Types to Remove

- `TableBuilder<TVersions>`: replaced by the variadic overload's return type (inline `{ migrate(...) }`)
- `KvBuilder<TVersions>`: same

### Types to Keep (unchanged)

- `TableDefinition<TVersions, TDocuments>`
- `TableDefinitionWithDocBuilder<TVersions, TDocuments>`
- `KvDefinition<TVersions>`
- `LastSchema<T>`
- `BaseRow`
- All result types, helper types, etc.

## Implementation Plan

### Wave 1: Core API Changes (sequential: `defineTable` then `defineKv`)

- [x] **1.1** Rewrite `defineTable` in `packages/epicenter/src/workspace/define-table.ts`:
  - Remove the `TableBuilder` type
  - Remove the zero-arg `defineTable()` overload
  - Keep the single-arg `defineTable(schema)` overload (unchanged behavior)
  - Add a variadic overload: `defineTable<const TVersions extends [CombinedStandardSchema<BaseRow>, CombinedStandardSchema<BaseRow>, ...CombinedStandardSchema<BaseRow>[]]>(...versions: TVersions)` returning `{ migrate(fn): TableDefinitionWithDocBuilder<TVersions, Record<string, never>> }`
  - Implementation body: check `arguments.length === 1` for shorthand path; otherwise treat as variadic, call `createUnionSchema(versions)` in `.migrate()`
  - Update JSDoc and `@example` blocks in the file

- [x] **1.2** Rewrite `defineKv` in `packages/epicenter/src/workspace/define-kv.ts`:
  - Remove the `KvBuilder` type
  - Remove the zero-arg `defineKv()` overload
  - Keep the single-arg `defineKv(schema)` overload (unchanged behavior)
  - Add a variadic overload: `defineKv<const TVersions extends [CombinedStandardSchema, CombinedStandardSchema, ...CombinedStandardSchema[]]>(...versions: TVersions)` returning `{ migrate(fn): KvDefinition<TVersions> }`
  - Update JSDoc and `@example` blocks

### Wave 2: Update All Test Files (parallelizable)

Every `.version()` chain becomes variadic arguments. The migration functions stay identical.

- [x] **2.1** Update `packages/epicenter/src/workspace/define-table.test.ts`
- [x] **2.2** Update `packages/epicenter/src/workspace/define-kv.test.ts`
- [x] **2.3** Update `packages/epicenter/src/workspace/create-tables.test.ts`
- [x] **2.4** Update `packages/epicenter/src/workspace/create-kv.test.ts`
- [x] **2.5** Update `packages/epicenter/src/workspace/table-helper.test.ts`
- [x] **2.6** Update `packages/epicenter/src/workspace/describe-workspace.test.ts`
- [ ] **2.7** Update `packages/epicenter/src/workspace/create-workspace.test.ts`
  > **Note**: No `.version()` chains found: file already uses single-arg shorthand only. No changes needed.

**Transformation pattern for tests:**

```typescript
// Before
defineTable()
  .version(type({ id: 'string', title: 'string', _v: '1' }))
  .version(type({ id: 'string', title: 'string', views: 'number', _v: '2' }))
  .migrate((row) => { ... });

// After
defineTable(
  type({ id: 'string', title: 'string', _v: '1' }),
  type({ id: 'string', title: 'string', views: 'number', _v: '2' }),
).migrate((row) => { ... });
```

Same for `defineKv`:

```typescript
// Before
defineKv()
  .version(type({ mode: "'light' | 'dark'", _v: '1' }))
  .version(type({ mode: "'light' | 'dark' | 'system'", fontSize: 'number', _v: '2' }))
  .migrate((v) => { ... });

// After
defineKv(
  type({ mode: "'light' | 'dark'", _v: '1' }),
  type({ mode: "'light' | 'dark' | 'system'", fontSize: 'number', _v: '2' }),
).migrate((v) => { ... });
```

### Wave 3: Verify

- [x] **3.1** Run `bun test` across the workspace to confirm all tests pass
  > **Note**: 200/201 pass. The 1 failure (`factory throw in workspace cleans up prior extensions in LIFO order`) is pre-existing on main.
- [x] **3.2** Run `bun run typecheck` to confirm no type errors
  > **Note**: All type errors are pre-existing. Our changes fixed 3 files (create-kv.test.ts, define-kv.test.ts, describe-workspace.test.ts).
- [x] **3.3** Run `bun run lint` and fix any issues
  > **Note**: Pre-existing lint warnings/errors unrelated to our changes. Applied formatting to our changed files.

## Edge Cases

1. **Single schema passed to variadic overload**: TypeScript overload resolution handles this: single arg matches the first overload (shorthand), not the variadic. The variadic requires 2+ args via the tuple constraint `[S, S, ...S[]]`.

2. **`.withDocument()` after `.migrate()`**: Works identically. `.migrate()` returns `TableDefinitionWithDocBuilder` which has `.withDocument()`. No change needed.

3. **Pre-composed schemas (like `commandBase.merge(...)`)**: Still works: the result is a `CombinedStandardSchema` passed as a single arg to the shorthand overload. No change.

4. **KV with non-object schemas** (e.g., `defineKv(type('Record<string, string> | null'))`): Single-arg shorthand, unaffected.

5. **KV with field-presence migration (no `_v`)**: Still works: the migrate function receives the union type and can use `'field' in v` checks. No change to migration function signatures.

## Impact Assessment

**Production code: zero changes required.** Every production call site uses the single-version shorthand `defineTable(schema)` or `defineKv(schema)`, which is unchanged. The `.version()` builder is only used in test files.

**Test files: mechanical transformation.** Every `.version()` chain becomes variadic args. The migration functions are identical.

## Open Questions

1. **Should we also update the `@example` in `workspace-api` skill documentation?**
   - Recommendation: Yes, update `.agents/skills/workspace-api/SKILL.md` examples in the same PR.

2. **Should the variadic overload's return type be a named type or inline?**
   - Option A: Inline `{ migrate(fn): TableDefinitionWithDocBuilder<...> }`: fewer types to maintain.
   - Option B: Named `TableMigratable<TVersions>`: more discoverable in IDE.
   - Recommendation: Start with inline (Option A). Extract to named type only if the inline becomes unwieldy.

## Success Criteria

- [ ] `TableBuilder` and `KvBuilder` types no longer exist
- [ ] Zero-arg `defineTable()` and `defineKv()` overloads removed
- [ ] Single-arg shorthand works identically (no changes to production code)
- [ ] Multi-version `defineTable(s1, s2).migrate(fn)` works with correct type inference
- [ ] Multi-version `defineKv(s1, s2).migrate(fn)` works with correct type inference
- [ ] `.withDocument()` chaining works after both shorthand and `.migrate()`
- [ ] All existing tests pass (after mechanical transformation)
- [ ] `bun run typecheck` passes
- [ ] `bun run lint` passes

## References

- `packages/epicenter/src/workspace/define-table.ts`: `defineTable` implementation + `TableBuilder` type
- `packages/epicenter/src/workspace/define-kv.ts`: `defineKv` implementation + `KvBuilder` type
- `packages/epicenter/src/workspace/types.ts`: `TableDefinition`, `KvDefinition`, `LastSchema`, `BaseRow`
- `packages/epicenter/src/workspace/schema-union.ts`: `createUnionSchema` (unchanged)
- `packages/epicenter/src/workspace/define-table.test.ts`: primary test file for multi-version
- `packages/epicenter/src/workspace/define-kv.test.ts`: primary test file for multi-version KV

## Review

**Completed**: 2026-03-03
**Branch**: `braden-w/variadic-define-table-kv`

### Summary

Replaced `.version()` builder chaining with variadic rest parameters on both `defineTable` and `defineKv`. Removed `TableBuilder` and `KvBuilder` types entirely. All 6 test files with `.version()` chains were mechanically transformed. `create-workspace.test.ts` needed no changes (already single-arg shorthand only). Zero production code changes required.

### Deviations from Spec

- Added zero-arg runtime guard (`arguments.length === 0` throw) to both `defineTable` and `defineKv`: the original builder threw lazily in `.migrate()`, but with the new API a zero-arg call would silently return a migrate-able object with no schemas.

### Follow-up Work

- Open question 1 (update `workspace-api` skill docs) deferred: not blocking.

---

## Addendum: JSON Serializability Constraint

**Date:** 2026-03-03
**Status:** Implemented
**Prerequisite:** `wellcrafted@^0.34.0` (adds `wellcrafted/json` export with `JsonValue` and `JsonObject`)

### Motivation

Table rows and KV values are stored in Yjs CRDTs, which serialize to JSON. Nothing currently prevents a schema from declaring non-JSON-safe types (e.g., `Date`, `Map`, `Set`, `undefined`, functions). This creates a class of bugs where data passes TypeScript checks but corrupts silently at runtime during serialization.

### Approach

Constrain the schema types at the `defineTable` and `defineKv` call sites so that:

1. **`defineTable` schemas** must output types extending `BaseRow & JsonObject`: i.e., `{ id: string; _v: number }` plus all other fields must be `JsonValue` (string, number, boolean, null, or nested arrays/objects of the same).
2. **`defineKv` schemas** must output types extending `JsonValue`: KV values can be primitives, arrays, or objects, but must be JSON-serializable.

### Types from `wellcrafted/json`

```typescript
type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };
type JsonObject = Record<string, JsonValue>;
```

### Changes

#### 1. `types.ts`: `BaseRow` intersection

```typescript
import type { JsonObject } from 'wellcrafted/json';
export type { JsonObject, JsonValue } from 'wellcrafted/json';

// Before
export type BaseRow = { id: string; _v: number };

// After: all fields must be JsonValue
export type BaseRow = { id: string; _v: number } & JsonObject;
```

This propagates automatically. Every constraint using `CombinedStandardSchema<BaseRow>` (in `defineTable`, `TableDefinitionWithDocBuilder`, `TableDefinition`) now requires JSON-safe output types. No changes needed in `define-table.ts`: it already constrains via `BaseRow`.

#### 2. `define-kv.ts`: `JsonValue` constraint

```typescript
import type { JsonValue } from 'wellcrafted/json';

// Before
export function defineKv<TSchema extends CombinedStandardSchema>(schema: TSchema): ...
export function defineKv<const TVersions extends [CombinedStandardSchema, ...]>(...versions: TVersions): ...

// After
export function defineKv<TSchema extends CombinedStandardSchema<JsonValue>>(schema: TSchema): ...
export function defineKv<const TVersions extends [CombinedStandardSchema<JsonValue>, ...]>(...versions: TVersions): ...
```

#### 3. `index.ts`: Re-export `JsonValue` and `JsonObject`

```typescript
export type { JsonObject, JsonValue } from './types.js';
```

#### 4. `package.json`: Bump wellcrafted

```json
"wellcrafted": "^0.34.0"
```

### What this rejects (correctly)

```typescript
// ❌ Date is not JsonValue
defineTable(type({ id: 'string', _v: '1', createdAt: 'Date' }));

// ❌ undefined is not JsonValue (optional fields produce T | undefined)
defineTable(type({ id: 'string', _v: '1', 'name?': 'string' }));

// ❌ Map is not JsonValue
defineKv(type('Map<string, string>'));
```

### What this accepts (correctly)

```typescript
// ✅ All primitives + nested objects/arrays
defineTable(type({ id: 'string', _v: '1', title: 'string', views: 'number', active: 'boolean' }));

// ✅ Nested JSON objects
defineTable(type({ id: 'string', _v: '1', metadata: '{ tags: string[], priority: number }' }));

// ✅ KV with primitive value
defineKv(type('string'));

// ✅ KV with nullable object
defineKv(type('{ mode: string, fontSize: number } | null'));
```

### Edge Case: Optional Fields

`{ name?: string }` produces `string | undefined` in TypeScript's output type. `undefined` is not a `JsonValue`. This is **intentionally rejected**: Yjs stores can't represent `undefined` (JSON has no `undefined`). Use `null` instead: `{ name: 'string | null' }`.

### Impact Assessment

**Production code**: All existing schemas use JSON-safe types (strings, numbers, booleans, nested objects). No breakage expected.

**Test files**: May need minor updates if any test schemas use non-JSON types. Most test schemas use `string`, `number`, `boolean`: all `JsonValue`.

### Implementation Plan

#### Wave 4: JSON Serializability Constraint

- [x] **4.1** Bump `wellcrafted` to `^0.34.0` in root `package.json` catalog and run `bun install`
- [x] **4.2** Update `types.ts`: import `JsonObject` from `wellcrafted/json`, re-export `JsonValue` and `JsonObject`, intersect `BaseRow` with `JsonObject`
- [x] **4.3** Update `define-kv.ts`: import `JsonValue` from `wellcrafted/json`, constrain all overloads to `CombinedStandardSchema<JsonValue>`
- [x] **4.4** Update `index.ts`: add `JsonObject` and `JsonValue` to the re-exports from `types.js`

#### Wave 4.5: Fix `createTableHelper` Variance Issue

The `& JsonObject` intersection on `BaseRow` exposed a TypeScript variance issue in `createTableHelper`. The generic `TVersions extends readonly CombinedStandardSchema<BaseRow>[]` forced the `migrate` function into a contravariant position: `(row: SpecificRow) => SpecificRow` can't satisfy `(row: BaseRow) => BaseRow`. Fixed by making the generic operate on the full definition type instead:

```typescript
// Before: variance-unfriendly
function createTableHelper<TVersions extends readonly CombinedStandardSchema<BaseRow>[]>(
  ykv: YKeyValueLww<unknown>,
  definition: TableDefinition<TVersions>,
): TableHelper<InferTableRow<TableDefinition<TVersions>>>

// After: variance-friendly
function createTableHelper<TTableDefinition extends TableDefinition<any>>(
  ykv: YKeyValueLww<unknown>,
  definition: TTableDefinition,
): TableHelper<InferTableRow<TTableDefinition>>
```

- [x] **4.5.1** Refactor `createTableHelper` generic from `TVersions` to `TTableDefinition extends TableDefinition<any>`
- [x] **4.5.2** Remove `as const` assertions from migrate return values in all test files (no longer needed)

#### Wave 5: Verify

- [x] **5.1** Run `bun run typecheck`: confirm no new type errors from the constraint
- [x] **5.2** Run `bun test`: confirm all tests still pass
- [x] **5.3** Run `bun run lint`: fix any issues
