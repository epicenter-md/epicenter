# Document Snapshot Fixes

**Date**: 2026-03-13
**Status**: Implemented
**Author**: AI-assisted

## Overview

Fix the broken `applySnapshot()` in `DocumentRoom` and add a delete endpoint. Two changes, two files.

## Motivation

### Current State

The `DocumentRoom` Durable Object has snapshot support: save, list, get, and apply. The REST endpoints exist and are wired through `app.ts`. Here's the current `applySnapshot()`:

```typescript
// apps/api/src/document-room.ts
async applySnapshot(snapshotId: number): Promise<boolean> {
    const past = await this.getSnapshot(snapshotId);
    if (!past) return false;

    await this.saveSnapshot('Before restore');
    Y.applyUpdateV2(this.doc, past, 'restore');
    return true;
}
```

Where `getSnapshot()` reconstructs via:

```typescript
const snap = Y.decodeSnapshot(new Uint8Array(row.snapshot as ArrayBuffer));
const restoredDoc = Y.createDocFromSnapshot(this.doc, snap);
return Y.encodeStateAsUpdateV2(restoredDoc);
```

**`applySnapshot()` is a no-op.** `Y.createDocFromSnapshot(this.doc, snap)` builds a doc from `this.doc`'s struct store—every item already exists in `this.doc`. Encoding that doc as an update and applying it back adds zero new struct items (CRDTs are idempotent). The delete set from the snapshot is a subset of the current delete set, and Yjs delete sets only grow via union. Net result: the visible content doesn't change, but the method returns `true`.

There is also no way to delete a snapshot.

### Desired State

`applySnapshot()` restores the document by creating new CRDT operations (delete current text + insert snapshot text), making the restore an append-only event in the timeline. A delete endpoint lets users manage their own snapshot history.

After this fix, the full snapshot API:

| Method | Endpoint | What it does |
|---|---|---|
| `GET` | `/documents/:doc/snapshots` | List all snapshots |
| `POST` | `/documents/:doc/snapshots` | Save a new snapshot |
| `GET` | `/documents/:doc/snapshots/:id` | Get snapshot binary |
| `DELETE` | `/documents/:doc/snapshots/:id` | Delete a snapshot |
| `POST` | `/documents/:doc/snapshots/:id/apply` | Restore from a snapshot |
## Research Findings

### Yjs Snapshot Internals

`Y.snapshot(doc)` captures a lightweight state vector + delete set (~7 bytes to ~1.5 KB). `Y.createDocFromSnapshot(originDoc, snapshot)` reconstructs a read-only doc by walking the origin doc's struct store—it requires `gc: false` on the origin (which `DocumentRoom` has).

The reconstructed doc is designed for *reading* past state, not for applying back. The Yjs README documents `createDocFromSnapshot` as a way to "create a document from a snapshot for rendering," not for restoration.

**Key finding**: there is no built-in `Y.restoreFromSnapshot()` API. Restoration requires content-level replacement—read text from the snapshot doc, delete current text, insert snapshot text. This creates proper new CRDT operations.

### Forward-Merge vs Content Replacement

| Approach | Mechanism | Result |
|---|---|---|
| Forward-merge (`Y.applyUpdateV2`) | Re-apply old update to current doc | No-op—items already exist |
| Content replacement (delete + insert) | Read old content, replace current | New CRDT ops, visible change |

Content replacement is correct. It's also append-only: the delete and insert operations are new entries in the struct store. With `gc: false`, the pre-restore content is still in the struct store and could be recovered by a later snapshot restore.

For server-side restoration, full delete + insert is acceptable. CRDT identity preservation only matters for concurrent editing—restoration is an intentional, non-concurrent action.

## Design Decisions

| Decision | Choice | Rationale |
|---|---|---|
| Restoration mechanism | Full delete + insert in a transaction | No new deps in the DO. CRDT identity preservation isn't needed for intentional restores. |
| Shared type support | `Y.Text('content')` only | Current documents use Y.Text. Add other types when needed. |
| Delete behavior | Hard delete from SQLite | Snapshots are lightweight metadata (~7B–1.5KB). No soft-delete complexity needed. |
| Safety snapshot before restore | Keep existing behavior | The "Before restore" auto-save lets users undo a bad restore. |
| No pruning | Users delete manually | Not enough usage data to pick a retention policy. Storage cost is negligible. |
| No schema changes | `CREATE TABLE` unchanged | No new columns needed for these two changes. |

## Architecture

```
DocumentRoom (gc: false)
├── snapshots table (SQLite)    (unchanged)
│
├── saveSnapshot(label?)        (unchanged)
├── listSnapshots()             (unchanged)
├── getSnapshot(id)             (unchanged)
├── applySnapshot(id)           ← FIXED: content replacement, not forward-merge
└── deleteSnapshot(id)          ← NEW: hard delete from SQLite
```

One new DELETE route in `app.ts`. No other endpoint changes.

## Implementation Plan

- [x] **1** Fix `applySnapshot(id)` in `document-room.ts`:
  - Fetch snapshot blob directly from SQLite (bypass `getSnapshot()`)
  - Decode via `Y.decodeSnapshot()`, reconstruct via `Y.createDocFromSnapshot(this.doc, snap)`
  - Read restored text: `restoredDoc.getText('content').toString()`
  - Save safety snapshot: `this.saveSnapshot('Before restore')`
  - In a single `this.doc.transact()`: delete all current text, insert restored text
- [x] **2** Add `deleteSnapshot(id)` RPC method to `DocumentRoom` — `DELETE FROM snapshots WHERE id = ?`, return boolean
- [x] **3** Add `DELETE /documents/:document/snapshots/:id` route in `app.ts` — validate param, call `stub.deleteSnapshot()`, return 204 or 404

## Edge Cases

### Restoring a document with no `content` Y.Text

`this.doc.getText('content')` returns an empty Y.Text (Yjs creates shared types lazily). Delete of 0 characters and insert of empty string are both no-ops. Restore succeeds, nothing changes. Correct.

### Restoring when other clients are connected

`this.doc.transact()` fires the `updateV2` handler, which persists to the update log and broadcasts to all WebSocket peers. Connected clients see the restore in real time.

### Concurrent snapshot during restore

`doc.transact()` is atomic. An auto-save from a disconnecting client captures either pre-restore or post-restore state, never mid-restore.

### Deleting a snapshot that was already applied

No effect on the live document. The restore created new CRDT operations that live in the struct store independently. Deleting the snapshot removes the metadata row only.

## Open Questions

1. **What about Y.XmlFragment or Y.Map content?**
   - The fix only handles `Y.Text('content')`. Other shared types are silently skipped.
   - **Recommendation**: add support when a real consumer uses structured content in documents.

## Success Criteria

- [ ] `applySnapshot()` changes the visible text content of the document to match the snapshot
- [ ] Restoring creates new CRDT operations (visible in the update log as deletes + inserts)
- [ ] The "Before restore" safety snapshot captures pre-restore content
- [ ] Connected WebSocket clients receive the content change after restore
- [ ] `DELETE /documents/:document/snapshots/:id` removes the snapshot row and returns 204
- [ ] Deleting a nonexistent snapshot returns 404
- [ ] `bun run typecheck` passes in `apps/api`

## References

- `apps/api/src/document-room.ts` — both changes live here
- `apps/api/src/app.ts` — one new DELETE route
- `apps/api/src/base-sync-room.ts` — parent class (unchanged, context only)

## Review

**Completed**: 2026-03-13

### Summary

Replaced the no-op CRDT forward-merge in `applySnapshot()` with content-level replacement (delete + insert in a transaction). Added `deleteSnapshot()` RPC and the corresponding `DELETE` route in `app.ts`.

### Deviations from Spec

None. Implementation matched the spec exactly.

### Follow-up Work

- Update the `applySnapshot` route's `describeRoute` description (still says "CRDT forward-merge").
