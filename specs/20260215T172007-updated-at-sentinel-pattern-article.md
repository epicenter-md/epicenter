# The `updatedAt` Sentinel Pattern for External Yjs Docs

## problem

in the split-doc architecture ("only the leaves need revision history"), metadata and content live in separate yjs documents. the metadata doc is always loaded and observed; content docs load on demand. but when a content doc changes, the metadata doc's observers don't fire. downstream systems (persistence, ui, indexes) have no signal that something happened.

## pattern

store an `updatedat` timestamp in the metadata row for each external content doc. bump it whenever the content doc is written to. this causes the metadata table's `.observe()` to fire, bridging the observation gap between the two layers.

```
metadata y.doc (gc: true, always loaded)
├── files table
│   ├── { id: 'abc', name: 'api.md', updatedat: 1739... }  ← bumped on content write
│   └── { id: 'def', name: 'index.ts', updatedat: 1739... }
│
content y.doc (gc: false, loaded on demand)     ← one per file
└── y.text('content')

write flow:
  1. user edits content doc 'abc'
  2. contentops.write('abc', data) writes to content y.doc
  3. filetree.touch('abc', size) bumps updatedat in metadata row
  4. metadata table observers fire → persistence, indexes, ui react
```

## Implementation (existing)

The filesystem package already implements this pattern:

### Schema

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
    updatedAt: 'number',       // ← the sentinel
    trashedAt: 'number | null',
  }),
);
```

### Write path

```typescript
// yjs-file-system.ts: writeFile calls content write, then touches metadata
async writeFile(path, data) {
  // ... resolve path, create row if needed ...
  const size = await this.content.write(id, data);  // write to content Y.Doc
  this.tree.touch(id, size);                         // bump updatedAt in metadata
}

// file-tree.ts: touch updates the sentinel
touch(id: FileId, size: number): void {
  this.filesTable.update(id, { size, updatedAt: Date.now() });
}
```

### Observer chain

```typescript
// file-system-index.ts: observes metadata table, rebuilds indexes
const unobserve = filesTable.observe(() => {
  rebuild();  // fires when updatedAt changes, among other things
});

// desktop.ts: persistence observes the Y.Doc for any update
ydoc.on('update', () => {
  const state = Y.encodeStateAsUpdate(ydoc);
  writeFileSync(filePath, state);
});
```

## 1:1 case (one content doc per row)

When each row maps to exactly one external doc, a single `updatedAt` field is enough. The row's `id` doubles as the content doc's GUID. This is the filesystem's approach.

## 1:N case (multiple content docs per row)

When a row references multiple external docs (e.g., a `code` doc and a `preview` doc stored in separate columns), use per-column sentinels:

```typescript
const articlesTable = defineTable(
  type({
    id: ArticleId,
    title: 'string',
    // ... other fields ...
    codeUpdatedAt: 'number',     // ← tracks code content doc
    previewUpdatedAt: 'number',  // ← tracks preview content doc
  }),
);
```

Each sentinel gets bumped independently when its corresponding content doc changes. Consumers can watch specific sentinel columns for fine-grained reactivity rather than reacting to every content change on the row.

## What this enables

| Consumer | How it uses the sentinel |
|---|---|
| Persistence | "Has this file changed since I last saved?" Compare `updatedAt` > `lastPersistedAt` |
| UI (file tree) | Metadata table observer fires → re-render file list with updated mtime |
| Cache invalidation | Skip re-processing files whose `updatedAt` hasn't moved |
| Selective sync | Only persist content docs whose sentinel advanced |

## Implementation considerations

- Use `Date.now()` for the timestamp. Lamport-like timestamps (as in YKeyValueLww) are overkill here since the sentinel doesn't need conflict resolution semantics; it just needs to be "different from before."
- The touch must happen immediately after the content write, not inside the content doc's transaction (they're separate Y.Docs, so they can't share a Yjs transaction).
- The metadata doc has `gc: true`, so old sentinel values compact away. No storage bloat from frequent updates.

## Deliverables

- [x] Spec at `specs/20260215T172007-updated-at-sentinel-pattern-article.md`
- [x] Article at `docs/articles/updated-at-sentinel-for-external-yjs-docs.md`

## Related

- [Only the Leaves Need Revision History](../articles/only-the-leaves-need-revision-history.md)
- [YKeyValue Timestamp Expansion](../articles/ykeyvalue-timestamp-expansion.md)
- [Debouncing Doesn't Lose Data When the Source is Separate](../articles/debouncing-with-separate-source-of-truth.md)
