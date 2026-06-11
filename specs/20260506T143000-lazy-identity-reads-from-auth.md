# Workspace identity reads become lazy callbacks

> Auth owns identity. Workspace borrows the values it needs through callbacks
> at use time. `openFuji` captures only `userId`; `encryption.applyKeys` is
> deleted; the SignedIn payload loses its `identity` field.

**Date**: 2026-05-06
**Status**: Implemented
**Author**: AI-assisted, grounded against the codebase post spec 1, and the SPA-ecosystem research compiled in spec 1's "Why we don't apply keys in place" section.
**Depends on**: spec 1 must land first. This spec rewrites the workspace identity surface assuming spec 1's `createSession` factory is in place.
**2026-05-07 note**: The lifecycle shape remains implemented, but the broad
"identity updates propagate through lazy reads" wording below is too broad for
encryption keys. Sync can read refreshed bearer tokens on reconnect or request.
Encrypted stores derive their keyring when attached; already-attached stores do
not observe same-user key rotation without re-attach.
**Branch**: feat/encrypted-local-workspace-storage (or follow-up branch)

## One-sentence thesis

```txt
The workspace captures only `userId` at construction; every other identity
read (encryption keys, future profile fields) is a lazy callback into
auth.state, mirroring how bearerToken already works.
```

## Why this draft exists

Spec 1 dropped the `applyKeys` hook from `createSession` and made identity
changes mid-session reload the page. That removed one symptom (the
mutation hook) but left the underlying smell: the workspace *captures a
copy of identity* at construction time. As long as that capture exists,
every future identity-derived field on the workspace will need its own
sync hook.

Spec 1's sentence: "identity changes reload."
Spec 2's sentence: "identity has one home (auth); the workspace borrows
what it needs lazily."

The asymmetric win in spec 2 is bigger than in spec 1. Spec 1 deleted one
hook. Spec 2 deletes a category of hooks: any future `applyX` for any
identity-derived workspace state. The pattern matches what `bearerToken`
already does in this codebase and what every major SPA auth provider
recommends for identity-bound resources (Clerk, Supabase, Auth0, Better
Auth).

## What is wrong after spec 1 lands

Spec 1 leaves three smells in place:

```txt
SMELL                                     LOCATION                                   COMPENSATING FOR
─────────────────────────────────         ─────────────────────────────────────      ─────────────────────────────
Workspace captures identity eagerly       openFuji({ identity })                     missing invariant: auth owns identity
                                          openHoneycrisp({ identity })
                                          openZhongwen({ identity })

Encryption holds mutable keys             attach-encryption.ts: lastKeys field       same; applyKeys is the sync mechanism
                                          attach-encryption.ts: applyKeys()

SignedIn payload duplicates identity      SignedInBase.identity (snapshot)           reload-on-change keeps it from
                                                                                      drifting; the field exists only
                                                                                      because constructors needed it
```

The deeper invariant in all three: **identity is owned by `auth-svelte`;
downstream resources observe it, they do not store rotated copies of it.**
With that invariant in place at the auth boundary, none of these three
smells need to exist.

## One-sentence test

After spec 1:

```txt
"In Fuji, the workspace exists exactly when a user is signed in,
 and any identity change reloads the page."
```

After this spec:

```txt
"In Fuji, the workspace exists exactly when a user is signed in,
 and reads identity values from auth at the moment it needs them."
```

The "reload on identity change" rule weakens to "reload only on user
switch." Same-user identity changes (key rotation, profile edits) do not
trigger reload because no captured copy is out of date.

## Architecture (one source of identity)

```txt
   auth-svelte (single source of truth for identity)
        │  exposes auth.state.identity (live, $state-backed)
        ▼
┌────────────────────────────────────────────────────────────┐
│  createSession (shared, @epicenter/svelte)                 │
│                                                            │
│  Inputs (per app):                                         │
│    auth        the AuthClient                              │
│    build       (identity) → SignedIn payload               │
│                                                            │
│  Owns:                                                     │
│    - one $state cell of TSignedIn | undefined              │
│    - the auth.onStateChange subscription                   │
│    - initial-state replay after subscribe                  │
│    - the user-switch refusal (location.reload)             │
│                                                            │
│  Reconcile rule (smaller after this spec):                 │
│    a.status !== 'signed-in'  → dispose, undefined          │
│    !signedIn                  → build(a.identity)           │
│    signedIn.userId === userId → no-op (lazy reads handle   │
│                                  same-user updates)         │
│    different user             → dispose, location.reload()  │
│                                                            │
│  Exposes:                                                  │
│    get current(): Session<TSignedIn>                       │
│    [Symbol.dispose](): void                                │
└────────────────────────────────────────────────────────────┘
        │  per-app config
        ▼
┌────────────────────────────────────────────────────────────┐
│  apps/<app>/src/lib/session.svelte.ts                      │
│                                                            │
│  build(identity) {                                         │
│    const userId = identity.user.id;                        │
│    const fuji = openFuji({                                 │
│      userId,                                               │
│      peer,                                                 │
│      bearerToken: () => auth.bearerToken,                  │
│      encryptionKeys: () => requireKeys(auth),              │
│    });                                                     │
│    return { userId, fuji, [Symbol.dispose]: ... }          │
│  }                                                         │
└────────────────────────────────────────────────────────────┘
        │  passes lazy callbacks
        ▼
┌────────────────────────────────────────────────────────────┐
│  openFuji / openHoneycrisp / openZhongwen                  │
│                                                            │
│  ({ userId, peer, bearerToken, encryptionKeys }) => Fuji   │
│                                                            │
│  Captures:                                                 │
│    - userId          stable identifier (IDB DB name, etc.) │
│  Borrows lazily:                                           │
│    - bearerToken()   for sync                              │
│    - encryptionKeys() for encrypt/decrypt at registration  │
└────────────────────────────────────────────────────────────┘
        │  callbacks close over auth, not over a snapshot
        ▼
┌────────────────────────────────────────────────────────────┐
│  attachEncryption (packages/workspace)                     │
│                                                            │
│  ({ encryptionKeys }): no mutable lastKeys, no applyKeys() exit  │
│                                                            │
│  Stores register; encryption derives keyring once at       │
│  registration via encryptionKeys(); same-user changes never       │
│  invalidate (because user-switch reloads) so a single      │
│  derivation per registration is sufficient.                │
└────────────────────────────────────────────────────────────┘
        │  descendants read identity directly from auth
        ▼
┌────────────────────────────────────────────────────────────┐
│  routes/+layout.svelte and descendants                     │
│                                                            │
│  Layout reads session.current.signedIn for the workspace.  │
│  Identity reads use auth.state.identity directly:          │
│                                                            │
│    const state = auth.state                                │
│    if (state.status === 'signed-in')                       │
│      state.identity.user.email                             │
│                                                            │
│  No destructure; bind once and dot-access (preserves       │
│  reactive read tracking and TypeScript narrowing).         │
└────────────────────────────────────────────────────────────┘
```

## The deeper invariant (boundary movement)

```txt
WHO OWNS WHAT                       BEFORE (spec 1)             AFTER (this spec)
─────────────────────────────       ───────────────────         ───────────────────────────
auth.state.identity                 live (auth-svelte)          live (auth-svelte)
SignedIn.identity                   snapshot, kept fresh by     gone; replaced by `userId`
                                    reload-on-change            (single captured field)
fuji.encryption keys                lastKeys field, mutable     encryptionKeys callback closure
                                    via deleted applyKeys()
fuji.encryption.applyKeys()         already deleted in spec 1   stays deleted; no caller
fuji bearer token                   already lazy callback       already lazy callback
descendants reading identity        signedIn.identity.X         auth.state.identity.X
```

The boundary that owns identity is `auth-svelte`. After this spec, no
other layer holds a copy. The workspace is constructed with one stable
field (`userId` for IDB namespacing) and lazy reads for everything else.
Same pattern as `bearerToken: () => auth.bearerToken`, which has
worked in production since the auth refactor landed.

## Asymmetric refusals

```txt
Refusal 1: workspace's right to capture identity at construction
  Deletes:
    - openFuji({ identity })                  (3 apps × 1 param)
    - the `identity` field on SignedIn payloads
    - any future per-resource applyX() hook for identity-derived state
    - SignedInBase.identity (replaced with userId)
  Replaces:
    - openFuji({ userId, peer, bearerToken, encryptionKeys })
    - SignedInBase.userId
    - per-app build closures pass userId + lazy callbacks
  User loss: none for end users; workspace authors lose the convenience of
            "open the workspace and forget about auth."

Refusal 2: encryption holds mutable keys
  Deletes:
    - attach-encryption.ts: `let lastKeys: EncryptionKeys | undefined;`
    - attach-encryption.ts: `applyKeys(keys)` method
    - attach-encryption.ts: `requireKeys()` private helper (folded into encryptionKeys callback)
  Replaces:
    - attachEncryption({ encryptionKeys: () => EncryptionKeys })
    - keyring derivation at store-registration time only
  User loss: none. Same-user key rotation, if it ever became real, would
            require a reload (which spec 1 already established as the rule
            for any identity mutation).

Refusal 3: the same-user identity-change reload (kept in spec 1, removed here)
  Deletes:
    - reconcile branch comparing identitiesEqual(...)
    - identitiesEqual import and the @epicenter/auth re-export added in spec 1
  Replaces:
    - reconcile compares userId only.
      Same user  → no-op (lazy reads handle any identity update).
      Different  → reload.
  User loss: none. Same-user identity updates are now invisible to the
            workspace lifecycle, which is correct: the workspace doesn't
            care, and consumers either lazy-read what they need or get
            invalidated through Svelte reactivity on auth.state.

Refusal 4: SignedIn payload as identity-snapshot container
  Deletes:
    - SignedInBase.identity field
    - getSignedInSession().identity readers across apps (zero in fuji per
      pre-spec audit; verify per app during migration)
  Replaces:
    - Descendants read auth.state.identity directly with TS narrowing.
    - SignedIn payload becomes purely workspace + dispose.
  User loss: descendants that need both workspace and identity now bind
            two names instead of one. Acceptable; naming the dependency
            in the import is honesty (matches spec 1's auth.signOut decision).
```

## The new `openFuji` (and siblings) shape

```ts
// apps/fuji/src/routes/(signed-in)/fuji/browser.ts
import type { EncryptionKeys } from '@epicenter/encryption';

export type OpenFujiOptions = {
  userId: string;
  peer: PeerIdentity;
  bearerToken?: () => string | null;
  encryptionKeys: () => EncryptionKeys;
};

export function openFuji(options: OpenFujiOptions): Fuji {
  // userId is captured (used for IDB DB name).
  // Other identity values are read at use time via the callbacks.
  // ...rest of openFuji unchanged in shape, but consumers of identity.X
  // inside openFuji's body switch to options.userId or options.encryptionKeys().
}
```

`openHoneycrisp` and `openZhongwen` get the same treatment. The signature is
identical across the three; the difference is what each constructor does
internally.

## The new `attachEncryption` shape

```ts
// packages/workspace/src/document/attach-encryption.ts
export type AttachEncryptionOptions = {
  workspaceId: string;
  encryptionKeys: () => EncryptionKeys;
};

export type EncryptionAttachment = {
  // applyKeys: REMOVED. No caller after this spec lands.
  registerStore(store: EncryptableStore): void;
  // Other methods unchanged.
};

export function attachEncryption(
  ydoc: Y.Doc,
  options: AttachEncryptionOptions,
): EncryptionAttachment {
  // No `lastKeys` field. No mutation.
  // On registerStore: synchronously call options.encryptionKeys(),
  // derive the keyring, activate the store. Done.
}
```

Internal note: the keyring derivation is still cached, but the cache lives
per-registration rather than as a single mutable cell. Two registrations
of the same store-type get the same keyring because `encryptionKeys()` returns
the same keys (assuming same-user, which is the only case that exists
post-reload-on-switch).

## The updated `createSession` factory

```ts
// packages/svelte-utils/src/session.svelte.ts
import type { AuthClient, AuthIdentity, AuthState } from '@epicenter/auth';

export type Session<TSignedIn> =
  | Exclude<AuthState, { status: 'signed-in' }>
  | { status: 'signed-in'; signedIn: TSignedIn };

export type SignedInBase = {
  readonly userId: string;
} & Disposable;

export function createSession<TSignedIn extends SignedInBase>({
  auth,
  build,
}: {
  auth: AuthClient;
  build: (identity: AuthIdentity) => TSignedIn;
}) {
  let signedIn = $state<TSignedIn | undefined>(undefined);

  function reconcile(a: AuthState) {
    if (a.status !== 'signed-in') {
      if (signedIn) {
        signedIn[Symbol.dispose]();
        signedIn = undefined;
      }
      return;
    }
    if (!signedIn) {
      signedIn = build(a.identity);
      return;
    }
    // Same user: no-op. Auth-bound callbacks read at their own boundaries:
    // sync can see refreshed tokens on reconnect or request, while encrypted
    // stores keep the keyring they derived when they were attached.
    if (signedIn.userId === a.identity.user.id) return;
    // Different user: refuse live switch (heap safety).
    signedIn[Symbol.dispose]();
    location.reload();
    throw new Error('unreachable: reload pending');
  }

  const unsubscribe = auth.onStateChange(reconcile);
  reconcile(auth.state);

  return {
    get current(): Session<TSignedIn> {
      const a = auth.state;
      if (a.status !== 'signed-in') return a;
      if (!signedIn) return { status: 'pending' };
      return { status: 'signed-in', signedIn };
    },
    [Symbol.dispose]() {
      unsubscribe();
      signedIn?.[Symbol.dispose]();
    },
  };
}
```

What's gone vs spec 1:

```txt
- `identitiesEqual` import and the cross-package export
- the "any identity change reload" branch
- the SignedInBase.identity contract field
```

What's added: nothing. The factory is strictly smaller.

## Per-app session module (post-spec-2)

```ts
// apps/fuji/src/lib/session.svelte.ts
import { requireSignedIn } from '@epicenter/auth';
import { createSession, type InferSignedIn } from '@epicenter/svelte';
import { getOrCreateInstallationId } from '@epicenter/workspace';
import { auth } from './auth';
import { openFuji } from '../routes/(signed-in)/fuji/browser';

export const session = createSession({
  auth,
  build: (identity) => {
    // Capture exactly one identity field: user.id, used for IDB DB name.
    // Everything else is read through `auth` at the consumer boundary.
    const userId = identity.user.id;
    const fuji = openFuji({
      userId,
      peer: {
        id: getOrCreateInstallationId(localStorage),
        name: 'Fuji',
        platform: 'web',
      },
      bearerToken: () => auth.bearerToken,
      encryptionKeys: () => requireSignedIn(auth).encryptionKeys,
    });
    return {
      userId,
      fuji,
      [Symbol.dispose]() { fuji[Symbol.dispose](); },
    };
  },
});

export type FujiSignedIn = InferSignedIn<typeof session>;

export function getSignedInSession(): FujiSignedIn {
  const c = session.current;
  if (c.status !== 'signed-in') {
    throw new Error(
      '[fuji] getSignedInSession() called outside the signed-in branch.',
    );
  }
  return c.signedIn;
}

if (import.meta.hot) {
  import.meta.hot.dispose(() => session[Symbol.dispose]());
}
```

About 35 lines, slightly more than spec 1's original per-app module because
the app names its signed-in accessor. The lines are legible: each callback has
one narrow job.

If a future feature attaches a non-fuji resource to the signed-in scope
(billing, telemetry), it composes inside `build` the same way and reads
identity values lazily through `auth.state`:

```ts
export const session = createSession({
  auth,
  build: (identity) => {
    const userId = identity.user.id;
    const fuji = openFuji({ userId, peer, bearerToken: ..., encryptionKeys: ... });
    const billing = openBilling({
      userId,
      accessToken: () => auth.bearerToken,
    });
    return {
      userId,
      fuji,
      billing,
      [Symbol.dispose]() {
        billing[Symbol.dispose]();
        fuji[Symbol.dispose]();
      },
    };
  },
});
```

`createSession` is unchanged. New attachments add three lines: declare the
field, build with lazy callbacks, dispose. No `applyX` hook for any of them.

## Descendant identity reads

After this spec, there are two reasons code might read identity:

```txt
1. The workspace internals need a value at use time     → use the lazy callback
2. UI needs to display identity in the user's chrome    → read auth.state directly
```

Pattern for (2):

```ts
// Bind once. Don't destructure (preserves reactive read tracking).
const state = auth.state;

if (state.status === 'signed-in') {
  state.identity.user.email;
  state.identity.user.id;
}
```

Or one-shot:

```svelte
{#if auth.state.status === 'signed-in'}
  <span>{auth.state.identity.user.email}</span>
{/if}
```

Both styles are fine; both preserve reactivity. The forbidden pattern is:

```ts
// BAD: destructure breaks reactive read tracking and TypeScript narrowing
const { identity, status } = auth.state;
```

See feedback memory `feedback_no_destructure_reactive.md` for the full rule.

## Lifecycle flows

```txt
Cold boot, signed-in user
─────────────────────────
1. session.svelte.ts evaluates createSession({ auth, build }).
2. signedIn = undefined; current projects auth.state (status: 'pending').
3. unsubscribe = auth.onStateChange(reconcile).
4. Initial replay: reconcile(auth.state). If signed-in, build(identity)
   captures userId and constructs fuji with lazy callbacks.
5. +layout: signed-in branch reads getSignedInSession().
6. WorkspaceGate awaits fuji.idb.whenLoaded.
7. Descendants receive the signed-in session through ordinary Svelte
   component flow and read auth.state directly for live identity fields.

Logout
──────
1. await auth.signOut() resolves.
2. better-auth atom updates session synchronously.
3. reconcile runs; signedIn[Symbol.dispose](); signedIn = undefined.
4. Layout re-renders signed-out branch; SignInPage mounts.

Same-user identity update (rotated keys, profile edit)
──────────────────────────────────────────────────────
1. atom emits new identity; same user.id.
2. reconcile compares signedIn.userId === a.identity.user.id; equal; returns.
3. Workspace lifecycle is undisturbed. No flicker, no remount, no reload.
4. The next encryption operation calls encryptionKeys(), which reads
   auth.state.identity.encryptionKeys, getting the new keys.
5. UI components reading auth.state.identity.X re-render through Svelte's
   normal reactivity (state changed → derived re-runs).

Different user (live switch)
─────────────────────────────
1. atom emits identity with different user.id.
2. reconcile detects user.id mismatch.
3. signedIn[Symbol.dispose](); location.reload();
4. Page reloads, cold-boot path runs with new identity.

HMR on session.svelte.ts
────────────────────────
1. Vite calls import.meta.hot.dispose: session[Symbol.dispose]().
2. Module re-evaluates: fresh createSession; initial replay seeds from
   current auth.state; new fuji constructed with new lazy callbacks
   (which close over the same `auth` import).

Direct nav to /entries/abc while signed-out
───────────────────────────────────────────
Same as spec 1: layout shows Loading then SignInPage based on auth.state.
Lazy callbacks never get invoked because the workspace was never built.
```

The key delta from spec 1: "same-user identity update" is no longer a
reload event. It's a no-op at the workspace lifecycle layer; reactive
updates flow through auth.state and the lazy callbacks.

## What changes per package

### `@epicenter/auth`

```txt
NO CHANGES needed beyond what spec 1 added.
identitiesEqual export added in spec 1 can be REMOVED if no other consumer
took a dependency on it. (Audit before removing.)
```

### `@epicenter/encryption`

```txt
NO CHANGES.
EncryptionKeys / encryptionKeysEqual stay as-is.
```

### `@epicenter/workspace`

```txt
MODIFIED:
  packages/workspace/src/document/attach-encryption.ts
    - Remove `lastKeys: EncryptionKeys | undefined`
    - Remove `applyKeys(keys)` method from EncryptionAttachment type
    - Add `encryptionKeys: () => EncryptionKeys` to AttachEncryptionOptions
    - Replace internal `requireKeys()` with `options.encryptionKeys()` calls
    - Move keyring derivation into `registerStore` flow:
        synchronously call encryptionKeys() at registration, derive keyring,
        activate the store.
    - Update tests in attach-encryption.test.ts to provide a encryptionKeys
      stub instead of calling applyKeys post-construction.

  packages/workspace/src/index.ts
    - Update EncryptionAttachment export shape (no applyKeys)
```

### `@epicenter/svelte` (svelte-utils)

```txt
MODIFIED:
  packages/svelte-utils/src/session.svelte.ts
    - SignedInBase.identity: AuthIdentity → SignedInBase.userId: string
    - Drop `import { identitiesEqual } from '@epicenter/auth'` if added in spec 1
    - reconcile compares `signedIn.userId === a.identity.user.id` only
    - Update JSDoc: status comes from auth.state, payload holds userId + app fields
```

### apps/fuji

```txt
MODIFIED:
  apps/fuji/src/routes/(signed-in)/fuji/browser.ts
    - openFuji parameter type: { identity } → { userId, encryptionKeys }
    - Internal reads: identity.user.id → userId
    - Internal reads: identity.encryptionKeys → encryptionKeys() at call site
      (encryption attachment construction)

  apps/fuji/src/lib/session.svelte.ts
    - FujiSignedIn type: drop `identity`, add `userId` (or rely on inheritance from updated SignedInBase)
    - buildFujiSignedIn: capture `const userId = identity.user.id;`
      pass lazy callbacks to openFuji
    - getSignedInSession() consumers reading signedIn.identity (none today
      per pre-spec audit) switch to auth.state.identity reads.
```

### apps/honeycrisp

```txt
Same shape of changes as fuji:
  apps/honeycrisp/src/routes/(signed-in)/honeycrisp/browser.ts
    - openHoneycrisp({ userId, peer, bearerToken, encryptionKeys })
  apps/honeycrisp/src/lib/session.svelte.ts (created during spec 1)
    - same buildHoneycrispSignedIn refactor
  Audit `getSignedInSession().identity` readers in honeycrisp; switch each
  to `auth.state.identity` with TS narrowing.
```

### apps/zhongwen

```txt
  apps/zhongwen/src/routes/(signed-in)/zhongwen/browser.ts
    - openZhongwen takes { identity } today (no peer/bearerToken).
      Refactor to { userId, encryptionKeys }.
  apps/zhongwen/src/lib/session.svelte.ts (created during spec 1)
    - same refactor
  Audit `getSignedInSession().identity` readers in zhongwen; switch each
  to `auth.state.identity`.
```

## Wave ordering

```txt
Wave 0   Workspace package change (encryption module).
         packages/workspace/src/document/attach-encryption.ts:
         - Add `encryptionKeys: () => EncryptionKeys` to options.
         - Internally still wired to applyKeys for backwards compat ONLY
           if needed during this wave (preferably not; clean break).
         - Update tests.
         Typecheck workspace package.

Wave 1   `@epicenter/svelte` change.
         packages/svelte-utils/src/session.svelte.ts:
         - SignedInBase.userId replaces SignedInBase.identity.
         - reconcile compares userId.
         - Drop identitiesEqual import.
         Typecheck svelte-utils package.
         No app uses the new shape yet (only consumers of SignedInBase
         contract are app session modules, which migrate in waves 2-4).

Wave 2   Fuji pilot.
         apps/fuji/src/routes/(signed-in)/fuji/browser.ts:
         - openFuji new signature: { userId, peer, bearerToken, encryptionKeys }
         - Internal identity reads switch to userId / encryptionKeys().
         apps/fuji/src/lib/session.svelte.ts:
         - buildFujiSignedIn captures userId and passes lazy callbacks.
         - FujiSignedIn type updated.
         Audit and migrate any descendant reading getSignedInSession().identity
         (expected: zero in fuji per pre-spec audit; re-verify).
         Typecheck.

Wave 3   Verify fuji (rollback point).
         - typecheck (apps/fuji + workspace + svelte-utils)
         - manual smoke:
             * cold boot signed-in (workspace opens; entries load)
             * cold boot signed-out (SignInPage)
             * sign in / sign out (in-place flips, no reload)
             * different-user switch (full reload; no state leak)
             * key rotation (if simulatable: same user, new keys; expect
               next encryption op to use new keys; no flicker)
             * HMR on session.svelte.ts (clean dispose + re-open)
             * /entries/[id] direct nav while signed-out
         - auth failure mode tests (carry over from spec 1):
             a. signOut while a workspace write is in flight
             b. signOut network failure
             c. HMR while signed-in with descendants holding workspace refs
             d. concurrent token refresh during render
         - encryption-specific tests:
             e. workspace encrypt/decrypt continues to work (round-trip
                an entry through IDB; assert content integrity)
             f. lazy encryptionKeys() callback returns current keys (mock auth
                emitting rotated keys; assert encryption uses them on
                next operation)
         If any test fails, roll back wave 2 (the workspace and
         svelte-utils changes are inert without app adoption).

Wave 4   Delete fuji's old shape, if anything remains.
         Typecheck.

Wave 5   Repeat 2-4 for honeycrisp.
Wave 6   Repeat 2-4 for zhongwen.

Wave 7   Final cleanup.
         - Remove identitiesEqual export from @epicenter/auth (added in spec 1)
           if no remaining consumer.
         - Remove EncryptionAttachment.applyKeys from any test fixture
           that still references it.
         - Grep for `signedIn.identity`, `getSignedInSession().identity`
           across the monorepo; any remaining reference is a bug.
```

## Tradeoffs (honest accounting)

**Per-app `build` becomes verbose-by-construction.** Two callback closures
where there was previously one snapshot. Three callsite arguments
(`bearerToken`, `encryptionKeys`, plus `userId`) where there was one
(`identity`). This is intentional: each callback names exactly which
identity-derived value the workspace will read, making the dependency
auditable. The verbosity is the contract.

**Lazy reads add a tiny per-operation cost.** Each `encryptionKeys()`
call walks `auth.state.identity.encryptionKeys` instead of reading a
local field. In the encryption module this happens once per store
registration (cached after that), so it's nearly free. In `bearerToken`
this happens once per sync attempt, also negligible. We're not adding
hot-path indirection.

**The `if (state.status !== 'signed-in') throw` inside `encryptionKeys()`
callback is defensive against an impossible-by-construction case.** The
workspace can only be alive when the session is signed-in, because the
factory disposes it on signout. The throw exists for the type system,
not for runtime correctness; if it ever fires, that means the workspace
outlived its scope, which is a bug worth screaming about.

**Testing the encryption module gets simpler.** Old tests had to call
`encryption.applyKeys(keys)` after construction to set up the test
state. New tests pass `encryptionKeys: () => testKeys` once and the keyring is
ready immediately. Less ceremony, less likely to test "what if
applyKeys fires twice" (which is now impossible).

**Migrating consumers of `signedIn.identity` is per-app work.** Each app
needs an audit. Pre-spec evidence: fuji has zero such readers (only
openFuji consumed identity, and openFuji is being refactored). Honeycrisp
and zhongwen need to be audited during their respective waves.

**`SignedInBase` shape change is a breaking type-level change.** Any code
in apps that wrote `signedIn.identity.X` will fail to compile. That's
desired: failing loudly at the boundary is better than silently working
on a stale snapshot.

## Open questions

### Q1: Should `userId` be a branded type?

`identity.user.id` is currently typed as `string` (or whatever
`AuthIdentity['user']['id']` resolves to). For `SignedInBase.userId`,
keeping the same type is the path of least resistance. If user ids
need to be distinguishable from other strings at the type level, a
brand could be added; not in scope here.

### Q2: Does the encryption module need a way to invalidate the cached keyring?

If keys ever truly need to refresh mid-session (forward-looking feature
the project doesn't have today), the current design assumes they don't.
If they do, two options:

```txt
A. Force a reload (matches spec 1's general policy for identity changes).
B. Re-derive the keyring on next operation if `encryptionKeys()` returns a
   different reference. Cheap to add later if needed.
```

Default to (A); revisit only if a real feature requires (B).

### Q3: Is `userId` enough for IDB namespacing?

Today, `openFuji` derives the IDB DB name from `identity.user.id`. Switching
to `userId` is a literal rename with no behavioral change. If IDB names
need to incorporate other identity fields (workspace id, environment),
that's a separate decision and lives in `openFuji`, not in the session
factory.

### Q4: Do we need a typed `requireSignedIn(auth)` helper?

The `encryptionKeys` callback shape:

```ts
encryptionKeys: () => {
  const state = auth.state;
  if (state.status !== 'signed-in') throw new Error('...');
  return state.identity.encryptionKeys;
};
```

is repeated for any lazy callback that reads identity. A helper:

```ts
// @epicenter/auth
export function requireSignedIn(auth: AuthClient): AuthIdentity {
  const state = auth.state;
  if (state.status !== 'signed-in') {
    throw new Error('[auth] called requireSignedIn while not signed-in.');
  }
  return state.identity;
}
```

would simplify call sites:

```ts
encryptionKeys: () => requireSignedIn(auth).encryptionKeys,
```

Add this in Wave 1 (the svelte-utils wave) since it's used by every
per-app session module from Wave 2 onward. Tradeoff: a tiny new export
to maintain. Worth it for the call-site clarity.

## Final check (cohesive-clean-breaks)

```txt
Can I explain the new API without saying "or"?
  Yes. "auth owns identity; the workspace borrows what it needs lazily;
  the workspace lifecycle is bounded by user.id; same-user changes are
  invisible to the workspace lifecycle. Each auth-bound callback reads at
  its own boundary."

Does one layer own each invariant?
  Yes:
    auth-svelte                 the truth about identity (live state)
    createSession               when the workspace exists; user-switch refusal
    per-app session module      what the workspace's lazy callbacks read
    openFuji and siblings       per-resource construction
    attachEncryption            keyring derivation from encryptionKeys callback
    descendants                 UI policy

Would a new caller find only one obvious path?
  Yes:
    For workspace: getSignedInSession().fuji
    For identity:  auth.state.identity (with status narrowing)
    For both:      bind both names; never destructure either.

Are examples free of compatibility shapes?
  Yes. EncryptionAttachment.applyKeys deletes. SignedInBase.identity
  deletes. openFuji({ identity }) deletes.

Did I delete stale names instead of leaving aliases?
  Yes. No backwards-compat shims. Type-level breaks fail loudly.

Did I move the boundary that caused the smell, or only wrap it?
  Moved. Identity ownership consolidates at auth-svelte. Other layers
  observe via callbacks; no other layer holds a copy.

Would mentally inlining each new helper make the code clearer?
  No. attachEncryption owns nontrivial keyring derivation. The
  `requireSignedIn(auth)` helper avoids repeating the throw-on-signed-out
  guard at every callback site. createSession is the auth-binding owner.

Did I run the asymmetric wins pass before adding another invariant?
  Yes. Refusal 1 is the load-bearing one: refusing the workspace's right
  to capture identity collapses the encryption applyKeys pathway, the
  SignedInBase.identity contract, and the same-user-rotation reload
  branch. Three deletions for one refusal.
```

## References

- `specs/20260506T013348-session-state-replaces-signed-in-component.md` (spec 1; predecessor that established createSession and the projection-on-auth.state collapse).
- `packages/auth-svelte/src/create-auth.svelte.ts:18-29` (auth.state is $state-backed; lazy reads through it are reactive).
- `packages/auth/src/create-auth.ts:143` (`sessionsEqual` short-circuit; same-user identical re-emits never fire onStateChange).
- `packages/workspace/src/document/attach-encryption.ts:142-251` (current applyKeys-based shape; this spec rewrites it).
- `apps/fuji/src/lib/session.svelte.ts:30` (the `bearerToken: () => auth.bearerToken` lazy pattern this spec generalizes to encryption keys).
- `apps/fuji/src/routes/(signed-in)/fuji/browser.ts:36-46` (openFuji's current eager-identity signature).
- `packages/workspace/src/document/attach-sync.ts:607` (existing precedent: bearerToken() called lazily during sync).
- Memory: `feedback_no_destructure_reactive.md` (rule for binding-and-dot-access on reactive accessors).
- Spec 1 ecosystem research: Clerk MultisessionAppSupport, Supabase onAuthStateChange, Better Auth session-management, Auth0 SPA SDK, WorkOS AuthKit. None recommend in-place identity mutation; all use lazy reads or remount/reload.
