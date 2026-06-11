# KV Default Values and Optional Migration

**Date**: 2026-03-13
**Status**: Implemented (simpler design: required `defaultValue` param, no `migrate` callback, no status discriminant)
**Builds on**: `specs/20260214T225000-version-discriminant-tables-only.md`, `specs/20251230T132500-kv-store-feature.md`
**Independent of**: `specs/20260313T180100-client-side-encryption-wiring.md` (can be implemented in parallel)

## Overview

Add a `defaultValue` parameter and an optional `migrate` callback to the `defineKv` shorthand. When `get()` finds no stored data or stored data that fails schema validation, it returns the default instead of `{ status: 'not_found' }` or `{ status: 'invalid' }`. The optional `migrate` callback transforms old values before validation, handling the cases where a user's stored preference is too valuable to silently discard.

## Motivation

### Current State

KV settings today have no default value concept. The app must handle three return statuses:

```typescript
const sidebar = defineKv(type({ collapsed: 'boolean', width: 'number' }));

// In component code:
const result = kv.get('sidebar');
switch (result.status) {
  case 'not_found':
    // First visit: use hardcoded default
    return { collapsed: false, width: 300 };
  case 'invalid':
    // Schema changed, old data doesn't validate: use hardcoded default
    return { collapsed: false, width: 300 };
  case 'valid':
    return result.value;
}
```

The default is duplicated: once in the component, often again in other components that read the same key. When the default changes, every call site needs updating.

For schema evolution, the variadic pattern exists:

```typescript
const theme = defineKv(
  type({ mode: "'light' | 'dark'", _v: '1' }),
  type({ mode: "'light' | 'dark' | 'system'", fontSize: 'number', _v: '2' }),
).migrate((v) => {
  switch (v._v) {
    case 1: return { ...v, fontSize: 14, _v: 2 };
    case 2: return v;
  }
});
```

This is the right tool for tables (thousands of rows, multiple versions coexisting). For KV (one value per key), it's overengineered in most cases.

### Why KV Migration Is Different From Table Migration

Tables accumulate rows over time. A table with 10,000 recordings might have rows at versions 1, 2, and 3 simultaneously. The variadic multi-schema pattern with discriminated unions handles this correctly. Every row validates against its own version's schema, then migrates forward.

KV stores are different. There's one value per key. You're migrating one thing, not thousands. The calculus changes:

| Factor | Tables | KV |
|--------|--------|----|
| Values to migrate | Thousands of rows | One value per key |
| Versions coexisting | Many (v1, v2, v3 in same array) | One (the stored value) |
| Cost of "reset to default" | Data loss at scale | User re-clicks one setting |
| Migration complexity needed | Full discriminated union | Simple transform function |
| Type system overhead | Worth it (safety at scale) | Often not worth it (one value) |

Most KV settings fall into the "reset is fine" category: booleans, simple enums, preferences fixable in one click. The small number of cases where migration matters (user configured a specific file path, chose a specific paid service, spent time on custom keybindings) can be handled with a simple `migrate` callback rather than the full variadic machinery.

### Desired State

```typescript
// Simple KV with default (most common case)
const sidebar = defineKv(
  type({ collapsed: 'boolean', width: 'number' }),
  { default: { collapsed: false, width: 300 } },
);

// In component code:
const value = kv.get('sidebar');
// value.status === 'valid' → stored data validated
// value.status === 'default' → no stored data, or stored data invalid; using default

// KV with default + migration (rare, high-value settings)
const transcription = defineKv(
  type({ service: "'deepgram' | 'openai'", model: 'string', language: 'string' }),
  {
    default: { service: 'openai', model: 'whisper-1', language: 'en' },
    migrate: (old) => {
      // Old schema was just { service: string }
      if (typeof old === 'object' && old && 'service' in old) {
        return { service: old.service, model: 'whisper-1', language: 'en' };
      }
      return undefined; // fall back to default
    },
  },
);
```

## Design Decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Default value parameter | Second arg as options object: `defineKv(schema, { default })` | Keeps the shorthand clean. The options object is extensible for `migrate` and future options. |
| Return type for defaulted values | `{ status: 'default', value: T }` | Distinguishes "stored and validated" from "using default". Components can show a "(default)" indicator or skip saving defaults to storage. |
| `migrate` callback | `(old: unknown) => T \| undefined` | Receives the raw stored value (pre-validation). Returns migrated value or `undefined` to fall back to default. Simple function, not multi-schema union. |
| Migration flow | `migrate → validate → return` or `fallback to default` | If `migrate` returns a value, it's validated against the schema. If validation fails, default is used. If `migrate` returns `undefined`, default is used. |
| Variadic pattern | Keep for backward compatibility | Existing variadic `defineKv(v1, v2).migrate(fn)` still works. Not deprecated. Just not the recommended path for most KV. |
| `defaultValue` in variadic | Not added | The variadic pattern is for complex multi-version cases. If you need the variadic pattern, you're already handling the complexity. Adding defaults there muddies the API. |

## Architecture

```
get(key) flow with defaults:

  ┌──────────────┐
  │ ykv.get(key) │
  └──────┬───────┘
         │
    ┌────▼────┐     ┌─────────────────────────┐
    │ found?  │─No──▶ return { status: 'default', │
    └────┬────┘     │         value: default }    │
         │Yes       └─────────────────────────┘
         ▼                         ▲
  ┌──────────────┐                 │
  │ migrate(raw) │─returns undefined──┘
  │ (if defined) │
  └──────┬───────┘
         │returns value
         ▼
  ┌──────────────────┐
  │ schema.validate() │
  └──────┬───────────┘
         │
    ┌────▼────┐     ┌─────────────────────────┐
    │ valid?  │─No──▶ return { status: 'default', │
    └────┬────┘     │         value: default }    │
         │Yes       └─────────────────────────┘
         ▼
  ┌─────────────────────────┐
  │ return { status: 'valid', │
  │         value: migrated } │
  └─────────────────────────┘
```

## Implementation Plan

### Phase 1: API Changes

- [ ] **1.1** Add `KvOptions` type: `{ default: T; migrate?: (old: unknown) => T | undefined }`
- [ ] **1.2** Add new `defineKv` overload: `defineKv<TSchema>(schema, options: KvOptions<InferOutput<TSchema>>): KvDefinition<[TSchema]>`
- [ ] **1.3** Update `KvDefinition` type to include optional `defaultValue` field
- [ ] **1.4** Update `KvGetResult` type to add `'default'` status: `{ status: 'default'; value: T }`

### Phase 2: Runtime Changes

- [ ] **2.1** Update `createKv` `get()` method to check for `defaultValue` on the definition
- [ ] **2.2** Wire the `migrate` callback: if defined, call it before schema validation
- [ ] **2.3** Handle the full flow: not_found → default, invalid + no migrate → default, invalid + migrate returns undefined → default, invalid + migrate returns value → validate → valid or default

### Phase 3: Tests

- [ ] **3.1** Test: `defineKv(schema, { default })` returns default when key not found
- [ ] **3.2** Test: returns default when stored data fails validation (schema changed)
- [ ] **3.3** Test: returns `{ status: 'valid' }` when stored data validates
- [ ] **3.4** Test: `migrate` callback transforms old data successfully
- [ ] **3.5** Test: `migrate` returning `undefined` falls back to default
- [ ] **3.6** Test: `migrate` returning invalid data (fails schema) falls back to default
- [ ] **3.7** Test: existing variadic `defineKv(v1, v2).migrate(fn)` still works unchanged

### Phase 4: Migrate Existing Apps (optional, incremental)

- [ ] **4.1** Audit existing `defineKv` usage across apps. Identify which KV settings would benefit from defaults
- [ ] **4.2** Add defaults to settings that currently have hardcoded fallbacks in component code
- [ ] **4.3** Add `migrate` callbacks only to high-value settings (service selections, file paths, device selections)

## Edge Cases

### Default Value Mutation

The default value is a static object. If the consumer mutates it, every subsequent `get()` returns the mutated version. The implementation should return a shallow copy (spread) of the default, not a reference.

### Migrate Callback Throws

If `migrate` throws, catch the error and fall back to the default value. Log a warning. Don't let a broken migration crash the app.

### Encrypted Values

The `migrate` callback receives the decrypted, deserialized value (same as what the variadic `migrate` receives). Encryption is transparent at this layer. The encrypted KV wrapper decrypts before the value reaches `get()`.

## Open Questions

1. **Should `get()` with defaults still expose `'not_found'` and `'invalid'` statuses?**
   - Options: (a) always return `'valid'` or `'default'` when defaults exist, (b) keep all four statuses
   - **Recommendation**: (a): when a default exists, the caller never needs to handle `not_found` or `invalid`. Simplify to two states.

2. **Should `observe()` fire for default values?**
   - The observer fires when the underlying YKV changes. If the key doesn't exist, the observer doesn't fire. Default values are a read-time concept, not a storage-time concept.
   - **Recommendation**: No. Observe only fires on actual storage changes. Defaults are a `get()` concern.

3. **Naming: `default` vs `defaultValue` vs `fallback`?**
   - `default` is a reserved word in some contexts but works as a property name.
   - **Recommendation**: `default` in the options object (`{ default: ... }`). It's the most natural name and works fine as a property.

## Success Criteria

- [ ] `defineKv(schema, { default })` compiles and returns a `KvDefinition`
- [ ] `get()` returns `{ status: 'default', value }` when key not found or invalid
- [ ] `migrate` callback transforms old values before validation
- [ ] `migrate` returning `undefined` falls back to default
- [ ] Existing variadic `defineKv(v1, v2).migrate(fn)` unchanged
- [ ] All existing tests pass
- [ ] Monorepo typecheck passes

## References

- `packages/workspace/src/workspace/define-kv.ts`: current `defineKv` implementation
- `packages/workspace/src/workspace/create-kv.ts`: `get()` method with `parseValue`
- `packages/workspace/src/workspace/types.ts`: `KvDefinition`, `KvGetResult` types
- `specs/20260214T225000-version-discriminant-tables-only.md`: KV versioning decisions (field presence vs `_v`)
- `specs/20251230T132500-kv-store-feature.md`: original KV store design
- `specs/20260126T120000-static-workspace-api.md`: workspace API design principles
