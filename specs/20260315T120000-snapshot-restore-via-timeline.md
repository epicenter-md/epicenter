# Snapshot Restore via Timeline

**Date**: 2026-03-15
**Status**: Implemented
**Author**: AI-assisted
**Supersedes**: `specs/20260313T144805-document-snapshot-fixes.md`

## Overview

Move snapshot restore from the Durable Object to the client, using the timeline abstraction. The DO stays format-agnostic (snapshot CRUD only); the client reads snapshot content via `createTimeline` and writes it back via `DocumentHandle`.

## Motivation

### Current State

`DocumentRoom.applySnapshot` directly manipulates raw Y.Doc keys:

```typescript
// apps/api/src/document-room.ts — BROKEN after timeline merge
const restoredDoc = Y.createDocFromSnapshot(this.doc, snap);
const restoredText = restoredDoc.getText('content').toString(); // ← reads from empty key

this.doc.transact(() => {
    const content = this.doc.getText('content');  // ← writes to unused key
    content.delete(0, content.length);
    content.insert(0, restoredText);
});
```

This creates problems:

1. **Reads from wrong key**: All content now lives in `ydoc.getArray('timeline')`, not `ydoc.getText('content')`. The restore reads an empty string and writes it to a key nothing reads from. It's a silent no-op.
2. **DO does content-level work**: The DO is a sync room—it stores and replicates a Y.Doc. It shouldn't know about timelines, content modes, or how to read/write entries. That's the workspace layer's job.
3. **No mode awareness**: Even if the key were correct, the code assumes text-only. The timeline supports text, richtext, and sheet entries. A sheet snapshot would be flattened to CSV text.

### Desired State

The DO handles snapshot CRUD (save, list, get, delete). The client handles restore—reading from the snapshot doc's timeline and writing to the live doc's timeline via `DocumentHandle`. The restore is a forward operation: new CRDT ops that make the visible content match the snapshot.

## Research Findings

### Yjs Snapshot Mechanics

A `Y.snapshot(doc)` captures `{ stateVector, deleteSet }` — a lightweight pointer (~7 bytes to ~1.5 KB) into the struct store. With `gc: false`, the struct store retains all deleted item content, so any snapshot can reconstruct the full doc.

`Y.createDocFromSnapshot(originDoc, snapshot)` replays the struct store up to the bookmark. The resulting Y.Doc has the **same internal structure** as the original at that point—including the `getArray('timeline')` with all entries as they existed.

| Approach | What happens | Result |
|---|---|---|
| `Y.applyUpdateV2(liveDoc, encodedSnapshotDoc)` | Re-applies structs already in the doc | No-op (CRDTs are idempotent) |
| Read snapshot content → write to live doc | Creates NEW delete + insert structs | Visible content changes |

There is no native `Y.restoreFromSnapshot()`. Restore always means creating new forward operations.

### Timeline Architecture Post-Merge

The timeline moved from `packages/filesystem` into `packages/workspace/src/timeline/`. It's now the canonical content layer for all documents:

```
Y.Doc
  └── getArray('timeline')          ← Y.Array of entries
        └── Y.Map (entry)
              ├── 'type': 'text' | 'richtext' | 'sheet'
              ├── 'content': Y.Text | Y.XmlFragment
              ├── 'columns'/'rows': Y.Map (sheet only)
              └── 'createdAt': number
```

`DocumentHandle` wraps this:
- `handle.read()` → `timeline.readAsString()` (flattens any mode to string)
- `handle.write(text)` → replaces current text entry in-place, or pushes new text entry
- `handle.asText()` / `handle.asRichText()` / `handle.asSheet()` → mode-aware accessors with auto-conversion
- `handle.timeline` → escape hatch for direct timeline access
- `handle.batch(fn)` → `ydoc.transact(fn)`

### Restore Semantics

A restore makes the visible content match the snapshot. Two sub-cases:

| Scenario | Action | Timeline effect |
|---|---|---|
| Same mode (snapshot text, current text) | Replace current entry's Y.Text content in-place (delete + insert) | No new entry. Same as select-all + paste. |
| Different mode (snapshot sheet, current text) | Push new timeline entry matching snapshot's mode | Timeline grows by one entry (mode change). |

`DocumentHandle.write()` already handles the same-mode case for text. For cross-mode restore, the client uses `handle.timeline.pushText()` / `pushSheetFromCsv()` / `pushRichtext()` via `handle.batch()`.

## Design Decisions

| Decision | Choice | Rationale |
|---|---|---|
| Where restore logic lives | Client side | DO is format-agnostic. Client has `DocumentHandle`, timeline, mode awareness. No new deps in the Worker. |
| Remove `applySnapshot` RPC from DO | Yes | Broken, and wrong layer. The DO shouldn't know about content format. |
| Remove `POST .../apply` route | Yes | No server-side restore. Client orchestrates via existing endpoints. |
| Keep `getSnapshot` RPC on DO | Yes | Returns `Y.encodeStateAsUpdateV2(restoredDoc)` — the full snapshot state as binary. Client needs this to reconstruct locally. |
| Safety snapshot before restore | Client calls `POST .../snapshots` with label "Before restore" | Explicit, not hidden. Client decides whether to save a safety snapshot. |
| Mode-aware restore | Match snapshot's content mode | Restoring a sheet snapshot should produce a sheet entry, not flattened CSV text. |
| Where client restore function lives | `@epicenter/workspace` — new export | Alongside `createTimeline` and `DocumentHandle`. Any app can use it. |

## Architecture

```
CLIENT (has @epicenter/workspace)          DO (DocumentRoom)
─────────────────────────────────          ──────────────────

1. Save safety snapshot ──────────────►  saveSnapshot('Before restore')
                                          └── Y.snapshot(this.doc) → SQLite

2. Fetch snapshot state ──────────────►  getSnapshot(id)
   ◄── binary update ────────────────    └── Y.createDocFromSnapshot → encode

3. Reconstruct snapshot doc locally
   const tempDoc = new Y.Doc({ gc: false })
   Y.applyUpdateV2(tempDoc, binary)

4. Read snapshot's timeline
   const snapshotTl = createTimeline(tempDoc)
   const entry = readEntry(snapshotTl.currentEntry)

5. Write to live doc's timeline
   (via DocumentHandle — same-mode or cross-mode)

6. CRDT ops sync naturally ───────────►  updateV2 handler persists + broadcasts
   tempDoc.destroy()
```

The DO only does step 1 and step 2 — pure data operations. Steps 3–6 use the timeline API that already exists.

## Implementation Plan

### Phase 1: Remove broken server-side restore

- [x] **1.1** Remove `applySnapshot()` method from `DocumentRoom` class in `apps/api/src/document-room.ts`
- [x] **1.2** Remove `POST /documents/:document/snapshots/:id/apply` route from `apps/api/src/app.ts`
- [x] **1.3** Typecheck: `bun run typecheck` in `apps/api`

### Phase 2: Add client-side restore function

- [x] **2.1** Create `restoreFromSnapshot` function in `packages/workspace/src/timeline/restore.ts` — takes a `DocumentHandle` and a snapshot binary (`Uint8Array`), performs the restore:
  - Creates temp Y.Doc, applies the binary update
  - Reads snapshot timeline entry via `readEntry(createTimeline(tempDoc).currentEntry)`
  - Writes to the live doc's timeline, matching mode:
    - `text` → `handle.write(snapshotText)` (in-place replacement on current entry)
    - `sheet` → `handle.batch(() => handle.timeline.pushSheetFromCsv(csv))`
    - `richtext` → `handle.batch(() => { pushRichtext(); populateFragmentFromText(...) })`
    - `empty` → no-op
  - Destroys temp doc
- [x] **2.2** Export `restoreFromSnapshot` from `packages/workspace/src/timeline/index.ts` and `packages/workspace/src/index.ts`
- [x] **2.3** Write tests in `packages/workspace/src/timeline/timeline.test.ts`:
  - Restore text snapshot → same mode: content matches, timeline length unchanged
  - Restore text snapshot → different mode: new entry pushed, content matches
  - Restore sheet snapshot → sheet entry restored with columns/rows
  - Restore empty snapshot → no-op
  - Temp doc is destroyed after restore

### Phase 3: Wire up in consuming app (if applicable)

- [x] **3.1** No UI calls the old `/apply` endpoint — no wiring needed.
  1. `POST /documents/:doc/snapshots` with label "Before restore"
  2. `GET /documents/:doc/snapshots/:id` to fetch binary
  3. Call `restoreFromSnapshot(handle, binary)`

## Edge Cases

### Restoring when the live doc's timeline is empty

`readEntry` returns `{ mode: 'empty' }` for the snapshot. The function is a no-op. No crash.

### Restoring when other clients are connected

The `handle.write()` / `handle.batch()` calls create local CRDT operations. The sync extension propagates them to the DO, which broadcasts to all peers. Connected clients see the restore in real time. Same as normal editing.

### Snapshot from before timeline migration

If a very old snapshot was captured when the doc used `getText('content')` instead of the timeline array, `createTimeline(tempDoc)` would return an empty timeline (`currentEntry` is undefined, `readEntry` returns `{ mode: 'empty' }`). Restore is a no-op. The old content in `getText('content')` is inaccessible through the timeline API—by design. Pre-migration snapshots are effectively view-only via the raw Y.Doc (accessible through `getSnapshot`).

### Temp doc cleanup on error

If `Y.applyUpdateV2` throws (corrupted binary), the function should still destroy the temp doc. Use try/finally.

## Open Questions

1. **Should `restoreFromSnapshot` accept a `DocumentHandle` or raw `Y.Doc` + `Timeline`?**
   - `DocumentHandle` is cleaner (single object, has `write()` and `batch()`), but couples to the workspace handle type.
   - Raw `Y.Doc` + `Timeline` is more flexible but requires the caller to manage transactions.
   - **Recommendation**: `DocumentHandle`. It's the canonical way to interact with content docs. The function signature: `restoreFromSnapshot(handle: DocumentHandle, snapshotBinary: Uint8Array): void`

2. **Should the safety snapshot be automatic or caller-managed?**
   - Automatic: `restoreFromSnapshot` always saves one (needs API access — breaks separation).
   - Caller-managed: client calls `saveSnapshot` before calling restore.
   - **Recommendation**: Caller-managed. Keep `restoreFromSnapshot` pure (Y.Doc operations only, no network). The client orchestrates the API calls.

3. **Should richtext restore preserve formatting or flatten to plaintext?**
   - The snapshot's `Y.XmlFragment` is a doc-backed type from the temp doc. Its content can't be transferred directly to the live doc's fragment (different Y.Doc instances).
   - ~~Flatten to plaintext, then `populateFragmentFromText` on the live doc's new fragment. Lossy but consistent.~~
   - **Resolved**: `Y.XmlElement.clone()` and `Y.XmlText.clone()` create deep, unattached copies that preserve formatting (bold, italic, headings, links). Clone each child from the snapshot's fragment and insert into the live fragment. No flattening needed.

## Success Criteria

- [x] `applySnapshot` method removed from `DocumentRoom`
- [x] `POST /documents/:document/snapshots/:id/apply` route removed from `app.ts`
- [x] `restoreFromSnapshot(handle, binary)` exists in `@epicenter/workspace`
- [x] Text restore: content matches snapshot, timeline doesn't grow (same-mode in-place)
- [x] Sheet restore: new sheet entry with correct columns/rows
- [x] Richtext restore: new richtext entry with formatting preserved via deep clone
- [x] Empty snapshot: no-op, no crash
- [x] Temp Y.Doc destroyed after restore (including on error)
- [x] `bun run typecheck` passes in `apps/api` and `packages/workspace`
- [x] Tests pass in `packages/workspace`

## References

- `apps/api/src/document-room.ts` — remove `applySnapshot`, keep all other snapshot RPCs
- `apps/api/src/app.ts` — remove the `/apply` route, keep all other snapshot routes
- `packages/workspace/src/timeline/timeline.ts` — `createTimeline`, `readEntry` (used by restore)
- `packages/workspace/src/workspace/create-document.ts` — `makeHandle` (the `DocumentHandle` factory, shows how write/asText/asSheet work)
- `packages/workspace/src/timeline/richtext.ts` — `xmlFragmentToPlaintext`, `populateFragmentFromText`
- `packages/workspace/src/timeline/sheet.ts` — `serializeSheetToCsv`, `parseSheetFromCsv`
- `specs/20260313T144805-document-snapshot-fixes.md` — superseded spec (used `getText('content')`)

## Review

**Completed**: 2026-03-15

### Summary

Moved snapshot restore from the Durable Object to the client. Removed the broken `applySnapshot()` method and its `/apply` route from the API, then added a pure `restoreFromSnapshot(ydoc, binary)` function in `@epicenter/workspace` that reads a snapshot's timeline and writes matching content to the live Y.Doc. The function is mode-aware (text, sheet, richtext, empty), uses try/finally for temp doc cleanup, and preserves richtext formatting via `Y.XmlElement.clone()`.

### Deviations from Spec

- **Phase 3 skipped**: No frontend code called the old `/apply` endpoint, so no UI wiring was needed.
- **Signature changed**: `restoreFromSnapshot` takes `Y.Doc` instead of `DocumentHandle`—removes cross-layer dependency, function lives in `timeline.ts` instead of a separate file.
- **Richtext is format-preserving**: Spec recommended plaintext flattening. After verifying Yjs source, `Y.XmlElement.clone()` deep-copies with formatting intact. Implemented clone approach instead of lossy flatten.

### Files Changed

- `apps/api/src/document-room.ts` — removed `applySnapshot()` method (lines 82–110)
- `apps/api/src/app.ts` — removed `POST .../snapshots/:id/apply` route (lines 607–621)
- `packages/workspace/src/timeline/timeline.ts` — `restoreFromSnapshot` function (inlined, no separate file)
- `packages/workspace/src/timeline/index.ts` — re-export `restoreFromSnapshot`
- `packages/workspace/src/index.ts` — re-export `restoreFromSnapshot`
- `packages/workspace/src/timeline/timeline.test.ts` — 6 tests for restore (including formatting preservation)

### Follow-up Work

- Pre-migration snapshot handling UI (snapshots from before timeline migration are no-ops—consider surfacing this to users)
