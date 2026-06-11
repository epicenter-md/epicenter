# Sync Auto-Reconnect on Token Change

The sync extension should reconnect automatically when the auth token
changes, eliminating manual `sync.reconnect()` calls from auth callbacks.

## Problem

Three apps use the sync extension. Only one calls `reconnect()` after auth
changes. And it's manually wired into auth callbacks alongside unrelated
encryption logic:

| App | Calls `reconnect()` on auth change? | How |
|---|---|---|
| honeycrisp | Yes | Manual calls in `onSignedIn`/`onSignedOut` auth callbacks |
| opensidian | **No**: bug |: |
| tab-manager | **No**: bug (only manual UI button) |: |

The sync provider calls `getToken()` fresh on every connection attempt, but
it has no mechanism to detect when the token changes mid-session. A live
WebSocket continues using the old auth state until something externally
calls `reconnect()`.

### Why this matters for the auth factory refactor

The shared `createAuthState` factory currently has `onSignedIn`/`onSignedOut`
callbacks. We want to replace them with a focused `encryption` config object
(`activate`/`deactivate`/`restoreFromCache`). But honeycrisp puts
`sync.reconnect()` in those callbacks alongside encryption. So they're not
purely about encryption. Fixing sync auto-reconnect removes `reconnect()`
from auth callbacks, making the `encryption` abstraction correct.

## Current Architecture

```
createSyncExtension({ getToken, ... })
  └─ createSyncProvider({ getToken, ... })
       └─ runLoop:
            while (desired === 'online' && runId === myRunId) {
              token = await getToken()       ← called fresh each iteration
              result = await attemptConnection(token)
              if (result === 'failed') await backoff.sleep()
            }

reconnect() = disconnect() + connect()      ← starts new runLoop
```

`getToken` is a callback, not a reactive signal. The provider never polls
or watches it. Reconnection only happens via:
- `reconnect()` (explicit, called by consumer)
- Network `online` event (calls `backoff.wake()`, retries current loop)
- Natural retry after connection failure

## Proposed Fix

Add an optional `onTokenChange` field to `SyncExtensionConfig`. The sync
extension calls it during setup, passing a `reconnect` callback. The
consumer wires it to their token's change detection mechanism.

### Sync extension config change

```typescript
// packages/workspace/src/extensions/sync.ts
type SyncExtensionConfig = {
  // ... existing fields ...

  /**
   * Subscribe to auth token changes. Called once during setup with a
   * `reconnect` callback. Return an unsubscribe function.
   *
   * When the token changes, call `reconnect()`: the provider will
   * disconnect the current WebSocket and start a new connection with
   * a fresh token from `getToken`.
   */
  onTokenChange?: (reconnect: () => void) => () => void;
};
```

Inside the extension factory, after creating the provider:

```typescript
let unsubTokenChange: (() => void) | undefined;
if (config.onTokenChange) {
  unsubTokenChange = config.onTokenChange(() => {
    provider.disconnect();
    provider.connect();
  });
}

// In dispose():
unsubTokenChange?.();
```

### How each app wires it

**honeycrisp** (`apps/honeycrisp/src/lib/workspace/client.ts`)

Token is in `localStorage` at `honeycrisp:authToken`. The `createLocalStorage`
helper uses `createPersistedState` which fires on `storage` events (cross-tab)
and `focus` events (same-tab/DevTools). But `storage` events don't fire for
same-tab writes.

The auth factory writes `storage.token.current` on sign-in (via `onSuccess`)
and sign-out (via `clearState`). For same-tab detection, we need to watch
the reactive `authState.token` getter.

Honeycrisp's workspace file is `.ts`, not `.svelte.ts`, so it can't use
`$effect`. Two options:

**Option A:** Rename to `.svelte.ts` and use `$effect.root`:
```typescript
onTokenChange: (reconnect) => {
  let prev = authState.token;
  return $effect.root(() => {
    $effect(() => {
      const token = authState.token;
      if (token !== prev) { prev = token; reconnect(); }
    });
    return () => {};
  });
},
```

**Option B:** Use the storage `subscribe` pattern on `createPersistedState`.
The persisted state already listens for `storage` and `focus` events
internally. Could expose a `subscribe` callback. But that requires changing
`createPersistedState`.

**Option C:** Add a `subscribe` method to the storage interface returned by
`createLocalStorage`:
```typescript
export function createLocalStorage(prefix: string) {
  const tokenState = createPersistedState({ key: `${prefix}:authToken`, ... });
  return {
    token: tokenState,
    user: userState,
    onTokenChange: (cb: () => void) => {
      // Watch localStorage via storage event + periodic check
    },
  };
}
```

**Recommendation:** Option A. Rename workspace files to `.svelte.ts` and
use `$effect`. It's the Svelte-native approach, catches all changes
(same-tab and cross-tab), and requires no new subscription infrastructure.

**tab-manager** (`apps/tab-manager/src/lib/workspace/client.ts`)

Token is in `chrome.storage.local` via `createStorageState`. Already has
`.watch()` for cross-context changes. Same-context changes are detected
via `$state` reactivity.

```typescript
onTokenChange: (reconnect) => {
  // Cross-context: chrome.storage change from another extension context
  const unsub = authToken.watch(() => reconnect());

  // Same-context: $effect.root for reactive tracking
  const dispose = $effect.root(() => {
    let prev = authToken.current;
    $effect(() => {
      const token = authToken.current;
      if (token !== prev) { prev = token; reconnect(); }
    });
    return () => {};
  });

  return () => { unsub(); dispose(); };
},
```

Or simpler: rename workspace file to `.svelte.ts`, use `$effect` for
same-context (which also catches cross-context since `createStorageState`
updates `$state` from `.watch` internally). Then just:

```typescript
onTokenChange: (reconnect) => {
  let prev = authToken.current;
  return $effect.root(() => {
    $effect(() => {
      const token = authToken.current;
      if (token !== prev) { prev = token; reconnect(); }
    });
    return () => {};
  });
},
```

**opensidian**: same pattern as honeycrisp.

### After this change

Auth callbacks become purely about encryption. `sync.reconnect()` is
removed from all auth callbacks. The `encryption` config object in the
auth factory becomes the correct abstraction:

```typescript
// honeycrisp: no more sync.reconnect() in auth callbacks
export const authState = createAuthState({
  baseURL: APP_URLS.API,
  storage: createLocalStorage('honeycrisp'),
  strategies: { signInWithGoogle: googleRedirect },
  encryption: {
    activate: (key) => workspace.activateEncryption(base64ToBytes(key)),
    deactivate: () => workspace.deactivateEncryption(),
  },
});
```

## Tasks

- [ ] Add `onTokenChange` to `SyncExtensionConfig` type
- [ ] Wire `onTokenChange` in `createSyncExtension` (call during setup, unsub on dispose)
- [ ] Rename honeycrisp workspace to `.svelte.ts`, wire `onTokenChange`
- [ ] Rename opensidian workspace to `.svelte.ts`, wire `onTokenChange`
- [ ] Rename tab-manager workspace to `.svelte.ts`, wire `onTokenChange`
- [ ] Remove `sync.reconnect()` from honeycrisp auth callbacks
- [ ] Verify opensidian sync reconnects on auth change (was a bug)
- [ ] Verify tab-manager sync reconnects on auth change (was a bug)
- [ ] Update auth factory: replace `onSignedIn`/`onSignedOut` with `encryption` object
- [ ] Update all consumers to use `encryption` config
- [ ] Build all apps

## Dependencies

This spec depends on the shared auth factory migration being complete
(the `createAuthState` strategies refactor from
`specs/20260323T225149-shared-auth-factory-for-tab-manager.md`).

## Review

_(To be filled after implementation.)_
