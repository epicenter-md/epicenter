# Drop context; expose `getSignedInSession()` as a module-level helper

> The signed-in scope is reached via a top-level function exported from each
> app's session module. The function reads `session.current`, throws on
> misuse, returns the signed-in payload. Per-app `<SignedInSessionProvider>`
> components delete; per-app context infrastructure deletes.

**Date**: 2026-05-07
**Status**: Implemented
**Author**: AI-assisted, grounded against [Svelte 5 context DeepWiki][1] and
[SvelteKit layout/context DeepWiki][2]; revised through three rounds against
external technical review.
**Depends on**: spec 1 (`20260506T013348-...`) and spec 2 (`20260506T143000-...`)
already landed. This refines the descendant-access surface they left in place.
**Branch**: feat/encrypted-local-workspace-storage (or follow-up branch)

[1]: https://deepwiki.com/search/in-svelte-5-what-are-the-recom_0194423b-85b2-4826-89e7-70385581e8aa
[2]: https://deepwiki.com/search/in-sveltekit-layouts-what-is-t_732f72f7-3961-493b-bccf-26c2dd174523

## One-sentence thesis

```txt
Each per-app session module exports a `getSignedInSession()` function that
reads `session.current` and throws on misuse; descendants call it instead
of going through context, and the per-app `<SignedInSessionProvider>`
components and context infrastructure delete.
```

## Why this draft exists

After spec 1 and spec 2 landed, three near-identical files survived per app:

```txt
apps/<app>/src/lib/components/SignedInSessionProvider.svelte   ~18 LOC
apps/<app>/src/lib/session.svelte.ts                            ~contains createContext setup
apps/<app>/src/routes/+layout.svelte                            mounts the Provider
```

The Provider's only job was `setSignedInSession(signedIn)`. Three rounds of
debate explored alternatives:

```txt
Round 1 (audit):                "extract a shared SignedInSessionProvider into
                                  @epicenter/svelte"
Round 2 (third-party review):   "wrong abstraction; install a lazy reader from
                                  the layout's <script> instead"
Round 3 (this spec):            "go one step further: drop context entirely;
                                  expose a module-level helper"
```

Each round refused more than the previous one. This is the floor. The
sections below preserve enough of the rejected alternatives that future
readers don't reopen the same debates.

## What is wrong today

```txt
THREE-PART CHOREOGRAPHY                                   PROBLEM
──────────────────────────────────────                    ────────────────────────────────
1. session.svelte.ts:                                     Context is set up per-app.
   const [getSignedInSession, setSignedInSession] =       Two callers per app
     createContext<FujiSignedIn>();                       (Provider sets, descendants get).

2. components/SignedInSessionProvider.svelte (~18 LOC):    Component whose only job is
   <script>                                                to call setContext during init.
     let { signedIn, children } = $props();                The capture-into-const pattern
     // svelte-ignore state_referenced_locally             is suppressing a real lint.
     setSignedInSession(signedIn);
   </script>
   {@render children()}

3. routes/+layout.svelte:                                  One more wrapping component
   <SignedInSessionProvider signedIn={current.signedIn}>   in the tree, doing nothing
     <FujiAppShell>...</FujiAppShell>                      semantic.
   </SignedInSessionProvider>
```

Three parts, two of them carrying nothing the layout cannot do directly. The
`state_referenced_locally` suppression is the receipt for using context to do
something it does not naturally do (host a precondition assertion).

## The new shape

```ts
// apps/fuji/src/lib/session.svelte.ts
import { type AuthIdentity, requireSignedIn } from '@epicenter/auth';
import { createSession, fromTable, type InferSignedIn } from '@epicenter/svelte';
import { getOrCreateInstallationId } from '@epicenter/workspace';
import { openFuji } from '../routes/(signed-in)/fuji/browser';
import type { EntryId } from '../routes/(signed-in)/fuji/workspace';
import { auth } from './auth';

export const session = createSession({
  auth,
  build: (identity) => {
    const userId = identity.user.id;
    const fuji = openFuji({
      userId,
      peer: { id: getOrCreateInstallationId(localStorage), name: 'Fuji', platform: 'web' },
      bearerToken: () => auth.bearerToken,
      encryptionKeys: () => requireSignedIn(auth).encryptionKeys,
    });
    const entriesMap = fromTable(fuji.tables.entries);
    const active = $derived([...entriesMap.values()].filter((e) => e.deletedAt === undefined));
    const deleted = $derived([...entriesMap.values()].filter((e) => e.deletedAt !== undefined));
    return {
      userId,
      fuji,
      entries: {
        get: (id: EntryId) => entriesMap.get(id),
        get active() { return active; },
        get deleted() { return deleted; },
      },
      [Symbol.dispose]() {
        entriesMap[Symbol.dispose]();
        fuji[Symbol.dispose]();
      },
    };
  },
});

export type FujiSignedIn = InferSignedIn<typeof session>;

if (import.meta.hot) {
  import.meta.hot.dispose(() => session[Symbol.dispose]());
}

/**
 * Returns the live signed-in session for this app.
 *
 * The caller is responsible for only invoking this from a context where the
 * layout has already proven we are in the signed-in branch (the typical case:
 * a `+page.svelte` mounted under the layout's `{#if status === 'signed-in'}`).
 * If invoked outside that scope, this throws to surface the misuse.
 *
 * Bind once at script init and dot-access the fields. Reactive reads on
 * `signedIn.entries.active`, `signedIn.fuji.tables.X` etc. flow through the
 * payload's getters into Svelte's reactive graph.
 */
export function getSignedInSession(): FujiSignedIn {
  const c = session.current;
  if (c.status !== 'signed-in') {
    throw new Error(
      '[fuji] getSignedInSession() called outside the signed-in branch. ' +
      'This indicates a route or component mounted without the layout gate, ' +
      'or a callback firing after the workspace was disposed.',
    );
  }
  return c.signedIn;
}
```

```svelte
<!-- apps/fuji/src/routes/+layout.svelte -->
<script lang="ts">
  import { auth } from '$lib/auth';
  import { session } from '$lib/session.svelte';
  import { AuthForm } from '@epicenter/svelte/auth-form';
  import { WorkspaceGate } from '@epicenter/svelte/workspace-gate';
  import { Loading } from '@epicenter/ui/loading';
  import FujiAppShell from './(signed-in)/components/FujiAppShell.svelte';

  let { children } = $props();
  const current = $derived(session.current);
</script>

{#if current.status === 'pending'}
  <Loading class="h-dvh" />
{:else if current.status === 'signed-out'}
  <AuthForm {auth} ... />
{:else}
  <WorkspaceGate pending={current.signedIn.fuji.idb.whenLoaded}>
    <FujiAppShell>{@render children?.()}</FujiAppShell>
  </WorkspaceGate>
{/if}
```

```svelte
<!-- apps/fuji/src/routes/(signed-in)/+page.svelte (and any other page) -->
<script lang="ts">
  import { getSignedInSession } from '$lib/session.svelte';
  const signedIn = getSignedInSession();
</script>

{#each signedIn.entries.active as entry (entry.id)}
  ...
{/each}
```

What changed structurally:

```txt
DELETED                                                  ADDED
─────────────────────────────────                        ──────────────────────────────────
SignedInSessionProvider.svelte (3 files)                  getSignedInSession() function
  ~18 LOC each                                            (one per app, ~10 LOC each)

createContext<FujiSignedIn>() in each session module     nothing (the createContext call
  ~3 LOC each                                              and its destructured exports go)

setSignedInSession bare export                            nothing

<SignedInSessionProvider> wrapping in +layout.svelte     nothing: layout passes
  ~3 LOC each                                            signedIn directly to its
                                                         shell component

// svelte-ignore state_referenced_locally suppression    nothing: the warning was
in 3 files                                                correct; we are no longer
                                                          doing the thing it warned
                                                          about
```

Net: roughly even on LOC, **strictly better on concept count** (no context layer per app) and **strictly better on lint cleanliness** (no svelte-ignore suppressions).

## Resolved debates (preserved here so they don't reopen)

### Q1: Why drop context entirely instead of installing a lazy reader from the layout?

The third-party review proposed:

```ts
const [readSignedInSession, setSignedInSessionReader] =
  createContext<() => FujiSignedIn>();
export function getSignedInSession(): FujiSignedIn {
  return readSignedInSession()();   // double-call: get reader, then invoke it
}
export function installSignedInSession(read: () => FujiSignedIn): void {
  setSignedInSessionReader(read);
}
// layout's <script>:
installSignedInSession(() => {
  const c = session.current;
  if (c.status !== 'signed-in') throw new Error('...');
  return c.signedIn;
});
```

That is a strict improvement over the Provider component. But it does not
ask whether context is needed at all. When that question is asked, the
answer is no:

```txt
WHEN CONTEXT EARNS ITS KEEP                                  RELEVANT HERE?
────────────────────────────────────────────────             ──────────────
Multiple instances of the same component tree need           No: one
isolated state                                               session per page

Test fixture injection via setContext                        No: vi.mock
                                                             is the codebase's
                                                             documented pattern

Subtree-scoped lifetime (parent owns; lifetime ≠            No: workspace
module lifetime)                                             lifetime IS the
                                                             module lifetime

Decoupling descendants from a specific module path          No: descendants
                                                             are app-specific
                                                             code already

SSR per-request scoping                                      No: SSR not
                                                             supported
```

None of the load-bearing reasons apply. Context is overhead. Drop it.

### Q2: Why a top-level function rather than a namespace getter or method?

We considered five concrete shapes for the same semantics:

```ts
// Shape 1 (chosen): top-level function
const signedIn = getSignedInSession();

// Shape 2: getter on session itself
const signedIn = session.signedIn;

// Shape 3: method on session (Rust-style unwrap)
const signedIn = session.unwrap();

// Shape 4: standalone namespace
const s = signedIn.current;

// Shape 5: getter on session named after the action
const signedIn = session.required;
```

Shape 1 wins on three axes:

```txt
                              SHAPE 1                   SHAPES 2, 4, 5            SHAPE 3
                              (function)                (getter access)           (method)
                              ────────────────          ────────────────           ─────────────
visually announces            yes: function call       no: looks like           yes: method call
"this might fail"             with `Get` prefix         property access

discoverability               top-level export,          must drill into           must drill into
                              shows in import auto-      session                   session
                              complete

naming collision with         no                         yes for Shape 2:          no
local `signedIn`                                         `session.signedIn` and
                                                         `const signedIn` overlap

fits codebase patterns        yes: parallels            no: would be the         no: `unwrap` is
                              `requireSignedIn(auth)`    only `.X.signedIn`        not used elsewhere
                              from @epicenter/auth        getter

reads what it returns         yes: `getSignedIn-       no: `session.signedIn`    no: `unwrap` of
                              Session` says it           does not name             what?
                              returns the session        the return type
```

The throw is a precondition assertion. Hiding it behind property-access
syntax (`session.signedIn`) lies about the operation's cost; making it a
function call (`getSignedInSession()`) is honest. The function shape also
avoids the local-variable naming collision that Shape 2 introduces.

### Q3: Why throw rather than return `T | null` or `Result<T, E>`?

```txt
SHAPE                                  EVERY CALLER MUST...                          VERDICT
─────────────────────────              ───────────────────────────────────           ────────────────
T (throw)                              ...do nothing; just call and use              cleanest at use site
                                                                                      bug surfaces loudly

T | undefined / T | null               ...nullish-check OR ! assert at every         noisy in templates
                                       call site                                     bug becomes
                                                                                      "everything is null"

Result<T, E>                           ...destructure { data, error } and            verbose; doesn't fit
                                       handle error case at every call site         "should never happen"

Stale-snapshot on signed-out           ...nothing; reads silently return             can mask
                                       last-known-good                               write-after-dispose

Proxy that throws on field access      ...nothing visible                            too clever, breaks
                                                                                      reflection and types
```

Throw is the standard pattern for preconditions that should hold by
construction at the call site. React's `useContext`-and-throw, TanStack's
`useQueryClient`, and equivalent SDKs use the same shape for the same
reason. The type signature `T` is the contract; the throw enforces it.

### Q4: Why not also expose `getSignedInSessionMaybe(): T | null`?

The escape hatch is tempting but unnecessary. Every plausible caller falls
into one of two buckets:

```txt
CALLER                                     HOW SHOULD IT ACCESS signedIn?
─────────────────────────────────────      ──────────────────────────────────────
Pages mounted under {#if signed-in}        Throwing helper; layout already proved
                                           the precondition.

Components above the page boundary         Receive signedIn as a prop (spec 4's
                                           migration); no helper call at all.

Event handlers fired from elements         The element only existed because a
inside the signed-in tree                  page was mounted; precondition holds
                                           by mount time.

Async callbacks that might survive         Should be tied to the signed-in scope's
past sign-out                              Symbol.dispose and torn down by the
                                           lifecycle, not exposed to handle null.
                                           Writing one of these without that
                                           teardown is a bug.

Library code outside Svelte components     Imports `session` directly; reads
                                           `session.current` and narrows itself.
                                           No helper needed.
```

There is no third bucket of "I legitimately need to handle both states from
a position where neither prop drilling nor proper teardown applies." Adding
the maybe variant pre-emptively splits the API surface ("which should I
use?") for a use case that has no proven caller. **YAGNI applies. Add it
the day a real caller arrives, not before.**

### Q5: Why not always-present `signedIn: null` on every union variant?

This would change `Session<T>` to:

```ts
type Session<T> =
  | { status: 'pending'; signedIn: null }
  | { status: 'signed-out'; signedIn: null }
  | { status: 'signed-in'; signedIn: T };
```

Pros: TypeScript narrows on either status or `signedIn !== null`; the type
shape is uniform across variants. A small reading-clarity win.

Cons: it doesn't simplify the helper. The helper still has to exist for
pages, just with a one-line internal change (`s === null` instead of
`status !== 'signed-in'`). Every caller is unchanged. Per-call-site code
is unchanged.

Plus, the variant-specific shape mirrors `AuthState` (the upstream union):

```ts
export type AuthState =
  | { status: 'pending' }
  | { status: 'signed-in'; identity: AuthIdentity }
  | { status: 'signed-out' };
```

Auth's `signed-in` variant carries `identity`; pending and signed-out do not.
Mirroring that shape in `Session<T>` is the consistency that matters more
than uniformity within `Session<T>` alone.

### Q6: Why not per-child getters (`signedIn.fuji.X` with throws on access)?

Considered:

```ts
export const signedIn = {
  get fuji(): Fuji { /* checks status, throws */ },
  get entries(): Entries { /* checks status, throws */ },
};
// usage: signedIn.fuji.tables.entries
```

Rejected because:

```txt
1. Loses the "bind once" pattern. Each top-level access invokes the
   precondition check. If a script reads `signedIn.fuji` and `signedIn.entries`,
   that is two checks. Mostly harmless, but it conflicts with the codebase's
   bind-once-and-dot-access rule (memory: feedback_no_destructure_reactive.md).

2. Manually mirrors the SignedIn payload shape. Every field added to
   FujiSignedIn requires adding a corresponding getter on the namespace.
   Brittle.

3. "signedIn" as a namespace name conflicts with the local variable name
   convention (`const signedIn = ...`).
```

### Q7: Why not prop-drill from the layout to descendants?

We do, where SvelteKit allows it (everything above the page boundary). But
SvelteKit's `+page.svelte` cannot receive props from its layout. The
layout-page boundary is owned by SvelteKit's runtime and only delivers
`data` (from `+page.ts` load functions) and route metadata.

For pages, prop drilling is structurally impossible. Some module-level
mechanism is required:

```txt
MECHANISM                          USABLE FOR PAGES?       OUR USE CASE FIT
─────────────────────              ──────────────────      ──────────────────────────
+layout.ts → +page.ts data         yes (via `parent()`)    no: workspace handle
cascade                                                    is non-serializable; load
                                                            is wrong layer for
                                                            lifecycle

context (setContext/getContext)    yes                     loses to module-level
                                                            on every other axis
                                                            (Q1 above)

module-level singleton +           yes                     CHOSEN: works, simple,
helper function                                             matches `auth`/`session`

page state ($app/state)            no                      wrong tool

custom event dispatch              no                      wrong shape
```

The helper exists for the page boundary. Above the page boundary, prop
drilling is the more idiomatic Svelte choice (handled in spec 4, not here).

## Catch-up items folded into this spec

Cheap-to-fix items the third-party review surfaced and this implementation
landed; bundled here to avoid a second pass.

```txt
1. createSession JSDoc accuracy.
   Before this spec, the doc claimed same-user identity changes were observed at the
   "next read." Accurate for bearer tokens (lazy at sync) but not
   universally for encryption keys: attachEncryption reads keys at
   store-registration time and derives a per-store keyring. Same-user
   key rotation does NOT propagate to already-registered stores
   without a re-attach.
   Landed: revise the JSDoc to say lazy callbacks are read at attachment,
   connection and attachment boundaries (sync's bearerToken; openFuji's
   encryptionKeys callback at attachEncryption registration), not by
   already-attached encrypted stores.

2. Drop redundant AuthIdentity annotations in build closures.
   apps/fuji/src/lib/session.svelte.ts has
     build: (identity: AuthIdentity) => { ... }
   createSession's signature already constrains the parameter type.
   The annotation is noise.
   Landed: drop the explicit annotation in fuji, honeycrisp, zhongwen.

3. Drop unused AuthIdentity re-exports.
   apps/<app>/src/lib/auth.ts re-exports AuthIdentity from @epicenter/auth
   in some apps. After the lazy-reads migration, downstream readers of
   identity import from @epicenter/auth directly (or read auth.state).
   The re-export has no callers in the migrated apps.
   Landed: remove the `export type { AuthIdentity }` line where present.

4. Update workspace-app-layout and auth skill examples.
   .claude/skills/workspace-app-layout/SKILL.md:134 still says
   "client.ts -- running singleton + auth + device + lifecycle" but the
   example below it is session.svelte.ts.
   .claude/skills/workspace-app-layout/SKILL.md:144-146 declares the
   SignedIn type explicitly; should use InferSignedIn<typeof session>.
   .agents/skills/auth/SKILL.md:100-119 has the same pattern.
   Landed: rewrite these example blocks to match the post-spec-2 runtime,
   AND document the new module-level getSignedInSession() pattern
   (no Provider component, no install step, no context).
```

## What is NOT in this spec

```txt
1. Prop drilling components above the page boundary.
   FujiAppShell currently calls getSignedInSession() at its <script>
   init. After this spec, it still does. The migration to receiving
   `signedIn` as a prop from the layout is a follow-up spec (spec 4)
   that touches every shell component in fuji, honeycrisp, zhongwen.
   It is mechanical but voluminous; out of scope here.

2. Opensidian and tab-manager migration to createSession.
   That has its own spec (specs/20260507T054727-...) and depends on
   the same primitives. Apply this spec's pattern there in that
   spec's wave ordering, not here.

3. apps/api/src/app.ts.
   The current per-request pg.Client + Hyperdrive shape is broadly
   aligned with Cloudflare/Hono guidance. A separate follow-up could
   investigate Better Auth's `backgroundTasks` with `waitUntil` and
   AsyncLocalStorage. Server concern unrelated to the frontend
   signed-in scope this spec addresses.

4. Extracting auth.ts into a shared factory.
   Per the standardization audit, three near-identical 12-line files
   are not worth extracting. Not addressed here.

5. Extracting browser.ts (openFuji and siblings).
   Per the standardization audit, the per-app variation is woven
   through. Not addressed here.
```

## What changes per file

### Per-app changes (fuji, honeycrisp, zhongwen)

```txt
DELETED:
  apps/<app>/src/lib/components/SignedInSessionProvider.svelte

MODIFIED:
  apps/<app>/src/lib/session.svelte.ts
    - DELETE: const [getSignedInSession, setSignedInSession] = createContext<...>()
    - ADD:    export function getSignedInSession(): <App>SignedIn { /* throws */ }
    - DELETE: explicit `(identity: AuthIdentity)` annotation on build's parameter
    - DELETE: `import type { AuthIdentity }` if no other reference remains
    - JSDoc on getSignedInSession explains the throw and the
      bind-once-dot-access pattern

  apps/<app>/src/lib/auth.ts
    - DELETE: `export type { AuthIdentity }` re-export if present and unused

  apps/<app>/src/routes/+layout.svelte
    - DELETE: import of SignedInSessionProvider
    - DELETE: <SignedInSessionProvider signedIn={current.signedIn}> wrapper
              around children
    - children render directly inside the {:else} branch (still gated by
      WorkspaceGate)

DESCENDANTS (no change in surface):
  Pages and components that already call `getSignedInSession()` continue
  to call the same name. The implementation moved from a context lookup
  to a module-scoped function; the caller's code is identical.
```

### Shared changes

```txt
MODIFIED:
  packages/svelte-utils/src/session.svelte.ts
    - JSDoc on createSession revised: lazy callbacks read at attachment,
      connection and attachment boundaries; not magically by
      already-attached encrypted stores
    - no API change

  .claude/skills/workspace-app-layout/SKILL.md
    - section heading "client.ts -- running singleton..." renamed to
      "session.svelte.ts -- lifecycle + signed-in helper"
    - example uses InferSignedIn<typeof session>, not explicit type
    - example shows the module-level getSignedInSession() function;
      no Provider component, no install step, no context
    - remove auth-construction-in-client.ts language

  .agents/skills/auth/SKILL.md
    - same updates to the example block (lines 100-119 today)
```

## Wave ordering

```txt
Wave 0  Update createSession JSDoc accuracy.
        Single-file edit to packages/svelte-utils/src/session.svelte.ts.
        No runtime change. Land first so subsequent waves consume the
        accurate doc.

Wave 1  Fuji migration (atomic commit).
        - session.svelte.ts: drop createContext, add getSignedInSession
          function, drop AuthIdentity annotation
        - auth.ts: drop AuthIdentity re-export if present
        - +layout.svelte: drop SignedInSessionProvider import and wrapper
        - DELETE: components/SignedInSessionProvider.svelte
        - Typecheck.

Wave 2  Verify fuji (rollback point).
        Manual smoke (browser):
        - cold boot signed-in
        - cold boot signed-out
        - sign in / sign out (in-place flips, no reload)
        - identity-change reload (different-user switch)
        - HMR on session.svelte.ts (clean dispose + reopen; descendant
          pages re-mount; getSignedInSession() returns the new session
          via Vite's HMR proxy)
        - HMR on auth.ts (full page reload)
        - /sign-in direct nav while signed-in
        - /entries/[id] direct nav while signed-out
        - Spec 1 wave 3 auth failure tests:
          a. signOut while a Y.IndexedDB write is in flight
          b. signOut network failure (mock /sign-out 500)
          c. HMR while signed-in with descendants holding workspace refs
          d. concurrent token refresh during render
        If any test fails, revert Wave 1 commit; Wave 0 is inert.
        Particularly watch for getSignedInSession() throwing during
        teardown (test a): if it fires, the appropriate fix is to make
        the helper return the last-known-good signedIn during the
        unmount frame, not to revert this spec. Document the decision
        if you hit this.

Wave 3  Repeat Wave 1 + Wave 2 for honeycrisp.
        Same shape of edit; same smoke suite.

Wave 4  Repeat Wave 1 + Wave 2 for zhongwen.
        Same shape of edit; same smoke suite.

Wave 5  Update workspace-app-layout and auth skill examples.
        Doc-only. After all three apps have migrated, the canonical
        examples can reference the new pattern with confidence.

Wave 6  Final grep sanity. The following should produce zero hits
        outside specs/ and historical articles:
        - SignedInSessionProvider             (component name)
        - state_referenced_locally            (lint suppression we deleted)
        - createContext<FujiSignedIn>         (context type we deleted)
        - createContext<HoneycrispSignedIn>
        - createContext<ZhongwenSignedIn>
        - setSignedInSession (bare export, distinct from the function name)
```

## Tradeoffs (honest accounting)

**The throw can fire during the unmount frame.** During the signed-out
teardown, descendants whose `$derived` re-evaluates and calls
`getSignedInSession()` may see a throw instead of stale-but-valid data.
Mitigation: bind the result once at script init (memory rule:
`feedback_no_destructure_reactive.md`) so the helper is only called when
the script runs, which is at mount and signed-in by construction. Wave 2's
spec-1 auth-failure tests cover this race; if they fail, the appropriate
fix is to make the helper fall back to the last-known-good `signedIn`
during teardown.

**Tests must mock the session module.** Per spec 1's documented test
pattern, `vi.mock('$lib/session.svelte', ...)` replaces the module-level
singleton. This spec doesn't change that.

**Module-level singletons are SPA-only.** SSR is not supported across
the codebase (per spec 1). This spec inherits the constraint. If SSR
ever needs to be added, the helper would need a per-request scope, at
which point context becomes the right tool again.

**HMR on session.svelte.ts re-evaluates the module.** Vite's import
proxy refreshes the helper's module reference; consumers continue to call
`getSignedInSession()` and get the new session. No module-level state
captured by descendants survives the reload.

**Skill docs need updating.** Wave 5 covers this. The previous round of
docs (commit 42f3f2820) updated for the lazy-keys runtime; this spec's
runtime updates require another pass.

## Final check (cohesive-clean-breaks)

```txt
Can I explain the new API without saying "or"?
  Yes. "Each app's session module exports a getSignedInSession() function;
  pages call it at script init; the function reads session.current and
  throws on misuse."

Does one layer own each invariant?
  Yes:
    createSession            when signed-in exists; user-switch refusal
    per-app session module   what the SignedIn payload looks like;
                              the throwing helper for descendant access
    layout                   types the {#if} narrowing for runtime UI
    descendants              UI policy

Would a new caller find only one obvious path?
  Yes. Import getSignedInSession from $lib/session.svelte. Bind once,
  dot-access. Memory rule and JSDoc both reinforce.

Are examples free of compatibility shapes?
  Yes (after migration). No Provider component, no install step, no
  context layer, no svelte-ignore suppression.

Did I delete stale names instead of leaving aliases?
  Yes. SignedInSessionProvider deletes; setSignedInSession bare export
  deletes; createContext<FujiSignedIn> deletes.

Did I move the boundary that caused the smell, or only wrap it?
  Moved. The throw moved from "every call site decides what to do with
  null" to "one helper enforces the precondition once." The Provider
  component, which was the wrong layer for setContext-only ceremony,
  is gone.

Would mentally inlining each new helper make the code clearer?
  No. getSignedInSession centralizes the throw in one place per app;
  inlining would distribute the precondition check to every page.

Did I run the asymmetric wins pass before adding another invariant?
  Yes. Refusal: the per-app context layer. Code family removed:
  Provider component (3 files), context-creation call (3 files),
  state_referenced_locally suppression (3 sites), <SignedInSessionProvider>
  wrapper in layouts (3 sites). Added: one function per app. Net
  asymmetric in favor of removal.
```

## References

- `packages/svelte-utils/src/session.svelte.ts` (current `createSession`).
- `packages/auth/src/index.ts` (`requireSignedIn` export, the parallel
  pattern this spec mirrors at the per-app layer).
- `apps/fuji/src/lib/session.svelte.ts` (current shape that this spec
  rewrites).
- `apps/fuji/src/lib/components/SignedInSessionProvider.svelte` (file
  to be deleted).
- `apps/fuji/src/routes/+layout.svelte` (current Provider mounting site).
- DeepWiki: [Svelte 5 context recommendations][1].
- DeepWiki: [SvelteKit layout/context patterns][2].
- `specs/20260506T013348-session-state-replaces-signed-in-component.md`
  (spec 1: createSession + projection-on-auth.state).
- `specs/20260506T143000-lazy-identity-reads-from-auth.md` (spec 2:
  lazy identity callbacks).
- `specs/20260507T054727-opensidian-tab-manager-create-session.md`
  (deferred migration of opensidian + tab-manager; should adopt this
  spec's pattern as part of its own wave ordering).
- Memory: `feedback_no_destructure_reactive.md` (binding-and-dot-access
  for reactive accessors; `getSignedInSession()` returns a value, so
  callers bind once and dot-access).
