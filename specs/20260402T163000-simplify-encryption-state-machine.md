# Simplify Encryption State Machine in `withEncryption()`

**Date**: 2026-04-02
**Status**: Implemented
**Author**: AI-assisted

## Overview

Refactor the `withEncryption()` closure in `create-workspace.ts` from 5 independent mutable variables with duplicated rollback logic into 2 state variables with a single extracted store-coordination helper. No behavioral changes: same tests, same API.

## Motivation

### Current State

The encryption lifecycle is managed by 5 closure variables that must be kept in sync:

```typescript
let activeUserKey: Uint8Array | undefined;
let isActiveUserKeyCached = config?.userKeyStore === undefined;
let workspaceKey: Uint8Array | undefined = options?.key;
let cacheQueue = Promise.resolve();
let activeWorkspaceKeyring: ReadonlyMap<number, Uint8Array> | undefined;
```

State transitions require 3 sequential assignments that aren't atomic:

```typescript
workspaceKey = nextWorkspaceKey;
activeWorkspaceKeyring = workspaceKeyring;
activeUserKey = currentUserKey;
// If anything throws between these lines, state is inconsistent
```

The rollback pattern (track modified stores, revert on partial failure) is duplicated across `lock()` and `unlock()`: 14 lines each with slightly different rollback strategies.

This creates problems:

1. **Non-atomic state transitions**: 3 variables must be set together but are assigned sequentially
2. **Duplicated rollback**: Same try/track/rollback pattern in both `lock()` and `unlock()`
3. **`workspaceKey` is a boolean dressed as a Uint8Array**: Only ever checked as `!== undefined`
4. **Hard to see the state machine**: Two states (locked/unlocked) hidden behind 5 mutable variables

### Desired State

Two variables. One state object, one cache flag:

```typescript
let encryptionState: {
    userKey: Uint8Array;
    keyring: ReadonlyMap<number, Uint8Array>;
} | undefined;

let persisted = !config?.userKeyStore;
```

Transitions are atomic (single assignment). Rollback is extracted. `isUnlocked` is derived.

## Design Decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Collapse 3 variables into one object | `encryptionState` | Atomic transitions, structurally enforced invariant |
| Keep `cacheQueue` separate | Stays as-is | Orthogonal concern: serializes async cache ops |
| Rename `isActiveUserKeyCached` → `persisted` | Shorter, same semantics | "Has the active key been written to the store?" |
| Extract `transactStores` helper | Top-level function | Eliminates duplicated rollback tracking in lock/unlock |
| Extract `bootFromCache` helper | Named function | Moves 22-line inline promise chain into a readable unit |
| De-dup early-returns at top of `unlock()` | Flat control flow | Eliminates the `if (!isSameUserKey) { ... entire body ... }` wrapper |
| `isUnlocked` derived from `encryptionState` | `encryptionState !== undefined` | No separate `workspaceKey` variable needed |

## Architecture

### Before: 5 mutable variables

```
withEncryption()
├── activeUserKey          ← identity (de-dup)
├── isActiveUserKeyCached  ← persistence flag
├── workspaceKey           ← only used as boolean
├── cacheQueue             ← async serialization
├── activeWorkspaceKeyring ← rollback state
├── lock()                 ← 14 lines of rollback tracking
├── unlock()               ← 14 lines of rollback tracking (duplicated)
├── persistKeys()
├── clearCache()
├── auto-boot (22 lines inline)
└── return { ... }
```

### After: 2 state variables + extracted helpers

```
transactStores()           ← top-level, reusable

withEncryption()
├── encryptionState        ← { userKey, keyring } | undefined
├── persisted              ← boolean
├── cacheQueue             ← async serialization (unchanged)
├── lock()                 ← uses transactStores()
├── unlock()               ← uses transactStores(), early-return de-dup
├── persistKeys()          ← unchanged
├── clearCache()           ← unchanged
├── bootFromCache()        ← extracted named function
└── return { ... }
```

## Implementation Plan

### Phase 1: Extract `transactStores` helper

- [x] **1.1** Add `transactStores` function above `createWorkspace`
- [x] **1.2** Replace `unlock()`'s inline rollback tracking with `transactStores()` call
- [x] **1.3** Replace `lock()`'s inline rollback tracking with `transactStores()` call

### Phase 2: Collapse state variables

- [x] **2.1** Replace 3 variables with single `encryptionState` object
- [x] **2.2** Rename `isActiveUserKeyCached` to `persisted`
- [x] **2.3** Derive `isUnlocked` from `encryptionState !== undefined || storesActive`
- [x] **2.4** Atomic state transition in `unlock()`: one assignment, not three
- [x] **2.5** Atomic state clear in `lock()`
- [x] **2.6** De-dup reads from `encryptionState.userKey`
- [x] **2.7** `persistKeys` stale guard reads from `encryptionState.userKey`
- [x] **2.8** `storesActive` boolean handles construction-time key path

### Phase 3: Extract `bootFromCache` and flatten control flow

- [x] **3.1** Extract `bootFromCache(store)` named function
- [x] **3.2** Flatten `unlock()` de-dup: early return when same key

### Phase 4: Verify

- [x] **4.1** All 55 `create-workspace.test.ts` tests pass (zero failures)
- [x] **4.2** `lsp_diagnostics` clean
- [x] **4.3** Full workspace suite: 567 tests pass

## Edge Cases

### Construction-time key (`options?.key`)

The construction-time key path (line 198) creates a synthetic `Map([[1, key]])` and activates stores immediately. BEFORE `withEncryption()` runs. Inside `withEncryption`, `workspaceKey` is initialized from `options?.key` purely so `isUnlocked` returns true. But `activeUserKey` and `activeWorkspaceKeyring` are NOT set.

**Resolution**: Use a separate `let storesActive = options?.key !== undefined` boolean. `isUnlocked` checks `encryptionState !== undefined || storesActive`. The `unlock()` and `lock()` functions update both. This avoids polluting `encryptionState` with a synthetic entry that has no user key for de-dup.

### `persistKeys` stale-write guard

`persistKeys` compares `encryptionState?.userKey` against the passed `currentUserKey`. Same semantics as before, different variable access.

### `lock()` after construction-time key

`lock()` sets `encryptionState = undefined` and `storesActive = false`. Rollback: `previousKeyring` comes from `encryptionState?.keyring`. If `encryptionState` is undefined (construction-time key, no `unlock()` called), no rollback keyring is available. Stores were activated externally, deactivation failure is unrecoverable. Matches current behavior.
## Success Criteria

- [x] All 55 `create-workspace.test.ts` tests pass unchanged
- [x] `withEncryption()` body uses 3 state variables instead of 5
- [x] No duplicated rollback logic: `transactStores` used by both lock/unlock
- [x] `lsp_diagnostics` clean
- [x] Auto-boot is `bootFromCache()` named function

## References

- `packages/workspace/src/workspace/create-workspace.ts`: lines 539-698 (`withEncryption` body)
- `packages/workspace/src/workspace/create-workspace.test.ts`: lines 964-1315 (encryption + lifecycle tests)
- `packages/workspace/src/workspace/types.ts`: `WorkspaceEncryption` type definition
- `packages/workspace/src/shared/y-keyvalue/y-keyvalue-lww-encrypted.ts`: `activateEncryption` / `deactivateEncryption` API

## Review

**Completed**: 2026-04-02
**Branch**: feat/epoch-based-ydoc-compaction

### Summary

Refactored `withEncryption()` from 5 independent mutable variables with duplicated 14-line rollback patterns into 3 state variables (`encryptionState` object, `persisted` boolean, `storesActive` boolean) with a shared `transactStores()` helper. Net reduction of ~30 lines. All 567 workspace tests pass unchanged.

### Key changes

- **`transactStores()`**: Top-level helper that applies an operation to all stores with automatic rollback on partial failure. Used by both `lock()` and `unlock()`.
- **`encryptionState`**: Single object replacing `activeUserKey` + `workspaceKey` + `activeWorkspaceKeyring`. State transitions are one assignment instead of three.
- **`storesActive`**: Separate boolean for the construction-time key path (`options?.key`) where stores are activated before `withEncryption()` runs.
- **`bootFromCache()`**: Extracted from 22-line inline promise chain.
- **Flattened `unlock()`**: De-dup is an early return at the top, not a wrapper around the entire body.
