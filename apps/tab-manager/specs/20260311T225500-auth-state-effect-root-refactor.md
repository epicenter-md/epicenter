# Auth State: Internalize Reactive Lifecycle with $effect.root

**Date**: 2026-03-11
**Status**: Implemented
**Author**: AI-assisted

## Overview

Replace the two "call me inside $effect" methods (`reactToTokenCleared`, `reactToTokenSet`) in `auth.svelte.ts` with internal `$effect.root()` effects that the auth state module manages itself. Consumers no longer participate in the auth state machine. They subscribe to events.

## Motivation

### Current State

The auth state singleton exposes two methods that only work when called inside a `$effect`:

```typescript
// auth.svelte.ts
reactToTokenCleared() {
    if (!authToken.current && phase.status === 'signed-in') {
        void authUser.set(undefined);
        phase = { status: 'signed-out' };
    }
},
reactToTokenSet() {
    if (authToken.current && authUser.current && phase.status === 'signed-out') {
        phase = { status: 'signed-in' };
        return true;
    }
    return false;
},
```

The sole consumer wires them up in `App.svelte`:

```svelte
$effect(() => {
    authState.reactToTokenCleared();
    if (authState.reactToTokenSet()) reconnectSync();
});
```

This creates problems:

1. **Implicit contract**: Nothing in the type signature enforces that these must be called inside `$effect`. The JSDoc says "Call this inside a $effect" but that's a comment, not a guarantee. If someone calls them from a plain function, they silently do nothing.
2. **Leaky abstraction**: The auth module's internal state transitions (signed-in → signed-out, signed-out → signed-in) are exposed as public API. The consumer has to understand the auth state machine to use it correctly.
3. **Coupled concerns**: `reconnectSync()` (a workspace concern) is tangled into auth's reactive lifecycle via a boolean return value.
4. **Fragile**: Both methods run inside a single `$effect` block. Svelte tracks all reactive reads in the block as dependencies. If either method reads a new `$state` in the future, the entire effect re-runs for both conditions. Potentially causing unexpected behavior.

### Desired State

Auth state manages its own reactive lifecycle internally. Consumers subscribe to events they care about:

```svelte
<!-- App.svelte -->
<script lang="ts">
    import { onMount } from 'svelte';

    onMount(() => {
        authState.checkSession();
        const unsub = authState.onExternalSignIn(() => reconnectSync());
        return unsub;
    });
    // No $effect block needed
</script>
```

## Design Decisions

| Decision | Choice | Rationale |
|---|---|---|
| Effect scope mechanism | `$effect.root()` inside `createAuthState()` | Module-level singleton has no component context; `$effect.root()` is the Svelte 5 API for exactly this case |
| Cleanup of root effects | None (intentional) | Singleton lives for the JS context lifetime; cleanup is the tab/window closing. See existing article: `your-spa-singleton-doesnt-need-effect-cleanup.md` |
| External sign-in notification | `onExternalSignIn(callback)` returning unsubscribe | Clean separation. Auth manages state, consumer decides what to do about it (e.g. reconnect sync) |
| External sign-out notification | No separate callback | Token cleared → phase goes to signed-out. Consumers already read `authState.status` reactively. No callback needed unless a specific side effect is required |
| Callback invocation safety | `untrack()` around callback execution | Prevents callbacks from accidentally creating reactive dependencies inside the effect body |

## Architecture

```
BEFORE:

┌─ auth.svelte.ts ─────────────────────────────┐
│ reactToTokenCleared()  ← "call in $effect"    │
│ reactToTokenSet()      ← "call in $effect"    │
└───────────────────────────────────────────────┘
         ▲ consumer must wire up
┌─ App.svelte ──────────────────────────────────┐
│ $effect(() => {                               │
│   authState.reactToTokenCleared();            │
│   if (authState.reactToTokenSet())            │
│     reconnectSync();                          │
│ })                                            │
└───────────────────────────────────────────────┘


AFTER:

┌─ auth.svelte.ts ─────────────────────────────┐
│ $effect.root(() => {                          │
│   $effect → token cleared → phase=signed-out  │
│   $effect → token set → phase=signed-in       │
│                          → fire listeners     │
│ })                                            │
│ onExternalSignIn(cb) → returns unsubscribe    │
└───────────────────────────────────────────────┘
         ▲ just subscribes
┌─ App.svelte ──────────────────────────────────┐
│ onMount(() => {                               │
│   authState.checkSession();                   │
│   return authState.onExternalSignIn(          │
│     () => reconnectSync()                     │
│   );                                          │
│ })                                            │
└───────────────────────────────────────────────┘
```

## Safety Analysis

This section documents every concern we considered and why each is safe.

### No premature firing on initialization

`phase` starts as `{ status: 'checking' }`. Neither effect condition matches:
- Token cleared effect requires `phase.status === 'signed-in'` → false during 'checking'
- Token set effect requires `phase.status === 'signed-out'` → false during 'checking'

The effects are inert until `checkSession()` resolves and sets a definitive phase.

### No infinite loops (self-stabilizing effects)

**Token cleared effect**: reads `authToken.current` and `phase.status`. Writes `phase = { status: 'signed-out' }`. On the re-run triggered by the phase write, the condition `phase.status === 'signed-in'` is now false. Effect exits. Stable.

**Token set effect**: reads `authToken.current`, `authUser.current`, and `phase.status`. Writes `phase = { status: 'signed-in' }`. On the re-run, `phase.status === 'signed-out'` is false. Effect exits. Stable.

### No cross-effect loops

The two effects have mutually exclusive activation conditions based on token presence:
- Token cleared fires when `!authToken.current` (token absent) AND `phase.status === 'signed-in'`
- Token set fires when `authToken.current` (token present) AND `phase.status === 'signed-out'`

If effect 1 sets phase to `signed-out`, effect 2 would need a truthy token to fire. But effect 1 only fires when token is falsy. If effect 2 sets phase to `signed-in`, effect 1 would need a falsy token. But effect 2 only fires when token is truthy. They can never trigger each other.

### No race with checkSession()

`checkSession()` is async. While it runs, phase is `'checking'`. Neither effect fires during `'checking'`. Once `checkSession()` sets a definitive phase, the effects respond correctly to the current token state. No interleaving concern.

### No race with signIn()/signUp()/signOut()

These methods set phase to `'signing-in'` or `'signing-out'` during their operation. Neither effect fires during these transitional states. They only match `'signed-in'` and `'signed-out'`. Once the method completes and sets the final phase, the effects align with the token state at that moment.

### No accidental dependencies from callbacks

`reconnectSync()` is `workspaceClient.extensions.sync.reconnect()`: a one-liner that reads no reactive state. However, future callbacks might read `$state` values. Wrapping callback invocation in `untrack()` prevents any callback from accidentally becoming a dependency of the effect:

```typescript
$effect(() => {
    if (authToken.current && authUser.current && phase.status === 'signed-out') {
        phase = { status: 'signed-in' };
        untrack(() => {
            for (const fn of externalSignInListeners) fn();
        });
    }
});
```

This is a defensive measure. Current consumers don't need it, but it prevents a subtle bug if a future callback reads reactive state.

### No memory leak

`$effect.root()` returns a cleanup function, but we intentionally don't call it. The auth state singleton lives for the entire JS context (browser extension sidepanel). When the context dies, everything is garbage collected together: effects, listeners, and state. This matches the existing pattern in `createStorageState`, which uses `item.watch()` without cleanup.

### No cleanup concern for listener Set

`externalSignInListeners` is a `Set<() => void>`. Subscribers call the returned unsubscribe function in their `onMount` cleanup. If they don't (e.g. another module-level singleton subscribes permanently), that's also fine. The Set lives as long as the auth state, which lives as long as the JS context.

## Implementation Plan

### Phase 1: Refactor auth state internals

- [x] **1.1** Add `$effect.root()` block inside `createAuthState()` with two internal effects (token cleared, token set)
- [x] **1.2** Add `externalSignInListeners` Set and `onExternalSignIn(callback)` method to the return object
- [x] **1.3** Remove `reactToTokenCleared()` and `reactToTokenSet()` from the return object

### Phase 2: Update consumer

- [x] **2.1** In `App.svelte`, remove the `$effect` block (lines 37-40)
- [x] **2.2** Add `authState.onExternalSignIn(() => reconnectSync())` inside the existing `onMount`, returning the unsubscribe in cleanup

### Phase 3: Verify

- [ ] **3.1** Test: sign in via email → verify phase transitions
- [ ] **3.2** Test: sign in via Google → verify phase transitions
- [ ] **3.3** Test: sign out → verify clearState and phase reset
- [ ] **3.4** Test: open two sidepanels → sign in in one → verify the other transitions to signed-in and reconnects sync
- [ ] **3.5** Test: open two sidepanels → sign out in one → verify the other transitions to signed-out
- [x] **3.6** LSP diagnostics clean on `auth.svelte.ts` and `App.svelte`

## Edge Cases

### Token and user arrive at different times from another context

1. Another context calls `signIn()`, which writes `authUser` first via `authUser.set(user)`, then the `onSuccess` callback writes `authToken` via the `set-auth-token` header
2. After `authUser` is set but before `authToken` arrives, the token set effect checks `authToken.current && authUser.current && phase.status === 'signed-out'`. Token is still falsy → effect doesn't fire
3. Once `authToken` arrives, both conditions are met → effect fires → transition to signed-in

This is the same behavior as the current implementation. The conditions naturally handle partial state.

### URL changes while signed in

1. User changes `remoteServerUrl` in settings
2. `$derived` creates a new `client` instance
3. Existing session is still valid; `authToken` and `authUser` unchanged
4. Next API call uses the new client with the existing token

No impact on the refactored code: `$derived` on `client` is unchanged.

## Success Criteria

- [x] `reactToTokenCleared()` and `reactToTokenSet()` removed from public API
- [x] No `$effect` block in `App.svelte` for auth lifecycle management
- [ ] Cross-context sign-in/sign-out still works (token changes in one panel are reflected in another) *(requires manual testing)*
- [ ] `reconnectSync()` still fires on external sign-in *(requires manual testing)*
- [x] LSP diagnostics pass on all changed files

## References

- `apps/tab-manager/src/lib/state/auth.svelte.ts`: The file being refactored
- `apps/tab-manager/src/lib/state/storage-state.svelte.ts`: Underlying reactive storage wrapper (unchanged)
- `apps/tab-manager/src/entrypoints/sidepanel/App.svelte`: Sole consumer of reactToToken* methods
- `apps/tab-manager/src/lib/workspace.ts`: `reconnectSync()` definition (line 870)
- `docs/articles/your-spa-singleton-doesnt-need-effect-cleanup.md`: Prior art on singleton lifecycle

## Review

**Completed**: 2026-03-11

### Summary

Internalized auth state's reactive lifecycle by replacing the two public `reactToTokenCleared()`/`reactToTokenSet()` methods with `$effect.root()` effects inside `createAuthState()`. Added `onExternalSignIn(callback)` subscription method so consumers can react to cross-context sign-ins without understanding the auth state machine. App.svelte now uses a simple `onMount` subscription instead of a raw `$effect` block.

### Deviations from Spec

None. Implementation matched the spec exactly.

### Follow-up Work

- Manual testing items 3.1-3.5 (sign-in/sign-out flows, cross-context sync) need human verification
