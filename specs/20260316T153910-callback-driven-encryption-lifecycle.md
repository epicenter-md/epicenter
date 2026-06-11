# Callback-Driven Encryption Lifecycle

**Date**: 2026-03-16
**Status**: Revision 2: Adapter pattern
**Builds on**: `specs/20260316T093000-encryption-wiring-api-refinements.md` (implemented), `specs/20260315T083000-keycache-chrome-extension.md`

## Overview

Replace the reactive `$effect` adapter between auth state and the key manager with a single adapter slot. Auth defines a narrow `EncryptionAdapter` interface and calls it at the right moments. The key-manager module injects the concrete adapter via `syncAuthToEncryption()`. No effects, no listener Sets, no stored encryption key state in auth.

### Revision note

The initial draft proposed three callback Sets (`onCacheRestore`, `onEncryptionKeyAvailable`, `onSigningOut`) following the existing `onExternalSignIn` pattern. During review, a responsibility analysis revealed that `encryptionKey` shouldn't be state inside auth at all. It's session data that auth extracts but never needs to store. The adapter pattern passes the key through transient, eliminating the stale-state class of bugs (including the pre-existing 4xx bug) by construction. It also reduces 3 Sets + 3 methods to 1 type + 1 method.

## Motivation

### Current State

The Svelte adapter watches `authState` reactively and translates state changes into key manager commands:

```typescript
// apps/tab-manager/src/lib/state/key-manager.svelte.ts (today)
const keyManager = createKeyManager(workspaceClient);

export function syncAuthToEncryption() {
  return $effect.root(() => {
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
  });
}
```

To add the cache fast-path (`restoreKey` before `checkSession` completes), the proposed pattern requires a second effect with a boolean gate:

```typescript
// Proposed two-effect pattern
let cacheRestoreAttempted = false;
$effect(() => {
  const userId = authState.user?.id;
  if (userId && !cacheRestoreAttempted) {
    cacheRestoreAttempted = true;
    void keyManager.restoreKey(userId);
  }
});
```

This creates problems:

1. **Reactive indirection.** Auth already knows when the encryption key changes. It sets `encryptionKey` inside `signIn()`, `signUp()`, `checkSession()`. The effect is a secondary observer re-deriving information auth had at the call site.
2. **Boolean flag for one-shot semantics.** Svelte 5 has no "run once when a reactive value appears" primitive. The `cacheRestoreAttempted` flag is the canonical workaround, but it's an imperative escape hatch in a declarative system.
3. **Effect timing race.** When `userId` appears, both effects re-run. The main effect calls `lock()` (no key yet), then the fast-path's async `restoreKey` resolves and activates encryption. The workspace flashes through a locked state for ~1-5ms. Correct (generation counter ensures activateEncryption wins), but unnecessarily subtle.
4. **Growing effect complexity.** Each new concern (cache restore, external sign-in, future key rotation) requires another effect or another branch in an existing effect. The reactive graph becomes harder to reason about.
5. **Stale state bug.** `encryptionKey` is stored as `$state` inside auth. If any code path forgets to clear it (the 4xx path in `checkSession()`), the reactive effect sees a truthy key and keeps the workspace in `encrypted` mode with a stale derived key. Storing the key as state creates an entire class of bugs.

### Desired State

Auth defines a narrow interface. The adapter injects it. Auth calls it directly at the right moments. No `encryptionKey` state variable in auth.

```typescript
// auth.svelte.ts
type EncryptionAdapter = {
  restoreKey(userId: string): void;
  setKey(key: string, userId: string): void;
  wipe(): void;
};

// Inside createAuthState:
let encryption: EncryptionAdapter | undefined;

// At call sites: optional chaining, no loops:
encryption?.restoreKey(userId);
encryption?.setKey(key, userId);
encryption?.wipe();

// Single registration method:
registerEncryption(adapter: EncryptionAdapter) {
  encryption = adapter;
  return () => { encryption = undefined; };
}
```

```typescript
// key-manager.svelte.ts
export function syncAuthToEncryption() {
  return authState.registerEncryption({
    restoreKey: (userId) => void keyManager.restoreKey(userId),
    setKey: (key, userId) => keyManager.setKey(key, userId),
    wipe: () => { keyManager.wipe(); },
  });
}
```

The hard parts stay in the key manager factory. The adapter is pure wiring. No reactive scope, no boolean flags, no timing races, no stored encryption key.

## Research Findings

### Where the Encryption Key Actually Changes

Every place `encryptionKey` is set or cleared in `auth.svelte.ts`:

| Call site | What happens | Adapter action |
|---|---|---|
| `refreshEncryptionKey()` (called after `signIn`, `signUp`, `signInWithGoogle`) | `encryptionKey = result.data.encryptionKey` | `setKey(key, userId)` |
| `checkSession()` success | `encryptionKey = data.encryptionKey` | `setKey(key, userId)` |
| `signOut()` | `encryptionKey = undefined` | `wipe()` |
| `checkSession()` rejection (4xx) | **Bug: `encryptionKey` is NOT cleared** (stays at previous value) | `wipe()` |
| `checkSession()` network error / 5xx | `encryptionKey` unchanged, trusts cached user | No action (intentional. Offline support) |

**Pre-existing bug**: `checkSession()` on 4xx calls `clearState()` and sets `phase = 'signed-out'`, but never clears `encryptionKey`. The adapter pattern eliminates this bug by construction. There is no `encryptionKey` variable to forget to clear. Auth calls `encryption?.wipe()` on 4xx, same as sign-out.

### Responsibility Analysis: Why `encryptionKey` Doesn't Belong in Auth

`encryptionKey` is currently a `$state` variable inside `createAuthState()`. It's set from session responses and exposed as a getter. But:

1. **Zero external consumers.** `authState.encryptionKey` is not referenced anywhere outside `auth.svelte.ts` and the old reactive adapter in `key-manager.svelte.ts`. No Svelte component reads it. No other module reads it.
2. **Auth doesn't use it.** Auth never reads `encryptionKey` for its own logic. It extracts it from the session and exposes it for someone else. That "someone else" is always the key manager.
3. **Storing it creates bugs.** The 4xx bug exists because `encryptionKey` is state that can become stale. If auth doesn't store it, the bug class vanishes.
4. **The adapter makes it transient.** With the adapter pattern, auth extracts the key from the session response and immediately passes it to `encryption?.setKey(key, userId)`. No storage needed.

**Conclusion**: Remove `let encryptionKey` from `createAuthState()`. Remove the `get encryptionKey()` getter. At call sites where `encryptionKey` was set, call `encryption?.setKey(...)` instead. At call sites where it was cleared, call `encryption?.wipe()` instead.

### Existing Callback Pattern in Auth

`auth.svelte.ts` already implements a listener pattern for cross-context sign-in detection:

```typescript
const externalSignInListeners = new Set<() => void>();

// In the effect that detects external sign-in:
untrack(() => {
  for (const fn of externalSignInListeners) fn();
});

// Public API:
onExternalSignIn(callback: () => void) {
  externalSignInListeners.add(callback);
  return () => { externalSignInListeners.delete(callback); };
}
```

The encryption adapter uses a different pattern: a single handler slot instead of a Set. This is deliberate. There will only ever be one encryption consumer, so the N-subscriber Set pattern is unnecessary overhead. The `onExternalSignIn` pattern stays as-is (it serves a different purpose).

### Cache Fast-Path: Timing via `checkSession()`

Rather than calling `restoreKey` imperatively at mount time (which may miss if `authUser` hasn't hydrated yet), the cache restore fires from the adapter in `checkSession()`. `checkSession()` already manages async boot order. It awaits `authToken.whenReady`. Adding `authUser.whenReady` gives it the userId at exactly the right moment: after storage hydration, before the network call.

```typescript
// Inside checkSession():
async checkSession() {
  await Promise.all([authToken.whenReady, authUser.whenReady]);

  // Fire cache-restore via adapter before network call
  const userId = authUser.current?.id;
  if (userId) {
    encryption?.restoreKey(userId);
  }

  // ... existing token check and network logic ...
}
```

Auth doesn't import the key manager. The coupling is through the adapter interface. Fires exactly once (`checkSession` runs once at mount), at exactly the right time (after storage hydration, before network), and handles offline correctly (`restoreKey` fires, network fails, workspace activates encryption from cache).

### Better Auth Session Behavior

From `apps/api/src/app.ts`:

```typescript
session: {
  expiresIn: 60 * 60 * 24 * 7,  // 7 days
  updateAge: 60 * 60 * 24,       // 1 day auto-refresh
}
```

Sessions auto-refresh on every `getSession()` call if older than 1 day. `checkSession()` runs on mount and on every visibility change. As long as the user opens the extension once per week, the session never expires. Session expiry is a rare edge case. But the 4xx path should still be correct.

## Design Decisions

| Decision | Choice | Rationale |
|---|---|---|
| Single adapter slot, not three callback Sets | `EncryptionAdapter` type with `registerEncryption()` | Only one consumer (key-manager). A Set per event is N-subscriber overhead for a 1:1 relationship. One type + one method vs three Sets + three methods. |
| Remove `encryptionKey` from auth state | Yes | Auth extracts the key from session responses but never uses it. Storing it as state creates the 4xx stale-key bug. With the adapter, the key is transient. Passed through, never stored. |
| Adapter methods mirror key manager names | `restoreKey`, `setKey`, `wipe` | The adapter IS the key manager interface from auth's perspective. Same names make the mapping obvious and the adapter code trivial. |
| Adapter on `authState`, not on the factory | Yes | Auth owns the lifecycle events. The key manager factory is framework-agnostic. The adapter wires them together. |
| Cache restore via adapter from `checkSession()` | Yes | `checkSession()` already manages async boot. Awaiting `authUser.whenReady` gives it the userId at the right time. Adapter keeps auth decoupled from key manager. |
| Call `wipe()` on 4xx rejection | Yes | A server-rejected session is functionally a forced sign-out. Stale local data should be wiped. |
| Remove `$effect.root` and `$effect` from adapter | Yes | With adapter injection, nothing to observe reactively. Adapter becomes a plain function. |
| Keep `.svelte.ts` extension | Yes | Svelte compiler on a rune-free `.svelte.ts` is a no-op. Zero cost. Consistent naming with adjacent files, avoids import churn, and future changes can add runes without renaming. |
| `await Promise.all([authToken.whenReady, authUser.whenReady])` | Yes | Ensures both token and user are hydrated before reading userId for cache restore. The token was already awaited; adding user is a net-new improvement. |

## Architecture

### Before: Reactive Observation

```
auth.svelte.ts                   key-manager.svelte.ts          key-manager.ts
┌──────────────────┐            ┌────────────────────┐         ┌─────────────────┐
│ signIn()          │            │ $effect.root()     │         │ createKeyManager │
│   sets encKey ────┼──$state──▶│   $effect() {      │────────▶│   setKey()       │
│                   │            │     if (key)       │         │   lock()         │
│ signOut()         │            │     else if (wipe) │         │   wipe()         │
│   clears encKey ──┼──$state──▶│     else lock()    │         │   restoreKey()   │
│                   │            │   }                │         └─────────────────┘
│ checkSession()    │            │   $effect() {      │
│   sets encKey ────┼──$state──▶│     // flag guard  │
│                   │            │     restoreKey()   │
└──────────────────┘            └────────────────────┘
```

Auth sets state → Effect observes → Effect calls key manager. Three hops. `encryptionKey` is stored state that can become stale.

### After: Adapter Injection

```
auth.svelte.ts                   key-manager.svelte.ts          key-manager.ts
┌──────────────────┐            ┌────────────────────┐         ┌─────────────────┐
│                   │  injects   │ syncAuth...() {    │         │ createKeyManager │
│ slot: encryption? │◄───adapter─│   authState        │         │                  │
│                   │            │     .register({    │         │                  │
│ signIn()          │            │       restoreKey,  │────────▶│   restoreKey()   │
│   encryption?     │            │       setKey,      │────────▶│   setKey()       │
│     .setKey(k,uid)│            │       wipe,        │────────▶│   wipe()         │
│                   │            │     })             │         │                  │
│ signOut()         │            │   return cleanup   │         └─────────────────┘
│   encryption?     │            │ }                  │
│     .wipe()       │            └────────────────────┘
│                   │
│ checkSession()    │            App.svelte
│   encryption?     │            ┌──────────────────────────┐
│     .restoreKey() │            │ onMount(() => {          │
│   encryption?     │            │   authState.checkSession()│
│     .setKey(k,uid)│            │   syncAuthToEncryption() │ ← unchanged
│                   │            │ })                       │
│ NO encryptionKey  │            └──────────────────────────┘
│ state variable    │
└──────────────────┘
```

Auth calls adapter → Adapter calls key manager. Two hops, no reactive indirection, no stored encryption key.

## Implementation Plan

### Phase 0: Add adapter slot to auth, remove encryptionKey

- [ ] **0.1** Define `EncryptionAdapter` type inside `createAuthState()`: `{ restoreKey(userId: string): void; setKey(key: string, userId: string): void; wipe(): void; }`
- [ ] **0.2** Add `let encryption: EncryptionAdapter | undefined` inside `createAuthState()`
- [ ] **0.3** Remove `let encryptionKey = $state<string | undefined>(undefined)`: no longer needed
- [ ] **0.4** Remove the `get encryptionKey()` getter from the return object
- [ ] **0.5** In `refreshEncryptionKey()`: replace `encryptionKey = result.data.encryptionKey` with `if (result?.data?.encryptionKey) encryption?.setKey(result.data.encryptionKey, result.data.user.id)`
- [ ] **0.6** In `checkSession()`: change `await authToken.whenReady` to `await Promise.all([authToken.whenReady, authUser.whenReady])`. After the await, fire `encryption?.restoreKey(userId)` if userId is truthy (before the token check)
- [ ] **0.7** In `checkSession()` success path: replace `encryptionKey = data.encryptionKey` with `if (data.encryptionKey) encryption?.setKey(data.encryptionKey, data.user.id)`
- [ ] **0.8** In `signOut()`: remove `encryptionKey = undefined`. Add `encryption?.wipe()` after setting `phase = { status: 'signing-out' }`, before `client.signOut()`
- [ ] **0.9** In `checkSession()` 4xx path: add `encryption?.wipe()` after `await clearState()` (no `encryptionKey = undefined` needed. Variable doesn't exist)
- [ ] **0.10** Expose `registerEncryption(adapter: EncryptionAdapter)` on the return object. Sets `encryption = adapter`, returns `() => { encryption = undefined; }`. Include JSDoc.
- [ ] **0.11** Remove the three callback Sets and three `on*` methods added in the initial implementation (if present from partial implementation of the previous draft)
- [ ] **0.12** Verify: `lsp_diagnostics` clean on `auth.svelte.ts`

### Phase 1: Rewrite the key-manager adapter

- [ ] **1.1** Wire `keyCache` into the `createKeyManager` call (already done)
- [ ] **1.2** Rewrite `syncAuthToEncryption()` to call `authState.registerEncryption()` with an adapter object mapping `{ restoreKey, setKey, wipe }` to `keyManager` methods
- [ ] **1.3** Return the cleanup function from `registerEncryption()`
- [ ] **1.4** Update JSDoc to describe the adapter-driven pattern
- [ ] **1.5** Remove any `$effect.root` / `$effect` / Svelte rune imports (already done)
- [ ] **1.6** Verify: `lsp_diagnostics` clean

### Phase 2: Verify

- [ ] **2.1** `bun run typecheck` in `apps/tab-manager`
- [ ] **2.2** `bun run build` in `apps/tab-manager`
- [ ] **2.3** Manual test: sign in → sidebar close → sidebar reopen → verify instant decrypt from cache
- [ ] **2.4** Manual test: sign out → verify data wiped
- [ ] **2.5** Manual test: offline → sidebar reopen → verify activateEncryption from cache

## Edge Cases

### Cache Restore When User Not Yet Hydrated

1. `syncAuthToEncryption()` runs from `onMount`: registers adapter
2. `authState.checkSession()` also runs from `onMount`
3. `checkSession()` awaits `Promise.all([authToken.whenReady, authUser.whenReady])`
4. After hydration, if userId is truthy, calls `encryption?.restoreKey(userId)`
5. If cache hits, `setKey()` → HKDF → activateEncryption happens in ~1ms

The `Promise.all` ensures the userId is available before attempting cache restore. No boolean flags needed.

### Sign-Out During In-Flight HKDF

1. `encryption?.setKey(key, userId)` → adapter calls `keyManager.setKey()` → starts HKDF derivation (async)
2. Before HKDF completes, user signs out → `encryption?.wipe()` → adapter calls `keyManager.wipe()`
3. `wipe()` calls `invalidateKey()` → `++generation`, then `clearLocalData()`
4. HKDF resolves → checks `thisGeneration === generation` → mismatch → no-op

Expected: Unlock never lands. Data wiped. Correct.

### Multiple Rapid Sign-In/Sign-Out

1. User signs in → `encryption?.setKey(key1, userId)` → `keyManager.setKey(key1)`
2. User signs out immediately → `encryption?.wipe()` → `keyManager.wipe()`
3. User signs in again → `encryption?.setKey(key2, userId)` → `keyManager.setKey(key2)`

Each call fires in order. `setKey` dedup and generation counter handle the rest. No effect batching to worry about.

### External Sign-In (Another Extension Context)

The existing `onExternalSignIn` callback in auth fires when token + user appear while signed out. This triggers `workspaceClient.extensions.sync.reconnect()` in `App.svelte`. The encryption key for the external sign-in comes through `checkSession()` (which the existing visibility-change handler already calls), so the adapter's `setKey` fires naturally.

### `wipe()` After Session Expiry

1. User is signed in, workspace is in `encrypted` mode
2. Session token expires server-side (after 7 days of inactivity)
3. `checkSession()` runs on visibility change → server returns 4xx
4. `checkSession()` calls `clearState()`, then `encryption?.wipe()`
5. Adapter receives `wipe()` → calls `keyManager.wipe()`
6. Workspace is wiped and locked

Expected: Clean transition to locked state. User must re-authenticate.

### Adapter Not Yet Registered

If `checkSession()` runs before `syncAuthToEncryption()` (race between two `onMount` calls):

1. `checkSession()` calls `encryption?.restoreKey(userId)`: `encryption` is undefined → no-op (optional chaining)
2. `checkSession()` completes, gets session with key, calls `encryption?.setKey(key, userId)`: still undefined → no-op
3. `syncAuthToEncryption()` runs, registers adapter: but the key was already available

This is a theoretical concern. In practice, both calls happen synchronously in the same `onMount` callback in App.svelte:

```typescript
onMount(() => {
  authState.checkSession();           // Starts async work
  const cleanup = syncAuthToEncryption(); // Registers adapter synchronously
  // ...
});
```

`checkSession()` is async. Its first await (`Promise.all(...)`) yields back to the event loop. By the time it resumes, `syncAuthToEncryption()` has already registered the adapter. No race.

## Open Questions

All resolved:

1. ~~Should 4xx rejection fire `onSigningOut` or a distinct `onSessionLost`?~~ **Resolved**: Both call `wipe()`. Single adapter method handles both.

2. ~~Should `onEncryptionKeyAvailable` receive `userId` or should the listener read it from `authState.user?.id`?~~ **Resolved**: `setKey(key, userId)` passes both directly. The adapter is independent of `authState.user`.

3. ~~Should `encryptionKey` be stored in auth?~~ **Resolved**: No. Auth passes the key through to the adapter. No stored state = no stale state bugs.

## Success Criteria

- [ ] `auth.svelte.ts` has no `encryptionKey` state variable, no `encryptionKey` getter
- [ ] `auth.svelte.ts` defines `EncryptionAdapter` type and exposes `registerEncryption()`
- [ ] `auth.svelte.ts` calls `encryption?.restoreKey()`, `encryption?.setKey()`, `encryption?.wipe()` at the right moments
- [ ] `key-manager.svelte.ts` has no `$effect`, no `$effect.root`, no boolean flags
- [ ] `key-manager.svelte.ts` calls `authState.registerEncryption()` with adapter object
- [ ] Cache fast-path works: sidebar close → reopen → instant decrypt from cache
- [ ] Sign-out wipes data (manual test)
- [ ] Session expiry (4xx) wipes data and locks (manual test or mock)
- [ ] Offline: sidebar reopen → activateEncryption from cache via adapter `restoreKey`
- [ ] `bun run typecheck` in `apps/tab-manager`
- [ ] `bun run build` succeeds in `apps/tab-manager`

## Files to Change

| File | Action |
|---|---|
| `apps/tab-manager/src/lib/state/auth.svelte.ts` | Add `EncryptionAdapter` type, adapter slot, `registerEncryption()`. Remove `encryptionKey` state + getter. Replace all `encryptionKey =` assignments with adapter calls. |
| `apps/tab-manager/src/lib/state/key-manager.svelte.ts` | Rewrite: `syncAuthToEncryption()` calls `authState.registerEncryption()` with adapter object. Remove `$effect.root`/`$effect`. |

## Files NOT to Change

| File | Reason |
|---|---|
| `packages/workspace/src/shared/crypto/key-manager.ts` | Factory is unchanged |
| `apps/tab-manager/src/lib/state/key-cache.ts` | Already implemented, read-only reference |
| `apps/tab-manager/src/entrypoints/sidepanel/App.svelte` | Call site `syncAuthToEncryption()` is unchanged |

## References

- `apps/tab-manager/src/lib/state/key-manager.svelte.ts`: Adapter to rewrite
- `apps/tab-manager/src/lib/state/auth.svelte.ts`: Auth module (add adapter here)
- `apps/tab-manager/src/lib/state/key-cache.ts`: KeyCache implementation (wire into createKeyManager)
- `packages/workspace/src/shared/crypto/key-manager.ts`: Factory (unchanged)
- `apps/tab-manager/src/entrypoints/sidepanel/App.svelte`: Call site for syncAuthToEncryption
- `apps/api/src/app.ts`: Better Auth session config (expiresIn, updateAge)
- `specs/20260316T093000-encryption-wiring-api-refinements.md`: Previous spec (implemented)
- `specs/20260315T083000-keycache-chrome-extension.md`: KeyCache spec
