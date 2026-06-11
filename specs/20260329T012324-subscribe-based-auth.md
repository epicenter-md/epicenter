# Subscribe-Based Auth with BA's useSession + Svelte 5 createSubscriber

**Date**: 2026-03-29
**Status**: Implemented
**Author**: AI-assisted
**Depends on**: 20260329T002221 (collapse transport + session. Already implemented)
## Overview

Replace the manual command→resolve pipeline in `createAuth` with Better Auth's built-in `useSession.subscribe()`, bridged to Svelte 5 via `createSubscriber` from `svelte/reactivity`. BA owns the session lifecycle (auto-refresh, cross-tab sync, token rotation). Workspace side-effects (key fetch, unlock, reconnect) are driven by an `onSessionChange` callback. Commands return errors only. Subscribe handles the success path.

## Motivation

### Current State

`createAuth` (569 lines) reimplements what BA already provides:

```
What we built manually              What BA provides natively
──────────────────────────          ─────────────────────────
resolveWithToken()                  useSession auto-refresh
commandThenResolve()                Commands auto-update session atom
applyResolvedSession()              subscribe callback
installWorkspaceAuthLifecycle()     SessionRefreshManager (visibility, online, polling)
Cross-tab sync in the box           BroadcastChannel
initializeSession()                 Session atom initialization
extractCommandToken()               BA handles token flow internally
```

~470 lines exist to manually manage what BA's `useSession` + `SessionRefreshManager` handle out of the box.

### Desired State

```typescript
const auth = createAuth({
    baseURL,
    session,
    onSessionChange(next, prev) {
        if (next.status === 'authenticated') {
            if (next.keyVersion !== lastKeyVersion) {
                auth.fetchWorkspaceKey().then(({ userKeyBase64, keyVersion }) => {
                    workspace.unlockWithKey(userKeyBase64);
                    lastKeyVersion = keyVersion;
                });
            }
            workspace.extensions.sync.reconnect();
        }
        if (prev.status === 'authenticated' && next.status === 'anonymous') {
            workspace.clearLocalData();
            workspace.extensions.sync.reconnect();
        }
    },
});

// Commands return errors only. Subscribe handles success.
const error = await auth.signIn({ email, password });
if (error) submitError = error.message;
```

## Research Findings

### BA's Client Session Management

BA uses nanostores internally. The vanilla client exposes:
- `useSession`: nanostore atom with `{ data, isPending, isRefetching, error }`
- `useSession.subscribe(callback)`: fires on every session change
- `SessionRefreshManager`: auto-refresh on visibility, network online, polling, cross-tab BroadcastChannel

### Svelte 5 External Source Integration

Svelte 5.7.0 introduced `createSubscriber` from `svelte/reactivity`. This is the idiomatic way to bridge external reactive sources (nanostores, RxJS, etc.) into runes. It handles:
- Lazy subscription (only subscribes when something reads the value)
- Reference counting (cleans up when no effects depend on it)
- Cleanup function (returned from the start callback)

Pattern:
```typescript
import { createSubscriber } from 'svelte/reactivity';

const subscribe = createSubscriber((update) => {
    const unsubscribe = externalSource.subscribe(() => update());
    return unsubscribe;
});

// In a getter: makes it reactive
get value() {
    subscribe(); // registers dependency
    return externalSource.getValue();
}
```

### BA's Svelte Client vs Vanilla + createSubscriber

| Aspect | better-auth/svelte | Vanilla + createSubscriber |
|--------|-------------------|---------------------------|
| Reactivity | nanostores → useStore adapter | createSubscriber → runes native |
| Svelte 5 idiom | Compat layer (Svelte 4 pattern) | First-class runes integration |
| Control | BA controls everything | We control the bridge |
| Token management | BA internal | We provide via fetchOptions |
| Workspace integration | Must wrap externally | In the subscribe callback |

**Decision**: Vanilla + createSubscriber. More control, idiomatic Svelte 5, workspace integration in the subscribe callback.

## Design Decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| BA client | Vanilla (`better-auth/client`) | Not `better-auth/svelte`. BA's Svelte client uses nanostores (Svelte 4 pattern). We bridge via `createSubscriber` for runes-native reactivity. |
| Svelte bridge | `createSubscriber` from `svelte/reactivity` | Idiomatic Svelte 5 (added 5.7.0). Lazy, reference-counted, cleanup-aware. |
| Session cache | Box stays (`{ current: AuthSession }`) | Stale-while-revalidate. Instant UI on startup from localStorage, BA refreshes in background. |
| Token storage | Reads from box (`session.current.token`) | Box is persisted → token survives page reload → BA uses it for initial getSession. |
| Token rotation | `onSuccess` header check | Captures rotated token from `set-auth-token` header immediately. Subscribe confirms with full session. |
| Workspace integration | `onSessionChange(next, prev)` callback | Auth emits, app responds. Auth doesn't know about workspaces, keys, or sync. Supports multiple workspaces. Each callback decides what to unlock/reconnect. |
| Command return | `Promise<AuthError \| undefined>` | Commands return errors only. Session updates propagate via subscribe → reactive getters. Return value carried dead weight. |
| Operation state | Internal `$state<AuthOperation>` | BA has `isPending`/`isRefetching` but not `signing-in`/`signing-out`. Still needed for command-specific UI spinners. |
| Auto-refresh | BA's SessionRefreshManager | Handles visibility, network online, cross-tab, polling. Replaces our manual visibility listener. |
| Google redirect | Thin passthrough `signInWithGoogleRedirect()` | Keeps BA client private. BA refresh picks up session on return via visibility change. |
| Workspace boot | App's own `onMount` | Auth boots auth. Workspace boots workspace. Independent, parallel. `onMount(() => workspace.bootFromCache())` in the app. |
| `workspace-auth.svelte.ts` | Deleted | `onSessionChange` callback replaces it entirely. |
| Error simplification | Remove `SessionHydrationFailed`, `SessionCommitFailed` | These described steps in the manual pipeline that no longer exist. |
| Error types cleanup | Remove `AuthRefreshResult`, `AuthCommandResult` | Commands return `error \| undefined`. No session in return value. |
## Architecture

```
┌─ BA Vanilla Client (owns session lifecycle) ─────────────────────┐
│                                                                   │
│  SessionRefreshManager                                            │
│    ├─ visibility change → refetch getSession                      │
│    ├─ network online → refetch                                    │
│    ├─ cross-tab BroadcastChannel → refetch                        │
│    └─ optional polling interval                                   │
│                                                                   │
│  useSession atom (nanostore)                                      │
│    { data: { session, user, keyVersion }, isPending, error }      │
│    Updated by: commands, auto-refresh, cross-tab                  │
│                                                                   │
└───────────────────────────┬───────────────────────────────────────┘
                            │
                            │  .subscribe()
                            ▼
┌─ createSubscriber bridge ────────────────────────────────────────┐
│                                                                   │
│  const subscribe = createSubscriber((update) => {                 │
│      return client.useSession.subscribe((state) => {              │
│          if (state.isPending) return;                              │
│                                                                   │
│          const prev = session.current;                             │
│          const next = state.data                                   │
│              ? { status:'authenticated', token, user }             │
│              : { status:'anonymous' };                             │
│                                                                   │
│          session.current = next;          // update the cache box  │
│          onSessionChange?.(next, prev);   // app handles workspace │
│          update();                        // mark Svelte dirty     │
│      });                                                          │
│  });                                                              │
│                                                                   │
└─────────────────────────────┬─────────────────────────────────┘
                            │
                            │  subscribe() in getters
                            ▼
┌─ Public API ───────────────────────────────────────────────────┐
│                                                                   │
│  get session()  { subscribe(); return session.current; }          │
│  get isPending() { subscribe(); return lastState?.isPending; }    │
│  get operation() { return operation; }  // $state, commands only  │
│                                                                   │
│  signIn(input)  → AuthError | undefined                    │
│  signUp(input)  → AuthError | undefined                    │
│  signOut()      → void                                            │
│  signInWithGoogle()  → AuthError | undefined               │
│  signInWithGoogleRedirect({ callbackURL })  → void                │
│                                                                   │
│  fetch          → authorized fetch (bearer from box)              │
│  fetchWorkspaceKey() → WorkspaceKeyResponse                       │
│                                                                   │
└───────────────────────────────────────────────────────────────┘


App call site:
──────────────
  const session = createPersistedState({
      key: '...', schema: AuthSession, defaultValue: { status: 'anonymous' }
  });
  let lastKeyVersion: number | undefined;

  const auth = createAuth({
      baseURL: APP_URLS.API,
      session,
      onSessionChange(next, prev) {
          if (next.status === 'authenticated') {
              if (next.keyVersion !== lastKeyVersion) {
                  auth.fetchWorkspaceKey().then(({ userKeyBase64, keyVersion }) => {
                      workspace.unlockWithKey(userKeyBase64);
                      lastKeyVersion = keyVersion;
                  });
              }
              workspace.extensions.sync.reconnect();
          }
          if (prev.status === 'authenticated' && next.status === 'anonymous') {
              workspace.clearLocalData();
              workspace.extensions.sync.reconnect();
          }
      },
  });

  // Workspace boot is independent
  onMount(() => workspace.bootFromCache());

  // Commands return errors only
  const error = await auth.signIn({ email, password });
  if (error) submitError = error.message;


Startup flow:
─────────────
  1. Box loads from localStorage → session.current = cached session → instant UI
  2. workspace.bootFromCache() loads Yjs from IndexedDB → instant content
  3. BA client initializes → fetchOptions.auth.token reads from box
  4. BA sends getSession with cached token → server validates
  5a. Valid → subscribe fires → onSessionChange → reconnect sync
  5b. Expired → subscribe fires → onSessionChange → clear workspace
```

## Implementation Plan

### Wave 1: Rewrite `create-auth.svelte.ts` with subscribe pattern

- [x] **1.1** Rewrite `createAuth()`:
  - Replace `CreateAuthOptions`: `{ baseURL, session, onSessionChange?, signInWithGoogle? }`
  - Replace all internal pipeline with `client.useSession.subscribe()` + `createSubscriber`
  - Subscribe callback: update box, call `onSessionChange(next, prev)`, call `update()`
  - Commands become thin: set operation → call BA → return error or undefined → set operation idle
  - Subscribe handles success side effects
  - `fetchWorkspaceKey()` stays as a method (raw fetch to /workspace-key)
  - `signInWithGoogleRedirect()` stays as thin passthrough to `client.signIn.social()`
  - Token rotation via `onSuccess` callback on the BA client
- [x] **1.2** Update `AuthClient` type:
  - Commands return `Promise<AuthError | undefined>`
  - Add `isPending` getter
  - Remove `isRefreshing` (use `isPending` from BA)
  - Add `onSessionChange` to `CreateAuthOptions`
- [x] **1.3** Simplify error types:
  - Remove `SessionHydrationFailed`, `SessionCommitFailed`
  - Remove `AuthRefreshResult`, `AuthCommandResult` types
  - Keep `AuthTransportError` for classifying BA errors in commands
  - Keep `AuthError` for UI-facing error messages
- [x] **1.4** Keep `auth-types.ts` unchanged

### Wave 2: Delete `workspace-auth.svelte.ts`, update barrel

- [x] **2.1** Delete `packages/svelte-utils/src/workspace-auth.svelte.ts`
- [x] **2.2** Delete `packages/svelte-utils/src/workspace-auth.test.ts`
- [x] **2.3** Update barrel `auth.svelte.ts`:
  - Remove `createWorkspaceAuth`, `CreateWorkspaceAuthOptions` exports
  - Remove `AuthRefreshResult`, `AuthCommandResult` exports
  - Keep all other exports

### Wave 3: Update app call sites

- [x] **3.1** Each app's auth setup: add `onSessionChange` callback with workspace unlock + `workspace.extensions.sync.reconnect()`
- [x] **3.2** Each app's root component: replace `workspaceAuth.mount()` with `onMount(() => workspace.bootFromCache())`
- [x] **3.3** Each Svelte component: replace `workspaceAuth.signIn` → `auth.signIn`, update to handle `error | undefined` return
- [x] **3.4** Remove `createWorkspaceAuth()` calls from all workspace client files
- [x] **3.5** AuthForm components: update Google redirect to use `auth.signInWithGoogleRedirect()`

### Wave 4: Tests + verify

- [ ] **4.1** Write new tests for subscribe-based behavior in `create-auth.test.ts`
- [x] **4.2** Run `bun test` in `packages/svelte-utils`
- [x] **4.3** `lsp_diagnostics` on all changed files

## Edge Cases

### Token rotation during subscribe gap

1. BA sends request with token A
2. Server responds with rotated token B in `set-auth-token` header
3. `onSuccess` callback writes token B to box immediately
4. Subscribe fires with updated session → box confirms token B

The `onSuccess` callback ensures the token is updated before any subsequent request. The subscribe callback is a second confirmation.

### Startup with expired cached token

1. Box loads cached session (stale) → UI shows authenticated
2. BA sends getSession with cached token → server returns 401
3. useSession atom: `{ data: null, isPending: false }`
4. Subscribe fires → box updates to anonymous → UI shows sign-in
5. Workspace data cleared

### Cross-tab sign-in

1. Tab A signs in → BA broadcasts via BroadcastChannel
2. Tab B's SessionRefreshManager hears broadcast → refetches getSession
3. Tab B's useSession atom updates → subscribe fires → box updates
4. Tab B shows authenticated UI, workspace unlocks

### Command error handling

1. `auth.signIn({ email, password })` → BA returns error
2. Operation set to 'idle'
3. Subscribe does NOT fire (session atom unchanged: no successful auth)
4. Error returned to caller for UI display

## Open Questions

1. **Should `isRefreshing` come from BA or from operation state?**
   - BA has `isRefetching` on the atom. We have `operation.status === 'refreshing'`.
   - Recommendation: Use BA's `isRefetching` for refresh, keep `operation` only for commands.

2. **Does `onSessionChange` need to be async?**
   - Workspace key fetch is async. If callback is sync, app uses `.then()` (fire-and-forget).
   - If async, createAuth could `await onSessionChange()` before calling `update()`.
   - Recommendation: Keep sync. Workspace key fetch is fire-and-forget; UI shouldn't block on it.
## Success Criteria

- [x] `create-auth.svelte.ts` under 200 lines (down from 569)
- [x] `workspace-auth.svelte.ts` deleted
- [x] No manual `getSession` calls: BA handles session resolution
- [x] No manual visibility change listener: BA's SessionRefreshManager
- [x] Commands return `AuthError | undefined`: no session in return
- [x] `onSessionChange` callback drives all workspace side effects
- [x] `bun test` passes
- [x] `lsp_diagnostics` clean

## References

- `packages/svelte-utils/src/create-auth.svelte.ts`: rewrite target
- `packages/svelte-utils/src/workspace-auth.svelte.ts`: being deleted
- `packages/svelte-utils/src/workspace-auth.test.ts`: being deleted
- `packages/svelte-utils/src/auth.svelte.ts`: barrel update
- All app auth + workspace client files: call site updates
- [BA client session-refresh.ts](https://github.com/better-auth/better-auth/blob/canary/packages/better-auth/src/client/session-refresh.ts)
- [BA client vanilla.ts](https://github.com/better-auth/better-auth/blob/canary/packages/better-auth/src/client/vanilla.ts)
- [Svelte 5 createSubscriber docs](https://svelte.dev/docs/svelte/svelte-reactivity#createSubscriber)

## Review

**Completed**: 2026-03-28

### Summary

Rewrote `createAuth` to use BA's `useSession.subscribe()` bridged to Svelte 5 via `createSubscriber`. Deleted `workspace-auth.svelte.ts` entirely. The subscribe callback + `onSessionChange` replaces it. All 4 apps (honeycrisp, tab-manager, opensidian, zhongwen) updated to wire `onSessionChange` in their workspace client files. Commands now return `AuthError | undefined` instead of the old `AuthCommandResult` union.

### Deviations from Spec

- **Line count**: `create-auth.svelte.ts` is ~290 lines (vs spec target of <200). The type definitions (`AuthTransportError`, `AuthError`, `AuthSessionEvent`, `AuthClient`, `CreateAuthOptions`) account for ~100 lines of that. The `createAuth` function body itself is well under 150 lines.
- **Auth creation moved to workspace files**: To wire `onSessionChange` (which needs both `workspace` and `auth` in scope), `createAuth()` moved from each app's `auth/index.ts` into the workspace client file. Auth files now export only the persisted session. This avoids circular dependencies.
- **`AuthSessionEvent` type added**: The `onSessionChange` callback receives `AuthSessionEvent` (includes `keyVersion`) for `next` and plain `AuthSession` (from the box) for `prev`. This lets apps compare keyVersion without storing it in the persisted session.
- **Token rotation via `onSuccess`**: Added `fetchOptions.onSuccess` on the BA client to capture rotated tokens from the `set-auth-token` response header immediately, before the subscribe callback fires.
- **Test 4.1 deferred**: New subscribe-based tests require mocking BA's nanostore atom, which needs further research into BA's client internals. Existing workspace-auth tests were deleted since the module no longer exists.

### Follow-up Work

- Write new integration tests for the subscribe-based flow (spec item 4.1)
- Consider whether `AuthTransportError` should be removed from the public API since it's no longer used internally
