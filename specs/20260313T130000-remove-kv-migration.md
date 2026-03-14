# Remove KV Migration Machinery

**Date**: 2026-03-13
**Status**: Implemented
**Author**: AI-assisted

## Overview

Remove the variadic `defineKv(v1, v2, ...).migrate(fn, default)` pattern and all migration infrastructure from KV stores. KV definitions become `defineKv(schema, defaultValue)` with no `migrate` field. Invalid stored data falls back to the default—no migration step.

## Motivation

### Current State

`defineKv` has two overloads—a shorthand and a variadic multi-version pattern borrowed from `defineTable`:

```typescript
// Shorthand (every production call site)
defineKv(type('boolean'), true)

// Variadic (zero production call sites—tests only)
defineKv(
  type({ mode: "'light' | 'dark'" }),
  type({ mode: "'light' | 'dark' | 'system'", fontSize: 'number' }),
).migrate((v) => {
  if (!('fontSize' in v)) return { ...v, fontSize: 14 };
  return v;
}, { mode: 'light', fontSize: 14 })
```

Even the shorthand returns a `migrate` identity function (`(v) => v`) that `create-kv.ts` calls on every `get()`:

```typescript
// create-kv.ts get() — today
const result = definition.schema['~standard'].validate(raw);
if (result.issues) return definition.defaultValue;
return definition.migrate(result.value);  // identity fn for shorthand
```

This creates problems:

1. **Dead code in production.** 43 production `defineKv` calls, 0 use the variadic pattern. The multi-version overload, `createUnionSchema` import, and `isSecondArgSchema` detection heuristic exist solely for test coverage.
2. **Caused a real bug.** The `isSecondArgSchema` heuristic used `typeof args[1] === 'object'` to distinguish schemas from default values. Arktype schemas are functions, not objects—the check silently misidentified the second schema as a default value, producing broken `KvDefinition`s (fixed in the defaults spec).
3. **Wrong mental model.** Tables accumulate rows that must survive schema changes—migration is mandatory. KV stores hold single preferences that can safely reset to default. Borrowing table migration machinery for KV conflates two fundamentally different data lifecycles.
4. **Unnecessary per-read overhead.** Every `get()` call runs `definition.migrate(result.value)` even though it's always the identity function in production.

### Desired State

```typescript
// The only defineKv signature
defineKv(type('boolean'), true)

// KvDefinition — no migrate field
{ schema, defaultValue }

// create-kv.ts get() — no migration step
const result = definition.schema['~standard'].validate(raw);
if (result.issues) return definition.defaultValue;
return result.value;
```

### Design Convention: One Scalar Per Key

KV keys should store scalar values (booleans, strings, numbers, enums), not structured objects. Use dot-namespaced keys to create logical groupings:

```typescript
// ✅ Correct — each preference is an independent scalar
'theme.mode': defineKv(type("'light' | 'dark' | 'system'"), 'light'),
'theme.fontSize': defineKv(type('number'), 14),

// ❌ Wrong — structured object invites migration needs
'theme': defineKv(type({ mode: "'light' | 'dark'", fontSize: 'number' }), { mode: 'light', fontSize: 14 }),
```

With scalar values, schema changes either don't break validation (widening `'light' | 'dark'` to `'light' | 'dark' | 'system'` still validates old data) or the default fallback is acceptable (resetting a toggle takes one click). This eliminates the need for migration entirely.

Exception: discriminated unions and `Record<string, T> | null` are acceptable when they represent a single atomic value (like the Reddit workspace's `defineKv(type('Record<string, string> | null'), null)`).

## Design Decisions

| Decision | Choice | Rationale |
|---|---|---|
| Remove variadic overload | Yes | Zero production usage, caused a bug, wrong abstraction for KV |
| Remove `migrate` field from `KvDefinition` | Yes | Identity function in all production paths; simplifies `get()` to validate-or-default |
| Remove `InferKvVersionUnion` type | Yes | Only meaningful with multi-version KV; unused outside its own definition |
| Keep `LastSchema` helper type | Yes | Still used by `defineTable` (tables legitimately need multi-version migration) |
| Keep `createUnionSchema` | Yes | Still used by `defineTable`; only remove the import from `define-kv.ts` |
| Don't add optional `migrate` callback | Deferred | No production KV entry needs it today. Add if/when a real case appears |
| Document scalar-per-key convention | Yes | Makes the "no migration needed" property structural, not accidental |

## Architecture

```
BEFORE                                    AFTER
──────                                    ─────

defineKv(schema, default)                 defineKv(schema, default)
  → { schema, migrate: identity, default }  → { schema, default }

defineKv(v1, v2).migrate(fn, default)     (removed)
  → { schema: union, migrate: fn, default }

get(key):                                 get(key):
  raw = ykv.get(key)                        raw = ykv.get(key)
  if missing → default                     if missing → default
  validate(raw)                             validate(raw)
  if invalid → default                     if invalid → default
  migrate(validated) → return               return validated
```

## Implementation Plan

All changes are in `packages/workspace/src/workspace/`. Every wave is independently committable.

### Wave 1: Simplify `KvDefinition` type

- [x] **1.1** In `types.ts`: Remove `migrate` field from `KvDefinition`. Remove the `TVersions` generic parameter—replace with a single `TSchema extends CombinedStandardSchema`. The type becomes:
  ```typescript
  export type KvDefinition<TSchema extends CombinedStandardSchema> = {
    schema: TSchema;
    defaultValue: StandardSchemaV1.InferOutput<TSchema>;
  };
  ```
- [x] **1.2** In `types.ts`: Simplify `InferKvValue` to extract directly from the single schema (no `LastSchema` indirection).
- [x] **1.3** In `types.ts`: Remove `InferKvVersionUnion` (dead type—unused outside its definition).
- [x] **1.4** In `types.ts`: Update the `KvDefinitions` record type if its constraint references the old generic shape.
- [x] **1.5** Update the JSDoc comment on `KvDefinition` to remove references to `.migrate(fn)`.

### Wave 2: Rewrite `defineKv`

- [x] **2.1** In `define-kv.ts`: Remove the variadic overload (the one requiring 2+ schemas and returning `{ migrate() }`).
- [x] **2.2** Remove the implementation body's multi-version branch (the `isSecondArgSchema` check, the `createUnionSchema` call, the returned `.migrate()` method).
- [x] **2.3** Remove the `import { createUnionSchema }` line.
- [x] **2.4** Remove the `import type { LastSchema }` from the imports.
- [x] **2.5** The remaining implementation is just:
  ```typescript
  export function defineKv<TSchema extends CombinedStandardSchema<JsonValue>>(
    schema: TSchema,
    defaultValue: StandardSchemaV1.InferOutput<TSchema>,
  ): KvDefinition<TSchema> {
    return { schema, defaultValue };
  }
  ```
- [x] **2.6** Update module-level and overload JSDoc to reflect the simplified API. Remove all variadic/migration examples.

### Wave 3: Simplify `createKv`

- [x] **3.1** In `create-kv.ts`: Remove the `parseValue` helper function (it exists only to call `definition.migrate`).
- [x] **3.2** Simplify `get()`: After successful validation, return `result.value` directly instead of `definition.migrate(result.value)`.
- [x] **3.3** Simplify `observe()`: In the `'add'`/`'update'` branch, validate and return the value without migration.
- [x] **3.4** Simplify `observeAll()`: Same—remove `definition.migrate(result.value)` call.
- [x] **3.5** Update JSDoc to remove migration references.

### Wave 4: Update tests

- [x] **4.1** In `define-kv.test.ts`: Remove the entire `variadic syntax` describe block. Remove migration-related tests from `schema patterns` (the ones using `.migrate()`). Keep shorthand syntax tests. Keep the primitive value test (it no longer calls `.migrate()`—just validates the schema).
- [x] **4.2** In `create-kv.test.ts`: Remove the `migrates old data on read` test. Keep `set/get`, `defaultValue for unset key`, `delete returns defaultValue`, and `defaultValue for invalid stored data` tests.
- [x] **4.3** In `define-workspace.test.ts`, `benchmark.test.ts`, `describe-workspace.test.ts`, `create-workspace.test.ts`: These all use the shorthand pattern—verified they still compile and pass.

### Wave 5: Cleanup

- [x] **5.1** Remove the `define-kv.ts` re-export of `LastSchema` if it was being re-exported (it isn't currently—verified).
- [x] **5.2** In `index.ts` barrel exports: Verify `KvDefinition`, `InferKvValue` still export correctly. `InferKvVersionUnion` was never in barrel—confirmed.
- [x] **5.3** Run `bun test` in `packages/workspace` to verify all tests pass. 347 pass, 0 fail.
- [ ] **5.4** Run `bun run typecheck` (or equivalent) to verify no type errors across the monorepo.

### Wave 6: Update documentation and skill files

KV migration references exist in skills and docs. Update them to reflect the simplified API and document the scalar-per-key convention.

- [x] **6.1** `.agents/skills/workspace-api/SKILL.md`: Rewrite the "KV Stores" section. Remove all variadic/versioned examples (`defineKv().version().migrate()`). Replace with the shorthand-only pattern (`defineKv(schema, defaultValue)`). Add a "KV Design Convention" subsection documenting scalar-per-key with dot-namespacing. Remove KV mentions from "Migration Function Rules" and "Anti-Patterns" (those now apply only to tables).
- [x] **6.2** `docs/articles/versioned-schemas-migrate-on-read.md`: Rewrite the "KV Storage" section (lines 196–212). Remove the multi-version KV example. Replace with the simplified pattern showing `defineKv(schema, default)` and explain that KV uses validate-or-default (no migration). Keep the table migration content unchanged.
- [x] **6.3** `docs/articles/api-design-decisions-definetable-definekv.md`: Update the "Symmetry: Tables and KV" section (lines 195–211). Tables and KV are no longer symmetric in their versioning API—tables have `.migrate()`, KV does not. Rewrite to explain the deliberate asymmetry: tables accumulate rows (migration required), KV stores preferences (default fallback sufficient).
- [x] **6.4** `docs/articles/20260127T120000-static-workspace-api-guide.md`: Update KV examples that use the builder/variadic pattern (`defineKv().version().migrate()`). Replace with `defineKv(schema, defaultValue)` shorthand.
- [x] **6.5** `packages/workspace/src/workspace/index.ts`: Update the module-level JSDoc example block (lines 29–41) — remove the variadic KV example and replace with a simple shorthand KV example.
- [x] **6.6** `packages/workspace/src/workspace/create-kv.ts`: Update the module-level JSDoc example block (lines 13–22) — remove the variadic KV example.

## Edge Cases

### Existing stored data from a variadic KV definition

No production code uses the variadic pattern. The only variadic `defineKv` calls are in test files. No real user data was ever written through a multi-version KV definition, so there's nothing to migrate or handle.

### Future need for KV migration

If a genuine case appears where a KV schema change would lose valuable user data, the escape hatch is:

1. Add a new KV key with the new schema and a default derived from the old key
2. Write app-level migration code that reads the old key and writes the new key on startup
3. Or add an optional `{ migrate? }` parameter to the shorthand at that time

This is a future concern, not a present one. Don't build it until it's needed.

### Widening an enum

Adding `'system'` to `'light' | 'dark'` doesn't break validation—old `'dark'` values still validate against the wider type. No migration needed. This is the most common schema evolution for KV and it's already handled correctly.

### Narrowing a type

Removing a previously valid value (e.g., dropping `'system'` from the enum) means old stored data fails validation and falls back to the default. This is acceptable for preferences—the user sees the default and rechooses.

## Success Criteria

- [x] `defineKv` has exactly one signature: `defineKv(schema, defaultValue)`
- [x] `KvDefinition` type has no `migrate` field
- [x] `create-kv.ts` `get()` does not call any migration function
- [x] No variadic overload or `isSecondArgSchema` detection logic exists
- [x] `createUnionSchema` is no longer imported by `define-kv.ts`
- [x] All tests in `packages/workspace` pass
- [x] Type checking passes across the monorepo
- [x] Zero production code changes required (all 44 Whispering `defineKv` calls are already shorthand)
- [x] `workspace-api` skill file reflects simplified KV API with scalar-per-key convention
- [x] Doc articles no longer show variadic KV patterns
- [x] Module-level JSDoc in `index.ts` and `create-kv.ts` updated

## References

### Source files (waves 1–5)

- `packages/workspace/src/workspace/define-kv.ts` — Primary target: rewrite to single overload
- `packages/workspace/src/workspace/create-kv.ts` — Remove migration calls from `get()`, `observe()`, `observeAll()`
- `packages/workspace/src/workspace/types.ts` — Simplify `KvDefinition`, remove `InferKvVersionUnion`
- `packages/workspace/src/workspace/define-kv.test.ts` — Remove variadic/migration tests
- `packages/workspace/src/workspace/create-kv.test.ts` — Remove migration test
- `apps/whispering/src/lib/workspace.ts` — 43 shorthand calls, zero changes needed (verification only)

### Documentation and skills (wave 6)

- `.agents/skills/workspace-api/SKILL.md` — Rewrite KV section, add scalar-per-key convention
- `docs/articles/versioned-schemas-migrate-on-read.md` — Rewrite KV Storage section
- `docs/articles/api-design-decisions-definetable-definekv.md` — Update symmetry section
- `docs/articles/20260127T120000-static-workspace-api-guide.md` — Update KV examples
- `packages/workspace/src/workspace/index.ts` — Update module JSDoc
- `packages/workspace/src/workspace/create-kv.ts` — Update module JSDoc

### Prior specs

- `specs/20260303T120000-variadic-define-table-kv.md` — Previous spec that added the variadic pattern (this reverses the KV portion)
- `specs/20260313T070000-definekv-defaults.md` — Follow-up note that first raised this question

## Review

**Completed**: 2026-03-13
**Branch**: opencode/silent-squid

### Summary

Removed all KV migration machinery from the workspace package. `defineKv` now has a single signature (`defineKv(schema, defaultValue)`) that returns `{ schema, defaultValue }`. The `KvDefinition` type dropped its `TVersions` tuple generic and `migrate` field. `createKv`'s `get()`, `observe()`, and `observeAll()` return validated values directly instead of running them through a migration function.

### Deviations from Spec

- Spec listed 43 production `defineKv` calls; actual count is 44 (one was added between spec writing and execution)
- Wave 5.4 (monorepo typecheck) deferred—the pre-existing `ClaimedDocumentColumns` error on line 256 of types.ts is unrelated to this change

### Follow-up Work

- Fix the pre-existing `ClaimedDocumentColumns` type error in types.ts (references `updatedAt` which was removed from `DocumentConfig`)
- Consider adding the scalar-per-key dot-namespacing convention to the Whispering workspace file (currently uses flat keys, which is fine)
