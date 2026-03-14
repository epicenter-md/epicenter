# Only the Leaves Need Revision History

**TL;DR: Split your Yjs architecture into a metadata doc (gc: true) for structure and separate per-content docs (gc: false) for editable text, loaded on demand—the same split Google Drive uses between file metadata and document content.**

> Structure is cheap. History is expensive. Only pay for history where users actually edit.

Think about Google Drive. The file list is instant. You see names, dates, sizes, folder structure. None of that has revision history. You can't "undo" a rename or roll back a folder move. But open a Google Doc and you get full revision history for every character ever typed.

That's the pattern. The structural layer (your file tree, row metadata, settings) is disposable CRDT state where garbage collection merges tombstones into nothing. The content layer (rich text, code, documents) preserves full history for snapshots and undo.

The architectural question is: where do you draw the line?

## The split

```
Metadata Y.Doc (gc: true, always loaded)
├── Y.Array('table:files')
│   ├── { key: 'abc', val: { id: 'abc', name: 'api.md', parentId: 'src', ... }, ts: ... }
│   ├── { key: 'def', val: { id: 'def', name: 'index.ts', parentId: 'src', ... }, ts: ... }
│   └── ...
└── Y.Array('kv')
    └── { key: 'theme', val: 'dark', ts: ... }

Content Y.Doc (gc: false, loaded on demand)          ← one per file
└── Y.Array('timeline')  →  [{ type: 'text', content: Y.Text }]
```

The metadata doc is a single document containing all your structural data: file names, parent IDs, timestamps, settings. It's small and always in memory. Garbage collection is on, so tombstones from updates get merged into a few bytes.

Each content doc is a separate top-level Y.Doc that holds one shared type. It uses the file's ID as its GUID, so `abc` in the files table maps directly to a Y.Doc with guid `abc`. GC is off, enabling Y.Snapshots for revision history.

The connection between them is a plain string: the file row's `id` field doubles as the content doc's GUID. No composite keys, no lookup tables, no subdocument API.

## Why string IDs, not Yjs subdocuments

Yjs has a subdocument system where you embed a Y.Doc inside a Y.Map. It handles lifecycle management and emits events when subdocs are added or loaded. On paper it sounds right.

In practice, almost no provider supports it. y-websocket, y-indexeddb, y-sweet, and Hocuspocus all treat subdocuments as opaque blobs or don't handle them at all. AFFiNE went the subdoc route and had to build a complete custom provider stack to make it work.

Separate top-level docs avoid this entirely. Every provider already knows how to sync a Y.Doc by GUID. You create one, connect it to your provider, and you're done. The files table already enumerates every document GUID, so you don't lose the discovery that subdocs give you.

```
Subdocument approach:
  Parent Y.Doc → embeds child Y.Doc → provider must understand nesting

  ✗ Most providers don't support this

Separate doc approach:
  Metadata Y.Doc (guid: 'workspace-1')     ← provider syncs normally
  Content Y.Doc  (guid: 'abc')             ← provider syncs normally
  Content Y.Doc  (guid: 'def')             ← provider syncs normally

  ✓ Every provider supports this
```

## Why the GC split matters

The `gc` boolean isn't just organizational; it completely changes the storage economics of your Yjs data structures.

With GC on, a YKeyValueLww store that has 10 keys updated 1,000 times each uses 446 bytes. The same operations with GC off: 392 KB. That's 878x larger. Every update creates a tombstone for the old entry, and without GC those tombstones live forever. (See [YKeyValue vs Y.Map: GC Is the Hidden Variable](./ykeyvalue-gc-the-hidden-variable.md) for the full benchmark.)

For content docs, the calculus is different. A Y.Text with revision history needs those tombstones. They're what let you reconstruct any previous state via `Y.snapshot()`. The overhead is proportional to edit history, not current content size, and it's the price of time travel.

The split lets you pay for history only where it matters:

| Layer | GC | Why |
|---|---|---|
| File metadata (names, parents, timestamps) | on | LWW row updates. No undo needed. Tombstones compact to nothing. |
| KV settings (theme, language, view config) | on | Infrequent updates. No revision history. |
| Text content (code files) | off | Character-level edits need snapshots for version history. |
| Rich text content (markdown docs) | off | ProseMirror tree edits need snapshots for version history. |

## One key per content doc

Most Yjs editor integrations use a single shared type per document. This is the dominant pattern across the ecosystem:

| Editor | Call | Key name |
|---|---|---|
| ProseMirror / Tiptap | `doc.getXmlFragment('prosemirror')` | `'prosemirror'` |
| CodeMirror | `doc.getText('codemirror')` | `'codemirror'` |
| BlockNote | `doc.getXmlFragment('document-store')` | `'document-store'` |
| Lexical | `doc.getXmlElement('root')` | `'root'` |
| Plain text | `doc.getText('content')` | `'content'` |

A Y.Doc with one root-level key isn't a code smell. It's the norm. The doc is the unit of loading, syncing, and revision history. One key inside it is all you need.

Name the key after what it represents or after the editor binding. `'content'` is the generic choice. If you're specifically binding to ProseMirror, `'prosemirror'` is the convention from y-prosemirror. Either works; just be consistent.

One caveat: Yjs permanently locks a root-level key to whichever shared type is accessed first. If you call `getText('content')` on a doc, that key is bound to Y.Text forever. Calling `getXmlFragment('content')` on the same doc throws. If you need to support both plain text and rich text on the same doc (like a file that can be renamed from `.ts` to `.md`), use separate keys:

```typescript
// Two keys, one active at a time
ydoc.getText('text')            // active for .ts, .js, .py, etc.
ydoc.getXmlFragment('richtext') // active for .md
```

## Lazy loading falls out naturally

The metadata doc is always loaded because it's small and you need it for navigation: file trees, table views, search indexes. It holds the structure of everything without the weight of any content.

Content docs load on demand. Opening a file creates a `new Y.Doc({ guid: fileId, gc: false })`, connects it to the provider, and binds it to an editor. Closing the file destroys the doc. A workspace with 500 files at 10KB each would be 5MB if loaded eagerly. With this split, you load only the files the user actually opens.

```
User opens workspace:
  → Load metadata doc (always)
  → Display file tree from files table (instant, metadata only)
  → User sees 500 files listed with names, sizes, dates

User opens api.md:
  → Create Y.Doc({ guid: 'abc', gc: false })
  → Connect to provider (IndexedDB, WebSocket, etc.)
  → Bind Y.XmlFragment('richtext') to ProseMirror

User closes api.md:
  → Destroy the content Y.Doc
  → Memory freed
```

This is the same lazy loading that Google Drive does. The file list loads instantly from Drive's metadata API. The actual document content loads separately when you open it.

## Drawing the line

Thinking through what belongs in each layer clarifies the architecture. The metadata layer handles everything structural: things where "last write wins" is fine and rolling back would be confusing rather than helpful.

File system operations are a good example. Renaming a file, moving it to a different folder, trashing it, creating a new folder. Nobody expects to "undo" a rename by rolling back to a previous filesystem snapshot. Google Drive has no revision history for renames, moves, or deletes. If you trash a file, you restore it from trash, not from version history. The same applies to settings, table row metadata, and workspace configuration. These are written infrequently, resolve trivially with LWW, and benefit enormously from GC keeping storage compact.

The content layer is where history matters. A user typing a document expects character-level undo. A team collaborating on code expects to see who changed what and when. Version snapshots let you restore a previous state of a specific document without affecting anything else.

This maps cleanly onto a tree. The branches and trunk are structure: file trees, table schemas, KV settings. The leaves are content: the actual documents users edit. Only the leaves need history.

## Lifecycle management

The one thing subdocuments handle automatically that you lose with separate docs: cleanup. When you delete a subdocument's parent reference, the subdoc gets garbage collected. With manual IDs, deleting a file row doesn't automatically destroy the orphaned content doc.

Handle this explicitly. When a file is permanently deleted (not soft-deleted to trash, but actually removed), the content doc's data in IndexedDB or your sync server needs cleanup. This can be a background job that scans for content doc GUIDs with no matching file row.

Soft delete doesn't create orphans. The file row still exists with a `trashedAt` timestamp. The content doc stays available for viewing ("this file is in trash") and for restoration.

---

**Related:**

- [YKeyValue vs Y.Map: GC Is the Hidden Variable](./ykeyvalue-gc-the-hidden-variable.md): The benchmark that changes everything based on one boolean
- [Cell Workspace Architecture](./cell-workspace-architecture.md): How the metadata layer works at cell-level granularity
- [Why Replacing Nested Y.Maps Loses Concurrent Edits](./nested-ymap-replacement-danger.md): Why flat structures beat nested ones in CRDTs
