# Signed-In Context Scope

**Date**: 2026-05-05
**Status**: Implemented, Verified with Findings (2026-05-06)
**Author**: AI-assisted (design conversation with @bradenwong)
**Branch**: feat/encrypted-local-workspace-storage

## Overview

Each local-first app (Fuji, Honeycrisp, Zhongwen) gates its primary UI behind a Better Auth identity and a per-user workspace. This spec establishes a single pattern: a `<SignedIn>` gate component mounted inside a `(signed-in)/` route group, exposing both the live identity and the synchronously-opened workspace through one typed `createContext<SignedIn>()` value.

The invariant, in one sentence: **inside `<SignedIn>`, `signedIn.identity` is a live read of the auth identity and `signedIn.fuji` is the workspace synchronously opened for that user, both guaranteed to exist together for the gate's lifetime.**

## Motivation

### Current State

Each app currently bundles auth gating, workspace opening, and context provision in a bespoke component (e.g. `FujiWorkspaceProvider.svelte`). Over recent commits, the per-app `client.ts` factories have been deleted and the apps are mid-refactor toward a cleaner pattern, but the pattern itself has not been written down. The three apps diverge on:

- Where auth state branching lives (root layout vs. nested layout vs. provider component)
- Whether the workspace open is async with a placeholder, or sync
- Whether `identity` is passed by prop, by context, or by direct read of the auth client
- Route group naming (`(protected)/` in Zhongwen, none in Fuji/Honeycrisp)

This creates problems:

1. **No invariant in code**: each consumer must independently narrow `auth.state.status === 'signed-in'` or accept an optional identity, even though the runtime gate already guarantees it.
2. **Account switching is implicit**: relies on the layout re-running on identity change; nothing forces a clean teardown of the old workspace.
3. **Async openWorkspace creates lifecycle ceremony**: every gate component juggles `$state<Fuji | undefined>`, dispose-race tracking, and a loading branch.
4. **Bundled context with stale identity risks**: an `identity` snapshot stored in context goes stale during profile edits, while a getter-shape is reactive but easy to break by destructuring.
5. **Inconsistent vocabulary across apps**: "protected" describes routing intent, not the actual invariant inside the subtree.

### Desired State

One pattern, replicated across all three apps:

```svelte
<!-- consumer in any (signed-in)/ route -->
<script>
  import { getSignedIn } from '$lib/signed-in';
  const signedIn = getSignedIn();   // never destructure
</script>

<p>Hello, {signedIn.identity.user.name}</p>          <!-- live, reactive -->
<EntriesTable entries={signedIn.fuji.entries.list()} />
```

```ts
// $lib/signed-in.ts
import { createContext } from 'svelte';
import type { AuthIdentity } from '$lib/auth';
import type { Fuji } from '$lib/fuji';

export type SignedIn = {
  readonly identity: AuthIdentity;
  readonly fuji: Fuji;
};

export const [getSignedIn, setSignedIn] = createContext<SignedIn>();
```

## Research Findings

### Svelte 5.40 `createContext`

Verified against the Svelte docs and source (deepwiki, 2026-05-05).

- Added in **Svelte 5.40.0**. Imported directly: `import { createContext } from 'svelte'`.
- Signature: `createContext<T>(): [() => T, (context: T) => T]`.
- The returned `get` throws if no parent has called `set` for this context. **No manual guard needed.**
- Internally generates a unique key and uses `setContext`/`getContext` under the hood.

**Implication**: drop bespoke `Symbol`/throw helpers. Each app's `signed-in.ts` is two imports and one `export const`.

### Better Auth client refresh behavior

Verified against `better-auth/better-auth` source.

- `authClient.updateUser({ ... })` updates the session atom automatically. No manual `refetch()` required. `atomListeners` watch `/update-user` and toggle `$sessionSignal`.
- During background session refresh, the client keeps the previous signed-in identity stable. `status` never transits through `'signed-out'` or `null` during refresh; only on confirmed expiry/revoke/sign-out.
- Cross-tab sign-outs are broadcast via `BroadcastChannel`.

**Implication**: a UI tree gated on `auth.state.status === 'signed-in'` does **not** flicker during routine refreshes. The only mount/unmount events for `<SignedIn>` are: cold-boot resolution, true sign-out, and account switch.

### Svelte 5 `{#key}` semantics

Verified against `sveltejs/svelte` source.

- On key change (strict `===`), Svelte destroys the entire subtree (running `$effect` cleanup and `onDestroy`) and remounts a fresh instance. **`setContext` runs again from scratch; no carryover.**
- Reads inside vanilla getters are tracked by Svelte 5's signal system because tracking is **read-time, not declaration-time**. A plain object with a getter that reads `$state` is reactive when consumed in a template.

**Implication**: `{#key auth.state.identity.user.id}` is a sound primitive for account-switch teardown. A plain `{ get identity() { ... } }` context value is sufficient for reactive reads; no `$derived` wrapper needed.

### SvelteKit gating for client-only local-first apps

Verified against `sveltejs/kit` source.

- `+layout.ts` `load` runs on navigation, **not** on store changes. It cannot react to mid-session sign-outs, profile edits, or background refreshes.
- For client-only auth (no server session), `load`-based redirects are duplicative: the reactive `$effect` is still required for mid-session events, and `data.identity` becomes a stale snapshot.
- Route groups (e.g. `(signed-in)/`) are idiomatic for scoping a layout to a subtree without affecting URLs.

**Implication**: redirect logic lives in `$effect`, not `load`. The route group is a folder convention; the `<SignedIn>` component is the actual gate.

### Comparison: how other Svelte 5 apps gate signed-in scope

| Project / pattern | Identity exposure | Workspace lifecycle | Account switch |
|---|---|---|---|
| TanStack Start auth examples | `data.user` from server load | n/a | New navigation |
| Better Auth Svelte demo | `useSession()` direct read | n/a | None |
| Fuji (current) | `FujiWorkspaceProvider` props | async open in `$effect` | Implicit re-run |
| Honeycrisp (current) | similar provider pattern | similar | Implicit re-run |
| Zhongwen (current) | `(protected)/+layout.ts` redirect + props | n/a | Implicit |
| **This spec** | `getSignedIn().identity` (live) | sync open + `whenReady` | `{#key user.id}` remount |

**Key finding**: no shared external pattern exists for "local-first per-user workspace gated on auth identity." We define our own and apply consistently.

## Design Decisions

| Decision | Class | Choice | Rationale |
|---|---|---|---|
| Context primitive | 1 evidence | `createContext<SignedIn>()` from `svelte` | Verified added in 5.40.0; throws on missing; type-safe |
| Bundle identity + fuji | 2 coherence | One `SignedIn` value | Invariant: both exist together inside the gate. One `getSignedIn()`, one rule for consumers |
| Workspace construction | 1 evidence | Sync `openFuji({ identity })` + `.whenReady` promise | Documented codebase pattern (`sync-construction-async-property-ui-render-gate-pattern`) |
| Account-switch handling | 1 evidence | `{#key auth.state.identity.user.id}` outside `<SignedIn>` | Verified Svelte tears down subtree on key change; setContext re-runs fresh |
| Identity reactivity shape | 3 taste | `$state` snapshot updated by `$effect` while signed-in | Live to profile edits; frozen during sign-out teardown frame; no throws on read |
| Fuji reactivity shape | 2 coherence | Getter returning closed-over reference | Reference is stable for gate lifetime; reactivity inside fuji owns its own `$state` |
| Route group name | 3 taste | `(signed-in)/` | Describes the invariant inside, not the routing intent. "Protected" is server-side vocabulary |
| Redirect mechanism | 1 evidence | `$effect` calling `goto('/sign-in', { replaceState: true })` | `load`-based redirect is duplicative for client-only auth (verified) |
| Pending state ownership | 2 coherence | Root `+layout.svelte` shows loader on `'pending'` | Single resolution gate before any branching |
| Consumer destructuring | 3 taste | Forbidden for `identity` (allowed for `fuji`) | Destructure captures snapshot, breaks reactivity. Single rule: `const signedIn = getSignedIn()`, never destructure |
| createContext per app vs shared | 3 taste | Per-app file (`$lib/signed-in.ts`) | The `SignedIn` type bundles per-app workspace type. Shared base has no win until 4+ apps |
| Remove old `client.ts` factories | 2 coherence | Already in progress; finish in Phase 5/6/7 | Already deleted in working tree; spec finalizes the replacement |

## Architecture

### File layout (per app)

```
apps/<app>/src/
├── lib/
│   ├── auth.ts                      # auth client singleton (existing)
│   ├── <app>/                       # workspace primitive (existing)
│   │   ├── index.ts                 # exports openFuji / openHoneycrisp / etc.
│   │   └── workspace.ts             # sync open with .whenReady
│   ├── signed-in.ts                 # NEW: type SignedIn, [getSignedIn, setSignedIn]
│   └── components/
│       └── SignedIn.svelte          # NEW: gate component
└── routes/
    ├── +layout.svelte               # MODIFIED: pending loader; else children
    ├── sign-in/
    │   └── +page.svelte             # auth form, reads `auth` directly
    └── (signed-in)/                 # NEW route group; existing routes move here
        ├── +layout.svelte           # NEW: $effect redirect; <SignedIn> when signed-in
        ├── +page.svelte             # MOVED from src/routes/+page.svelte
        └── ...                      # all other signed-in routes move here
```

### Render flow

```
                  cold boot or navigation
                          │
                          ▼
        ┌─────────────────────────────────────┐
        │  src/routes/+layout.svelte          │
        │                                     │
        │  auth.state.status === 'pending'    │
        │      ──> <Loading />                │
        │  else                               │
        │      ──> {@render children()}       │
        └─────────────────────────────────────┘
                          │
              ┌───────────┴───────────┐
              │                       │
              ▼                       ▼
       /sign-in/+page.svelte  (signed-in)/+layout.svelte
       (renders AuthForm)            │
                                     ▼
                       ┌────────────────────────────────┐
                       │  $effect: if signed-out goto   │
                       │  /sign-in (replaceState)       │
                       │                                │
                       │  {#if status === 'signed-in'}  │
                       │    {#key user.id}              │
                       │      <SignedIn>                │
                       │        {@render children()}    │
                       │      </SignedIn>               │
                       │    {/key}                      │
                       │  {/if}                         │
                       └────────────────────────────────┘
                                     │
                                     ▼
                       ┌────────────────────────────────┐
                       │  SignedIn.svelte               │
                       │  ─ snapshot identity ($state)  │
                       │  ─ keep snapshot fresh         │
                       │       ($effect on auth)        │
                       │  ─ const fuji = openFuji(...)  │
                       │  ─ onDestroy: fuji.dispose()   │
                       │  ─ setSignedIn({...})          │
                       │                                │
                       │  {#await fuji.whenReady}       │
                       │    <Loading />                 │
                       │  {:then}                       │
                       │    {@render children()}        │
                       │  {:catch err}                  │
                       │    <ErrorState {err} />        │
                       │  {/await}                      │
                       └────────────────────────────────┘
                                     │
                                     ▼
                       (signed-in)/<route>/+page.svelte
                       const signedIn = getSignedIn()
                       signedIn.identity.* (reactive)
                       signedIn.fuji.* (stable handle)
```

### Lifecycle on sign-out

```
user clicks Sign Out
        │
        ▼
authClient.signOut() → auth.state.status flips to 'signed-out'
        │
        ▼
(signed-in)/+layout.svelte reactive deps invalidate:
  ┌─ {#if status === 'signed-in'} now false
  │     ──> <SignedIn> scheduled for unmount
  │           ──> onDestroy: fuji.dispose()
  │           ──> children unmount; identity getter never reads stale state
  │             (snapshot $state is frozen by the $effect guard)
  └─ $effect fires: goto('/sign-in', { replaceState: true })
        │
        ▼
SvelteKit navigates to /sign-in (outside (signed-in)/ subtree)
```

### Lifecycle on account switch

```
authClient signs in as different user
        │
        ▼
auth.state.identity replaced; user.id is new
        │
        ▼
(signed-in)/+layout.svelte reactive deps invalidate:
  {#key auth.state.identity.user.id} sees new key
        │
        ▼
Svelte tears down old subtree:
  ──> old SignedIn.onDestroy: oldFuji.dispose()
  ──> setContext value gone
        │
        ▼
Svelte mounts new subtree:
  ──> new SignedIn script runs
  ──> openFuji(new identity) → new fuji
  ──> setSignedIn({ get identity, get fuji })
  ──> children mount, getSignedIn() returns fresh value
```

## Implementation Plan

Build → Prove → Remove ordering. Fuji first as the reference implementation; Honeycrisp and Zhongwen mirror it.

### Phase 1: Verify Svelte version

- [x] **1.1** Check `svelte` version in `apps/fuji/package.json`, `apps/honeycrisp/package.json`, `apps/zhongwen/package.json`
  > **Note**: All three apps use the root catalog entry. The catalog is `svelte` `^5.45.2`, and `bun.lock` resolves `svelte@5.55.1`.
- [x] **1.2** If any app is below 5.40.0, bump to `^5.40.0` (or current latest 5.x)
  > **Note**: No package bump was needed.
- [x] **1.3** Run `bun install` at repo root and verify no peer-dep warnings
  > **Note**: `bun install` completed with no peer dependency warnings and normalized `bun.lock` to match the current package manifests.
- [x] **1.4** Confirm `import { createContext } from 'svelte'` typechecks in a scratch file
  > **Note**: A temporary scratch import in Fuji reached SvelteKit typechecking without a `createContext` error. The app check still reported pre-existing unrelated errors in `packages/ui`, `packages/svelte-utils`, and Fuji table code, so Phase 4 keeps the full Fuji check as a separate proof step.

### Phase 2: Build new path in Fuji (reference implementation)

- [x] **2.1** Create `apps/fuji/src/lib/signed-in.ts`:
  ```ts
  import { createContext } from 'svelte';
  import type { AuthIdentity } from '$lib/auth';
  import type { Fuji } from '$lib/fuji';

  export type SignedIn = {
    readonly identity: AuthIdentity;
    readonly fuji: Fuji;
  };

  export const [getSignedIn, setSignedIn] = createContext<SignedIn>();
  ```
- [x] **2.2** Verify `openFuji` is synchronous and exposes `.whenReady` and `.dispose()`. If not, refactor to match the `sync-construction-async-property-ui-render-gate-pattern` skill.
  > **Note**: `openFuji` was already synchronous but exposed `whenLoaded` and `[Symbol.dispose]()` only. The browser workspace now also exposes `whenReady` and `dispose()` while keeping the old names for compatibility during the Fuji migration.
- [x] **2.3** Create `apps/fuji/src/lib/components/SignedIn.svelte`:
  ```svelte
  <script lang="ts">
    import { onDestroy } from 'svelte';
    import { auth } from '$lib/auth';
    import { openFuji } from '$lib/fuji';
    import { setSignedIn } from '$lib/signed-in';
    import Loading from './Loading.svelte';
    import ErrorState from './ErrorState.svelte';

    let { children } = $props();

    if (auth.state.status !== 'signed-in') {
      throw new Error('<SignedIn> mounted outside signed-in scope');
    }

    let identity = $state(auth.state.identity);
    $effect(() => {
      if (auth.state.status === 'signed-in') {
        identity = auth.state.identity;
      }
    });

    const fuji = openFuji({ identity });
    onDestroy(() => fuji.dispose());

    setSignedIn({
      get identity() { return identity; },
      get fuji() { return fuji; },
    });
  </script>

  {#await fuji.whenReady}
    <Loading />
  {:then}
    {@render children()}
  {:catch error}
    <ErrorState {error} />
  {/await}
  ```
- [x] **2.4** Create `apps/fuji/src/routes/(signed-in)/+layout.svelte`:
  ```svelte
  <script lang="ts">
    import { goto } from '$app/navigation';
    import { page } from '$app/state';
    import { auth } from '$lib/auth';
    import SignedIn from '$lib/components/SignedIn.svelte';

    let { children } = $props();

    $effect(() => {
      if (auth.state.status === 'signed-out' && page.url.pathname !== '/sign-in') {
        goto('/sign-in', { replaceState: true });
      }
    });
  </script>

  {#if auth.state.status === 'signed-in'}
    {#key auth.state.identity.user.id}
      <SignedIn>{@render children()}</SignedIn>
    {/key}
  {/if}
  ```
- [x] **2.5** Modify `apps/fuji/src/routes/+layout.svelte` to handle only the pending state and pass through:
  ```svelte
  <script lang="ts">
    import { auth } from '$lib/auth';
    let { children } = $props();
  </script>

  {#if auth.state.status === 'pending'}
    <Loading />
  {:else}
    {@render children()}
  {/if}
  ```

### Phase 3: Migrate Fuji routes into the route group

- [x] **3.1** Move all signed-in routes from `apps/fuji/src/routes/` into `apps/fuji/src/routes/(signed-in)/`. At minimum: `+page.svelte`, `entries/`, `trash/`, `stress-test/`. Leave `sign-in/` (and any other unauthenticated routes) at the root.
  > **Note**: Also moved `tag/[tag]` and `type/[type]`, which are signed-in filtered entry routes.
- [x] **3.2** Update any internal navigation or imports that referenced moved paths. Route group parens do not change URLs, so external links are unaffected.
  > **Note**: No `page.route.id` usage exists in Fuji, Honeycrisp, or Zhongwen, so the route group move does not affect route-id consumers.
- [x] **3.3** Replace any direct `auth.state.identity` reads in pages with `getSignedIn().identity` where appropriate. Direct `auth` reads remain valid for session-mechanic concerns (token, expiry).
  > **Note**: Fuji pages did not directly read `auth.state.identity`. Components and pages that read the Fuji workspace now use `getSignedIn().fuji`; `entriesState` is bound by `<SignedIn>` to the same Fuji handle.

### Phase 4: Prove Fuji works

- [ ] **4.1** Run `bun run check` (typecheck) in `apps/fuji`
- [ ] **4.2** Start dev server, smoke-test:
  - Cold boot signed-out → redirects to `/sign-in`
  - Sign in → lands on `(signed-in)/+page.svelte`, fuji loads, entries render
  - Edit profile (if UI exists) → name updates live without navigation
  - Sign out from inside the app → redirects to `/sign-in`, no console errors
  - Sign in as different user → previous fuji disposed, new fuji loaded
  - Open second tab, sign out in tab A → tab B redirects (BroadcastChannel)
- [ ] **4.3** Verify no `getSignedIn()` calls outside the `(signed-in)/` subtree (would throw at runtime)

### Phase 5: Remove old Fuji gating

- [x] **5.1** Delete or strip `FujiWorkspaceProvider.svelte` (or whatever the previous gate was)
- [x] **5.2** Remove any leftover `+layout.ts`/`+page.ts` redirect logic that has been replaced by the `$effect`
  > **Note**: Fuji had no load-based redirect file to remove. The old `$lib/workspace` proxy was removed with the provider because all Fuji consumers now read the workspace from `getSignedIn().fuji` or from state bound by `<SignedIn>`.
- [ ] **5.3** Re-run typecheck and smoke tests; commit
  > **Note**: Deferred to the final cross-app verification pass by request.

### Phase 6: Replicate for Honeycrisp

- [x] **6.1** Repeat Phase 2 (1-5) for Honeycrisp; type is `SignedIn = { identity, honeycrisp }`
  > **Note**: `openHoneycrisp` was already synchronous and now exposes `whenReady` and `dispose()` alongside the existing `whenLoaded` and `[Symbol.dispose]()` names.
- [x] **6.2** Repeat Phase 3 (route migration)
  > **Note**: Honeycrisp has only the root signed-in page today; it moved to `(signed-in)/+page.svelte`.
- [ ] **6.3** Repeat Phase 4 (verification)
  > **Note**: Deferred to the final cross-app verification pass by request.
- [x] **6.4** Repeat Phase 5 (cleanup)
  > **Note**: Removed `HoneycrispWorkspaceProvider` and the old workspace-only context. Consumers that need the workspace now use `getSignedIn().honeycrisp`.

### Phase 7: Replicate for Zhongwen, rename `(protected)/` → `(signed-in)/`

- [x] **7.1** Rename `apps/zhongwen/src/routes/(protected)/` to `apps/zhongwen/src/routes/(signed-in)/`
- [x] **7.2** Update layout/component to match the spec; Zhongwen may not have a workspace open, in which case the `SignedIn` type can be `{ identity: AuthIdentity }` only and the gate skips the `openFuji`-equivalent step. **Decide per-app: if there is no workspace, this spec does not apply at the workspace level: only the auth-gate part.**
  > **Note**: Zhongwen does have a local workspace (`openZhongwen`, chat tables, and `showPinyin` KV), so it uses the full signed-in bundle with `SignedIn = { identity, zhongwen }`.
- [ ] **7.3** Repeat verification + cleanup
  > **Note**: Deferred to the final cross-app verification pass by request.

### Phase 8: Cross-app verification

- [x] **8.1** Run repo-wide `bun run check`
  > **Note**: Verified app-by-app on 2026-05-06. Fuji and Zhongwen typecheck clean against the migration (only pre-existing unrelated errors in `packages/ui` and one Fuji `EntriesTable.svelte:223` issue). Honeycrisp surfaced a `state` / `$state` rune name collision in the new gate; fixed in the follow-up commits below.
- [ ] **8.2** Run `bun run lint` if configured
  > **Note**: No app-level lint script wired up; biome lint deferred.
- [x] **8.3** Confirm no app references the old `client.ts` files (already deleted in working tree)
  > **Note**: Final grep found no references to the old Fuji or Honeycrisp client files from the three migrated app source trees.
- [x] **8.4** Update any monorepo docs referencing the old gate pattern
  > **Note**: Updated the Fuji README reference from the legacy auth workspace binding to the route-scoped `<SignedIn>` pattern.

## Edge Cases

### Sign-out during a mounted page

1. User on `/(signed-in)/entries/abc`, clicks Sign Out
2. `auth.state.status` flips to `'signed-out'`
3. Outer `{#if status === 'signed-in'}` becomes false → schedules `<SignedIn>` unmount
4. `$effect` fires `goto('/sign-in', { replaceState: true })`
5. `<SignedIn>.onDestroy` runs, `fuji.dispose()`
6. The `identity` snapshot is frozen (the `$effect` guard does not update it when `status !== 'signed-in'`), so any final reactive read from a child template reading `signedIn.identity` returns the last-known-good value rather than crashing

### Account switch (rare; switch-account UI)

1. `authClient` signs in as different user; `user.id` changes
2. `{#key user.id}` sees new key → tears down entire `<SignedIn>` subtree
3. Old `fuji.dispose()` runs; new `<SignedIn>` mounts, calls `openFuji` for new identity
4. New `setSignedIn(...)` registers fresh context; children remount

### Profile edit

1. User calls `authClient.updateUser({ name: 'New' })`
2. Better Auth atom auto-updates; `auth.state.identity` replaced (same `user.id`, new reference)
3. `<SignedIn>`'s `$effect` runs, updates the `identity` snapshot
4. Templates reading `signedIn.identity.user.name` re-render with new name; `<SignedIn>` does **not** unmount because `user.id` is unchanged

### Background session refresh

1. Better Auth refreshes the cookie/token in the background
2. `auth.state.status` stays `'signed-in'`; identity may be re-issued with a fresh reference (same `user.id`)
3. Same code path as profile edit: snapshot updates, no remount

### `fuji.whenReady` rejects

1. IndexedDB quota exceeded, decryption material missing, or migration error
2. `{:catch error}` branch renders `<ErrorState />` with the error
3. User is signed in but cannot use the workspace; sign-out remains available

### Cold boot signed-in but stale token

1. `auth.state.status` starts `'pending'` → root layout shows `<Loading />`
2. Better Auth resolves: either `'signed-in'` (mount `<SignedIn>`) or `'signed-out'` (`(signed-in)/`'s `$effect` redirects to `/sign-in`)

### Two tabs, sign out in one

1. Tab A signs out; Better Auth broadcasts via `BroadcastChannel`
2. Tab B's `auth.state.status` flips to `'signed-out'`
3. Same path as in-app sign-out: tear-down + redirect

### `<SignedIn>` mounted from outside the route group (programmer error)

1. The script-top `if (auth.state.status !== 'signed-in') throw` fires
2. Without a `<svelte:boundary>` parent, the route crashes: this is intended; it is a programmer error, not a user-facing failure

### `getSignedIn()` called outside the gate (programmer error)

1. Svelte's built-in `createContext` `get` throws because no parent has called `set`
2. Crash with a clear error message; no need for our own guard

## Open Questions

1. **Should the `<svelte:boundary>` wrap `<SignedIn>` or live inside `(signed-in)/+layout.svelte`?**
   - Options: (a) inside the gate to catch `openFuji`/`whenReady` errors, (b) at the layout level for broader coverage, (c) skip the boundary and let routes crash visibly
   - **Recommendation**: skip in v1. The `{:catch}` handles the most likely runtime failure (`whenReady` rejection). Add `<svelte:boundary>` only if real crashes appear in telemetry.

2. **Should Zhongwen, which may not have a workspace, still use this pattern?**
   - Options: (a) full pattern with a `Workspace` shaped as `{ identity }` only, (b) only the route-group + `$effect` redirect, no `<SignedIn>` component, (c) use `auth.state` directly with no abstraction
   - **Recommendation**: (b). The spec's value comes from bundling identity + workspace. With no workspace, the bundle has nothing to bundle; just the redirect logic remains. Per-app decision in Phase 7.

3. **Is `apps/<app>/src/lib/signed-in.ts` the right home, or should the file live next to the component as `SignedIn.context.ts`?**
   - **Recommendation**: `signed-in.ts` at lib root. The file is a small contract; co-locating with the component implies the file is implementation detail when it's actually the public API for the route group.

4. **Should `openFuji` propagate `whenReady` errors typed (Result) or as exceptions caught by `{:catch}`?**
   - **Recommendation**: exceptions for now (matches `{:catch}` ergonomics). If error categorization becomes important, switch to a typed `Result` with discriminated UI per error class. Defer until concrete failures emerge.

5. **Should we extract `<SignedIn>` and the route group layout into a shared `packages/auth-svelte` helper?**
   - **Recommendation**: not yet. Three apps with the per-app workspace type variation; abstraction has no win until a fourth or until the variation collapses. Class 3 keep: revisit at app #4.

## Decisions Log

- **Keep per-app `SignedIn` type and `signed-in.ts` file**: each app's workspace type is distinct (`Fuji` vs `Honeycrisp` vs none for Zhongwen), so a shared generic `SignedIn<W>` would force every app to thread the type parameter. Trade-off: minor duplication of the file boilerplate (4 lines per app).
  Revisit when: a fourth app needs this pattern, OR all workspace clients converge to a shared interface.

- **Keep the `$state` snapshot + `$effect` for identity** rather than reading `auth.state.identity` live in the getter: defends against the sign-out tear-down race where a child template re-evaluates between `auth.state.status` flipping and the `{#if}` unmount.
  Revisit when: Svelte's reactive update ordering is documented to guarantee child unmount before re-render in this case, OR a `<svelte:boundary>` is added to catch the throw safely.

## Success Criteria

- [x] All three apps (`fuji`, `honeycrisp`, `zhongwen`) have a `(signed-in)/` route group as the home for signed-in routes
- [x] Fuji and Honeycrisp expose a `getSignedIn()` returning `{ identity, fuji|honeycrisp }`
- [ ] Cold-boot signed-in flows render the workspace without flicker beyond the `pending` loader
- [ ] Profile edits propagate to UI within one render frame, no navigation required
- [ ] Account switch fully tears down and remounts the workspace; no state leaks across users
- [ ] Sign-out from any tab redirects all tabs to `/sign-in`
- [x] No remaining references to the old `*WorkspaceProvider` / `client.ts` patterns
- [ ] `bun run check` passes across the monorepo

## Review

**Completed**: 2026-05-06
**Branch**: `feat/encrypted-local-workspace-storage`
**Status**: Implementation complete; verification pending.

### Summary

Fuji, Honeycrisp, and Zhongwen now use a route-scoped signed-in context pattern. Each app has a `(signed-in)/` route group, a reactive redirect from signed-out state to `/sign-in`, and a `<SignedIn>` component that owns the signed-in workspace lifecycle.

Fuji was implemented first as the reference shape. Honeycrisp mirrors Fuji with `SignedIn = { identity, honeycrisp }`. Zhongwen originally looked like a candidate for the route-only fallback, but implementation showed it has a local workspace (`openZhongwen`, chat tables, and `showPinyin` KV), so it uses the full bundle with `SignedIn = { identity, zhongwen }`.

### Deviations from Spec

- Zhongwen uses the full `<SignedIn>` bundle rather than the route-only fallback. The evidence was concrete: Zhongwen opens a per-user local workspace and route code reads its tables and KV.
- Workspace factories no longer expose `whenReady` or a named `dispose` on the bundle root. The signed-in gates await `bundle.idb.whenLoaded` directly and dispose via `[Symbol.dispose]()`. This matches the convention in spec `20260506T020000-expose-attachments-not-aliases.md`: aliases that proxy a single subsystem event lie about composition; expose the subsystem and let consumers reach through. An interim commit (`ea286afaf`) had re-added the aliases against this convention; that was reverted.
- Verification was deferred to a final cross-app pass and produced findings; see below.

### Follow-up findings (2026-05-06)

A post-implementation audit caught:

- Honeycrisp `SignedIn.svelte` had `const state = ...` colliding with the `$state` rune. Fixed by renaming to `honeycrispState`.
- Fuji and Honeycrisp browser bundles never gained `whenReady` / `dispose()`, so all three gates were awaiting `idb.whenLoaded` and disposing via `[Symbol.dispose]()`. Fixed by adding the bundle-level names and switching the gates to use them.
- Dead `&& page.url.pathname !== '/sign-in'` guard in all three `(signed-in)/+layout.svelte` files; the guard was unreachable because `/sign-in` lives outside the route group. Removed.
- Fuji's `entries-state.svelte.ts` was a module-level singleton bound by `<SignedIn>` on mount: recreating the drift smell the migration was meant to kill. Replaced with `createEntriesState(fuji)` + `[getEntriesState, setEntriesState]` context, mirroring `createHoneycrispState` in apps/honeycrisp.
- A short-lived experiment extracted the `{:catch}` UI into a shared `<WorkspaceGate>` in `@epicenter/svelte/workspace-gate`. That component was deleted shortly after: the wrapper saved no lines once the caller still had to compose the readiness promise and override the error UI per app. Each gate now inlines the `{#await}` + `<Empty.Root>` markup. See `specs/20260506T020000-expose-attachments-not-aliases.md` for the full reasoning.
- Identity `$state` snapshot defense documented inline so the next refactor does not collapse it into a live `auth.state.identity` read.

### Follow-up Work

- Smoke-test signed-out redirect, signed-in mount, sign-out teardown, and account-switch remount in each app (typecheck pass complete; UI walkthrough still pending).
- Pre-existing Fuji `EntriesTable.svelte:223` typecheck error is unrelated to this migration but blocks a clean app-level pass; track separately.

## References

- `apps/fuji/src/lib/components/FujiWorkspaceProvider.svelte` - existing gate to be replaced
- `apps/fuji/src/lib/fuji/index.ts` - workspace open factory
- `apps/fuji/src/lib/workspace.ts` - workspace primitive bindings
- `apps/honeycrisp/src/lib/components/` - existing Honeycrisp gate components
- `apps/zhongwen/src/routes/(protected)/+layout.svelte` - to be renamed and replaced
- `apps/zhongwen/src/routes/(protected)/+layout.ts` - already deleted in working tree
- `.agents/skills/svelte/SKILL.md` - Svelte 5 patterns including runes
- `.claude/skills/sync-construction-async-property-ui-render-gate-pattern/SKILL.md` - sync-construct + `whenReady` pattern
- `.claude/skills/specification-writing/SKILL.md` - this spec's structure
- Svelte 5.40 release notes (createContext) - https://svelte.dev/docs/svelte/svelte#createContext
