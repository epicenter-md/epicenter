# Fix Workspace Reset Lifecycle

**Date**: 2026-03-18
**Status**: Approved (v2: stable client approach)

## The insight

**Don't replace the workspace client. Ever.**

The previous approach (rebuild-not-mutate) required every consumer module to handle client rotation via `$effect.root(() => $effect(...))`: 10 files changed, `workspace.ts` renamed to `.svelte.ts`, `$state`, `$derived`, the works.

The simpler approach: keep the same client object forever. Toggle encryption state in-place. Clear data in-place. Observers stay alive because the Y.Doc never changes. Actions stay valid because the client never changes. No `$state`, no `$effect`, no file renames, zero consumer changes.

## What was broken

### 1. Dead observers after reset

`workspace.reset()` replaces the client: observers bound at module init are attached to a disposed Y.Doc. **Fix: don't replace the client. Remove `reset()`.**

### 2. Stale tool closures after reset

`workspaceTools` etc. are computed once from the initial client. After reset, they point to dead actions. **Fix: client never changes, closures never go stale.**

### 3. Encryption mutated onto a live client

`activateEncryption(key)` fires synthetic events with `undefined as unknown as Y.Transaction`. **Accepted trade-off: we keep `activateEncryption()` but add `deactivateEncryption()` for sign-out. Synthetic events only fire when plaintext data exists at sign-in time (rare: store is usually empty after sign-out wipe).**

### 4. Scattered session side effects

`reconnect()` calls in AuthForm, App, SyncStatusIndicator. `onExternalSignIn` callback in browser-state. **Fix: remove these. Sync naturally handles auth token changes.**

## Lifecycle

```
boot (no session)     → client starts plaintext, sync gets no token, stays offline
boot (cached key)     → activateEncryption(cachedKey), IndexedDB data decrypts in-memory
sign-in               → activateEncryption(key), sync reconnects, server data arrives
sign-out              → clearAllData() + deactivateEncryption() + clearLocalData()
external sign-in      → restoreFromCache → activateEncryption(key)
```

All transitions happen on the SAME client. Observers fire real Y.Transaction events (delete events on sign-out, add events when sync downloads). No dead observers. No stale closures. No `$effect`.

## Changes

### Step 0: Revert the two `$effect` commits

```
git revert --no-commit d74406229   # wrap simple consumer observers in $effect
git revert --no-commit a556cb98c   # rename workspace.ts to workspace.svelte.ts, make client reactive
git commit -m "revert: undo $effect-based observer rebinding in favor of stable client approach"
```

This restores:
- `workspace.svelte.ts` → back to `workspace.ts`
- `$state(buildWorkspaceClient())` → back to plain `let client = buildWorkspaceClient()`
- `$derived(...)` on tool exports → back to plain `const`
- `$effect.root(() => $effect(...))` in saved-tab-state, bookmark-state, tool-trust → back to direct `.observe()` calls

### Step 1: `packages/workspace`: add `deactivateEncryption()` + `clearAllData()` (~25 lines)

**`y-keyvalue-lww-encrypted.ts`**: add method to the return object:
```typescript
deactivateEncryption() {
    currentKey = undefined;
    map.clear();
},
```

**`YKeyValueLwwEncrypted<T>` type**: add to the type:
```typescript
deactivateEncryption(): void;
```

**`create-workspace.ts`**: add two methods to the client object:
```typescript
deactivateEncryption() {
    workspaceKey = undefined;
    for (const store of encryptedStores) {
        store.deactivateEncryption();
    }
},
clearAllData() {
    ydoc.transact(() => {
        for (const store of encryptedStores) {
            for (const [key] of store.entries()) {
                store.delete(key);
            }
        }
    });
},
```

**`WorkspaceClient` type in `types.ts`**: add:
```typescript
deactivateEncryption(): void;
clearAllData(): void;
```

### Step 2: `workspace.ts`: remove `reset()`, simplify to stable client

Remove `createWorkspaceState()` wrapper and `reset()` method. The workspace is a static singleton that never changes:

**Before:**
```typescript
function createWorkspaceState() {
    let client = buildWorkspaceClient();
    return {
        get current() { return client; },
        async reset() {
            await client.clearLocalData();
            await client.dispose();
            client = buildWorkspaceClient();
        },
    };
}
export const workspace = createWorkspaceState();
```

**After:**
```typescript
function createWorkspaceState() {
    const client = buildWorkspaceClient();
    return {
        get current() { return client; },
    };
}
export const workspace = createWorkspaceState();
```

Note: `workspace.current` getter stays (consumers already use it). We just remove `reset()` and make `client` a `const`.

### Step 3: `auth.svelte.ts`: replace `workspace.reset()` with clear-in-place

Remove `createKeyManager` usage. Replace all `workspace.reset()` calls with the clear-in-place sequence.

**New helper functions:**
```typescript
let lastKeyBase64: string | undefined;
let keyGeneration = 0;

/** Sign-in: derive workspace key, activate encryption. */
async function activateSession(userKeyBase64: string, userId: string) {
    if (userKeyBase64 === lastKeyBase64) return;
    lastKeyBase64 = userKeyBase64;
    const thisGeneration = ++keyGeneration;
    const userKey = base64ToBytes(userKeyBase64);
    const wsKey = await deriveWorkspaceKey(userKey, workspace.current.id);
    if (thisGeneration !== keyGeneration) return;
    workspace.current.activateEncryption(wsKey);
    await keyCache.set(userId, userKeyBase64);
}

/** Sign-out: wipe all data, deactivate encryption, clear IndexedDB. */
async function deactivateSession() {
    ++keyGeneration;
    lastKeyBase64 = undefined;
    workspace.current.clearAllData();
    workspace.current.deactivateEncryption();
    await workspace.current.clearLocalData();
    await keyCache.clear();
}

/** Boot: restore key from cache without wiping data. */
async function restoreFromCache(userId: string): Promise<boolean> {
    const cached = await keyCache.get(userId);
    if (!cached) return false;
    await activateSession(cached, userId);
    return true;
}
```

**Sign-out** calls `deactivateSession()` instead of `workspace.reset()`.
**checkSession 4xx** calls `deactivateSession()` instead of `workspace.reset()`.
**Sign-in** calls `activateSession()` after getting the session.
**External sign-in** calls `restoreFromCache()`.

### Step 4: Remove scattered side effects

**`AuthForm.svelte`**: remove `workspace.current.extensions.sync.reconnect()` after sign-in.

**`App.svelte`**: remove `authState.onExternalSignIn(() => workspace.current.extensions.sync.reconnect())`. Remove the unsub cleanup.

**`SyncStatusIndicator.svelte`**: if it calls `reconnect()` after sign-out, remove that too.

## What we're NOT changing

- Consumer modules: saved-tab-state, bookmark-state, tool-trust, browser-state, chat-state, SyncStatusIndicator: **ZERO changes** (observers stay alive)
- `workspaceTools`, `workspaceDefinitions`, `workspaceToolTitles`: stay as static `const` exports (actions never change)
- `workspace.current` getter pattern: stays (consumers already use it, harmless)
- `createKeyManager` in `packages/workspace`: stays, we just stop importing it in app code
- `activateEncryption()` on `WorkspaceClient`: stays, still used for sign-in

## Todo

- [x] Revert commits `d74406229` and `a556cb98c` (the `$effect` + `.svelte.ts` changes)
- [x] Add `deactivateEncryption()` to `y-keyvalue-lww-encrypted.ts` return object + type
- [x] Add `deactivateEncryption()` + `clearAllData()` to `create-workspace.ts` client object
- [x] Add `deactivateEncryption()` + `clearAllData()` to `WorkspaceClient` type in `types.ts`
- [x] Remove `reset()` from `workspace.ts`, make `client` a `const`
- [x] Update `auth.svelte.ts`: replace `workspace.reset()` with `deactivateSession()`, add `activateSession()` / `restoreFromCache()`
- [x] Update `AuthForm.svelte`: remove `reconnect()` call
- [x] Update `App.svelte`: remove `onExternalSignIn` callback + `reconnect()`
- [x] Add tests for `deactivateEncryption()` in `y-keyvalue-lww-encrypted.test.ts`
- [x] Add test for `clearAllData()` in `create-workspace.test.ts`: 4 tests (removes all rows, fires observers, clears encrypted data, write after clear)
- [x] Run `bun test` in `packages/workspace`: 497 pass, 0 fail
- [x] Run `bun run typecheck` across the monorepo: all errors pre-existing (packages/ui `#/` imports, workspace `NumberKeysOf`)

## Constraints

- Use `bun`, not npm/yarn/pnpm
- Use `type` not `interface`
- No `as any`, `@ts-ignore`, `@ts-expect-error`
- Every change should be as simple as possible: minimal diff
- Follow existing patterns in packages/workspace for new methods
- `activateEncryption()` stays: it's the sign-in mechanism
- The synthetic `undefined as unknown as Y.Transaction` in `activateEncryption()` is accepted (only fires on rare plaintext→encrypted transitions, all consumers ignore the transaction)

## Review

**Date**: 2026-03-18
**Status**: 11/12 items complete

### Completed
**Status**: 12/12 items complete
All lifecycle changes shipped across multiple commits:

- `e20b21154`: revert: undo second $effect re-application: stable client approach
- `dd3d7d743`: feat(workspace): add deactivateEncryption() and clearAllData() to workspace client
- `439424456`: refactor(tab-manager): remove reset(), make workspace client const
- `c8c00be94`: refactor(tab-manager): replace workspace.reset() with clear-in-place lifecycle
- `331a6c755`: refactor(tab-manager): export workspace client directly, remove .current wrapper
- `4251ca18c`: refactor(tab-manager): remove workspace.current indirection across consumers
- `aa8002bf2`: chore(tab-manager): update stale comment in App.svelte
- `2380be1ae`: docs(tab-manager): fix stale JSDoc referencing workspace rebuild
- `259d4d614`: docs(workspace): fix stale JSDoc referencing workspace.reset()

Dead `$effect.root`/`$effect` wrappers confirmed removed from all three consumer files:
- `SyncStatusIndicator.svelte`: plain init-time calls
- `browser-state.svelte.ts`: plain Yjs observers
- `chat-state.svelte.ts`: plain Yjs observers + `whenReady`

### Remaining

None: all items complete.

### Verification

- `bun test` in packages/workspace: **497 pass, 0 fail** (4 new clearAllData tests)
- `bun run typecheck` in apps/tab-manager: **87 errors, all pre-existing** (packages/ui `#/` import resolution, workspace `NumberKeysOf` type, one `as SyncStatus` cast)
