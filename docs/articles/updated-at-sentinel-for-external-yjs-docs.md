# Touch `updatedAt` When Content in a Separate Yjs Doc Changes

Think of Google Drive's file list. It's always loaded, renders instantly, and each row is metadata plus a pointer to a document stored elsewhere. In our [split-doc architecture](./only-the-leaves-need-revision-history.md), the files table works the same way: each row stores a name, size, and timestamps, and the row's `id` doubles as the GUID of a separate Yjs content document that loads on demand.

That separation creates a blind spot. When someone edits a content doc, nothing in the metadata row changes, so everything watching the files table (persistence, the file tree UI, "recently modified" sorting) sees no event. The fix: touch `updatedAt` on the metadata row every time the referenced content changes. One cheap metadata write makes content edits visible to every observer without loading all content docs.

## The blind spot

```
Metadata Y.Doc (gc: true, always loaded)
├── files table
│   ├── { id: 'abc', name: 'api.md', size: 2048, updatedAt: ... }
│   └── { id: 'def', name: 'index.ts', size: 512, updatedAt: ... }

Content Y.Doc 'abc' (gc: false, loaded on demand)
└── Y.Array('timeline')  →  [{ type: 'text', content: Y.Text('# API Reference\n...') }]

Content Y.Doc 'def' (gc: false, loaded on demand)
└── Y.Array('timeline')  →  [{ type: 'text', content: Y.Text('export function main() {...') }]
```

A user opens `api.md` and starts typing. Content doc `abc` gets updated, but the files table row still has the same name, same size, same `updatedAt`. No observer fires. Persistence doesn't save. The UI doesn't reflect the edit. The reference doesn't propagate change events.

You could observe each content doc individually, but that defeats lazy loading. You'd have to load every content doc in the workspace just to watch for changes.

## The fix

On every content write, also write `updatedAt` (and `size`) back to the metadata row. This is the "touch": a tiny metadata update whose only purpose is to make content changes visible to observers.

```typescript
// file-table.ts
export const filesTable = defineTable(
  type({
    id: FileId,
    name: 'string',
    parentId: FileId.or(type.null),
    type: "'file' | 'folder'",
    size: 'number',
    createdAt: 'number',
    updatedAt: 'number',       // ← touched on every content write
    trashedAt: 'number | null',
  }),
);
```

The write path touches both docs in sequence:

```typescript
// yjs-file-system.ts
async writeFile(path, data) {
  // ... resolve path, get file ID ...
  const size = await this.content.write(id, data);  // 1. write content doc
  this.tree.touch(id, size);                         // 2. touch metadata row
}

// file-tree.ts
touch(id: FileId, size: number): void {
  this.filesTable.update(id, { size, updatedAt: Date.now() });
}
```

From the metadata layer's perspective, this looks like any other table update:

```
User types in editor
       │
       ▼
Content Y.Doc 'abc'          Metadata Y.Doc
  Y.Text updated       →      filesTable.update('abc', {
                                 size: 2150,
                                 updatedAt: 1739612345678
                               })
                                      │
                              ┌───────┴────────┐
                              ▼                ▼
                        Persistence       File tree UI
                        re-saves doc      shows modified indicator
```

Every system already watching the metadata table now reacts to content changes for free.

## Routing: which rows get touched?

When each row points to exactly one content doc (1:1), a single `updatedAt` field is enough. This is how the filesystem package works: file `abc` has metadata row `abc` and content doc with guid `abc`. The `updatedAt` value does double duty as both an observer trigger and the mtime shown in the file tree (via `stat()` reading `new Date(row.updatedAt)`).

When a row references multiple content docs (1:N), one `updatedAt` can't tell you which content changed. An article might have a `code` doc and a `preview` doc; a cell might have a `formula` doc and a `result` doc. Use per-reference timestamps instead:

```typescript
const articlesTable = defineTable(
  type({
    id: ArticleId,
    title: 'string',
    code: ContentDocId,            // references the code content doc
    preview: ContentDocId,         // references the preview content doc
    codeUpdatedAt: 'number',      // touched when code doc changes
    previewUpdatedAt: 'number',   // touched when preview doc changes
  }),
);
```

Each timestamp moves independently. A consumer that only cares about code changes watches `codeUpdatedAt` and ignores preview updates. The naming convention follows the reference column: `code` → `codeUpdatedAt`, `preview` → `previewUpdatedAt`. For 1:1 where the row ID is the only reference, plain `updatedAt` works.

## Implementation notes

The metadata doc uses `gc: true`, so old timestamp values get tombstoned and compacted. Frequent touches don't grow storage.

Conflict resolution is a non-issue. The timestamp's job is to be different from its previous value, not to be a globally accurate clock. Two users touching `updatedAt` concurrently resolve via LWW; either value triggers observers, so the exact winner doesn't matter.

The content write and the metadata touch can't share a Yjs transaction because they're different Y.Docs. Both happen in the same synchronous call chain, so the gap is negligible in practice.

## What this enables

| Consumer | Mechanism |
|---|---|
| Persistence | Compare `updatedAt > lastPersistedAt` to decide which docs need saving |
| File tree UI | Metadata table observer fires; re-render with new mtime |
| Cache invalidation | Skip re-processing files whose timestamp hasn't moved |
| Selective sync | Only transfer content docs whose timestamp advanced |

Instead of watching N content docs, you watch one metadata table.

---

Related:

- [Only the Leaves Need Revision History](./only-the-leaves-need-revision-history.md): The split-doc architecture this pattern builds on
- [YKeyValue Conflict Resolution](./ykeyvalue-timestamp-expansion.md): Timestamp semantics in YKeyValueLww
- [Debouncing Doesn't Lose Data When the Source is Separate](./debouncing-with-separate-source-of-truth.md): Persistence patterns that pair well with this approach
