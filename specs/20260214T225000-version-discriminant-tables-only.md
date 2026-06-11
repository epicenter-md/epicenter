# Version Discriminant Design Decisions

**Date**: 2026-02-14
**Status**: Ready for Implementation
**Branch**: main

## Overview

The `_v` version discriminant field is recommended for versioned schemas. This spec captures all resolved design decisions around `_v` usage, type-level behavior, and the trimmed implementation plan. KV stance is still open (field presence may suffice for simple additive KV, but `_v` works there too).

## Resolved Decisions

| Decision                              | Choice                       | Rationale                                                                                                                                                                       |
| ------------------------------------- | ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| KV stores and `_v`                    | Open                         | Field presence works for simple additive KV. `_v` also works and is fine. No firm stance yet.                                                                                   |
| `as const` on `_v` in migrate returns | Unnecessary                  | TypeScript contextually narrows `_v: 2` to the literal type when the return type expects it. Verified with arktype + `StandardSchemaV1.InferOutput`.                            |
| `_v` property position                | Last property                | Business fields first (`id`, `title`, `views`), system metadata (`_v`) last. Keeps data intent front-and-center.                                                                |
| DX cost of `_v` in every `set()`      | Feature, not cost            | The `_v: 2` in every write is a grep-able marker. When bumping versions, search for `_v: 2` to find every call site that needs updating.                                        |
| `_v` type                             | Number, not string           | `_v: 2` not `_v: '2'`. In arktype: `_v: '2'` (literal number 2). Simpler, more natural for a version counter.                                                                   |
| Architecture pattern                  | Generic parameter constraint | The `extends ? TSchema : never` conditional type is gone on main. The constraint propagates through the generic parameter of `.version()`, not through `TableDefinition` types. |
| `types.ts` changes                    | None needed                  | The `_v` constraint flows through `.version()`'s generic parameter. No changes to `TableDefinition`, `InferTableRow`, or `LastSchema`.                                          |

## Motivation

### Current State

Tables and KV both support versioning through `.version().migrate()`. The `_v` discriminant field is recommended but not enforced. Users can version with or without `_v` in both tables and KV.

```typescript
// Table with _v (recommended)
const posts = defineTable()
	.version(type({ id: 'string', title: 'string', _v: '1' }))
	.version(type({ id: 'string', title: 'string', views: 'number', _v: '2' }))
	.migrate((row) => {
		if (row._v === 1) return { ...row, views: 0, _v: 2 };
		return row;
	});

// KV without _v (field presence works for simple cases)
const theme = defineKv()
	.version(type({ mode: "'light' | 'dark'" }))
	.version(type({ mode: "'light' | 'dark' | 'system'", fontSize: 'number' }))
	.migrate((v) => {
		if (!('fontSize' in v)) return { ...v, fontSize: 14 };
		return v;
	});
```

### KV Without `_v` (Simple Cases)

KV values are typically small objects with 2-5 fields. For simple additive changes, field presence is unambiguous:

```typescript
const theme = defineKv()
	.version(type({ mode: "'light' | 'dark'" }))
	.version(type({ mode: "'light' | 'dark' | 'system'", fontSize: 'number' }))
	.migrate((v) => {
		if (!('fontSize' in v)) return { ...v, fontSize: 14 };
		return v;
	});
```

For simple additive KV, field presence works. But `_v` is also fine for KV, especially if the KV value grows complex or has non-additive changes (removals, renames). No firm stance yet on whether to recommend one over the other for KV.

## `as const` Analysis

The `as const` annotation on `_v` in migrate return values is unnecessary. TypeScript narrows the literal type contextually when the function's return type constrains it.

Given:

```typescript
const posts = defineTable()
	.version(type({ id: 'string', title: 'string', _v: '1' }))
	.version(type({ id: 'string', title: 'string', views: 'number', _v: '2' }))
	.migrate((row) => {
		if (row._v === 1) return { ...row, views: 0, _v: 2 };
		//                                        ^^^^
		//                    TypeScript infers _v: 2 (literal), not number
		return row;
	});
```

The migrate function's return type is `StandardSchemaV1.InferOutput<LastSchema<TVersions>>`, which resolves to a type containing `_v: 2` (the literal). TypeScript's contextual typing narrows `2` to the literal without `as const`.

Verified: arktype's `type({ _v: '2' })` produces `StandardSchemaV1.InferOutput` with `_v: 2` as a literal type, not `number`. The return type constraint makes `as const` redundant.

The existing articles and guide use `as const` throughout. This is harmless but unnecessary; articles will be updated to remove it for clarity.

## `_v` Position Convention

The `_v` field goes last in object literals. Business fields first, system metadata last:

```typescript
// Good: business fields first, _v last
.version(type({ id: 'string', title: 'string', views: 'number', _v: '2' }))

posts.set({ id: '1', title: 'Hello', views: 0, _v: 2 });

// Avoid: _v mixed with business fields
.version(type({ id: 'string', _v: '2', title: 'string', views: 'number' }))
```

This is a convention, not enforced. It keeps the data shape readable: you see what the row IS, then what version it IS.

## DX Impact

Every `set()` call for a versioned table includes `_v`:

```typescript
posts.set({ id: '1', title: 'Hello', views: 0, _v: 2 });
```

This looks like boilerplate, but it's a feature:

1. **Searchable version marker.** When you add v3, search for `_v: 2` to find every write site that needs updating.
2. **Explicit intent.** The developer sees which schema version they're writing against.
3. **No magic.** What you write is exactly what gets stored. No hidden field injection.

The auto-injected `_v` approach (documented in `specs/20260131T110000-auto-injected-version-discriminant-v2.md`) remains deferred.

## Architecture

The `_v` enforcement on tables works through the existing generic constraint on `.version()`:

```typescript
type TableBuilder<
	TVersions extends StandardSchemaWithJSONSchema<{ id: string }>[],
> = {
	version<TSchema extends StandardSchemaWithJSONSchema<{ id: string }>>(
		schema: TSchema,
	): TableBuilder<[...TVersions, TSchema]>;

	migrate(
		fn: (
			row: StandardSchemaV1.InferOutput<TVersions[number]>,
		) => StandardSchemaV1.InferOutput<LastSchema<TVersions>>,
	): TableDefinition<TVersions>;
};
```

The `_v` literal type flows through `TSchema` → `TVersions[number]` → `InferOutput`. When the user defines `_v: '2'` in their arktype schema, the output type has `_v: 2` as a literal. The migrate function's union input (`V1 | V2`) and required output (`V2`) both carry the literal `_v` types, enabling TypeScript discriminated union narrowing.

No changes to `TableDefinition`, `InferTableRow`, `LastSchema`, or any other types in `types.ts` are needed. The constraint propagates through the generic parameter naturally.

## Implementation Plan

### Phase 1: Documentation Updates

- [ ] **1.1** Update `versioned-schemas-migrate-on-read.md`: remove `_v` from KV section, remove `as const`, position `_v` last in all table examples
- [ ] **1.2** Update `schema-granularity-matches-write-granularity.md`: remove `_v` from KV section, remove `as const`, position `_v` last
- [ ] **1.3** Update `20260127T120000-static-workspace-api-guide.md`: align KV examples (no `_v`), remove `as const`, position `_v` last in table examples
- [ ] **1.4** Create article: `_v` design decisions (tables-only, DX tradeoff, `as const` analysis)
- [ ] **1.5** Review and update remaining articles for consistency (`cell-level-crdt-vs-row-level-lww.md`, `api-design-decisions-definetable-definekv.md`, `crdt-schema-evolution-without-migrations.md`)

### Phase 2: Code (if needed)

No code changes needed. The current implementation on `main` already works correctly:

- `defineTable()` accepts any `StandardSchemaWithJSONSchema<{ id: string }>`: users include `_v` in their schema, and the literal type propagates
- `defineKv()` accepts any `StandardSchemaWithJSONSchema`: no `_v` enforcement
- `types.ts` types don't reference `_v` directly: they're generic over the schema types

## Success Criteria

- [ ] All table examples in articles/guide show `_v` as last property
- [ ] All table examples remove `as const` from `_v` values in migrate returns
- [ ] KV examples in articles/guide do NOT include `_v`
- [ ] New article explains the tables-only decision and DX tradeoff
- [ ] No code changes needed (architecture already correct)

## References

- `packages/epicenter/src/static/define-table.ts`: Current `defineTable()` implementation
- `packages/epicenter/src/static/define-kv.ts`: Current `defineKv()` implementation
- `packages/epicenter/src/static/types.ts`: Shared type definitions (no changes needed)
- `specs/20260131T110000-auto-injected-version-discriminant-v2.md`: Deferred auto-injection proposal
- `specs/20260125T120000-versioned-table-kv-specification.md`: Original versioning spec
