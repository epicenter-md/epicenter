# Document Primitive Redesign: `defineDocument` as the Lower-Level Substrate

**Date**: 2026-04-19
**Status**: Superseded by follow-up: see addendum at the top of this file.
**Author**: AI-assisted (Braden + Claude)

## Addendum (post-landing)

The `defineDocument` / `openDocument` wrapper described below was **removed** shortly after landing. The real primitive is just `Y.Doc` + the `attach*` functions; wrapping Yjs's own constructor added no value and created an options-bag drift risk (every new `Y.Doc` option would need mirroring through `defineDocument`'s options).

Current API: construct `new Y.Doc({ guid, gc })` directly, call `attach*(ydoc, ...)`, dispose with `ydoc.destroy()`. `createWorkspace` builds on this directly. Per-row content docs (Fuji entries) use the same raw pattern.

See `.agents/skills/workspace-api/references/document-primitive.md` for the current guidance. The rest of this spec remains as a record of the design process and the motivating pyramid: `attach*` helpers, split readiness signals, no-framework `onUpdate`, component-owned lifecycle: all of which survived.

## Overview

Introduce a lower-level primitive: `defineDocument`: that owns Y.Doc lifecycle and nothing else. `createWorkspace` becomes sugar built on top of `defineDocument`, and its existing extensions become trivially-thin `(ctx) => attachX(ctx.ydoc, ...)` shims over the new `document` attach helpers. `.withDocument()` (the per-row subdoc declaration attached to a table) is **removed entirely**: per-row content docs become child `defineDocument`s opened by a small helper, with their closures free to reference the parent workspace's tables.

The pyramid:

```
            apps (fuji, whispering, opensidian, honeycrisp, …)
           /                                                  \
createWorkspace                                      standalone defineDocument
(.withExtension chain,                               (skills, per-row content,
 single Y.Doc scope)                                  settings split, …)
           \                                                  /
            packages/document
            (defineDocument, openDocument, attachX helpers)
                              │
                             yjs
```

Two layers, one primitive, zero hooks object:

```
┌────────────────────────────────────────────────────────────┐
│  packages/workspace: createWorkspace + .withExtension(*)  │  ← call sites unchanged
│  Builder chain accumulates (ctx) => attachX(ctx.ydoc, …)   │     (sans .withDocument)
│  factories. One scope (workspace Y.Doc). Single variant.   │
├────────────────────────────────────────────────────────────┤
│  packages/document: defineDocument + openDocument + attachX│  ← new package
│  Sync bootstrap closure. Cleanup via ydoc.on('destroy').   │
│  Attach helpers return typed atoms (whenLoaded,        │
│  whenConnected, reconnect, …). No precomposed readiness.   │
└────────────────────────────────────────────────────────────┘
```

## Chosen Strategy: A+B (Builder + Thin Shims)

Three shapes were considered for how `createWorkspace` should consume the new primitives:

| Strategy | Shape | Verdict |
|---|---|---|
| **A**: Explicit ctx arrows | `.withExtension('sync', (ctx) => attachSync(ctx.ydoc, {...}))` | **Chosen foundation.** Honest, typed, zero magic. Every `waitFor` dependency is a plain JS reference with IDE autocomplete. |
| **B**: Pre-baked factories wrapping A | `.withExtension('sync', websocketSync({url, getToken}))` where the factory returns a `(ctx) => attachSync(...)` closure internally. | **Convenience layer on top of A.** Same underlying types; fewer keystrokes at call sites. Existing apps get this for free: `indexeddbPersistence` and `createSyncExtension` become thin shims with unchanged external signatures. |
| **C**: Drop the builder; pass one bootstrap closure | `createWorkspace({ id, tables, bootstrap: (ydoc) => ({...}) })` | **Rejected.** Ergonomic edge over A collapsed once the three-variant foot-gun disappeared. Departs from the codebase's builder idiom (`.withActions`, `defineTable`, `defineKv`). Breaks cross-package extension composition. Migration cost not justified. |

Net: the builder chain stays. It just becomes one method (`.withExtension`) over one scope (the workspace Y.Doc), with extensions that are trivial closures over `document` attach helpers.

## Readiness Signals: Split, Don't Precompose

Earlier drafts returned a single `whenSynced` composed as `Promise.all([idb.whenSynced, sync.whenConnected])`. That's over-eager:

- `sync.whenConnected` is transport-level handshake, not CRDT convergence. Calling the composite `whenSynced` propagates `y-indexeddb`'s misnaming upward.
- Most callers (especially offline-first UIs) want "local data is loaded, edits are safe": waiting on the network is unnecessary and slows first paint.
- Precomposing hides which signal a caller actually depends on.

The rule: **each attach helper returns what it actually knows.** The bootstrap returns the atoms. Callers compose at the call site.

```ts
// attach helpers expose atoms
attachIndexedDb(ydoc)  →  { whenLoaded, clearLocal, disposed }
attachSync(ydoc, opts) →  { whenConnected, status, onStatusChange, reconnect, disposed }

// a doc returns atoms, not composites
return {
  content,
  whenLoaded: idb.whenLoaded,   // "my draft is loaded"
  whenConnected:  sync.whenConnected,   // "server reachable"
}

// callers pick the signal they actually need
await doc.whenLoaded           // offline-first render (typical UI)
await doc.whenConnected            // CLI that needs remote data
await Promise.all([...])           // strict "both" when it matters
```

If a convenience composite turns out to be common, it can be added later as an opt-in helper. Precomposing in the primitive is a one-way door; exposing atoms is not.

## Motivation

### The `.withDocument` XML smell

`.withDocument` was the *originating* complaint. Look at the real call site:

```ts
// apps/fuji/src/lib/workspace.ts:107-112
export const fuji = defineWorkspace({ id: 'epicenter.fuji', tables: { entries } })
  .withDocument('content', {
    content: richText,                                // 2nd "content"
    guid: 'id',
    onUpdate: () => ({ updatedAt: DateTimeString.now() }),
  })
```

Three things are wrong here, and they compound:

1. **Three unrelated uses of `"content"`**: the registration name, the field key in the config, and (hidden) `ydoc.getText('content')` inside `richText`'s strategy at `packages/workspace/src/workspace/strategies.ts:47`. Convention masquerading as configuration.
2. **`onUpdate` lives in doc config but mutates the row**. Inversion of control done backwards: the child doc shouldn't know that its updates ripple into a row on the parent.
3. **Nested declarative block inside the workspace builder**: the per-row doc is defined *inside a table, inside a workspace*, as an object literal, with its lifecycle implicitly tied to the enclosing `createWorkspace`. That shape is fine for XML. It's wrong for composable Yjs documents.

### The single-Y.Doc ceiling (real, not hypothetical)

`createWorkspace` allocates exactly one Y.Doc (`create-workspace.ts:131`). Real apps already work around this:

| App | Evidence |
|---|---|
| Opensidian | `apps/opensidian/src/lib/client.ts:203`: calls `createWorkspace` twice (opensidian + skills), duplicating extension wiring, because there is no shared-doc primitive. |
| Whispering | `apps/whispering/…/kv.ts:188`: comment explicitly says API keys/paths/hardware IDs stay in localStorage "because only preferences that roam live here." Translation: we want a separate settings doc but the API gives us one. |
| Filesystem | `packages/filesystem/src/table.ts:21-24`: markdown, sheets, and canvas data all flattened through a single `timeline` strategy. One doc per app means one content type per file. |

### The `.withExtension` × 3 variants foot-gun

Today there are three parallel methods (`create-workspace.ts:470-549`):

```ts
.withExtension(key, factory)            // workspace AND every doc
.withWorkspaceExtension(key, factory)   // workspace only
.withDocumentExtension(key, factory)    // docs only: literally unused in the repo
```

Users must read JSDoc to know which scope each covers. `.withDocumentExtension` is dead public API. This complexity exists only to thread extensions into `.withDocument`'s subdocs, which this redesign eliminates.

### Standalone external consumers

Yjs apps outside epicenter don't want `tables`, `kv`, or `awareness`. They want "I have a Y.Doc, compose providers against it with typed API and clean disposal." No such package exists in the ecosystem: SyncedStore is the closest public shape (a factory that takes a Y.Doc and returns a typed proxy), but it owns the data schema. `packages/document` fills that gap.

## The Primitive

### Shape

```ts
// packages/document

export function defineDocument<T>(
  id: string,
  bootstrap: (ydoc: Y.Doc) => T,
): DocumentDefinition<T>

export function openDocument<T>(
  def: DocumentDefinition<T>,
): T & { ydoc: Y.Doc; dispose: () => void }
```

That's the entire primitive. **One argument. Sync open, sync dispose.** No `ctx`, no `onDispose`, no providers array, no registry. Attach helpers register cleanup via the native `ydoc.on('destroy')` event. Those that have meaningful async teardown expose an opt-in `disposed: Promise<void>` in their return value: consumers who need strict ordering (tests, CLIs) compose these into a `whenDisposed` on the handle, symmetric with `whenSynced`.

### Why synchronous

An earlier draft made the bootstrap `async` so `await idb.whenSynced` could express ordering. That's wrong. It forces every consumer into top-level `await openDocument(...)`, which cascades through the module graph and wrecks test ergonomics.

The key insight: Y.Doc is usable immediately. Edits queue and merge when persistence hydrates. The real ordering concern is *sync shouldn't broadcast empty state before local loads*, that's a sync-layer concern, not a bootstrap-layer one. Push the `waitFor` into the helpers that care:

```ts
export const settingsDoc = defineDocument('fuji.settings', (ydoc) => {
  const kv   = attachKv(ydoc, schema)
  const idb  = attachIndexedDb(ydoc)
  const sync = attachSync(ydoc, { url, getToken, waitFor: idb.whenLoaded })
  return {
    kv,
    whenLoaded: idb.whenLoaded,
    whenConnected:  sync.whenConnected,
  }
})

export const settings = openDocument(settingsDoc)       // SYNC, no top-level await
settings.kv.apiKey.set('sk-...')                        // usable immediately
await settings.whenLoaded                           // typical UI path
// or: await settings.whenConnected                     // CLI path
```

The handle is a plain synchronous value: trivially mockable in tests, no top-level-await propagation, errors caught by ordinary `try/catch`. Ordering is still visible in code: `sync` names `idb.whenSynced` as its dependency.

### No registry

The spec's earlier "Open Questions" worried about two `openDocument(def)` calls hitting the same id concurrently. ES module caching already handles this:

```ts
// packages/skills/src/doc.ts
export const skills = openDocument(skillsDoc)
//           ^^^^^^ evaluated once per module graph

// Anywhere else:
import { skills } from '@epicenter/skills'
skills.tables.skills.set({ ... })
```

Evaluating `openDocument` at module scope, not at component scope: makes singleton behavior a consequence of the import graph, not a framework primitive. Dev-time HMR or misuse can be surfaced with a `console.warn` when a guid is reused, but there's no ref-counted registry inside `openDocument`. Users who genuinely want multiple instances of the same logical doc (rare) can call it multiple times.

### No `attachChildDocs` helper

Per-row content docs are just `DocumentDefinition`s returned from a factory function. No framework observer on the parent table, no caching policy, no lifecycle machinery:

```ts
// apps/fuji/src/lib/entry-content-doc.ts
export function entryContentDoc(rowId: string) {
  return defineDocument(`fuji.entries.${rowId}.content`, (ydoc) => {
    const content = attachRichText(ydoc)
    const idb     = attachIndexedDb(ydoc)
    const sync    = attachSync(ydoc, { url, getToken, waitFor: idb.whenLoaded })

    ydoc.on('update', () => {
      workspace.tables.entries.update(rowId, { updatedAt: DateTimeString.now() })
    })

    return {
      content,
      whenLoaded: idb.whenLoaded,
      whenConnected:  sync.whenConnected,
    }
  })
}
```

Component owns the lifecycle:

```svelte
<!-- Editor.svelte -->
<script lang="ts">
  let { row } = $props<{ row: Entry }>()
  let doc: ReturnType<typeof openDocument<...>> | null = $state(null)

  $effect(() => {
    doc = openDocument(entryContentDoc(row.id))
    return () => doc?.dispose()
  })
</script>

{#if doc}
  <RichEditor binding={doc.content.binding} />
{/if}
```

Concurrent tabs editing the same entry reconcile at the Yjs layer via IndexedDB + sync, no JS-side deduplication needed. Apps that want cross-component caching or close-on-row-delete write it themselves in ~10 lines (a `Map<id, handle>` with a `table.onDelete` subscription). It's not framework scope.

### Why no hooks, not even `onDispose`

An earlier draft had `hooks: { onReady, onDispose, onUpdate }` as a second bootstrap argument. A later draft collapsed this to a `ctx` object carrying just `onDispose`. This draft removes `ctx` entirely.

The four concerns that motivated `ctx.onDispose` over `ydoc.on('destroy')`, honestly re-examined:

| Concern | Verdict |
|---|---|
| **Async cleanup lost to fire-and-forget.** `idb.destroy()` returns a Promise. | *Narrow.* Browser tab close → OS reaps everything; async loss only matters in tests (leak between runs) and CLIs (`process.exit` races IDB). Solvable without a framework-level cascade: the helper returns an opt-in `disposed: Promise<void>`. |
| **LIFO ordering.** | *Fabricated.* Yjs providers don't depend on each other at teardown. No concrete scenario where FIFO vs LIFO changes correctness for this codebase. |
| **Error visibility.** Sync throws in destroy listeners. | *Real but narrow, solvable inside the helper.* Each helper wraps its async destroy work in try/catch. |
| **Codebase consistency with `{ dispose }` everywhere.** | *Weak.* That pattern lives at the extension-builder layer, not a new primitive's. Internal consistency is what matters; `ydoc.on('destroy')` is self-consistent. |

And the cost of `ctx.onDispose`: every attach helper gains a second parameter, the bootstrap gains a second parameter, and we've added a one-field "context" object reserved for features that may never arrive. Speculative ceremony.

Conclusion: attach helpers use `ydoc.on('destroy', …)` directly, exactly as the native mechanism intends. Those with meaningful async teardown expose a `disposed` promise in their return value. The bootstrap composes `whenSynced` and (optionally) `whenDisposed` the same way it composes every other cross-cutting concern: plain JS in user code.

```ts
const settingsDoc = defineDocument('fuji.settings', (ydoc) => {
  const kv   = attachKv(ydoc, schema)
  const idb  = attachIndexedDb(ydoc)       // returns { whenLoaded, clearLocal, disposed }
  const sync = attachSync(ydoc, { url, getToken, waitFor: idb.whenLoaded })
  return {
    kv,
    whenLoaded: idb.whenLoaded,
    whenConnected:  sync.whenConnected,
    whenDisposed:   Promise.all([idb.disposed, sync.disposed]).then(() => {}),
  }
})

// Browser usage: no one cares about the disposed cascade:
const settings = openDocument(settingsDoc)
settings.dispose()                     // done

// Test usage: strict cleanup between cases:
settings.dispose()
await settings.whenDisposed
```

The two other originally-proposed hooks remain rejected:

| Hook | Native thing that's already better |
|---|---|
| `onReady(fn)` | `await` on a returned `whenLoaded` / `whenConnected` promise. |
| `onUpdate(fn)` | `ydoc.on('update', fn)`. Destroy auto-cleans Y.Doc's own listeners. |

### Internals of `openDocument`

```ts
export function openDocument<T>(def: DocumentDefinition<T>) {
  const ydoc = new Y.Doc({ guid: def.id, gc: false })
  try {
    const api = def.bootstrap(ydoc)
    return Object.assign(api, { ydoc, dispose: () => ydoc.destroy() })
  } catch (err) {
    ydoc.destroy()     // fires 'destroy' so whatever registered first cleans up
    throw err
  }
}
```

That's it. Under ten lines. Synchronous, error-safe, no machinery beyond what Y.Doc already provides.

Attach helpers use the native `ydoc.on('destroy')` event. Those with async teardown expose an opt-in `disposed` promise for consumers who need to await cleanup (tests, CLIs):

```ts
export function attachIndexedDb(ydoc: Y.Doc) {
  const idb = new IndexeddbPersistence(ydoc.guid, ydoc)
  const { promise: disposed, resolve } = Promise.withResolvers<void>()
  ydoc.once('destroy', async () => {
    try { await idb.destroy() } finally { resolve() }
  })
  return {
    whenSynced: idb.whenSynced,        // local data loaded
    clearLocal: () => idb.clearData(),
    disposed,                          // opt-in await for strict shutdown
  }
}

export function attachSync(ydoc: Y.Doc, opts: {
  url: (docId: string) => string
  getToken?: (docId: string) => Promise<string | null>
  waitFor?: Promise<unknown>           // gate first connect on e.g. idb.whenSynced
}) {
  // ...supervisor loop from existing extensions/sync/websocket.ts, with:
  //   - `await opts.waitFor` before the first connect attempt
  //   - `ydoc.once('destroy', async () => { ...teardown; resolveDisposed(); })`
  return {
    whenConnected,                     // handshake + first sync exchange
    status,
    onStatusChange,
    reconnect,
    disposed,
  }
}
```

Two shapes worth noticing. `waitFor` is *optional*: docs without persistence can skip it and connect immediately (rare, but useful for ephemeral awareness-only docs). And the helper exposes `whenConnected`, not `whenSynced`: transport-level handshake, not CRDT convergence.

```ts
return {
  kv,
  whenLoaded: idb.whenLoaded,
  whenConnected:  sync.whenConnected,
}
```

Each helper returns what it actually knows. The doc exposes those atoms. Callers compose at the call site when they genuinely need "both" (most don't).

Y.Doc's `'destroy'` event fires LIFO naturally in V8 (listener list, pushed in registration order, iterated in insertion order. But `attachIndexedDb` runs before `attachSync` so sync destroys first if registered last). If strict LIFO becomes important later, `openDocument` can maintain its own destroy list. For now, registration-order destruction is sufficient.

## Call Sites

### Single-doc app: `createWorkspace` is UNCHANGED

This is the 90% case. If your app fits in one Y.Doc, nothing about your call site changes:

```ts
// apps/fuji/src/lib/workspace.ts: SAME AS TODAY (no .withDocument though)
export const fuji = defineWorkspace({ id: 'epicenter.fuji', tables: { entries } })

// apps/fuji/src/lib/client.ts: SAME AS TODAY
export const workspace = createWorkspace(fuji)
  .withExtension('persistence', indexeddbPersistence)
  .withExtension('sync', createSyncExtension({ url, getToken: () => auth.token }))
  .withActions((client) => ({
    createEntry: defineMutation({ ... }),
  }))
```

Progressive extension typing preserved. Actions work exactly the same. The only thing missing from today's call site is `.withDocument('content', { content: richText, ... })`: and that's deliberate. Per-row content docs are now handled below.

### Per-row content doc: replacing `.withDocument`

This is the change you feel at the call site. `.withDocument` is gone. The per-entry rich-text document is a factory function that returns a `DocumentDefinition`. The editor component opens it on mount, disposes on unmount.

```ts
// apps/fuji/src/lib/entry-content-doc.ts: new file
import { APP_URLS } from '@epicenter/constants/vite'
import { DateTimeString } from '@epicenter/workspace'
import {
  attachIndexedDb,
  attachRichText,
  attachSync,
  defineDocument,
  websocketUrl,
} from '@epicenter/document'
import { auth, workspace } from './client'

export function entryContentDoc(rowId: string) {
  return defineDocument(`epicenter.fuji.entries.${rowId}.content`, (ydoc) => {
    const content = attachRichText(ydoc)

    const idb  = attachIndexedDb(ydoc)
    const sync = attachSync(ydoc, {
      url: (id) => websocketUrl(`${APP_URLS.API}/docs/${id}`),
      getToken: async () => auth.token,
      waitFor: idb.whenSynced,      // connect only after local state hydrates
    })

    // Bump the parent row's updatedAt on every edit. Plain closure, no framework
    // between this listener and workspace.tables.entries. Y.Doc.destroy() clears
    // its own listeners, so no explicit off() needed.
    ydoc.on('update', () => {
      workspace.tables.entries.update(rowId, { updatedAt: DateTimeString.now() })
    })

    return {
      content,
      whenSynced:   Promise.all([idb.whenSynced, sync.whenConnected]).then(() => {}),
      whenDisposed: Promise.all([idb.disposed,   sync.disposed     ]).then(() => {}),
    }
  })
}
```

```svelte
<!-- apps/fuji/src/lib/components/Editor.svelte -->
<script lang="ts">
  import { openDocument } from '@epicenter/document'
  import { entryContentDoc } from '$lib/entry-content-doc'

  let { row } = $props<{ row: { id: string } }>()
  let doc = $state<ReturnType<typeof openDocument<ReturnType<typeof entryContentDoc>['bootstrap']>> | null>(null)

  $effect(() => {
    doc = openDocument(entryContentDoc(row.id))
    return () => doc?.dispose()
  })
</script>

{#if doc}
  <RichEditor binding={doc.content.binding} />
{/if}
```

Four wins over `.withDocument`:

1. **One naming of `"content"`**: it's a variable name bound from `attachRichText(ydoc)`, not a registration key colliding with a field key colliding with a Yjs type key.
2. **The row-touch is a plain closure**: `workspace.tables.entries.update(rowId, ...)` reads as what it does, no inversion-of-control about "returning a partial row from an `onUpdate` hook."
3. **Per-row doc extensions are regular attach calls**: each content doc has its own idb, its own sync, its own awareness if it wants. Nothing inherited implicitly from the workspace.
4. **The component owns the lifecycle**: `$effect` mounts the doc, returns a disposer. No framework observer on the parent table, no cache policy to tune, no `attachChildDocs` to learn. Concurrent editors for the same row reconcile at the Yjs layer, which is what Yjs is for.

### Multi-doc app: whispering's settings/recordings split

This is the case `createWorkspace` cannot express. Drop to `defineDocument` directly:

```ts
// apps/whispering/src/lib/docs.ts
import {
  attachIndexedDb,
  attachKv,
  attachSync,
  attachTable,
  defineDocument,
  openDocument,
} from '@epicenter/document'

const settingsDoc = defineDocument('epicenter.whispering.settings', (ydoc) => {
  const kv   = attachKv(ydoc, settingsSchema)
  const idb  = attachIndexedDb(ydoc)
  const sync = attachSync(ydoc, { url, getToken, waitFor: idb.whenLoaded })
  return {
    kv,
    reconnect: sync.reconnect,
    clearLocal: idb.clearLocal,
    whenLoaded: idb.whenLoaded,
    whenConnected:  sync.whenConnected,
  }
})

const recordingsDoc = defineDocument('epicenter.whispering.recordings', (ydoc) => {
  const tables = { recordings: attachTable(ydoc, recordingsSchema) }
  const idb    = attachIndexedDb(ydoc)
  const sync   = attachSync(ydoc, { url, getToken, waitFor: idb.whenLoaded })
  return {
    tables,
    reconnect: sync.reconnect,
    clearLocal: idb.clearLocal,
    whenLoaded: idb.whenLoaded,
    whenConnected:  sync.whenConnected,
  }
})

// Module-scope singletons: no top-level await, no registry needed.
export const settings   = openDocument(settingsDoc)
export const recordings = openDocument(recordingsDoc)

// Usable immediately:
settings.kv.apiKey.set('sk-...')
recordings.tables.recordings.set({ id, title, blob })

// Opt-in readiness:
await settings.whenLoaded
```

The localStorage-for-roamable-settings hack (`apps/whispering/…/kv.ts:188`) goes away. API keys and hardware IDs live in `settingsDoc`, which syncs.

### Cross-app shared doc: opensidian's skills collapse

Define the doc and open it once in the shared package. Apps import the open handle, not the definition:

```ts
// packages/skills/src/doc.ts
function skillsDocFor(config: { url: (id: string) => string; getToken: () => Promise<string | null> }) {
  return defineDocument('epicenter.skills', (ydoc) => {
    const tables = { skills: attachTable(ydoc, skillsSchema) }
    const idb    = attachIndexedDb(ydoc)
    const sync   = attachSync(ydoc, { ...config, waitFor: idb.whenLoaded })
    return {
      tables,
      whenLoaded: idb.whenLoaded,
      whenConnected:  sync.whenConnected,
    }
  })
}

// Each consuming app opens it once at module scope with its own auth config.
// apps/opensidian/src/lib/skills.ts
export const skills = openDocument(skillsDocFor({
  url: (id) => `${APP_URLS.API}/docs/${id}`.replace(/^http/, 'ws'),
  getToken: async () => auth.token,
}))

// apps/opensidian/src/lib/client.ts: replaces the double-createWorkspace at line 203
export const workspace = createWorkspace(opensidianDef)
  .withExtension('persistence', indexeddbPersistence)
  .withExtension('sync', createSyncExtension({ url, getToken }))

// Usage anywhere:
import { skills } from '$lib/skills'
skills.tables.skills.set({ ... })
```

Factory-returns-definition is the pattern for shared docs that need per-app config. The definition itself is pure; the open handle is what gets imported and reused across modules within one app.

### Standalone external consumer

For a Yjs app that doesn't want tables/KV at all:

```ts
import { defineDocument, openDocument } from '@epicenter/document'

const counterDoc = defineDocument('my-counter', (ydoc) => {
  const state = ydoc.getMap<number>('state')
  ydoc.on('update', () => console.log('count is now', state.get('n')))
  return {
    get: () => state.get('n') ?? 0,
    inc: () => state.set('n', (state.get('n') ?? 0) + 1),
  }
})

const counter = openDocument(counterDoc)
counter.inc()               // "count is now 1"
counter.dispose()
```

This is what SyncedStore ships. But with explicit lifecycle and no schema coupling. No one in the public ecosystem ships this shape.

## How `createWorkspace` Builds on `defineDocument`

The existing builder chain stays. Internally, `createWorkspace(def)` is a thin wrapper that produces a `defineDocument` under the hood, and every extension factory becomes a trivially-thin closure over an attach helper from `document`.

### Internal shape

```ts
// packages/workspace/src/workspace/create-workspace.ts: internal sketch
export function createWorkspace<T extends WorkspaceDefinition>(def: T) {
  const docDef = defineDocument(def.id, (ydoc) => {
    const tables    = attachTable(ydoc, def.tables)       // from @epicenter/document
    const kv        = attachKv(ydoc, def.kv)
    const awareness = attachAwareness(ydoc, def.awareness)
    return { tables, kv, awareness }
  })

  return createBuilder(docDef)  // returns today's WorkspaceClientBuilder
}

// .withExtension('key', factory) where factory: (ctx) => attachment
//   1. Extends the underlying bootstrap to also run factory(ctx) after priors
//   2. Merges the factory's return value into the handle under `key`
//   3. Threads the key+return type through the chain for progressive ctx typing
```

### External shape (extensions as thin shims)

Existing extension factories become one-line closures over `document` attach helpers. External signatures stay identical: existing apps compile unchanged.

```ts
// packages/workspace/src/extensions/persistence/indexeddb.ts: after
import { attachIndexedDb } from '@epicenter/document'
export function indexeddbPersistence({ ydoc }: SharedExtensionContext) {
  return attachIndexedDb(ydoc)
}

// packages/workspace/src/extensions/sync/websocket.ts: after
import { attachSync } from '@epicenter/document'
export function createSyncExtension(config: SyncExtensionConfig) {
  return (ctx: SharedExtensionContext) =>
    attachSync(ctx.ydoc, {
      ...config,
      awareness: ctx.awareness.raw,
      waitFor:   ctx.whenReady,          // chain onto priors (persistence first)
    })
}
```

At the call site, nothing changes:

```ts
export const workspace = createWorkspace(fuji)
  .withExtension('persistence', indexeddbPersistence)
  .withExtension('sync', createSyncExtension({ url, getToken }))
  .withActions((client) => ({ … }))
```

### What this unlocks

- **Zero API surface change for existing apps.** `.withExtension`, `.withActions`, `defineTable`, `defineKv`, `defineAwareness` all keep working identically. The three-variant foot-gun collapses to a single `.withExtension` once `.withDocument`/`.withDocumentExtension` are gone: same method name, one scope, less to document.
- **Progressive extension typing preserved** because the builder's type parameters accumulate across calls exactly as today. `ctx.persistence.whenLoaded` becomes typed autocomplete in the `sync` factory.
- **Encryption, `clearLocalData`, `applyEncryptionKeys`** stay in the builder layer: they're cross-cutting concerns over the encrypted store set, not Y.Doc lifecycle.
- **Per-row content docs** are no longer entangled in the builder. They're separate `defineDocument` calls opened by the editor component. Extension wiring for them is local to each content doc, not inherited implicitly from the workspace.

## What Gets Deleted

| Surface | Status | Reason |
|---|---|---|
| `.withDocument(name, { content, guid, onUpdate })` | **Deleted** | Replaced by separate `defineDocument` + `attachChildDocs` helper. |
| `DocumentConfig`, `DocumentContext` types | **Deleted** | No in-builder doc configs anymore. |
| `create-documents.ts` per-row subdoc manager | **Deleted** (logic ports to `attachChildDocs` helper) | Becomes a userland helper consuming `openDocument`. |
| `ContentStrategy` / `Handle` vocabulary | **Deleted** | Each strategy becomes a thin `attachX(ydoc)` function (`attachRichText`, `attachPlainText`, `attachTimeline`). The hardcoded `ydoc.getText('content')` becomes configurable. |
| `.withDocumentExtension` | **Deleted** | Unused. Doc extensions are now just attach calls inside a doc's bootstrap. |

## What Stays

| Surface | Status |
|---|---|
| `createWorkspace(def)` | Unchanged at call site. Internally wraps `defineDocument`. |
| `.withExtension(key, factory)` | Unchanged. Progressive context typing preserved. |
| `.withWorkspaceExtension(key, factory)` | Unchanged (tolerated until Phase 3 consolidation). |
| `.withActions(factory)` | Unchanged. |
| `defineWorkspace`, `defineTable`, `defineKv`, `defineAwareness` | Unchanged schema builders. |
| Encryption, `applyEncryptionKeys`, `clearLocalData` | Unchanged. Live in the builder layer. |
| All six apps' existing workspace call sites | Unchanged, except removing `.withDocument` in Phase 2. |

## Architecture Diagrams

### Layer split

```
┌──────────────────────────────────────────────────────────────┐
│ packages/workspace                                           │
│ ──────────────────────────────────────────────────────────── │
│ createWorkspace(def)                                         │
│   .withExtension(k, f)      ← unchanged                      │
│   .withActions(f)           ← unchanged                      │
│                                                              │
│ defineWorkspace / defineTable / defineKv / defineAwareness   │
│                                                              │
│ attachChildDocs(parentTable, rowFactory)  ← replaces         │
│                                              .withDocument   │
│                                                              │
│ Encryption, clearLocalData, applyEncryptionKeys              │
└──────────────────────────────────────────────────────────────┘
                             │
                             │  builds on
                             ▼
┌──────────────────────────────────────────────────────────────┐
│ packages/document (NEW, standalone)                           │
│ ──────────────────────────────────────────────────────────── │
│ defineDocument(id, async (ydoc) => T): DocumentDefinition<T> │
│ openDocument(def): Promise<T & { ydoc, dispose }>            │
│                                                              │
│ attach helpers: attachTable, attachKv, attachAwareness,      │
│                 attachIndexedDb, attachSync, attachSqlite,   │
│                 attachBroadcastChannel, attachRichText,      │
│                 attachPlainText, attachTimeline              │
│                                                              │
│ Each attach helper:                                          │
│   - sync function: (ydoc, opts) => api                       │
│   - registers ydoc.on('destroy') internally                  │
│   - exposes whenSynced / clearLocal / reconnect as needed    │
└──────────────────────────────────────────────────────────────┘
                             │
                             │  uses
                             ▼
┌──────────────────────────────────────────────────────────────┐
│ yjs (Y.Doc, Y.Map, Y.Text, Y.XmlFragment)                    │
│ Y.Doc emits 'destroy' event. This is the cleanup primitive. │
└──────────────────────────────────────────────────────────────┘
```

### Lifecycle flow

```
STEP 1: defineDocument(id, bootstrap)
        Returns inert { id, bootstrap }. No Y.Doc allocated. Reusable.

STEP 2: openDocument(def)
        1. ydoc = new Y.Doc({ guid: def.id, gc: false })
        2. api = await def.bootstrap(ydoc)
             Source: User's async function runs linearly
             Source: Each attach helper registers its cleanup on ydoc.on('destroy')
             Source: User awaits whenSynced / other readiness signals explicitly
        3. return { ...api, ydoc, dispose }

STEP 3: Consumer uses the API
        counter.inc()
        workspace.tables.entries.set({...})
        settings.kv.apiKey.set('sk-...')

STEP 4: Consumer calls dispose (or the library unmounts)
        ydoc.destroy()
          → fires 'destroy' event
          → every attach helper's cleanup runs
          → providers disconnect, persistence flushes, awareness destroys
```

## Implementation Plan

### Phase 1: Ship the primitive

- [ ] **1.1** Create `packages/document` with `defineDocument`, `openDocument`: under 50 lines of production code.
- [ ] **1.2** Extract `attachTable(ydoc, schema)` from `create-workspace.ts:138-147`.
- [ ] **1.3** Extract `attachKv(ydoc, schema)` from `create-workspace.ts:150-152`.
- [ ] **1.4** Extract `attachAwareness(ydoc, schema)` from `create-awareness.ts`.
- [ ] **1.5** Port `attachIndexedDb(ydoc)` from `extensions/persistence/indexeddb.ts`.
- [ ] **1.6** Port `attachSync(ydoc, opts)` from `extensions/sync/websocket.ts`.
- [ ] **1.7** Port `attachBroadcastChannel(ydoc, opts)`.
- [ ] **1.8** Port `attachRichText`, `attachPlainText`, `attachTimeline` from `strategies.ts`: each ~10 lines, with configurable Y.Doc key instead of hardcoded `'content'`.
- [ ] **1.9** Unit tests: lifecycle ordering, destroy fan-out, error propagation.

### Phase 2: Kill `.withDocument` without breaking apps

- [ ] **2.1** Implement `attachChildDocs(parentTable, rowFactory)` helper in `packages/workspace`, built on top of `openDocument`.
- [ ] **2.2** Internal: rewrite `createWorkspace` to construct a `defineDocument` under the hood. All existing builder methods (`.withExtension`, `.withActions`, etc.) preserved. Verify no call-site changes required.
- [ ] **2.3** Migrate fuji off `.withDocument('content', ...)` to `attachChildDocs(workspace.tables.entries, entryContentDoc)`.
- [ ] **2.4** Migrate honeycrisp similarly.
- [ ] **2.5** Migrate filesystem: this unlocks real multi-type support (markdown vs sheet vs canvas), since each row can open a differently-typed content doc.
- [ ] **2.6** Delete `.withDocument`, `DocumentConfig`, `DocumentContext`, `create-documents.ts`.
- [ ] **2.7** Delete `.withDocumentExtension` (unused today).

### Phase 3: Unlock multi-doc and shared docs

- [ ] **3.1** Migrate opensidian: `skills` moves to `openDocument(skillsDoc)` in `packages/skills`; opensidian opens it alongside its workspace.
- [ ] **3.2** Migrate whispering: split into `settingsDoc` + `recordingsDoc`. Remove the localStorage-for-roamable-preferences hack.
- [ ] **3.3** Evaluate `tab-manager`: does `sourceDeviceId` want to become a shared `deviceIdentityDoc`?
- [ ] **3.4** Document the three consumption patterns (single-doc workspace, multi-doc split, cross-app shared).

### Phase 4: Cleanup

- [ ] **4.1** Consider consolidating `.withWorkspaceExtension` into `.withExtension` (now that scope is unambiguous: there's only the workspace Y.Doc to target).
- [ ] **4.2** Ship `packages/document` as a standalone npm package for external consumers.
- [ ] **4.3** Write migration guide documenting the `.withDocument` → `attachChildDocs` path.

## Edge Cases

### Sync must await persistence

```ts
const idb = attachIndexedDb(ydoc)
const sync = attachSync(ydoc, { ..., waitFor: idb.whenLoaded })
```

`waitFor` on `attachSync` is the typed, visible way to express this ordering. The alternative: `await idb.whenLoaded` mid-bootstrap: would force the bootstrap async; keeping the bootstrap synchronous and pushing the wait into the helper is simpler and more mockable. Forgetting `waitFor` means sync connects before local hydrates: visible in code review, impossible to hide behind a framework hook.

### Dispose during async hydration

`openDocument` is awaited before the caller gets a handle. If the caller wants to abort a still-hydrating doc, they need an `AbortSignal`. Defer: wrap `openDocument` in caller-side `Promise.race` if you actually need this. Y.Doc's own lifecycle has no concept of "cancel mid-hydrate" so punting here matches the underlying primitive.

### Cross-app shared doc with diverging schemas

App A ships `skillsDoc` v1. App B upgrades to v2. Both open `epicenter.skills`. Yjs cannot merge incompatible shared-type shapes safely. Schema migrations must be version-gated. This is the same problem the current `defineTable.migrate(...)` pattern solves, and it applies unchanged.

### User forgets to register cleanup in a bootstrap

Bootstrap creates `new Awareness(ydoc)` but doesn't register `ydoc.on('destroy', () => awareness.destroy())`. Memory leak on dispose. Mitigation: use the `attachAwareness(ydoc, schema)` helper, which registers cleanup. No framework enforcement: relies on consistent use of attach helpers over raw construction.

### Per-row content doc leak on row delete

`attachChildDocs` observes the parent table's rows. On row delete, it must close the corresponding child doc. This is non-trivial (existing logic lives in `create-documents.ts:onRowDelete`). The port must preserve it, not simplify it.

### Cross-app shared doc provider config divergence

Opensidian and whispering both open `skillsDoc`. If `skillsDoc` hardcodes `url` and `getToken` in its bootstrap, both apps are locked to one config. Fix: accept config as a parameter to a factory that *returns* a `DocumentDefinition`, not the definition itself:

```ts
export function createSkillsDoc(config: { url: string; getToken: () => Promise<string> }) {
  return defineDocument('epicenter.skills', (ydoc) => {
    const tables = { skills: attachTable(ydoc, skillsSchema) }
    const idb    = attachIndexedDb(ydoc)
    const sync   = attachSync(ydoc, { ...config, waitFor: idb.whenLoaded })
    return { tables, idb, sync }
  })
}

// apps/opensidian:
export const skills = openDocument(createSkillsDoc({ url, getToken }))
```

Shared docs that need per-app configuration become factories. This is a convention, not a primitive change.

## Design Decisions

| Decision | Choice | Rationale |
|---|---|---|
| Substrate primitive | `defineDocument(id, (ydoc) => T)` | Sync closure; typed API returned; ordering expressed via `waitFor` on helpers. |
| Lifecycle mechanism | `ydoc.on('destroy', fn)` | Native Y.Doc event. No hooks object, no registry, no reinvention. |
| Bootstrap sync or async | **Sync** | Avoids top-level-await propagation. Y.Doc is usable immediately; ordering goes into helpers' `waitFor` param. |
| Readiness signal shape | **Split atoms (`whenLoaded` + `whenConnected`)** | Precomposing `whenSynced` conflates transport and CRDT convergence; hides what callers actually depend on. |
| Extension composition | **Strategy A+B (builder + thin shims)** | Builder chain stays; factories become `(ctx) => attachX(ctx.ydoc, …)`. Strategy C (drop the builder) rejected: marginal ergonomic gain didn't justify departing from codebase idiom or breaking cross-package composition. |
| Hooks object | **Rejected** | Every hook was wrapping a native Y.Doc mechanism. Removing it removes a concept. |
| Providers array | **Rejected** | Attach helpers are just function calls. No array to index, no names to collide. |
| `createWorkspace` at call sites | **Unchanged** | Sugar for the 90% case. Progressive extension typing preserved via existing builder type machinery. |
| `createWorkspace` internals | Wraps `defineDocument` | Two layers, one source of truth for Y.Doc lifecycle. |
| `.withDocument` | **Deleted entirely** | Replaced by separate `defineDocument` + `attachChildDocs` helper. Closure references parent directly. |
| `.withDocumentExtension` | **Deleted** | Unused. Doc extensions are attach calls inside a bootstrap. |
| `.withWorkspaceExtension` | Tolerated (Phase 4 consolidation) | Not blocking. |
| Child-doc lifecycle | `attachChildDocs` userland helper | Not part of the primitive. Opens/closes per row via parent-table observation. |
| Cross-app shared docs | `defineDocument` imported from shared package | Per-app config via factory functions when needed. |
| Standalone package | `packages/document` | Enables external consumption. Keeps `packages/workspace` as a pure consumer. |
| LIFO dispose order | Registration order on `'destroy'` event | Sufficient for now. If strict LIFO needed, `openDocument` maintains its own list. |
| `clearLocalData` | Attach-helper-returned method | `doc.idb.clearLocal()`. Coordinated wipe via a `clearAllLocal(doc)` helper that walks known cleanup surfaces. |
| Encryption placement | Stays in builder layer | Phase-4 work; the core redesign ships first. |

## Open Questions

1. **Does `attachChildDocs` need a caching policy?** Opening every row's content doc eagerly would blow up Yjs memory for a large table. The helper likely needs `{ policy: 'eager' | 'lazy' | 'lru' }`. Current `create-documents.ts` is eager: port preserves that, upgrade later.

2. **Do we need `ydoc.on('destroy')` to run LIFO strictly?** Registration order works in current V8 but is not specified. If persistence-before-sync-dispose becomes critical, `openDocument` maintains its own list and iterates it in reverse.

3. **Should attach helpers return `{ api, whenReady, clearLocal, dispose }` uniformly?** Some (idb) expose `whenSynced`; some (sync) expose `reconnect`. No enforced shape. Pro: matches what each thing actually provides. Con: no generic "wait for all ready" helper. Lean: no uniform shape: user awaits what they need.

4. **Does `attachChildDocs` belong in `packages/document` or `packages/workspace`?** It depends on `parentTable` being a table helper, which only `packages/workspace` ships. Lean: `packages/workspace`. `packages/document` stays pure Y.Doc lifecycle.

5. **Can `.withExtension` disappear if external factories move to attach helpers?** Probably, eventually. Not in this spec: existing apps depend on it. Phase 4 consolidation question.

6. **What happens when two `openDocument(def)` calls hit the same id concurrently?** Two Y.Docs allocated, two sets of providers. Yjs itself handles the sync/persistence layer correctly but the JS-side state is duplicated. Need either an open-doc registry inside `openDocument` or accept the footgun. Lean: registry, keyed by id, ref-counted. Not in the primitive: ships as `packages/document`'s default.

## Success Criteria

- [ ] `packages/document` ships `defineDocument`, `openDocument`: under 50 lines of production code, zero external dependencies beyond `yjs`.
- [ ] `attachTable`, `attachKv`, `attachIndexedDb`, `attachSync`, `attachBroadcastChannel`, `attachRichText`, `attachPlainText`, `attachTimeline` all functional and unit-tested.
- [ ] `createWorkspace` builds on `defineDocument` internally. Existing app call sites (fuji, honeycrisp, tab-manager, whispering, opensidian, skills) compile unchanged.
- [ ] `.withDocument`, `.withDocumentExtension`, `DocumentConfig`, `DocumentContext`, and `create-documents.ts` are deleted from `packages/workspace`.
- [ ] Fuji and honeycrisp migrate per-row content to `attachChildDocs(...)` with no regression in editor behavior.
- [ ] Opensidian's double-`createWorkspace` at `client.ts:203` collapses to `await openDocument(skillsDoc)`.
- [ ] Whispering splits into `settingsDoc` + `recordingsDoc`. The localStorage-for-roamable-preferences hack in `kv.ts:188` is removed.
- [ ] Filesystem no longer flattens content types to `timeline`: each row opens a per-type content doc.
- [ ] Existing test suites pass (workspace, filesystem, materializer).
- [ ] Documentation covers three consumption patterns: single-doc workspace (unchanged), multi-doc split, cross-app shared.

## References

- `packages/workspace/src/workspace/create-workspace.ts`: Builder; internally wraps `defineDocument` after migration.
- `packages/workspace/src/workspace/create-documents.ts`: Per-row subdoc manager; logic ports to `attachChildDocs` helper, file is deleted.
- `packages/workspace/src/workspace/strategies.ts`: `plainText`/`richText`/`timeline`; each becomes an `attachX(ydoc, opts)` helper with configurable Y.Doc key.
- `packages/workspace/src/workspace/define-table.ts:100-150`: `.withDocument()` declaration; deleted.
- `packages/workspace/src/workspace/lifecycle.ts`: Extension lifecycle; retained for the builder layer, no longer propagates to docs.
- `packages/workspace/src/extensions/persistence/indexeddb.ts`: Ports to `attachIndexedDb(ydoc)`.
- `packages/workspace/src/extensions/persistence/sqlite.ts`: Ports to `attachFilesystem(ydoc, { filePath })`.
- `packages/workspace/src/extensions/sync/websocket.ts`: Ports to `attachSync(ydoc, opts)`.
- `packages/workspace/src/extensions/sync/broadcast-channel.ts`: Ports to `attachBroadcastChannel(ydoc, opts)`.
- `packages/workspace/src/extensions/materializer/sqlite/sqlite.ts`: Ports to `attachSqlite(ydoc, { tables, db })`.
- `apps/fuji/src/lib/workspace.ts`: Simplest migration target. Removes `.withDocument('content', ...)`.
- `apps/opensidian/src/lib/client.ts:203`: Double-`createWorkspace` collapses.
- `apps/whispering/.../kv.ts:188`: Localstorage comment; validation target for settings/recordings split.
- `packages/filesystem/src/table.ts:21-24`: `timeline`-for-everything hack; validation target for multi-type content docs.
- `specs/20260224T141400-local-server-plugin-architecture.md`: Related prior spec on plugin/extension architecture.

## Conversation Journey (for context)

This spec went through multiple shapes before landing here. The final form is substantially simpler than earlier drafts: worth recording what was rejected and why, so a future reader understands the design intent:

1. **Round 1**: Started from "why does `.withDocument('content', { content: richText })` have two `content`s?" Identified naming redundancy, the three-variant `.withExtension` foot-gun, and convention masquerading as config.

2. **Rounds 2-4**: Proposed `defineDocument` as a new primitive. Initially framed as a *replacement* for `createWorkspace`. Audits confirmed the single-Y.Doc ceiling is real (opensidian, whispering evidence).

3. **Round 5**: Overbuilt: the first draft had `emit`, scope-tagged providers, `onDiscriminatorChange`, encrypted defaults, declarative undo config. User correctly called this overbuilt.

4. **Rounds 6-9**: Stripped to a hooks-based IoC model. `defineDocument((ydoc, hooks) => api)` with `hooks: { onReady, onDispose, onUpdate }`. Each audit pass kept trimming ceremony.

5. **Round 10 (the "hooks is a code smell" realization)**: User pushed back: what is `hooks` actually doing? Review found every hook wrapped a native Y.Doc mechanism (`onDispose` → `ydoc.on('destroy')`, `onReady` → `await`, `onUpdate` → a one-liner). Removed the hooks object entirely. The async bootstrap closure plus `ydoc.on('destroy')` is the whole lifecycle story.

6. **Round 11 (the two-layer realization)**: User: "I like how `createWorkspace` works today. The thing I want to fix is the lower level." Reframed: `defineDocument` is the lower primitive, `createWorkspace` is sugar built on top, call sites for single-doc apps don't change. This is what this spec describes.

The repeated pattern: each complication we added was working around an earlier design that was doing too much. The final shape: async bootstrap + Y.Doc destroy event + `createWorkspace` as unchanged sugar: is the first version where nothing feels forced, and the migration path for existing apps is "delete `.withDocument`, port to `attachChildDocs`, done."
