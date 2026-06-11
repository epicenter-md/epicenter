# Route loader singleton auth collapse

**Date**: 2026-05-05
**Status**: Implemented, verification blocked by existing shared diagnostics
**Author**: AI-assisted, grounded against live code, DeepWiki, and SvelteKit docs
**Branch**: feat/encrypted-local-workspace-storage
**Supersedes (in part)**: `specs/20260505T030000-browser-workspace-route-loaders.md` (zhongwen pilot)
**Pairs with**: this is the cleanup pass after the pilot landed; what the pilot built stays, what the pilot accidentally introduced gets refused

## One-sentence thesis

Auth is a const singleton imported anywhere; route-group `+layout.ts` files are pure identity gates that build a fresh workspace per signed-in session and pass narrowed `AuthIdentity` plus `Zhongwen` through `data`; the module-level workspace cache, the `SignedInAuth` intersection type, the `forgetDevice` bundle method, and the `{#key}` remount block all collapse.

## Why this spec exists

The route-loader pilot (spec `20260505T030000`) successfully moved signed-in workspace construction from a TLA-driven `client.ts` singleton to `(authed)/+layout.ts`. That win is real and stays. Reviewing the pilot revealed complexity that the predecessor spec accepted as canonical but does not earn its keep:

```
Module-level let cached: { auth, zhongwen, unsubscribe } | null = null
disposeCached() function with optional chaining
import.meta.hot.dispose hook in (authed)/+layout.ts
auth.onChange listener registered inside load()
SignedInAuth = AuthClient & { readonly identity: AuthIdentity }
forgetDevice() bundled on the workspace (1 internal caller)
{#key data.zhongwen.userId} block in (authed)/+page.svelte
$effect(() => { let active = true; ... goto('/') ... }) in sign-in/+page.svelte
createCookieAuth(...) constructed in TWO places (sign-in page + authed layout)
```

DeepWiki + SvelteKit docs confirm: `+layout.ts` `load` does not rerun on internal navigation in an SPA; the cache only earns its keep for HMR. That's a small benefit for nine pieces of complexity. Refuse the cache; the rest collapses.

## The asymmetric refusals

```
Refusal 1: cache the workspace across loads
  Deletes:
    - module-level `let cached`
    - `disposeCached()` with optional chaining
    - `import.meta.hot.dispose` hook in (authed)/+layout.ts
    - cache-hit branch in load
    - userId tracking in cached object
  User loss: HMR rebuilds the workspace on dev-time hot reload (already bounded; full reload cleans up)

Refusal 2: support live in-tab user switch
  Deletes:
    - {#key data.zhongwen.userId} in (authed)/+page.svelte
    - the user-switch branch of auth.onChange (becomes window.location.reload)
  User loss: ~200ms reload flash on cross-tab user switch (rare in single-account app)

Refusal 3: bundle takes auth (full client)
  Deletes:
    - SignedInAuth type (intersection-extension code smell)
    - the AuthClient & { readonly identity: AuthIdentity } pattern
    - forgetDevice() on the bundle (1-caller helper)
    - signOut coupling inside browser.ts
  User loss: none; bundle gets cleaner narrow type (AuthIdentity), forgetDevice
  is two lines at the UI dialog handler

Refusal 4: per-route auth construction
  Deletes:
    - createCookieAuth in sign-in/+page.svelte
    - createCookieAuth in (authed)/+layout.ts
    - second import.meta.hot.dispose hook
    - $effect with `let active` flag in sign-in/+page.svelte
    - sign-in page's auth[Symbol.dispose]() cleanup
  User loss: none; one auth instance is correct, two was a bug-in-waiting
```

Together these four refusals collapse roughly 80 lines into roughly 40, deletes three named concepts (cache, SignedInAuth, forgetDevice), and removes every `let` and optional-chain from the auth/route plumbing.

## Grounding

DeepWiki on `sveltejs/kit` confirms the load behavior the cache was defending against:

```
Q: Does (authed)/+layout.ts load rerun when navigating from / to /entries/abc?
A: No. Layout load reruns only when params/url/depends/invalidate change.
   Internal navigation within the layout group does not rebuild data.
   Component instances are reused; data prop updates if the value changed.

Q: Returned object reference stability?
A: Same reference across navigations within the same layout (ssr=false).

Q: Where should auth.onChange subscriptions live?
A: +layout.svelte via $effect (or onMount). Subscriptions in load risk
   re-registration. load is for data fetching, not subscription lifecycle.
```

DeepWiki on `sveltejs/svelte` confirms the lifecycle pattern:

```
Q: Pattern A (script body create, $effect cleanup) vs Pattern B ($effect setup+cleanup)?
A: Pattern A is canonical for non-prop-reactive resources. Script body runs
   exactly once on instance creation. The asymmetry is intended idiom, not a smell.
```

Together these mean: the workspace can be created once per layout-mount in `load`, disposed in the layout's `$effect` cleanup, and the auth listener can live in the layout's `$effect`. No module-level cache needed.

## Design decisions

| Decision | Class | Choice | Rationale |
|---|---|---|---|
| Auth construction site | 2 coherence | const singleton in `$lib/auth.ts` | Both `(public)` and `(authed)` need auth; one client per app instance is correct; `const` is honest |
| Auth disposal in HMR | 1 evidence | `import.meta.hot.dispose` on the singleton module | Vite's documented HMR contract; lives where the disposable thing actually is |
| Workspace cache in `(authed)/+layout.ts` | 2 coherence | Removed | Per DeepWiki, load doesn't rerun on internal nav; cache only helped HMR; cost ≫ benefit |
| Workspace disposal | 2 coherence | `$effect` cleanup in `(authed)/+layout.svelte` | Workspace lifetime = layout-mount lifetime; SvelteKit unmounts the layout on navigation away |
| Auth listener location | 1 evidence | `(authed)/+layout.svelte` `$effect` | Per DeepWiki: subscriptions belong in component lifecycle, not load |
| Bundle parameter type | 2 coherence | `{ identity: AuthIdentity }` | `AuthIdentity` is already non-nullable by definition; no intersection trick needed |
| `SignedInAuth` type | Open | Delete (recommended) | Zero callers after Refusal 3; see Open Questions |
| `forgetDevice` on bundle | 2 coherence | Removed | 1 caller; inline at UI dialog handler |
| `wipe` on bundle | 2 coherence | Kept | UI calls it directly now; clear, narrow verb |
| `{#key}` on userId | 3 taste | Removed | UX cost of reload on user-switch is a 200ms flash on a rare event; the simpler page is worth it |
| User-switch handling | 3 taste | `window.location.reload()` | Rare event; reload is acceptable; deletes `{#key}` and the user-switch branch |
| Sign-out handling | 2 coherence | `invalidateAll()` → `redirect(307, '/sign-in')` | Common case stays smooth (no reload flash) |
| Sign-in page redirect-when-signed-in | 2 coherence | `(public)/+layout.ts` `redirect()` | Route boundary owns the policy; deletes the page-level `$effect` with `let active` |
| Pass `auth` or `identity` through `data`? | 3 taste | Both: `identity` (narrowed prop) + auth singleton (imported) | Splits "proven-narrow data" from "ambient client" |
| Chat-state's `auth.fetch` access | 3 taste | Import singleton directly | Fewer props; chat-state is app-specific, coupling is fine |

## Architecture

### Module structure

```
apps/zhongwen/src/lib/
├── auth.ts                              ← const singleton + HMR dispose
└── zhongwen/
    ├── index.ts                         ← iso doc factory (unchanged)
    └── browser.ts                       ← takes identity, returns Zhongwen

apps/zhongwen/src/routes/
├── +layout.ts                           ← export const ssr = false
├── +layout.svelte                       ← global mounts (Toaster, ModeWatcher)
├── (public)/
│   ├── +layout.ts                       ← redirect signed-in users to /
│   ├── +layout.svelte                   ← invalidateAll on sign-in
│   └── sign-in/+page.svelte             ← dumb form
└── (authed)/
    ├── +layout.ts                       ← redirect signed-out, build workspace
    ├── +layout.svelte                   ← workspace dispose + auth listener
    └── +page.svelte                     ← <ZhongwenWorkspace />
```

### Lifecycle flow

```
INITIAL LOAD (signed in, navigates to /)
  ─────────────────────────────────────────────────
  $lib/auth.ts module evaluated → const auth = createCookieAuth(...)
  + +layout.ts (root)            → ssr=false
  (authed)/+layout.ts load()     → await auth.whenReady
                                 → auth.identity ✓ (narrowed)
                                 → openZhongwen({ identity })
                                 → return { identity, zhongwen }
  (authed)/+layout.svelte mounts → $effect: cleanup disposes zhongwen
                                 → $effect: subscribes to auth.onChange
  (authed)/+page.svelte mounts   → renders ZhongwenWorkspace

INTERNAL NAVIGATION (/ → /entries/abc within authed)
  ─────────────────────────────────────────────────
  load DOES NOT rerun (per DeepWiki)
  data.zhongwen reference unchanged
  workspace stays alive

SIGN-OUT (user clicks sign-out anywhere in (authed))
  ─────────────────────────────────────────────────
  auth.signOut() resolves
  auth.onChange fires (next === null)
  layout.svelte $effect → invalidateAll()
  load reruns → !auth.identity → redirect(307, '/sign-in')
  (authed) layout unmounts
  $effect cleanup runs → zhongwen[Symbol.dispose]()
  user lands on /sign-in

USER SWITCH (rare; cross-tab cookie change)
  ─────────────────────────────────────────────────
  auth.onChange fires (next.user.id !== zhongwen.userId)
  layout.svelte $effect → window.location.reload()
  fresh page load → fresh auth singleton → fresh workspace

FORGET DEVICE (user clicks "Forget device" in UI)
  ─────────────────────────────────────────────────
  await zhongwen.wipe()  ← disposes doc, awaits idb, deletes IDB data
  await auth.signOut()   ← triggers sign-out flow above
```

### Key code shapes

`$lib/auth.ts`:

```ts
import { createCookieAuth } from '@epicenter/auth-svelte';
import { APP_URLS } from '@epicenter/constants/vite';

export const auth = createCookieAuth({ baseURL: APP_URLS.API });

if (import.meta.hot) {
  import.meta.hot.dispose(() => auth[Symbol.dispose]());
}
```

`$lib/zhongwen/browser.ts`:

```ts
import type { AuthIdentity } from '@epicenter/auth';
import {
  attachOwnedBroadcastChannel,
  wipeOwnerLocalYjsData,
} from '@epicenter/workspace';
import { openZhongwen as openZhongwenDoc } from './index';

export function openZhongwen({ identity }: { identity: AuthIdentity }) {
  const userId = identity.user.id;
  const doc = openZhongwenDoc({ encryptionKeys: identity.encryptionKeys });
  const idb = doc.encryption.attachIndexedDb(doc.ydoc, { userId });
  attachOwnedBroadcastChannel(doc.ydoc, { userId });

  return {
    ...doc,
    idb,
    userId,
    whenLoaded: idb.whenLoaded,
    async wipe() {
      doc[Symbol.dispose]();
      await idb.whenDisposed;
      await wipeOwnerLocalYjsData({ userId, ydocGuids: [doc.ydoc.guid] });
    },
    [Symbol.dispose]() {
      doc[Symbol.dispose]();
    },
  };
}

export type Zhongwen = ReturnType<typeof openZhongwen>;
```

`(authed)/+layout.ts`:

```ts
import { redirect } from '@sveltejs/kit';
import { auth } from '$lib/auth';
import { openZhongwen } from '$lib/zhongwen/browser';

export async function load() {
  await auth.whenReady;
  if (!auth.identity) redirect(307, '/sign-in');

  const zhongwen = openZhongwen({ identity: auth.identity });
  return { identity: auth.identity, zhongwen };
}
```

`(authed)/+layout.svelte` (new):

```svelte
<script lang="ts">
  import { invalidateAll } from '$app/navigation';
  import { auth } from '$lib/auth';

  let { data, children } = $props();

  $effect(() => () => data.zhongwen[Symbol.dispose]());

  $effect(() => {
    return auth.onChange((next) => {
      if (next === null) {
        void invalidateAll();
        return;
      }
      if (next.user.id !== data.zhongwen.userId) {
        window.location.reload();
        return;
      }
      data.zhongwen.encryption.applyKeys(next.encryptionKeys);
    });
  });
</script>

{@render children()}
```

`(authed)/+page.svelte`:

```svelte
<script lang="ts">
  import ZhongwenWorkspace from '$lib/components/ZhongwenWorkspace.svelte';
  import type { PageData } from './$types';
  let { data }: { data: PageData } = $props();
</script>

<ZhongwenWorkspace identity={data.identity} zhongwen={data.zhongwen} />
```

`(public)/+layout.ts`:

```ts
import { redirect } from '@sveltejs/kit';
import { auth } from '$lib/auth';

export async function load() {
  await auth.whenReady;
  if (auth.identity) redirect(307, '/');
  return {};
}
```

`(public)/+layout.svelte` (new):

```svelte
<script lang="ts">
  import { invalidateAll } from '$app/navigation';
  import { auth } from '$lib/auth';

  let { children } = $props();

  $effect(() => {
    return auth.onChange((next) => {
      if (next !== null) void invalidateAll();
    });
  });
</script>

{@render children()}
```

`(public)/sign-in/+page.svelte`:

```svelte
<script lang="ts">
  import { Button } from '@epicenter/ui/button';
  import { auth } from '$lib/auth';

  let submitError = $state<string | null>(null);

  async function signInWithGoogle() {
    const { error } = await auth.signInWithSocialRedirect({
      provider: 'google',
      callbackURL: window.location.origin,
    });
    if (error) submitError = error.message;
  }
</script>

<!-- markup unchanged from current sign-in page -->
```

`ZhongwenWorkspace.svelte` (changes):

```svelte
<script lang="ts">
  import { auth } from '$lib/auth';
  import type { AuthIdentity } from '@epicenter/auth';
  import type { Zhongwen } from '$lib/zhongwen/browser';
  // ...other imports

  let {
    identity,
    zhongwen,
  }: {
    identity: AuthIdentity;
    zhongwen: Zhongwen;
  } = $props();

  const showPinyin = fromKv(zhongwen.kv, 'showPinyin');
  const chatState = createChatState({ zhongwen });
  let dismissedError = $state(false);

  const handle = $derived(chatState.active);

  $effect(() => () => {
    chatState[Symbol.dispose]();
  });

  function openForgetDeviceDialog() {
    confirmationDialog.open({
      title: 'Forget this device?',
      description:
        'This deletes local Zhongwen data on this device. Account data on the server stays in your account.',
      confirm: { text: 'Forget device', variant: 'destructive' },
      onConfirm: async () => {
        try {
          await zhongwen.wipe();
          await auth.signOut();
        } catch (error) {
          toast.error('Failed to forget this device', {
            description: extractErrorMessage(error),
          });
        }
      },
    });
  }
</script>

<!-- header reads {identity.user.name} instead of $derived(auth.identity)?.user.name -->
```

`chat-state.svelte.ts` (signature change):

```ts
import { auth } from '$lib/auth';

export function createChatState({ zhongwen }: { zhongwen: Zhongwen }) {
  // ... uses auth.fetch directly inside fetchServerSentEvents callback
}
```

## Implementation plan

Wave-ordered (Build, Stop, Verify, Remove). Spec branch may break during the middle waves; the final wave restores green.

### Wave 1: Build new path

- [x] **1.1** Create `apps/zhongwen/src/lib/auth.ts` exporting `const auth = createCookieAuth(...)` plus the `import.meta.hot.dispose` handler.
- [x] **1.2** Change `apps/zhongwen/src/lib/zhongwen/browser.ts` to take `{ identity: AuthIdentity }`, drop `forgetDevice`, keep `wipe`, export `type Zhongwen = ReturnType<typeof openZhongwen>`.
- [x] **1.3** Update `apps/zhongwen/src/lib/chat/chat-state.svelte.ts` to drop the `auth` parameter and import the `auth` singleton directly. Update its prop type to `{ zhongwen: Zhongwen }`.
- [x] **1.4** Rewrite `(authed)/+layout.ts` to the gate-only shape (no cache, no listener, no HMR hook). Return `{ identity, zhongwen }`.
- [x] **1.5** Create `(authed)/+layout.svelte` with the two `$effect` blocks (workspace dispose + auth listener).
- [x] **1.6** Rewrite `(authed)/+page.svelte` to the one-line ZhongwenWorkspace render (no `{#key}`).
- [x] **1.7** Update `ZhongwenWorkspace.svelte` props to `{ identity, zhongwen }`, import `auth` singleton, inline the forget-device dialog handler.
- [x] **1.8** Create `(public)/+layout.ts` that redirects signed-in users to `/`.
- [x] **1.9** Create `(public)/+layout.svelte` with the `auth.onChange` → `invalidateAll()` `$effect`.
- [x] **1.10** Strip `(public)/sign-in/+page.svelte` of its own `createCookieAuth` and `$effect` redirect; import `auth` singleton instead.

### Wave 2: Stop importing the old path

- [x] **2.1** Search-and-replace any remaining `ReturnType<typeof openZhongwen>` to `Zhongwen` import.
- [x] **2.2** Confirm no file imports `SignedInAuth` from `@epicenter/auth` anywhere in `apps/zhongwen`.
- [x] **2.3** Confirm no file references `forgetDevice` as a method on the zhongwen bundle.

### Wave 3: Verify

- [ ] **3.1** Typecheck: `bun run typecheck` passes.
  > **Note**: Full typecheck is still blocked by existing shared package diagnostics in `packages/ui`, `packages/svelte-utils/src/from-table.svelte.ts`, `packages/svelte-utils/src/workspace-gate/workspace-gate.svelte`, and `apps/tab-manager`. Auth and auth-svelte targeted typechecks pass. Zhongwen-specific dependency and AI fetch-client diagnostics found during this pass were fixed.
- [ ] **3.2** Manual smoke: signed-out user reaches `/sign-in`.
- [ ] **3.3** Manual smoke: sign-in via Google reaches `/` and renders chat.
- [ ] **3.4** Manual smoke: sign-out from chat redirects to `/sign-in` without page reload.
- [ ] **3.5** Manual smoke: forget device wipes IDB and lands on `/sign-in`.
- [ ] **3.6** Manual smoke: hot-reload an unrelated file; chat survives without leaks.
- [ ] **3.7** Manual smoke: cross-tab user switch reloads cleanly (or no-op for same user).
- [ ] **3.8** Internal nav test: navigate within `(authed)` (when more pages exist); verify load does not rerun and workspace reference is stable.

### Wave 4: Remove the old path

- [x] **4.1** Grep `apps/zhongwen` for `cached`, `disposeCached`, `SignedInAuth`, `forgetZhongwenDevice`, `forgetDevice`, `let active`. All should be gone.
- [x] **4.2** Grep `packages/auth` for callers of `SignedInAuth` and `isSignedIn`. If zero, delete from `packages/auth/src/create-auth.ts`, the export in `packages/auth/src/index.ts`, the re-export in `packages/auth-svelte/src/index.ts`, and the test in `packages/auth/src/contract.test.ts`. (See Open Questions.)
- [x] **4.3** Update `specs/20260505T030000-browser-workspace-route-loaders.md` Status to `Implemented (zhongwen pilot) revised by 20260505T040000` so the predecessor spec doesn't read as the canonical pattern for fuji/honeycrisp/opensidian rollout.

### Wave 5: Roll out to other SvelteKit apps (deferred to follow-up spec)

> **Note**: this wave's shape was further refined by `20260505T060000-zhongwen-context-and-listener-collapse.md`. The fuji / honeycrisp / opensidian rollout adopts T060000's shape, not this spec's: workspace handle published through Svelte 5 `createContext` (not the SvelteKit `data` prop), workspace constructed in `(protected)/+layout.svelte` script body (not `load()`), single `auth.onChange` listener with three branches (sign-out goto, user-switch reload, same-user `applyKeys`), `onDestroy` for both unsubscribe and workspace dispose, no `hasDisposed` flag, no `SignedInAuth` intersection type, no `forgetDevice` bundle method.

Track in a separate rollout spec.

- [ ] **5.1** Apply the T060000 shape to `apps/fuji`.
- [ ] **5.2** Apply the T060000 shape to `apps/honeycrisp`.
- [ ] **5.3** Apply the T060000 shape to `apps/opensidian`.

Each rollout has app-specific concerns (sync, peer identity, child-doc caches) that the follow-up spec owns.

## Edge cases

### OAuth callback returns to `/`

1. User on `/sign-in` clicks "Sign in with Google".
2. `auth.signInWithSocialRedirect` does a full page navigation to Google.
3. Google redirects back to `window.location.origin` (i.e. `/`).
4. Browser reloads the SPA from scratch; `$lib/auth.ts` module re-evaluates; new auth singleton reads the cookie.
5. `(authed)/+layout.ts` `load` runs, identity is now non-null, returns `{ identity, zhongwen }`.
6. Chat renders. No special handling needed.

### Sign-in in another tab

1. Tab A is on `/sign-in`. Tab B signs in. Cookies update.
2. Tab A's `auth` singleton fires `onChange` (via cookie sync or refresh).
3. `(public)/+layout.svelte` `$effect` calls `invalidateAll()`.
4. `(public)/+layout.ts` reruns, sees `auth.identity` is now non-null, redirects to `/`.
5. Tab A lands on chat without manual reload.

### Sign-out in another tab while on `/`

1. Tab A is on `/` (authed). Tab B signs out.
2. Tab A's `auth.onChange` fires with `next === null`.
3. `(authed)/+layout.svelte` `$effect` calls `invalidateAll()`.
4. `(authed)/+layout.ts` reruns, identity is null, redirects to `/sign-in`.
5. Layout unmounts, `$effect` cleanup disposes the workspace.

### User switch in another tab

1. Tab A is on `/` as user X. Tab B signs out and signs in as user Y.
2. Tab A's `auth.onChange` fires with `next.user.id !== data.zhongwen.userId`.
3. `(authed)/+layout.svelte` `$effect` calls `window.location.reload()`.
4. Full reload: fresh auth singleton, fresh workspace built for user Y.

### HMR

1. Developer edits `(authed)/+layout.ts`. Vite hot-reloads.
2. The component instance MAY be rebuilt depending on Vite's HMR strategy for SvelteKit layouts.
3. If the layout is rebuilt, the `$effect` cleanup disposes the workspace, then `load` reruns and builds a fresh one.
4. If `$lib/auth.ts` is hot-reloaded, the `import.meta.hot.dispose` handler disposes the old singleton; the new module creates a new one. Components re-import.
5. Any temporary leak resolves on next full reload. Bounded.

### Same-user re-sign-in

1. User signs out. Layout unmounts. Workspace disposed. Lands on `/sign-in`.
2. User signs in as the same user.
3. `(public)/+layout.svelte` `$effect` calls `invalidateAll()`.
4. `(public)/+layout.ts` reruns, identity now non-null, redirects to `/`.
5. `(authed)/+layout.ts` runs fresh: builds a NEW workspace for the same userId.
6. The IndexedDB data is keyed on userId, so the new workspace loads the same persisted data. No data loss.

## Open questions

1. **Delete `SignedInAuth` and `isSignedIn` from `packages/auth`?**
   - Options: (a) delete entirely, (b) keep as private utilities, (c) keep exported for consumer convenience.
   - **Recommendation**: Delete. After this spec, zhongwen has zero callers. fuji/honeycrisp/opensidian still have callers via the old `client.ts` pattern, but Wave 5 rolls out the new pattern there too, removing the last callers. The intersection-extension type is the smell; keeping it exported invites the smell to grow.
   - **Decision gate**: do not delete in Wave 4 if other apps still import it. Defer the deletion to whichever Wave 5 spec finishes the rollout.

2. **Should `(authed)/+layout.svelte`'s workspace-dispose `$effect` also handle the chat-state lifecycle?**
   - Options: (a) keep as-is (chat-state lives in `ZhongwenWorkspace.svelte`), (b) hoist chat-state into `openZhongwen` so the bundle owns its dispose, (c) hoist chat-state to the layout.
   - **Recommendation**: Defer. Option (b) is appealing semantically (zhongwen IS chat) but couples the workspace bundle to chat-specific runes. Option (a) is canonical Svelte 5 per DeepWiki. Pick (b) only if a future audit shows the asymmetry is causing real bugs; otherwise keep (a).

3. **`{#await zhongwen.whenLoaded}` explicit gate in `ZhongwenWorkspace.svelte`?**
   - Currently the gate is implicit (`{#if handle}`). The svelte skill prefers explicit `{#await}`.
   - **Recommendation**: cosmetic; defer to a separate cleanup PR if anyone is bothered by it. Not part of this spec's wins.

## Decisions log

- **Keep `wipe` on the bundle**: 1 caller (the UI dialog handler).
  Reason: clear narrow verb that names a real lifecycle moment ("delete this device's local data"). Inlining the IDB sequencing into the UI handler would expose `wipeOwnerLocalYjsData`, the dispose order, and the `whenDisposed` gate to the UI layer. That's a worse abstraction.
  Revisit when: another caller appears OR the IDB-deletion details get refactored such that one inlined call site reads as cleanly as the named verb.

- **Keep `(authed)/+page.svelte` as a separate file** (not inline ZhongwenWorkspace into the layout):
  Reason: SvelteKit convention. Future authed routes (e.g. `/settings`) will need siblings of `+page.svelte`; keeping the layout focused on layout concerns and `+page.svelte` focused on page content is the canonical split.
  Revisit when: never; this is a SvelteKit-shape decision, not a taste call.

## Success criteria

- [x] `apps/zhongwen` has zero `let cached`, `disposeCached`, `import.meta.hot.dispose` (except in `$lib/auth.ts`).
- [x] `apps/zhongwen` has zero `ReturnType<typeof openZhongwen>` consumers (replaced by `Zhongwen` imports).
- [x] `apps/zhongwen` has zero `{#key}` in routes.
- [x] `apps/zhongwen` has zero `forgetDevice` symbol on the workspace bundle.
- [x] `apps/zhongwen` has zero `createCookieAuth` calls outside `$lib/auth.ts`.
- [x] `apps/zhongwen/src/lib/zhongwen/browser.ts` does not import `SignedInAuth`.
- [ ] Sign-in flow works: redirect → Google → callback → chat renders.
- [ ] Sign-out flow works: invalidate → redirect to `/sign-in` without page reload.
- [ ] Forget device flow works: wipe IDB, sign out, land on `/sign-in`.
- [ ] HMR survives a full edit-save-edit cycle without observable leaks.
- [ ] `bun run typecheck` passes.

## References

- `apps/zhongwen/src/lib/zhongwen/browser.ts`: current bundle factory; takes `SignedInAuth`, exposes `wipe` + `forgetDevice`.
- `apps/zhongwen/src/routes/(authed)/+layout.ts`: current pilot pattern with cache + listener-in-load.
- `apps/zhongwen/src/routes/(public)/sign-in/+page.svelte`: current sign-in page with own auth client + `$effect` redirect.
- `apps/zhongwen/src/lib/components/ZhongwenWorkspace.svelte`: current component owning chatState lifecycle.
- `apps/zhongwen/src/lib/chat/chat-state.svelte.ts`: current chat-state factory taking `auth` as a param.
- `packages/auth/src/create-auth.ts`: defines `SignedInAuth` and `isSignedIn`.
- `specs/20260505T030000-browser-workspace-route-loaders.md`: predecessor pilot spec; this spec revises its end shape.
- SvelteKit load: https://svelte.dev/docs/kit/load
- SvelteKit navigation: https://svelte.dev/docs/kit/$app-navigation
- DeepWiki sveltejs/kit query history (in conversation, not committed)
- DeepWiki sveltejs/svelte query history (in conversation, not committed)

## Review

**Completed**: 2026-05-05
**Branch**: `feat/encrypted-local-workspace-storage`

### Summary

The zhongwen route loader cleanup is implemented on top of the pilot state. Auth now lives in `$lib/auth.ts` as a singleton, `(authed)/+layout.ts` only proves identity and opens the workspace, layout components own auth subscriptions and disposal, and the workspace bundle takes `AuthIdentity` instead of a full auth client.

### Deviations From Spec

- `apps/zhongwen/package.json` was also updated: `@tanstack/ai-svelte` is now declared because `chat-state.svelte.ts` imports it, and the stale `@epicenter/auth-workspace` dependency was removed because zhongwen no longer imports that package.
- `packages/svelte-utils/src/create-ai-chat-fetch.ts` now returns a `typeof fetch` compatible wrapper so TanStack AI's `fetchClient` type accepts authenticated fetch wrappers consistently.
- `SignedInAuth` and `isSignedIn` were deleted from `packages/auth` and the `@epicenter/auth-svelte` re-export because no non-spec callers remained.

### Verification

- `rg` confirmed zhongwen has no `let cached`, `disposeCached`, `SignedInAuth`, `forgetZhongwenDevice`, `forgetDevice`, `let active`, or `{#key}` stragglers.
- `rg` confirmed package-level `SignedInAuth` and exported `isSignedIn` callers are gone. Remaining `isSignedIn` matches are local variable names in `packages/svelte-utils/src/account-popover/account-popover.svelte`.
- `bun turbo run typecheck --filter=@epicenter/auth --filter=@epicenter/auth-svelte` passes. `@epicenter/auth-svelte` still emits its existing "no svelte input files" warning.
- `bun turbo run test --filter=@epicenter/auth` passes with 27 tests.
- `bun run typecheck` and `bun turbo run typecheck --filter=@epicenter/zhongwen --filter=@epicenter/svelte` remain blocked by existing shared package diagnostics outside this spec's route-loader cleanup.
- `bun turbo run test --filter=@epicenter/zhongwen` is blocked because the app test script points at `./src/lib/zhongwen`, but there are no matching test files there.
