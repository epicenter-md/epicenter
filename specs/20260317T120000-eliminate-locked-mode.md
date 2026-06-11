# Eliminate Locked Mode from Encrypted KV Wrapper

## Problem

The encrypted KV wrapper (`y-keyvalue-lww-encrypted.ts`) has a three-state encryption state machine: `plaintext → encrypted → locked`. The `locked` state was designed for a theoretical transient auth gap that doesn't exist. Better Auth uses 7-day server-side sessions with no token rotation. The only trigger for `locked` is explicit sign-out.

When locked, `set()` throws an unhandled `Error`. This crashes 37+ call sites across the tab manager (plaintext of which catch it). Browser event listeners keep firing after sign-out, calling `tables.tabs.set()` on every tab event, causing silent crashes and partially-applied `batch()` transactions.

The error-handling convention (wellcrafted `trySync`/`tryAsync`) says: return errors, don't throw for expected conditions.

## Decision Record

Discussed and decided:

- **Locked mode serves no purpose.** No transient auth gap exists. It only triggers on explicit sign-out.
- **Eliminating locked mode, not just making it harmless.** Cleaner model. Two states (`plaintext`, `encrypted`) instead of three.
- **Full local functionality when signed out.** The workspace exists in `plaintext` (unencrypted) state. User can view tabs, create bookmarks, use chat. Just not synced.
- **Re-download on sign-in is acceptable.** Sign-in creates a fresh encrypted workspace and syncs from server. Tab data is small (few KB), takes ~1 second.
- **Encrypt all plaintext entries on activateEncryption.** When transitioning `plaintext → encrypted`, `activateEncryption()` encrypts any existing plaintext entries in the CRDT. Guarantees a single invariant: after `activateEncryption()`, everything is encrypted.
- **Workspace client becomes recreatable.** Follows the existing `$state` + getter pattern used by `authState`, `authToken`, etc. in `.svelte.ts` modules.
- **`EncryptionState` keeps its current naming.** The type becomes `'plaintext' | 'encrypted'` (removing `'locked'`). These names are descriptive and unambiguous for a two-state system. No rename needed.

## Architecture

### Current State Machine

```
plaintext ──(activateEncryption)──→ encrypted ──(lock)──→ locked ──(activateEncryption)──→ encrypted
                      ↑                           ↑
               set() encrypts              set() THROWS
               reads decrypt               reads return cache
```

### New State Machine

```
plaintext ──(activateEncryption)──→ encrypted ──(sign-out: destroy + recreate)──→ plaintext
  ↑                   ↑
  set() writes         set() encrypts
  reads passthrough    reads decrypt
```

No locked state. Sign-out destroys the workspace and creates a fresh `plaintext` instance. Sign-in calls `activateEncryption(key)` which encrypts existing plaintext entries and transitions to `encrypted`.

### Workspace Lifecycle

```
App launch (no auth)          → workspace in 'plaintext' state (local-only, functional)
Sign-in                       → activateEncryption(key) encrypts plaintext entries, sync connects, server data downloads
Normal use                    → 'encrypted' (encrypted, synced)
Sign-out                      → destroy workspace + clear IndexedDB, create fresh workspace in 'plaintext' state
                                Browser state re-seeded from chrome.tabs.query()
App launch (has cached token) → workspace created, activateEncryption(key), sync connects
```

### Workspace Client Pattern

**Before** (static const, never recreated):
```typescript
// workspace.ts
export const workspaceClient = createWorkspace(...).withExtension(...);

// consumers
import { workspaceClient } from '$lib/workspace';
workspaceClient.tables.tabs.set(row);
```

**After** (recreatable, reactive):
```typescript
// workspace.svelte.ts
function createWorkspaceState() {
    let client = $state(buildWorkspaceClient());

    function buildWorkspaceClient() {
        return createWorkspace(definition)
            .withExtension('persistence', indexeddbPersistence)
            .withExtension('broadcast', broadcastChannelSync)
            .withExtension('sync', createSyncExtension({...}))
            .withActions(({ tables }) => ({...}));
    }

    return {
        get current() { return client; },
        async reset() {
            await client.destroy();
            // clear IndexedDB for this workspace
            client = buildWorkspaceClient();
        },
    };
}
export const workspace = createWorkspaceState();

// consumers
import { workspace } from '$lib/workspace';
workspace.current.tables.tabs.set(row);
```

This follows the same pattern as `authToken`, `authUser`, `remoteServerUrl` in the codebase: `$state` inside a factory function, exported as a module-level singleton, accessed via `.current` getter.

### Encrypt-on-Unlock

When `activateEncryption(key)` transitions from `plaintext` to `encrypted`, it:
1. Sets the encryption key
2. Scans all entries in the inner Y.Array
3. Any entry that is NOT an `EncryptedBlob` (i.e., plaintext) gets encrypted in-place: `inner.set(key, encryptValue(JSON.stringify(val), key))`
4. Rebuilds the decrypted cache (`wrapper.map`)
5. Emits synthetic change events

Performance: XChaCha20-Poly1305 encrypts 1KB in ~0.01ms. 500 entries < 5ms. Negligible.

This guarantees: after `activateEncryption()`, every entry in the CRDT is encrypted. No mixed formats.

## Todo

### Phase 1: packages/workspace: Remove locked state

- [ ] Remove `'locked'` from `EncryptionState` type (keep `'plaintext'` and `'encrypted'` only)
- [ ] Remove `lock()` method from `YKeyValueLwwEncrypted`
- [ ] Remove both `throw` statements from `set()` (the `encryptionState === 'locked'` guard and the `!currentKey` guard become unreachable)
- [ ] Add encrypt-on-activateEncryption to `activateEncryption()`: scan inner entries, encrypt any plaintext values in-place
- [ ] Remove `lock()` from `createWorkspace` client object
- [ ] Remove `lock()` from `WorkspaceClient` type in `types.ts`
- [ ] Update JSDoc comments that reference locked mode
- [ ] Update/remove tests for locked mode behavior (`set() throws while locked`, `get() returns cached plaintext while locked`, etc.)
- [ ] Add tests for the new encrypt-on-activateEncryption behavior
- [ ] Run `bun test` in packages/workspace to verify

### Phase 2: apps/tab-manager: Recreatable workspace

- [ ] Rename `workspace.ts` → `workspace.svelte.ts`
- [ ] Wrap workspace client in `$state` + factory pattern (`.current` getter + `reset()` method)
- [ ] Export `workspace` instead of `workspaceClient`
- [ ] Also export derived convenience re-exports (`workspaceTools`, `workspaceDefinitions`, `workspaceToolTitles`): these need to be `$derived` from `workspace.current`
- [ ] Update all 10 consumer files to use `workspace.current` instead of `workspaceClient`
- [ ] Update `encryption-wiring.svelte.ts`: replace `workspaceClient.lock()` with `workspace.reset()` on sign-out
- [ ] Update `encryption-wiring.svelte.ts`: replace `workspaceClient.activateEncryption(wsKey)` with `workspace.current.activateEncryption(wsKey)`
- [ ] Update sign-out flow: after `workspace.reset()`, re-seed browser state from `chrome.tabs.query()`
- [ ] Update `SyncStatusIndicator.svelte`: replace `workspaceClient.extensions.sync.reconnect()` with `workspace.current.extensions.sync.reconnect()`
- [ ] Verify browser event listeners work correctly after workspace reset (they should fire harmlessly against the new `plaintext` instance)

### Phase 3: Verify & clean up

- [ ] Run `bun test` in packages/workspace
- [ ] Run `bun run typecheck` across the monorepo
- [ ] Manually verify: app launches in `plaintext` state → sign in → data syncs → sign out → fresh `plaintext` workspace → sign back in → data re-downloads
- [ ] Check that no references to `lock()`, `'locked'`, or `EncryptionState` with three values remain

## Open Questions

1. **IndexedDB clearing**: Does `client.destroy()` clear IndexedDB, or do we need to explicitly delete the IndexedDB database? Need to check what `indexeddbPersistence`'s `destroy()` does.
2. **Browser listener lifecycle**: Currently listeners fire continuously. After workspace reset, they write to the new `plaintext` instance (harmless). Should we also unregister/re-register listeners on sign-out/sign-in for cleanliness? (Deferred: the reset handles it.)
3. **Honeycrisp (notes app)**: Does it also have an encrypted workspace? If so, it needs the same treatment. (Separate spec if so.)
4. **Actions re-derivation**: `workspaceTools` and `workspaceDefinitions` are derived from `workspaceClient.actions`. After the workspace becomes recreatable, these need to be `$derived` so they update when the workspace resets. Need to verify this works with the AI tool system.

## Review

### Phase 1: packages/workspace (complete)

**EncryptionState** reduced from `'plaintext' | 'locked' | 'encrypted'` to `'plaintext' | 'encrypted'`.

**`lock()` removed** from:
- `YKeyValueLwwEncrypted<T>` type and implementation
- `createWorkspace` client object
- `WorkspaceClient` type in types.ts

**`set()` simplified**: removed the `encryptionState === 'locked'` throw guard. The `encryptionState === 'plaintext'` plaintext passthrough stays. A defensive `!currentKey` guard remains with message `'Encryption key missing in encrypted state: this is a bug'` (should never fire in practice).

**Encrypt-on-activateEncryption**: `activateEncryption()` now scans `inner.map` for plaintext entries (`!isEncryptedBlob(entry.val)`) and encrypts them in-place via `inner.set(key, encryptValue(...))`. This fires during plaintext→encrypted transitions. During encrypted→encrypted key rotations, all entries are already encrypted blobs so the loop is a no-op.

**`clearLocalData()`** no longer calls `lock()`: it just iterates clearData callbacks.

**`activateEncryption()` rollback** in createWorkspace simplified: removed the try/catch that re-locked stores on failure. All stores use the same key, so if one fails they all fail.

**JSDoc** updated throughout: "Three-Mode" → "Two-State", LOCKED removed from ASCII diagrams, `lock()` references removed.

**Tests**: Removed locked-mode tests (set throws, get cached, has cached, entries cached, mode transitions involving locked). Updated "passthrough then encrypted" test to expect encrypted blobs after activateEncryption. Added "activateEncryption encrypts existing plaintext entries in-place" test. 490 tests pass, 0 fail.

### Phase 2: apps/tab-manager (complete)

**`workspace.ts` → `workspace.svelte.ts`**: Renamed and wrapped in `$state` + factory pattern.

**`workspace` singleton** with:
- `workspace.current`: getter returning the current client
- `workspace.reset()`: `await client.dispose()` + rebuild fresh client

**Derived exports**: `workspaceTools`, `workspaceDefinitions`, `workspaceToolTitles` are now `$derived` from `workspace.current.actions`.

**Consumer updates** (9 files):
- `auth.svelte.ts`: key manager target changed to proxy that delegates to `workspace.current`; `signOut()` calls `workspace.reset()`
- `tool-trust.svelte.ts`, `saved-tab-state.svelte.ts`, `bookmark-state.svelte.ts`: `workspaceClient` → `workspace.current`
- `browser-state.svelte.ts`: removed `const { tables } = workspaceClient` destructure, use `workspace.current.tables` at each call site
- `chat-state.svelte.ts`: `workspaceClient` → `workspace.current`, kept `workspaceTools`/`workspaceDefinitions` imports
- `AuthForm.svelte`, `SyncStatusIndicator.svelte`, `App.svelte`: `workspaceClient` → `workspace.current`

**Note**: `encryption-wiring.svelte.ts` referenced in the spec does not exist. Encryption wiring is handled through `createKeyManager` in auth.svelte.ts, which calls `client.clearLocalData()` (via `wipe()`) and `client.activateEncryption()` (via `activateEncryption()`). The key manager target was changed to a proxy that always delegates to `workspace.current`, so it tracks workspace resets automatically.

### Open questions resolved

1. **IndexedDB clearing**: `dispose()` calls each extension's `dispose()` in LIFO order. `indexeddbPersistence`'s dispose disconnects the provider but does not delete the IndexedDB database. For a full wipe, `clearLocalData()` calls each extension's `clearData()` callback. The `reset()` method calls `dispose()` (disconnects providers, destroys Y.Doc) then creates a fresh client. IndexedDB from the old session may persist but is ignored by the new client.
2. **Browser listener lifecycle**: Deferred per spec. Listeners fire against the new `'plaintext'` instance harmlessly.
3. **Honeycrisp**: Separate spec needed if applicable.
4. **Actions re-derivation**: Resolved: `workspaceTools` and `workspaceDefinitions` are `$derived` from `workspace.current.actions` and update automatically on reset.
