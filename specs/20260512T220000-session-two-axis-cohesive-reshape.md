# Session<T> Two-Axis Cohesive Reshape

**Date**: 2026-05-12
**Status**: Implemented
**Author**: AI-assisted
**Branch**: `codex/auth-bearer-omit-cookies`
**Depends on**: `specs/20260511T150000-final-oauth-auth-architecture.md`, `specs/20260512T100428-app-side-oauth-migration.md`
**Supersedes**: Phase 3 of `specs/20260512T111335-post-oauth-audit-remediation.md`
**Stack map**: `specs/20260512T134603-auth-spec-stack-clean-break-map.md`
**Stack position**: Deeper version of the remediation spec's "preserve local workspace during reauth-required" patch. Lands one final `Session<T>` shape instead of a hybrid that would need a second migration.
**Grounding**:
- Local `packages/svelte-utils/src/session.svelte.ts`, `packages/auth/src/auth-contract.ts`, `packages/auth/src/require-signed-in.ts`, every `apps/*/src/lib/session.svelte.ts`, every `apps/*/src/routes/(signed-in)/+layout.svelte`, `packages/svelte-utils/src/account-popover/account-popover.svelte`.
- DeepWiki against `better-auth/better-auth` and `bitwarden/server` for two-axis precedent (results in Research Findings).
- Yjs/IndexedDB lifetime grounding inherited from `specs/20260512T111335-post-oauth-audit-remediation.md` Research Findings (not duplicated here).

## One Sentence

```txt
Identity gates the workspace; credential freshness gates the network.
```

Anything that does not make this sentence true is out of scope.

## Overview

`createSession` is the projection layer between Better Auth's three-state `AuthState` and the workspace-rendering apps. Today the projection mirrors `AuthState`'s shape one-for-one, glues identity-presence and credential-freshness into a single discriminator (`status`), and disposes the local workspace whenever credentials go stale. The remediation spec (Phase 3) fixes the disposal but keeps the three-state hybrid type. This spec reshapes `Session<T>` to a nullable workspace bundle (`SessionPayload<T> | null`), renames `requireSignedIn` → `requireIdentity` in the auth core to match, and routes credential staleness through the sync indicator (one place) reading `auth.state.status` directly, plus per-operation error toasts (contextual, deferred).

The result: one obvious gate at every consumer (`if (current)`), no second-axis property smuggled into the projection, and one final migration pass across every app instead of two.

## Motivation

### Current state

`createSession` reconciles auth state into a workspace payload, but treats reauth-required identically to signed-out:

```ts
// packages/svelte-utils/src/session.svelte.ts:80-87
function reconcile(state: AuthState) {
  if (state.status !== 'signed-in') {
    if (signedIn) {
      signedIn[Symbol.dispose]();
      signedIn = undefined;
    }
    return;
  }
  // ...
}
```

The type forces every consumer through a three-state discriminator that mirrors `AuthState`:

```ts
// packages/svelte-utils/src/session.svelte.ts:43-45
export type Session<TSignedIn> =
  | Exclude<AuthState, { status: 'signed-in' }>
  | { status: 'signed-in'; signedIn: TSignedIn };

// Expands to:
//   | { status: 'signed-in';       signedIn: TSignedIn }
//   | { status: 'reauth-required'; identity: WorkspaceIdentity }
//   | { status: 'signed-out' }
```

Only the `signed-in` variant carries the workspace payload. `reauth-required` does not. Layouts are forced into a binary gate:

```svelte
<!-- apps/zhongwen/src/routes/(signed-in)/+layout.svelte -->
{#if current.status !== 'signed-in'}
  <Loading class="h-dvh" />
{:else}
  <WorkspaceGate pending={current.signedIn.zhongwen.idb.whenLoaded}>
    {@render children?.()}
  </WorkspaceGate>
{/if}
```

The `requireSignedIn` helper has the same misalignment at the auth-core boundary:

```ts
// packages/auth/src/require-signed-in.ts:13-18
export function requireSignedIn(auth: AuthClient): WorkspaceIdentity {
  if (auth.state.status !== 'signed-in') {
    throw new Error('[auth] called requireSignedIn while not signed-in.');
  }
  return auth.state.identity;
}
```

Used for things that genuinely only need identity (encryption keys, user id), which are preserved across `reauth-required`. The name and check both assume "signed-in" when the actual requirement is "identity present."

### Problems

1. **Two questions glued into one discriminator.** `auth.state.status === 'signed-in'` answers "do we have identity AND fresh credentials?" Almost every UI gate wants only the first question. Reading the glued form gets the wrong answer for `reauth-required`.
2. **Type traps future consumers.** A three-state union with `'signed-in'` as a member tempts `=== 'signed-in'` at every call site. That check is syntactically obvious and semantically wrong for a local-first app.
3. **Remediation Phase 3 is a hybrid.** The proposed shape preserves the three-state discriminator and just bolts `signedIn` onto `reauth-required`. Cohesive-clean-breaks rule: do not ship hybrid APIs unless migration support is the explicit product goal. Migration is not the goal; cohesion is.
4. **Two-migration cost.** If we land the hybrid first and reshape later, every app gets touched twice: once to add a third layout branch, then again to drop it. Better to do one final pass.
5. **`requireSignedIn` lies after the local-first fix.** Encryption keys, user id, and workspace identity are all available during `reauth-required`. A name that throws based on credential freshness misrepresents the invariant.
6. **`<Loading />` on reauth-required is dishonest.** Nothing is loading. The placeholder exists only because the type forces a non-signed-in branch and the layout has nothing else it can render.

### Desired state

`Session<T>` becomes a nullable payload. The shape itself is the discriminator:

```ts
type SessionPayload<T> = {
  identity: WorkspaceIdentity;
  workspace: T;
};

type Session<T> = SessionPayload<T> | null;
```

No redundant `authenticated` boolean, no `status` field, no second-axis property. The shape directly answers exactly one question: do we have a workspace bundle?

Consumers gate uniformly:

```svelte
{#if current}
  <WorkspaceGate pending={current.workspace.zhongwen.idb.whenLoaded}>
    {@render children?.()}
  </WorkspaceGate>
{:else}
  <Loading class="h-dvh" />
{/if}
```

The auth-core helper renames to match its actual invariant:

```ts
export function requireIdentity(auth: AuthClient): WorkspaceIdentity {
  if (auth.state.status === 'signed-out') {
    throw new Error('[auth] called requireIdentity while signed-out.');
  }
  return auth.state.identity;
}
```

Credential staleness is **not** modeled on `Session<T>` at all. The only consumers that legitimately care about it (`account-popover`, sign-in pages, sync indicator, per-op error handling) read `auth.state.status` directly. This keeps `Session<T>` as a pure identity-presence projection and refuses the wrong-question trap at the type level.

Credential staleness surfaces only where it matters:
- `auth.state.status === 'reauth-required'` consumed by the sync/connection indicator
- 401 responses from `auth.fetch` surfaced as contextual toasts at the call site (deferred to follow-up)

No global banner. No three-state layout branch. No phantom "Loading" placeholder for reauth-required.

## Research findings

### Upstream precedent (DeepWiki)

| Source | Question | Finding | Implication |
| --- | --- | --- | --- |
| `better-auth/better-auth` | Is the client SDK's state model two-axis or three-state? | "Better Auth's client SDK uses a two-axis model for session state, distinguishing between the presence of an identity and the freshness of credentials." `SessionResponse` exposes a `needsRefresh: boolean` flag inside the session object rather than promoting it to a top-level discriminator. | The upstream auth library Epicenter wraps already models this as two axes. The current three-state `AuthState` is an Epicenter projection choice, not a Better Auth requirement. |
| `bitwarden/server` | Is "locked but identity known" a distinct state from "logged out" in production offline-first auth? | "Bitwarden employs a two-axis model for authentication: Identity Presence and Credential Freshness." The "locked but identity known" state exists when the `SecurityStamp` is valid and master keys are cached, allowing local vault decryption even when access tokens have expired. | The two-axis model is the production benchmark for offline-first encrypted clients. Epicenter's local-first goals align with this precedent. |

Key finding: **the reshape this spec proposes is not invention; it matches Better Auth's own client SDK shape and Bitwarden's production offline-first model.** The current three-state `Session<T>` projection is an Epicenter-local choice that diverges from both.

### Local code audit

| Surface | Current pattern | After this spec |
| --- | --- | --- |
| `packages/svelte-utils/src/session.svelte.ts` | Three-state `Session<T>`, dispose on any non-signed-in | Nullable `SessionPayload<T> \| null`, dispose only on signed-out or different-user |
| `packages/auth/src/require-signed-in.ts` | Throws unless `status === 'signed-in'` | Renamed `requireIdentity`, throws only on `signed-out` |
| `apps/fuji/src/lib/session.ts` | `getSignedInSession()` throws unless signed-in | Re-exports `createSession().requireWorkspace`, which throws only when `current` is null |
| `apps/honeycrisp/src/lib/session.ts` | Same | Same |
| `apps/opensidian/src/lib/session.ts` | Same | Same |
| `apps/zhongwen/src/lib/session.ts` | Same | Same |
| `apps/tab-manager/src/lib/session.svelte.ts` | Same helper shape, plus async Chrome storage/workspace readiness wrapper | Custom wrapper remains until the async storage/build unification follow-up |
| `apps/*/src/routes/(signed-in)/+layout.svelte` | Binary `status === 'signed-in'` gate, redirect to /sign-in otherwise | Binary `if (current)` gate, redirect only when null |
| `packages/svelte-utils/src/account-popover/account-popover.svelte` | Reads `auth.state.status === 'reauth-required'` for button label | No change. It legitimately consults credential freshness. |
| `apps/*/src/routes/sign-in/+page.svelte` | Reads `auth.state.status === 'reauth-required'` for "Reconnect" label | No change. It legitimately consults credential freshness. |
| Sync indicator (per app, where it exists) | Mostly does not distinguish reauth-required from offline | Add "session-expired" variant reading `auth.state.status === 'reauth-required'` |

Counted: ~36 `requireSignedIn` call sites across apps and packages; ~5 `(signed-in)` layouts; 5 per-app `getSignedInSession` helpers. All compiler-surfaced.

### Relationship to adjacent specs

| Source | Relationship |
| --- | --- |
| `20260511T150000-final-oauth-auth-architecture.md` | Northern star. Defines `AuthClient`, `/workspace-identity`, scopes. This spec preserves all of it; only reshapes the app-side projection. |
| `20260512T100428-app-side-oauth-migration.md` | Migrates apps onto the OAuth `AuthClient`. This spec assumes that migration has landed (it has, per recent commits). |
| `20260512T111335-post-oauth-audit-remediation.md` | **Phase 3 superseded.** That phase proposes a hybrid `Session<T>` that preserves the three-state union. This spec proposes the deeper reshape. Other phases of the remediation spec are unaffected. |
| `20260504T233223-sign-out-preserves-local-data.md` | Compatible. Sign-out remains the only disposal trigger (plus different-user). |
| `20260512T134603-auth-spec-stack-clean-break-map.md` | Success criterion "Same-user `reauth-required` keeps local workspace state mounted" is what this spec makes true. |
| `20260512T153000-fuji-signed-in-route-boundary.md` | No conflict. That spec works at the route layer; this works at the session-payload-lifecycle layer. The two compose. |
| `20260512T114350-auth-token-capability-boundary.md` | No conflict. That spec splits `OAuthSession` storage into identity/network sub-objects; this spec splits the app-facing `Session<T>` along the same two-axis seam. They reinforce each other. |

### Why not just keep the hybrid (remediation Phase 3)?

Cohesive-clean-breaks rule: reject hybrid APIs. The hybrid shape:

```ts
type Session<TSignedIn> =
  | { status: 'signed-in'; signedIn: TSignedIn }
  | { status: 'reauth-required'; identity: WorkspaceIdentity; signedIn: TSignedIn }
  | { status: 'signed-out' }
```

Pros: smaller diff, mirrors `AuthState`, no consumer rename.
Cons: every layout still has to write a triple-branch; the wrong-question trap (`status === 'signed-in'`) still exists for new code; we will pay another migration when we later collapse to the right shape (which we should, per Better Auth's upstream `null \| { ..., needsRefresh }` precedent).

The asymmetric win is **refusing the three-state shape entirely at the `Session<T>` boundary**. AuthState's three states stay for the consumers that legitimately want them (sync transport, account-popover, sign-in page). The `Session<T>` projection collapses to nullable because that is the right question for workspace-rendering apps: "do we have a workspace bundle?"

## Design decisions

| Decision | Class | Choice | Rationale |
| --- | --- | --- | --- |
| `Session<T>` shape | 2 coherence | Nullable: `SessionPayload<T> \| null`. No discriminant field; the shape itself is the discriminator. | Matches Better Auth upstream client SDK shape (`session` is `null \| { user, session, needsRefresh }`). Refuses the wrong-question trap permanently: no field to read incorrectly. One source of truth: the value's presence. |
| `Session<T>` payload field name | 2 coherence | Rename `signedIn` → `workspace` | After the reshape, the field is the workspace payload, not a "signed-in" sentinel. Honest naming. |
| Credential freshness on `Session<T>` | 2 coherence | Not modeled. Consumers read `auth.state.status` directly. | The asymmetric win is `Session<T>` answering exactly one question. Adding `credentialsFresh` would re-introduce the second axis. The few legitimate consumers (account-popover, sign-in pages, sync indicator) already import `auth` for `startSignIn`. |
| Disposal trigger | 1 evidence, 2 coherence | Dispose only on `signed-out` or different user. `reauth-required` is a no-op. | Better Auth and Yjs both treat refresh failure as recoverable; preserving local identity is the documented intent (auth skill, clean-break map success criterion). |
| `requireSignedIn` rename | 2 coherence | Rename to `requireIdentity`. Throw only when `status === 'signed-out'`. | The invariant is identity presence, not credential freshness. Same axis correction as `Session<T>`. |
| Descendant workspace assertion | 2 coherence | `createSession` returns `requireWorkspace()`. Apps re-export it from their session modules. | One shared assertion helper matches the nullable `Session<T>` shape. It avoids per-app copy-paste while keeping descendants on the bind-once pattern. |
| Three-state `AuthState` | 2 coherence | Leave unchanged | Its consumers (sync transport, fetch retry logic, account-popover, sign-in page button label) legitimately want three discrete states. The mismatch is at the `Session<T>` projection, not at `AuthState`. |
| Credential staleness UI surface | 2 coherence | Sync/connection indicator only, plus per-operation toasts on 401 | Honest mapping to "offline because of auth" instead of a global banner. Matches local-first principle: auth gates network, not app. |
| Per-operation 401 toast plumbing | Deferred | Defer | Useful but not load-bearing for this reshape. The auth core already transitions to `reauth-required` on 401; the sync indicator surfaces it. Per-operation contextual toasts are follow-up polish. |
| `<Loading />` placeholder semantics | 1 evidence | Render only on `!session.current` while redirect to `/sign-in` resolves | No longer pretends to load anything during `reauth-required`. |
| Auth-side `node` entrypoint rename | 2 coherence | `requireSignedIn` is re-exported from `packages/auth/src/node.ts:14`; rename in lockstep | Single rename sweep, not two |
| Cold-boot in `reauth-required` | 1 evidence | Build workspace from `state.identity` | Workspace construction does not synchronously touch the network. Verified by reading `openZhongwen`/`openFuji` pre-implementation, but Phase 3 of the implementation plan validates. |
| Sync indicator scope | 3 taste | Add the new state variant per app that already has a sync/connection indicator. Apps without one do not gain one in this spec. | Adding indicators uniformly is a separate UI consistency pass; not load-bearing here. |

## Architecture

### Type shape transition

```txt
BEFORE
┌─────────────────────────────────────────────────────────┐
│ AuthState (auth core, unchanged)                        │
│   | { status: 'signed-in';        identity }            │
│   | { status: 'reauth-required';  identity }            │
│   | { status: 'signed-out' }                            │
└─────────────────────────────────────────────────────────┘
                       │
                       ▼ Session<T> mirrors three states
┌─────────────────────────────────────────────────────────┐
│ Session<T> (BEFORE: wrong question)                    │
│   | { status: 'signed-in';        signedIn: T }         │
│   | { status: 'reauth-required';  identity }            │ <- no payload, type forces redirect
│   | { status: 'signed-out' }                            │
└─────────────────────────────────────────────────────────┘
                       │
                       ▼ apps gate `status === 'signed-in'`
                       triple branch, dispose on reauth, etc.

AFTER
┌─────────────────────────────────────────────────────────┐
│ AuthState (auth core, unchanged)                        │
│   | { status: 'signed-in';        identity }            │
│   | { status: 'reauth-required';  identity }            │
│   | { status: 'signed-out' }                            │
└─────────────────────────────────────────────────────────┘
                       │
                       ▼ Session<T> projects identity-presence only
┌─────────────────────────────────────────────────────────┐
│ Session<T> (AFTER: right question, one shape)          │
│   = SessionPayload<T> | null                            │
│                                                         │
│   SessionPayload<T> = { identity, workspace: T }        │
└─────────────────────────────────────────────────────────┘
                       │
                       ▼ apps gate `if (current)`
                       binary branch, dispose only on signed-out
                       sync indicator reads auth.state directly
                       per-op toast on 401 (deferred to follow-up)
```

### Lifecycle decision tree (reconcile)

```txt
On every auth state change:

  state.status === 'signed-out'?
    └─ yes → dispose workspace (if any), set null, return

  workspace not yet built?
    └─ yes → build(state.identity), return

  workspace.userId !== state.identity.user.id?
    └─ yes → dispose, location.reload(), throw unreachable

  same user, any status (signed-in or reauth-required)
    └─ no-op. Auth-bound callbacks see refreshed values at their
       own boundaries (sync at reconnect, fetch at next call).
```

### Where credential freshness is read (not via Session<T>)

```txt
Layer                          Reads credential freshness?     Source
────────────────────────────   ──────────────────────────────  ───────────────────
(signed-in)/+layout.svelte     NO  (gates on identity only)    session.current
WorkspaceGate                  NO  (waits on idb.whenLoaded)   -
WorkspaceContent / children    NO  (local-first; no auth gate) -

Sync attachment                YES (auth.openWebSocket fails)   transport-internal
Sync indicator UI              YES ("session-expired" variant)  auth.state.status
account-popover                YES (button label, disabled)     auth.state.status
sign-in page                   YES (button label "Reconnect")   auth.state.status
auth.fetch caller (per op)     YES (401 → contextual toast)     fetch response
```

Session<T> is the workspace projection; it never surfaces credential freshness. Consumers that need it read `auth.state.status` directly, which is the source of truth.

### Module touch map

```txt
packages/auth/src/
  require-signed-in.ts          renamed → require-identity.ts
  index.ts                      rename export
  node.ts                       rename re-export

packages/svelte-utils/src/
  session.svelte.ts             reshape Session<T>, reconcile, current getter

apps/{fuji,honeycrisp,opensidian,zhongwen}/src/lib/
  session.ts                    re-export { requireWorkspace } from session,
                                update build callback if it uses requireSignedIn

apps/tab-manager/src/lib/
  session.svelte.ts             keep custom wrapper for now; async storage and
                                build unification should later collapse it to
                                the shared session shape

apps/{fuji,honeycrisp,opensidian,zhongwen}/src/routes/(signed-in)/
  +layout.svelte                gate on `if (session.current)`, drop triple
                                branch, render workspace while identity is
                                present

apps/tab-manager/src/entrypoints/sidepanel/
  App.svelte                    same gate update

apps/dashboard/src/routes/(signed-in)/
  +layout.svelte                same gate update (uses auth.state directly
                                today; align with Session<T> if applicable
                                or leave as-is since it does not consume
                                createSession)

apps/*/src/components/ or app-shell/
  (wherever sync indicator lives) add 'session-expired' variant
```

## Implementation plan

Wave order per cohesive-clean-breaks: Build, Prove, Remove. No coexistence period because this is a monorepo and the TypeScript compiler surfaces every consumer.

### Phase 1: Reshape Session<T> and reconcile

- [x] **1.1** Reshape `Session<T>` in `packages/svelte-utils/src/session.svelte.ts` to `SessionPayload<T> | null`. Export `SessionPayload<T> = { identity: WorkspaceIdentity; workspace: T }`.
- [x] **1.2** Rename the internal `signedIn` state variable to `workspace` for honesty.
- [x] **1.3** Update `reconcile` to gate on `state.status === 'signed-out'` (not `!== 'signed-in'`). Same-user reauth becomes the existing no-op branch naturally.
- [x] **1.4** Update the `current` getter to project the new shape: return `null` when `state.status === 'signed-out'`, otherwise return `{ identity, workspace }`. The getter never throws under invariant: if identity is present but workspace was not built, the existing `unreachable` error stays as a defensive check.
- [x] **1.5** Update `InferSignedIn<TSession>` → `InferWorkspace<TSession>`. The conditional infers from the non-null branch.
- [x] **1.6** Update `SignedInBase` → `WorkspaceBase`. Constraint is unchanged: `Disposable & { userId: string }`.

### Phase 2: Rename `requireSignedIn` → `requireIdentity`

- [x] **2.1** Rename `packages/auth/src/require-signed-in.ts` → `packages/auth/src/require-identity.ts`, function name, JSDoc, error message.
- [x] **2.2** Update the check from `!== 'signed-in'` to `=== 'signed-out'`.
- [x] **2.3** Update exports in `packages/auth/src/index.ts` and `packages/auth/src/node.ts`.
- [x] **2.4** Compiler-guided sweep across all callers (~36 sites). No alias kept.

### Phase 3: Migrate apps

For each of `fuji`, `honeycrisp`, `opensidian`, `zhongwen`, `tab-manager`:

- [x] **3.x.1** Update each app session module to expose `requireWorkspace`. For the SvelteKit apps, re-export the shared helper with `export const { requireWorkspace } = session`. Tab-manager keeps its custom wrapper until async storage/build unification removes the outer readiness layer.
- [x] **3.x.2** Update `(signed-in)/+layout.svelte` (or app-equivalent gate) to use `if (current)`. Collapse to binary branch. Read `current.workspace.X.idb.whenLoaded` for `WorkspaceGate`.
- [x] **3.x.3** Update sync indicator (or app shell where sync status lives) to surface `auth.state.status === 'reauth-required'` as a "session expired" state. Skip if the app currently has no sync indicator.
- [x] **3.x.4** Verify build callback in `createSession({ build })` reads `requireIdentity(auth)` (after Phase 2 rename) for things like `encryptionKeys`.

### Phase 4: Prove

- [x] **4.1** Typecheck across the monorepo (`bun run typecheck` from root, or per-app filtered).
- [x] **4.2** Run existing auth tests (`packages/auth/src/auth-factories.test.ts`): they reference `reauth-required` directly and should pass unchanged.
- [x] **4.3** Add a test in `packages/svelte-utils` (or wherever `createSession` is tested) proving: `signed-in → reauth-required → signed-in` preserves the same workspace instance.
- [x] **4.4** Add a test proving: `signed-in (user A) → signed-in (user B)` disposes and reloads.
- [x] **4.5** Manual smoke per app: open the app, force a 401 (revoke refresh token or expire it on the server), verify the workspace stays mounted and the sync indicator (where present) shows the expired state.
- [x] **4.6** Manual smoke per app: clear local OAuth session, verify redirect to `/sign-in` works.

### Phase 5: Remove

- [x] **5.1** Grep monorepo for `signedIn` references that should be `workspace` after Phase 1. Update.
- [x] **5.2** Grep for `requireSignedIn`: should be zero hits.
- [x] **5.3** Grep for `getSignedInSession`: should be zero hits.
- [x] **5.4** Grep for `current.status === 'signed-in'` and `current.status !== 'signed-in'` in app code: should be zero hits (only auth-state direct reads remain, which is correct for sign-in pages and account-popover).
- [x] **5.5** Delete `specs/20260512T111335-post-oauth-audit-remediation.md` Phase 3 (or mark it superseded inline) so future readers do not implement both.

### Phase 6: Defer until a triggering need

- [ ] **6.1** Per-operation 401 toast: classify auth-stale 401 distinctly in `auth.fetch` callers; add a contextual toast with re-auth action. Defer until users hit an authed action and report confusion.
- [ ] **6.2** Apps without a sync indicator: do not add one in this spec. Sibling work if product wants uniform offline UI.

## Edge cases

### Cold boot in `reauth-required`

1. User reopens an app whose refresh token was revoked while away.
2. `auth.state` settles to `reauth-required` before the first `reconcile` fires.
3. `reconcile` sees `state.status !== 'signed-out'` and `workspace === undefined`.
4. Builds workspace from `state.identity` (encryption keys, user id all present).
5. Layout renders the workspace immediately (`current` is truthy).
6. Sync indicator (reading `auth.state.status` directly) shows "session expired."
7. User clicks "Reconnect," `startSignIn` runs, success transitions auth to `signed-in`, sync resumes. `current` remains the same payload throughout: no remount.

**Risk**: workspace construction touches the network synchronously at boot. Phase 4.5 smoke test confirms this is not the case.

### Mid-session token expiry

1. User is working in the workspace; access token expires.
2. Next `auth.fetch` triggers refresh attempt; refresh fails.
3. `auth.state` transitions to `reauth-required`.
4. `reconcile` runs (`onStateChange` subscription); same-user branch matches; no disposal.
5. `session.current` is unchanged: same `SessionPayload<T>` object, same workspace instance.
6. Sync indicator reads `auth.state.status === 'reauth-required'` and updates its display.
7. Workspace stays mounted. Local edits continue working.
8. Sync push/pull attempts fail until re-auth.

### Different-user sign-in attempt

1. User A is signed in. Workspace is built against A's identity.
2. Somehow `state.identity.user.id` becomes B.
3. `reconcile` detects mismatch, disposes A's workspace, calls `location.reload()`, throws.
4. After reload, fresh boot builds workspace for whichever identity is in storage.

Unchanged from current behavior. The "different user" check is the same.

### Account-popover during `reauth-required`

`account-popover.svelte` already reads `auth.state.status === 'reauth-required'` to:
- Disable the sign-in button (line 220)
- Change label to "Reconnect" (line 225-226)

After this spec: unchanged. The popover is a credential-freshness consumer, not an identity-presence consumer. It legitimately wants the three-state distinction from `auth.state`.

### Sign-in page during `reauth-required`

Same as account-popover. Sign-in pages read `auth.state.status === 'reauth-required'` to show "Reconnect" instead of "Sign in." Unchanged.

### Workspace's encryption keys during `reauth-required`

The auth skill documents that encryption keys are derived at attach time and embedded in store keyrings. They are valid for the entire session as long as identity does not change. `reauth-required` preserves identity, so encryption continues working. Local CRDT operations and decryption are uninterrupted.

### Tab-manager / Chrome extension

Tab-manager's session shape (`apps/tab-manager/src/lib/session.svelte.ts`) and sidepanel gate (`apps/tab-manager/src/entrypoints/sidepanel/App.svelte`) need the same migration. Sidepanel currently checks `current.status === 'signed-out' || current.status === 'reauth-required'`; after this spec, that becomes `!current` if the extension wants to render workspace during reauth, OR `!current || auth.state.status === 'reauth-required'` if not. See Open Questions.

## Rejected alternatives

Considered and rejected for the `Session<T>` shape. Kept here so future readers do not relitigate.

| Shape | Why rejected |
| --- | --- |
| `\| { authenticated: true; identity; workspace } \| { authenticated: false }` (boolean discriminant) | Two sources of truth (the boolean AND identity presence). Allows construction drift. Boolean discriminants are a mild TS anti-pattern; string literals self-document better. |
| `\| { status: 'authenticated'; ... } \| { status: 'unauthenticated' }` (string discriminant) | Same redundancy as boolean. Brings back `current.status` syntax, which is exactly the trap this spec escapes. Different "axis" but same trap shape. |
| `\| { identity; workspace } \| { identity: undefined; workspace: undefined }` (matched-undefined fields) | The "both undefined" variant is exactly the empty-object case `null` represents more cleanly. Adds noise to construct. |
| Separate `session.identity` and `session.workspace` getters | Loses the co-present invariant at the type level. TS does not know the two fields are linked, so consumers need `if (a && b)` and lose narrowing. |
| Hybrid three-state preserving `signed-in`/`reauth-required`/`signed-out` (remediation Phase 3) | Fixes the disposal bug but keeps the wrong-question trap. Forces a second migration when we later collapse to two states. See "Why not just keep the hybrid" in Research Findings. |

Chosen shape: `SessionPayload<T> | null`. The shape is the discriminator. No field can be read incorrectly because there is no second field.

## Open questions

1. **Should `InferSignedIn<T>` be renamed to `InferWorkspace<T>`?**
   - Resolved: yes. `packages/svelte-utils` exports `InferWorkspace`, and app session modules export workspace-shaped aliases such as `FujiWorkspace` and `ZhongwenWorkspace`.

2. **Should tab-manager's sidepanel render workspace during `reauth-required`?**
   - Currently the sidepanel gates on `status === 'signed-out' || status === 'reauth-required'` and shows the sign-in card for both.
   - Options: (a) match SvelteKit apps and render workspace during reauth (b) keep the current "show sign-in card" behavior because the extension UX has different constraints (limited surface, sync-heavy).
   - Recommendation: (a) for consistency. The extension's local data is just as durable; users should not lose tab context to a token expiry. Confirm with manual smoke testing before locking in.

3. **Does dashboard participate?**
   - `apps/dashboard/src/routes/(signed-in)/+layout.svelte` reads `auth.state` directly today and does not appear to consume `createSession`. Verify before the migration; if dashboard does not have a workspace, it has no `Session<T>` to reshape.
   - Recommendation: leave dashboard as-is unless investigation shows it consumes `createSession`.

4. **Should we add a `sessionPayloadBase` type or remove the constraint?**
   - The current `SignedInBase = { userId: string } & Disposable` constrains the workspace shape. With the rename it becomes `WorkspaceBase`.
   - Options: (a) rename to `WorkspaceBase` (b) inline the constraint into `createSession`'s generic.
   - Recommendation: (a). Apps that infer this constraint indirectly benefit from a named base type.

5. **Per-operation 401 toast: in this spec or follow-up?**
   - Recommendation: follow-up. The reshape stands on its own and the sync indicator covers the ambient surface. Per-op toasts are polish for actions that synchronously require fresh credentials (sharing, billing, server-trusted ops), and the population of such actions is small.

## Decisions log (Class 3 keeps)

- **Keep three-state `AuthState`.** Its consumers (`auth.fetch` retry logic, `account-popover.svelte`, sign-in pages, sync indicator) legitimately want three discrete states. The wrong-question trap was at the `Session<T>` projection, not at `AuthState` itself. Revisit when: any consumer outside the legitimate set above starts reading `auth.state.status` in a way that re-introduces the trap.
- **Keep `<Loading />` placeholder in the `(signed-in)` layout.** It now renders only on the brief `!session.current -> redirect -> /sign-in` transition. Revisit when: routing becomes synchronous or the placeholder is observed to flash visibly.

## Acceptance criteria

```txt
- packages/svelte-utils/src/session.svelte.ts exports Session<T> as
  SessionPayload<T> | null. No discriminant field. No credentialsFresh field.
- SessionPayload<T> is exported and contains exactly { identity, workspace }.
- createSession.reconcile disposes only on signed-out or different-user.
  Same-user reauth-required is a no-op at the session boundary.
- packages/auth exports `requireIdentity`, not `requireSignedIn`. The check
  throws only when status is signed-out.
- Every app exposes `requireWorkspace`. SvelteKit apps re-export the shared
  `createSession().requireWorkspace`; tab-manager keeps a custom wrapper until
  its async readiness layer is collapsed.
- Every app's (signed-in)/+layout (or equivalent gate) gates on `if (current)`.
  No app's layout references `status` or `authenticated` on `current`.
- Apps with a sync/connection indicator show a "session expired" variant
  when auth.state.status === 'reauth-required'.
- Tests prove: signed-in → reauth-required → signed-in preserves the same
  SessionPayload instance (object identity, not just structural equality).
- Tests prove: signed-in (user A) → signed-in (user B) disposes and reloads.
- grep `requireSignedIn` returns zero results.
- grep `getSignedInSession` returns zero results.
- grep `current.status` and `current.authenticated` return zero results
  in app code. (Only `auth.state.status` reads remain, in sync indicators,
  sign-in pages, and account-popover.)
- Remediation spec Phase 3 is marked superseded by this spec.
- TypeScript passes across the monorepo.
- Manual smoke confirms each app keeps the workspace alive when refresh
  fails and reconnects cleanly after re-auth.
```

## Non-goals

```txt
Do not reshape AuthState. Its three states serve consumers that legitimately
  want them.
Do not collapse Better Auth's session machinery. The wrap is correct; the
  projection is the only thing that changes.
Do not add a global ReauthBanner component. Wrong surface; sync indicator
  owns this.
Do not change apps/api server routes or middleware. Server-side scope checks,
  /workspace-identity, /docs vs /documents drift: all owned by other specs.
Do not introduce a shared SignInCard component. Sibling work if duplicated
  fallbacks become expensive.
Do not add per-operation 401 toasts in this spec. Phase 6 defers them.
Do not touch encryption derivation, keyring attachment, or store crypto
  setup. The reshape does not affect them.
```

## References

- `packages/svelte-utils/src/session.svelte.ts`: factory being reshaped
- `packages/auth/src/auth-contract.ts`: AuthState type (unchanged)
- `packages/auth/src/require-signed-in.ts`: file being renamed
- `packages/auth/src/index.ts`, `node.ts`: export points to update
- `apps/fuji/src/lib/session.svelte.ts`: exemplar of per-app helper to rename
- `apps/zhongwen/src/routes/(signed-in)/+layout.svelte`: exemplar of layout gate
- `apps/tab-manager/src/entrypoints/sidepanel/App.svelte`: extension equivalent
- `packages/svelte-utils/src/account-popover/account-popover.svelte`: legitimate credential-freshness consumer (unchanged)
- `specs/20260512T111335-post-oauth-audit-remediation.md`: Phase 3 superseded
- `specs/20260512T134603-auth-spec-stack-clean-break-map.md`: success criterion this spec makes true
- `.claude/skills/cohesive-clean-breaks/SKILL.md`: clean-break framework applied
- `.claude/skills/auth/SKILL.md`: documents the contract this spec aligns code to
- DeepWiki query: `better-auth/better-auth` two-axis session state (2026-05-12)
- DeepWiki query: `bitwarden/server` two-axis offline-first auth (2026-05-12)
