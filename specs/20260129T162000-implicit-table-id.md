# Implicit Table ID

**Date**: 2026-01-29
**Status**: Draft
**Author**: AI-assisted

## Overview

Make table IDs implicit so every table automatically has an `id: string` field without requiring `id()` in the fields array. This removes boilerplate and unifies `Field` and `KvField` types.

## Motivation

### Current State

```typescript
// Every table requires explicit id()
table('posts', {
  fields: [id(), text('title'), boolean('published')]
})

table('users', {
  fields: [id(), text('name'), text('email')]
})

// KvField exists solely to exclude IdField
type Field = IdField | TextField | SelectField | BooleanField | ...
type KvField = Exclude<Field, IdField>
```

This creates problems:

1. **Boilerplate**: Every table definition starts with `id()`. 200+ usages in codebase, zero variation.
2. **Forgettable**: Nothing prevents defining a table without `id()`. The type allows it; convention requires it.
3. **Type divergence**: `KvField` exists only because `IdField` is in the union. Two types for essentially the same concept.

### Desired State

```typescript
// ID is implicit
table('posts', {
  fields: [text('title'), boolean('published')]
})
// Row type: { id: string, title: string, published: boolean }

// Field and KvField unify
type Field = TextField | SelectField | BooleanField | ...
// KvField = Field (same type, alias for documentation)
```

## Research Findings

### id() Usage Patterns

Searched 200+ usages of `id()` across the codebase.

| Pattern                    | Occurrences | Example                         |
| -------------------------- | ----------- | ------------------------------- |
| `id()` with no arguments   | 200+        | `fields: [id(), text('title')]` |
| `id('customId')`           | 0           | Never used                      |
| `id('id', { name: 'ID' })` | 1           | Metadata only, still uses 'id'  |

**Key finding**: Nobody uses custom ID field names. The `id('userId')` example in JSDoc is purely illustrative.

**Implication**: Safe to make 'id' implicit and reserved. No migration pain from custom ID names.

### TypeScript Reserved Name Patterns

Researched how to reject specific string literals at compile time.

| Pattern                      | Error Clarity                                | Type Checker Cost | Used By                  |
| ---------------------------- | -------------------------------------------- | ----------------- | ------------------------ |
| `T extends 'id' ? never : T` | Poor ("not assignable to never")             | Low               | Common (broken)          |
| Object Error Type            | Excellent (`SchemaError<"CODE", "message">`) | Low               | Drizzle ORM              |
| Template Literal             | Poor                                         | Medium            | TanStack Router          |
| `[T] extends [never]`        | N/A (detection, not rejection)               | Low               | XState, TypeScript tests |

**Key finding**: TypeScript shows the EXPECTED TYPE in error messages. If expected type is `never`, you get useless errors. If expected type is an object containing your message, you get readable errors.

**Implication**: Return an object type (not `never`) for invalid field IDs so the message appears in hover.

```typescript
// ❌ BROKEN: Returns never
type ValidFieldId<K> = K extends 'id' ? never : K;
// Error: "not assignable to type 'never'"

// ✅ CORRECT: Returns object type with message
type SchemaError<Code extends string, Msg extends string> = {
	readonly __errorCode: Code;
	readonly __message: Msg;
};
type ValidFieldId<K> = K extends 'id'
	? SchemaError<'RESERVED', `"${K}" is reserved`>
	: K;
// Error: "not assignable to type 'SchemaError<"RESERVED", "\"id\" is reserved">'"
```

### Existing Constraints

| Constraint                   | Location          | Enforced               |
| ---------------------------- | ----------------- | ---------------------- |
| Field IDs cannot contain `:` | `keys.ts`         | Runtime                |
| No duplicate field IDs       | `fields-store.ts` | Runtime (dynamic only) |
| Reserved names               | None              | Not enforced           |

**Key finding**: No compile-time validation exists for field names.

**Implication**: This change adds the first compile-time field name constraint.

## Design Decisions

| Decision                   | Choice                  | Rationale                                                       |
| -------------------------- | ----------------------- | --------------------------------------------------------------- |
| Make ID implicit           | Yes                     | 100% of tables use `id()` with default name                     |
| Reserve 'id' as field name | Yes, compile-time error | Prevents shadowing; clear error message                         |
| Support custom ID names    | No                      | Zero usage in codebase; adds type complexity                    |
| Support composite keys     | No                      | CRDTs need stable synthetic IDs; use unique constraints instead |
| Include ID in Y.Map row    | Yes                     | Rows need to be self-contained when passed around               |
| Unify Field/KvField        | Yes                     | Distinction only existed because of IdField                     |
| Error message approach     | Object Error Type       | Return object type (not `never`) so TypeScript shows message    |

## Architecture

```
BEFORE                                  AFTER
──────                                  ─────

Field Union                             Field Union
┌─────────────────────┐                 ┌─────────────────────┐
│ IdField             │                 │ TextField           │
│ TextField           │                 │ SelectField         │
│ SelectField         │      ───►       │ BooleanField        │
│ BooleanField        │                 │ ...                 │
│ ...                 │                 └─────────────────────┘
└─────────────────────┘                        │
        │                                      │ (same type)
        │ Exclude<Field, IdField>              ▼
        ▼                               ┌─────────────────────┐
┌─────────────────────┐                 │ KvField (alias)     │
│ KvField             │                 └─────────────────────┘
└─────────────────────┘


Table Row Type Derivation
─────────────────────────

table('posts', { fields: [text('title')] })
                    │
                    ▼
        ┌───────────────────────┐
        │ TableDefinition       │
        │ ├── id: 'posts'       │
        │ └── fields: [...]     │
        └───────────────────────┘
                    │
                    ▼ RowOf<T> injects id
        ┌───────────────────────┐
        │ { id: string }        │  ◄── Always present
        │ & FieldsToRow<Fields> │
        └───────────────────────┘
                    │
                    ▼
        { id: string, title: string }
```

## Implementation Plan

### Phase 1: Type Infrastructure

- [ ] **1.1** Add `FieldIdError<T>` branded error type to `types.ts`
- [ ] **1.2** Add `ValidFieldId<T>` type that returns error for 'id'
- [ ] **1.3** Update all field factories to use `ValidFieldId<K>` constraint
- [ ] **1.4** Verify compile-time error for `text({ id: 'id' })`

### Phase 2: Remove IdField from Public API

- [ ] **2.1** Remove `id()` export from `factories.ts`
- [ ] **2.2** Remove `IdField` from `Field` union
- [ ] **2.3** Make `KvField` an alias for `Field`
- [ ] **2.4** Update `TableDefinition` to inject ID into row type

### Phase 3: Update Consumers

- [ ] **3.1** Remove `id()` calls from all table definitions
- [ ] **3.2** Update Drizzle converter to unconditionally inject ID column
- [ ] **3.3** Update table helper to always include ID in row maps
- [ ] **3.4** Update tests

### Phase 4: Cleanup

- [ ] **4.1** Deprecate or remove `KvField` type (or keep as documentation alias)
- [ ] **4.2** Update JSDoc examples throughout codebase
- [ ] **4.3** Add runtime validation as belt-and-suspenders

## Edge Cases

### Reserved Name Collision

1. User writes `text({ id: 'id' })`
2. Type system rejects with `FieldIdError<'"id" is reserved...'>`
3. User sees error in IDE before running code

### Custom ID Names Requested

1. User wants `_id` for MongoDB compatibility
2. Response: Handle at serialization boundary, not schema level
3. Alternative: `serialize: (row) => ({ _id: row.id, ...row })`

### Composite Keys Requested

1. User wants `[userId, postId]` as primary key
2. Response: CRDTs need stable synthetic IDs for merge semantics
3. Alternative: Use synthetic ID + unique constraint on `[userId, postId]`

### Tables Without ID (Join Tables)

1. Some patterns use ID-less join tables
2. With implicit ID, they get an ID anyway
3. This is fine; the ID enables CRDT operations

## Open Questions

1. **Should `KvField` be removed or kept as alias?**
   - Options: (a) Remove entirely, (b) Keep as `type KvField = Field` for documentation
   - Recommendation: Keep as alias; helps communicate "fields usable in KV stores"

2. **Runtime validation in addition to compile-time?**
   - Options: (a) Compile-time only, (b) Both
   - Recommendation: Both; JavaScript users don't get compile-time checks

3. **Extend reserved names beyond 'id'?**
   - Options: (a) Just 'id', (b) Also reserve `_id`, `createdAt`, `updatedAt`
   - Recommendation: Just 'id' for now; expand later if needed

## Success Criteria

- [ ] `text({ id: 'id' })` produces compile-time error with clear message
- [ ] All existing table definitions work after removing `id()` calls
- [ ] Row types include `id: string` automatically
- [ ] `Field` and `KvField` are the same type (or alias)
- [ ] All 788+ tests pass
- [ ] TypeScript compiles without errors

## References

- `packages/epicenter/src/core/schema/fields/types.ts` - Field type definitions
- `packages/epicenter/src/core/schema/fields/factories.ts` - Field factory functions
- `packages/epicenter/src/extensions/sqlite/to-drizzle.ts` - Drizzle column conversion
- `packages/epicenter/src/core/tables/table-helper.ts` - Row map operations
- `specs/20260129T143000-workspace-tables-kv-to-array.md` - Related array refactor
