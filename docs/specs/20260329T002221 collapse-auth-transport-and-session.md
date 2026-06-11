# Collapse Auth Transport + Session into `createAuth`

**Date**: 2026-03-29
**Status**: In Progress
**Author**: AI-assisted

## Overview

Merge `createAuthTransport()` and `createAuthSession()` into a single `createAuth()` factory. Auth reads and writes a "box" (`{ current: AuthSession }`) passed in by the caller. The same shape `createPersistedState` already returns. One BA client with a dynamic token getter, zero prop threading, zero new abstractions.

## Motivation

### Current State

Every app wires auth the same way. Three factories, five manually threaded props:

```typescript
const session = createPersistedState({ key: '...', schema: AuthSession, defaultValue: { status: 'anonymous' } });
const authTransport = createAuthTransport({ baseURL: APP_URLS.API });
const authState = createAuthSession({
    storage: session,
    resolveSession: authTransport.resolveSession,
    commands: { signIn: authTransport.signInWithPassword, signUp: authTransport.signUpWithPassword },
    signOutRemote: authTransport.signOutRemote,
});
```

Problems:

1. **Prop threading**: 5 transport methods manually wired into session options. Identical across all 4 apps
2. **Separate stateless transport creates ephemeral clients**: `makeClient(token)` per operation because the transport doesn't know the current token
3. **Storage adapter indirection**: `AuthSessionStorage` exists so auth can read reactive session state it doesn't own. But auth can just read/write a box

### Desired State

```typescript
const session = createPersistedState({ key: '...', schema: AuthSession, defaultValue: { status: 'anonymous' } });
export const authState = createAuth({ baseURL: APP_URLS.API, session });
```

One function. Auth reads `session.current` for the token, writes `session.current` on sign-in/out. What backs the box, `$state`, localStorage, chrome.storage, is none of auth's business.

## Design Decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Merge transport + session | Single `createAuth()` | Transport and session are always used together. No app uses one without the other. Prop threading is pure boilerplate. |
| Session state | External "box" `{ current: AuthSession }` | Auth reads/writes `.current`. The box owner decides what backs it (`$state` + localStorage, chrome.storage, plain variable in tests). No new persistence type needed. |
| BA client token | `token: () => session.current.token` | Dynamic getter called per-request. One client instance, no `makeClient(token)`. |
| Per-request override | `fetchOptions.headers.Authorization` in `resolveWithToken()` | Only needed for command→getSession bridge where new token isn't in state yet. |
| Google sign-in DI | `signInWithGoogle?: () => Promise<{ idToken: string; nonce: string }>` | Callback returns credentials only. Transport call (signIn.social) stays internal. |
| `fetchWorkspaceKey` | Method on `AuthClient` return type | Auth already has `baseURL` and `token`: no reason to thread separately. |
| Operation state | Internal `$state<AuthOperation>` | Only auth mutates operation lifecycle (bootstrapping→idle→signing-in→idle). Not part of the box. |

## Architecture

```
BEFORE (3 factories, prop threading)
─────────────────────────────────────────────────
  createPersistedState()  ──► AuthSessionStorage
          │
          ▼
  createAuthTransport({ baseURL })
    ├─ makeClient(token)  ← per operation
    ├─ resolveSession(current)
    ├─ signInWithPassword(input)
    ├─ signUpWithPassword(input)
    ├─ signOutRemote(current)
    └─ signInWithGoogleIdToken({...})
          │
          │  5 props threaded manually
          ▼
  createAuthSession({ storage, resolveSession, commands, signOutRemote })
    ├─ $state<AuthOperation>
    ├─ refresh()
    ├─ signIn(), signUp(), signInWithGoogle()
    └─ signOut()
          │
          ▼
  createWorkspaceAuth({ workspace, auth, fetchWorkspaceKey, reconnect })

AFTER (1 factory, 1 box, zero threading)
─────────────────────────────────────────────────
  createPersistedState()
          │
          ▼
  { current: AuthSession }  ◄── the box
          │
          ▼
  createAuth({ baseURL, session, signInWithGoogle? })
    ├─ const client = createAuthClient(...)        ← ONE instance
    │     fetchOptions.auth.token: () => session.current.token
    ├─ session.current                              ← reads/writes the box
    ├─ let operation = $state<AuthOperation>         ← internal only
    ├─ resolveWithToken(token)                       ← internal
    ├─ commandThenResolve(command)                   ← internal
    ├─ refresh()
    ├─ signIn(), signUp(), signInWithGoogle()
    ├─ signOut()
    └─ fetchWorkspaceKey()                           ← new method
          │
          ▼
  createWorkspaceAuth({ workspace, auth, reconnect })
    └─ calls auth.fetchWorkspaceKey() directly
```

## Implementation Plan

### Wave 1: Create the collapsed `createAuth` module

- [ ] **1.1** Create `packages/svelte-utils/src/create-auth.svelte.ts` with:
  - `CreateAuthOptions` type: `{ baseURL: BaseURL; session: { current: AuthSession }; signInWithGoogle?: () => Promise<{ idToken: string; nonce: string }> }`
  - `createAuth()` function merging transport + session internals
  - Single `createAuthClient` with `token: () => session.current.status === 'authenticated' ? session.current.token : undefined`
  - All transport helpers internal: `extractCommandToken`, `resolveWithToken`, `commandThenResolve`, `classifyBetterAuthError`
  - All session helpers internal: `applyResolvedSession`, `executeAuthCommand`
  - Internal `$state<AuthOperation>` for lifecycle state (only auth mutates this)
  - Auth reads `session.current` for current state, writes `session.current = next` on changes
  - `fetchWorkspaceKey()` as a method on the returned `AuthClient`
  - Same `AuthClient` return type shape (session, operation, isRefreshing, refresh, signIn, signUp, signInWithGoogle, signOut, fetch)
- [ ] **1.2** Export `AuthTransportError`, `AuthError`, `SessionResolution`, `AuthClient`, `CreateAuthOptions` from the new module
- [ ] **1.3** Keep `auth-types.ts` unchanged (StoredUser, AuthSession, AuthOperation still needed)

### Wave 2: Update barrel exports

- [ ] **2.1** Update `packages/svelte-utils/src/auth.svelte.ts` barrel:
  - Export `createAuth`, `CreateAuthOptions` from `./create-auth.svelte.js`
  - Export `AuthTransportError`, `AuthError`, `AuthClient`, `SessionResolution` from `./create-auth.svelte.js`
  - Keep exporting `AuthSession`, `StoredUser`, `AuthOperation` from `./auth-types.js`
  - Keep exporting `createWorkspaceAuth`, `CreateWorkspaceAuthOptions` from `./workspace-auth.svelte.js`
  - Remove `createAuthTransport`, `createAuthSession`, `AuthSessionStorage` exports

### Wave 3: Update `workspace-auth.svelte.ts`

- [ ] **3.1** Update imports to use the new module's types
- [ ] **3.2** Remove `fetchWorkspaceKey` prop from `CreateWorkspaceAuthOptions`: call `auth.fetchWorkspaceKey()` directly
- [ ] **3.3** Update `applyAuthResult` to call `auth.fetchWorkspaceKey()` instead of the injected function
- [ ] **3.4** Update workspace-auth tests

### Wave 4: Update app call sites

- [ ] **4.1** `apps/honeycrisp/src/lib/auth/index.ts`: replace with `createAuth({ baseURL, session })` where session is `createPersistedState(...)` (already returns `{ current }`)
- [ ] **4.2** `apps/opensidian/src/lib/auth/index.ts`: same pattern
- [ ] **4.3** `apps/zhongwen/src/lib/auth.ts`: same pattern
- [ ] **4.4** `apps/tab-manager/src/lib/state/auth.svelte.ts`: use `createAuth` with `createStorageState` box + `signInWithGoogle` credential getter

### Wave 5: Delete old modules + verify

- [ ] **5.1** Delete `packages/svelte-utils/src/auth-transport.ts`
- [ ] **5.2** Delete `packages/svelte-utils/src/auth-session.svelte.ts`
- [ ] **5.3** Move/update `auth-transport.test.ts` → `create-auth.test.ts` (test `createAuth` directly)
- [ ] **5.4** Run `bun test` in `packages/svelte-utils`: all pass
- [ ] **5.5** `lsp_diagnostics` clean on all changed files

## Edge Cases

### Cross-tab sync

Cross-tab sync is the box's responsibility, not auth's. `createPersistedState` already handles this. It listens for `storage` events and updates `.current`. Auth sees the update because it reads `.current` on every access. Chrome extension storage works the same way via `chrome.storage.onChanged`.

### First boot (empty storage)

1. Box starts with `{ status: 'anonymous' }` (the `defaultValue` from `createPersistedState`)
2. BA client sends no token (getter returns undefined)
3. Boot sequence calls `refresh()` which resolves from server
4. On success, auth writes `session.current = { status: 'authenticated', ... }`
5. Box persists automatically (it's a persisted state)

### Sign-in → getSession bridge

1. `client.signIn.email()` returns a new token
2. Token not yet in box (session not updated yet)
3. `resolveWithToken(newToken)` passes per-request `Authorization` header
4. `getSession` returns full session with `keyVersion`
5. Auth writes `session.current = { authenticated }` → box persists, BA client's getter now returns new token

### Tab manager Google sign-in callback change

1. Currently: callback does chrome.identity + calls `authTransport.signInWithGoogleIdToken()`
2. After: callback does chrome.identity, returns `{ idToken, nonce }`
3. `createAuth` internally calls `client.signIn.social()` with those credentials
4. Cancellation/failure still caught by `executeAuthCommand`'s try/catch: the thrown error from chrome.identity propagates naturally

## Success Criteria

- [ ] `bun test` passes in `packages/svelte-utils`
- [ ] `lsp_diagnostics` clean on all changed files
- [ ] All 4 apps typecheck (`bun run typecheck`)
- [ ] `auth-transport.ts` and `auth-session.svelte.ts` deleted
- [ ] No app imports `createAuthTransport` or `createAuthSession`
- [ ] Each app auth setup is ≤10 lines (down from 15-40)

## References

- `packages/svelte-utils/src/auth-transport.ts`: being absorbed
- `packages/svelte-utils/src/auth-session.svelte.ts`: being absorbed
- `packages/svelte-utils/src/auth-types.ts`: kept as-is
- `packages/svelte-utils/src/workspace-auth.svelte.ts`: updated imports + fetchWorkspaceKey
- `packages/svelte-utils/src/auth.svelte.ts`: barrel, updated exports
- `apps/honeycrisp/src/lib/auth/index.ts`: call site update
- `apps/opensidian/src/lib/auth/index.ts`: call site update
- `apps/zhongwen/src/lib/auth.ts`: call site update
- `apps/tab-manager/src/lib/state/auth.svelte.ts`: call site update + Google callback change
