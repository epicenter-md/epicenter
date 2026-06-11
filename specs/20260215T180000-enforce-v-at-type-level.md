# Enforce `_v: number` at the Type Level

**Date**: 2026-02-15
**Status**: Completed
**Depends on**: `specs/20260215T174700-symmetric-v-all-tables.md` (completed)

## Goal

Change `CombinedStandardSchema<{ id: string }>` → `CombinedStandardSchema<{ id: string; _v: number }>` in all table-related generics. This makes `_v` **enforced by the type system**, not just recommended. Tables without `_v` become a compile error.

Remove all references to "symmetric", "asymmetric", and "field presence" patterns from JSDoc, docs, and skills. There's only one way now.

KV stores are **unchanged** (no `_v` enforcement).

## What Changes

The constraint `{ id: string }` appears in exactly **6 locations** across 3 files:

### `define-table.ts` (4 occurrences)

```typescript
// Line 58: TableBuilder generic
type TableBuilder<TVersions extends CombinedStandardSchema<{ id: string }>[]>
//                                                          ^^^^^^^^^^^^^^
//                                                          → { id: string; _v: number }

// Line 64: .version() method constraint
version<TSchema extends CombinedStandardSchema<{ id: string }>>
//                                              ^^^^^^^^^^^^^^
//                                              → { id: string; _v: number }

// Line 93: Shorthand overload
TSchema extends CombinedStandardSchema<{ id: string }>
//                                      ^^^^^^^^^^^^^^
//                                      → { id: string; _v: number }

// Line 136: Implementation signature
TSchema extends CombinedStandardSchema<{ id: string }>
//                                      ^^^^^^^^^^^^^^
//                                      → { id: string; _v: number }
```

### `types.ts` (1 occurrence)

```typescript
// Line 106: TableDefinition generic
TVersions extends readonly CombinedStandardSchema<{ id: string }>[]
//                                                 ^^^^^^^^^^^^^^
//                                                 → { id: string; _v: number }
```

### `table-helper.ts` (1 occurrence)

```typescript
// Line 28: createTableHelper generic
TVersions extends readonly CombinedStandardSchema<{ id: string }>[]
//                                                 ^^^^^^^^^^^^^^
//                                                 → { id: string; _v: number }
```

### `types.ts`: `TableHelper` constraint (1 occurrence, optional)

```typescript
// Line 186: TableHelper row constraint
export type TableHelper<TRow extends { id: string }> = {
//                                    ^^^^^^^^^^^^^^
//                                    → { id: string; _v: number }
```

This is technically optional since TRow is already narrowed by the time it reaches TableHelper, but adds consistency.

**Total: 7 type-level changes across 3 files.**

## What Also Changes (Documentation / Cleanup)

### JSDoc in source files (5 files)

Remove all "asymmetric \_v", "field presence", and "symmetric \_v" language. There's one pattern now: `_v` is always required. No need to label it.

| File               | What to change                                                                                       |
| ------------------ | ---------------------------------------------------------------------------------------------------- |
| `define-table.ts`  | Remove bullet list of patterns. Just say "all schemas must include `_v`". Remove asymmetric example. |
| `define-kv.ts`     | KV unchanged: keep current flexibility docs                                                         |
| `index.ts`         | Remove asymmetric pattern from module docs                                                           |
| `create-tables.ts` | Simplify JSDoc                                                                                       |
| `create-kv.ts`     | No changes                                                                                           |

### Skill file (1 file)

| File                                           | What to change                                                                                                                                             |
| ---------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `.agents/skills/static-workspace-api/SKILL.md` | Remove entire comparison table of patterns. Remove asymmetric/field-presence sections. Update to say `_v` is enforced. Change `'"1"'` → `'1'` in examples. |

### Articles / docs (3 files: content updates)

| File                                                            | What to change                                                                                |
| --------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| `docs/articles/why-explicit-version-discriminants.md`           | Already mostly aligned (it argues for symmetric). Update any remaining asymmetric references. |
| `docs/articles/versioned-schemas-migrate-on-read.md`            | Remove KV field-presence section for tables. Table examples should all use `_v`.              |
| `docs/articles/schema-granularity-matches-write-granularity.md` | Minor: remove KV field-presence comment if it implies tables can skip `_v`.                  |

### Specs (informational: no changes needed, historical record)

- `specs/20260214T225000-version-discriminant-tables-only.md`: Keep as-is (historical)
- `specs/20260125T120000-versioned-table-kv-specification.md`: Keep as-is (historical)

### Tests (3 files)

The previous commit already converted all tests to use `_v`. But some tests still test the "asymmetric" and "field presence" patterns. Those patterns are now **impossible** at the type level: passing a schema without `_v` to `defineTable()` will be a compile error.

| File                    | What to change                                                                                                                                   |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| `define-table.test.ts`  | Remove or merge tests that tested asymmetric/field-presence (they're already converted to use `_v`, so mostly just rename/simplify descriptions) |
| `create-tables.test.ts` | Same: simplify test descriptions                                                                                                                |
| `define-kv.test.ts`     | No changes (KV keeps flexibility)                                                                                                                |

## What's NOT Changing

- **KV stores** (`define-kv.ts`, `KvDefinition`, `KvBuilder`): No `_v` enforcement. KV keeps its current flexibility.
- **Dynamic API** (`src/dynamic/`): Completely separate type system. `TableDefinition` in `dynamic/schema/fields/types.ts` is a different type.
- **`createUnionSchema`**: No changes: it just combines whatever schemas it receives.
- **Runtime behavior**: Zero changes. The `defineTable()` implementation doesn't check for `_v` at runtime. This is purely a compile-time enforcement.

## Execution Plan

- [x] **Task 1**: Change 7 generic constraints (3 files: `define-table.ts`, `types.ts`, `table-helper.ts`): commit `66d272dfc`
- [x] **Task 2**: Update JSDoc in `define-table.ts` and `index.ts`: remove asymmetric/field-presence language: commit `2c9e89c49`
- [x] **Task 3**: Update skill file `.agents/skills/static-workspace-api/SKILL.md`: commit `61100b401`
- [x] **Task 4**: Update 2 articles (versioned-schemas-migrate-on-read, schema-granularity-matches-write-granularity); why-explicit-version-discriminants was already correct: commit `61100b401`
- [x] **Task 5**: Simplify test descriptions in `define-table.test.ts` and `create-tables.test.ts`: commit `4ea70c263`
- [x] **Task 6**: Run tests, verify clean build: 630 tests pass, 0 failures

## Risk Assessment

**Low risk.** All production code already has `_v: '1'` from the previous commit. The only code that would break is code that passes a schema WITHOUT `_v` to `defineTable()`, which is exactly the behavior we want to prevent.

## Review

### Summary

All 6 tasks completed across 4 commits:

1. **`66d272dfc`**: Core type change: `CombinedStandardSchema<{ id: string }>` → `CombinedStandardSchema<{ id: string; _v: number }>` in 7 locations across `define-table.ts`, `types.ts`, `table-helper.ts`, plus `create-tables.ts` internal type.
2. **`2c9e89c49`**: JSDoc cleanup: removed pattern taxonomy from `define-table.ts` and `index.ts` module docs.
3. **`4ea70c263`**: Test descriptions: simplified "symmetric"/"asymmetric" labels to plain version migration descriptions.
4. **`61100b401`**: Skill file + articles: rewrote `SKILL.md` to present one pattern (tables require `_v`), updated 2 articles to say `_v` is required not recommended.

### What changed

- **Tables**: `_v: number` is now enforced at the type level. A schema without `_v` passed to `defineTable()` is a compile error.
- **KV stores**: Unchanged. `defineKv()` keeps `CombinedStandardSchema` without `_v` constraint.
- **Dynamic API**: Unchanged. Separate type system entirely.
- **Documentation**: One pattern, no taxonomy. "Required for tables, optional for KV."

### What didn't change

- Zero runtime behavior changes. This is purely compile-time enforcement.
- No test logic changed: only descriptions were simplified.
- All 630 tests pass with no modifications to assertions.

### Risk assessment (post-implementation)

Low risk confirmed. All production code already had `_v` from the Phase 1 commit (`37a354fe7`). The type-level enforcement only prevents future code from omitting `_v` on tables.
