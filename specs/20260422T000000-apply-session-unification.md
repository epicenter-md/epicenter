# applySession Unification: Collapse Auth → Workspace Imperative Coupling

**Status:** Complete (2026-04-22)
**Created:** 2026-04-22
**Supersedes:** specs/20260329T012324-subscribe-based-auth.md (partial: keeps the subscribe-based core, removes callback wiring)

## Problem

Every app's `client.ts` currently wires auth to workspace through imperative callbacks:

```ts
// apps/fuji/src/lib/client.ts (and honeycrisp, tab-manager, opensidian, zhongwen: same shape)
export const workspace = openFuji();

export const auth = createAuth({
  baseURL: APP_URLS.API,
  session,
  onLogin(session) {
    workspace.encryption.applyKeys(session.encryptionKeys);
    workspace.sync.reconnect();
  },
  async onLogout() {
    await workspace.idb.clearLocal();
    window.location.reload();
  },
});
```

Inside `openFuji()`:

```ts
const sync = attachSync(ydoc, {
  getToken: async () => auth.token,  // closure captures `auth`: which is defined BELOW this call
  // ...
});
```

Three problems:

1. **Circular ownership.** `workspace` reads `auth.token` via closure; `auth` calls `workspace.sync.reconnect()` / `workspace.encryption.applyKeys()`. Each side owns pieces of the other's lifecycle.
2. **Forward reference at module scope.** `openFuji()` is called before `auth` is defined; the closure is only safe because it fires lazily. Moving one line silently breaks it.
3. **No clear owner of sync lifecycle.** `onLogout` does `window.location.reload()` and skips `sync.goOffline()`. Sync lives on `workspace` but is driven by auth.

The `openXxx` rename (commit `3b8dd15e`) was cosmetic. The underlying composition was not touched. This spec fixes it.

## Target architecture

One direction of dependency. One method on workspace. One reactive seam.

```
openFuji()                  ← library-agnostic; exposes applySession(session | null)
createAuth()                ← Svelte-rune session source; knows nothing of workspace
client.svelte.ts            ← single $effect.root seam wires them
```

After:

```ts
// apps/fuji/src/lib/client.svelte.ts
export const workspace = openFuji();

export const auth = createAuth({
  baseURL: APP_URLS.API,
  session,
});

$effect.root(() => {
  $effect(() => {
    workspace.applySession(auth.session);
  });
});
```

Three lines of wiring. No closure on `auth.token`. No `onLogin`/`onLogout` callbacks mutating workspace. No forward reference.

## Why `$effect.root` is correct here (grounded)

Verified against `sveltejs/svelte` via DeepWiki:

- `$effect` at bare module scope throws `rune_outside_svelte`. Module-scope reactive bindings **must** wrap in `$effect.root`.
- `$effect.root` creates a non-tracked scope with no auto-cleanup. For app-lifetime singletons in an SPA, never calling the returned disposer is **not a leak**: the effect's lifecycle matches the app's, which matches the page's.
- No GC concern. The workspace and auth singletons are intended to live forever; references between them are expected graph edges, not leaks.
- Svelte batches reactive updates in a microtask, so rapid session changes collapse into one `applySession` call.
- SSR: `$effect` is a no-op on the server. Fuji/Honeycrisp/Tab-Manager/Opensidian/Zhongwen are browser-only; not a concern.
- HMR: module reload can leave a stale root effect. Guard in dev:
  ```ts
  const dispose = $effect.root(() => { $effect(() => workspace.applySession(auth.session)); });
  if (import.meta.hot) import.meta.hot.dispose(dispose);
  ```

Verified against `yjs/yjs` via DeepWiki:

- Yjs has no standard "session-aware provider" pattern. Wrappers encapsulating token + keys + reconnect behind one behavioral method is the idiomatic shape.
- `y-websocket` has no native `getToken`: the idiomatic flow is configure → reconnect, which is exactly what `applySession` will do internally.

## API changes

### 1. `openXxx` return shape: add `applySession`

Every workspace factory that currently attaches sync or encryption gains one method:

```ts
applySession(session: AuthSession | null): void;
```

Internally, `applySession` does:

- **If `session` is non-null:**
  - `encryption.applyKeys(session.encryptionKeys)`: already idempotent via fingerprint dedup (`packages/workspace/src/document/attach-encryption.ts:198`).
  - Update the stored token used by sync (see §2 below).
  - `sync.reconnect()`: forces a fresh connect with the new token (`packages/workspace/src/document/attach-sync.ts:705`).
- **If `session` is null:**
  - Clear the stored token.
  - `sync.goOffline()` (if it exists) or equivalent: close the websocket and stop the supervisor. **Spec note:** `attachSync` currently exposes `reconnect()` but not `goOffline()` in the public type (`packages/workspace/src/document/attach-sync.ts:97-138`). A `goOffline()` / `disconnect()` method must be added to `SyncAttachment`. See §4.

For workspaces without sync (Whispering, Zhongwen): `applySession` only calls `encryption.applyKeys` on login and is a no-op on logout (or wipes IDB: see §5).

### 2. `attachSync`: accept a token slot instead of `getToken` closure

Replace:

```ts
getToken?: (docId: string) => Promise<string | null>;
```

With a pushed-in token:

```ts
// in SyncAttachment return type:
setToken(token: string | null): void;

// in attachSync config: remove getToken entirely
// internally: sync reads from a local `currentToken: string | null` variable
// on each connect attempt (lines 399-420), instead of calling getToken()
```

The existing `getToken()` call site at `attach-sync.ts:399-420` becomes a synchronous read of the local slot. No more async fetch inside the supervisor loop. Auth errors from "no token available" remain, just surfaced when `currentToken` is null and the supervisor is `desired: 'online'`.

### 3. `attachSync`: add `goOffline`

```ts
// add to SyncAttachment
goOffline(): void;  // set desired = 'offline', close ws, stop supervisor
// then applySession(null) can call this
```

A later `applySession(session)` flips `desired` back to `online` before calling `reconnect()`.

### 4. `createAuth`: drop `onLogin` / `onLogout`, expose `session` as a rune

Current `AuthClient` (at `packages/svelte-utils/src/auth/create-auth.svelte.ts:37-158`) exposes `token`, `user`, `isAuthenticated`, `isBusy` as reactive getters but not the full `AuthSession`. Add:

```ts
readonly session: AuthSession | null;  // reactive getter; single source of truth
```

Remove from `CreateAuthOptions`:

```ts
onLogin?: (session: AuthSession) => void;    // DELETE
onLogout?: () => void | Promise<void>;       // DELETE
```

The subscribe handler at `create-auth.svelte.ts:296-317` stops calling the removed callbacks; it only updates `session.current`. Consumers observe `auth.session` reactively instead.

**Boot-time onLogin** (lines 319-330) is also deleted: the `$effect` in `client.svelte.ts` fires on mount with the current value, which is the same behavior.

### 5. Logout data-clearing becomes workspace's responsibility

Currently auth's `onLogout` does `await workspace.idb.clearLocal(); window.location.reload();`. With callbacks gone, `applySession(null)` is now the single place to handle logout:

```ts
async applySession(session) {
  if (session === null) {
    sync.goOffline();
    await idb.clearLocal();
    // No window.location.reload(): state is already cleared; Svelte re-renders.
    // If apps genuinely need a reload (e.g. to reset non-workspace state), they do it
    // in a separate $effect that watches auth.session === null.
    return;
  }
  encryption.applyKeys(session.encryptionKeys);
  sync.setToken(session.token);
  sync.reconnect();
}
```

**Decision point:** Does any app genuinely require `window.location.reload()` on logout? Audit usage; if yes, keep it as an app-level `$effect` in `client.svelte.ts`, separate from `applySession`. Default: drop it.

## Per-file migration

| File | Change |
|---|---|
| `packages/workspace/src/document/attach-sync.ts` | Drop `getToken` config. Add `setToken(token \| null)` and `goOffline()` methods. Supervisor reads from local token slot instead of calling `getToken()`. |
| `packages/workspace/src/document/attach-encryption.ts` | No changes. `applyKeys` already idempotent. |
| `packages/svelte-utils/src/auth/create-auth.svelte.ts` | Drop `onLogin` / `onLogout` from options. Drop the boot-time `applyBoot` call. Expose `readonly session: AuthSession \| null` on `AuthClient`. |
| `packages/svelte-utils/src/auth/auth-types.ts` | No changes. `AuthSession` type stays as-is. |
| `apps/fuji/src/lib/client.ts` → `client.svelte.ts` | Add `applySession` to `openFuji` return. Remove `getToken` from `attachSync` call. Remove `onLogin`/`onLogout` from `createAuth` call. Add `$effect.root` wiring. Update any imports in consuming files from `./client` (path stays the same: the `.svelte.ts` extension resolves via SvelteKit/Vite). |
| `apps/honeycrisp/src/lib/client.ts` → `client.svelte.ts` | Same as Fuji. |
| `apps/tab-manager/src/lib/client.ts` → `client.svelte.ts` | Same as Fuji, plus the post-device-registration `.sync.reconnect()` call at line 92 becomes `workspace.applySession(auth.session)` (or kept if device registration is orthogonal: audit). |
| `apps/opensidian/src/lib/client.ts` → `client.svelte.ts` | Same as Fuji. |
| `apps/zhongwen/src/lib/client.ts` → `client.svelte.ts` | No sync, but gains `applySession` for encryption-only flow. |
| `apps/whispering/src/lib/client.ts` → `client.svelte.ts` | No sync, no auth in current codebase: check if whispering has or will have auth. If no, no changes. |

## Acceptance criteria

1. No file in `apps/*/src/lib/client.svelte.ts` contains the strings `onLogin`, `onLogout`, `workspace.sync.reconnect`, `workspace.encryption.applyKeys`, or `getToken`. All session wiring goes through `workspace.applySession(auth.session)` in a single `$effect.root`.
2. `openFuji()` (and peers) can be called at module scope without any reference to `auth` in scope. `attachSync` no longer receives a token callback.
3. Grep `\.sync\.reconnect\|\.encryption\.applyKeys\|\.sync\.goOffline` across the repo: zero matches outside `packages/workspace/src/document/attach-*.ts` (the implementations) and `applySession` in workspace factories.
4. Login → sync reconnects with new token (manual verify in Fuji: sign in, network tab shows new ws with correct token param).
5. Logout → sync disconnects, IDB cleared (manual verify: sign out, network tab shows ws close, IDB dev tools shows empty).
6. Token refresh via `set-auth-token` header still works: `auth.session` updates → `$effect` fires → `applySession` reconnects with new token.
7. HMR in dev does not accumulate duplicate effects across edits to `client.svelte.ts` (verified with `import.meta.hot.dispose`).
8. `bun run check` and `bun test` pass.

## Open questions

- **Tab-manager's post-registration reconnect (line 92):** Is this called *after* auth login, or independently? If after login, it becomes redundant once `$effect` fires on session update. If independent (device registration is a separate lifecycle), keep it but rename the call from `.sync.reconnect()` to a method that expresses the intent: possibly `workspace.applySession(auth.session)` to force a re-apply, or a new `workspace.sync.refresh()` if we want to keep sync addressable.
- **`window.location.reload()` on logout:** Default to dropping it. Audit each app to confirm no app-specific state requires a full reload.
- **Whispering's auth status:** Does Whispering currently or imminently gain auth? If not, skip it; this spec touches it only if it already has the pattern.
- **Test coverage:** `attachSync` tests (`packages/workspace/src/document/attach-sync.test.ts`) cover `reconnect` and status round-trips. Add tests for `setToken` + `goOffline` behavior. `createAuth` tests were previously deleted (per 20260329T012324 spec); a minimal session-exposure test is worth adding.

## Out of scope

- No changes to `attachEncryption`, `attachIndexedDb`, `attachBroadcastChannel`, or `attachAwareness`.
- No changes to `AuthSession` / `EncryptionKeys` / `StoredUser` types.
- No changes to auth form components or sign-in flows.
- No introduction of a "bundle factory" (`createSession` / `createClientBundle`). Each app's `client.svelte.ts` stays explicit. If duplication becomes painful later, that's a follow-up.
