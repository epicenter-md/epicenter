# Rename `whenSynced` to `whenReady`

**Date**: 2026-02-13
**Status**: Complete
**Author**: AI-assisted

## Overview

Rename the `Lifecycle.whenSynced` property to `whenReady` across the codebase. The current name implies network synchronization, but the promise actually means "this thing is ready to use". That could be local persistence loaded, a database initialized, or just `Promise.resolve()` for extensions with no async work.

## Motivation

### Current State

The `Lifecycle` type in `packages/epicenter/src/shared/lifecycle.ts` defines the contract every extension and provider must satisfy:

```typescript
export type Lifecycle = {
	whenSynced: Promise<unknown>;
	destroy: () => MaybePromise<void>;
};
```

Every extension returns `whenSynced`. The workspace aggregates them:

```typescript
// create-workspace.ts
const whenSynced = Promise.all(
	Object.values(extensions).map((e) => (e as Lifecycle).whenSynced),
).then(() => {});
```

UI awaits the result as a render gate:

```typescript
// +layout.ts
const client = createWorkspaceClient(definition);
await client.whenSynced;
```

This creates problems:

1. **The name is misleading.** In `y-sweet-persist-sync.ts`, `whenSynced` resolves when local persistence loads. The WebSocket connects _after_ in the background. "Synced" implies network synchronization; the promise has nothing to do with that.

2. **The same name means different things.** In `y-sweet-connection.ts` (static workspace viewer), `whenSynced` resolves when the WebSocket connects. Actual network sync. Same name, different semantic.

3. **It conflicts with Yjs vocabulary.** Yjs core (`Y.Doc`) has its own `whenSynced` that specifically means "network provider has synced with backend." Our `whenSynced` usually means the opposite: local data is loaded, network hasn't happened yet.

### Desired State

```typescript
export type Lifecycle = {
	whenReady: Promise<unknown>;
	destroy: () => MaybePromise<void>;
};
```

```typescript
await client.whenReady;
```

One name, one meaning: "this thing is ready to use."

## Research Findings

### Yjs Core's Two-Phase Readiness System

Yjs (since 2021/2023) provides two distinct concepts on `Y.Doc`:

| Property         | Meaning                                | Event  | Boolean        |
| ---------------- | -------------------------------------- | ------ | -------------- |
| `doc.whenLoaded` | Persistence provider loaded local data | `load` | `doc.isLoaded` |
| `doc.whenSynced` | Network provider synced with backend   | `sync` | `doc.isSynced` |

Kevin Jahns (Yjs author) designed these as separate phases: local load first, network sync second. The `load` event is emitted by persistence providers when they finish reading from storage. The `sync` event fires when a connection provider completes synchronization. If `sync` fires before `load`, Yjs automatically emits `load` too.

**Key finding**: Yjs deliberately separates "loaded from persistence" from "synced with network." Our `Lifecycle.whenSynced` conflates the two.

### y-indexeddb's Naming Confusion

y-indexeddb exposes `.whenSynced` on its `IndexeddbPersistence` instance, but this resolves when data is loaded from IndexedDB. Not when anything is synced with a network. This is arguably a naming mistake in y-indexeddb itself. It predates Yjs core's `whenLoaded`/`whenSynced` distinction.

Our web persistence currently passes it through directly:

```typescript
// y-sweet-persist-sync/web.ts
return defineExports({
	whenSynced: idb.whenSynced, // y-indexeddb's "whenSynced" = local load
});
```

After the rename, this becomes an explicit adapter at the boundary:

```typescript
return defineExports({
	whenReady: idb.whenSynced, // Adapt y-indexeddb's name to our convention
});
```

This is actually clearer. It makes visible that y-indexeddb's concept and our concept are related but named differently.

### Why Not `whenLoaded`?

We considered aligning with Yjs's `whenLoaded` since most of our uses are persistence loading. Rejected because:

| Concern                                       | Explanation                                                                                                                                               |
| --------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Not all extensions "load"                     | A pure computation extension or one that returns `defineExports()` with no async work doesn't load anything. `whenLoaded: Promise.resolve()` reads oddly. |
| The workspace aggregate isn't a "load"        | `workspace.whenReady` means "all extensions are initialized." That's readiness, not loading.                                                              |
| Yjs's own naming is tangled                   | y-indexeddb calls local load `whenSynced`. Yjs core calls it `whenLoaded`. Aligning with one half of this confusion doesn't help.                         |
| `whenReady` is already precedented internally | `content-doc-store.ts` already uses `whenReady` for the same concept.                                                                                     |

### Y-Sweet Provider Resilience

Y-Sweet's `YSweetProvider` has built-in resilience that interacts well with `whenReady`:

| Behavior                       | Detail                                                             |
| ------------------------------ | ------------------------------------------------------------------ |
| Retry with exponential backoff | Reconnects automatically on failure                                |
| Token refresh                  | After 3 failed retries, refreshes auth token and retries           |
| Heartbeats                     | Sends sync status messages every 2s to detect dead connections     |
| Connection timeout             | Closes WebSocket after 3s without heartbeat response               |
| Browser online/offline events  | Resumes connection attempts when network comes back                |
| Status events                  | Emits `connecting`, `connected`, `error`, `handshaking`, `offline` |

The current `y-sweet-persist-sync.ts` extension already handles this correctly:

```typescript
const whenSynced = (async () => {
	const p = config.persistence({ ydoc });
	persistenceCleanup = p.destroy;
	await p.whenSynced;
	// WebSocket connects in background: don't await it.
	// Y-Sweet retries automatically. Status surfaced via provider events.
	provider.connect().catch(() => {});
})();
```

`whenReady` resolves when persistence loads (~10-20ms). The WebSocket is non-blocking. If the Y-Sweet server is down, `whenReady` still resolves. Y-Sweet retries in the background indefinitely. Connection status is reactive via `provider.on('connection-status', ...)`.

This is correct local-first behavior: show local data immediately, sync in the background, surface connection status reactively.

### Why `whenReady` Never Blocks Long (For Dynamic Workspaces)

Dynamic workspaces use the `ySweetPersistSync` extension (or will, once Y-Sweet sync is wired in). This extension orchestrates a two-phase startup inside a single `whenReady` promise:

```typescript
// y-sweet-persist-sync.ts
const whenReady = (async () => {
  await p.whenReady;              // Phase 1: local persistence load (~10-20ms)
  provider.connect().catch(…);    // Phase 2: WebSocket in background (non-blocking)
})();
```

`whenReady` resolves after Phase 1. The WebSocket is fire-and-forget. If the Y-Sweet server is down, unreachable, or slow, `whenReady` still resolves in milliseconds. Y-Sweet's provider handles retry with exponential backoff, token refresh, and heartbeats entirely in the background. Connection status is surfaced reactively via `provider.on('connection-status', ...)`.

This means `await workspace.whenReady` in a SvelteKit layout or Svelte `{#await}` block will never block the UI waiting for network. The user sees local data immediately; sync happens silently.

Currently, `createWorkspaceClient` (`apps/epicenter/src/lib/yjs/workspace.ts`) only wires up `workspacePersistence` (Tauri filesystem, no network sync). When Y-Sweet sync is added, the persistence-first pattern in `ySweetPersistSync` ensures `whenReady` stays fast.

### The 10-Second Timeout (Static Workspace Viewer Only)

The static workspace viewer (`workspaces/static/[id]/+layout.ts`) is a fundamentally different case. It uses `createYSweetConnection` directly. Raw WebSocket, no local persistence:

```typescript
const connection = createYSweetConnection({ workspaceId, serverUrl });
await Promise.race([
	connection.whenReady,
	new Promise((_, reject) =>
		setTimeout(() => reject(new Error('Sync timeout')), 10000),
	),
]);
```

Since there's no local data to load, the viewer _must_ wait for the WebSocket to get any data at all. The 10-second timeout is a consumer-level policy for this specific case. It's not a concern for the `whenReady` abstraction itself.

This distinction matters: the timeout exists because the static viewer lacks a persistence layer, not because `whenReady` is slow. If the static viewer ever gains local caching (e.g., IndexedDB), its `whenReady` would resolve fast too.

## Design Decisions

| Decision                            | Choice                   | Rationale                                                                                                                                                                                                                                                                                                  |
| ----------------------------------- | ------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Property name                       | `whenReady`              | Honest for all uses. Short. Already precedented in `content-doc-store.ts`.                                                                                                                                                                                                                                 |
| Diverge from Yjs naming             | Yes                      | Yjs's own naming is inconsistent (y-indexeddb `whenSynced` ≠ Y.Doc `whenSynced`). Our `Lifecycle` is broader than Yjs (covers SQLite, filesystem, KV). A clean name avoids inheriting their confusion.                                                                                                     |
| Keep single promise (no split)      | Yes                      | The resilient-client-architecture spec already decided: "We don't need separate `whenLoaded` vs `whenReady` promises. We just need to do things in the right order inside ONE promise." The composition happens inside extensions (e.g., y-sweet-persist-sync loads persistence, then connects WebSocket). |
| y-indexeddb adapter                 | Explicit boundary rename | `idb.whenSynced` → our `whenReady`. Makes the adaptation visible.                                                                                                                                                                                                                                          |
| No behavioral changes               | Rename only              | This is purely a naming change. No logic, no new features, no changed semantics.                                                                                                                                                                                                                           |
| `whenReady` never blocks on network | By design                | For dynamic workspaces, `ySweetPersistSync` resolves `whenReady` on local persistence load (~10-20ms), then connects WebSocket in background. The 10-second timeout only exists in the static workspace viewer which has no local persistence. A fundamentally different pattern.                           |

## Architecture

No architectural changes. The lifecycle flow remains:

```
Extension Factory (sync)
   │
   └─→ returns { whenReady, destroy, ...exports }
              │
              ▼
Workspace aggregates: Promise.all(extensions.map(e => e.whenReady))
              │
              ▼
Consumer awaits: await workspace.whenReady
              │
              ▼
UI renders
```

## Implementation Plan

### Phase 1: Core Type + Helper

- [x] **1.1** Rename `whenSynced` → `whenReady` in `Lifecycle` type (`packages/epicenter/src/shared/lifecycle.ts`)
- [x] **1.2** Update `defineExports()` default key and destructuring in same file
- [x] **1.3** Update all JSDoc referencing `whenSynced` in `lifecycle.ts`

### Phase 2: Extension + Provider Implementations

- [x] **2.1** `packages/epicenter/src/extensions/y-sweet-persist-sync.ts`
- [x] **2.2** `packages/epicenter/src/extensions/y-sweet-persist-sync/web.ts` (y-indexeddb adapter: `whenReady: idb.whenSynced`)
- [x] **2.3** `packages/epicenter/src/extensions/y-sweet-persist-sync/desktop.ts`
- [x] **2.4** `packages/epicenter/src/extensions/y-sweet-persist-sync.test.ts`
- [x] **2.5** `packages/epicenter/src/dynamic/workspace/create-workspace.ts` (aggregation)
- [x] **2.6** `packages/epicenter/src/dynamic/workspace/create-workspace.test.ts`
- [x] **2.7** `packages/epicenter/src/dynamic/workspace/types.ts`
- [x] **2.8** `packages/epicenter/src/dynamic/provider-types.ts`
- [x] **2.9** `packages/epicenter/src/dynamic/extension.ts`
- [x] **2.10** `packages/epicenter/src/filesystem/content-doc-store.ts` (already uses `whenReady` internally; update provider references)
- [x] **2.11** `packages/epicenter/src/filesystem/content-doc-store.test.ts`
- [x] **2.12** `packages/epicenter/src/static/types.ts`

### Phase 3: App Consumers

- [x] **3.1** `apps/epicenter/src/routes/(workspace)/workspaces/[id]/+layout.ts`
- [x] **3.2** `apps/epicenter/src/routes/(workspace)/workspaces/static/[id]/+layout.ts`
- [x] **3.3** `apps/epicenter/src/lib/yjs/workspace-persistence.ts`
- [x] **3.4** `apps/epicenter/src/lib/yjs/y-sweet-connection.ts`
- [x] **3.5** `apps/tab-manager/src/entrypoints/background.ts`

### Phase 4: Documentation + Specs

- [x] **4.1** Update `packages/epicenter/src/shared/lifecycle.ts` module-level JSDoc
- [x] **4.2** Update READMEs that reference `whenSynced` (workspace, dynamic, yjs, YDOC-ARCHITECTURE)
- [x] **4.3** Update `docs/articles/sync-construction-async-property-ui-render-gate-pattern.md`
- [x] **4.4** Update `docs/articles/sync-client-initialization.md`
- [x] **4.5** Historical specs left as-is (they document decisions at the time)
- [x] **4.6** Update `docs/articles/lazy-singleton-pattern.md`
- [x] **4.7** Update `docs/articles/archived-head-registry-patterns.md`
- [x] **4.8** Update `docs/articles/20260127T120000-static-workspace-api-guide.md`
- [x] **4.9** Update `docs/guides/yjs-persistence-guide.md` (our keys only; y-indexeddb right-side stays `whenSynced`)
- [x] **4.10** Update `docs/patterns/type-composition-across-platforms.md`
- [x] **4.11** Update `packages/epicenter/README.md`
- [x] **4.12** Update `packages/epicenter/src/static/define-workspace.test.ts`

### Phase 5: Verify

- [x] **5.1** `bun typecheck` passes (pre-existing errors in cli.test.ts and table-helper.ts unrelated to rename)
- [x] **5.2** `bun test` passes (811 pass, 0 fail)
- [x] **5.3** Grep for any remaining `whenSynced` in source files: only `web.ts:37` (`idb.whenSynced`, legitimate external API)

## Edge Cases

### y-indexeddb Boundary Adapter

After rename, the web persistence file becomes:

```typescript
return defineExports({
	whenReady: idb.whenSynced, // y-indexeddb's whenSynced = "data loaded from IndexedDB"
});
```

This is intentional. The comment documents the semantic mapping.

### Extensions With No Async Work

Extensions that return `defineExports()` or `defineExports({ helper })` without providing `whenReady` get `Promise.resolve()` as the default. This is correct: an extension with no async init is ready immediately.

### Static Workspace Timeout

The static layout's `Promise.race` with 10-second timeout continues to work identically. The only change is the property name.

### content-doc-store's Internal `whenReady`

`content-doc-store.ts` already uses `whenReady` as a local variable name for the same concept. After this rename, the local variable and the provider property name align, which is cleaner. No semantic change.

## Open Questions

1. **Should `y-sweet-connection.ts` use `whenReady` or should it use a different name?**
   - This is the one case where the promise means "WebSocket connected," not "local data loaded."
   - `whenReady` still works: the connection is "ready to use" when connected.
   - **Recommendation**: Use `whenReady`. The consumer (static layout) already wraps it with a timeout, so it's clearly understood as potentially slow.

2. **Should docs/articles be updated in this PR or separately?**
   - Updating docs is low-risk but makes the diff noisier.
   - **Recommendation**: Update articles in the same PR. They're closely tied to the API and stale docs are worse than a larger diff.

## Out of Scope / Follow-up

### Eliminate `createYSweetConnection` in favor of `ySweetPersistSync`

`apps/epicenter/src/lib/yjs/y-sweet-connection.ts` hand-rolls its own Y-Sweet lifecycle: manually creates a Y.Doc, a provider, and a `whenReady` promise using `Promise.withResolvers` + connection-status event listening. This duplicates what `ySweetPersistSync` already handles.

The static workspace viewer (`workspaces/static/[id]/+layout.ts`) is the sole consumer. It could use `ySweetPersistSync` directly:

```typescript
const ydoc = new Y.Doc({ guid: workspaceId });
const sync = ySweetPersistSync({
	auth: directAuth(syncUrl),
	persistence: indexeddbPersistence,
})({ ydoc });

await sync.whenReady;
```

This would:

1. Eliminate `createYSweetConnection` and `y-sweet-connection.ts` entirely
2. Give the static viewer IndexedDB caching for free (revisits load instantly from cache)
3. Remove the 10-second timeout concern (persistence loads fast; WebSocket syncs in background)
4. Unify both workspace types on the same `ySweetPersistSync` extension

`ySweetPersistSync`'s factory only destructures `{ ydoc }` from its context, so it works fine without a full `ExtensionContext`.

This is a behavioral change (adds IndexedDB caching, changes the lifecycle) and deserves its own spec or PR. Not included in the rename.

## Success Criteria

- [x] No remaining `whenSynced` in `.ts` source files (only `web.ts` with legitimate `idb.whenSynced`)
- [x] `bun typecheck` passes (pre-existing errors unrelated to rename)
- [x] `bun test` passes (811 pass, 0 fail)
- [ ] App builds successfully (`bun run build` in apps/epicenter): not run (Tauri build requires native toolchain)
- [x] y-indexeddb adapter has explicit comment documenting the name mapping
- [x] `docs/articles/sync-construction-async-property-ui-render-gate-pattern.md` updated

## References

- `packages/epicenter/src/shared/lifecycle.ts`: Source of truth for Lifecycle type
- `packages/epicenter/src/dynamic/workspace/create-workspace.ts`: Workspace aggregation
- `packages/epicenter/src/extensions/y-sweet-persist-sync.ts`: Primary extension showing persistence-first pattern
- `packages/epicenter/src/extensions/y-sweet-persist-sync/web.ts`: y-indexeddb adapter boundary
- `apps/epicenter/src/routes/(workspace)/workspaces/[id]/+layout.ts`: Dynamic workspace render gate
- `apps/epicenter/src/routes/(workspace)/workspaces/static/[id]/+layout.ts`: Static workspace with timeout
- `docs/articles/sync-construction-async-property-ui-render-gate-pattern.md`: Pattern documentation
- `docs/articles/sync-client-initialization.md`: Client initialization guide
- `specs/20260119T231252-resilient-client-architecture.md`: Prior decision to keep single promise

## Review

### Summary

Pure rename of `Lifecycle.whenSynced` → `whenReady` across 31 files. No behavioral changes. The rename resolves naming confusion with Yjs core's `whenSynced` (which means network sync): our promise means "ready to use" (usually local persistence loaded).

### Files Changed (31 files, ~160 lines changed)

**Core type + helper (1 file):**

- `packages/epicenter/src/shared/lifecycle.ts`: Lifecycle type, `defineExports()`, all JSDoc

**Extension implementations (5 files):**

- `packages/epicenter/src/extensions/y-sweet-persist-sync.ts`: Internal variable and return
- `packages/epicenter/src/extensions/y-sweet-persist-sync/web.ts`: Boundary adapter: `whenReady: idb.whenSynced`
- `packages/epicenter/src/extensions/y-sweet-persist-sync/desktop.ts`: Internal variable and return
- `packages/epicenter/src/extensions/y-sweet-persist-sync.test.ts`: Test assertions

**Workspace core (5 files):**

- `packages/epicenter/src/dynamic/workspace/create-workspace.ts`: `whenSyncedPromises` → `whenReadyPromises`, aggregation
- `packages/epicenter/src/dynamic/workspace/create-workspace.test.ts`: Test assertions
- `packages/epicenter/src/dynamic/workspace/types.ts`: Type definition
- `packages/epicenter/src/dynamic/provider-types.ts`: Provider type
- `packages/epicenter/src/dynamic/extension.ts`: Extension type

**Other packages (4 files):**

- `packages/epicenter/src/filesystem/content-doc-store.ts`: Provider references (also removed unused `defineExports` import)
- `packages/epicenter/src/filesystem/content-doc-store.test.ts`: Test assertions
- `packages/epicenter/src/static/types.ts`: Static workspace type
- `packages/epicenter/src/static/define-workspace.test.ts`: Test assertions

**App consumers (5 files):**

- `apps/epicenter/src/routes/(workspace)/workspaces/[id]/+layout.ts`: `await client.whenReady`
- `apps/epicenter/src/routes/(workspace)/workspaces/static/[id]/+layout.ts`: `connection.whenReady`
- `apps/epicenter/src/lib/yjs/workspace-persistence.ts`: Return type
- `apps/epicenter/src/lib/yjs/y-sweet-connection.ts`: Type, promise, return
- `apps/tab-manager/src/entrypoints/background.ts`: `await client.extensions.sync.whenReady`

**Documentation (11 files):**

- `packages/epicenter/README.md`: Client properties section
- `packages/epicenter/src/dynamic/YDOC-ARCHITECTURE.md`: Code example
- `packages/epicenter/src/dynamic/workspace/README.md`: Workspace docs
- `packages/epicenter/src/static/README.md`: Static workspace docs
- `apps/epicenter/src/lib/yjs/README.md`: Yjs module docs
- `docs/articles/sync-client-initialization.md`: Full article update (our refs only; y-indexeddb refs preserved)
- `docs/articles/sync-construction-async-property-ui-render-gate-pattern.md`: Pattern article (our refs only)
- `docs/articles/lazy-singleton-pattern.md`: Pattern article
- `docs/articles/archived-head-registry-patterns.md`: Archived article
- `docs/articles/20260127T120000-static-workspace-api-guide.md`: API guide
- `docs/guides/yjs-persistence-guide.md`: Persistence guide (our keys only; y-indexeddb RHS preserved)
- `docs/patterns/type-composition-across-platforms.md`: Pattern doc

### Key Decision: y-indexeddb Boundary

The adapter in `web.ts` now reads `whenReady: idb.whenSynced` with a comment explaining the semantic mapping. This makes visible that y-indexeddb's concept ("data loaded from IndexedDB") maps to our concept ("ready to use"), despite the naming difference in the external library.

### What Was NOT Changed

- **Historical specs**: Left as-is per spec guidelines ("they document decisions at the time")
- **y-indexeddb external API references**: `idb.whenSynced`, `persistence.whenSynced`, `provider.whenSynced` in docs that refer to the external library's API
- **No behavioral changes**: Pure rename, no logic changes

### Verification

- `bun test` in `packages/epicenter`: 811 pass, 0 fail
- `bun typecheck`: Pre-existing errors in `cli.test.ts` and `table-helper.ts` unrelated to this rename
- Grep `.ts` for `whenSynced`: Only `web.ts` line 37 (`idb.whenSynced`): legitimate external API reference
