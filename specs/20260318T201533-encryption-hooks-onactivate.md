# Add `onActivate` hook to `.withEncryption()`: eliminate split cache responsibility

Status: **Implemented**

## How We Got Here

The `workspace-owns-encryption-lifecycle` refactor moved encryption from a standalone `KeyManager` into `workspace.withEncryption()`. The workspace now owns HKDF derivation, dedup, race protection, and the `onDeactivate` hook.

But it left cache *writes* as the consumer's problem. After every `activateEncryption()` call, `auth.svelte.ts` manually calls `keyCache.set()`. We extracted an `activateAndCacheKey` helper to deduplicate this, but the smell remained: why is the workspace responsible for clearing the cache (via `onDeactivate`) but not for saving to it?

The answer was that `activateEncryption` receives `Uint8Array` and the cache needs a `userId` + base64 string. But stepping back:

1. **The cache doesn't need `userId`.** `deactivateEncryption` always calls `clear()` which wipes ALL cached keys. There's only ever one active key. The userId scoping was inherited from the old `KeyManager` and serves no purpose now.
2. **The workspace can convert bytes to base64.** It already imports `bytesToBase64` from its own crypto module.

So the real fix is symmetric hooks: `onActivate(userKey)` and `onDeactivate()`. The consumer creates their cache outside the workspace, passes callbacks that close over it, and the workspace fires them at the right time. No new interface types, no `restoreFromCache` method, no scope creep.

## Design

### Before (current)

```typescript
// workspace.ts: workspace knows about deactivation only
.withEncryption({
  onDeactivate: () => keyCache.clear(),
})

// auth.svelte.ts: auth manually manages cache writes
async function activateAndCacheKey(encryptionKey: string, userId: string) {
  await workspace.activateEncryption(base64ToBytes(encryptionKey));
  await keyCache.set(userId, encryptionKey);
}

// restore from cache: auth reads cache and activates
const cached = await keyCache.get(userId);
if (cached) await workspace.activateEncryption(base64ToBytes(cached));
```

### After

```typescript
// workspace.ts: workspace fires hooks on both transitions
.withEncryption({
  onActivate: (userKey) => keyCache.save(bytesToBase64(userKey)),
  onDeactivate: () => keyCache.clear(),
})

// auth.svelte.ts: just activates. cache write is automatic.
await workspace.activateEncryption(base64ToBytes(session.encryptionKey));

// restore from cache: auth still reads cache and activates
// (onActivate fires, cache save is an idempotent overwrite: same key)
const cached = await keyCache.load();
if (cached) await workspace.activateEncryption(base64ToBytes(cached));
```

### What changes

| Concern | Before | After |
|---|---|---|
| Cache write after activation | Manual in auth (`activateAndCacheKey`) | Automatic via `onActivate` hook |
| Cache clear on deactivation | `onDeactivate` hook (unchanged) | `onDeactivate` hook (unchanged) |
| Cache restore on reopen | Manual in auth (2 lines) | Manual in auth (2 lines, unchanged) |
| `KeyCache` interface | `set(userId, b64)`, `get(userId)`, `clear()` | `save(b64)`, `load()`, `clear()`: no userId |
| `activateAndCacheKey` helper | Exists in auth.svelte.ts | Deleted |

### Why `restoreFromCache` is NOT a method on the workspace

The workspace doesn't know *when* to restore, that's a UI/auth decision (sidebar reopen, token found in storage, session validated). Adding `restoreFromCache()` to the workspace would either require the consumer to call it manually (no different from 2 lines of inline code) or require the workspace to know about UI lifecycle events. Two lines in auth is the right answer:

```typescript
const cached = await keyCache.load();
if (cached) await workspace.activateEncryption(base64ToBytes(cached));
```

### `onActivate` fires AFTER successful activation

The hook fires after HKDF derivation succeeds AND the stores are activated, not before, not on dedup skip. This means:
- First activation with key A → `onActivate(keyA)` fires, cache saves key A
- Second activation with same key A → dedup skips, `onActivate` does NOT fire (no work done)
- Activation with new key B → `onActivate(keyB)` fires, cache saves key B
- Restore from cache with key A → `onActivate(keyA)` fires, cache overwrites with same value (idempotent)

## Todo

- [x] Simplify `KeyCache` interface: `set(userId, b64)`/`get(userId)` → `save(b64)`/`load()` (keep `clear()` as-is)
- [x] Update `key-cache.ts` JSDoc: remove userId references, update examples and "How It Fits" diagram
- [x] Add `onActivate` to `EncryptionConfig` type in `types.ts`
- [x] Update `EncryptionConfig` JSDoc: remove "only one hook" phrasing, document symmetric hooks
- [x] Update `EncryptionMethods` JSDoc: note that `onActivate` fires after successful activation (not on dedup skip)
- [x] Call `onActivate` in `withEncryption()` implementation in `create-workspace.ts`: after HKDF + store activation, before return
- [x] Update `withEncryption` inline comments: add onActivate to activation pipeline
- [x] Update module-level JSDoc encryption flow diagram in `create-workspace.ts`
- [x] Update `apps/tab-manager/src/lib/state/key-cache.ts`: remove userId from `set`/`get`, rename to `save`/`load`, simplify storage key to just `'ek'`
- [x] Update `apps/tab-manager/src/lib/workspace.ts`: add `onActivate` to `.withEncryption()` config
- [x] Update `apps/tab-manager/src/lib/state/auth.svelte.ts`: delete `activateAndCacheKey`, remove all `keyCache.set`/`keyCache.get` calls, simplify restore-from-cache to use `keyCache.load()`
- [x] Keep `import { keyCache }` in `auth.svelte.ts`: still needed for `keyCache.load()` reads
- [x] Add test: `onActivate` fires after successful activation with the userKey
- [x] Add test: `onActivate` does NOT fire on dedup skip (same key twice)
- [x] Add test: `onActivate` does NOT fire when HKDF fails
- [x] Add test: `onActivate` does NOT fire when activation is superseded by race (stale generation)
- [x] Run `bun test packages/workspace/`: 494 pass, 0 fail
- [x] Run `bun run typecheck` in `apps/tab-manager/`: only pre-existing errors (87 errors, all in `packages/ui` path aliases)

## Constraints

- `onActivate` receives `Uint8Array` (the raw userKey bytes, same as what was passed to `activateEncryption`)
- `onActivate` is called AFTER stores are activated, not before: if HKDF fails or the call is stale, the hook doesn't fire
- `onActivate` is optional: workspaces without caching needs (Whispering, CLI) just don't pass it
- `onDeactivate` behavior is unchanged
- The `KeyCache` interface loses userId scoping: `save(b64)` replaces `set(userId, b64)`, `load()` replaces `get(userId)`
- `clear()` is unchanged (already clears all keys regardless of userId)
- No new methods on the workspace client (`restoreFromCache` is explicitly out of scope)
- Use `type` not `interface`

## Non-goals

- `restoreFromCache()` method on the workspace (consumer owns restore timing)
- Auto-restore at workspace construction time (workspace doesn't know about UI lifecycle)
- Changing `activateEncryption` signature (stays `Uint8Array`)

## Review

**Completed**: 2026-03-18

### Summary

Added symmetric `onActivate`/`onDeactivate` hooks to `.withEncryption()`. The workspace now owns both transitions. Cache writes happen automatically via `onActivate` after successful HKDF derivation + store activation. The `KeyCache` interface was simplified to drop userId scoping (`save`/`load`/`clear` instead of `set(userId)`/`get(userId)`/`clear`). The tab-manager's `activateAndCacheKey` helper was deleted entirely. All cache writes flow through the hook.

### Deviations from Spec

- Spec item "Remove `import { keyCache }` from `auth.svelte.ts`" was changed to "Keep": `keyCache.load()` is still called in auth for restore-from-cache reads, so the import stays.

### Files Changed

| File | Change |
|------|--------|
| `packages/workspace/src/shared/crypto/key-cache.ts` | `set/get` → `save/load`, drop userId |
| `packages/workspace/src/workspace/types.ts` | Add `onActivate` to `EncryptionConfig`, update JSDoc |
| `packages/workspace/src/workspace/create-workspace.ts` | Call `onActivate` after store activation, update pipeline docs |
| `packages/workspace/src/workspace/create-workspace.test.ts` | 4 new tests for onActivate behavior |
| `apps/tab-manager/src/lib/state/key-cache.ts` | Implement simplified `save/load/clear` with `'ek'` key |
| `apps/tab-manager/src/lib/workspace.ts` | Add `onActivate` hook + `bytesToBase64` import |
| `apps/tab-manager/src/lib/state/auth.svelte.ts` | Delete `activateAndCacheKey`, simplify cache reads |
