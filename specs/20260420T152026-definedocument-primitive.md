# `defineDocument`: collapse documents and extensions onto one primitive

## TL;DR

Today the workspace package has three overlapping concepts: `.withDocument(slot, config)` declarations on tables, a `withDocumentExtension(key, factory)` registry on the workspace builder, and a separate `withWorkspaceExtension`. Together they encode a Y.Doc lifecycle (ref-counted caching, grace-period disposal, origin-tagged write loops, LIFO extension teardown) inside ~500 LOC of framework plumbing.

This spec **extracts that lifecycle into a single primitive**: `defineDocument` in `@epicenter/document`: and **deletes the three workspace concepts** (`.withDocument`, `.withDocumentExtension`, `.withWorkspaceExtension`) in favor of users writing a plain Y.Doc construction closure that the primitive wraps. The workspace's own root Y.Doc is rebuilt on the same primitive, so there's exactly one way to construct a managed Y.Doc in the system.

This is a clean break, not a layered refactor. Five `.withDocument` call sites and zero `.withDocumentExtension` production call sites migrate. The framework gets dramatically smaller (~500 LOC deleted from `packages/workspace`, ~250 LOC added to `packages/document`).

## Why a clean break (not a wrapper)

The original draft of this spec proposed `defineDocument` as the primitive *and* kept `.withDocument` as sugar on top. That's a layered refactor: framework still exists, just thinner.

The problem with layering: `.withDocument` exists because the framework controls Y.Doc construction, so users can't reach the construction site to wire their own extensions. The framework had to invent a registry (`withDocumentExtension`) to inject behavior into a place users couldn't reach. **If `defineDocument` lets users own the construction closure directly, the entire reason `.withDocument` and `withDocumentExtension` exist disappears.** Keeping them as sugar preserves the smell.

The trade-off:

| | Keep `.withDocument` as sugar | Clean break |
|---|---|---|
| App-side LOC per doc type | ~4 lines | ~12 lines |
| Framework LOC | ~120 (sugar) + ~250 (primitive) | ~250 (primitive) |
| Concepts to learn | 3 (`.withDocument`, `withDocumentExtension`, `defineDocument`) | 1 (`defineDocument`) |
| Migration cost | 0 | 5 call sites |
| Per-document extension control | Workspace-uniform (registry) | Per-document explicit |
| Y.Doc construction options (gc, meta, autoLoad) | Framework decides | User decides |

For a local-first library where users *are* developers, the clean break wins. The extra lines per doc type are explicit composition that reads top-to-bottom; the framework collapse pays for itself the first time someone needs a one-off extension or a non-default Y.Doc option.

## Inventory

### `.withDocument` call sites (5 total, all identical shape)

| File | Line | Slot | Strategy |
|---|---|---|---|
| `apps/fuji/src/lib/workspace.ts` | 110 | `content` | `richText` |
| `apps/honeycrisp/src/lib/workspace/definition.ts` | 107 | `body` | `richText` |
| `packages/filesystem/src/table.ts` | 21 | `content` | `timeline` |
| `packages/skills/src/tables.ts` | 61 | `instructions` | `plainText` |
| `packages/skills/src/tables.ts` | 96 | `content` | `plainText` |

Every site uses the same config shape:
```ts
.withDocument(slot, {
  content: <strategy>,
  guid: 'id',
  onUpdate: () => ({ updatedAt: <now> }),
})
```

### `.withDocumentExtension` call sites
**Zero production usage.** Defined but unused. Documented in `packages/workspace/README.md:151`. One test reference (`create-workspace.test.ts:533`). Safe to delete.

### `.withWorkspaceExtension` call sites
Used internally by the workspace builder for the root Y.Doc's awareness/sync wiring. Collapses into a generic `.withExtension` once the workspace itself is a `defineDocument` instance (Phase 3).

## The reference shape (what the primitive must wrap)

A reasonable hand-rolled factory for fuji's entry content doc looks like this:

```ts
// apps/fuji/src/lib/entry-content-doc.ts (illustrative: NOT the proposed shape)
import { APP_URLS } from '@epicenter/constants/vite';
import { attachIndexedDb, attachRichText, attachSync, websocketUrl } from '@epicenter/document';
import { DateTimeString } from '@epicenter/workspace';
import * as Y from 'yjs';
import { auth, workspace } from './client';
import type { EntryId } from './workspace';

export function openEntryContentDoc(rowId: EntryId) {
  const ydoc = new Y.Doc({
    guid: `epicenter.fuji.entries.${rowId}.content`,
    gc: false,  // sync compat: GC'd deletion markers diverge from offline peers
  });
  const content = attachRichText(ydoc);
  const idb = attachIndexedDb(ydoc);
  const sync = attachSync(ydoc, {
    url: (docId) => websocketUrl(`${APP_URLS.API}/docs/${docId}`),
    getToken: async () => auth.token,
    waitFor: idb.whenLoaded,
  });
  ydoc.on('update', () => {
    workspace.tables.entries.update(rowId, { updatedAt: DateTimeString.now() });
  });
  return {
    ydoc, content,
    whenLoaded: idb.whenLoaded,
    whenConnected: sync.whenConnected,
    clearLocal: idb.clearLocal,
    reconnect: sync.reconnect,
    dispose: () => ydoc.destroy(),
  };
}
```

This is appealing: full visibility, no magic, `gc: false` explicitly chosen with a comment. **But it has seven real bugs that the framework's existing `.withDocument` machinery silently fixes.** The primitive's job is to wrap this exact construction style while restoring those fixes.

### Bugs in the raw factory (what the primitive must restore)

1. **Single-Y.Doc-per-id invariant violated.** Two components on the same `rowId` get two separate `Y.Doc` instances, two IDB connections, two WebSocket handshakes. They reconcile *eventually* through server round-trip, but local state diverges in between.
2. **`ydoc.on('update', ...)` fires on transport echoes.** Fires for every update including remote peer edits arriving via sync. So a collaborator's edit triggers a local `updatedAt` write: wrong. The framework's `DOCUMENTS_ORIGIN` filtering skips updates whose origin is a Symbol (transports tag their writes with provider symbols).
3. **No grace period.** Mount → unmount → remount in 5s = full reconstruction (new IDB hydration, new WebSocket handshake). 30s grace makes that round-trip free.
4. **Lifecycle ergonomics are fragile.** Every caller must remember `dispose()`. Forget once → leaked WebSocket + IDB connection. Ref-counted `bind()` returning an idempotent release closure fits naturally into Svelte `$effect` / React `useEffect` cleanup, and double-release is a no-op.
5. **No coordinated teardown.** App teardown can't say "close all open entry docs."
6. **`whenLoaded` is single-extension.** Only awaits IDB. Adding a second extension that needs loading requires manually merging the promise.
7. **No LIFO disposal with error collection.** `ydoc.destroy()` clears listeners but doesn't await sync's WebSocket close or IDB's connection close. If one throws, others may not run.

The primitive wraps the raw closure and adds: id-keyed cache, ref-count + grace, origin filtering, aggregated `whenLoaded`, coordinated `closeAll`, LIFO disposal with error aggregation.

## The primitive API

```ts
// packages/document/src/define-document.ts

export function defineDocument<Id extends string, TAttach extends { ydoc: Y.Doc }>(
  build: (id: Id) => TAttach,
  opts?: { graceMs?: number }
): DocumentFactory<Id, TAttach>;

export interface DocumentFactory<Id extends string, TAttach> {
  /** Cached, ref-counted handle. Concurrent .get(sameId) returns same instance. */
  get(id: Id): DocumentHandle<TAttach>;

  /** Sugar: get(id) + await whenLoaded, returns TAttach. */
  read(id: Id): Promise<TAttach>;

  /** Explicit eviction. Bypasses grace period. */
  close(id: Id): Promise<void>;

  /** Tear down everything. Called from app teardown / workspace dispose. */
  closeAll(): Promise<void>;
}

export type DocumentHandle<TAttach> = TAttach & {
  whenLoaded: Promise<void>;
  /** Returns idempotent release closure. 0→1 fires onActive across attached
   *  extensions; last release schedules onIdle after graceMs. */
  bind(): () => void;
};

/** Helper for "fire on local edits, skip transport echoes." Equivalent to
 *  ydoc.on('update', (_, origin) => { if (origin === null) fn() }) but the
 *  filter rule (origin must be null or DOCUMENTS_ORIGIN, never a Symbol) is
 *  what the framework uses internally. Exposed so user closures get the
 *  same semantics. */
export function onLocalUpdate(ydoc: Y.Doc, fn: () => void): () => void;

/** Internal-write origin tag. Exposed so users tagging their own metadata
 *  writebacks can match the framework's filtering convention. */
export const DOCUMENTS_ORIGIN: unique symbol;
```

### Call site after migration

```ts
// apps/fuji/src/lib/entry-content-doc.ts (proposed)
import { APP_URLS } from '@epicenter/constants/vite';
import {
  attachIndexedDb, attachRichText, attachSync,
  defineDocument, onLocalUpdate, websocketUrl,
} from '@epicenter/document';
import { DateTimeString } from '@epicenter/workspace';
import * as Y from 'yjs';
import { auth, workspace } from './client';
import type { EntryId } from './workspace';

export const entryContent = defineDocument((rowId: EntryId) => {
  const ydoc = new Y.Doc({
    guid: `epicenter.fuji.entries.${rowId}.content`,
    gc: false,  // sync compat: see Yjs createDocFromSnapshot constraint
  });
  const content = attachRichText(ydoc);
  const idb = attachIndexedDb(ydoc);
  const sync = attachSync(ydoc, {
    url: (docId) => websocketUrl(`${APP_URLS.API}/docs/${docId}`),
    getToken: async () => auth.token,
    waitFor: idb.whenLoaded,
  });
  onLocalUpdate(ydoc, () => {
    workspace.tables.entries.update(rowId, { updatedAt: DateTimeString.now() });
  });
  return {
    ydoc, content,
    whenConnected: sync.whenConnected,
    clearLocal: idb.clearLocal,
    reconnect: sync.reconnect,
  };
});

// Usage in EntryEditor.svelte
const handle = entryContent.get(rowId);
const release = handle.bind();
await handle.whenLoaded;          // aggregate of all extensions' load promises
// ... use handle.content.binding ...
// $effect cleanup:
release();
```

Diff from the hand-rolled version: `function openEntryContentDoc` → `defineDocument(...)`, `ydoc.on('update', ...)` → `onLocalUpdate(ydoc, ...)`, drop the `dispose` field (framework owns it), drop the `whenLoaded` field (framework aggregates). Construction body is otherwise identical.

### Why this shape (the API journey)

We evaluated four candidates. One was eliminated, two were eliminated by inversion of the original constraint, one won.

**Original framing (Option A): config object with separate `buildGuid` + `attach` callbacks.** Initially recommended on the grounds that "the framework must construct the Y.Doc because the cache key has to exist before user code runs." This reasoning is **wrong**: verified against the existing implementation:

> `packages/workspace/src/workspace/create-documents.ts:211, 401, 433`: `openDocuments = new Map<string, DocEntry>()`. Cache key is the Y.Doc guid, but guid is just `buildGuid(id)`, so the cache key is computable from `id` alone. There is no need to construct the Y.Doc to derive the cache key.

The flow that actually works:
```
factory.get('foo')
  → cache.get('foo')        // hit? return cached.
  → userClosure('foo')      // miss → user constructs Y.Doc + attaches
  → cache.set('foo', wrappedHandle)
```

Y.Doc construction is synchronous. There's no await between cache check and cache set, so concurrent `.get(sameId)` is race-safe: same property the current code relies on.

With that constraint dropped, **Option B (single closure that constructs Y.Doc)** becomes viable, and it's strictly better than A:

| | A (split callbacks) | B (single closure) |
|---|---|---|
| Closures user writes | 2 (guid + attach) | 1 |
| Y.Doc construction options | None (or `ydocOptions` passthrough: half-measure) | Native, full control |
| `gc: false` for snapshot use | Hidden behind framework default | Explicit in user code |
| `meta`, `autoLoad`, `collectionid` | Need separate API surface | Just pass to `new Y.Doc(...)` |
| Mental model | "Configure 3 callbacks the framework calls" | "Build a Y.Doc, return it" |

The Yjs constraint matters: `gc: false` is **strictly required** for `createDocFromSnapshot` (Yjs throws otherwise). Forcing `gc: true` would break snapshot/undo-restoration; forcing `gc: false` would prevent memory cleanup for short-lived ephemeral docs. The framework shouldn't pick.

Other Y.Doc options that matter:
- `meta`: arbitrary metadata that syncs to peers. Application-specific.
- `autoLoad` / `shouldLoad`: subdoc lifecycle control.
- `collectionid`: provider-specific collection grouping.

All of these argue for letting the user own `new Y.Doc()`.

**Eliminated options:**
- **Option C (config object + positional attach):** splits API across positional callback AND named config bag. Adding new framework knobs (`graceMs`, etc.) creates asymmetry. Worst of both worlds.
- **Option D (builder chain):** invites scope creep, awkward to extend without breaking source order, no type-inference advantage.

### Trade-offs honestly

What B costs:
- **User must include `ydoc` in the return object.** One extra property. Type constraint `TAttach extends { ydoc: Y.Doc }` enforces it at compile time.
- **No compile-time enforcement of "you set a guid."** If user forgets `guid:`, Y.Doc auto-generates a UUID: two `.get('foo')` and `.get('bar')` calls would both get cached but their Y.Docs would have unrelated random guids, breaking sync. Mitigation: framework asserts `ydoc.guid` is deterministic by checking it against a per-id cache on construction. (Cheap runtime check.)
- **No automatic origin tagging.** Framework can't pre-tag user writes with `DOCUMENTS_ORIGIN` because user owns the transactions. Mitigation: `onLocalUpdate(ydoc, fn)` helper provides the filtering for the common case; users tagging their own writebacks can use `ydoc.transact(fn, DOCUMENTS_ORIGIN)`.

What B is *not* taking away:
- All seven invariants from the bug list above are restored by the framework wrapping the closure. User's mental model is "I built a Y.Doc"; framework's job is "I cache, ref-count, dispose, and aggregate `whenLoaded` around your build closure."

## Migration map

### Before (5 call sites, all identical pattern)

```ts
// e.g., apps/honeycrisp/src/lib/workspace/definition.ts:107
.withDocument('body', {
  content: richText,
  guid: 'id',
  onUpdate: () => ({ updatedAt: DateTimeString.now() }),
});
```

### After

```ts
// apps/honeycrisp/src/lib/workspace/note-body-doc.ts
import { attachRichText, defineDocument, onLocalUpdate } from '@epicenter/document';
import { DateTimeString } from '@epicenter/workspace';
import * as Y from 'yjs';
import { workspace } from './client';

export const noteBody = defineDocument((noteId: string) => {
  const ydoc = new Y.Doc({ guid: `epicenter.honeycrisp.notes.${noteId}.body` });
  const body = attachRichText(ydoc);
  onLocalUpdate(ydoc, () => {
    workspace.tables.notes.update(noteId, { updatedAt: DateTimeString.now() });
  });
  return { ydoc, body };
});

// Usage (was workspace.tables.notes.documents.body.get(id))
const handle = noteBody.get(noteId);
const release = handle.bind();
await handle.whenLoaded;
// ... handle.body.binding for the editor ...
release();
```

The slot definition no longer lives on the table. The factory is a module-level export. The "namespace" is just an import path. Type safety is preserved: `noteBody.get(id)` returns `DocumentHandle<{ ydoc: Y.Doc; body: RichTextBinding }>`.

For sites that need extensions (sync, IDB persistence), they go in the closure inline: see the fuji example above. Reusable bits are extracted as helper functions, which is just function composition, not a registry.

### Workspace builder simplification

Today (`packages/workspace/src/workspace/create-workspace.ts:198-246`):
- Iterates each table's `.withDocument` declarations.
- Walks the `withDocumentExtension` registry.
- Wires both into a `createDocuments()` call per slot.
- Installs `workspace.tables.<X>.documents.<Y>` namespace.

After:
- All of the above deleted. ~50 LOC removed.
- Tables no longer carry document slot definitions in their type.
- `defineTable` strips down to pure data-shape + migration (already its only real job: the `.withDocument` builder method was an awkward guest).
- `workspace.tables.<X>` keeps its row API (`get`, `update`, `delete`, `filter`). Document access is via the user's exported factories.

## Phases

### Phase 0: Prototype (~3h, no commits)

Write `packages/document/src/define-document.ts` from scratch. Port the core mechanics from `packages/workspace/src/workspace/create-documents.ts`:

- `openDocuments` Map keyed by `id` (was guid; switch to id since id is the user-facing identity)
- Race-safe construction (source:221-235): synchronous get/set, no await between
- `DocEntry` shape (source:91-120): adapted to drop `tableHelper` coupling and to wrap a user-provided `{ ydoc, ...attachments }` instead of constructing internally
- Ref-counting + grace period (source:344-393)
- `DOCUMENTS_ORIGIN` symbol export + `onLocalUpdate(ydoc, fn)` helper (source observer logic: 283-307)
- LIFO extension disposal (source:405-428): now disposes via `ydoc.destroy()` plus any framework-tracked listeners

Also add a runtime guid-stability check: on construction, framework records `ydoc.guid` for the id; on subsequent cache hits, asserts the guid hasn't changed (catches user closures that accidentally produce nondeterministic guids, e.g., `Math.random()`).

Sketch a migration of one call site (recommend `packages/skills/src/tables.ts:61`: simplest, plainText, no auth). Don't wire it up. Just verify the call site reads cleanly and TypeScript correctly infers the `factory.get(id)` return type from the closure's return type.

**Go/no-go gate:** can you express the skills/instructions migration in ≤10 lines of `defineDocument` code that reads more clearly than the current `.withDocument` call? Does TypeScript infer `factory.get(id).content` without manual annotation? If yes to both, proceed.

### Phase 1: Land the primitive (~1d)

Single commit: `feat(document): add defineDocument primitive`.

- `packages/document/src/define-document.ts`: the primitive itself, ~250 LOC.
- `packages/document/src/types.ts`: define `DocumentHandle`, `DocumentFactory`. (These types currently live in `packages/workspace/src/workspace/types.ts:253-392` but workspace will lose them in Phase 2; introduce them here as the canonical home.)
- `packages/document/src/on-local-update.ts`: the helper.
- `packages/document/src/index.ts`: barrel export `defineDocument`, `DocumentHandle`, `DocumentFactory`, `DOCUMENTS_ORIGIN`, `onLocalUpdate`.
- `packages/document/src/define-document.test.ts`: port the load-bearing tests from `packages/workspace/src/workspace/create-documents.test.ts:555-881` (ref-count, grace, stale-release safety, concurrent-get race, origin filtering via `onLocalUpdate`, LIFO disposal, error propagation). ~450 LOC.

At this point `packages/document` exports a complete primitive. `packages/workspace` is unchanged and still passing tests.

### Phase 2: Migrate the 5 call sites and delete `.withDocument` (~1.5d)

Single commit: `refactor!: replace .withDocument with defineDocument across workspace consumers`.

Per call site, in order of risk (lowest first):

1. **`packages/skills/src/tables.ts:61`** (`instructions`, plainText): pilot site. Lowest blast radius.
2. **`packages/skills/src/tables.ts:96`** (`content`, plainText): same package, same pattern.
3. **`packages/filesystem/src/table.ts:21`** (`content`, timeline): different strategy, exercises the timeline path.
4. **`apps/honeycrisp/src/lib/workspace/definition.ts:107`** (`body`, richText): first richText site.
5. **`apps/fuji/src/lib/workspace.ts:110`** (`content`, richText): second richText, plus the use case driving this whole refactor (eventually wants custom auth/sync URLs not expressible in `.withDocument`).

For each site:
- Add a `defineDocument` call at module scope.
- Update consumers: `workspace.tables.X.documents.Y.get(id)` → `<exportedFactory>.get(id)`.
- Wire `closeAll()` into the workspace's dispose path so app teardown still cleans up.

Then in `packages/workspace`:
- Delete `create-documents.ts` (493 LOC).
- Delete `create-documents.test.ts` (1153 LOC): its coverage is now in `packages/document/src/define-document.test.ts`.
- Delete the `.withDocument` builder method on `defineTable` (`packages/workspace/src/workspace/define-table.ts` shrinks).
- Delete `withDocumentExtension` from the workspace builder (zero production callers; one test usage to remove).
- Delete the `documents` namespace installation in `create-workspace.ts:198-246`.
- Delete `DocumentExtensionRegistration`, `DocumentContext`, `DocumentConfig` types from `types.ts`.
- Re-export `DocumentHandle` and `DocumentFactory` from `@epicenter/document` for compatibility.

Net: ~−1500 LOC across packages/workspace, ~+700 LOC in packages/document (250 impl + 450 tests).

### Phase 3: Build workspace's root Y.Doc on the primitive (~1d, load-bearing)

Single commit: `refactor(workspace): build workspace root Y.Doc via defineDocument`.

This phase is **not optional** in the clean-break world. The justification for collapsing `.withWorkspaceExtension` into `.withExtension` rests on the workspace itself being a `defineDocument` instance: otherwise the workspace's root doc has a different lifecycle than content docs and the two `.with*Extension` variants persist as a smell.

- Workspace root Y.Doc becomes:
  ```ts
  const workspaceDoc = defineDocument(() => {
    const ydoc = new Y.Doc({ guid: workspaceId });
    return {
      ydoc,
      tables: createTables(ydoc, tableDefs),
      kv: createKvs(ydoc, kvDefs),
      awareness: attachAwareness(ydoc, ...),
      // user extensions appended here from .withExtension() calls
    };
  });
  ```
- The workspace client is `workspaceDoc.get(workspaceId)`: i.e., the workspace becomes a singleton document handle.
- Ref-counting gives `.close()` / `.bind()` on the workspace itself, replacing the ad-hoc dispose path in `create-workspace.ts:274-288`.
- `.withWorkspaceExtension` and `.withDocumentExtension` collapse into one `.withExtension` that takes a function `(ydoc, id) => Disposable`, called inside the build closure.

**Risk acknowledgment:** workspace construction has more complexity than a content doc: encryption setup, schema migration, first-load bootstrap. If these don't fit into a single closure cleanly, options are:
1. Decompose into helper functions called from inside the closure. Likely sufficient.
2. If decomposition produces a knotted closure, introduce an internal `attachWorkspace(ydoc, opts)` helper that the closure delegates to. Still uses `defineDocument`, just with the construction logic factored out.

The shape "workspace IS a defineDocument" must hold even if construction logic is delegated to internal helpers. Otherwise we keep the dual lifecycle and the spec is incomplete.

### Phase 4: Realize fuji's flexibility (~0.5d)

Now that `defineDocument` exposes the construction closure, fuji's entry doc becomes a separate module (`apps/fuji/src/lib/entry-content-doc.ts`) wired with custom sync URL templating, auth tokens, and IDB persistence: exactly as shown in the call-site example above. `apps/fuji/src/lib/components/EntryEditor.svelte` switches from `workspace.tables.entries.documents.content.get(id)` to `entryContent.get(id)`.

This is the use case that justified the whole refactor.

### Phase 5: Polish (~0.25d)

- `@internal` tag on the positional `YKeyValue` export.
- Remove `LastSchema` dead fallback in `packages/document/src/types.ts`.
- Drop `attach-kv` unknown-key runtime check on reads.

## Invariants preservation checklist

Every item must hold in `packages/document/src/define-document.ts` and be covered by a test in `define-document.test.ts`. Verified against current behavior in `create-documents.test.ts`.

- [ ] **Ref-count starts at 0.** `bind()` 0→1 fires `onActive`; subsequent binds don't re-fire. Source: `create-documents.test.ts:555-572`.
- [ ] **Grace period default 30s, configurable via `opts.graceMs`.** Source: `create-documents.test.ts:596-617`.
- [ ] **Re-bind during grace cancels disposal.** Source: `create-documents.test.ts:596-617`.
- [ ] **Explicit `close()` during grace fires disposal synchronously.** Source: `create-documents.test.ts:657-671`.
- [ ] **`onLocalUpdate` filtering.** Symbol origins (sync, broadcast transports) skip the callback. `null` origins (local edits) trigger it. `DOCUMENTS_ORIGIN`-tagged origins (user metadata writebacks) skip. Source: `create-documents.test.ts:241-258, 292-324`.
- [ ] **LIFO extension disposal with error collection.** All disposers run even if earlier ones throw; errors aggregated and re-thrown with cause chain. Source: `create-documents.test.ts:362-394`.
- [ ] **Concurrent `.get(sameId)` returns the same handle.** No await between `Map.get` and `Map.set`. Construction is synchronous. Tested with `Promise.all([f.get('x'), f.get('x'), f.get('x')])` returning identity-equal handles.
- [ ] **Stale release after `close()` is a no-op.** Entry's `disposed` flag blocks scheduling. Source: `create-documents.test.ts:673-712`.
- [ ] **`.get()` is synchronous; `whenLoaded` gates reads.** Handle returned immediately; `Promise.all(initPromises)` resolves `whenLoaded`.
- [ ] **`.close()` is caller-owned.** No automatic eviction on row deletion. `closeAll()` exists for app-teardown coordination.
- [ ] **Build closure runs without coupling to a parent workspace.** New invariant. Today every test runs through a workspace; the primitive must be tested standalone since that's now the supported use case (e.g., a fuji-style entry doc with no metadata Y.Doc).
- [ ] **Throwing user closure surfaces cleanly.** Cache should NOT retain the entry; next `.get(sameId)` re-runs the closure. Otherwise a transient init failure permanently poisons the id.
- [ ] **Throwing `onLocalUpdate` callback is isolated.** Yjs transactions don't roll back; partial writes commit. Caller's bug, but the primitive shouldn't crash.
- [ ] **Guid stability check.** If the user closure produces a different `ydoc.guid` for the same id across calls (e.g., `Math.random()` in the guid template), framework throws on the second construction. Catches a real footgun.

## Risks

**Risk 1: Phase 3 may resist.** Workspace root Y.Doc construction has encryption, migration, schema bootstrap: heavier than content doc construction. If the closure becomes unwieldy, factor internal helpers (still inside the closure) rather than punting on Phase 3. The dual-lifecycle-smell argument means we can't ship Phases 1-2+4 and skip Phase 3 cleanly. Budget 2× the estimate; if it still resists, we've learned the primitive is wrong-shaped and need to revisit.

**Risk 2: Type inference quality.** `(id) => TAttach` infers `TAttach` from the return type. We need to verify TypeScript can infer the full attached shape (including nested objects from `attachRichText`, `attachSync`, etc.) without manual annotation at the `defineDocument` call. If inference fails for a common case, the API has lost a key ergonomic property. Test with at least one site that returns 4+ attached behaviors and verify `noteBody.get(id).sync.whenConnected` types cleanly. Also verify the `TAttach extends { ydoc: Y.Doc }` constraint produces a useful error message when the user forgets to include `ydoc`.

**Risk 3: Test coverage transfer.** 1153 LOC of `create-documents.test.ts` deletes in Phase 2. We're porting only the load-bearing primitive-level tests (~450 LOC) to `define-document.test.ts`. Anything specific to row-coupling, table-helper integration, or `.withDocument` API surface drops. Risk: silently dropping a regression test. Mitigation: before Phase 2, walk every `it()` block in `create-documents.test.ts` and explicitly classify it as "primitive behavior: port", "workspace coupling: drop", or "ambiguous: discuss." Document the classification in the Phase 2 PR description.

**Risk 4: Migration touches 4 packages and 2 apps.** Phase 2 is one commit per the plan but affects:
- `packages/workspace` (delete docs subsystem)
- `packages/document` (no change: already done in Phase 1)
- `packages/skills` (2 sites)
- `packages/filesystem` (1 site)
- `apps/honeycrisp` (1 site)
- `apps/fuji` (1 site, basic: Phase 4 enriches it)

Coordinated breaking change. CI must run all package tests in one go. Consider splitting Phase 2 into two commits: (a) update the 5 call sites to a transitional shape that calls `defineDocument` while `.withDocument` still works, (b) delete `.withDocument`. Transitional adds churn but keeps each commit independently bisectable. Recommend: single commit if test suite is fast (<2min), split if slower.

**Risk 5: Loss of "uniform extension" capability.** Today, `withDocumentExtension('persistence', idbFactory)` would apply IDB to *every* content doc in the workspace. After this refactor, each `defineDocument` call lists its own extensions. If an app wants IDB on all 5 content doc types, that's 5 inline calls (or 1 helper function the user writes and calls 5 times). Honest cost. Mitigation: documentation: show the helper-function pattern as the recommended shape for "I want extension X on every doc."

**Risk 6: User forgets `guid` in `new Y.Doc(...)`.** Y.Doc auto-generates a UUID if no guid passed. Two `defineDocument` factories without explicit guids would produce non-deterministic guids on each construction → sync providers connect to random rooms each time → no convergence with peers. Mitigation: the guid-stability invariant (last item in checklist) detects this on the second `.get(sameId)` call by comparing `ydoc.guid` to the stored value. Optionally, also detect "guid looks like an auto-generated UUID" on first construction and warn: but this is heuristic and may false-positive for users who deliberately use UUIDs.

## Open questions (now resolved)

- ~~Should the framework own Y.Doc construction?~~ **Resolved: no.** Cache key is `id`, derivable without running user code. Framework wraps user closure rather than calling sub-callbacks.
- ~~Should `.withDocument` survive as sugar?~~ **Resolved: no.** Keeping it preserves the layered-concept smell that motivated the refactor. Clean break.
- ~~Should `metadataYdoc` / origin-tagging be an API field?~~ **Resolved: no.** Export `DOCUMENTS_ORIGIN` symbol and `onLocalUpdate` helper. Users tagging their own writebacks use `ydoc.transact(fn, DOCUMENTS_ORIGIN)`.
- ~~Should `defineDocument` accept Y.Doc constructor options as a passthrough?~~ **Resolved: no: they pass them directly to `new Y.Doc(...)` in the closure.** The user has full control.
- ~~Should `TAttach` flatten onto the handle or nest under `.attachments`?~~ **Resolved: flatten.** `handle.content.binding` reads better than `handle.attachments.content.binding`. The handle is `TAttach & { whenLoaded, bind }`.
- ~~Should `whenLoaded` come from the user closure or the framework?~~ **Resolved: framework aggregates.** User returns extensions whose `.whenLoaded` (or equivalent) the framework collects via convention. Spec the contract: extensions expose a `whenLoaded?: Promise<void>` that the framework `Promise.all`s. Extensions without one count as "loaded immediately."

## Estimated scope

| Phase | LOC change | Days | Risk |
|---|---|---|---|
| 0: prototype | 0 (scratch) | 0.4 |: |
| 1: primitive + tests | +700 | 1 | low |
| 2: migrate 5 sites + delete sugar | −1500 net | 1.5 | medium (test classification) |
| 3: workspace root on primitive | ~−50 net | 1 | high (load-bearing) |
| 4: fuji enrichment | +30 | 0.5 | low |
| 5: polish | −30 | 0.25 | trivial |

**Total: ~4.5 days focused work. Net LOC delta: ~−850.**

## Commit sequence

1. `feat(document): add defineDocument primitive`: Phase 1.
2. `refactor!: replace .withDocument with defineDocument; remove workspace doc subsystem`: Phase 2. Breaking change marker (`!`) because `.withDocument` is removed from the public API.
3. `refactor(workspace): build workspace root Y.Doc via defineDocument`: Phase 3.
4. `refactor(fuji): wire entry content doc with custom sync via defineDocument`: Phase 4.
5. `chore: polish document package internals`: Phase 5.

Phases 1 and 2 land in a single PR (Phase 2 doesn't compile without Phase 1). Phase 3 lands as its own PR. The structural shift to "workspace IS a defineDocument" is significant enough to review in isolation. Phase 4 is a small follow-up. Phase 5 anytime after.

## What success looks like

- `packages/document/src/index.ts` exports `defineDocument` as the only sanctioned way to construct a managed Y.Doc.
- `packages/workspace` no longer mentions "documents" as a separate concept. Tables manage rows; docs are user-defined factories.
- A new contributor reading the codebase encounters one Y.Doc lifecycle pattern, not three.
- Adding a new content doc type to an app is "write a `defineDocument` call": no framework registration, no builder chain, no slot definition.
- Fuji can wire its custom auth + sync URLs without forking framework code.
- Y.Doc construction options (`gc`, `meta`, `autoLoad`) are decisions users make explicitly per-document, with the rationale visible at the construction site.
