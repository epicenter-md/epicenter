# Simplify Content Doc Lifecycle: Drop Pool + Cache, Serialize on Demand

**Date**: 2026-02-09T00:00:00
**Status**: Implemented
**Parent**: `specs/20260208T000000-yjs-filesystem-spec.md`
**Implemented by**: `specs/20260211T100000-simplified-ytext-content-store.md` (further superseded by `specs/20260211T230000-timeline-content-storage-implementation.md`): the simplification went further than this spec planned. Pool and cache were dropped. `openDocument()`/`documentHandleToString()` were removed entirely. `ContentDocStore` kept as `ensure`/`destroy`/`destroyAll`. The ensure/heal/open pipeline was simplified to just `ensure`: no healing, no document handles.
**See also**: `specs/20260211T220000-yjs-content-doc-multi-mode-research.md`: `ContentDocStore` remains unchanged under Option F. The timeline changes what's inside each Y.Doc, not how Y.Doc lifecycle is managed.

> **Note (2026-02-11)**: The `mv()` type-changing rename concept is eliminated entirely: all files use `Y.Text('content')`, so `mv()` is always metadata-only. No `store.destroy()` in `mv()`, no healing, no conversion.

## Problem

The current content doc system has two mechanisms that add complexity without proportional benefit:

1. **ContentDocPool**: reference-counted acquire/release lifecycle for per-file Y.Docs. In practice, every filesystem operation (readFile, writeFile) acquires and releases in the same synchronous scope. The refcount never exceeds 1 in headless usage. The pool exists for a UI editor scenario that doesn't exist yet.

2. **Plaintext cache** (`index.plaintext: Map<FileId, string>`): manually invalidated string cache with **zero observers** on per-file Y.Docs. If a remote collaborator, editor, or provider writes to a Y.Doc, the cache goes stale silently. Adding observers would require loading every Y.Doc into memory, defeating lazy loading entirely.

### Why the cache is fundamentally broken

The cache is updated in exactly 5 places, all inside `YjsFileSystem`:

- `readFile()` populates it after serializing
- `writeFile()` updates it after writing
- `rm()` deletes it
- `mv()` with type change deletes it
- `softDeleteDescendants()` deletes it

Any write that bypasses `YjsFileSystem`: a provider sync, an editor writing directly to the Y.Doc, a remote collaborator: leaves the cache stale. There are no Y.Doc observers to catch this.

### Why acquire/release adds ceremony without value

Every filesystem operation follows the same pattern:

```typescript
const handle = this.pool.acquire(id, row.name);
try {
	/* use handle */
} finally {
	this.pool.release(id);
}
```

The pool creates a Y.Doc on acquire and destroys it on release. For `writeFile`, this means every single write creates and destroys a Y.Doc. There is no cross-operation reuse.

---

## Proposal: ContentDocStore: a Y.Doc Lifecycle Manager

Replace the pool and cache with a **ContentDocStore**: a data structure that manages the lifecycle of many per-file Y.Docs. It holds live `Y.Doc` instances keyed by `FileId`. That's all it does.

The store has **zero domain knowledge**. It doesn't know about file names, document types (richtext vs text), markdown, or frontmatter. All type discrimination stays with the caller (the filesystem), which already has the file metadata and knows the file name.

### ContentDocStore interface

```typescript
import type * as Y from 'yjs';
import type { FileId } from './types.js';

export type ContentDocStore = {
	/** Get or create a Y.Doc for a file. Idempotent: returns existing if already created. */
	ensure(fileId: FileId): Y.Doc;
	/** Destroy a specific file's Y.Doc. Called when a file is deleted. No-op if not created. */
	destroy(fileId: FileId): void;
	/** Destroy all Y.Docs. Called on filesystem/workspace shutdown. */
	destroyAll(): void;
};
```

Three methods. No `fileName`, no `DocumentHandle`, no `peek`, no refcount.

### Implementation

```typescript
export function createContentDocStore(): ContentDocStore {
	const docs = new Map<FileId, Y.Doc>();

	return {
		ensure(fileId: FileId): Y.Doc {
			const existing = docs.get(fileId);
			if (existing) return existing;

			const ydoc = new Y.Doc({ guid: fileId, gc: false });
			docs.set(fileId, ydoc);
			return ydoc;
		},

		destroy(fileId: FileId): void {
			const ydoc = docs.get(fileId);
			if (!ydoc) return;
			ydoc.destroy();
			docs.delete(fileId);
		},

		destroyAll(): void {
			for (const ydoc of docs.values()) {
				ydoc.destroy();
			}
			docs.clear();
		},
	};
}
```

~25 lines. No domain logic whatsoever.

### How the filesystem uses it

The filesystem already has `row.name` from its metadata lookup. It calls the domain-specific helpers (`healContentType`, `openDocument`, `documentHandleToString`) itself. These are just utility functions, not part of the store.

```typescript
// readFile: always serialize from live Y.Doc
async readFile(path: string): Promise<string> {
  const resolved = posixResolve(this.cwd, path);
  const id = this.resolveId(resolved);
  const row = this.getRow(id, resolved);
  if (row.type === 'folder') throw fsError('EISDIR', resolved);

  const ydoc = this.store.ensure(id);
  healContentType(ydoc, row.name);
  const handle = openDocument(id, row.name, ydoc);
  return documentHandleToString(handle);
}

// writeFile: write to live Y.Doc, no release needed
async writeFile(path: string, data: string): Promise<void> {
  // ...resolve/create file metadata...
  const ydoc = this.store.ensure(id);
  healContentType(ydoc, row.name);
  const handle = openDocument(id, row.name, ydoc);
  if (handle.type === 'text') {
    handle.ydoc.transact(() => {
      handle.content.delete(0, handle.content.length);
      handle.content.insert(0, content);
    });
  } else {
    const { frontmatter, body } = parseFrontmatter(content);
    updateYMapFromRecord(handle.frontmatter, frontmatter);
    updateYXmlFragmentFromString(handle.content, body);
  }
  // ...update metadata...
}

// rm: destroy the Y.Doc when file is deleted
async rm(path: string, options?: RmOptions): Promise<void> {
  // ...soft delete metadata...
  this.store.destroy(id);
}
```

No try/finally. No cache set/delete. No acquire/release.

**Why `openDocument` on every call is fine:** `ydoc.getXmlFragment('richtext')` and `ydoc.getText('text')` are just lookups on the Y.Doc's internal shared types map. They return the same instance every time. Creating a `DocumentHandle` is essentially free: it's just wrapping references that already exist.

**Why `healContentType` on every call is fine:** It's idempotent. It checks if content is in wrong-type keys and migrates if needed. If content is already in the right place, it's a no-op (a few empty-string checks).

### How an editor uses it (future)

```typescript
// Editor opens a file: gets the same Y.Doc the filesystem uses
const ydoc = store.ensure(fileId);

// Attach providers for persistence + sync (editor's responsibility)
const persistence = new IndexeddbPersistence(fileId, ydoc);
const provider = new WebsocketProvider(url, fileId, ydoc);

// Editor binds to the shared types directly
const content = ydoc.getXmlFragment('richtext'); // same instance filesystem uses
const frontmatter = ydoc.getMap('frontmatter');

// Any edits propagate through the live Y.Doc
// Next readFile() serializes the latest state: always correct

// Editor closes: disconnect sync, Y.Doc stays alive in store
provider.destroy();
persistence.destroy();
```

### Architecture diagram

```
Main Y.Doc (gc: true, always loaded)
  └── Y.Array('table:files')  →  file metadata rows (YKeyValueLww)

ContentDocStore (pure Y.Doc lifecycle manager)
  └── Map<FileId, Y.Doc>
        ├── "abc-123" → Y.Doc { guid: "abc-123", gc: false }
        ├── "def-456" → Y.Doc { guid: "def-456", gc: false }
        └── ...
      Created lazily via .ensure(), destroyed via .destroy() or .destroyAll()

                              ┌─────────────────────┐
                              │  openDocument()      │  ← utility function
                              │  healContentType()   │  ← utility function
                              │  documentHandleToString() │
                              └──────────┬──────────┘
                                         │ called by
                              ┌──────────┴──────────┐
                              │  YjsFileSystem       │  ← has row.name from metadata
                              │  (the caller)        │
                              └─────────────────────┘

Runtime Indexes (ephemeral JS Maps, rebuilt from files table)
  ├── pathToId:    Map<string, FileId>
  └── childrenOf:  Map<FileId | null, FileId[]>
  (no plaintext cache)
```

---

## Responsibility layers (clean separation)

| Concern                                     | Owner                              | Knows about                          |
| ------------------------------------------- | ---------------------------------- | ------------------------------------ |
| Y.Doc lifecycle (create, hold, destroy)     | `ContentDocStore`                  | FileId, Y.Doc. Nothing else.         |
| File type discrimination (richtext vs text) | `openDocument()` utility           | fileName extension                   |
| Content type healing                        | `healContentType()` utility        | fileName extension, Y.Doc keys       |
| Serialization (Y.Doc → string)              | `documentHandleToString()` utility | DocumentHandle                       |
| POSIX API + metadata                        | `YjsFileSystem`                    | Everything above, orchestrates calls |
| Provider attachment (IndexedDB, WebSocket)  | App/editor layer                   | Y.Doc instance from store            |

---

## What changes

### Files modified

| File                                                     | Change                                                                                                                                                                                                                                                                                                 |
| -------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `content-doc-pool.ts` → `content-doc-store.ts`           | Replace entire `createContentDocPool` with `createContentDocStore` (~25 lines). Remove `PoolEntry` type. Keep `openDocument`, `documentHandleToString` as standalone utility exports.                                                                                                                  |
| `types.ts`                                               | Replace `ContentDocPool` type with `ContentDocStore` (3 methods instead of 4). Remove `plaintext` from `FileSystemIndex`.                                                                                                                                                                              |
| `yjs-file-system.ts`                                     | Replace `pool: ContentDocPool` with `store: ContentDocStore`. Replace `pool.acquire`/`pool.release` pattern with `store.ensure` + `openDocument`. Remove all `index.plaintext` references (8 occurrences). Remove try/finally release blocks. Add `store.destroy(id)` in `rm`/`softDeleteDescendants`. |
| `file-system-index.ts`                                   | Remove `plaintext` map creation (line 17), return (line 69), and comment (line 29).                                                                                                                                                                                                                    |
| `content-doc-pool.test.ts` → `content-doc-store.test.ts` | Rewrite: test ensure idempotency, destroy cleanup, destroyAll. Remove refcount/release/loadAndCache tests.                                                                                                                                                                                             |
| `yjs-file-system.test.ts`                                | No changes expected: tests use readFile/writeFile which behave the same.                                                                                                                                                                                                                              |
| `index.ts`                                               | Update re-exports for renamed file.                                                                                                                                                                                                                                                                    |

### What gets deleted

- `ContentDocPool` type (acquire/release/peek/loadAndCache)
- `PoolEntry` type (refcount tracking)
- `createContentDocPool()` factory (refcount logic, provider bundling)
- `loadAndCache()` method
- `connectProvider` callback parameter
- `index.plaintext` map and all 5 manual invalidation sites
- try/finally release blocks in writeFile
- `ROOT_ID` sentinel (already replaced by `null` for root)

### What stays (as utility functions, not on the store)

- `openDocument(fileId, fileName, ydoc)` → creates typed `DocumentHandle` from a Y.Doc
- `documentHandleToString(handle)` → serializes handle to string
- `healContentType(ydoc, fileName)` → fixes content in wrong-type keys
- `DocumentHandle`, `TextDocumentHandle`, `RichTextDocumentHandle` types

---

## Performance tradeoffs

### Read performance

| Scenario                   |    Current (cache)     |   Proposed (serialize on demand)   |
| -------------------------- | :--------------------: | :--------------------------------: |
| readFile (warm, same file) | ~0.001ms (Map lookup)  | ~0.05-0.1ms (serialize from Y.Doc) |
| grep 100 files (all warm)  |      ~0.1ms total      |           ~5-10ms total            |
| readFile after remote edit | **returns stale data** |           always correct           |

In absolute terms: grep 100 files goes from 0.1ms to 10ms. Both are imperceptible.

### Write performance (improves)

| Scenario                          |         Current (pool)         |         Proposed (store)          |
| --------------------------------- | :----------------------------: | :-------------------------------: |
| writeFile (cold)                  | create Y.Doc + write + destroy | create Y.Doc + write (kept alive) |
| writeFile (warm)                  | create Y.Doc + write + destroy |        reuse Y.Doc + write        |
| 10 sequential writes to same file |    10 create/destroy cycles    |       1 create + 10 writes        |

### Memory

- Typical source file Y.Doc: 1-50 KB
- Workspace with 200 files, 50 touched in session: ~0.5-2.5 MB
- Not a concern at workspace scale

---

## Provider separation

| Concern                    | Owner            | When                              |
| -------------------------- | ---------------- | --------------------------------- |
| Y.Doc creation/destruction | ContentDocStore  | `.ensure()` / `.destroy()`        |
| IndexedDB persistence      | App/editor layer | When file is opened in UI         |
| WebSocket sync             | App/editor layer | When collaborative editing starts |

The store doesn't know about providers. The filesystem doesn't know about providers. The editor attaches them to the Y.Doc it gets from the store.

---

## Migration steps

1. Add `ContentDocStore` type to `types.ts`
2. Implement `createContentDocStore()` in new `content-doc-store.ts`
3. Update `YjsFileSystem` constructor to accept `ContentDocStore` instead of `ContentDocPool`
4. Replace all pool.acquire/release with store.ensure + openDocument/healContentType
5. Remove all `index.plaintext` references from `yjs-file-system.ts`
6. Remove `plaintext` from `FileSystemIndex` type and `createFileSystemIndex()`
7. Remove `ContentDocPool`, `PoolEntry`, `createContentDocPool`, `loadAndCache`
8. Delete `content-doc-pool.ts`, update `index.ts` exports
9. Rewrite tests for new semantics
