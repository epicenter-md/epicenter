# Async Build for createSession

**Date**: 2026-05-12
**Status**: Rejected (kept for the analysis, not for execution)
**Author**: AI-assisted
**Branch**: `codex/auth-bearer-omit-cookies`
**Depends on**: `specs/20260512T220000-session-two-axis-cohesive-reshape.md`
**Stack position**: Proposed widening `createSession.build` to `T | Promise<T>` so tab-manager could drop ~25 lines of deferred-`ready` plumbing. Rejected after a second radical-options pass surfaced a UX regression and net-negative complexity relocation. See the "Why this was rejected" section below.

## Why this was rejected

After drafting the minimal version, a closer mental-inlining pass revealed three problems the spec did not account for:

1. **Wrong-direction complexity relocation.** The proposal deletes ~25 lines of `ready = $state(undefined)` plumbing inside `apps/tab-manager/src/lib/session.svelte.ts` and adds ~30 lines of in-flight-build / promise-detection / race-resolution logic to `packages/svelte-utils/src/session-lifecycle.ts`. Library-central complexity is worse than app-local complexity because every reader of `createSession` must understand it, including consumers (fuji, honeycrisp, opensidian, zhongwen) that never use the async path.

2. **UX regression on cold boot.** Today's `App.svelte` does a triple-await: outer `{#await tabManagerSession.whenReady}` masks the `chrome.storage` load; inner `{#await current.workspace.whenReady}` masks the `openTabManager` + IDB load; `SignedInApp` renders only when both complete. After the proposal, the inner `whenReady` would disappear because the workspace doesn't exist until built. `session.current === null` would conflate "no auth identity" (show sign-in) with "auth identity, workspace loading" (should show Loading). The sign-in card would flash for ~150ms on cold boot. The inner await was doing honest work.

3. **Silent-failure category for async builds.** Sync builds throw synchronously and propagate. Async builds reject: into a `.catch` handler that the spec proposed handling via `console.error` and leaving payload null. New error path that swallows visibly to dev tools but silently to the user.

4. **Speculation about future apps.** No other async-backed app exists today. The cohesive-clean-breaks rule: "Don't design for hypothetical future requirements." If a future Tauri-filesystem or mobile app needs async builds, widen the API then, with the new app as concrete grounding.

The asymmetric-option check should have flagged this earlier: the proposal saves ~25 lines in one isolated file (where the smell is local and documented by structure) and adds ~30 lines of central framework code plus a UX regression plus a new error category. Net negative.

The radical-options skill is explicit: keep the current shape when the weirdness comes from an external runtime constraint, when the radical option deletes behavior users rely on, and when the migration cost exceeds the explanation win. All three apply here. `chrome.storage` is async-only by browser spec; the inner `{#await whenReady}` masks a real load; the migration cost (framework API change + race-condition reasoning + new tests) exceeds the explanation win (one file reads more linearly).

**Decision: leave tab-manager's shape as-is.** The inner `ready = $state(undefined)` + `whenReady` + throw-getter pattern is the honest local cost of async-backed workspace construction on Chrome extensions. Future async-backed apps (if any) will encounter the same constraint and can decide then whether the pattern still earns its keep across multiple consumers.

The rest of this document is the rejected draft, preserved so future reviewers can see what was considered and why it was set aside. Do NOT execute the implementation plan below.

---
**Grounding**:
- Local `apps/tab-manager/src/lib/session.svelte.ts`, `apps/tab-manager/src/lib/platform/auth/auth.ts`, `apps/tab-manager/src/lib/state/storage-state.svelte.ts`, `packages/auth/src/create-oauth-app-auth.ts`, `packages/svelte-utils/src/session.svelte.ts`, `packages/svelte-utils/src/session-lifecycle.ts`, `packages/svelte-utils/src/session-lifecycle.test.ts`.
- Consumer audit (5 sync + 1 async for both `OAuthSessionStorage` and `createSession.build`). See Research Findings.

## One Sentence

```txt
createSession's build callback accepts T or Promise<T>, and the lifecycle
holds payload null until the promise resolves.
```

## Overview

`createSession({ auth, build })` today types `build` as `(identity) => TWorkspace`. Sync-only. Four apps (fuji, honeycrisp, opensidian, zhongwen) have sync builds and this contract fits them perfectly. Tab-manager's `openTabManager` is async (installation ID lookup uses `browser.storage`), so its build callback returns a synchronous object whose real fields are gated behind an internal `ready = $state(undefined)` plus getters that throw if read too early.

This spec widens `build` to accept `T | Promise<T>`. The lifecycle awaits when the build returns a promise; `session.current` stays null until resolution. Tab-manager's internal deferred-`ready` pattern disappears.

**Out of scope** (deliberately: see Rejected Alternatives):
- Widening `OAuthSessionStorage.get()` to accept promises. The 5 sync consumers (fuji, honeycrisp, opensidian, zhongwen, dashboard) plus node CLI all read sync; the wrapper tab-manager builds around `chrome.storage` is doing real work (masking the initial load with a "Loading…" indicator). Deleting it costs a sign-in card flash on cold boot.
- Adding `auth.initialized: boolean` or `whenInitialized: Promise<void>` to the `AuthClient`. Same reason: every "skip the wrapper" option ends up needing a separate "are we ready yet?" signal, which is just relocating the wrapper.
- Trying to make tab-manager's outer shape match fuji's. Chrome extension async storage is the runtime constraint; the wrapper is the honest cost of bridging it.

## Motivation

### Tab-manager's build today

```ts
// apps/tab-manager/src/lib/session.svelte.ts:58-133 (excerpt)
function createWorkspaceSession(auth: AuthClient) {
  return createSession({
    auth,
    build: (identity) => {
      const userId = identity.user.id;
      let disposed = false;
      let ready = $state<ReadyTabManagerSession | undefined>(undefined);
      const whenReady = openTabManager({
        userId,
        peer: createPeer(),
        openWebSocket: auth.openWebSocket,
        encryptionKeys: () => requireIdentity(auth).encryptionKeys,
      }).then((tabManager) => {
        if (disposed) {
          tabManager[Symbol.dispose]();
          return;
        }
        const workspaceAiTools = actionsToAiTools(tabManager.actions);
        const savedTabs = createSavedTabState(tabManager);
        // ...4 more state factories...
        ready = { tabManager: Object.assign(tabManager, { state: {...} }), workspaceAiTools };
        void tabManager.idb.whenLoaded.then(() => registerDevice(tabManager));
      });

      return {
        userId,
        get whenReady() { return whenReady; },
        get tabManager() {
          if (!ready) throw new Error('[tab-manager] tabManager read before signed-in session readiness.');
          return ready.tabManager;
        },
        get workspaceAiTools() {
          if (!ready) throw new Error('[tab-manager] workspaceAiTools read before signed-in session readiness.');
          return ready.workspaceAiTools;
        },
        [Symbol.dispose]() {
          disposed = true;
          ready?.tabManager.state.aiChat[Symbol.dispose]();
          // ...
        },
      };
    },
  });
}
```

What this does:
- Returns a sync object so `createSession`'s type fits.
- Internally tracks `ready = $state(undefined)` for the async work.
- Exposes `whenReady` as a field so consumers (App.svelte's inner await) can wait.
- Each meaningful field (`tabManager`, `workspaceAiTools`) is a getter that throws if read before `ready`.
- Manual `disposed` flag races the async work against `[Symbol.dispose]`.

That's 40 lines of plumbing to bridge "build returns a sync placeholder while the real work runs in the background."

### What it looks like with async build

```ts
function createWorkspaceSession(auth: AuthClient) {
  return createSession({
    auth,
    build: async (identity, { signal }) => {
      const tabManager = await openTabManager({
        userId: identity.user.id,
        peer: await createPeer(),
        openWebSocket: auth.openWebSocket,
        encryptionKeys: () => requireIdentity(auth).encryptionKeys,
      });
      if (signal.aborted) {
        tabManager[Symbol.dispose]();
        throw new Error('aborted');
      }
      const workspaceAiTools = actionsToAiTools(tabManager.actions);
      const savedTabs = createSavedTabState(tabManager);
      const bookmarks = createBookmarkState(tabManager);
      const toolTrust = createToolTrustState(tabManager);
      const unifiedView = createUnifiedViewState({ bookmarks, savedTabs });
      const aiChat = createAiChatState({ auth, tabManager, workspaceAiTools });
      void tabManager.idb.whenLoaded.then(() => registerDevice(tabManager));
      return {
        userId: identity.user.id,
        tabManager: Object.assign(tabManager, {
          state: { savedTabs, bookmarks, toolTrust, unifiedView, aiChat },
        }),
        workspaceAiTools,
        [Symbol.dispose]() {
          aiChat[Symbol.dispose]();
          toolTrust[Symbol.dispose]();
          bookmarks[Symbol.dispose]();
          savedTabs[Symbol.dispose]();
          tabManager[Symbol.dispose]();
        },
      };
    },
  });
}
```

What disappears:
- `ready = $state(undefined)`
- `whenReady` field on the returned object
- `disposed` flag
- The two getter-with-throw pairs
- `Object.assign` after-the-fact wiring (state is added during build, not after)

What survives (and stays correct):
- Outer `tabManagerSession` wrapper: still needs to gate `auth` reads on `authSessionStorage.whenReady`.
- Outer `App.svelte` `{#await tabManagerSession.whenReady}`: still masks the chrome.storage load.

The `session.current.workspace.whenReady` pattern in App.svelte goes away (because the workspace no longer surfaces a `whenReady` field). The inner `{#await}` collapses to `{#if session.current}`.

## Research findings

### Consumer audit

`OAuthSessionStorage` implementers (deliberately not touched):

| Consumer | Backend | Sync or async |
| --- | --- | --- |
| `apps/fuji/src/lib/platform/auth/auth.ts` | `localStorage` via `createPersistedState` | sync |
| `apps/honeycrisp/src/lib/platform/auth/auth.ts` | `localStorage` via `createPersistedState` | sync |
| `apps/opensidian/src/lib/platform/auth/auth.ts` | `localStorage` via `createPersistedState` | sync |
| `apps/zhongwen/src/lib/platform/auth/auth.ts` | `localStorage` via `createPersistedState` | sync |
| `apps/dashboard/src/lib/platform/auth/auth.ts` | `localStorage` via `createPersistedState` | sync |
| `apps/tab-manager/src/lib/platform/auth/auth.ts` | `chrome.storage.local` via `createStorageState` | async (with `whenReady`) |
| `packages/auth/src/node/machine-auth.ts` | filesystem (pre-loaded before construction) | sync at the boundary |

Widening `get()` to `MaybePromise` would touch every implementation (the wrappers stay but the type changes), and the auth-core would gain sync/async branching, and tab-manager would lose its outer "Loading…" mask. Net negative.

`createSession.build` callers (subject of this spec):

| Caller | Sync or async |
| --- | --- |
| fuji, honeycrisp, opensidian, zhongwen | sync |
| tab-manager | sync wrapper around async `openTabManager` |

Widening `build` to `T | Promise<T>`: sync callers are unaffected (their return is `T`, type still fits). Tab-manager's async work moves from inside-the-sync-build to the build itself.

### Why NOT widen `OAuthSessionStorage`

Cold-boot timing comparison for tab-manager:

```txt
Today (storage stays sync, wrapper masks load)
0-50ms   chrome.storage load  → outer await shows "Loading…"
50-200ms openTabManager + IDB → outer await shows "Loading…"
200ms+   workspace renders    → SignedInApp

Widen storage to async (delete wrapper)
0-50ms   chrome.storage load  → auth.state = signed-out, session.current = null,
                                 SIGN-IN CARD FLASHES
50-200ms openTabManager + IDB → still flashing
200ms+   workspace renders    → SignedInApp
```

The wrapper is honestly doing work. The radical-options skill is explicit: "Keep the current shape when the weirdness comes from an external API, file format, or runtime constraint." `chrome.storage` being async-only is the runtime constraint. Leave the wrapper.

### Why NOT add `auth.initialized` or `whenInitialized`

Every "delete the wrapper" path needs a "is auth done loading?" signal to avoid the flash. That signal IS the wrapper, just relocated to a different layer. Net: zero deletion prize, plus an API field that 4 of 5 apps don't need.

### Sync build remains the dominant case

Per the consumer audit, 5 of 6 `createSession` consumers (counting dashboard, even though dashboard doesn't currently use `createSession`) have sync builds. The spec keeps `T` as a valid build return; only `Promise<T>` is added. Zero migration cost for the sync apps.

## Design decisions

| Decision | Class | Choice | Rationale |
| --- | --- | --- | --- |
| `build` return type | 2 coherence | `build: (input) => TWorkspace \| Promise<TWorkspace>` | Smallest possible widening. Sync callers unaffected. |
| Build callback input | 2 coherence | `(input: { identity, signal: AbortSignal })` | `signal` lets async builds short-circuit on auth-state churn. Sync builds ignore. |
| Lifecycle on async build | 1 evidence | `setPayload(null)` immediately on auth state change; await build; if signal aborted or auth has changed, dispose the result and skip set; otherwise `setPayload({ identity, workspace })`. | Same race-resolution pattern that the today's `disposed` flag in tab-manager implements; lifted into the lifecycle. |
| `session.current` during async build | 1 evidence | Stays `null`. | Matches the parent spec's "shape is the discriminator." Apps already render `{:else}` while waiting; tab-manager's outer `{#await whenReady}` continues masking the wait. |
| Tab-manager outer wrapper | 2 coherence | Keep. | Masks `chrome.storage` load. Deleting it costs UX. |
| `requireWorkspace` for tab-manager | 2 coherence | Keep hand-rolled. | The wrapper has to check both "auth client ready" and "session.current truthy"; the package's destructured helper only checks the second. |
| AbortSignal on disposal | 1 evidence | `signal.aborted` becomes true when the lifecycle decides this build is obsolete (signed-out, different user, or `lifecycle[Symbol.dispose]`). | Apps can choose to short-circuit; if they ignore the signal, the lifecycle disposes the resolved workspace anyway. |
| Test coverage | 1 evidence | Add tests for: async build resolves → payload appears; sign-out mid-build → no payload, build result disposed when promise settles; different-user mid-build → old user's in-flight build is aborted, new user's build runs. | Mirrors the existing sync tests. |

## Architecture

### Lifecycle: before / after

```txt
BEFORE (sync build only)
─────────────────────────
reconcile(state):
  if signed-out:
    dispose payload, setPayload(null)
    return
  if no payload:
    workspace = build(identity)        ← MUST RETURN SYNCHRONOUSLY
    setPayload({ identity, workspace })
    return
  if same user: no-op
  else: dispose, onDifferentUser()

AFTER (build can return Promise)
─────────────────────────────────
reconcile(state):
  if signed-out:
    abort any in-flight build
    dispose payload, setPayload(null)
    return
  if no payload AND no in-flight build:
    controller = new AbortController()
    inFlightBuild = { controller, identity }
    const result = build({ identity, signal: controller.signal })

    if (result is not a Promise):              ← SYNC PATH (unchanged behavior)
      setPayload({ identity, workspace: result })
      inFlightBuild = null
      return

    result.then(workspace => {                 ← ASYNC PATH
      if (controller.signal.aborted) {
        workspace[Symbol.dispose]()
        return
      }
      setPayload({ identity, workspace })
      inFlightBuild = null
    }).catch(err => {
      // build threw; surface via console.error and leave payload null
      // (sign-in card stays visible; user can retry)
      inFlightBuild = null
    })
    return
  if same user as in-flight build or as payload: no-op
  else:
    abort in-flight build (if any)
    dispose payload (if any), onDifferentUser()
```

### Tab-manager: before / after

```txt
session.svelte.ts
─────────────────
BEFORE  ~232 lines, includes:
  - 40-line inner build with `ready = $state(undefined)`, two throw-getters, disposed flag
  - tabManagerSession wrapper (kept)
  - hand-rolled requireWorkspace (kept)

AFTER  ~180 lines, includes:
  - ~25-line async inner build (linear control flow)
  - tabManagerSession wrapper (kept, unchanged)
  - hand-rolled requireWorkspace (kept, unchanged)

App.svelte
──────────
BEFORE  Outer {#await tabManagerSession.whenReady}
        → Inner {#if current}
          → Inner {#await current.workspace.whenReady}
            → SignedInApp

AFTER   Outer {#await tabManagerSession.whenReady}    (unchanged: masks chrome.storage load)
        → Inner {#if current}                          (now: null while build resolves too)
          → SignedInApp                                (no more nested await)
```

The cosmetic-but-meaningful win: App.svelte's triple-await collapses to double-await. The session.current value handles both "no auth identity" and "build in flight," same way the four sync apps do (where build is instant so it's never visibly in flight).

## Implementation plan

Two waves. Both small.

### Phase 1: Widen createSession and the lifecycle

- [ ] **1.1** Update `SessionLifecycleConfig.build` in `packages/svelte-utils/src/session-lifecycle.ts` to `(input: { identity: WorkspaceIdentity; signal: AbortSignal }) => TWorkspace | Promise<TWorkspace>`.
- [ ] **1.2** Update `createSessionLifecycle` to handle both sync and async build:
  - Track an in-flight `AbortController`.
  - On sync return: same as today.
  - On promise return: subscribe via `.then`; check `signal.aborted` before `setPayload`; dispose workspace if aborted; clear `inFlightBuild` in both paths.
  - On `signed-out` or different-user: abort the in-flight controller before disposing payload.
- [ ] **1.3** Update `createSession` in `packages/svelte-utils/src/session.svelte.ts` to widen its `build` parameter type to match.
- [ ] **1.4** Add tests in `session-lifecycle.test.ts`:
  - async build resolves to a workspace → payload appears
  - signed-out fires before async build resolves → no payload set, resolved workspace gets disposed
  - different-user fires before async build resolves → old build aborts, new build runs
  - async build rejects → no payload set, no throw at the lifecycle layer

### Phase 2: Tab-manager build async

- [ ] **2.1** Rewrite `createWorkspaceSession`'s inner build in `apps/tab-manager/src/lib/session.svelte.ts` as `async (identity, { signal }) => {...}`. Use linear control flow (no `ready = $state(undefined)`, no throw-getters, no `disposed` flag).
- [ ] **2.2** Drop the `whenReady` field from the build's return object. Remove `current.workspace.whenReady` access.
- [ ] **2.3** Simplify `apps/tab-manager/src/entrypoints/sidepanel/App.svelte`: drop the inner `{#await current.workspace.whenReady}`. Render `<SignedInApp />` directly under `{#if current}`.
- [ ] **2.4** Verify `tabManagerSession` wrapper, exported `whenReady`, and hand-rolled `requireWorkspace` are unchanged. They still own the chrome.storage gate.

### Phase 3: Prove

- [ ] **3.1** `bun test` in `packages/svelte-utils`: old tests pass, new tests pass.
- [ ] **3.2** Per-app typecheck across the monorepo.
- [ ] **3.3** Manual smoke on tab-manager:
  - Cold boot, persisted session: shows "Loading…" (outer await), then SignedInApp. No sign-in card flash.
  - Cold boot, no persisted session: shows "Loading…" briefly (outer await), then sign-in card.
  - Mid-session sign-out: workspace tears down cleanly.
  - Sign-out during build (race): in-flight build aborts, no leak.

## Open questions

1. **AbortSignal ergonomics for sync builds**: sync builds ignore the signal. Is that surface clutter for fuji/honeycrisp/opensidian/zhongwen? The signal is an optional second parameter; sync builds destructure only `{ identity }`. Cost: zero unless they care. Keep.

2. **Should the lifecycle log async build failures?** `result.then(...).catch(err => ?)`. Today's sync builds throw synchronously and propagate up. For consistency, async failures should surface to the developer console at minimum. Recommendation: `console.error('[session] async build failed', err)` and leave payload null. Apps can wrap their own build in try/catch if they want app-specific UX.

3. **Is `Object.assign(tabManager, { state })` safe inside async build?** Today it mutates the workspace doc handle to add a `state` field. With async build, we do this after `await openTabManager(...)` so the order is the same. No semantic change.

4. **Should we also fix the `await Promise.all([createPeer(), ...])` parallelism while we're here?** Today `createPeer()` is one awaited call, then `openTabManager()` is awaited separately. They're already structured sequentially because openTabManager needs the peer. Out of scope unless we discover a real waterfall.

## Rejected alternatives

| Option | Why rejected |
| --- | --- |
| Widen `OAuthSessionStorage.get()` to `MaybePromise` | Deletes tab-manager's outer wrapper but flashes the sign-in card during chrome.storage load. The wrapper masks a real load. Adding `auth.initialized` to compensate just relocates the wrapper. Net: API complexity for no real prize. |
| Add `auth.initialized: boolean` or `whenInitialized: Promise<void>` | Same prize-relocation problem. 4 of 5 apps don't need it. |
| Top-level `await` in `apps/tab-manager/src/lib/platform/auth/index.ts` | Blocks the module graph; sidepanel renders blank page during chrome.storage load. Worse than today's "Loading…" indicator. |
| Make `createOAuthAppAuth` async (return `Promise<AuthClient>`) | Cascades async to every consumer of `auth`. Every app's session module would have to await before exporting. |
| Add a separate `createAsyncSession` factory | Two factories for what is the same lifecycle. Apps would have to know which to pick. The current widening covers both sync and async naturally. |
| Refactor `openTabManager` to be sync (move installation-ID lookup elsewhere) | App-specific workaround. Doesn't help future async-backed builds (Tauri filesystem, mobile, service workers). |

## Decisions log (Class 3 keeps)

- **Keep tab-manager's outer wrapper** (`tabManagerSession`, `whenReady` export, hand-rolled `requireWorkspace`). Revisit only if `chrome.storage` gains a sync API, which won't happen.
- **Keep `OAuthSessionStorage.get()` sync**. Revisit if a future app cannot pre-load storage before construction (none today).
- **Keep sync build as the dominant signature**. Revisit if more than half the apps have async builds (unlikely).

## Acceptance criteria

```txt
- packages/svelte-utils/src/session-lifecycle.ts: SessionLifecycleConfig.build
  accepts T | Promise<T>; the lifecycle handles both branches; AbortSignal
  passes through to async builds.
- packages/svelte-utils/src/session.svelte.ts: createSession's build parameter
  matches the widened type.
- Existing 5 tests continue to pass unchanged.
- 4 new tests cover: async resolves; signed-out mid-build; different-user
  mid-build; build rejects.
- apps/tab-manager/src/lib/session.svelte.ts: createWorkspaceSession's inner
  build is `async (identity, { signal })`; no `ready = $state(undefined)`,
  no throw-getters, no `disposed` flag.
- tabManagerSession wrapper, whenReady export, and hand-rolled
  requireWorkspace are unchanged.
- apps/tab-manager/src/entrypoints/sidepanel/App.svelte: drops the inner
  {#await current.workspace.whenReady}; renders SignedInApp directly under
  {#if current}.
- Per-app typecheck across the monorepo: zero errors in scope.
- Manual smoke: cold-boot with persisted session shows "Loading…" then
  SignedInApp (no sign-in card flash); sign-out during build doesn't leak.
```

## Non-goals

```txt
Do not widen OAuthSessionStorage.get() or auth-core construction. The 5 sync
  consumers don't need it and tab-manager's outer wrapper is doing real UX work.
Do not unify tab-manager's outer shape with fuji/honeycrisp/opensidian/zhongwen.
  Chrome extension async storage is a real runtime constraint.
Do not introduce auth.initialized or whenInitialized as a public field.
Do not refactor openTabManager. The bridge is at createSession, not inside
  workspace constructors.
Do not introduce a parallel createAsyncSession factory.
Do not require sync builds to declare they're sync. The signature accepts
  either return type; type inference does the rest.
```

## References

- `packages/svelte-utils/src/session.svelte.ts`: `createSession`
- `packages/svelte-utils/src/session-lifecycle.ts`: pure lifecycle (the file actually changed)
- `packages/svelte-utils/src/session-lifecycle.test.ts`: existing test suite
- `apps/tab-manager/src/lib/session.svelte.ts`: current divergent build shape
- `apps/tab-manager/src/entrypoints/sidepanel/App.svelte`: current triple-await
- `specs/20260512T220000-session-two-axis-cohesive-reshape.md`: parent spec
- `.agents/skills/radical-options/SKILL.md`: framework that talked us out of the bigger redesign
- `.agents/skills/cohesive-clean-breaks/SKILL.md`: guides the "smallest widening that earns its keep" decision
