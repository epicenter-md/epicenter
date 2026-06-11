# Workspace Storage Architecture

**Status**: Draft
**Created**: 2026-01-19

## Overview

This spec defines the storage architecture for Epicenter workspaces, including:

- Y.Doc structure (three top-level maps)
- File layout (per-epoch folders)
- Persistence strategy (hybrid: binary + JSON + SQLite)
- Snapshot system (revision history)

## Design Principles

1. **Single Y.Doc per epoch**: Schema and data co-located for atomic snapshots/rollback
2. **Three top-level namespaces**: `definition`, `kv`, `tables` (1:1 mapping to files)
3. **Hybrid persistence**: Binary for sync, JSON for humans, SQLite for queries
4. **Epoch isolation**: Each epoch is a self-contained folder

## Y.Doc Structure

Each workspace epoch has a single Y.Doc with three top-level maps:

```typescript
// Y.Doc guid: "{workspaceId}-{epoch}"

// Schema (rarely changes)
Y.Map('definition')
  └── name: string              // Workspace display name
  └── icon: IconDefinition | null
  └── tables: {                 // Table SCHEMAS (not data)
        [tableName]: {
          name: string,
          icon: IconDefinition | null,
          description: string,
          fields: { [fieldName]: FieldSchema }
        }
      }
  └── kv: {                     // KV SCHEMAS (not values)
        [key]: {
          name: string,
          icon: IconDefinition | null,
          description: string,
          field: FieldSchema
        }
      }

// Settings values (changes occasionally)
Y.Map('kv')
  └── [key]: value              // Actual KV values

// Table data (changes frequently)
Y.Map('tables')
  └── [tableName]: Y.Map<rowId, Y.Map<fieldName, value>>
```

### Why Three Top-Level Maps?

| Map          | Content         | Change Frequency | Persistence Target |
| ------------ | --------------- | ---------------- | ------------------ |
| `definition` | Schema metadata | Rare             | `definition.json`  |
| `kv`         | Settings values | Occasional       | `kv.json`          |
| `tables`     | Row data        | Frequent         | `tables.sqlite`    |

**Benefits:**

- 1:1 mapping between Y.Doc maps and files
- Independent observation (no `observeDeep` needed)
- Each map can have different persistence strategies
- Clean conceptual separation: schema vs settings vs data

## File Layout

```
workspaces/
└── {workspace-id}/
    ├── head.yjs                    # Current epoch pointer
    ├── head.json                   # Human-readable
    │
    ├── 0/                          # Epoch 0
    │   ├── workspace.yjs           # Full Y.Doc (sync source of truth)
    │   ├── definition.json         # Schema (from Y.Map('definition'))
    │   ├── kv.json                 # Settings (from Y.Map('kv'))
    │   ├── tables.sqlite           # Table data (from Y.Map('tables'))
    │   └── snapshots/              # Revision history
    │       ├── 1704067200000.ysnap
    │       ├── 1704067200000.json  # Optional metadata
    │       └── ...
    │
    └── 1/                          # Epoch 1 (after migration)
        ├── workspace.yjs
        ├── definition.json
        ├── kv.json
        ├── tables.sqlite
        └── snapshots/
            └── ...
```

### File Descriptions

| File                | Format | Purpose                    | Source                         |
| ------------------- | ------ | -------------------------- | ------------------------------ |
| `workspace.yjs`     | Binary | CRDT sync, source of truth | Full Y.Doc                     |
| `definition.json`   | JSON   | Schema, git-friendly       | `Y.Map('definition').toJSON()` |
| `kv.json`           | JSON   | Settings, human-editable   | `Y.Map('kv').toJSON()`         |
| `tables.sqlite`     | SQLite | Queryable data             | `Y.Map('tables')` rows         |
| `snapshots/*.ysnap` | Binary | Revision history           | `Y.snapshot()`                 |

## Persistence Strategy

### Observer Pattern

```typescript
const definition = ydoc.getMap('definition');
const kv = ydoc.getMap('kv');
const tables = ydoc.getMap('tables');

// Full Y.Doc binary (always, for sync)
ydoc.on('update', (update) => {
	appendUpdate('workspace.yjs', update);
	// Periodically compact updates
});

// Definition → JSON (on change)
definition.observe(() => {
	writeFile('definition.json', JSON.stringify(definition.toJSON(), null, '\t'));
});

// KV → JSON (on change)
kv.observe(() => {
	writeFile('kv.json', JSON.stringify(kv.toJSON(), null, '\t'));
});

// Tables → SQLite (on change, debounced)
tables.observeDeep(() => {
	debounce(() => syncToSqlite(tables), 1000);
});
```

### Why Hybrid Persistence?

| Approach                 | Use Case                                    |
| ------------------------ | ------------------------------------------- |
| `workspace.yjs` (binary) | Device sync, CRDT merge semantics           |
| `definition.json`        | Git tracking, manual editing, import/export |
| `kv.json`                | User-editable settings, debugging           |
| `tables.sqlite`          | SQL queries, large dataset efficiency       |

## Snapshots (Revision History)

Snapshots capture the entire Y.Doc state for rollback. They live inside each epoch folder.

### Storage

```
{epoch}/snapshots/
├── 1704067200000.ysnap     # Unix ms timestamp
├── 1704067200000.json      # Optional: { description: "Before bulk delete" }
├── 1704067500000.ysnap
└── ...
```

### Why Per-Epoch?

1. **Snapshots reference Y.Doc items**: A snapshot from epoch 0 can only reconstruct epoch 0's Y.Doc
2. **Atomic rollback**: Rolling back restores both schema AND data together
3. **Clean deletion**: `rm -rf 0/` removes epoch and all its snapshots
4. **Isolation**: Epoch 1 starts fresh snapshot history after migration

### Snapshot API

```typescript
interface RevisionHistory {
	save(description?: string): Promise<VersionEntry | null>;
	list(): Promise<VersionEntry[]>;
	view(index: number): Promise<Y.Doc>; // Read-only
	restore(index: number): Promise<void>;
	count(): Promise<number>;
}
```

### Critical Requirement

Snapshots require `gc: false` on the Y.Doc. Without this, deleted items are garbage collected and snapshots cannot reconstruct historical states.

## Registry

The registry remains minimal, just workspace existence:

```typescript
// registry.yjs
Y.Map('workspaces')
  └── {workspaceId}: true
```

Full metadata (name, icon) comes from loading `{epoch}/definition.json`.

**Why not store metadata in registry?**

- Avoids duplication (metadata already in definition.json)
- Registry stays small for fast sync
- Single source of truth for workspace metadata

## Head Doc

Tracks the current epoch for each workspace:

```typescript
// head.yjs guid: "{workspaceId}"
Y.Map('epochs')
  └── {clientId}: number    // Per-client epoch proposals

// getEpoch() returns max(all values)
// Uses CRDT-safe per-client MAX pattern
```

See `packages/epicenter/src/core/docs/README.md` for epoch semantics.

## Migration Flow

When bumping epochs (schema migration, compaction):

```
1. Create new epoch folder: mkdir 1/
2. Create new Y.Doc at epoch 1
3. Copy/transform data from epoch 0 to epoch 1
4. Bump head doc: head.bumpEpoch()
5. Old epoch (0/) can be archived or deleted
```

Snapshots do NOT migrate: each epoch has its own snapshot history.

## Example: Full Workspace Tree

```
workspaces/
└── epicenter.whispering/
    ├── head.yjs
    ├── head.json
    │
    └── 0/
        ├── workspace.yjs
        ├── definition.json
        │   {
        │     "name": "Whispering",
        │     "icon": { "type": "emoji", "value": "🎙️" },
        │     "tables": {
        │       "recordings": {
        │         "name": "Recordings",
        │         "icon": { "type": "emoji", "value": "🎤" },
        │         "description": "Voice recordings",
        │         "fields": {
        │           "id": { "type": "id" },
        │           "title": { "type": "text" },
        │           "transcript": { "type": "text", "nullable": true }
        │         }
        │       }
        │     },
        │     "kv": {
        │       "theme": {
        │         "name": "Theme",
        │         "icon": null,
        │         "description": "",
        │         "field": { "type": "select", "options": ["light", "dark"] }
        │       }
        │     }
        │   }
        │
        ├── kv.json
        │   {
        │     "theme": "dark"
        │   }
        │
        ├── tables.sqlite
        │   (recordings table with id, title, transcript columns)
        │
        └── snapshots/
            ├── 1704067200000.ysnap
            └── 1704067200000.json
                { "description": "Initial state" }
```

## Implementation Checklist

### Phase 1: Y.Doc Structure

- [x] Update `createClient` to use three top-level maps
- [x] Update table helpers to read from `Y.Map('tables')` (already done)
- [x] Update KV helpers to read from `Y.Map('kv')` (already done)
- [x] Add definition storage in `Y.Map('definition')`
- [x] Create `workspace-doc.ts` with types and helpers

### Phase 2: File Layout

- [x] Create epoch folder structure (`{id}/{epoch}/`)
- [x] Update persistence files to use epoch folders
- [x] Update file path resolution in app providers

### Phase 3: Unified Persistence Capability

- [x] Create `workspacePersistence` capability that materializes all three maps
- [x] Extract `definition.json` from `Y.Map('definition')`
- [x] Extract `kv.json` from `Y.Map('kv')`
- [x] Integrate SQLite provider to write `tables.sqlite` in epoch folder

### Phase 4: Snapshots

- [ ] Move snapshot storage into epoch folders
- [ ] Update `localRevisionHistory` paths
- [ ] Verify atomic rollback (schema + data)

### Phase 5: Migration

- [x] Update app to use new folder structure
- [N/A] Migration script (backwards compatibility not required)

### Phase 6: Documentation

- [x] Update `apps/epicenter/src/lib/docs/README.md` (Three-Doc Architecture)
- [ ] Update `packages/epicenter/src/core/workspace/README.md` with new Y.Doc structure
- [ ] Update `packages/epicenter/src/core/docs/README.md` with new file layout
- [x] Update JSDoc comments in `workspace.ts`

## Open Questions

1. **Compression for snapshots?**
   - `.ysnap` files could be gzipped
   - Tradeoff: CPU vs storage

2. **SQLite WAL mode?**
   - Currently enabled for concurrent access
   - May want `-wal` and `-shm` files in epoch folder too

## References

- [YJS Snapshots](https://docs.yjs.dev/api/snapshots)
- [Local Revision History Spec](./20250109T033000-local-revision-history.md)
- [Workspace README](../packages/epicenter/src/core/workspace/README.md)
- [Docs README](../packages/epicenter/src/core/docs/README.md)

---

## Implementation Review

**Date**: 2026-01-19
**Branch**: `feat/workspace-storage-architecture`

### Summary of Changes

1. **New File: `workspace-doc.ts`** (`packages/epicenter/src/core/docs/`)
   - Defines `WORKSPACE_DOC_MAPS` constants for the three top-level map names
   - Exports types: `DefinitionMap`, `KvMap`, `TablesMap`, `TableMap`, `RowMap`, `WorkspaceDefinitionMap`
   - `getWorkspaceDocMaps(ydoc)` - Get all three Y.Maps from a Y.Doc
   - `mergeDefinitionIntoYDoc()` - Merge WorkspaceDefinition into Y.Map('definition')
   - `readDefinitionFromYDoc()` - Extract definition as plain JSON

2. **Updated: `workspace.ts`** (`packages/epicenter/src/core/workspace/`)
   - `createClient()` now merges definition into `Y.Map('definition')` on creation
   - `client.name` is now a live getter from Y.Map, not static from definition
   - Updated comments to reflect new Y.Doc structure

3. **New Capability: `workspacePersistence`** (`packages/epicenter/src/capabilities/workspace-persistence/`)
   - Unified persistence capability that materializes:
     - `workspace.yjs` - Full Y.Doc binary
     - `definition.json` - From `Y.Map('definition')`
     - `kv.json` - From `Y.Map('kv')`
     - `tables.sqlite` - From `Y.Map('tables')` via Drizzle
   - All files stored in epoch folders: `{baseDir}/{workspaceId}/{epoch}/`
   - Exports Drizzle `db` and table references for SQL queries

4. **Updated: Epicenter App** (`apps/epicenter/src/lib/docs/`)
   - `workspace.ts` now uses epoch folder paths: `workspaces/{id}/{epoch}/workspace.yjs`
   - Updated README with new architecture documentation

### Key Architecture Decisions

1. **Definition IN Y.Doc**: Schema is now stored in `Y.Map('definition')`, enabling collaborative schema editing. The code-defined schema is merged on `createClient()`, but CRDT sync can modify it.

2. **Live `name` getter**: `client.name` reads from Y.Map on each access, reflecting real-time collaborative changes.

3. **Epoch folders**: Each epoch is a self-contained folder with all persistence files, enabling atomic snapshots and clean epoch migrations.

4. **Unified persistence**: One capability handles all persistence formats, simplifying configuration and ensuring consistency.

### Not Yet Implemented

- Snapshot storage in epoch folders (Phase 4)
- Some README updates in packages/epicenter
