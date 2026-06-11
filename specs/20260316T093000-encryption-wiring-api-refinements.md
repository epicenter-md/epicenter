# Key Manager API Refinements

**Date**: 2026-03-16
**Status**: Implemented
**Builds on**: `specs/20260315T141700-encryption-wiring-factory.md` (implemented, then renamed to key-manager), `specs/20260315T083000-keycache-chrome-extension.md` (draft)

## Overview

A design review of the key manager API after the `createEncryptionWiring` → `createKeyManager` rename found four concrete issues: a `this`-binding footgun in the factory return object, a fire-and-forget `wipe()` that can't be awaited during sign-out, a silent failure mode in `deriveAndUnlock`, and a consumer that never passes `userId`. This spec documents each finding, the concrete fix, and the rationale.

## Motivation

### Current State

The factory was implemented per `specs/20260315T141700-encryption-wiring-factory.md` and subsequently renamed from `createEncryptionWiring` to `createKeyManager`, with method names updated to better reflect their purpose:

| Before | After | Rationale |
|---|---|---|
| `createEncryptionWiring(client, config?)` | `createKeyManager(client, config?)` | "Key manager" is a more standard term than "wiring" |
| `EncryptionWiring` | `KeyManager` |: |
| `EncryptionWiringClient` | `KeyManagerTarget` | "Target" communicates the thing the manager acts on |
| `EncryptionWiringConfig` | `KeyManagerConfig` |: |
| `connect(keyBase64, userId?)` | `setKey(keyBase64, userId?)` | "Set key" directly describes what you're doing. Supplying a key. Better than "connect" (networking metaphor) and better than `activateEncryption` (implies synchronous completion, but HKDF derivation is async) |
| `wipeLocalData()` | `wipe()` | Shorter, same meaning. The "local data" was redundant. All data the manager touches is local |
| `loadCachedKey(userId)` | `restoreKey(userId)` | "Restore" communicates intent (resume from cache), matches `setKey` vocabulary |
| `lock()` | `lock()` | Unchanged. Already correct |

The mode-guarding responsibility moved from the key manager to the client during the original implementation. The key manager always calls through to `lock()` / `clearLocalData()` unconditionally, and the `KeyManagerTarget` type doesn't include `mode`.

The current public API:

```typescript
type KeyManager = {
  setKey(userKeyBase64: string, userId?: string): void;
  lock(): void;
  wipe(): void;
  restoreKey(userId: string): Promise<boolean>;
};
```

The current consumer (`apps/tab-manager/src/lib/state/key-manager.svelte.ts`):

```typescript
$effect(() => {
  const key = authState.encryptionKey;
  if (key) {
    keyManager.setKey(key);
  } else if (authState.status === 'signing-out') {
    keyManager.wipe();
  } else {
    keyManager.lock();
  }
});
```

The names are good. But a close read of the implementation surfaces four issues worth fixing before additional consumers adopt the API.

### Problems

1. **`this.setKey()` in `restoreKey` is a destructuring footgun.** The implementation calls `this.setKey(cachedKeyBase64, userId)` from inside `restoreKey`. If anyone destructures: `const { restoreKey } = createKeyManager(client)`: then `this` is `undefined` in strict mode and the call throws. Factory functions that return plain objects should never reference `this`. Every other factory in the codebase (`createSyncExtension`, `createClient`) avoids `this` in the return object.

2. **`wipe()` can't be awaited.** It calls `client.clearLocalData()` (async) and `keyCache.clear()` (async) via fire-and-forget `void`. In a sign-out flow that navigates away immediately, the caller races against data destruction. Returning `Promise<void>` lets callers fire-and-forget (existing behavior preserved with `void keyManager.wipe()`) or `await` when they need the guarantee.

3. **`deriveAndUnlock` swallows errors silently.** The `void deriveWorkspaceKey(...).then(...)` chain has no `.catch()`. If HKDF derivation fails (invalid key data, corrupted bytes), the promise rejects as an unhandled rejection. The workspace stays locked with no indication of why. In test runners that treat unhandled rejections as fatal, this crashes the suite unpredictably.

4. **The Svelte consumer never passes `userId`.** `keyManager.setKey(key)` omits `userId`, so the key is never cached. The factory already warns via `console.warn` when `keyCache` is configured without `userId`, but the consumer doesn't participate. The KeyCache spec (`20260315T083000`) explicitly plans to pass `userId` in Phase 3. The omission is a gap, not a deliberate choice.

### Non-Problems (Things That Are Correct)

The rename from `connect` → `setKey` resolved the naming issue identified in the initial design review. `setKey` is more accurate than `activateEncryption` would have been: the method supplies a key and initiates async derivation. The encryption activation is a side effect that happens later. `setKey`/`lock` is a complementary pair (one provides the key, the other removes it) rather than a symmetric one, and that's honest about what each method does.

The `wipe()` name is clean and sufficient. `restoreKey` communicates intent well. `KeyManagerTarget` is a better name than `EncryptionWiringClient` for the narrow client interface.

## Research Findings

### `this` in Factory Return Objects

The codebase's factory function pattern returns plain objects from closures. These objects get destructured, passed as arguments, and stored in variables. The `this` usage was inherited from the original spec's implementation sketch (`specs/20260315T141700`, line 439: `this.connect(base64, userId)`) and carried through the rename to `this.setKey()`. It works when called as `keyManager.restoreKey(userId)` but breaks under destructuring, which no current consumer does. It's a latent bug waiting for the wrong refactor.

### Fire-and-Forget Audit

Three async operations are currently fire-and-forget:

| Operation | Current handling | Failure mode | Risk |
|---|---|---|---|
| `deriveWorkspaceKey()` | `void promise.then()` | Unhandled rejection | High. Workspace silently stays locked |
| `client.clearLocalData()` | `void client.clearLocalData()` | Internal try/catch | Low. Client handles errors |
| `keyCache.set/clear()` | `void keyCache.set(...)` | Acceptable degradation | Low. Cache miss is not critical |

`deriveWorkspaceKey` is the only operation where silent failure has user-visible consequences (workspace stuck in locked state with no error). The other two degrade gracefully.

### `userId` in the Consumer

`authState` in the tab-manager exposes `authState.user?.id` (reactive, available after `checkSession()`). The consumer could pass it:

```typescript
keyManager.setKey(key, authState.user?.id);
```

The `console.warn` at line 178 of `key-manager.ts` confirms the factory expects `userId` when `keyCache` is configured.

### Stale JSDoc in `key-manager.ts`

The module-level `@example` block at line 21 still references `wiring.lock()` instead of `keyManager.lock()`. The method-level JSDoc at lines 65 and 82 has inconsistent indentation (mixed tabs/spaces from the rename). These are cosmetic but worth fixing in the same pass.

## Design Decisions

| Decision | Choice | Rationale |
|---|---|---|
| Eliminate `this` usage | Yes. Extract `setKeyInternal` private helper | The factory pattern uses closures for privacy; the public API should never reference `this`. Both `setKey()` and `restoreKey()` call the private helper directly. Zero behavioral change. |
| Make `wipe()` async | Yes. Return `Promise<void>` | Enables `await keyManager.wipe()` for sign-out flows that need guaranteed completion. Existing callers use `void keyManager.wipe()` which continues to work unchanged. |
| Add `.catch()` to `deriveAndUnlock` | Yes. Log error, don't rethrow | Surfaces derivation failures visibly instead of creating an unhandled rejection. The workspace stays locked (safe) but the developer sees why. No `onError` callback yet. YAGNI. |
| Pass `userId` in Svelte consumer | Yes | The factory warns when `userId` is missing and `keyCache` is configured. The consumer has access to `authState.user?.id`. Pass it through so caching works when a `KeyCache` implementation is wired in. |
| Fix stale JSDoc references | Yes | Module-level example says `wiring.lock()` instead of `keyManager.lock()`. Fix while we're in the file. |
| Add `delete(userId)` to KeyCache | Defer | Would enable per-user cache removal on multi-user devices. No current consumer needs it. |
| Add `onError` callback to config | Defer | The `.catch()` on `deriveAndUnlock` surfaces the error visibly. Derivation failures are programming errors, not recoverable runtime conditions. |

## Architecture

### Before (Current)

```
createKeyManager(client, config?)
  │
  ├─ Private state: generation, lastKeyBase64, keyCache
  │
  ├─ Private helper: deriveAndUnlock(userKey, gen)
  │     └─ void deriveWorkspaceKey(...).then(wsKey => { ... })  ← no .catch()
  │
  ├─ Private helper: invalidateKey()
  │
  └─ Return object:
       setKey(keyBase64, userId?)
       lock()
       wipe()                        ← returns void
       restoreKey(userId)            ← uses this.setKey()  ← footgun
```

### After (Proposed)

```
createKeyManager(client, config?)
  │
  ├─ Private state: generation, lastKeyBase64, keyCache
  │
  ├─ Private helper: deriveAndUnlock(userKey, gen)
  │     └─ void deriveWorkspaceKey(...).then(...).catch(console.error)  ← visible
  │
  ├─ Private helper: invalidateKey()
  │
  ├─ Private helper: setKeyInternal(keyBase64, userId?)      ← extracted from return
  │     └─ dedup check, generation++, decode, derive, cache
  │
  └─ Return object:
       setKey(keyBase64, userId?)    ← delegates to setKeyInternal
       lock()
       wipe()                        ← returns Promise<void>
       restoreKey(userId)            ← calls setKeyInternal() directly, no this
```

### Consumer Change

```typescript
// Before
$effect(() => {
  const key = authState.encryptionKey;
  if (key) {
    keyManager.setKey(key);
  } else if (authState.status === 'signing-out') {
    keyManager.wipe();
  } else {
    keyManager.lock();
  }
});

// After: only change is userId
$effect(() => {
  const key = authState.encryptionKey;
  if (key) {
    keyManager.setKey(key, authState.user?.id);
  } else if (authState.status === 'signing-out') {
    keyManager.wipe();
  } else {
    keyManager.lock();
  }
});
```

One change: `userId` is now passed to `setKey()`.

### Concrete Implementation Diff

#### 1. Extract `setKeyInternal` from the `setKey` method body

```typescript
// Private helper: extracted from the setKey() method body
function setKeyInternal(userKeyBase64: string, userId?: string) {
  if (userKeyBase64 === lastKeyBase64) return;
  lastKeyBase64 = userKeyBase64;

  const thisGeneration = ++generation;
  const userKey = base64ToBytes(userKeyBase64);

  deriveAndUnlock(userKey, thisGeneration);

  if (keyCache && !userId) {
    console.warn(
      '[key-manager] keyCache configured but no userId provided. Key not cached',
    );
  } else if (userId && keyCache) {
    void keyCache.set(userId, userKeyBase64);
  }
}

// Public API
return {
  setKey(userKeyBase64, userId) {
    setKeyInternal(userKeyBase64, userId);
  },
  // ...
  async restoreKey(userId) {
    if (!keyCache) return false;
    const cachedKeyBase64 = await keyCache.get(userId);
    if (!cachedKeyBase64) return false;
    setKeyInternal(cachedKeyBase64, userId);  // no this
    return true;
  },
};
```

#### 2. Make `wipe()` async

```typescript
async wipe() {
  invalidateKey();
  await client.clearLocalData();
  if (keyCache) void keyCache.clear();
},
```

The `keyCache.clear()` stays fire-and-forget because it's a convenience optimization. The data wipe is the critical operation. Awaiting `wipe()` guarantees data destruction, not cache cleanup.

Callers that don't care still call `void keyManager.wipe()`: zero breaking change.

#### 3. Add `.catch()` to `deriveAndUnlock`

```typescript
function deriveAndUnlock(userKey: Uint8Array, thisGeneration: number) {
  void deriveWorkspaceKey(userKey, client.id)
    .then((wsKey) => {
      if (thisGeneration === generation) client.activateEncryption(wsKey);
    })
    .catch((error) => {
      // Derivation failures are programming errors (invalid key data).
      // Surface them loudly rather than leaving the workspace silently locked.
      console.error('[key-manager] Key derivation failed:', error);
    });
}
```

#### 4. Update `KeyManager` type JSDoc

Method-level JSDoc references to `setKey()` should say "the previous `setKey()`" not "the previous `connect()`" (already correct after rename). The module-level `@example` block at line 21 still references `wiring.lock()`: update to `keyManager.lock()`. Fix inconsistent indentation on lines 65, 82, 95, 104-105.

#### 5. Update consumer to pass `userId`

In `apps/tab-manager/src/lib/state/key-manager.svelte.ts`:

```typescript
if (key) {
  keyManager.setKey(key, authState.user?.id);
}
```

## Edge Cases

### Destructuring After Fix

1. Consumer destructures: `const { setKey, lock, restoreKey } = createKeyManager(client)`
2. `restoreKey('user-1')` is called standalone
3. `setKeyInternal()` fires correctly. No `this` dependency

Expected: Works. The private `setKeyInternal` is captured by closure.

### `await wipe()` When `clearLocalData` Throws

1. Consumer calls `await keyManager.wipe()` during sign-out
2. `client.clearLocalData()` throws (extension cleanup failure)
3. Promise rejects, propagates to caller
4. Consumer catches the error and decides what to do

Expected: Error propagates. Existing fire-and-forget callers using `void keyManager.wipe()` are unaffected.

### `console.error` on Derivation Failure

1. `setKey(invalidBase64, userId)` is called
2. `base64ToBytes` returns garbage
3. `deriveWorkspaceKey` throws inside the Web Crypto API
4. `.catch()` fires, `console.error` prints the error
5. Workspace stays in its previous mode (locked or plaintext)

Expected: Error visible in console. Workspace safe. No state corruption.

### `wipe()` Becoming Async. Type Compatibility

The return type changes from `void` to `Promise<void>`. Existing callers use `void keyManager.wipe()` which works identically: `void` discards the promise. `keyManager.wipe()` without the `void` prefix produces a floating promise lint warning, which is correct behavior. The caller should decide whether to await.

### Tests Still Pass

The test file (`key-manager.test.ts`) calls `wiring.wipe()` (line 181, 194, 289) without awaiting. These calls continue to work because the tests don't need to verify wipe completion. They check that `clearLocalData` was called, which happens synchronously before the await. The `async` change doesn't affect the mock call timing.

`wiring.restoreKey()` tests (lines 246, 254, 266) already `await` the result. After removing `this`, these work identically since the closure captures `setKeyInternal`.

## Open Questions

1. **Should `wipe()` await or fire-and-forget `keyCache.clear()`?**

   The proposed implementation awaits only `client.clearLocalData()` and fire-and-forgets `keyCache.clear()`. The cache is a convenience optimization; the data wipe is the critical operation.

   - Options: (a) `Promise.all`: strict, both must succeed. (b) `Promise.allSettled`: report but don't block on cache failure. (c) Await only `clearLocalData()`, fire-and-forget cache clear.
   - **Recommendation**: Option (c). Awaiting `wipe()` should guarantee data destruction, not cache cleanup. Cache expiration happens naturally when the browser session ends.

2. **Should the factory warn or throw when `setKey()` is called without `userId` and `keyCache` is configured?**

   Currently it `console.warn`s. A stricter approach would throw, forcing the caller to provide `userId` or explicitly pass `undefined`. But throwing on a missing optional parameter is hostile.

   - **Recommendation**: Keep the `console.warn`. It surfaces the issue without breaking the call.

## Implementation Plan

### Phase 1: Extract `setKeyInternal` and fix `this` footgun

- [x] **1.1** Extract `setKeyInternal` private helper from the `setKey()` method body in `key-manager.ts`
- [x] **1.2** Update `restoreKey()` to call `setKeyInternal()` instead of `this.setKey()`
- [x] **1.3** Update `setKey()` in the return object to delegate to `setKeyInternal()`
- [x] **1.4** Verify: `bun test` in `packages/workspace`, `lsp_diagnostics` clean

### Phase 2: Add `.catch()` to `deriveAndUnlock`

- [x] **2.1** Add `.catch((error) => console.error('[key-manager] Key derivation failed:', error))` to the promise chain in `deriveAndUnlock`
- [x] **2.2** Verify: `bun test` passes (no test depends on unhandled rejection behavior)

### Phase 3: Make `wipe()` async

- [x] **3.1** Change `wipe()` return type from `void` to `Promise<void>` in the `KeyManager` type
- [x] **3.2** Add `async` to the method definition
- [x] **3.3** Update the method body: `await client.clearLocalData()` then `if (keyCache) void keyCache.clear()`
- [x] **3.4** Verify consumer still works with `void keyManager.wipe()` (no await needed)
- [x] **3.5** Verify: `bun test`, `lsp_diagnostics` clean
  > **Note**: Test "wipe() clears keyCache" needed `async`/`await` because `keyCache.clear()` now runs after the `await` yield point.

### Phase 4: Fix consumer and JSDoc

- [x] **4.1** Update `key-manager.svelte.ts`: `keyManager.setKey(key)` → `keyManager.setKey(key, authState.user?.id)`
- [x] **4.2** Fix module-level `@example` in `key-manager.ts`: `wiring.lock()` → `keyManager.lock()`
- [x] **4.3** Fix inconsistent indentation on JSDoc lines 65, 82, 95, 104-105 in `key-manager.ts`
- [x] **4.4** Update `KeyManager` type JSDoc to reference `setKey()` consistently (verify no stale `connect()` references)

### Phase 5: Verify across monorepo

- [x] **5.1** Run `bun run typecheck` across the monorepo
  > **Note**: `@epicenter/landing` fails with a pre-existing `tinyexec` module resolution issue, unrelated to these changes.
- [x] **5.2** Run `bun run build` in `apps/tab-manager`
- [x] **5.3** Grep for any remaining `this.setKey` or `this.connect` references in source files
- [x] **5.4** Verify no stale references to old names (`createEncryptionWiring`, `EncryptionWiring`, `wipeLocalData`, `loadCachedKey`) in source `.ts` files (specs are historical. Don't update)
  > **Note**: Fixed stale `// wipeLocalData()` comment in test file section header.

## Success Criteria

- [x] `restoreKey()` no longer uses `this`: calls private `setKeyInternal` via closure
- [x] `deriveAndUnlock` has a `.catch()` that logs errors visibly
- [x] `wipe()` returns `Promise<void>`, existing callers unchanged
- [x] Svelte consumer passes `userId` to `setKey()`
- [x] Module-level JSDoc example uses `keyManager.lock()` not `wiring.lock()`
- [x] No inconsistent indentation in method-level JSDoc
- [x] `bun test` passes in `packages/workspace`
- [x] `bun run typecheck` clean across monorepo (except pre-existing `@epicenter/landing` issue)
- [x] `bun run build` succeeds in `apps/tab-manager`
- [x] No remaining `this.setKey` or `this.connect` references in source files

## References

- `packages/workspace/src/shared/crypto/key-manager.ts`: The factory (primary file to change)
- `packages/workspace/src/shared/crypto/key-manager.test.ts`: Tests (verify, may need minor updates)
- `packages/workspace/src/shared/crypto/key-cache.ts`: KeyCache interface (unchanged)
- `packages/workspace/src/shared/crypto/index.ts`: Barrel export (already exports from `./key-manager`)
- `apps/tab-manager/src/lib/state/key-manager.svelte.ts`: Svelte consumer (add `userId`)
- `specs/20260315T141700-encryption-wiring-factory.md`: Original factory spec (historical, don't update)
- `specs/20260315T083000-keycache-chrome-extension.md`: KeyCache spec (references old names, historical)

## Review

**Completed**: 2026-03-16

### Summary

All four issues identified in the design review are fixed: the `this`-binding footgun is eliminated by extracting `setKeyInternal` as a closure-captured private helper, `wipe()` now returns `Promise<void>` for awaitable sign-out, `deriveAndUnlock` has a `.catch()` that surfaces HKDF failures visibly, and the Svelte consumer passes `userId` to enable key caching.

### Deviations from Spec

- The spec predicted existing `wipe()` tests would pass unchanged because `clearLocalData` is called synchronously. This was incorrect: `keyCache.clear()` runs after the `await` yield point, so the "wipe() clears keyCache" test needed `async`/`await`. Minimal fix, no behavioral change.
- Fixed a stale `// wipeLocalData()` comment in the test file section header (not called out in the spec).

### Follow-up Work

- Implement `KeyCache` adapter for Chrome extension storage (`specs/20260315T083000-keycache-chrome-extension.md`)
- Consider adding `delete(userId)` to `KeyCache` interface for multi-user device support
