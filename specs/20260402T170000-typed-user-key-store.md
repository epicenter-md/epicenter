# Typed UserKeyStore

**Date**: 2026-04-02
**Status**: Implemented
**Author**: AI-assisted

## Overview

Change `UserKeyStore` from an opaque string interface (`set(json: string)` / `get(): string | null`) to a typed interface (`set(keys: EncryptionKeys)` / `get(): EncryptionKeys | null`). Serialization moves into the store implementations, and deserialization gets ArkType validation at the boundary.

## Motivation

### Current State

```typescript
// user-key-store.ts: interface
export type UserKeyStore = {
  set(keysJson: string): Promise<void>;
  get(): Promise<string | null>;
  delete(): Promise<void>;
};

// create-workspace.ts: caller must JSON.stringify
await config.userKeyStore.set(JSON.stringify(keys));

// create-workspace.ts: caller must JSON.parse + cast
const keys = JSON.parse(cached) as EncryptionKey[];
await unlock(keys);
```

This creates problems:

1. **Shape errors surface at JSON.parse, not at the boundary.** A corrupt or schema-mismatched string crashes `JSON.parse` or silently produces wrong data. The ArkType `EncryptionKeys` schema exists but is only used in `create-workspace.ts`: the store interface doesn't enforce it.
2. **Every caller handles serialization.** `create-workspace.ts` does `JSON.stringify` on set and `JSON.parse` + ArkType validation on get. If a second caller ever uses `UserKeyStore`, it would need to duplicate this logic.
3. **The type signature lies.** `set(keysJson: string)` looks like it accepts any string. The actual contract is "must be `JSON.stringify(EncryptionKeys)`". Invisible to TypeScript.

### Desired State

```typescript
// user-key-store.ts: typed interface
import type { EncryptionKeys } from './encryption-key.js';

export type UserKeyStore = {
  set(keys: EncryptionKeys): Promise<void>;
  get(): Promise<EncryptionKeys | null>;
  delete(): Promise<void>;
};

// create-workspace.ts: no serialization at call site
await config.userKeyStore.set(keys);

// auto-boot: store returns validated data
const keys = await store.get();
if (!keys) return;
await unlock(keys);
```

## Design Decisions

| Decision | Choice | Rationale |
|---|---|---|
| Where serialization lives | Inside each store implementation | Store owns its persistence format (JSON for IndexedDB/WXT, could be binary for Stronghold) |
| Validation on `get()` | ArkType `EncryptionKeys` schema | Catches corrupt data at the boundary, not at `unlock()` |
| Return type on validation failure | `null` (same as "no cached key") | Consumer already handles null. Logging the error inside the store is sufficient. |
| `set()` parameter type | `EncryptionKeys` (non-empty tuple) | Matches `unlock()` parameter. Prevents storing an empty array. |

## Implementation Plan

### Phase 1: Change the interface + workspace caller

- [x] **1.1** Update `UserKeyStore` type in `user-key-store.ts`: `set(keys: EncryptionKeys)`, `get(): Promise<EncryptionKeys | null>`
- [x] **1.2** Update `create-workspace.ts`: remove `JSON.stringify()` in `persistKeys`, remove `JSON.parse()` + ArkType validation in auto-boot
- [x] **1.3** Update `create-workspace.test.ts`: `setupWithUserKeyStore` mock now stores/returns `EncryptionKeys | null` instead of `string | null`. Removed `toKeysJson` helper, assertions use `toEncryptionKeys` directly.

### Phase 2: Update store implementations

- [x] **2.1** `indexed-db-key-store.ts` (svelte-utils): `set()` calls `JSON.stringify`, `get()` calls `JSON.parse` + `EncryptionKeys(parsed)` validation, returns `null` on failure
- [x] **2.2** `key-store.ts` (tab-manager WXT storage): same pattern. Serialize on set, validate on get
- [x] **2.3** Run `bun test` on affected packages, `bun typecheck`

## Edge Cases

### Corrupt data in existing IndexedDB stores

1. User upgrades to new code with old JSON string in IndexedDB
2. `get()` reads string, `JSON.parse` succeeds, ArkType validation succeeds (schema is unchanged)
3. Works transparently. No migration needed

### Corrupt data from manual tampering

1. User edits IndexedDB value directly
2. `get()` reads string, `JSON.parse` or ArkType validation fails
3. Store returns `null`, auto-boot skips, workspace waits for server session

## Success Criteria

- [x] `UserKeyStore.set()` accepts `EncryptionKeys`, not `string`
- [x] `UserKeyStore.get()` returns `EncryptionKeys | null`, not `string | null`
- [x] No `JSON.stringify` or `JSON.parse` in `create-workspace.ts` for key store operations
- [x] ArkType validation happens inside `get()` implementations
- [x] All tests pass, typecheck clean
- [x] Existing IndexedDB data works without migration

## References

- `packages/workspace/src/workspace/user-key-store.ts`: Interface definition
- `packages/workspace/src/workspace/encryption-key.ts`: `EncryptionKeys` ArkType schema
- `packages/workspace/src/workspace/create-workspace.ts`: Primary caller (persistKeys, auto-boot)
- `packages/workspace/src/workspace/create-workspace.test.ts`: Mock UserKeyStore + assertions
- `packages/svelte-utils/src/indexed-db-key-store.ts`: IndexedDB implementation
- `apps/tab-manager/src/lib/state/key-store.ts`: WXT storage implementation

## Review

**Completed**: 2026-04-02

### Summary

Changed `UserKeyStore` from an opaque `string` interface to a typed `EncryptionKeys` interface. Serialization (JSON.stringify/parse) moved from `create-workspace.ts` into each store implementation. ArkType validation now happens at the store boundary in `get()`, returning `null` on failure instead of throwing.

### Deviations from Spec

- **Duplicate export collision**: `index.ts` exported `EncryptionKeys` as both a type (from `types.ts`) and a runtime value (from `encryption-key.ts`), causing `TS2300`. Fixed by removing the type re-export from the types block and adding a proper `import type` in `types.ts`.
- **Corrupt cache test**: The original test passed a corrupt string to `setupWithUserKeyStore`. With the typed interface, the store always returns valid data or `null`. Updated the test to pass valid-shaped but bad-base64 keys that cause `unlock()` to throw instead.

### Follow-up Work

- None identified. The change is backward-compatible with existing IndexedDB data since the JSON format is unchanged.
