# Handoff: Session<T> Two-Axis Cohesive Reshape

> **Historical. Not executable.**
>
> This prompt is preserved for reference only. The reshape it describes has
> already landed across the monorepo in the most recent commits on this
> branch: `Session<T>` is `SessionPayload<T> | null`, `requireSignedIn` was
> renamed to `requireIdentity`, each app's `getSignedInSession` was renamed
> to `requireWorkspace`, SvelteKit apps gate on `if (session.current)`,
> the workspace is reached through `current.workspace`, the app-side session
> module is `src/lib/session.ts`, and `createSession()` no longer takes a
> `name` field.
>
> Do not run this prompt against the current tree. If you need to repeat any
> step (for example, in a new app), reread
> `specs/20260512T220000-session-two-axis-cohesive-reshape.md` and the live
> code first, then adapt; do not replay the steps below verbatim.
>
> Tab-manager's async readiness story stays unfinished, but the route to fix
> it is open. The earlier handoff text pointed at
> `specs/20260512T161042-async-storage-and-build-unification.md`; that spec
> was **rejected** on a later pass and must not be executed. A replacement
> path, if any, will land in a future spec, not here.

## Task

Execute `specs/20260512T220000-session-two-axis-cohesive-reshape.md` in the Epicenter monorepo. The spec reshapes `Session<T>` (the app-side projection of auth state) from a three-state discriminated union into a nullable workspace bundle, renames `requireSignedIn` → `requireIdentity` in the auth core, renames each app's `getSignedInSession` → `requireWorkspace`, and aligns each app's protected layout to gate on `if (current)`.

Read the spec first. The spec has the full motivation, research findings, design decisions, edge cases, and acceptance criteria. This handoff closes every open question and gives you the exact starting state.

## Closed decisions (do not relitigate)

| Decision | Choice |
| --- | --- |
| `Session<T>` shape | `SessionPayload<T> \| null`. No discriminant field. No `authenticated` boolean. No `status` string. No `credentialsFresh` property. |
| `SessionPayload<T>` shape | `{ identity: WorkspaceIdentity; workspace: T }`. Identity is co-present with workspace by type. |
| Disposal trigger | `state.status === 'signed-out'` or different `user.id`. Same-user `reauth-required` is a no-op. |
| Auth core helper | Rename `requireSignedIn` → `requireIdentity`. Throw only when `state.status === 'signed-out'`. |
| Per-app helper | Rename `getSignedInSession` → `requireWorkspace`. Throw when `current` is null. |
| Per-app type alias | Rename `XxxSignedIn` → `XxxWorkspace` (e.g., `FujiSignedIn` → `FujiWorkspace`). Rename `InferSignedIn` → `InferWorkspace`. Rename `SignedInBase` → `WorkspaceBase`. |
| Layout gate | `if (current)` (truthy narrowing). No `current.status` or `current.authenticated` reads. |
| Tab-manager behavior during `reauth-required` | **Path A: consistency.** Render the workspace; do not replace UI with a sign-in card. Surface "session expired" via a small indicator (`auth.state.status === 'reauth-required'`) inside the workspace shell, not by hiding the workspace. |
| Credential staleness surface | Sync indicator (where one exists per app) plus account-popover and sign-in pages. All read `auth.state.status` directly. `Session<T>` does not surface credential freshness. |
| Per-op 401 toast | Deferred to follow-up. Not in scope for this PR. |
| Three-state `AuthState` | Unchanged. Its direct consumers (sync transport, account-popover, sign-in pages) legitimately want three states. |
| Remediation Phase 3 | Mark as superseded inline. Do not implement it separately. |
| Migration order | One PR, monorepo-wide. No coexistence period. TypeScript compiler surfaces every consumer. |

## Context: current code

### `packages/svelte-utils/src/session.svelte.ts` (the factory being reshaped)

```ts
import type { AuthClient, WorkspaceIdentity, AuthState } from '@epicenter/auth';

export type Session<TSignedIn> =
  | Exclude<AuthState, { status: 'signed-in' }>
  | { status: 'signed-in'; signedIn: TSignedIn };

export type SignedInBase = {
  userId: string;
} & Disposable;

export type InferSignedIn<TSession extends { current: unknown }> =
  TSession['current'] extends infer C
    ? C extends { status: 'signed-in'; signedIn: infer T }
      ? T
      : never
    : never;

export function createSession<TSignedIn extends SignedInBase>({
  auth,
  build,
}: {
  auth: AuthClient;
  build: (identity: WorkspaceIdentity) => TSignedIn;
}) {
  let signedIn = $state<TSignedIn | undefined>(undefined);

  function reconcile(state: AuthState) {
    if (state.status !== 'signed-in') {              // ← bug: disposes on reauth-required
      if (signedIn) {
        signedIn[Symbol.dispose]();
        signedIn = undefined;
      }
      return;
    }
    if (!signedIn) {
      signedIn = build(state.identity);
      return;
    }
    if (signedIn.userId === state.identity.user.id) return;
    signedIn[Symbol.dispose]();
    location.reload();
    throw new Error('unreachable: reload pending');
  }

  const unsubscribe = auth.onStateChange(reconcile);
  reconcile(auth.state);

  return {
    get current(): Session<TSignedIn> {
      const state = auth.state;
      if (state.status !== 'signed-in') return state;
      if (!signedIn) {
        throw new Error('unreachable: auth state is signed-in but session payload was not built');
      }
      return { status: 'signed-in', signedIn };
    },
    [Symbol.dispose]() {
      unsubscribe();
      signedIn?.[Symbol.dispose]();
    },
  };
}
```

### `packages/auth/src/require-signed-in.ts` (renaming + relaxing)

```ts
import type { AuthClient } from './auth-contract.js';
import type { WorkspaceIdentity } from './auth-types.js';

export function requireSignedIn(auth: AuthClient): WorkspaceIdentity {
  if (auth.state.status !== 'signed-in') {
    throw new Error('[auth] called requireSignedIn while not signed-in.');
  }
  return auth.state.identity;
}
```

Exported from `packages/auth/src/index.ts:17` and `packages/auth/src/node.ts:14`.

### `packages/auth/src/auth-contract.ts` (DO NOT CHANGE)

```ts
export type AuthState =
  | { status: 'signed-in';       identity: WorkspaceIdentity }
  | { status: 'reauth-required'; identity: WorkspaceIdentity }
  | { status: 'signed-out' }
```

`AuthState` stays three-state. Only `Session<T>` reshapes.

### Example per-app session (`apps/zhongwen/src/lib/session.svelte.ts`)

```ts
import { requireSignedIn } from '@epicenter/auth';
import { createSession, type InferSignedIn } from '@epicenter/svelte';
import { auth } from '$platform/auth';
import { openZhongwen } from '../routes/(signed-in)/zhongwen/browser';

export const session = createSession({
  auth,
  build: (identity) => {
    const userId = identity.user.id;
    const zhongwen = openZhongwen({
      userId,
      encryptionKeys: () => requireSignedIn(auth).encryptionKeys,
    });
    return {
      userId,
      zhongwen,
      [Symbol.dispose]() {
        zhongwen[Symbol.dispose]();
      },
    };
  },
});

export type ZhongwenSignedIn = InferSignedIn<typeof session>;

export function getSignedInSession() {
  const c = session.current;
  if (c.status !== 'signed-in') {
    throw new Error('[zhongwen] getSignedInSession() called outside the signed-in branch.');
  }
  return c.signedIn;
}
```

### Example SvelteKit layout (`apps/zhongwen/src/routes/(signed-in)/+layout.svelte`)

```svelte
<script lang="ts">
  import { WorkspaceGate } from '@epicenter/svelte/workspace-gate';
  import { Loading } from '@epicenter/ui/loading';
  import { goto } from '$app/navigation';
  import { auth } from '$platform/auth';
  import { session } from '$lib/session.svelte';

  let { children } = $props();
  const current = $derived(session.current);

  $effect(() => {
    if (current.status !== 'signed-in') {
      void goto('/sign-in', { replaceState: true });
    }
  });
</script>

{#if current.status !== 'signed-in'}
  <Loading class="h-dvh" />
{:else}
  <WorkspaceGate pending={current.signedIn.zhongwen.idb.whenLoaded} onSignOut={() => auth.signOut()}>
    {@render children?.()}
  </WorkspaceGate>
{/if}
```

### Tab-manager sidepanel (`apps/tab-manager/src/entrypoints/sidepanel/App.svelte`, key fragment)

```svelte
{@const current = tabManagerSession.current}
{#if current.status === 'signed-out' || current.status === 'reauth-required'}
  <!-- ...sign-in card... -->
{:else}
  {#await current.signedIn.whenReady}
    <Loading class="h-full" label="Loading tabs…" />
  {:then _}
    <SignedInApp />
  ...
{/if}
```

This needs Path A: render the workspace under `if (current)` and surface reauth-required via a small indicator inside `SignedInApp` (header or footer of the sidepanel), not by replacing the UI.

## Target shapes

### `Session<T>` after

```ts
export type SessionPayload<T> = {
  identity: WorkspaceIdentity;
  workspace: T;
};

export type Session<T> = SessionPayload<T> | null;

export type WorkspaceBase = {
  userId: string;
} & Disposable;

export type InferWorkspace<TSession extends { current: unknown }> =
  TSession['current'] extends infer C
    ? C extends { workspace: infer T } ? T : never
    : never;
```

### `requireIdentity` after

```ts
export function requireIdentity(auth: AuthClient): WorkspaceIdentity {
  if (auth.state.status === 'signed-out') {
    throw new Error('[auth] called requireIdentity while signed-out.');
  }
  return auth.state.identity;
}
```

### `reconcile` after

```ts
function reconcile(state: AuthState) {
  if (state.status === 'signed-out') {
    if (workspace) {
      workspace[Symbol.dispose]();
      workspace = undefined;
    }
    return;
  }
  // signed-in or reauth-required: both carry identity, same-user is a no-op
  if (!workspace) {
    workspace = build(state.identity);
    return;
  }
  if (workspace.userId === state.identity.user.id) return;
  workspace[Symbol.dispose]();
  location.reload();
  throw new Error('unreachable: reload pending');
}
```

(Rename the internal `signedIn` state variable to `workspace`.)

### `current` getter after

```ts
get current(): Session<TSignedIn> {
  const state = auth.state;
  if (state.status === 'signed-out') return null;
  if (!workspace) {
    throw new Error('unreachable: auth has identity but workspace was not built');
  }
  return { identity: state.identity, workspace };
}
```

### Per-app helper after (zhongwen example)

```ts
export type ZhongwenWorkspace = InferWorkspace<typeof session>;

export function requireWorkspace() {
  const c = session.current;
  if (!c) {
    throw new Error('[zhongwen] requireWorkspace() called without an authenticated session.');
  }
  return c.workspace;
}
```

Build callback uses `requireIdentity(auth)` instead of `requireSignedIn(auth)`.

### SvelteKit layout after

```svelte
<script lang="ts">
  import { WorkspaceGate } from '@epicenter/svelte/workspace-gate';
  import { Loading } from '@epicenter/ui/loading';
  import { goto } from '$app/navigation';
  import { auth } from '$platform/auth';
  import { session } from '$lib/session.svelte';

  let { children } = $props();
  const current = $derived(session.current);

  $effect(() => {
    if (!current) {
      void goto('/sign-in', { replaceState: true });
    }
  });
</script>

{#if current}
  <WorkspaceGate pending={current.workspace.zhongwen.idb.whenLoaded} onSignOut={() => auth.signOut()}>
    {@render children?.()}
  </WorkspaceGate>
{:else}
  <Loading class="h-dvh" />
{/if}
```

## Execution order

Follow this exact order. Each phase compiles independently; do not skip ahead.

### Phase 1: Reshape `Session<T>` in `packages/svelte-utils/src/session.svelte.ts`

1. Replace `Session<T>` type. Export `SessionPayload<T>` and the nullable union.
2. Rename `SignedInBase` → `WorkspaceBase`.
3. Rename `InferSignedIn` → `InferWorkspace` and update the conditional inference.
4. Rename internal `signedIn` state variable to `workspace` throughout the factory.
5. Update `reconcile` to gate on `state.status === 'signed-out'` (see target above).
6. Update `current` getter to project the new shape.
7. Update JSDoc in the file (the `@example` block uses `FujiSignedIn`: change to `FujiWorkspace`).
8. Update `packages/svelte-utils/src/index.ts:16` export name from `InferSignedIn` to `InferWorkspace`.

### Phase 2: Rename `requireSignedIn` → `requireIdentity` in `@epicenter/auth`

1. Rename file `packages/auth/src/require-signed-in.ts` → `packages/auth/src/require-identity.ts`.
2. Update function name, JSDoc, and error message.
3. Change the check from `state.status !== 'signed-in'` to `state.status === 'signed-out'`.
4. Update exports in `packages/auth/src/index.ts:17` and `packages/auth/src/node.ts:14`.
5. Compiler-guided sweep across all ~36 callers (apps + packages). Replace import + call site. **Do not keep an alias.**

### Phase 3: Migrate each app, one app per commit

Apps in scope: `fuji`, `honeycrisp`, `opensidian`, `zhongwen`, `tab-manager`.

For each app:

1. Update `src/lib/session.svelte.ts`:
   - Change `import { requireSignedIn }` to `import { requireIdentity }`. Replace the call inside `build`.
   - Change `import { ..., type InferSignedIn }` to `import { ..., type InferWorkspace }`.
   - Rename `XxxSignedIn` type alias to `XxxWorkspace`.
   - Rename `getSignedInSession` → `requireWorkspace`. Update check to `if (!c)`. Return `c.workspace`.

2. Update `src/routes/(signed-in)/+layout.svelte` (SvelteKit apps) or `src/entrypoints/sidepanel/App.svelte` (tab-manager) to the target layout shape.

3. Update any descendant components that call `getSignedInSession()` to call `requireWorkspace()` instead, and reference `.workspace.X` where they previously used `.signedIn.X` or `.fuji` etc.

4. **Tab-manager only**: add a small reauth indicator to `SignedInApp.svelte` (or wherever the app shell lives). Read `auth.state.status === 'reauth-required'` and render an unobtrusive indicator. **Do not** replace the workspace UI with the sign-in card. Path A.

5. Sync indicator (if the app has one): add a "session-expired" variant that activates when `auth.state.status === 'reauth-required'`. Skip if the app has no sync indicator today.

### Phase 4: Prove

1. `bun run typecheck` at the repo root (or filtered per app if monorepo filtering is set up).
2. `bun test` for `packages/auth` and `packages/svelte-utils`.
3. Add tests in `packages/svelte-utils`:
   - `signed-in → reauth-required → signed-in` preserves the same `SessionPayload` instance (assert object identity, not just structural equality).
   - `signed-in (user A) → signed-in (user B)` disposes and reloads.
4. Manual smoke per app:
   - Boot signed-in, force a 401 (revoke or expire the refresh token server-side, or stub the auth client), confirm workspace stays mounted and the sync indicator (where present) shows expired.
   - Clear local OAuth session, confirm redirect to `/sign-in` works and `<Loading />` renders briefly during transition.

### Phase 5: Remove + verify

Run these greps. Each must return zero matches in production code (test/build/spec/docs files are OK).

```bash
rg "requireSignedIn" --type ts --type svelte
rg "getSignedInSession" --type ts --type svelte
rg "InferSignedIn" --type ts --type svelte
rg "SignedInBase" --type ts --type svelte
rg "current\.status" apps/*/src --type svelte --type ts
rg "current\.authenticated" apps/*/src --type svelte --type ts
rg "current\.signedIn" apps/*/src --type svelte --type ts
```

Mark `specs/20260512T111335-post-oauth-audit-remediation.md` Phase 3 superseded inline (add a note pointing at this spec; do not delete the phase).

## MUST DO

- Land everything in one PR. No coexistence period. No deprecation shims.
- `Session<T>` is `SessionPayload<T> | null`. No discriminant field of any name.
- `reconcile` disposes only on `signed-out` or different `user.id`. Reauth-required is a no-op.
- `requireIdentity` throws only on `signed-out`. It returns the identity for both `signed-in` and `reauth-required`.
- Same-user reauth must preserve the same `SessionPayload` object identity across the auth state transition. The Phase 4 test asserts this.
- Tab-manager renders the workspace during reauth-required (Path A).
- Keep `AuthState` three-state. Account-popover, sign-in pages, and sync indicators continue to read `auth.state.status` directly.
- Follow the project's `writing-voice` skill for any new copy you write. No em dashes anywhere (prose, comments, JSDoc, error strings).
- Use `bun` for all commands. Not `npm`, `yarn`, `pnpm`, or `node`.

## MUST NOT DO

- Do not add `authenticated: boolean`, `status: 'authenticated' | ...`, or `credentialsFresh: boolean` to `Session<T>`. The shape is nullable. Period.
- Do not keep a `requireSignedIn` alias or re-export for the rename. Hard rename.
- Do not keep a `getSignedInSession` alias per app. Hard rename to `requireWorkspace`.
- Do not change `AuthState` in `packages/auth/src/auth-contract.ts`. It stays three-state.
- Do not change `apps/api/src/app.ts` or any server-side auth code. Server is out of scope.
- Do not build a `ReauthBanner` global component. The sync indicator and per-component reads cover this surface.
- Do not implement per-operation 401 toast classification. It is deferred.
- Do not add `@ts-ignore`, `as any`, or `// @ts-expect-error` to silence compiler errors. Fix the underlying type mismatch.
- Do not skip or delete existing tests to make the build pass. If a test fails, the test is correct until proven otherwise.
- Do not change unrelated files. If a file does not need to be touched for this reshape, leave it alone.

## Notes for the implementer

- Read the spec at `specs/20260512T220000-session-two-axis-cohesive-reshape.md` before starting. The spec explains *why*; this prompt tells you *what*.
- Read `.claude/skills/cohesive-clean-breaks/SKILL.md` and `.claude/skills/auth/SKILL.md` for the project conventions this change embodies.
- The TypeScript compiler is your sweep tool. After Phase 1 and Phase 2 land, every remaining migration site will surface as a type error. Work through them mechanically.
- For each app, commit at the end of that app's migration. Suggested message: `refactor({app}): migrate to nullable Session<T>`. Keep commits per-app for cherry-pickability.
- If you discover an app or call site not listed in this prompt, audit it the same way. Do not relitigate the design.
- If anything in the spec contradicts this prompt, **this prompt wins**: it reflects the most recent grilling pass.
