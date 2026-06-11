# Unify Awareness with Sync Transport

**Date**: 2026-04-03
**Status**: Draft (v2: revised from split-registration to per-Y.Doc awareness)
**Author**: AI-assisted (Braden + Sisyphus)

## Overview

Make awareness a per-Y.Doc primitive. Every Y.Doc gets one `Awareness` instance, created by the framework and passed to both the typed `AwarenessHelper` and the sync transport. Workspace and document scopes each define their own awareness schemas independently.

## Motivation

### Current State

Two independent `y-protocols/awareness` instances are created for the same Y.Doc:

```
createWorkspace()
  └─ createAwareness(ydoc, defs)       → Awareness instance A (typed, NOT synced)
  └─ .withExtension('sync', ...)
       └─ createTransport({ doc })      → Awareness instance B (untyped, SYNCED)
```

The workspace's `AwarenessHelper` creates its own `Awareness`:

```typescript
// create-awareness.ts
export function createAwareness(ydoc, definitions) {
  const raw = new Awareness(ydoc);   // ← creates instance A
  return { setLocal, getAll, observe, raw };
}
```

The sync transport also creates its own `Awareness`:

```typescript
// websocket-transport.ts
export function createTransport({ doc, awareness: awarenessOption }) {
  const awareness = awarenessOption ?? new Awareness(doc);  // ← creates instance B
}
```

This creates problems:

1. **`client.awareness.setLocal()` is silently broken for remote peers.** The tab-manager publishes device identity via `client.awareness.setLocal({ deviceId, client: 'extension' })`, but this writes to instance A which is never synced. Remote peers never see it.

2. **`peers()` uses manual typeof guards instead of schema validation.** The sync extension reads from instance B (the only one that's synced) with manual `typeof state.deviceId === 'string'` checks instead of using the workspace's schema-validated `awareness.getAll()`.

3. **The transport already supports external awareness. Nobody uses it.** `createTransport()` accepts `awareness?: Awareness` but `createSyncExtension()` never passes it because it only receives `SharedExtensionContext = { ydoc, whenReady }`.

4. **Documents have no typed awareness path.** Content Y.Docs (rich text, canvas, etc.) get their own sync transports with internal awareness, but there's no way to define cursor/selection schemas. `DocumentContext` has no `awareness` field.

### Research Findings

#### Yjs Awareness Is Per-Y.Doc

From `y-protocols/awareness.js` (the source):

```javascript
constructor (doc) {
  this.clientID = doc.clientID  // borrows the Y.Doc's clientID
  this.states = new Map()       // completely independent state map
}
```

From the Yjs maintainer (discuss.yjs.dev):
> "The Awareness CRDT is completely isolated from the Yjs document. We only supply the Y.Doc to the Awareness CRDT because we want to reuse the clientID."

Each `new Awareness(doc)` is fully independent. Awareness auto-destroys when its Y.Doc is destroyed (`doc.on('destroy', () => this.destroy())`).

#### Industry Standard: One Awareness Per Document/Room

| Project | Pattern | Source |
|---|---|---|
| y-websocket | One awareness per WebSocket room (one room = one Y.Doc) | y-websocket source |
| Tiptap | One awareness per editor/document | tiptap.dev/docs/collaboration |
| BlockNote | One awareness per document (via Yjs provider) | blocknotejs.org/docs |
| Liveblocks | Per-document awareness through managed service | liveblocks.io |

No major Yjs implementation shares awareness across documents.

#### Different Scopes Need Different Schemas

| Scope | Awareness purpose | Example fields |
|---|---|---|
| Workspace | Device identity. Who's online? | `deviceId`, `client`, `deviceName` |
| Rich text doc | Cursor presence. Where are they editing? | `cursor: { line, ch }`, `selection`, `color`, `name` |
| Canvas doc | Viewport. What are they looking at? | `viewport: { x, y, zoom }`, `tool` |
| Spreadsheet doc | Cell focus. Which cell? | `cell: 'A1'`, `selectionRange` |

Workspace awareness and document awareness serve fundamentally different purposes with different shapes.

### Desired State

```
createWorkspace()
  └─ new Awareness(ydoc)                → ONE instance per workspace Y.Doc
  └─ createAwareness(awareness, defs)   → typed wrapper (workspace schema)
  └─ .withExtension('sync', ...)
       └─ receives ctx.awareness.raw    → transport uses the SAME instance

  documents.open('doc-abc')
    └─ new Awareness(contentYdoc)       → ONE instance per document Y.Doc
    └─ createAwareness(awareness, defs) → typed wrapper (document schema)
    └─ sync extension fires for doc
         └─ receives ctx.awareness.raw  → transport uses the SAME instance
```

- ONE awareness instance per Y.Doc. Workspace AND documents
- `SharedExtensionContext` includes `awareness: { raw: Awareness }`: all extensions can access it
- No split registration needed: `withExtension('sync', ...)` works at both scopes
- Workspace awareness schema on `defineWorkspace({ awareness })`
- Document awareness schema on `.withDocument('content', { awareness })`

## Design Decisions

| Decision | Choice | Rationale |
|---|---|---|
| Who owns the Awareness instance | The framework creates one per Y.Doc | Awareness is a Y.Doc primitive (confirmed by y-protocols source). Every Y.Doc that syncs has awareness. |
| `createAwareness()` signature change | Takes `Awareness` instead of `Y.Doc` | Wrapping an existing instance instead of creating one eliminates the dual-instance problem. |
| Grow `SharedExtensionContext` | Add `awareness: { raw: Awareness }` | Awareness is per-Y.Doc, not per-workspace. Every scope (workspace + document) has one. Extensions need it for transport wiring. |
| Keep single `withExtension` for sync | No split registration | Since `SharedExtensionContext` now includes awareness, the sync extension receives `ctx.awareness.raw` at both scopes. One factory handles both. |
| Document awareness schema location | On `.withDocument('content', { awareness })` | Document awareness is per-document-type (rich text cursors ≠ canvas viewports). `withDocument()` is where document-type config already lives (`guid`, `onUpdate`). |
| Document awareness is optional | Defaults to empty `AwarenessHelper<Record<string, never>>` | Not every document type needs cursor presence. The helper exists (`.raw` always works) but has zero typed fields unless schemas are defined. |
| `peers()` data source | Transport membership + typed awareness overlay | `awareness.getAll()` skips clients with zero valid fields. `peers()` should still list connected clients that haven't published identity yet. |
| RPC targeting | Stays `clientId`-based | `clientId` is the transport address. `deviceId` is metadata for display, not routing. |

## Architecture

### Before: Two Independent Instances

```
┌────────────────────────────────────┐
│  createWorkspace()                 │
│                                    │
│  ┌──────────────────────────────┐  │
│  │  AwarenessHelper             │  │
│  │  raw = new Awareness(ydoc)  ─┼──┼── Instance A (typed, local-only)
│  │  setLocal() → writes here    │  │
│  │  getAll()  → reads here      │  │
│  └──────────────────────────────┘  │
│                                    │
│  ┌──────────────────────────────┐  │
│  │  Sync Extension              │  │
│  │  transport.awareness ────────┼──┼── Instance B (untyped, synced via WS)
│  │  peers() → reads here        │  │
│  │  rpc()   → targets here      │  │
│  └──────────────────────────────┘  │
└────────────────────────────────────┘

Documents: no typed awareness at all.
Problem: setLocal() writes to A, peers() reads from B. Never connected.
```

### After: One Awareness Per Y.Doc

```
┌──────────────────────────────────────────┐
│  Workspace Y.Doc                         │
│                                          │
│  awareness = new Awareness(ydoc) ────────┼── ONE instance
│                                     │    │
│  ┌──────────────────────────────┐   │    │
│  │  AwarenessHelper             │   │    │
│  │  schema: { deviceId, client }│   │    │
│  │  raw ═══════════════════════►│───┘    │
│  │  setLocal() → writes to raw  │        │
│  │  getAll()  → validates raw   │        │
│  └──────────────────────────────┘        │
│                                     │    │
│  ┌──────────────────────────────┐   │    │
│  │  Sync Extension              │   │    │
│  │  transport({ awareness }) ═══│───┘    │
│  │  peers() → membership + typed overlay │
│  │  rpc()   → same transport socket      │
│  └──────────────────────────────┘        │
└──────────────────────────────────────────┘

┌──────────────────────────────────────────┐
│  Document Y.Doc ("doc-abc")              │
│                                          │
│  awareness = new Awareness(docYdoc) ─────┼── ONE instance (independent)
│                                     │    │
│  ┌──────────────────────────────┐   │    │
│  │  AwarenessHelper             │   │    │
│  │  schema: { cursor, color }   │   │    │
│  │  raw ═══════════════════════►│───┘    │
│  └──────────────────────────────┘        │
│                                     │    │
│  ┌──────────────────────────────┐   │    │
│  │  Sync Extension              │   │    │
│  │  transport({ awareness }) ═══│───┘    │
│  └──────────────────────────────┘        │
└──────────────────────────────────────────┘

Each Y.Doc owns its awareness. Typed helpers wrap it. Transports sync it.
```

### Type Hierarchy

```
SharedExtensionContext
  awareness: { raw: Awareness }          ← base interface, for transports
     │
     ├── ExtensionContext (workspace scope)
     │     awareness: AwarenessHelper<TWorkspaceDefs>   ← typed, satisfies base
     │
     └── DocumentContext (document scope)
           awareness: AwarenessHelper<TDocDefs>          ← typed, satisfies base

AwarenessHelper<TDefs> has .raw: Awareness
  → structurally satisfies { raw: Awareness }
  → TypeScript handles this via structural subtyping
```

### Schema Definition Sites

```
defineWorkspace({
  id: 'my-app',

  awareness: {                              ← workspace awareness schema
    deviceId: type('string'),
    client: type('"extension" | "desktop" | "cli"'),
  },

  tables: {
    files: defineTable(fileSchema)
      .withDocument('content', {
        guid: 'id',
        onUpdate: () => ({ updatedAt: Date.now() }),
        awareness: {                        ← document awareness schema (optional)
          cursor: type({ line: 'number', ch: 'number' }),
          color: type('string'),
          name: type('string'),
        },
      }),

    canvases: defineTable(canvasSchema)
      .withDocument('canvas', {
        guid: 'id',
        awareness: {                        ← different schema for different doc type
          viewport: type({ x: 'number', y: 'number', zoom: 'number' }),
        },
      }),
  },
})
```

### `peers()` Composition (unchanged from v1)

```
Transport raw awareness          Scope typed awareness
(who's connected)                (what we know about them)
─────────────────                ─────────────────────────
awareness.getStates()            awareness.getAll()
  Map<clientId, raw state>         Map<clientId, validated state>
       │                                │
       └──────────┬─────────────────────┘
                  │
            peers() merges:
            ┌──────────────────────────────────────┐
            │ for each clientId in transport states │
            │   skip self                          │
            │   overlay typed fields if available   │
            │   include client even if no fields    │
            └──────────────────────────────────────┘
                  │
            Peer[]: every connected client,
            enriched with typed identity when available
```

## Implementation Plan

### Phase 1: `createAwareness()` Wraps Instead of Creates

- [ ] **1.1** Change `createAwareness(ydoc, definitions)` → `createAwareness(awareness, definitions)`. Takes an existing `Awareness` instance instead of a `Y.Doc`. Remove the `new Awareness(ydoc)` call inside.
- [ ] **1.2** Update `createWorkspace()` to create `new Awareness(ydoc)` and pass it to `createAwareness(rawAwareness, defs)`.
- [ ] **1.3** Verify: `awareness.raw` in `AwarenessHelper` is the same object reference as the `Awareness` created in `createWorkspace()`.
- [ ] **1.4** Update `dispose()` in `buildClient()`: it already calls `awareness.raw.destroy()`, still works.
- [ ] **1.5** Run existing awareness tests: behavior unchanged (same API, different construction).

### Phase 2: Awareness on SharedExtensionContext

- [ ] **2.1** Update `SharedExtensionContext` type: add `awareness: { raw: Awareness }`.
- [ ] **2.2** Update `withExtension()` in `createWorkspace()` to include `awareness` (the `AwarenessHelper`) in the context passed to shared extension factories. Since `AwarenessHelper` has `.raw`, it satisfies `{ raw: Awareness }`.
- [ ] **2.3** Update `createSyncExtension` (single factory, no split) to pass `context.awareness.raw` to `createTransport()`. Remove the transport's internal awareness creation for this path.
- [ ] **2.4** Rewrite `peers()` to use transport membership + `awareness.getAll()` overlay. Delete `PeerInfo` type.
- [ ] **2.5** Keep `websocket-transport.ts` unchanged: it already supports `awareness?: Awareness` and `onCustomMessage`.

### Phase 3: Document Awareness

- [ ] **3.1** Add optional `awareness?: AwarenessDefinitions` to `DocumentConfig` type (the config object in `.withDocument()`).
- [ ] **3.2** Update `createDocuments()` to create `new Awareness(contentYdoc)` per document Y.Doc and wrap it with `createAwareness(rawAwareness, docAwarenessDefs)`.
- [ ] **3.3** Add `awareness` to `DocumentContext` type. Document extensions now receive `ctx.awareness` (typed helper with `.raw`).
- [ ] **3.4** The sync extension (registered via `withExtension`) receives `ctx.awareness.raw` at document scope: the transport uses the document's awareness instance. No code change needed in the sync extension itself.
- [ ] **3.5** Update `DocumentHandle` to include `awareness` so app code can access `handle.awareness.setLocal(...)` for cursor state.

### Phase 4: Update Consumer Sites

- [ ] **4.1** Update `apps/tab-manager/src/lib/workspace/definition.ts`: add workspace awareness definitions (`deviceId`, `client`) to `defineWorkspace()`.
- [ ] **4.2** Verify tab-manager's `client.awareness.setLocal({ deviceId, client: 'extension' })` now works for remote peers.
- [ ] **4.3** Consumer sync registration calls (`withExtension('sync', ...)`) are **unchanged**: no migration needed.
- [ ] **4.4** Delete old `PeerInfo` type and any manual `typeof` awareness checks.

### Phase 5: Cleanup and Verification

- [ ] **5.1** Run full test suite: `bun test` across the monorepo.
- [ ] **5.2** Run type check: `bun run typecheck` across affected packages.
- [ ] **5.3** Update sync extension tests to verify awareness instance sharing.
- [ ] **5.4** Add test: workspace awareness `setLocal()` → transport sends awareness update (confirms single instance).
- [ ] **5.5** Add test: document awareness `setLocal()` → document transport sends awareness update (confirms per-doc instance).

## Edge Cases

### Workspace Without Sync Extension

1. `createWorkspace()` creates awareness and the `AwarenessHelper` wraps it.
2. No sync extension registered: no transport, no syncing.
3. `client.awareness.setLocal()` works locally (same-tab), but nothing syncs.
4. **Expected**: Fine. Awareness is useful for local state even without sync.

### Transport Receives Awareness After Local State Already Set

1. Workspace creates awareness, app calls `setLocal()` immediately.
2. Sync extension registers, transport receives the awareness instance.
3. Transport calls `connect()`, WebSocket opens, awareness update is sent.
4. **Expected**: Works. The `onopen` handler checks `awareness.getLocalState() !== null` and sends initial state.

### `peers()` for Clients Without Identity

1. Remote client connects but hasn't called `setLocal()` yet.
2. Transport's `awareness.getStates()` has the client.
3. `awareness.getAll()` skips this client (zero valid fields).
4. **Expected**: `peers()` still lists the client (from transport membership) but with no typed fields. RPC can still target them.

### Document Without Awareness Schema

1. `withDocument('content', { guid: 'id' })`: no `awareness` field.
2. Framework still creates `new Awareness(contentYdoc)` and wraps with `createAwareness(raw, {})`.
3. `handle.awareness` exists but has zero typed fields. `handle.awareness.raw` always works.
4. **Expected**: Same as workspace awareness with no definitions: helper exists, zero typed fields.

### Document Open/Close Lifecycle

1. User opens a document: `new Y.Doc()` + `new Awareness(docYdoc)` created.
2. Awareness state accumulates (cursors from peers).
3. User closes the document: `contentYdoc.destroy()` fires, awareness auto-destroys (y-protocols: `doc.on('destroy', () => this.destroy())`).
4. **Expected**: Clean lifecycle. No leaked awareness instances.

### Multiple Documents Open Simultaneously

1. User opens doc-abc and doc-xyz. Each has its own Awareness instance.
2. Peer appears in doc-abc's awareness but not doc-xyz's (they only have doc-abc open).
3. **Expected**: Correct isolation. Each document's `peers()` shows only that document's collaborators.

## Open Questions

1. **Should `peers()` exist at document scope too?**
   - At workspace scope, `peers()` shows connected devices. At document scope, it would show who's editing this document.
   - **Recommendation**: Yes. The implementation is identical: merge transport membership with typed awareness. Useful for showing collaborator cursors in editors.

2. **Should `peers()` return type be generic over awareness definitions?**
   - After this change, the typed fields come from the awareness schema (workspace or document).
   - **Recommendation**: Yes. `peers()` returns `Peer<TAwarenessDefinitions>[]` where each peer has `clientId: number` plus optional typed awareness fields.

3. **How does `rpc()` work at document scope?**
   - RPC currently targets workspace peers (devices). Should documents support RPC too?
   - **Recommendation**: Defer. RPC at document scope doesn't have a clear use case yet. Keep it workspace-only for now; the transport supports it if needed later.

4. **Should workspace awareness fields be visible at document scope?**
   - When a peer opens a document, should the document's `peers()` include workspace-level identity (deviceId, client type)?
   - **Recommendation**: No. Each scope has its own awareness. If you need identity in documents, the app publishes `name` and `color` into the document's awareness `setLocal()`. This matches how Tiptap, BlockNote, etc. work: each document has self-contained presence.

## Success Criteria

- [ ] ONE `Awareness` instance per Y.Doc. Workspace and documents (verified by reference equality: `awareness.raw === transport.awareness`)
- [ ] `client.awareness.setLocal(...)` values visible to remote peers
- [ ] `peers()` returns typed awareness fields (not manual `typeof` checks)
- [ ] Document awareness works independently with per-document-type schemas
- [ ] `SharedExtensionContext` includes `awareness: { raw: Awareness }`
- [ ] No split registration needed: single `withExtension('sync', ...)` works at both scopes
- [ ] All existing tests pass
- [ ] Type check passes across the monorepo
- [ ] Tab-manager awareness identity flows end-to-end

## References

- `packages/workspace/src/workspace/create-awareness.ts`: Phase 1: accept `Awareness` instead of `Y.Doc`
- `packages/workspace/src/workspace/create-workspace.ts`: Phase 1: create `Awareness` here, pass to helpers
- `packages/workspace/src/workspace/types.ts`: Phase 2: update `SharedExtensionContext`, `DocumentContext`, add `Peer<T>` type
- `packages/workspace/src/extensions/sync/websocket.ts`: Phase 2: pass `ctx.awareness.raw` to transport
- `packages/workspace/src/extensions/sync/websocket-transport.ts`: Unchanged (already supports external awareness)
- `packages/workspace/src/workspace/create-document.ts`: Phase 3: create per-doc awareness, add to context
- `apps/tab-manager/src/lib/workspace/definition.ts`: Phase 4: add awareness definitions
- `apps/tab-manager/src/lib/client.ts`: Phase 4: verify awareness works
- `apps/honeycrisp/src/lib/client.ts`: Phase 4: unchanged (sync registration stays the same)
- `apps/opensidian/src/lib/client.ts`: Phase 4: unchanged
- `specs/20260403T180000-collapse-sync-client-into-workspace.md`: Prior art: the sync-client collapse
