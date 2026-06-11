# Extract Encryption Runtime from create-workspace.ts

## Problem

`create-workspace.ts` (761 lines) has a 160-line `withEncryption()` method that defines its own state, five operations, and lifecycle wiring. All via closures inside a builder method. This makes it:

1. **Untestable in isolation**: every encryption test goes through `createWorkspace().withEncryption()`, constructing a full workspace just to test lock/unlock behavior
2. **Hard to trace**: `encryptedStores`, `id`, and other dependencies are captured from 200+ lines above via closure
3. **A mixed concern**: encryption key management, HKDF derivation, cache serialization, and transactional store activation live inline in a workspace builder file

## Solution

Extract `createEncryptionRuntime()` to a new `encryption-runtime.ts` file. Move `bytesEqual` and `transactStores` alongside it (they're only used by encryption code). Delete the dead `WorkspaceClientWithActions` type found during review.

## What changes

### New file: `encryption-runtime.ts`

Contains:
- `bytesEqual()`: byte-level Uint8Array comparison (moved from create-workspace.ts)
- `transactStores()`: apply-with-rollback for encrypted stores (moved from create-workspace.ts)
- `createEncryptionRuntime()`: all encryption state and operations, explicit dependencies

```typescript
// encryption-runtime.ts
export function createEncryptionRuntime(config: {
  workspaceId: string;
  stores: readonly YKeyValueLwwEncrypted<unknown>[];
  userKeyStore?: UserKeyStore;
}): {
  encryption: WorkspaceEncryption;
  lock: () => void;
  clearCache: () => Promise<void>;
  bootPromise?: Promise<void>;
}
```

### Modified: `create-workspace.ts`

Before (~160 lines in withEncryption):
```
withEncryption(config?) {
    // 160 lines: state, lock, unlock, persistKeys, clearCache,
    // bootFromCache, wiring, bootPromise, return buildClient
}
```

After (~15 lines):
```
withEncryption(config?) {
    const runtime = createEncryptionRuntime({
        workspaceId: id,
        stores: encryptedStores,
        userKeyStore: config?.userKeyStore,
    });
    // wire bootPromise into whenReadyPromises
    return buildClient({ extensions, state: newState, encryptionRuntime: runtime, actions });
}
```

Net: `create-workspace.ts` drops ~170 lines. `encryption-runtime.ts` gains ~170 lines. Complexity is redistributed, not added.

### Deleted: `WorkspaceClientWithActions`

Dead type alias in `types.ts` (line 965). Re-exported from `workspace/index.ts` and `src/index.ts` but **never imported by any consumer**. The comment says "retained for backward compatibility" but nothing uses it.

### Before/After: closure dependency graph

```
BEFORE:                                    AFTER:
createWorkspace()                          createWorkspace()
  ├─ ydoc, tables, encryptedStores         ├─ ydoc, tables, encryptedStores
  ├─ buildClient()                         ├─ buildClient()
  │   ├─ withEncryption()                  │   └─ withEncryption()  (~15 lines)
  │   │   ├─ encryptionState  ←closure     │       └─ createEncryptionRuntime(deps)
  │   │   ├─ lock()           ←closure     │
  │   │   ├─ unlock()         ←closure     encryption-runtime.ts
  │   │   ├─ persistKeys()    ←closure       └─ createEncryptionRuntime({ stores, id, config })
  │   │   ├─ clearCache()     ←closure           ├─ encryptionState  ←local
  │   │   ├─ bootFromCache()  ←closure           ├─ lock()           ←local
  │   │   └─ transactStores() ←module            ├─ unlock()         ←local
  │   └─ ... other builder methods               ├─ persistKeys()    ←local
  └─ bytesEqual() ←module                        ├─ clearCache()     ←local
                                                  ├─ bootFromCache()  ←local
                                                  ├─ transactStores() ←local
                                                  └─ bytesEqual()     ←local
```

### Testing improvement

Before: every encryption test creates a full workspace:
```typescript
function setupLifecycle() {
    const posts = defineTable(type({ id: 'string', title: 'string', _v: '1' }));
    const client = createWorkspace(
        defineWorkspace({ id: 'lifecycle-enc-test', tables: { posts } }),
    ).withEncryption();
    return { client };
}
```

After: test the runtime directly with minimal fixtures:
```typescript
function setup(opts?: { userKeyStore?: UserKeyStore }) {
    const ydoc = new Y.Doc();
    const stores = [
        createEncryptedYkvLww(ydoc.getArray('table:posts')),
        createEncryptedYkvLww(ydoc.getArray('kv')),
    ];
    return createEncryptionRuntime({
        workspaceId: 'test',
        stores,
        userKeyStore: opts?.userKeyStore,
    });
}
```

Existing integration tests in `create-workspace.test.ts` remain untouched. They verify the wiring between the builder and the runtime.

## What doesn't change

- **`types.ts`**: all public types stay (WorkspaceEncryption, EncryptionConfig, WorkspaceKeyAccess). Only `WorkspaceClientWithActions` is removed.
- **`lifecycle.ts`**: untouched
- **`encryption-key.ts`**: untouched
- **`user-key-store.ts`**: untouched
- **Builder pattern**: `buildClient`, `BuilderState`, `applyWorkspaceExtension` stay in create-workspace.ts
- **Public API**: zero breaking changes, `createWorkspace().withEncryption()` works identically

## Todo

- [x] Create `encryption-runtime.ts` with `createEncryptionRuntime()`, `bytesEqual()`, `transactStores()`
- [x] Update `create-workspace.ts`: remove inlined encryption code, import and call `createEncryptionRuntime()`
- [x] Remove `bytesEqual` and `transactStores` from `create-workspace.ts`
- [x] Delete `WorkspaceClientWithActions` from `types.ts` and its re-exports from `workspace/index.ts` and `src/index.ts`
- [x] Add `encryption-runtime.test.ts` with isolated unit tests
- [x] Verify all existing tests pass (`bun test` in workspace package)

## Review

### Changes made

**New file: `encryption-runtime.ts` (242 lines)**
- `bytesEqual()` and `transactStores()` moved here from `create-workspace.ts`
- `createEncryptionRuntime()` takes explicit `{ workspaceId, stores, userKeyStore? }` config
- Returns `{ encryption, lock, clearCache, bootPromise? }`: the shape the builder consumes
- All encryption state (`encryptionState`, `persisted`, `cacheQueue`) is local to the function, not captured via closures from outer scope

**New file: `encryption-runtime.test.ts` (281 lines)**
- 17 isolated tests covering lock/unlock, dedup, key rotation, userKeyStore integration, auto-boot, corrupt cache, bootPromise presence
- Uses minimal fixtures (Y.Doc + 2 encrypted stores) instead of full workspace construction

**Modified: `create-workspace.ts` (591 lines, was 761)**
- `withEncryption()` collapsed from ~160 lines to ~30 lines: calls `createEncryptionRuntime()` and wires `bootPromise` into builder state
- Removed `bytesEqual`, `transactStores`, `EncryptionRuntime` type, unused imports (`base64ToBytes`, `deriveWorkspaceKey`, `EncryptionKeysSchema`, `type` from arktype, `EncryptionKeysJson`, `EncryptionKey`, `TableHelper`)
- Added `WorkspaceEncryption` to types import (needed for inlined `buildClient` parameter type)
- Net: -170 lines

**Modified: `types.ts` (1568 lines, was 1599)**
- Removed `WorkspaceClientWithActions` type alias (dead: never imported by any consumer)
- Updated `AnyWorkspaceClient` doc comment to remove stale reference

**Modified: `workspace/index.ts`, `src/index.ts`**
- Removed `WorkspaceClientWithActions` re-exports

### Test results

68 tests, 0 failures across `create-workspace.test.ts` and `encryption-runtime.test.ts`.
All existing integration tests pass unchanged. The extraction is a pure refactor with zero API changes.
