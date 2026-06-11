# Expose Attachments, Not Aliases

**Date**: 2026-05-06
**Status**: Implemented (bundle-shape rule); gate-UI inlining decision **reversed** post-implementation. See "Post-implementation reversal" below.
**Author**: AI-assisted
**Branch**: feat/encrypted-local-workspace-storage

## Overview

Workspace bundles expose attached subsystems (`idb`, `sync`, `awareness`) directly, and consumers await specific events on them (`fuji.idb.whenLoaded`). Top-level aliases like `whenLoaded` and `whenReady` are deleted unless `whenReady` composes two or more events into a real `Promise.all`.

~~Per-app `Loading.svelte` and `ErrorState.svelte` files are inlined directly into the corresponding `SignedIn.svelte` gate.~~ **Reversed.** The gate UI now lives in two shared components: `WorkspaceGate` and `WorkspaceLoading`: in `packages/svelte-utils`, consumed by all three signed-in apps plus opensidian. See the section below for context and rationale.

## Post-implementation reversal (2026-05-06)

After this spec was marked implemented (`bd33545c7`), the inline-the-gate-UI half was reversed in three commits:

```
92ed684b5  feat(svelte-utils): add WorkspaceLoading and WorkspaceGate
5bfc2bf2c  refactor(apps): swap per-app Loading.svelte for WorkspaceLoading
a43a3768f  refactor(apps): migrate workspace gates to <WorkspaceGate>
```

What changed vs what stuck:

| Decision | Spec said | Reality | Outcome |
|---|---|---|---|
| Bundle exposes subsystems directly (`idb`, `sync`, `awareness`) | yes | yes | **stuck** |
| Delete `whenLoaded`/`whenReady` aliases that proxy a single event | yes | yes (zero alias survivors in apps) | **stuck** |
| Keep composed `whenReady` (Whispering, tab-manager browserState) | yes | yes | **stuck** |
| Apply rule to child-doc bundles | yes | yes | **stuck** |
| Inline `Loading` + `ErrorState` markup into each `SignedIn.svelte` | yes | no: extracted to `WorkspaceGate`/`WorkspaceLoading` | **reversed** |
| Delete `WorkspaceGate` from `packages/svelte-utils` | yes | no: re-introduced with snippet overrides | **reversed** |
| Delete per-app `Loading.svelte` | partial (kept for layout `pending`) | yes: fully replaced by `WorkspaceLoading` | **reversed (further than the spec)** |

Rationale for the reversal (not in the original spec):

1. The new `WorkspaceGate` is **not** the old five-line `{#await}` wrapper that was deleted. It accepts `loading` and `error` snippets and a `pending` promise, defaulting to `WorkspaceLoading` and an `auth.signOut`-aware error panel. Apps consume it as `<WorkspaceGate pending={fuji.idb.whenLoaded} onSignOut={…}>{@render children?.()}</WorkspaceGate>`: five lines per gate, with each app free to override the loading or error branch via snippets.
2. Once opensidian started using the same gate UI, the consumer count was 4 (fuji, honeycrisp, zhongwen, opensidian). The spec's "fifth app, then revisit" trigger had effectively arrived during the same branch.
3. The same logic applies to `Loading.svelte`: a single `WorkspaceLoading` covers both the layout's auth-pending state and the gate's IDB-pending state, which is what the per-app files were already doing identically.

Net surface today: `packages/svelte-utils` exports `WorkspaceGate` and `WorkspaceLoading`. Apps import both. No app keeps a private `Loading.svelte` or `ErrorState.svelte` for the gate path. The bundle-shape rule is unchanged from the spec.

If a future app needs gate UI that diverges materially from the snippet override surface (different chrome, different action set, branded variants), revisit the package vs inline trade-off again.

## Motivation

### Current State

`apps/fuji/src/lib/fuji/browser.ts:107-137`:

```ts
return {
    ...doc,
    idb,                              // real subsystem, exposed
    entryContentDocs,
    awareness,
    sync,                             // real subsystem, exposed
    async wipe() { ... },
    remote,
    rpc,
    whenLoaded: idb.whenLoaded,       // alias #1
    whenReady: idb.whenLoaded,        // alias #2 (identical)
    dispose,
    [Symbol.dispose]: dispose,
};
```

`apps/honeycrisp/src/lib/honeycrisp/browser.ts:107-137` is identical in shape.

`apps/zhongwen/src/lib/zhongwen/browser.ts:13-26`:

```ts
return {
    ...doc,
    whenLoaded: idb.whenLoaded,       // alias of an undeclared subsystem
    whenReady: idb.whenLoaded,        // alias of the same event
    async wipe() {
        doc[Symbol.dispose]();
        await idb.whenDisposed;        // uses idb internally...
        ...
    },
};
```

Consumers:

```svelte
<!-- apps/fuji/src/lib/components/SignedIn.svelte:54 -->
{#await fuji.whenReady}
    <Loading />
{:then}
    {@render children?.()}
{:catch error}
    <ErrorState {error} />
{/await}
```

```svelte
<!-- apps/honeycrisp/src/lib/components/SignedIn.svelte:55 -->
{#await honeycrisp.whenReady}
    <Loading />
...
```

Plus per-app `Loading.svelte` (7 identical lines) and `ErrorState.svelte` (~28 nearly identical lines) at:

- `apps/fuji/src/lib/components/Loading.svelte`
- `apps/fuji/src/lib/components/ErrorState.svelte`
- `apps/honeycrisp/src/lib/components/Loading.svelte`
- `apps/honeycrisp/src/lib/components/ErrorState.svelte`
- `apps/zhongwen/src/lib/components/Loading.svelte`
- `apps/zhongwen/src/lib/components/ErrorState.svelte`

Zhongwen's gate is `apps/zhongwen/src/lib/components/SignedIn.svelte:39`, structurally identical to fuji and honeycrisp (no separate provider component).

This creates problems:

1. **`whenReady` lies.** It is a soft alias for one event (`idb.whenLoaded`). The name promises composition that does not exist. A reader sees `await fuji.whenReady` and cannot tell whether they are waiting for IndexedDB hydration, sync to converge, or both.
2. **Forwarding loses information.** Zhongwen flattens `idb.whenLoaded` to `zhongwen.whenLoaded` while still using `idb` internally for `wipe`. Consumers that need `idb.whenDisposed`, `idb.whenError`, or any other subsystem event have no path. Each forward has to be predicted in advance.
3. **Bundle surfaces are inconsistent.** Fuji and Honeycrisp expose `idb` directly. Zhongwen does not. Same primitive, two shapes, no rule.
4. **`Loading` and `ErrorState` are scope-bound but file-scoped.** They exist for one consumer (the `SignedIn` gate), have one render branch, are duplicated across apps, and pretend to be reusable components. The file-per-component split is ceremony.

### Desired State

Bundles expose attached subsystems directly. Consumers await the specific event on the specific subsystem. `whenReady` is removed unless it composes.

```ts
return {
    ...doc,
    idb,
    sync,
    awareness,
    entryContentDocs,
    remote,
    rpc,
    async wipe() { ... },
    dispose,
    [Symbol.dispose]: dispose,
};
```

```svelte
{#await fuji.idb.whenLoaded}
    <div class="flex h-dvh items-center justify-center">
        <Spinner class="size-5 text-muted-foreground" />
    </div>
{:then}
    {@render children?.()}
{:catch error}
    <Empty.Root class="h-dvh">
        <Empty.Title>Failed to load workspace</Empty.Title>
        <Empty.Description>
            {error instanceof Error ? error.message : 'The workspace could not be opened.'}
        </Empty.Description>
        <Button variant="outline" onclick={() => window.location.reload()}>Reload</Button>
        <Button onclick={() => auth.signOut()}>Sign out</Button>
    </Empty.Root>
{/await}
```

## The Convention

```txt
1. Expose attached subsystems directly on the bundle root (idb, sync, awareness).
2. Consumers await specific events on specific subsystems: fuji.idb.whenLoaded.
3. Add bundle.whenReady ONLY when it composes >=2 events into one Promise.all.
4. Never alias a single event flat at the bundle root.
```

### Anti-patterns

```ts
// Smelly: alias drops information
return { ...doc, whenLoaded: idb.whenLoaded };

// Smelly: "ready" name without real composition
return { ...doc, whenReady: idb.whenLoaded };

// Smelly: hides the subsystem while still using it internally
return {
    ...doc,
    whenLoaded: idb.whenLoaded,
    async wipe() { await idb.whenDisposed; },
};
```

### Honest patterns

```ts
// Single subsystem: expose it, let the consumer name the event
return { ...doc, idb, sync };
// consumer: await fuji.idb.whenLoaded

// Real composition: whenReady earns its place
return {
    ...doc,
    idb,
    migrations,
    whenReady: Promise.all([idb.whenLoaded, migrations.whenComplete]),
};
// consumer: await fuji.whenReady   (because >=2 events)
```

The composing example at `apps/whispering/src/lib/whispering/tauri.ts:30`:

```ts
whenReady: Promise.all([idb.whenLoaded, recordingsFs.whenFlushed]),
```

Caveat: `recordingsFs.whenFlushed` itself awaits `config.whenReady` internally (`recording-materializer.ts:87-88`), and `config.whenReady` is `idb.whenLoaded` (`tauri.ts:22`). So the second promise already implies the first, and this `whenReady` is borderline. Keep it for two reasons: (a) the consumer should not have to know that `whenFlushed` internally awaits IDB; the bundle composing both is defensive against materializer rewiring; (b) materializers that may add file-system or network dependencies later will rejoin the composition without changing the consumer contract. The cleaner archetype is `apps/tab-manager/src/lib/state/browser-state.svelte.ts:120` (`const whenReady = (async () => { ... })()`), an explicit multi-step async init that does not collapse to a single `whenLoaded`.

If a `whenReady` ever becomes provably equivalent to a single underlying event, delete it and let consumers await that event.

## Research Findings

### Existing usage

| Bundle | Exposes idb? | whenLoaded alias? | whenReady alias? | Honest? |
| --- | --- | --- | --- | --- |
| `apps/fuji/.../browser.ts` | yes | yes (=`idb.whenLoaded`) | yes (=`idb.whenLoaded`) | no, two aliases |
| `apps/honeycrisp/.../browser.ts` | yes | yes | yes | no, two aliases |
| `apps/zhongwen/.../browser.ts` | no | yes | yes | no, leaks via `wipe` |
| `apps/opensidian/.../browser.ts` | yes (`idb`) | yes | yes | no |
| `apps/tab-manager/.../extension.ts` | yes | yes | n/a | flat alias still |
| `apps/skills/.../browser.ts` | yes | n/a | yes (=`persistence.whenLoaded`) | no |
| `apps/whispering/.../tauri.ts` | yes | n/a | yes (`Promise.all([...])`) | yes, real composition |
| `apps/tab-manager/.../browser-state.svelte.ts` | n/a | n/a | yes (real async init) | yes |

**Key finding**: every existing `whenLoaded` and most `whenReady` fields in this repo are aliases of `idb.whenLoaded`. Only Whispering and tab-manager browser state have real compositions. The convention will delete the aliases and keep the compositions.

### Child-doc shape

`apps/fuji/src/lib/fuji/browser.ts:74-88` (and the parallel `apps/honeycrisp/.../browser.ts`):

```ts
return {
    ydoc, body,
    idb: childIdb,
    sync: childSync,
    whenLoaded: childIdb.whenLoaded,   // alias
    [Symbol.dispose]() { ydoc.destroy(); },
};
```

Consumer: `apps/fuji/src/lib/components/EntryEditor.svelte:174` does `{#await contentDoc.current.whenLoaded}`. Same anti-pattern, smaller surface.

**Implication**: child-doc bundles are in scope; the rule applies recursively.

### Loading / ErrorState duplication

| Path | Lines | Imports `auth`? |
| --- | --- | --- |
| `apps/fuji/src/lib/components/Loading.svelte` | 7 | no |
| `apps/fuji/src/lib/components/ErrorState.svelte` | 28 | yes (`auth.signOut`) |
| `apps/honeycrisp/src/lib/components/Loading.svelte` | 7 | no |
| `apps/honeycrisp/src/lib/components/ErrorState.svelte` | 28 | yes |
| `apps/zhongwen/src/lib/components/Loading.svelte` | 7 | no |
| `apps/zhongwen/src/lib/components/ErrorState.svelte` | 28 | yes |

**Key finding**: each pair has exactly one consumer (the app's `SignedIn.svelte`). The `auth` dependency makes a shared package awkward (UI cannot know about auth; auth-svelte should not ship UI primitives).

**Implication**: inline both into `SignedIn.svelte` rather than splitting into separate component files or hoisting to a shared package.

**Note on the rejected shared package option**: `@epicenter/auth-svelte` is a plausible home (it already imports auth), and would prevent copy drift across the four apps. We are explicitly rejecting it because (a) the four apps are likely to want different copy and chrome over time (different brand voice per app), (b) the gate UI is 35 lines, (c) extraction adds a dependency just to consolidate a snippet. If a fifth app appears or if copy parity becomes a real product requirement, revisit and move to `@epicenter/auth-svelte`.

## Design Decisions

| Decision | Class | Choice | Rationale |
| --- | --- | --- | --- |
| Surface attached subsystems on bundle root | 2 coherence | Yes (`idb`, `sync`, `awareness`) | Matches the existing partial pattern in fuji/honeycrisp; eliminates lossy forwarding |
| Delete `whenLoaded` and `whenReady` aliases | 2 coherence | Yes when 1:1 alias of a single event | Aliases lie about composition; verified single-source via grep |
| Keep `whenReady` when composed | 1 evidence | Yes | Whispering tauri bundle composes `idb.whenLoaded` and `recordingsFs.whenFlushed`; real invariant |
| Inline `Loading` + `ErrorState` into `SignedIn.svelte` | 2 coherence | ~~Yes, delete the separate files~~ **Reversed** | Replaced by shared `WorkspaceGate` + `WorkspaceLoading` in `packages/svelte-utils` once opensidian adopted the same UI (4 consumers). See "Post-implementation reversal" above. |
| Shared package for gate UI | ~~Rejected~~ **Adopted in svelte-utils** | Live in `packages/svelte-utils`, not `@epicenter/auth-svelte` | The component takes a `pending` promise and an `onSignOut` callback as props, so it carries no auth dependency itself: the caller wires auth in. |
| Apply rule to child-doc bundles | 2 coherence | Yes | Same anti-pattern, same fix |
| Migration ordering | 2 coherence | Build-prove-remove per app | Keep alias fields until consumers migrate, then delete |
| Apps in scope | 2 coherence | Fuji, Honeycrisp, Zhongwen, Opensidian, Skills, tab-manager-extension | All ship a single-source `whenLoaded`/`whenReady` alias today |
| Apps out of scope | 2 coherence | Whispering, tab-manager browser-state | Their `whenReady` is a real composition |
| Add lint or codegen check | Deferred | Defer | Manual grep verification in success criteria; revisit if regressions appear |

## Architecture

### Bundle shape (before vs after)

```txt
BEFORE (fuji)                              AFTER (fuji)
─────────────────────────────              ─────────────────────────────
{                                          {
    ...doc,                                    ...doc,
    idb,                                       idb,
    entryContentDocs,                          entryContentDocs,
    awareness,                                 awareness,
    sync,                                      sync,
    wipe,                                      wipe,
    remote,                                    remote,
    rpc,                                       rpc,
    whenLoaded: idb.whenLoaded,    ─ del      dispose,
    whenReady:  idb.whenLoaded,    ─ del      [Symbol.dispose]: dispose,
    dispose,                               }
    [Symbol.dispose]: dispose,
}
```

### Gate consumer (before vs after)

```svelte
BEFORE                                  AFTER
────────────────────────────            ────────────────────────────────
import Loading from './Loading.svelte'  import { Spinner } from '@epicenter/ui/spinner';
import ErrorState                       import { Button } from '@epicenter/ui/button';
    from './ErrorState.svelte';         import * as Empty from '@epicenter/ui/empty';
                                        import TriangleAlertIcon
                                            from '@lucide/svelte/icons/triangle-alert';
{#await fuji.whenReady}
    <Loading />                         {#await fuji.idb.whenLoaded}
{:then}                                     <div class="flex h-dvh items-center justify-center">
    {@render children?.()}                      <Spinner class="size-5 text-muted-foreground" />
{:catch error}                              </div>
    <ErrorState {error} />              {:then}
{/await}                                    {@render children?.()}
                                        {:catch error}
                                            <Empty.Root class="h-dvh">
                                                <Empty.Media>
                                                    <TriangleAlertIcon class="size-8 text-muted-foreground" />
                                                </Empty.Media>
                                                <Empty.Title>Failed to load workspace</Empty.Title>
                                                <Empty.Description>
                                                    {error instanceof Error ? error.message
                                                        : 'The workspace could not be opened.'}
                                                </Empty.Description>
                                                <div class="flex items-center gap-2">
                                                    <Button variant="outline"
                                                        onclick={() => window.location.reload()}>
                                                        Reload
                                                    </Button>
                                                    <Button onclick={() => auth.signOut()}>
                                                        Sign out
                                                    </Button>
                                                </div>
                                            </Empty.Root>
                                        {/await}
```

### File deletions

```txt
apps/fuji/src/lib/components/ErrorState.svelte        delete
apps/honeycrisp/src/lib/components/ErrorState.svelte  delete
apps/zhongwen/src/lib/components/ErrorState.svelte    delete

# Originally: Loading.svelte stays in each app for the layout pending state.
# Reality (post-reversal, commit 5bfc2bf2c): Loading.svelte was also deleted
# in all three apps and replaced by `WorkspaceLoading` from svelte-utils,
# which now serves both the layout pending state and the gate's IDB-pending
# state.
```

(Opensidian, Skills, tab-manager: audit in their phases; delete only files that served the gate.)

## Implementation Plan

### Migration invariant (apply to every wave)

```txt
Always migrate consumers BEFORE deleting the alias on the bundle.
Within a single phase: update consumer awaits first, then `bun run check`,
then remove the alias field. Never the reverse: deleting the field first
breaks typecheck and forces a forward-only fix.
```

### Phase 1: Establish convention

- [ ] **1.1** Verify the convention statement and anti-patterns in this spec match the team's intent. Adjust wording if needed.
- [ ] **1.2** Optional: add the convention to `apps/fuji/README.md` (Fuji is the canonical example) so the rule is documented next to the code.

### Phase 2: Fuji (reference implementation)

> **Reversal note (post-implementation, 2026-05-06):** Steps 2.1 and 2.2 inlined the markup as the spec specified. They were superseded by commits `5bfc2bf2c` (`WorkspaceLoading` adoption) and `a43a3768f` (`WorkspaceGate` adoption). The current `SignedIn.svelte` gates render `<WorkspaceGate pending={fuji.idb.whenLoaded} onSignOut={…}>` instead of inline `{#await}`.

- [x] **2.1** Inline `Loading.svelte` markup into `apps/fuji/src/lib/components/SignedIn.svelte`. Drop the `import Loading` line. **Superseded:** the inlined markup was later replaced by `<WorkspaceGate>` + `<WorkspaceLoading>` from `@epicenter/svelte`.
- [x] **2.2** Inline `ErrorState.svelte` markup into `SignedIn.svelte`. Pull in `Spinner`, `Button`, `Empty`, `TriangleAlertIcon` directly. **Superseded:** error markup now lives inside `WorkspaceGate`'s default error snippet.
- [x] **2.3** Change the gate from `{#await fuji.whenReady}` to `{#await fuji.idb.whenLoaded}`.
- [x] **2.4** `bun run check`. Smoke test: sign in, see render after IDB hydrates; force an IDB error, see ErrorState; sign out and back in. (Typecheck clean against migration source; UI smoke pending.)
- [x] **2.5** Delete `apps/fuji/src/lib/components/ErrorState.svelte`. (Note: `Loading.svelte` stays; it is also used by the root `+layout.svelte` for the auth `pending` state, not just the gate.)
- [x] **2.6** Remove `whenLoaded` and `whenReady` from the bundle in `apps/fuji/src/lib/fuji/browser.ts`.
- [x] **2.7** Remove the child-doc `whenLoaded` alias. EntryEditor awaits `contentDoc.current.idb.whenLoaded`.
- [x] **2.8** `bun run check` and re-smoke.

### Phase 3: Honeycrisp

- [x] **3.1** Repeat 2.1-2.5 against Honeycrisp paths.
- [x] **3.2** Repeat 2.6-2.8 against `apps/honeycrisp/src/lib/honeycrisp/browser.ts`. NoteBodyPane awaits `idb.whenLoaded` directly.

### Phase 4: Zhongwen

- [x] **4.1** Inline `Loading.svelte` + `ErrorState.svelte` into `apps/zhongwen/src/lib/components/SignedIn.svelte`. Drop the imports. **Superseded** by the same `WorkspaceGate`/`WorkspaceLoading` migration noted at Phase 2.
- [x] **4.2** Change the gate from `{#await zhongwen.whenReady}` to `{#await zhongwen.idb.whenLoaded}`.
- [x] **4.3** Migrate other consumers (chat-state awaits `idb.whenLoaded` directly).
- [x] **4.4** `bun run check`. Smoke test.
- [x] **4.5** Delete `apps/zhongwen/src/lib/components/ErrorState.svelte`. (`Loading.svelte` stays; used by the root `+layout.svelte` for auth `pending`.)
- [x] **4.6** Edit `apps/zhongwen/src/lib/zhongwen/browser.ts`: idb is exposed; alias fields removed.
- [x] **4.7** Final `bun run check` + smoke test.

### Phase 5: Opensidian

Opensidian's child-doc factories use `persistence` (the same role as `idb`). Two options:

```txt
A. Rename `persistence` to `idb` for cross-app consistency.
B. Keep `persistence`, accept that consumers do `handle.persistence.whenLoaded`.
```

**Recommendation**: A (rename). Cross-app consistency is the point of this spec; leaving `persistence` undermines `bundle.idb.whenLoaded` as the canonical phrasing. If A is too risky for this pass, do B and add an Open Question to revisit. Either way, the bundle exposes the subsystem under one name; consumers reach in for the event.

- [x] **5.1** Decide A vs B. If A, rename across opensidian and skills (Phase 6).
- [x] **5.2** Migrate consumers in `apps/opensidian/src/routes/+layout.svelte:15` and `apps/opensidian/src/routes/about/+page.svelte:81` to specific subsystem awaits. (`WorkspaceGate` is gone; opensidian already inlines its `{#await}` per commit `734ef3a4b`.)
- [x] **5.3** Migrate `apps/opensidian/src/lib/chat/chat-state.svelte.ts:317` (`opensidian.whenLoaded.then(...)`).
- [x] **5.4** Edit `apps/opensidian/src/lib/opensidian/browser.ts`:
    - Top-level (`:139`): delete `whenLoaded: idb.whenLoaded`.
    - Child-doc factories (`:58`): delete `whenReady: persistence.whenLoaded`. Update internal callsites in the same factory (lines 72, 77, 82) to `await handle.persistence.whenLoaded` (or `idb.whenLoaded` post-rename).
- [x] **5.5** `bun run check` + smoke.

### Phase 6: Skills

Skills has two surfaces:

```txt
Browser (apps/skills/src/lib/skills/browser.ts)        bundle, follows the rule
Generic handle protocol (packages/skills/src/node.ts)  interface, exempt
```

The `node.ts` handles legitimately need a `whenReady` field because the interface is generic over implementations (some Node, some browser). That stays. The browser-side child-doc factories at `browser.ts:39, 69, 103` are concrete bundles and must follow the rule.

- [x] **6.1** `apps/skills/src/lib/skills/browser.ts:103` (top-level): delete `whenReady: idb.whenLoaded`.
- [x] **6.2** `apps/skills/src/lib/skills/browser.ts:39, 69` (child-doc factories): delete `whenReady: persistence.whenLoaded`. Update internal callsites (lines 87, 92) to await `handle.persistence.whenLoaded` directly (or `handle.idb.whenLoaded` post-rename).
- [x] **6.3** Leave `packages/skills/src/node.ts` untouched. Its `whenReady: Promise.resolve()` satisfies the generic handle contract; that contract is exempt (see Edge Cases).
- [x] **6.4** Migrate browser-side consumers found via grep.

### Phase 7: tab-manager

- [x] **7.1** Edit `apps/tab-manager/src/lib/tab-manager/extension.ts:81`: delete `whenLoaded: idb.whenLoaded`.
- [x] **7.2** Migrate consumers:
    - `apps/tab-manager/src/lib/tab-manager/client.ts:66` (`await tabManager.whenLoaded`)
    - `apps/tab-manager/src/lib/chat/chat-state.svelte.ts:435` (`tabManager.whenLoaded.then(...)`)
    - `apps/tab-manager/src/lib/state/unified-view-state.svelte.ts:80` (`browserState.whenReady.then(...)`: note: `browserState.whenReady` is a real composed `(async () => { ... })()`, NOT in scope)
- [x] **7.3** `bun run check`. Note: `browserState.whenReady` and `apps/tab-manager/src/entrypoints/sidepanel/App.svelte:194` consume the legitimate composed `whenReady`. Do not touch.

### Phase 8: Verify and clean

- [x] **8.1** Repo-wide grep for surviving aliases:
    ```sh
    rg "whenLoaded:\s*\w+\.whenLoaded" apps packages
    rg "whenReady:\s*\w+\.whenLoaded" apps packages
    ```
    Both should return zero hits in `apps/` (Whispering's composed `whenReady` is fine; verify by visual inspection).
- [x] **8.2** Repo-wide grep for stale consumers:
    ```sh
    rg "\.whenReady\b" apps
    rg "\.whenLoaded\b" apps | grep -v "\.idb\.whenLoaded\|\.persistence\.whenLoaded"
    ```
    Survivors should be either composed `whenReady` (Whispering, tab-manager browser-state) or genuine subsystem events on a typed handle interface (Skills node handles).
- [x] **8.3** Update `apps/fuji/README.md` if it documents the old shape (line 53 currently shows `whenLoaded: idb.whenLoaded` in an example).
- [ ] **8.4** `bun run check`, `bun run lint`, smoke test all four apps end to end.

### Phase 9: Documentation

- [ ] **9.1** Add the convention statement and anti-pattern catalog to either `apps/fuji/README.md` or a new `docs/articles/` entry. The convention is short enough to live next to a worked example.

## Edge Cases

### Skills handle interface keeps `whenReady`

`packages/skills/src/node.ts` defines a generic handle interface where `whenReady: Promise<void>` is the only readiness signal. This is not a 1:1 alias of any one subsystem; it is the contract a handle implementation must satisfy. The implementation may resolve it from `Promise.resolve()`, `idb.whenLoaded`, or composed sources.

**Decision**: keep `whenReady` on handle interfaces. Implementations that satisfy the interface by aliasing one event (`whenReady: persistence.whenLoaded`) are acceptable when the handle abstraction itself is single-source.

The rule applies to **app workspace bundles**, not to generic handle protocols.

### `WorkspaceGate` package component (deleted, then re-introduced)

`packages/svelte-utils/src/workspace-gate/workspace-gate.svelte` was a thin generic gate that accepted a single promise prop and rendered loading/children/error branches around `{#await}`. **Decision (2026-05-06): deleted.** **Reversed same day**: see "Post-implementation reversal" above.

Original reasoning for deletion (kept here as historical context):

1. The component wrapped five lines of `{#await}` markup. Apps still had to compose the readiness promise themselves (`opensidian.idb.whenLoaded`) and pass it in, so the gate was not abstracting any composition.
2. The three local-first apps (Fuji, Honeycrisp, Zhongwen) inline the `{#await}` directly in their `SignedIn.svelte` and override the error branch with app-specific actions (Reload + Sign out). The same inline pattern fits Opensidian.
3. A second go-round briefly resurrected the component with an `errorActions` snippet to dedupe the three apps' error UI. Replacing one `<WorkspaceGate>` with the same `<Empty.Root>...</Empty.Root>` block is a wash in lines and adds an external dependency for no abstraction win.

What changed when it was re-introduced (`92ed684b5`):

1. The new component takes `loading` and `error` snippet props, not just a promise. Apps that need different chrome override the snippet; apps that don't accept the default. This was the abstraction the deleted version lacked.
2. Opensidian was actively adopting the same gate UI. Once a fourth consumer landed in the same branch, the "revisit if a fifth app appears" trigger from the original Decisions Log was effectively in play.
3. `WorkspaceLoading` was extracted alongside it because the per-app `Loading.svelte` files were already byte-identical and served two distinct callers (layout `pending` and gate `pending`).

Inline pattern (replicated across all three signed-in gates):

```svelte
{#await fuji.idb.whenLoaded}
    <Empty.Root class="h-dvh flex-none border-0" aria-live="polite">
        <Empty.Media>
            <Spinner class="size-5 text-muted-foreground" />
        </Empty.Media>
    </Empty.Root>
{:then _}
    {@render children?.()}
{:catch error}
    <Empty.Root class="h-dvh flex-none border-0">
        ...
        <Empty.Content>
            <Button variant="outline" onclick={() => window.location.reload()}>Reload</Button>
            <Button onclick={() => auth.signOut()}>Sign out</Button>
        </Empty.Content>
    </Empty.Root>
{/await}
```

Revisit only if a fourth+ app needs the same gate UI verbatim and copy parity becomes a real product requirement.

### Child docs without their own subsystems

A child doc bundle that exposes only one attachment (e.g., a doc that has only `idb` and nothing else worth namespacing) might feel like a candidate to keep `whenLoaded` flat. Resist. Even one-subsystem bundles benefit from the explicit path because future additions (sync, awareness) do not require renaming the gate.

### Consumer reaches across subsystems

Some flows need both IDB hydration and initial sync. Today these would fail at `await fuji.whenReady` because `whenReady` only proxied IDB. After the change, the consumer composes locally:

```ts
await Promise.all([fuji.idb.whenLoaded, fuji.sync.whenInitialConnect]);
```

Or, if the same composition appears in 2+ places, the bundle adds a real `whenReady` field that does the same `Promise.all`. That earns the name.

## Open Questions

1. **Should the bundle also expose a `subsystems` namespace, e.g., `fuji.subsystems.idb`?**
    - Options: (a) flat `fuji.idb`, `fuji.sync`, `fuji.awareness`; (b) namespaced `fuji.subsystems.idb`
    - **Recommendation**: (a) flat. The bundle root is already named (`fuji`), and a second `subsystems` segment is bureaucratic. Class 3 taste.

2. **Should `persistence` (opensidian, skills) be renamed to `idb` for cross-app consistency?**
    - Options: (a) rename `persistence` to `idb` everywhere, (b) keep `persistence`, accept `bundle.persistence.whenLoaded` as a valid form alongside `bundle.idb.whenLoaded`, (c) rename `idb` to `persistence` everywhere
    - **Recommendation**: (a). The point of this spec is consistency: `bundle.idb.whenLoaded` is the canonical phrasing. Two synonyms across apps reintroduces the inconsistency the spec exists to remove. (a) is non-trivial because it touches opensidian and skills internals, but it is mechanical. If (a) is deferred, (b) is acceptable as long as it is named in the convention text. Avoid (c): `idb` is the dominant existing name.

3. **Should the inlined gate markup live in a `gateContents` snippet inside `SignedIn.svelte` or directly in the `{#await}` blocks?**
    - Options: (a) directly in `{#await}` blocks (terser), (b) `{#snippet loading()}` and `{#snippet errored(error)}` snippets above the `{#await}`
    - **Recommendation**: (a) directly. The whole point of inlining is to avoid the abstraction; reintroducing it via snippets defeats the move. If the gate UI grows past ~30 lines per branch, revisit.

4. **What if Whispering's `whenReady` later becomes a single-source alias (e.g., `recordingsFs.whenFlushed` is dropped)?**
    - **Recommendation**: at that point delete `whenReady` and have consumers await the surviving event directly. The rule applies at every boundary commit.

## Decisions Log

- Keep `whenReady` on Skills **node-side** handle interface (`packages/skills/src/node.ts`): the interface is generic over implementations; an implementation that satisfies it via `Promise.resolve()` or by aliasing one event is acceptable because the abstraction itself is single-source. The spec rule applies to **app workspace bundles**, not generic handle protocols.
    Revisit when: a handle implementation needs to expose multiple readiness events to its caller, at which point the interface itself should grow.
- ~~Delete `WorkspaceGate` component~~: **Reversed 2026-05-06** (same day). Once opensidian started consuming the same gate UI, the consumer count hit four (fuji, honeycrisp, zhongwen, opensidian), and a snippet-overrideable `WorkspaceGate` re-extraction was justified. The new shape is not the deleted shape: it accepts `loading`/`error` snippet props, defaults to `WorkspaceLoading`, and lets each app override chrome without forking the wrapper. See "Post-implementation reversal" at the top of the spec.
- ~~Inline `Loading` and `ErrorState` per app~~: **Reversed 2026-05-06**. `WorkspaceLoading` (in `packages/svelte-utils`) replaced the per-app `Loading.svelte` files entirely; `ErrorState` lives inside `WorkspaceGate`'s default error snippet. Trigger as predicted: fourth-app adoption (opensidian) plus byte-identical `Loading.svelte` copies across all three apps.

## Success Criteria

- [x] No `whenLoaded: <expr>.whenLoaded` aliases remain in `apps/`.
- [x] No `whenReady: <expr>.whenLoaded` aliases remain in `apps/`. Composed `Promise.all`-based `whenReady` fields stay (Whispering, tab-manager browser-state).
- [x] Every workspace bundle in scope (fuji, honeycrisp, zhongwen, opensidian, skills browser, tab-manager extension) exposes its attached subsystems (`idb` or `persistence`, `sync`, `awareness` where applicable) directly.
- [~] ~~`WorkspaceGate` component removed from `packages/svelte-utils`.~~ **Superseded.** Re-introduced in `92ed684b5` with snippet-overrideable shape; consumed by all three signed-in apps plus opensidian. See "Post-implementation reversal."
- [x] `Loading.svelte` and `ErrorState.svelte` are deleted from each app. (`ErrorState.svelte` deleted in all three apps. `Loading.svelte` was also deleted in all three: replaced by `WorkspaceLoading` from svelte-utils, which now serves both the layout's auth-pending state and the gate's IDB-pending state. The original spec language "Loading.svelte retained" is superseded.)
- [x] Each `SignedIn.svelte` gate awaits a specific subsystem event (`bundle.idb.whenLoaded`), passed in via `<WorkspaceGate pending={…}>`.
- [ ] `bun run check` and `bun run lint` pass.
- [ ] Manual smoke: sign in, render workspace, sign out, sign in as different user, force IDB load failure (e.g., disable IndexedDB) and see the inlined error UI.
- [ ] Convention is documented in `apps/fuji/README.md` or a `docs/articles/` entry.

## References

- `apps/fuji/src/lib/fuji/browser.ts` - bundle to clean up (reference implementation)
- `apps/fuji/src/lib/components/SignedIn.svelte` - gate that consumes `whenReady`
- `apps/fuji/src/lib/components/Loading.svelte` - to delete and inline
- `apps/fuji/src/lib/components/ErrorState.svelte` - to delete and inline
- `apps/honeycrisp/src/lib/honeycrisp/browser.ts` - parallel cleanup
- `apps/honeycrisp/src/lib/components/SignedIn.svelte` - parallel gate
- `apps/zhongwen/src/lib/components/SignedIn.svelte` - gate that consumes `whenReady`
- `apps/zhongwen/src/lib/components/Loading.svelte` - to delete and inline
- `apps/zhongwen/src/lib/components/ErrorState.svelte` - to delete and inline
- `apps/zhongwen/src/lib/zhongwen/browser.ts` - cleanup, plus expose `idb`
- `apps/zhongwen/src/routes/(signed-in)/+layout.svelte` - signed-in route group entry
- `apps/opensidian/src/lib/opensidian/browser.ts` - cleanup
- `apps/skills/src/lib/skills/browser.ts` - cleanup, mind the handle interface edge case
- `apps/tab-manager/src/lib/tab-manager/extension.ts` - cleanup
- `apps/whispering/src/lib/whispering/tauri.ts` - example of an honest composed `whenReady` (do not touch)
- `apps/tab-manager/src/lib/state/browser-state.svelte.ts` - example of an honest async-init `whenReady` (do not touch)
- `packages/svelte-utils/src/workspace-gate/workspace-gate.svelte` - deleted (see "WorkspaceGate package component" section)
- `specs/20260506T010807-signed-in-owns-the-workspace.md` - related: signed-in scope owns the workspace lifecycle
