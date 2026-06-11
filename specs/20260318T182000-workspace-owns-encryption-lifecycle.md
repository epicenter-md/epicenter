# Workspace Owns Encryption Lifecycle

## Problem

The encryption lifecycle is split across three layers:

1. **WorkspaceClient**: has `activateEncryption(derivedKey)` / `deactivateEncryption()` but only does raw key distribution to stores
2. **KeyManager**: wraps workspace, adds dedup + race protection + HKDF derivation + key caching
3. **auth.svelte.ts**: must compose both objects (`keyManager.clearKeys()` + `workspace.deactivateEncryption()`)

This creates three problems:

- **Two-step dance**: sign-out requires calling both `keyManager.clearKeys()` and `workspace.deactivateEncryption()` in sequence. auth.svelte.ts duplicates this at 2 call sites. And **forgets it at 2 others** (the `$effect` token-cleared path and the `!data` branch in `checkSession`). These are real bugs where encryption state leaks after sign-out.
- **Footgun API**: WorkspaceClient exposes `activateEncryption(derivedKey)` publicly. A raw low-level method with no dedup, no race protection, no HKDF. Nobody should call it directly, but it's right there on the type. Apps that don't use encryption (Whispering, CLI) still see these methods on the client.
- **KeyManager is a shim, not a real abstraction**: It exists solely to bridge the async HKDF gap and add dedup/race protection. Its `KeyManagerTarget` interface (`{ id, activateEncryption }`) is just a subset of WorkspaceClient. It doesn't model a meaningful concept. It's plumbing that leaked into architecture.

## Background: How Encryption Actually Works

### Key hierarchy

```
SERVER
  ENCRYPTION_SECRETS env var ("2:secret2,1:secret1")
    → parseEncryptionSecrets() → keyring sorted by version
    → HKDF(SHA-256(current.secret), "user:{userId}")
    → per-user encryption key (base64 string)
    → delivered to client via getSession() response

CLIENT
  session.encryptionKey (base64)                    ← "user key"
    → base64ToBytes()
    → HKDF(userKeyBytes, workspaceId)               ← deriveWorkspaceKey()
    → per-workspace derived key (32 bytes)           ← "workspace key"
    → XChaCha20-Poly1305 encrypt/decrypt per entry
```

Two-level HKDF: server derives per-user key from root secret, client derives per-workspace key from user key. Each workspace gets a unique key even from the same user key.

### Where encryption happens

Encryption is a **store-level value transformation**, not a transport concern:

```
App Code → set('key', value)
  → EncryptedYkvLww → JSON.stringify → encryptValue → Uint8Array blob
  → inner YKeyValueLww (CRDT) → Y.Array entry contains ciphertext
  → Persistence (IndexedDB) stores ciphertext: transparent
  → Sync (WebSocket) transmits ciphertext: transparent
  → Server stores ciphertext: transparent
```

Sync and persistence never see plaintext. They receive Y.Doc binary updates containing encrypted blobs and pass them through unchanged. The server CAN decrypt (it has `ENCRYPTION_SECRETS`), but the sync room doesn't. It just relays binary updates.

### No dependency on sync or persistence ordering

`.withEncryption()` doesn't depend on any extension. Encryption state lives on the workspace's encrypted stores, which are created at workspace construction time (before any extensions). Extensions can be chained in any order:

```typescript
// Both orderings work identically
createWorkspace(def).withEncryption({...}).withExtension('persistence', ...)
createWorkspace(def).withExtension('persistence', ...).withEncryption({...})
```

The only relationship: `deactivateEncryption()` calls `clearData()` on extensions (to wipe IndexedDB). That's the inverse operation and the ordering is irrelevant: `clearDataCallbacks` are accumulated by the builder and iterated at deactivation time.

### Keys only come via getSession()

Keys are NOT delivered through WebSocket (sync extension) or any other channel. The sync extension's `getToken` provides a Better Auth bearer token for authentication, not an encryption key. The Durable Object receives `user.id` and `session` from the auth guard. Never `encryptionKey`.

This means `.withEncryption()` has zero coupling to the sync extension.

## Solution

Move the "hard parts" of KeyManager into WorkspaceClient via a `.withEncryption()` builder method. Delete KeyManager entirely.

### Why KeyManager is not needed

KeyManager's 9 responsibilities and where they naturally live:

| # | Responsibility | Lives in… | Why |
|---|---|---|---|
| 1 | Dedup check (same key → skip) | **Workspace** | Workspace owns key state. It knows if re-activation is redundant. |
| 2 | Generation counter (race protection) | **Workspace** | Protects workspace state from stale async HKDF results. |
| 3 | HKDF derivation (user key → workspace key) | **Workspace (batteries-included)** | `deriveWorkspaceKey` is already in `packages/workspace/src/shared/crypto/`. Same package. |
| 4 | Base64 → bytes conversion | **Caller** | Encoding is not encryption. Auth knows the wire format. |
| 5 | Apply key to stores | **Already in workspace** | `store.activateEncryption(derivedKey)` loop. |
| 6 | Key fingerprint invalidation | **Workspace** | Part of dedup state (#1). Lives with it. |
| 7 | Key caching (set) | **Caller** | Platform-specific: `chrome.storage.session` for extensions, could differ for desktop. |
| 8 | Cache clearing | **Workspace (via hook)** | Workspace triggers it via `onDeactivate` callback. Caller provides implementation. |
| 9 | Cache restore orchestration | **Caller** | App-level: read cache → base64ToBytes → workspace.activateEncryption. |

Items 1-3, 5-6, 8 move into workspace. Items 4, 7, 9 stay in the caller. Nothing remains that justifies a standalone `KeyManager` module.

### API change

**Before** (encryption always on the type, footgun without KeyManager):
```typescript
const workspace = createWorkspace(definition)
  .withExtension('persistence', indexeddbPersistence)

// Raw API: no dedup, no race protection, no HKDF
workspace.activateEncryption(derivedKey)   // sync, takes pre-derived key
workspace.deactivateEncryption()            // doesn't clear key cache
```

**After** (encryption only when configured, batteries-included):
```typescript
const workspace = createWorkspace(definition)
  .withEncryption({
    onDeactivate: () => keyCache.clear(),
  })
  .withExtension('persistence', indexeddbPersistence)

// Full pipeline: dedup + HKDF + race protection baked in
await workspace.activateEncryption(userKeyBytes)  // async, takes user key
await workspace.deactivateEncryption()             // also calls onDeactivate hook
workspace.isEncrypted                              // boolean getter
```

**Without `.withEncryption()`** (Whispering, CLI):
```typescript
const workspace = createWorkspace(definition)
  .withExtension('persistence', indexeddbPersistence)

// These methods don't exist on the type
workspace.activateEncryption  // ← TypeScript error
workspace.isEncrypted         // ← TypeScript error
```

### EncryptionConfig

```typescript
type EncryptionConfig = {
  /**
   * Called after deactivateEncryption() completes store cleanup and IndexedDB wipe.
   * Use for platform-specific cleanup like clearing key caches.
   *
   * This is the ONLY hook. No onActivate: asymmetric risk:
   * missing cache-clear leaks keys (security bug),
   * missing cache-set just costs a server roundtrip (UX inconvenience).
   */
  onDeactivate?: () => MaybePromise<void>;
};
```

One key. It earns its keep because:
- Without it, callers must remember the two-step dance (proven to cause bugs)
- The callback is platform-specific (chrome.storage.session, desktop keychain, etc.)
- Workspace can't batteries-include it

No other keys needed:
- `deriveKey` → batteries-included (`deriveWorkspaceKey` is in the same package)
- `onActivate` → doesn't earn its keep (missing cache-set ≠ security bug)
- `keyVersion` → embedded in blob format, not a config concern

### auth.svelte.ts after

```typescript
// No more createKeyManager import. Workspace handles everything.
import { workspace } from '$lib/workspace';
import { keyCache } from './key-cache';
import { base64ToBytes } from '@epicenter/workspace/shared/crypto';

// Sign-in: workspace does HKDF + dedup + race protection internally
async function refreshEncryptionKey() {
  const result = await getSession().catch(() => null);
  if (result?.data?.encryptionKey) {
    const userKey = base64ToBytes(result.data.encryptionKey);
    await workspace.activateEncryption(userKey);
    await keyCache.set(result.data.user.id, result.data.encryptionKey);
  }
}

// Sign-out: ONE call. onDeactivate clears key cache automatically.
async signOut() {
  phase = { status: 'signing-out' };
  await workspace.deactivateEncryption();
  await client.signOut().catch(() => {});
  await clearState().catch(() => {});
  phase = { status: 'signed-out' };
}

// Cache restore: caller orchestrates, workspace does the hard part
async function restoreFromCache(userId: string): Promise<boolean> {
  const cached = await keyCache.get(userId);
  if (!cached) return false;
  await workspace.activateEncryption(base64ToBytes(cached));
  return true;
}

// checkSession 4xx: ONE call instead of three
await clearState();
await workspace.deactivateEncryption();
phase = { status: 'signed-out' };
```

### Leaked sign-out paths: fixed for free

Both existing bugs disappear because every sign-out path just calls `workspace.deactivateEncryption()`:

**Bug 1: `$effect` token cleared (line 133-137)**: encryption state leaks:
```typescript
// BEFORE: no encryption cleanup
if (!authToken.current && phase.status === 'signed-in') {
  void authUser.set(undefined);
  phase = { status: 'signed-out' };
  // ← workspace still encrypted, key cache still has key
}

// AFTER: one call
if (!authToken.current && phase.status === 'signed-in') {
  void authUser.set(undefined);
  void workspace.deactivateEncryption(); // clears stores + IndexedDB + key cache
  phase = { status: 'signed-out' };
}
```

**Bug 2: `!data` branch in checkSession (line 427-431)**: encryption state leaks:
```typescript
// BEFORE: no encryption cleanup
if (!data) {
  await clearState();
  phase = { status: 'signed-out' };
  // ← workspace still encrypted, key cache still has key
}

// AFTER: one call
if (!data) {
  await clearState();
  await workspace.deactivateEncryption();
  phase = { status: 'signed-out' };
}
```

### workspace.ts (tab-manager) after

```typescript
function buildWorkspaceClient() {
  return createWorkspace(definition)
    .withEncryption({
      onDeactivate: () => keyCache.clear(),
    })
    .withExtension('persistence', indexeddbPersistence)
    .withExtension('broadcast', broadcastChannelSync)
    .withExtension('sync', createSyncExtension({
      url: (workspaceId) => `${serverUrl.current}/workspaces/${workspaceId}`,
      getToken: async () => authState.token,
    }))
    .withActions(({ tables }) => ({ ... }));
}
```

### Whispering workspace (unchanged)

```typescript
// No .withEncryption(): no encryption methods on the type
export default createWorkspace(
  defineWorkspace({ id: 'whispering', tables: { ... }, kv: { ... } }),
).withExtension('persistence', indexeddbPersistence);
```

## Implementation

### create-workspace.ts

`.withEncryption(config)` builder method:

1. Imports `deriveWorkspaceKey` from `../shared/crypto/index.js`
2. Adds internal state: `lastUserKey: Uint8Array | undefined`, `keyGeneration: number`
3. Adds `activateEncryption(userKey)`:
   - Byte-compare dedup against `lastUserKey` (early return if equal)
   - `lastUserKey = userKey`
   - `const thisGen = ++keyGeneration`
   - `const wsKey = await deriveWorkspaceKey(userKey, id)`: HKDF
   - Stale check: `if (thisGen !== keyGeneration) return`
   - `workspaceKey = wsKey`
   - `for (store of encryptedStores) store.activateEncryption(wsKey)`
4. Adds `deactivateEncryption()`:
   - `++keyGeneration`: invalidate in-flight HKDF
   - `lastUserKey = undefined`: clear fingerprint
   - `workspaceKey = undefined`
   - `for (store of encryptedStores) store.deactivateEncryption()`
   - `clearDataCallbacks` LIFO iteration (wipe IndexedDB)
   - `await config.onDeactivate?.()`: call hook last
5. Adds `isEncrypted` getter: `workspaceKey !== undefined`
6. Returns a new builder with these methods added to the type

The internal `encryptedStores`, `workspaceKey`, and `clearDataCallbacks` are already closure variables in `buildClient()`. `.withEncryption()` just adds methods that operate on them. No new plumbing needed.

### types.ts

1. Remove `activateEncryption`, `deactivateEncryption`, `isEncrypted` from `WorkspaceClient` base type
2. Add `EncryptionConfig` type
3. Add `EncryptionMethods` type:
   ```typescript
   type EncryptionMethods = {
     readonly isEncrypted: boolean;
     activateEncryption(userKey: Uint8Array): Promise<void>;
     deactivateEncryption(): Promise<void>;
   };
   ```
4. `withEncryption(config)` on `WorkspaceClientBuilder`: returns `WorkspaceClientBuilder & EncryptionMethods`
5. `ExtensionContext`: if encryption is configured, extensions see the encryption methods (sync extension may want to check `isEncrypted` in the future, though it doesn't today)

### Delete

- `packages/workspace/src/shared/crypto/key-manager.ts`: 239 lines
- `packages/workspace/src/shared/crypto/key-manager.test.ts`: all tests
- `createKeyManager`, `KeyManager`, `KeyManagerTarget`, `KeyManagerConfig` exports from `crypto/index.ts`
- `KeyCache` type export from `crypto/index.ts` (only used by key-manager)

### Migrate tests

Key-manager.test.ts tests:
- Dedup (same base64 → no re-derivation)
- Race protection (stale generation → skipped)
- Generation counter (concurrent calls → only latest applies)
- Key cache interactions (set on activate, clear on clearKeys, restore from cache)

These move to `create-workspace.test.ts` and test through the workspace client's `activateEncryption`/`deactivateEncryption` with real encrypted stores. Better integration coverage than the mock-based KeyManager tests.

Specifically:
- Dedup: call `activateEncryption(sameKey)` twice, verify store.activateEncryption called once
- Race: call `activateEncryption(key1)` then immediately `activateEncryption(key2)`, verify only key2 applies
- onDeactivate: call `deactivateEncryption()`, verify hook called after store cleanup
- isEncrypted: verify getter reflects key state

### Update auth.svelte.ts

- Remove `import { createKeyManager }`
- Remove `const keyManager = createKeyManager(workspace, { keyCache })`
- Replace `keyManager.activateEncryption(base64, userId)` with `workspace.activateEncryption(base64ToBytes(base64))` + `keyCache.set(userId, base64)`
- Replace `keyManager.clearKeys()` + `workspace.deactivateEncryption()` with just `workspace.deactivateEncryption()`
- Replace `keyManager.restoreKeyFromCache(userId)` with inline cache read + `workspace.activateEncryption(base64ToBytes(cached))`
- Fix the two leaked sign-out paths (add `workspace.deactivateEncryption()`)
- The `$effect` for token-cleared fires synchronously. Use `void workspace.deactivateEncryption()` (fire-and-forget, same as current `restoreKeyFromCache` pattern)

### Update workspace.ts (tab-manager)

- Add `.withEncryption({ onDeactivate: () => keyCache.clear() })` to builder chain
- Import `keyCache` from `./state/key-cache`

### Update key-cache.ts

- Remove JSDoc example referencing `createKeyManager`
- The `KeyCache` type may move or be deleted if nothing else uses it

## Todo

- [x] Add `EncryptionConfig` and `EncryptionMethods` types to types.ts
- [x] Remove `activateEncryption`, `deactivateEncryption`, `isEncrypted` from base `WorkspaceClient` type
- [x] Add `withEncryption(config)` to `WorkspaceClientBuilder` type. Returns builder with encryption methods
- [x] Implement `.withEncryption()` in create-workspace.ts. Dedup, generation counter, HKDF, onDeactivate hook
- [x] Update `ExtensionContext` so extensions see encryption methods when configured
  > **Note**: No explicit change needed: `ExtensionContext` is `Omit<WorkspaceClient, ...>`, so removing encryption from `WorkspaceClient` automatically removes it. Encryption methods appear when the builder type is intersected with `EncryptionMethods`.
- [x] Update workspace.ts (tab-manager): add `.withEncryption({ onDeactivate })` to builder chain
- [x] Update auth.svelte.ts. Remove createKeyManager, use workspace directly, fix two leaked sign-out paths
- [x] Delete key-manager.ts, key-manager.test.ts, remove re-exports from crypto/index.ts
- [x] Migrate dedup/race/generation/hook tests to create-workspace.test.ts
- [x] Update key-cache.ts JSDoc
- [x] Run `bun test` in packages/workspace (490 pass, 0 fail)
- [x] Run typecheck across monorepo (only pre-existing packages/ui `#/` import errors)

## Constraints

- `.withEncryption()` chains with `.withExtension()` in any order. No ordering dependency
- Without `.withEncryption()`, workspace works exactly as today minus encryption methods on the type
- `deriveWorkspaceKey` is batteries-included. Not configurable
- `onDeactivate` is the only hook. No `onActivate`
- `activateEncryption` returns `Promise<void>` (HKDF is async)
- Must not break Whispering, CLI, or any non-encryption workspace consumer
- Encryption is store-level, transparent to sync and persistence. This doesn't change

## Non-goals

- Key rotation (keyVersion infrastructure exists in blob format but no rotation logic. Separate concern)
- Server-side decryption changes (server already derives keys independently via `ENCRYPTION_SECRETS`)
- Sync extension encryption awareness (sync is and should remain encryption-transparent)

## Review

**Completed**: 2026-03-18
**Branch**: opencode/shiny-meadow

### Summary

Moved encryption lifecycle management from the standalone `KeyManager` factory into the workspace client via a `.withEncryption()` builder method. The workspace now owns dedup (byte-level comparison), race protection (generation counter), HKDF derivation, and the `onDeactivate` hook. All previously split across KeyManager and auth.svelte.ts. Two real bugs in auth.svelte.ts (leaked encryption state on token-cleared `$effect` and `!data` branch in `checkSession`) are fixed for free because every sign-out path now calls a single `workspace.deactivateEncryption()`.

### Deviations from Spec

- **`TEncryption` type parameter**: Added a 7th generic parameter to `WorkspaceClientBuilder` and 8th to `WorkspaceClientWithActions` to thread encryption methods through `.withActions()`. The spec described `withEncryption` returning `Builder & EncryptionMethods`, but that intersection is lost when `.withActions()` returns `WorkspaceClientWithActions`. The type parameter approach preserves the intersection through the entire builder chain.
- **`Object.defineProperty` for `isEncrypted`**: The spec suggested `Object.assign(client, { get isEncrypted() {...} })` but `Object.assign` evaluates getters at copy time rather than preserving them. Used `Object.defineProperty` for the getter and `Object.assign` for the methods.
- **`key-cache.ts` import path**: Updated from `@epicenter/workspace/shared/crypto` to `@epicenter/workspace/shared/crypto/key-cache` since the `KeyCache` re-export was removed from crypto/index.ts. Added corresponding package.json export entry.

### Follow-up Work

- None identified. The spec's scope is fully implemented.
