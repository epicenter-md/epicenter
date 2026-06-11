# Matter Multi-Vault via the Routing Layer

**Date**: 2026-06-06
**Status**: Implemented (static checks green; live `tauri dev` smoke pending, see Review)
**Owner**: Braden
**Branch**: `matter-multi-vault-routing` (off `995cd9390`, the merge of `matter-typed-markdown-editor`)
**Builds on**: the single-vault work in `matter-typed-markdown-editor` (commits `ba0d611a1`..`fdaeee480`), especially `fdaeee480` which gave the vault `whenReady` + `dispose` and the `vaultSession` singleton this spec replaces.

## One Sentence

Make the URL the open vault: each vault is a `/vault/[id]` route whose component owns the live watcher (construct on mount, dispose on destroy), a persisted string list is the set of open tabs, and SvelteKit's router replaces the bespoke `vaultSession` lifecycle entirely.

## How to read this spec

```txt
Read first:
  One Sentence
  Motivation (Current State / Desired State)
  The Asymmetric Win
  Architecture
  Implementation Plan
  Success Criteria

Read if changing the architecture:
  Research Findings (SvelteKit grounding)
  Design Decisions
  Edge Cases
  Open Questions

For the next session:
  Handoff Prompt (last section)
```

The reader should get the current truth in one minute (One Sentence + Asymmetric Win), the model in five (Architecture + Decisions), the execution path in fifteen (Implementation Plan + Handoff).

## Overview

Matter today opens one folder at a time. This spec adds multiple open vaults with a tab strip, by moving "which vault is active" into the URL and "the live watcher" into a per-route component lifecycle. The only durable state added is a small persisted list of opened folders.

## Motivation

### Current State

After `fdaeee480`, the open vault lives in a module singleton and the page reads it:

```ts
// src/lib/vault.svelte.ts  (today)
function createVault(path) {
  // ... self-watches at construction; exposes whenReady + dispose
}
function createVaultSession() {
  let current = $state<Vault>();   // exactly ONE open vault
  let opening = $state(false);
  let openError = $state<string>();
  async function open() {
    const path = await openFolderDialog();
    if (path) { current?.dispose(); current = createVault(path); }
  }
  return { get current(){...}, get opening(){...}, get openError(){...}, open };
}
export const vaultSession = createVaultSession();
```

```svelte
<!-- src/routes/+page.svelte  (today) -->
{#if vaultSession.current}
  {@const vault = vaultSession.current}
  {#await vault.whenReady} ...loading {:then _} <FolderGrid {vault} ...> {:catch error} ... {/await}
{:else}
  ...open a folder
{/if}
```

This is clean for one vault. The constraints it cannot meet:

1. **One vault only**: `current` is a single slot. Tabs need many.
2. **No navigable identity**: there is no back/forward, no deep-link, no "which vault am I in" that survives a reload.
3. **If you bolt on multi-vault naively**, you reinvent a `Map<id, Vault>`, an `activeId` `$state`, and a manual dispose policy: state the router already manages.

### Desired State

```txt
the URL  /vault/[id]   ->  WHICH vault is active     (free: back/forward, deep-link, no activeId state)
persisted list         ->  WHICH vaults are open     ({id, path, name}[] = the tabs, survives relaunch)
the route component     ->  the LIVE vault for [id]   (construct on mount, dispose on destroy)
```

`vaultSession` is deleted. The vault core (`createVault`, `whenReady`, `dispose`, `FolderGridVault`, `createWhereFilter`) is unchanged; it was built to be exactly the seam a keyed route consumes.

## Research Findings

### SvelteKit routing for a Tauri SPA (grounded against `sveltejs/kit` via DeepWiki, 2026-06-06)

Matter is `ssr = false` (`src/routes/+layout.ts`) with `adapter-static`: a pure client-side SPA. The decisive facts:

| Question | Finding | Source |
| --- | --- | --- |
| Do client-side dynamic routes need config? | Yes: `adapter-static` needs a `fallback` HTML (e.g. `index.html` / `200.html`); the server serves it for any unprerendered path and the client router takes over. | DeepWiki `sveltejs/kit` |
| Does `+page.svelte` remount on `[id]` change? | No. SvelteKit **reuses** the component instance across param changes. You must wrap the resource owner in `{#key page.params.id}` so `onMount`/`onDestroy` fire per id. | DeepWiki `sveltejs/kit` |
| Where does a live, non-serializable resource go? | The **component**, not `load()`. `load()` returns serializable data only. Construct the watcher in the keyed component; `load()` may resolve `id -> {path, name}` and `error(404)` on unknown. | DeepWiki `sveltejs/kit` |
| Programmatic navigation after opening? | `goto()` from `$app/navigation`. | DeepWiki `sveltejs/kit` |
| `page.params` access | `page` from `$app/state` in current kit (verify the exact import against installed version; older code used the `$page` store from `$app/stores`). | Class 1, verify on start |

**Key finding**: the SvelteKit docs already describe this exact shape. `{#key page.params.id}` is the documented mechanism for per-param resource lifecycle; it is the [svelte skill's keyed-resource pattern](../.agents/skills/svelte/references/lifecycle-and-reactivity.md) ("let the parent own mount/unmount; open sync in the child; gate readiness with `{#await}`") lifted from a component to the router.

**Implication**: the radical-simple design is also the framework-native one. Reaching for a global registry is fighting the router.

### Route-owned vs global registry

| | Route-owned (recommended) | Global registry `Map<id, Vault>` |
| --- | --- | --- |
| Who owns lifecycle | the router (`{#key}` + `onDestroy`) | you (manual create/dispose policy) |
| Live watchers | one at a time (active route) | N (all open tabs) |
| Tab switch | re-open + re-seed the new vault | instant (already live) |
| Background changes | seen on next visit (re-seed) | live |
| OS resources | one `notify` watcher | N watchers (inotify/FSEvents pressure) |
| Bespoke state | a persisted string list only | list + `Map` + `activeId` + dispose policy |
| Fits SvelteKit | yes, native | no, you keep state the router wants to tear down |

**Key finding**: matter's lifecycle bench (`scripts/bench-lifecycle.ts`, see `specs/20260605T145734-matter-live-projection-lifecycle.md`) shows reconcile is sub-frame to ~50k rows and the cost is the IPC seed **payload**, not CPU. Re-seed on tab switch is cheap at drafting scale.

**Implication**: re-open-on-switch is the default; a registry is a later, scoped addition only if a feature needs background liveness.

## The Asymmetric Win

```txt
Refuse:   background vaults staying live while their tab is inactive        (~15% of the feature)
Collapse: the Map<id,Vault>, the activeId state, the manual dispose policy,
          and the imperative open/current/swap  ->  all of it becomes the router  (~85%)
```

One line: **the URL is the active vault, a persisted string list is the open vaults, and SvelteKit's router is the entire live-vault lifecycle.** Giving up background watching is what lets every piece of bespoke multi-vault state disappear. Re-seed-on-view is also a safety property: it is the same "pure function of truth, full reconcile, no silent divergence" rule matter already applies to the SQLite mirror, now applied to tabs.

## Design Decisions

| Decision | Class | Choice | Rationale |
| --- | --- | --- | --- |
| Active vault identity | 2 coherence | the URL `/vault/[id]` | URL is the natural home for navigable state; frees back/forward/deep-link; no `activeId` `$state`. |
| Vault lifetime | 2 coherence | route-owned, one live at a time | router + `{#key}` + `onDestroy` is the lifecycle; refuse background watching (the asymmetric win). |
| Tab switch behavior | 3 taste | re-open + re-seed | cheap at matter's scale (bench); re-seed = always-current safety. Constraint: brief loading flash on switch; large-folder seed payload. |
| `id -> path` resolution | 1 evidence | `+page.ts` `load()` returns `{path, name}` or `error(404)` | DeepWiki: serializable data + clean not-found; component stays lifecycle-only. (Open Q: could read the singleton in-component instead.) |
| Live vault construction | 1 evidence | in the keyed component, never `load()` | DeepWiki: non-serializable resources cannot leave `load()`. |
| Slug shape | 2 coherence | opaque short id, not the raw path | filesystem paths contain `/` and special chars; `%2F` in URLs is fragile. `id -> path` lives in the persisted list. |
| Open-vaults persistence | 3 taste | `createPersistedState` from `@epicenter/svelte` (localStorage) | repo-idiomatic per the svelte skill; survives reload; gives reopen-on-relaunch (watch_folder takes an unrestricted absolute path, verified `watch.rs`). Add the dep if absent; a tiny hand-rolled wrapper is acceptable. |
| Vault core (`createVault`/`whenReady`/`dispose`/`FolderGridVault`/`createWhereFilter`) | 2 coherence | unchanged | built in `fdaeee480` to be exactly this seam. |
| `/demo` route | 2 coherence | unchanged | its own synchronous in-memory vault; orthogonal. |
| Registry of live vaults | Deferred | Deferred | add only when a feature needs background liveness (cross-vault search, inactive-tab badges). |

## Architecture

```txt
src/routes/
  +layout.svelte         tab strip: reads openVaults (persisted), <a href="/vault/{id}">,
                         active = page.params.id, "+" button = open(); renders {@render children()}
  +layout.ts             export const ssr = false   (already present)
  +page.svelte           index: "open a folder" onboarding  (Open Q: or redirect to last open vault)
  vault/[id]/
    +page.ts             load({ params }): openVaults.find(params.id) -> {path, name} | error(404)
    +page.svelte         {#key data.path} <VaultView path={data.path} /> {/key}
    VaultView.svelte     the OLD +page body, verbatim minus the singleton reads:
                           const vault = createVault(path)
                           $effect(() => () => vault.dispose())   // dispose on destroy
                           {#await vault.whenReady} spinner {:then _} <FolderGrid> {:catch} couldn't-watch
                           const filter = createWhereFilter(); $effect(() => filter.resolve(vault))
  demo/                  unchanged

src/lib/
  open-vaults.svelte.ts  persisted {id,path,name}[] singleton + open() (dialog -> mint id -> push -> goto) + close()
  vault.svelte.ts        createVault / whenReady / dispose / FolderGridVault   UNCHANGED
                         vaultSession  ->  DELETED
  where-filter.svelte.ts UNCHANGED (now one filter per VaultView = a free per-tab WHERE clause)

svelte.config.js         adapter-static { fallback: 'index.html' }   (required for the dynamic route)
```

Open flow:

```txt
"+" / "Open folder"
  -> openVaults.open()
    -> openFolderDialog()  (native picker, returns absolute path | null)
    -> mint opaque id; push { id, path, name: basename(path) } to the persisted list
    -> goto('/vault/' + id)
      -> /vault/[id] load resolves id -> { path }
        -> VaultView mounts: createVault(path) self-watches; {#await whenReady} -> grid
```

Switch flow:

```txt
click tab  ->  <a href="/vault/{otherId}">
  -> SvelteKit reuses +page.svelte; {#key data.path} sees a new key
    -> old VaultView onDestroy -> vault.dispose()  (old OS watcher stops)
    -> new VaultView mount -> createVault(newPath) -> re-seed
```

## Call Sites: before and after

### The page body moves into a keyed route component

**Before** (`src/routes/+page.svelte`, today): reads `vaultSession.current`, gates with `{#await}`.

**After**: `src/routes/vault/[id]/+page.svelte` is just the keyed wrapper; the body becomes `VaultView.svelte`:

```svelte
<!-- vault/[id]/+page.svelte -->
<script lang="ts">
  import { page } from '$app/state';      // verify import vs installed kit
  import type { PageData } from './$types';
  import VaultView from './VaultView.svelte';
  let { data }: { data: PageData } = $props();
</script>
{#key data.path}
  <VaultView path={data.path} />
{/key}
```

```svelte
<!-- vault/[id]/VaultView.svelte  (the current +page body, de-singletoned) -->
<script lang="ts">
  import { createVault } from '$lib/vault.svelte';
  import { createWhereFilter } from '$lib/where-filter.svelte';
  let { path }: { path: string } = $props();
  const vault = createVault(path);
  $effect(() => () => vault.dispose());   // dispose when this keyed instance is torn down
  const filter = createWhereFilter();
  $effect(() => filter.resolve(vault));
  const view = $derived(vault.read.view);
</script>
{#await vault.whenReady}
  ...spinner...
{:then _}
  ...{#if vault.writeError}...{/if} <FolderGrid {vault} matchedFileNames={filter.matchedFileNames} />
{:catch error}
  ...couldn't watch {vault.folderName}...
{/await}
```

**Semantic shift to flag**: `filter.resolve(vault)` now takes a non-undefined `vault` (the route guarantees one), so the `vault | undefined` branch inside `resolve` is dead on this path. Leave `resolve` tolerant (the demo and the cold index may still pass undefined), or tighten it; grill which.

### Open action moves from the singleton to the list

**Before**: `vaultSession.open()` sets `current`.

**After** (`src/lib/open-vaults.svelte.ts`):

```ts
async function open(): Promise<void> {
  const path = await openFolderDialog();
  if (path === null) return;
  const id = mintId();                                  // opaque, URL-safe
  list.push({ id, path, name: basename(path) });        // persisted
  await goto(`/vault/${id}`);
}
```

## Implementation Plan

Follow Build, Prove, Remove: the old `vaultSession` path stays on disk until the new path is proven, so rollback is one revert.

### Phase 1: Build the route skeleton

- [x] **1.1** Add `adapter-static` `fallback` in `svelte.config.js`; confirm a hard refresh on `/vault/anything` boots the SPA.
  > **Note**: `fallback: 'index.html'` was already present. Confirmed statically via `bun run build`: the SPA shell (`build/index.html`) is emitted and the dynamic route builds with no prerender error. Live hard-refresh is part of the `tauri dev` smoke (3.2).
- [x] **1.2** `src/lib/open-vaults.svelte.ts`: persisted `{id,path,name}[]`, `open()`, `close(id)`, a `get(id)` helper.
  > **Deviation**: hand-rolled localStorage wrapper instead of `createPersistedState`. Matter never imports `@epicenter/svelte` and `createPersistedState` requires a `StandardSchemaV1` schema (typebox v1 is not one, and matter's own `src` never imports raw typebox). The spec blessed "a tiny hand-rolled wrapper." It guards reads with `browser`, validates the parsed shape (corrupt store degrades to no tabs), and persists on every change. `mintId()` is inlined as `crypto.randomUUID()` (opaque, URL-safe, collision-free) rather than a one-line named helper. `openFolderDialog` moved here from `vault.svelte.ts` (its only caller was `vaultSession`).
  > **Added decision**: `open()` dedups by path. Reopening a folder already in the list focuses its existing tab instead of minting a duplicate (tabs show one at a time and only the active one is live, so a duplicate would be dead). Class 3 taste.
- [x] **1.3** `vault/[id]/+page.ts`: `load` resolves `params.id -> {path,name}` from the list or `error(404)`.
- [x] **1.4** `vault/[id]/VaultView.svelte`: move the current `+page.svelte` body here, de-singletoned (props `path`), dispose via `$effect` cleanup.
  > **Note**: `createVault` is now exported from `vault.svelte.ts` (was private to `vaultSession`). The keyed-prop capture uses the repo-idiomatic `// svelte-ignore state_referenced_locally` (same pattern as fuji's `EntryBodyEditor`). `where-filter.svelte.ts` is unchanged: `resolve` stays tolerant of `undefined` per Open Q6.
- [x] **1.5** `vault/[id]/+page.svelte`: `{#key data.path}<VaultView path={data.path}/>{/key}`.

### Phase 2: Build the shell

> **Deviation (whole phase)**: the tab strip lives in a `(vaults)` route-group layout (`src/routes/(vaults)/+layout.svelte`), not the root `+layout.svelte`, and the index moved to `(vaults)/+page.svelte`. Reason: the spec wants `/demo` orthogonal/unchanged, but a layout cannot be un-inherited, so a root-level tab strip would force itself onto `/demo`. The group puts index + `vault/[id]` under the tab-strip shell while `demo/` stays a sibling with only the root providers layout (no path-sniffing conditional). The root `+layout.svelte` (Tooltip + ModeWatcher) is unchanged.

- [x] **2.1** `(vaults)/+layout.svelte`: tab strip from `openVaults`, active = `page.params.id`, "+" calls `open()`, per-tab close button (`close(id)` + `goto` to a neighbor, else `/`, if it was active).
- [x] **2.2** `(vaults)/+page.svelte` (index): onboarding "open a folder" (Open Q2 resolved to (a) for v1).
- [x] **2.3** `(vaults)/vault/[id]/+error.svelte`: the `error(404)` "this vault isn't open" state with a reopen affordance.

### Phase 3: Prove

- [x] **3.1** `bun run typecheck`, `bun test` green (44 pass). `cargo test` not run: this feature touches no Rust (the `FileDelta`/`watch_folder` IPC is unchanged), so there is no ts-rs binding to regenerate. `bun run build` also green (adapter-static emits the SPA fallback and the dynamic route builds with no prerender error).
- [ ] **3.2** `bun tauri dev` smoke test (the only real proof of the watcher lifecycle): open two folders, switch tabs (old watcher stops, new seeds), close a tab, relaunch (vaults reopen from the persisted list), open a since-deleted folder (catch branch).
  > **Not run in this session** (no headless Tauri). The watcher-lifecycle behavior is the one thing static checks cannot prove; it must be run by hand. See the Review section for the exact steps.

### Phase 4: Remove

- [x] **4.1** Delete `vaultSession` (and its `openFolderDialog`) from `vault.svelte.ts`; delete the old single-vault `+page.svelte` body.
  > **Note**: the old `+page.svelte` was removed in Wave 1 (the new path replaced it); `vaultSession` + `openFolderDialog` + the `plugin-dialog` import were removed here in Wave 2, after the new path proved out statically. `extractErrorMessage` stays (still used by `write`).
- [x] **4.2** Straggler sweep (no `vaultSession` refs outside `open-vaults.svelte.ts`'s historical doc note); updated the `vault.svelte.ts` module doc comment to describe the route-owned lifecycle. Memory update is in the Final step.

## Edge Cases

### Relaunch with persisted vaults
1. App boots at `/` (or last route via SvelteKit), the persisted list has N entries.
2. Navigating to `/vault/[id]` re-runs `createVault(path)`; the watcher re-arms (path is unrestricted, verified `watch.rs`).
3. Expected: vaults reopen. If a path was deleted/moved, `whenReady` rejects -> `{:catch}`.

### Cold deep-link to an unknown id
1. `/vault/abc` where `abc` is not in the persisted list.
2. `load` throws `error(404)`.
3. Expected: `+error.svelte` "not open, reopen?" (not a crash).

### Closing the active tab
1. User closes the tab they are viewing.
2. `close(id)` removes it; the route is now stale.
3. Expected: `goto` to a sibling tab, or to `/` if none. Decide in 2.1.

### Rapid tab flipping on a huge folder
1. Many switches; each re-seeds.
2. The seed IPC payload is the cost.
3. Expected: acceptable at drafting scale; if it bites, add a small LRU keep-alive (Open Q), not a registry.

## Open Questions

All resolved for v1 (decisions below). Each marks `[RESOLVED]` with the choice taken.

1. **`load()` vs reading the singleton in the component for `id -> path`.** `[RESOLVED: (a)]`
   - Chose (a): `+page.ts load` returns `{path,name}` + `error(404)`. Clean framework-native error boundary (`+error.svelte` renders inside the tab strip, verified against kit 2.56) and the component stays lifecycle-only.
   - Known limit: `load` is not reactive to the `$state` list, so the "viewed id is always in the list" invariant is caller-enforced (`closeTab` always navigates away from a closed active tab). Documented on `close()`. If a future path removes the active vault without navigating, switch to `depends('matter:open-vaults')` + `invalidate`, or to option (b) reactive in-component resolution. See Follow-up.

2. **Index route `/` behavior.** `[RESOLVED: (a)]` Onboarding "open a folder" for v1. (b)/(c) deferred.

3. **Keep-alive on tab switch.** `[RESOLVED: defer]` Re-seed-on-switch, no keep-alive (Decisions Log). Revisit only if the flash is measured as annoying; model on `createDisposableCache`, not a hand-rolled map.

4. **Tabs vs native Tauri windows.** `[RESOLVED: in-app tabs]` One window, routes. Native multi-window deferred (would add a `storage` listener to `open-vaults` so windows agree on the open set; noted in that file).

5. **Tab order / session restore fidelity.** `[RESOLVED: persist order only]` The persisted array order IS the tab order. Auto-restoring the active tab on relaunch (a `lastActiveId`) is deferred; relaunch lands on `/` and the tabs are one click away. See Follow-up.

6. **Tighten `createWhereFilter` / `filter.resolve` to a non-optional vault?** `[RESOLVED: keep tolerant]` `where-filter.svelte.ts` is byte-unchanged; `resolve` stays tolerant of `undefined`. The dead branch on the route path is harmless and keeps the module a true "unchanged" per the architecture table.

## Adjacent Work

- Registry of live vaults: not required now; add only for a feature that needs background liveness (cross-vault search, inactive-tab change badges).
- Native multi-window: not required; a different product direction.
- Reopen-active-tab-on-launch: not required; cheap nicety once the list persists.

## Decisions Log

- Keep `createWhereFilter` per-`VaultView` (one filter instance per tab): each tab gets its own WHERE clause, which is correct, not a cost.
  Revisit when: a feature needs a shared cross-tab filter.
- Keep re-seed-on-switch (no keep-alive): simplicity + always-current safety over instant switching.
  Revisit when: the loading flash is measured as annoying, or a folder is large enough that the seed payload stalls switching.

## Success Criteria

Static criteria are checked; the watcher-lifecycle criteria need the live `tauri dev` smoke (Review).

- [~] Open two folders; both appear as tabs; the URL reflects the active one. (built; verify live)
- [~] Switching tabs disposes the old watcher and seeds the new (verify in `tauri dev`: only one watcher live). (built; verify live)
- [~] Back/forward navigates between vaults. (built on the router; verify live)
- [~] Relaunch reopens the persisted vaults; a deleted folder shows the `{:catch}` state, not a crash. (built; verify live)
- [~] A cold deep-link to an unknown id shows the `error(404)` state. (built; verify live)
- [x] `vaultSession` is gone; `bun run typecheck` + `bun test` green (44 pass). `cargo test` n/a (no Rust touched). Live smoke pending.
- [x] The vault core, `FolderGrid`, `where-filter`, and `/demo` are unchanged. (`createVault` gained `export`; otherwise the listed surfaces are untouched.)

## Review

**Completed**: 2026-06-06
**Branch**: `matter-multi-vault-routing` (commits `9a4be7414`, `7498ad999`, `e2e692d81` on `995cd9390`)

### What Landed

The URL is now the active vault, a persisted `{id,path,name}[]` list is the open vaults, and SvelteKit's router is the entire live-vault lifecycle. `vaultSession` is deleted. The keyed `/vault/[id]` route constructs `createVault(path)` on mount and disposes it on destroy via an `$effect` cleanup; `+page.ts load` resolves the opaque id to a path or `error(404)`; a `(vaults)` route-group `+layout.svelte` renders the tab strip; `+error.svelte` is the not-open state. The one-sentence description holds.

### Deviations and Discoveries

- **Tab strip in a `(vaults)` route group, not the root layout.** A layout cannot be un-inherited, so a root-level strip would force itself onto `/demo`. The group puts index + `vault/[id]` under the shell and keeps `/demo` a clean sibling, with no path-sniffing conditional. The root `+layout.svelte` is unchanged.
- **Hand-rolled persisted list, not `createPersistedState`.** Matter never imports `@epicenter/svelte`, and that helper requires a `StandardSchemaV1` schema (typebox v1 is not one). A tiny `browser`-guarded localStorage wrapper with a shape guard fit matter's stack; the spec blessed this.
- **`open()` dedups by path** (reopening a folder focuses its existing tab). This makes key-on-path equivalent to key-on-id (a quietly load-bearing coupling, now commented).
- **`load()` returns `{path,name}`; `name` sets a per-vault window title** (`Matter / name`, matching the `/demo` title convention) so the field is consumed, not dead.
- **`createVault` is now exported** (was private to `vaultSession`); the keyed-prop capture uses the repo-idiomatic `// svelte-ignore state_referenced_locally`.
- **Review pass (code-reviewer subagent)** confirmed: one watcher live, dispose-before-armed race already handled in `vault.svelte.ts`, correct `closeTab` index math, clean 404 boundary that preserves the tab strip. It surfaced two latent reactivity gaps (load not reactive to the list; no cross-context `storage` sync), both with no current trigger (closeTab always navigates; v1 is single-window). Resolved by documenting the invariants rather than adding machinery; see Follow-up.

### Live smoke test (REQUIRED, not run in this session)

The watcher lifecycle is the one thing static checks cannot prove. Run `cd apps/matter && bun tauri dev` and verify:

1. **Open two folders** via the `+` button. Both appear as tabs; the URL is `/vault/<id>`; the active tab is highlighted.
2. **Switch tabs.** The new vault re-seeds (brief loading), the old watcher stops. Confirm only one OS watcher is live (e.g. the old folder's external edits no longer stream while you are on the other tab).
3. **Back/forward** navigates between the two vaults.
4. **Close a tab.** Closing the active tab jumps to a neighbor (or `/` if it was the last); closing an inactive tab leaves you put.
5. **Relaunch the app.** The persisted tabs are gone from the view (lands on `/`) but reopen when you click a tab; a tab whose folder was deleted/moved shows the "Couldn't watch" `{:catch}` state, not a crash.
6. **Cold deep-link** to `/vault/does-not-exist` shows the `+error.svelte` "This vault isn't open" 404 state with the tab strip intact.

### Follow-up Work

- **Reopen-active-tab-on-relaunch**: store a `lastActiveId` and `goto` it on boot. Cheap nicety now that the list persists.
- **Self-healing route** if a non-navigating removal of the active vault ever becomes possible: `depends('matter:open-vaults')` in `load` + `invalidate` in `open`/`close`, or move id->path resolution into the component (Open Q1 option b).
- **Multi-window** (Open Q4): add a `storage` listener in `open-vaults.svelte.ts` so windows agree on the open set.
- **Keep-alive LRU** (Open Q3) only if the re-seed flash is measured as annoying.

## References

- `apps/matter/src/lib/vault.svelte.ts` - `createVault` (keep), `vaultSession` (delete), `openVault` (fold into the list).
- `apps/matter/src/routes/+page.svelte` - the body that moves into `VaultView.svelte`.
- `apps/matter/src/lib/where-filter.svelte.ts` - `createWhereFilter`, now per-tab.
- `apps/matter/src/lib/components/FolderGrid.svelte` - consumes `FolderGridVault`, unchanged.
- `apps/matter/src/routes/demo/` - the in-memory vault precedent (keep).
- `apps/matter/src/routes/+layout.ts` - `ssr = false`.
- `apps/matter/src-tauri/src/watch.rs` - confirms `watch_folder` takes an unrestricted absolute path (reopen-on-relaunch works).
- `specs/20260605T145734-matter-live-projection-lifecycle.md` - the reconcile/seed bench that makes re-seed-on-switch cheap.
- Skills: `svelte` (keyed-resource pattern), `sveltekit` (routing/load/adapter), `cohesive-clean-breaks` + `greenfield-clean-breaks` (the asymmetric-win review), `radical-options`, `collapse-pass`, `one-sentence-test`, `standalone-commits`, `git`.

---

## Handoff Prompt

Give the following to a fresh agent with enough time to grill before building. It is self-contained.

```txt
You are implementing multi-vault support for the Matter app (apps/matter) in the
epicenter monorepo. Read specs/20260606T163601-matter-multi-vault-routing.md in
full first; it is the source of truth. Work on a new branch
`matter-multi-vault-routing` off `matter-typed-markdown-editor`.

CONTEXT YOU INHERIT (do not redo):
- Matter is a Tauri + SvelteKit SPA (ssr = false, adapter-static). A "vault" is a
  live folder watcher (Rust `notify` + an IPC Channel + an in-memory SvelteMap).
- The vault core already exposes the exact seam this needs: createVault(path)
  self-watches on construction and exposes `whenReady` (Promise) + `dispose()`;
  `FolderGridVault` keeps the grid vault-agnostic; `createWhereFilter()` is a
  page-owned filter. These shipped in commits ba0d611a1..fdaeee480. Keep them
  unless your grilling proves a better seam.
- Today a `vaultSession` singleton holds ONE `current` vault. You are replacing it
  with the routing layer. The target is: URL = active vault (/vault/[id]),
  persisted {id,path,name}[] list = open tabs, route component = the live vault
  (construct on mount, dispose on destroy via {#key page.params.id}).

YOUR JOB IS TO GRILL FIRST, THEN BUILD. Spend real time here.
1. Before writing code, grill the design for the asymmetric win. Load and apply:
   grill-me / fresh-eyes-grill (stress the state machine and lifecycle),
   radical-options (is there an even smaller shape?), cohesive-clean-breaks and
   greenfield-clean-breaks (what 15% do we refuse to delete 85%?), one-sentence-test
   (can you still name it in one sentence after each change?), collapse-pass.
   Re-open the spec's Open Questions and resolve each with evidence or a logged
   Class-3 keep. If a sub-agent or a grill round finds a simpler shape than the
   route-owned + reload-on-switch default, take it and update the spec.
2. GROUND every SvelteKit routing claim against the docs before relying on it.
   Ask DeepWiki narrow questions against sveltejs/kit (and sveltejs/svelte for
   runes), and verify decisive details against the installed types/source. The
   spec lists the facts already grounded (adapter-static fallback; component reuse
   across params so {#key} is required; non-serializable resources go in the
   component not load(); goto; error(404)); re-verify anything you change and the
   exact `page`/params import for the installed kit version.
3. Honor the constraints that shape everything: a vault is a live resource and a
   URL is a string, so the URL holds an opaque id (not the raw path); the native
   folder dialog cannot be triggered from a URL, so opening is always a user
   action that mints an id and goto()s. Re-seed-on-switch is the default; do NOT
   add a global Map<id,Vault> registry unless a concrete feature demands background
   liveness (and then scope it + write the dispose policy).

EXECUTION DISCIPLINE:
- Build, Prove, Remove (spec Implementation Plan). Do not delete vaultSession until
  the new path is proven; rollback should be one revert.
- Standalone commits, conventional messages, no AI attribution, no em/en dashes.
  Stage specific files only (git add <paths>; never `git add .`). This worktree
  may have concurrent human edits: re-read ground truth before each edit and
  commit with explicit paths.
- Gates after each wave: `bun run typecheck`, `bun test`, and `cargo test` in
  apps/matter/src-tauri when Rust/ts-rs is touched. The watcher lifecycle is only
  truly verifiable under `bun tauri dev`: do the live smoke test in the spec's
  Success Criteria (two vaults, tab switch disposes old + seeds new, close,
  relaunch reopens, deleted folder -> catch, unknown id -> 404) and report it
  honestly as the real proof.
- When done, run a post-implementation-review pass and update the memory file
  project_typed_markdown_grid_editor with what shipped and what was deferred.

Deliver the asymmetric win: the URL is the active vault, a persisted string list
is the open vaults, and SvelteKit's router is the entire live-vault lifecycle.
If you cannot keep that one-sentence description true, stop and surface why.
```
