# OpenSidian SQLite Index Extension

**Date**: 2026-03-13
**Status**: Draft
**Author**: AI-assisted

## Overview

A workspace extension that mirrors the Yjs CRDT filesystem into a local SQLite database as a read-optimized index. The SQLite database is never the source of truth—it's a derived, rebuildable cache that enables SQL queries, full-text search, and fast lookups against file metadata and content.

## Motivation

### Current State

OpenSidian's filesystem is backed by Yjs CRDTs via `@epicenter/filesystem`. The `FileTree` class provides reactive indexes for path lookups and parent-child queries:

```typescript
const ws = createWorkspace({ id: 'opensidian', tables: { files: filesTable } })
  .withExtension('persistence', indexeddbPersistence);

const fs = createYjsFileSystem(ws.tables.files, ws.documents.files.content);
```

All queries go through the `FileTree.index` object, which maintains in-memory `Map`s derived from Yjs observeDeep callbacks. This works for tree navigation but can't support:

1. **Full-text search**: No way to search across file contents. Users can't find files by content.
2. **Complex queries**: Can't do "find all .md files modified in the last week" or "find files larger than 10KB" without iterating every row.
3. **SQL-powered features**: No aggregate queries, joins, or filtering that SQL gives you for free.
4. **Content indexing**: File content lives in per-file Y.Docs—no unified view exists.

### Previous Implementation

This codebase previously had a `sqliteIndex` function (in the now-removed `packages/epicenter/src/indexes/sqlite/`). Key lessons from existing specs:

- **Debounced rebuild beats incremental sync** (`20251205T164620-sqlite-index-batching.md`): Individual change tracking caused race conditions and ordering bugs. Rebuilding from Yjs on a 100ms debounce is simpler and guarantees correctness at ~7.4k rows/s.
- **Config inversion** (`20251030T120000-sqlite-config-inversion.md`): The caller should pass the path/config, not the extension.
- **WAL mode on, foreign keys off** — SQLite is a read index, not a relational database.

### Desired State

A workspace extension that:

```typescript
const ws = createWorkspace({ id: 'opensidian', tables: { files: filesTable } })
  .withExtension('persistence', indexeddbPersistence)
  .withExtension('sqliteIndex', createSqliteIndex);

// Extension provides SQL query capabilities
const results = ws.extensions.sqliteIndex.query(
  sql`SELECT * FROM files WHERE name LIKE ${'%.md'} AND trashed_at IS NULL`
);

// Full-text search across file content
const searchResults = ws.extensions.sqliteIndex.search('meeting notes');

// Manual rebuild (e.g., after suspected corruption)
await ws.extensions.sqliteIndex.rebuild();
```

## Research Findings

### Browser SQLite Options

OpenSidian is a SvelteKit web app (no Tauri backend). SQLite must run in the browser via WASM.

| Option | Browser Support | Drizzle Adapter | Maturity | Notes |
|---|---|---|---|---|
| **sql.js** | Excellent (WASM, battle-tested) | `drizzle-orm/sql-js` | Very mature | Emscripten-compiled SQLite, widely used |
| **@libsql/client-wasm** | Exists (wasm32 target) | Via `drizzle-orm/libsql` | Less proven | Turso's WASM build, thin browser docs |
| **sqlite-wasm** (official) | Good (official SQLite WASM) | No native Drizzle adapter | Newer | Official build, OPFS backend |
| **wa-sqlite** | Good | No Drizzle adapter | Moderate | IndexedDB/OPFS VFS backends |

**Key finding**: sql.js is the safest choice for browser today. It has the most ecosystem support and a first-class Drizzle adapter.

**Turso/libSQL upgrade path**: If OpenSidian later needs remote sync (sharing indexes across devices), the schema stays identical—only the driver changes from sql.js to `@libsql/client`. Turso's "embedded replicas" pattern (local SQLite that syncs to a remote Turso database) maps perfectly to this architecture. The local SQLite index remains the read surface; the remote database becomes the sync target.

### Turso Platform

Turso is a managed libSQL platform built on SQLite. Key capabilities relevant to this design:

- **Embedded replicas**: A local SQLite file that syncs with a remote Turso database. Local reads are instant; writes propagate to remote.
- **Database-per-tenant**: Turso supports creating databases programmatically via their Platform API—one database per workspace is a natural fit.
- **libSQL extensions**: libSQL is a fork of SQLite that adds features like native vector search and remote replication.

For a LOCAL-ONLY index (no remote sync), Turso adds no value over sql.js. The value comes IF/WHEN remote sync is needed. The upgrade path is clean because:

1. Drizzle schema definitions are driver-agnostic (`sqliteTable` works with sql.js, libSQL, better-sqlite3, bun:sqlite)
2. The extension factory pattern means swapping the driver is a single-line change
3. Turso's embedded replica pattern matches our "index as derived cache" architecture perfectly

### Workspace Extension System

The workspace provides three extension methods:

- `.withExtension(key, factory)` — applies to both workspace Y.Doc and per-file content Y.Docs (90% use case)
- `.withWorkspaceExtension(key, factory)` — workspace Y.Doc only
- `.withDocumentExtension(key, factory, opts?)` — per-file content Y.Docs only

The SQLite index should use `.withWorkspaceExtension()` because it observes the workspace-level files table, not individual content documents. Content serialization happens by explicitly opening each file's content doc via `documents.open(fileId)`.

Factory receives: `{ id, ydoc, tables, kv, documents, awareness, extensions, whenReady }`

### Content Serialization

File content lives in per-file Y.Docs managed by `documents.files.content`. The `ContentHelpers` abstraction provides:

- `content.read(fileId): Promise<string>` — reads text content from the file's Y.Doc
- `content.readBuffer(fileId): Promise<Uint8Array>` — reads binary content

The timeline abstraction inside `ContentHelpers` handles three content modes: `text`, `binary`, and `sheet` (CSV-like). For the SQLite index, we serialize text content as UTF-8 strings and skip binary content (not searchable).

## Design Decisions

| Decision | Choice | Rationale |
|---|---|---|
| Extension type | `.withWorkspaceExtension()` | Observes workspace table, not individual content docs |
| Browser SQLite driver | sql.js (WASM) | Most mature browser SQLite, first-class Drizzle adapter |
| Sync strategy | Debounced full rebuild | Proven simpler and more correct than incremental (per existing spec) |
| Default debounce | 100ms | Matches previous implementation; good balance of latency vs write batching |
| Content indexing | Include text content | Enables full-text search; skip binary files |
| FTS implementation | SQLite FTS5 | Native to SQLite, no additional dependencies |
| Schema definition | Drizzle ORM `sqliteTable` | Driver-agnostic schema, typed queries, migration support |
| Turso/remote sync | Deferred | No value for local-only index; clean upgrade path exists via driver swap |
| Package location | `packages/filesystem/src/extensions/` | Co-located with the filesystem it indexes |
| Persistence | None (ephemeral) | Index is rebuilt from Yjs on every page load; optionally persist to IndexedDB/OPFS later |

## Architecture

```
┌───────────────────────────────────────────────────────────────┐
│  Yjs Y.Doc (Source of Truth)                                  │
│  ├── Y.Array('table:files')  ← FileRow metadata              │
│  │   observe() fires on add/update/delete                     │
│  └── Per-file Y.Doc          ← content via documents.open()   │
└────────────────────┬──────────────────────────────────────────┘
                     │ observe() callback
                     ▼
┌───────────────────────────────────────────────────────────────┐
│  Debounce (100ms default)                                     │
│  scheduleSync() → clearTimeout → setTimeout → rebuild()       │
└────────────────────┬──────────────────────────────────────────┘
                     │
                     ▼
┌───────────────────────────────────────────────────────────────┐
│  rebuild()                                                    │
│  1. Delete all rows from `files` table                        │
│  2. Read all valid rows from tables.files.getAllValid()        │
│  3. For each file: serialize content via documents.open()     │
│  4. Batch INSERT into SQLite `files` table                    │
│  5. Rebuild FTS5 index                                        │
└───────────────────────────────────────────────────────────────┘

Extension Exports:
┌───────────────────────────────────────────────────────────────┐
│  { db, query, search, rebuild, destroy, whenReady }           │
│                                                               │
│  db:       Drizzle SQLite database instance                   │
│  query:    Run typed Drizzle queries against the index        │
│  search:   Full-text search across file names + content       │
│  rebuild:  Manually nuke and rebuild the entire index         │
│  destroy:  Tear down observers, close SQLite                  │
│  whenReady: Promise that resolves after initial rebuild       │
└───────────────────────────────────────────────────────────────┘
```

### SQLite Schema

```typescript
import { index, integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';

/** 1:1 mirror of FileRow from the Yjs files table */
export const files = sqliteTable('files', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  parentId: text('parent_id'),
  type: text('type').notNull(),           // 'file' | 'folder'
  path: text('path'),                      // materialized path from FileTree.index
  size: integer('size').notNull(),
  createdAt: integer('created_at').notNull(),
  updatedAt: integer('updated_at').notNull(),
  trashedAt: integer('trashed_at'),
  content: text('content'),                // serialized text from Y.Doc (null for folders/binary)
}, (t) => ({
  parentIdx: index('parent_idx').on(t.parentId),
  typeIdx: index('type_idx').on(t.type),
  pathIdx: index('path_idx').on(t.path),
  updatedIdx: index('updated_idx').on(t.updatedAt),
}));

// FTS5 virtual table (created via raw SQL — Drizzle can't define virtual tables)
// CREATE VIRTUAL TABLE files_fts USING fts5(name, content, content=files, content_rowid=rowid);
```

### Extension Factory

```typescript
import { drizzle } from 'drizzle-orm/sql-js';
import initSqlJs from 'sql.js';
import type { ExtensionContext } from '@epicenter/workspace';
import * as schema from './schema.js';

type SqliteIndexOptions = {
  debounceMs?: number;
};

export function createSqliteIndex(options: SqliteIndexOptions = {}) {
  const { debounceMs = 100 } = options;

  return (context: ExtensionContext) => {
    const { tables, documents } = context;

    let db: ReturnType<typeof drizzle>;
    let syncTimeout: ReturnType<typeof setTimeout> | null = null;

    const whenReady = (async () => {
      const SQL = await initSqlJs();
      const sqlite = new SQL.Database();
      db = drizzle(sqlite, { schema });

      // Create tables and FTS index
      sqlite.run(`CREATE TABLE IF NOT EXISTS files (...)`);
      sqlite.run(`CREATE VIRTUAL TABLE IF NOT EXISTS files_fts USING fts5(...)`);

      // Initial rebuild
      await rebuild();

      // Observe ongoing changes
      tables.files.observe(() => scheduleSync());
    })();

    function scheduleSync() { /* debounced rebuild */ }
    async function rebuild() { /* nuke + reinsert from Yjs */ }
    function search(query: string) { /* FTS5 MATCH query */ }

    return {
      get db() { return db; },
      query: (q: Parameters<typeof db.select>) => db.select(...q),
      search,
      rebuild,
      whenReady,
      destroy() {
        if (syncTimeout) clearTimeout(syncTimeout);
        tables.files.unobserve?.();
        db?.close?.();
      },
    };
  };
}
```

## Implementation Plan

### Phase 1: Core Extension

- [x] **1.1** Add `sql.js` and `drizzle-orm` dependencies to `packages/filesystem`
- [x] **1.2** Create `packages/filesystem/src/extensions/sqlite-index/schema.ts` — Drizzle schema mirroring `FileRow`
- [x] **1.3** Create `packages/filesystem/src/extensions/sqlite-index/index.ts` — extension factory with `rebuild()`, `destroy()`, `whenReady`
- [x] **1.4** Implement debounced rebuild: observe `tables.files` → schedule → nuke + reinsert
- [x] **1.5** Wire content serialization: for each file, `documents.open(fileId)` → `content.read()` → store in `content` column
- [x] **1.6** Add materialized `path` column populated via parentId chain traversal
- [x] **1.7** Export from `packages/filesystem/src/index.ts`

### Phase 2: Full-Text Search

- [x] **2.1** Create FTS5 virtual table via raw SQL in the schema setup
- [x] **2.2** Implement `search(query: string)` method using FTS5 `MATCH`
- [x] **2.3** Return ranked results with highlighted snippets via `snippet()` function
- [x] **2.4** Handle content-less files (folders, binary) gracefully in FTS

### Phase 3: OpenSidian Integration

- [x] **3.1** Wire extension into OpenSidian's workspace: `.withWorkspaceExtension('sqliteIndex', createSqliteIndex())`
- [ ] **3.2** Create a search service in `apps/opensidian/src/lib/fs/` that wraps the extension's `search()` method
- [ ] **3.3** Expose rebuild/status in the UI (e.g., "Index: 1,234 files" in the status bar)

### Phase 4: Turso Upgrade Path (Future)

- [ ] **4.1** Swap sql.js driver for `@libsql/client-wasm` or `@libsql/client`
- [ ] **4.2** Configure embedded replica with `syncUrl` pointing to Turso
- [ ] **4.3** Add sync controls (manual sync, auto-sync interval)

## Edge Cases

### Large Workspaces (>10k files)

1. Rebuild iterates all rows and opens each file's content doc
2. Content docs may not all be loaded in memory—`documents.open()` may trigger Y.Doc creation
3. For >10k files, rebuild could take seconds. Consider: showing a progress indicator, or deferring content indexing to a second pass.

### Binary Files

1. A file's content mode is `binary` (detected by the timeline abstraction)
2. Binary content is not UTF-8 text and shouldn't be indexed
3. Store `null` in the `content` column for binary files; exclude from FTS5

### Concurrent Rebuilds

1. A rebuild is in progress when another change triggers `scheduleSync()`
2. The debounce handles this naturally—the new timer replaces the old one
3. If a rebuild is actively running (async), a flag should prevent overlapping rebuilds

### Page Reload / Fresh Load

1. SQLite index is ephemeral (in-memory via sql.js)
2. On page load, `whenReady` triggers a full rebuild from Yjs
3. Yjs data is persisted via IndexedDB (`y-indexeddb`), so the source of truth survives reloads
4. Rebuild time depends on workspace size. For fast startup, consider persisting the SQLite DB to IndexedDB/OPFS (Phase 5).

## Open Questions

1. **Should the SQLite database persist across page reloads?**
   - Options: (a) Always ephemeral—rebuild from Yjs on every load, (b) Persist to IndexedDB via sql.js export, (c) Persist to OPFS via sqlite-wasm
   - **Recommendation**: Start ephemeral (a). It's simpler and the index is always fresh. Add persistence later if rebuild time becomes a problem on large workspaces.

2. **Should content indexing be eager or lazy?**
   - Options: (a) Index all file content during rebuild (eager), (b) Index content only when a file is first opened (lazy), (c) Index metadata eagerly, content in a background pass
   - **Recommendation**: (c) — rebuild metadata first (fast, synchronous), then index content in a background pass. This keeps `whenReady` fast while still enabling full-text search.

3. **Where should this package live?**
   - Options: (a) `packages/filesystem/src/extensions/`, (b) `packages/workspace/src/extensions/`, (c) New `packages/sqlite-index/`
   - **Recommendation**: (a) — it's specifically an index over the filesystem, not a generic workspace extension.

4. **Should we use sql.js or target the official sqlite-wasm with OPFS?**
   - sql.js is more mature and has Drizzle support. Official sqlite-wasm has OPFS persistence built in but no Drizzle adapter.
   - **Recommendation**: sql.js for now. Revisit if persistence becomes a requirement (sqlite-wasm's OPFS support would be compelling then).

## Success Criteria

- [ ] `createSqliteIndex` extension can be wired into any workspace with a files table
- [ ] Full rebuild from Yjs completes in <1s for 1,000 files
- [ ] `search()` returns results with file name, path, and content snippets
- [ ] `rebuild()` produces an identical database state regardless of call order
- [ ] Extension properly destroys observers and closes SQLite on `destroy()`
- [ ] Drizzle schema is driver-agnostic (can swap sql.js for libSQL/bun:sqlite without schema changes)
- [ ] Tests pass using in-memory SQLite (no browser required)

## References

- `packages/filesystem/src/table.ts` — `filesTable` definition with `withDocument('content', ...)`
- `packages/filesystem/src/file-system.ts` — `createYjsFileSystem` orchestrator
- `packages/filesystem/src/content/content.ts` — `createContentHelpers` for reading file content
- `packages/filesystem/src/tree/tree.ts` — `FileTree` class with index/observe patterns
- `packages/workspace/src/workspace/create-workspace.ts` — Extension API (`withWorkspaceExtension`)
- `specs/20251205T164620-sqlite-index-batching.md` — Previous debounced rebuild design
- `specs/20251030T120000-sqlite-config-inversion.md` — Previous config pattern
- `specs/20251112T132055-sqlite-schema-namespace-refactor.md` — Previous schema organization


## Review

### Changes Made (2026-03-14)

**Files created:**
- `packages/filesystem/src/extensions/sqlite-index/schema.ts` — Drizzle `sqliteTable` definition with 10 columns (id, name, parentId, type, path, size, createdAt, updatedAt, trashedAt, content) plus 4 indexes
- `packages/filesystem/src/extensions/sqlite-index/index.ts` — Extension factory (386 lines) implementing:
  - sql.js WASM initialization with in-memory database
  - Raw SQL schema creation (files table + FTS5 virtual table)
  - Debounced full rebuild from Yjs (100ms default)
  - Eager content indexing via `documents.open()` → `handle.read()`
  - Materialized path computation via parentId chain traversal (handles cycles and orphans)
  - FTS5 `search()` with `snippet()` highlighting and `<mark>` tags
  - Concurrent rebuild guard (`rebuilding` flag)
  - Proper cleanup: timeout clearing, observer unsubscribe, SQLite close

**Files modified:**
- `packages/filesystem/package.json` — Added `sql.js`, `drizzle-orm`, `@types/sql.js`
- `packages/filesystem/src/index.ts` — Added exports for `createSqliteIndex`, `SearchResult`, `SqliteIndex`, `SqliteIndexOptions`
- `apps/opensidian/src/lib/fs/fs-state.svelte.ts` — Added `.withWorkspaceExtension('sqliteIndex', createSqliteIndex())` to workspace chain

### Deviations from Spec

1. **Path computation**: Spec referenced `FileTree.index.getPathById()` which doesn't exist. Implemented equivalent via parentId chain traversal with cycle detection and orphan handling (same algorithm as `path-index.ts`).
2. **FTS5 table**: Used standalone FTS5 (`file_id UNINDEXED, name, content`) instead of external-content (`content=files, content_rowid=rowid`) for simplicity—both get nuked and rebuilt together anyway.
3. **Index syntax**: Used array-style Drizzle index syntax (`(t) => [...]`) instead of object-style (`(t) => ({...})`) to match current drizzle-orm API.
4. **Phase 3.2–3.3 deferred**: Search service wrapper and status bar UI left for a follow-up—the extension is usable directly via `ws.extensions.sqliteIndex.search()`.

### Verification

- All existing tests pass: 189 pass, 0 fail (packages/filesystem)
- LSP diagnostics clean on all changed files (schema.ts, index.ts, index.ts barrel, fs-state.svelte.ts)
- Extension is purely additive—no existing code was modified beyond the barrel export and OpenSidian wiring