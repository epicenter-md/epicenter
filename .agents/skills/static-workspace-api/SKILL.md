---
name: static-workspace-api
description: Static workspace API patterns for defineTable, defineKv, versioning, and migrations. Use when defining workspace schemas, adding versions to existing tables/KV stores, or writing migration functions.
metadata:
  author: epicenter
  version: '1.0'
---

# Static Workspace API

Type-safe schema definitions for tables and KV stores with versioned migrations.

## When to Apply This Skill

- Defining a new table or KV store with `defineTable()` or `defineKv()`
- Adding a new version to an existing definition
- Writing migration functions
- Converting from shorthand to builder pattern
- Deciding whether to use `_v` discriminants or field presence

## Two Patterns

### Shorthand (Single Version)

Use when a table or KV store has only one version. No `_v` field needed.

```typescript
import { defineTable, defineKv } from 'epicenter/static';
import { type } from 'arktype';

const users = defineTable(type({ id: 'string', email: 'string' }));
const sidebar = defineKv(type({ collapsed: 'boolean', width: 'number' }));
```

### Builder (Multiple Versions)

Use when you need to evolve a schema over time.

```typescript
const posts = defineTable()
  .version(type({ id: 'string', title: 'string' }))
  .version(type({ id: 'string', title: 'string', views: 'number', _v: '"2"' }))
  .migrate((row) => {
    if (!('_v' in row)) return { ...row, views: 0, _v: '2' };
    return row;
  });
```

## Versioning: Two Options

When evolving a schema, you choose whether to include `_v` on the first version. Both are valid — the tradeoff is ceremony vs symmetry.

### Option A: No `_v` on v1 (common)

Start with shorthand, add `_v` only when you need a second version. Less ceremony upfront, one asymmetric check in migrations.

```typescript
// Start simple
const posts = defineTable(type({ id: 'string', title: 'string' }));

// Later, evolve to v2
const posts = defineTable()
  .version(type({ id: 'string', title: 'string' }))                             // v1: original, no _v
  .version(type({ id: 'string', title: 'string', views: 'number', _v: '"2"' })) // v2+: adds _v
  .migrate((row) => {
    if (!('_v' in row)) return { ...row, views: 0, _v: '2' };
    return row;
  });

// v3: asymmetric — first check is `in`, rest are `===`
const posts = defineTable()
  .version(type({ id: 'string', title: 'string' }))
  .version(type({ id: 'string', title: 'string', views: 'number', _v: '"2"' }))
  .version(type({ id: 'string', title: 'string', views: 'number', tags: 'string[]', _v: '"3"' }))
  .migrate((row) => {
    if (!('_v' in row)) return { ...row, views: 0, tags: [], _v: '3' };
    if (row._v === '2') return { ...row, tags: [], _v: '3' };
    return row;
  });
```

### Option B: `_v` from the start (upfront)

Include `_v: '"1"'` on the first version from day one. More ceremony on every `set()` call, but clean symmetric `switch` in migrations.

```typescript
// Include _v from the start
const posts = defineTable(type({ id: 'string', title: 'string', _v: '"1"' }));

// Evolve to v2 — clean switch
const posts = defineTable()
  .version(type({ id: 'string', title: 'string', _v: '"1"' }))
  .version(type({ id: 'string', title: 'string', views: 'number', _v: '"2"' }))
  .migrate((row) => {
    switch (row._v) {
      case '1': return { ...row, views: 0, _v: '2' };
      case '2': return row;
    }
  });

// v3: all cases symmetric
const posts = defineTable()
  .version(type({ id: 'string', title: 'string', _v: '"1"' }))
  .version(type({ id: 'string', title: 'string', views: 'number', _v: '"2"' }))
  .version(type({ id: 'string', title: 'string', views: 'number', tags: 'string[]', _v: '"3"' }))
  .migrate((row) => {
    switch (row._v) {
      case '1': return { ...row, views: 0, tags: [], _v: '3' };
      case '2': return { ...row, tags: [], _v: '3' };
      case '3': return row;
    }
  });
```

### Tradeoff Summary

| | Field Presence | Asymmetric `_v` | Symmetric `_v` |
|---|---|---|---|
| Shorthand | ✅ `defineTable(schema)` | ✅ `defineTable(schema)` | ❌ Must use builder + `_v: '"1"'` |
| Write calls | Clean | Clean | Must include `_v: '1'` |
| Migration checks | `if (!('field' in row))` | `if (!('_v' in row))` then `===` | `switch (row._v)` |
| Best for | Two versions only | Tables that may never version | Tables you know will evolve |

Choose whichever fits the table. Most tables never version, so asymmetric `_v` is the common default.

**Important:** If you started with Option A (no `_v` on v1), do NOT retroactively add `_v: '"1"'` to the first `.version()` schema — existing data in the wild won't have it and will fail validation. Stick with `!('_v' in row)` for the v1 check.

### Same Patterns for KV

```typescript
// Option A
const theme = defineKv()
  .version(type({ mode: "'light' | 'dark'" }))
  .version(type({ mode: "'light' | 'dark' | 'system'", fontSize: 'number', _v: '"2"' }))
  .migrate((v) => {
    if (!('_v' in v)) return { ...v, fontSize: 14, _v: '2' };
    return v;
  });

// Option B
const theme = defineKv()
  .version(type({ mode: "'light' | 'dark'", _v: '"1"' }))
  .version(type({ mode: "'light' | 'dark' | 'system'", fontSize: 'number', _v: '"2"' }))
  .migrate((v) => {
    switch (v._v) {
      case '1': return { ...v, fontSize: 14, _v: '2' };
      case '2': return v;
    }
  });
```

## The `_v` Convention

- `_v` is a **string literal** discriminant field (`'"2"'` in arktype = the literal string `"2"`)
- `_v` on v1 is **optional**. If omitted, the absence of `_v` is the v1 discriminant.
- v2 onward always has `_v`. Values are `"1"`, `"2"`, `"3"`, etc.
- In migration returns: `_v: '2'` (TypeScript narrows automatically, `as const` is optional)
- In arktype schemas: `_v: '"2"'`

## Migration Function Rules

1. Input type is a union of all version outputs
2. Return type is the latest version output
3. If v1 has no `_v`, first check is `if (!('_v' in row))`
4. If all versions have `_v`, use `switch(row._v)` for clean discrimination
5. Final `return row` (or `default` case) handles the already-latest case
6. Always migrate directly to latest (not incrementally through each version)

## Anti-Patterns

### Retroactively adding `_v` to v1

If you started without `_v` on v1, don't add it later:

```typescript
// BAD: v1 data in the wild does NOT have _v — this breaks validation
.version(type({ id: 'string', title: 'string', _v: '"1"' }))
```

Use `!('_v' in row)` in the migration instead.

### Note: `as const` is optional

TypeScript's contextual typing automatically narrows `_v: '2'` to the literal type `"2"` based on the return type constraint from the migration function. Both of these work:

```typescript
// Works: TypeScript infers _v as "2" from context
return { ...row, views: 0, _v: '2' };

// Also works: Explicit narrowing with as const (optional)
return { ...row, views: 0, _v: '2' };
```

The `as const` is NOT required but can make the type narrowing more explicit if you prefer.

## Field Presence as Alternative

For simple two-version cases where the field difference is obvious, you can skip `_v` entirely:

```typescript
const posts = defineTable()
  .version(type({ id: 'string', title: 'string' }))
  .version(type({ id: 'string', title: 'string', views: 'number' }))
  .migrate((row) => {
    if (!('views' in row)) return { ...row, views: 0 };
    return row;
  });
```

This works for two versions but becomes ambiguous beyond that. Prefer `_v` for 3+ versions.

## References

- `packages/epicenter/src/static/define-table.ts`
- `packages/epicenter/src/static/define-kv.ts`
- `packages/epicenter/src/static/index.ts`
