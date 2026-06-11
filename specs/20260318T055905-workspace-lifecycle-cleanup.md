# Workspace Lifecycle Cleanup

Separate key concerns from workspace concerns. Make `reset()` self-contained. Gate browser-state writes on auth status.

Follows up on `20260317T120000-eliminate-locked-mode.md`.

## Problem

After eliminating locked mode, the sign-out lifecycle has two issues:

1. **Key manager reaches into workspace data.** `keyManager.wipe()` calls `client.clearLocalData()`: a workspace concern that doesn't belong in the key manager. The key manager should only manage keys.

2. **Browser-state listeners keep firing after sign-out.** Chrome event listeners (`tabs.onCreated`, `tabs.onUpdated`, etc.) write tab data into the new empty workspace as plaintext before the user signs back in. Functionally correct (encrypt-on-activateEncryption handles it) but leaves a window of plaintext data in IndexedDB.

## Changes

### Phase 1: Make `reset()` self-contained

**`workspace.reset()` absorbs `clearLocalData()`:**

```typescript
// workspace.ts
async reset() {
    await client.clearLocalData();  // wipe IndexedDB persistence
    await client.dispose();         // tear down sync, Y.Doc
    client = buildWorkspaceClient(); // fresh instance in 'plaintext' mode
}
```

After reset, the new workspace is a clean slate: empty tables, no encryption, no sync connection. Signing in triggers `activateEncryption()` which sets up encryption.

**`keyManager.wipe()` → `keyManager.clearKeys()`:**

```typescript
// key-manager.ts
async clearKeys() {
    invalidateKey();                    // forget key fingerprint + bump generation
    if (keyCache) await keyCache.clear(); // clear IndexedDB key cache
    // NO workspace interaction: that's reset()'s job
}
```

Rename because the method no longer "wipes" workspace data. It only clears key state.

**`KeyManagerTarget` shrinks:**

```typescript
// BEFORE:
type KeyManagerTarget = {
    readonly id: string;
    activateEncryption(key: Uint8Array): void;
    clearLocalData(): Promise<void>;  // ← remove
};

// AFTER:
type KeyManagerTarget = {
    readonly id: string;
    activateEncryption(key: Uint8Array): void;
};
```

**`keyManagerTarget` proxy in auth.svelte.ts shrinks:**

```typescript
// BEFORE:
const keyManagerTarget = {
    get id() { return workspace.current.id; },
    activateEncryption(key) { workspace.current.activateEncryption(key); },
    async clearLocalData() { await workspace.current.clearLocalData(); },  // ← remove
};

// AFTER:
const keyManagerTarget = {
    get id() { return workspace.current.id; },
    activateEncryption(key) { workspace.current.activateEncryption(key); },
};
```

**Sign-out paths simplify:**

```typescript
// Both paths become the same pattern:
await encryption.clearKeys();   // forget key + clear cache
await workspace.reset();        // clear data + dispose + rebuild
```

### Phase 2: Gate browser-state writes on auth status

**Guard every Chrome event listener:**

```typescript
// browser-state.svelte.ts
chrome.tabs.onCreated.addListener((tab) => {
    if (authState.status !== 'signed-in') return;
    // ...existing handler
});
```

This prevents plaintext tab data from being written to IndexedDB between sign-out and sign-in.

**Extract seed logic into a callable function + re-seed on sign-in:**

```typescript
async function seedFromBrowser() {
    const [browserWindows, id] = await Promise.all([
        browser.windows.getAll({ populate: true }),
        getDeviceId(),
    ]);
    // ...existing seed logic currently inside the whenReady IIFE
}

// Initial seed (existing behavior)
const whenReady = seedFromBrowser();

// Re-seed when user signs back in
authState.onExternalSignIn(() => seedFromBrowser());
```

After sign-out, the listeners no-op. When the user signs back in, `onExternalSignIn` fires, re-seeds the workspace with current browser state, and the listeners resume writing.

## Todo

- [ ] Phase 1.1: Fold `clearLocalData()` into `workspace.reset()` in workspace.ts
- [ ] Phase 1.2: Rename `keyManager.wipe()` → `keyManager.clearKeys()` in key-manager.ts
- [ ] Phase 1.3: Remove `clearLocalData` from `KeyManagerTarget` type
- [ ] Phase 1.4: Update `keyManagerTarget` proxy in auth.svelte.ts (remove clearLocalData)
- [ ] Phase 1.5: Update both sign-out paths in auth.svelte.ts (`encryption.wipe()` → `encryption.clearKeys()`)
- [ ] Phase 1.6: Update `KeyManager` type (wipe → clearKeys)
- [ ] Phase 1.7: Update key-manager.test.ts (rename wipe tests, remove clearLocalData assertion)
- [ ] Phase 1.8: Update JSDoc throughout key-manager.ts and types.ts
- [ ] Phase 1.9: Run `bun test` in packages/workspace
- [ ] Phase 2.1: Add auth status guard to all Chrome event listeners in browser-state.svelte.ts
- [ ] Phase 2.2: Extract seed logic from whenReady IIFE into a callable `seedFromBrowser()` function
- [ ] Phase 2.3: Register `authState.onExternalSignIn(() => seedFromBrowser())` for re-seed on sign-in

## Files touched

Phase 1:
- `apps/tab-manager/src/lib/workspace.ts`: reset() absorbs clearLocalData
- `apps/tab-manager/src/lib/state/auth.svelte.ts`: proxy shrinks, wipe→clearKeys
- `packages/workspace/src/shared/crypto/key-manager.ts`: wipe→clearKeys, remove clearLocalData interaction
- `packages/workspace/src/shared/crypto/key-manager.test.ts`: update tests
- `packages/workspace/src/workspace/types.ts`: update JSDoc references

Phase 2:
- `apps/tab-manager/src/lib/state/browser-state.svelte.ts`: auth guard + seedFromBrowser

## Constraints

- `clearLocalData()` stays on the raw `WorkspaceClient` type in `packages/workspace`: other apps (Honeycrisp) may use it directly. Only the tab-manager's wrapper stops exposing it.
- `dispose()` stays on `WorkspaceClient`: it's the standard teardown primitive.
- No behavior changes to encryption or sync: only lifecycle orchestration.
- Every change should be as simple as possible.

## Open Questions

1. **Should `clearLocalData()` also be removed from `WorkspaceClient`?** It's now only called inside `reset()` in the tab-manager. Other apps could still use it. Keep for now; remove if no other app needs it.
2. **Should the auth guard use a dedicated `isWritable` flag instead of `authState.status`?** The guard couples browser-state to auth-state. A dedicated workspace-level flag (`workspace.current.isWritable`) would be cleaner but adds API surface. Defer unless needed.

## Review

_To be filled after implementation._
