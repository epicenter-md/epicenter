# Standardize TableHelper Type Definitions

**Date**: 2026-02-13
**Status**: Complete

## Overview

Standardize how `TableHelper` is typed across the static and dynamic workspace APIs. Both should use a hand-written interface as the primary export with JSDoc, rather than the dynamic API's current `ReturnType<typeof factory>` approach.

## Motivation

### Current State

The two APIs define `TableHelper` in fundamentally different ways:

**Static API**: hand-written interface (`src/static/types.ts`):

```typescript
export type TableHelper<TRow extends { id: string }> = {
	/** Parse unknown input against the table schema. */
	parse(id: string, input: unknown): RowResult<TRow>;
	/** Set a row (insert or replace). */
	set(row: TRow): void;
	/** Get a row by ID. */
	get(id: string): GetResult<TRow>;
	// ... every method explicitly declared with JSDoc
};
```

The factory annotates its return type:

```typescript
export function createTableHelper<TVersions extends readonly StandardSchemaV1[]>(
  ykv: YKeyValueLww<unknown>,
  definition: TableDefinition<TVersions>,
): TableHelper<InferTableRow<TableDefinition<TVersions>>> {
```

**Dynamic API**: derived from factory return type (`src/dynamic/tables/table-helper.ts`):

```typescript
export type TableHelper<
	TId extends string = string,
	TFields extends readonly Field[] = readonly Field[],
> = ReturnType<typeof createTableHelper<TableDefinition<TId, TFields>>>;
```

The factory has no return type annotation: TypeScript infers everything.

This creates problems:

1. **IDE hover inconsistency**: Hovering `TableHelper` in the dynamic API shows an inlined blob of every property. In the static API, you see `TableHelper<TRow>` with jump-to-definition.
2. **JSDoc lives in different places**: Static has docs on the type contract. Dynamic has docs on the factory's return object literal: they don't surface to the type.
3. **Accidental API surface expansion**: Adding an internal helper to the dynamic factory silently adds it to the public type. The static API forces deliberate additions to the interface.
4. **Dead generic parameter**: Dynamic's `TableHelper<TId, TFields>` carries a `TId` generic that is **always `string`** at every call site. It exists only because it's threaded through `TableDefinition` for `ReturnType` derivation: not because consumers need it.

### Desired State

Both APIs use a hand-written `TableHelper<TRow>` type as the primary export. The factory function annotates its return type against this interface. TypeScript enforces the contract at the factory level. No secondary `ReturnType` alias needed.

## Research Findings

### How TId is Used in Dynamic

Searched every usage of `TableHelper<` in `src/dynamic/`:

| File                   | Usage                                           | TId value |
| ---------------------- | ----------------------------------------------- | --------- |
| `create-tables.ts:46`  | `TableHelper<string, TableById<...>['fields']>` | `string`  |
| `create-tables.ts:157` | `TableHelper<string, ...>` (internal map type)  | `string`  |
| `create-tables.ts:187` | `TableHelper<string, ...>` (get method return)  | `string`  |

**Key finding**: TId is always `string`. It's never narrowed to a specific table name at the `TableHelper` level. The table name narrowing happens at the `TablesFunction.get()` level (which constrains the key, not the helper).

**Implication**: TId can be removed from `TableHelper` entirely with zero impact on consumers.

### How the Two APIs Differ in Method Surface

| Capability     | Dynamic              | Static                |
| -------------- | -------------------- | --------------------- |
| Insert/replace | `upsert(row)`        | `set(row)`            |
| Batch insert   | `upsertMany(rows)`   | `batch(fn)` (general) |
| Partial update | `update(partialRow)` | `update(id, partial)` |
| Batch update   | `updateMany(rows)`   | via `batch(fn)`       |
| Get by ID      | `get(id: Id)`        | `get(id: string)`     |
| Get all        | `getAll()`           | `getAll()`            |
| Get valid      | `getAllValid()`      | `getAllValid()`       |
| Get invalid    | `getAllInvalid()`    | `getAllInvalid()`     |
| Has            | `has(id: Id)`        | `has(id: string)`     |
| Count          | `count()`            | `count()`             |
| Delete         | `delete(id: Id)`     | `delete(id: string)`  |
| Batch delete   | `deleteMany(ids)`    | via `batch(fn)`       |
| Clear          | `clear()`            | `clear()`             |
| Filter         | `filter(pred)`       | `filter(pred)`        |
| Find           | `find(pred)`         | `find(pred)`          |
| Observe        | `observe(cb)`        | `observe(cb)`         |
| Parse          | - | `parse(id, input)`    |
| Batch tx       | - | `batch(fn)`           |
| Infer helper   | `inferRow` property  | - |
| Table ID       | `id` property        | - |

**Key finding**: The method surfaces aren't identical. The dynamic API has richer batch operations (`upsertMany`, `updateMany`, `deleteMany`) while the static API has a general `batch()` transaction and `parse()`. They share a common core (~12 methods) but diverge intentionally based on their domains.

**Implication**: This is NOT about creating a single shared `TableHelper` type. It's about both APIs following the same _pattern_: hand-written interface as contract, factory annotates against it.

### Whether a Secondary `ReturnType` Alias is Needed

Three potential uses for a `ReturnType`-based alias:

| Use Case                                 | Alternative                                                           | Verdict                               |
| ---------------------------------------- | --------------------------------------------------------------------- | ------------------------------------- |
| Verify factory satisfies contract        | Annotate return type directly: `): TableHelper<TRow>`                 | Annotation is simpler and more direct |
| Power users who want exact inferred type | They can write `ReturnType<typeof createTableHelper<...>>` themselves | Not worth a dedicated export          |
| Internal type tests                      | Same: inline `ReturnType` in test files                              | Not worth polluting the public API    |

**Key finding**: When the factory function annotates its return type as `TableHelper<TRow>`, TypeScript already enforces 1:1 structural compliance. Adding a property to the factory that isn't in the interface → type error. Missing a property from the interface → type error. The annotation IS the verification.

**Implication**: No secondary `ReturnType` alias. It's noise.

## Design Decisions

| Decision                     | Choice                                    | Rationale                                                                                                                          |
| ---------------------------- | ----------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| Primary type pattern         | Hand-written interface with JSDoc         | Deliberate API surface, better IDE experience, docs live on the contract                                                           |
| Secondary `ReturnType` alias | Don't create one                          | Factory return type annotation already enforces the contract. No use case justifies the extra export.                              |
| Dynamic `TId` generic        | Remove                                    | Dead parameter: always `string` at every call site                                                                                |
| Generic parameter style      | `TableHelper<TRow>` for both              | Both APIs compute the row type externally and pass it in. Field-level granularity belongs on `TableDefinition`, not `TableHelper`. |
| Shared type?                 | No: each API keeps its own `TableHelper` | Method surfaces differ intentionally. Forcing a shared type would either bloat the interface or require conditional members.       |
| Where types live             | Each API's `types.ts`                     | Already the pattern in static. Dynamic should centralize result types and `TableHelper` in a types file too.                       |

## Architecture

```
CURRENT (Dynamic)                         PROPOSED (Both APIs)
═══════════════════                       ═══════════════════════

createTableHelper()                       types.ts
  └── returns { ... }                       └── TableHelper<TRow> = { ... }  ← hand-written, JSDoc'd
        │                                         ▲
        ▼                                         │ annotates return type
  TableHelper<TId, TFields>              createTableHelper()
  = ReturnType<typeof factory>              └── ): TableHelper<TRow> { ... }
                                                     ▲
                                                     │ TypeScript enforces
                                                     │ structural match
```

## Implementation Plan

### Phase 0: Merge `Row` and `TableRow` (DONE)

Prerequisite work: `Row` and `TableRow` were two types that should have been one. Every table row has an `id`, so `Row` should always guarantee `{ id: Id }`.

- [x] **0.1** Merge `Row` and `TableRow`: `Row<TFields>` now includes `& BaseRow`, guaranteeing `{ id: Id }` even when `TFields` is a bare generic.
- [x] **0.2** Delete `TableRow` type from `types.ts` and remove from all exports.
- [x] **0.3** Rewrite `PartialRow` as `Partial<Row<TFields>> & BaseRow`: derives entirely from `Row`, no manual `{ id: Id }` or `Omit`.
- [x] **0.4** Replace all `TableRow` usages across the codebase:
  - `dynamic/tables/create-tables.ts`: `TablesFunction` and internal map types
  - `dynamic/tables/table-helper.ts`: factory return type
  - `extensions/markdown/markdown.ts`: all type annotations and casts
  - `extensions/sqlite/sqlite.ts`: row cast (simplified, no longer needs `& { id: Id }`)
  - `dynamic/schema/index.ts`: re-exports
- [x] **0.5** Update `BaseRow` JSDoc in `shared/id.ts`: remove stale `TableRow` references.
- [x] **0.6** Clean up `RowWithId` alias in `extensions/markdown/configs.ts`: keep `& { id: string }` for serializer boundary (markdown files work with plain string ids, not branded `Id`).
- [x] **0.7** Type-check passes: zero new errors introduced.

### Phase 1: Dynamic API: Hand-Write TableHelper Type (DONE in prior commits)

- [x] **1.1** Create the hand-written `TableHelper<TRow>` type in `src/dynamic/tables/table-helper.ts`, mirroring every method currently on the factory's return object. Include full JSDoc on each method.
- [x] **1.2** Annotate `createTableHelper()`'s return type as `TableHelper<Row<TTableDef['fields']>>`.
- [x] **1.3** Remove the old `ReturnType`-based `TableHelper<TId, TFields>` alias.
- [x] **1.4** Update `create-tables.ts`: the `TablesFunction` type and internal map type reference `TableHelper<Row<...>>`.
- [x] **1.5** Update `src/dynamic/index.ts` exports: export `TableHelper` from the new location.
- [x] **1.6** Verify no downstream consumers reference `TId` on `TableHelper`.

### Phase 2: Static API: Use `BaseRow` Instead of `{ id: string }` (DROPPED)

> **Decision (2026-02-14):** Phase 2 is dropped. The static API intentionally uses plain `string` ids while the dynamic API uses branded `Id`. `BaseRow` is `{ id: Id }` where `Id` is a branded string: adopting it in the static API would propagate branded ids through the entire static type surface, which is a separate design decision, not a standardization gap. The spec's core goal: "both APIs follow the same pattern (hand-written interface as contract, factory annotates against it)": is fully achieved without this phase.

- [x] ~~**2.1** Change `TableHelper<TRow extends { id: string }>` to `TableHelper<TRow extends BaseRow>`~~: Dropped: intentional API divergence
- [x] ~~**2.2** Update `createTableHelper()` to use `BaseRow`~~: Dropped
- [x] ~~**2.3** Update `InferTableRow` usage sites~~: Dropped
- [x] **2.4** Audit static `TableHelper` JSDoc for completeness.: Already thorough (every method has full JSDoc)
- [x] **2.5** Type-check passes.

### Phase 3: Clean Up Result Types (DONE)

- [x] **3.1** Audit that result types (`GetResult`, `RowResult`, `ValidRowResult`, `InvalidRowResult`, `NotFoundResult`, etc.) follow the same pattern: hand-written, standalone, JSDoc'd. Both APIs already do this: verified 2026-02-14.

## Edge Cases

### Dynamic TableHelper Has an `id` Property

The dynamic `TableHelper` exposes `id: tableId` (the table's name). The static one doesn't. When writing the hand-written interface, this property needs to be on the dynamic `TableHelper<TRow>` but not the static one. This is fine. They're separate types.

### Dynamic Uses Branded `Id`, Static Uses `string` (Targeted for Phase 2)

The dynamic API uses `Id` (branded string) for row identifiers. The static API currently uses plain `string`. Phase 2 will change the static API to use `BaseRow` (which contains branded `Id`), aligning both APIs on the same id type.

### `inferRow` Property on Dynamic

The dynamic `TableHelper` has `inferRow: null as unknown as TRow` for type inference. This should be included in the hand-written interface.

## Open Questions

1. **Should we also standardize method names across the two APIs?**
   - Dynamic uses `upsert`/`upsertMany`, static uses `set`.
   - Dynamic uses `delete(id: Id)`, static uses `delete(id: string)`.
   - **Recommendation**: Out of scope. The naming differences reflect domain intent (dynamic has cell-level merging semantics where "upsert" is accurate; static has row-level replacement where "set" is accurate). Standardizing types is the goal here, not standardizing API surfaces.

2. **Should we extract a `BaseTableHelper` with the shared ~12 methods?**
   - Could create a base type with `get`, `getAll`, `getAllValid`, `getAllInvalid`, `has`, `count`, `delete`, `clear`, `filter`, `find`, `observe`, then extend per-API.
   - **Recommendation**: Not now. Premature abstraction. The two types are small enough (~15-20 methods each) that the duplication is manageable and keeping them independent avoids coupling. Revisit if a third table variant appears.

## Success Criteria

- [x] `Row` always includes `& BaseRow`: no separate `TableRow` type
- [x] `PartialRow` derives from `Row`: `Partial<Row<TFields>> & BaseRow`
- [x] Dynamic `TableHelper` is a hand-written type with JSDoc on every method
- [x] Dynamic `createTableHelper()` annotates its return type as `TableHelper<Row<...>>`
- [x] No `ReturnType<typeof createTableHelper>` alias exists
- [x] `TId` generic parameter is removed from `TableHelper`
- [x] Both APIs' `TableHelper` types use `<TRow>` as their single generic parameter
- [x] ~~Static `TableHelper` uses `BaseRow` instead of `{ id: string }`~~: Dropped: intentional API divergence (static uses plain `string`, dynamic uses branded `Id`)
- [x] Static `TableHelper` JSDoc is audited for completeness
- [x] All existing tests pass
- [x] Type-check passes (zero new errors)

## References

- `packages/epicenter/src/dynamic/tables/table-helper.ts`: Dynamic factory + current `ReturnType` alias
- `packages/epicenter/src/dynamic/tables/create-tables.ts`: Dynamic collection type (`TablesFunction`)
- `packages/epicenter/src/static/types.ts`: Static hand-written `TableHelper<TRow>` (the reference pattern)
- `packages/epicenter/src/static/table-helper.ts`: Static factory with return type annotation
- `packages/epicenter/src/static/create-tables.ts`: Static collection type (`TablesHelper`)
