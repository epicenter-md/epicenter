# Spec: Add tables.sqlite Persistence to Workspace Persistence

**Date:** 2026-01-21  
**Status:** Draft  
**Location:** `apps/epicenter/src/lib/docs/workspace-persistence.ts`

## Goal

Add SQLite persistence for table data alongside existing YJS/JSON persistence. When `Y.Map('tables')` changes, delete the entire `tables.sqlite` file and rebuild it from scratch (debounced).

## Storage Layout (After)

```
{appLocalDataDir}/workspaces/{workspaceId}/{epoch}/
├── workspace.yjs      # (existing) Full Y.Doc binary
├── schema.json        # (existing) Table schemas
├── kv.json            # (existing) Settings
├── tables.sqlite      # (NEW) SQLite database rebuilt from Y.Map('tables')
└── snapshots/
    └── {unix-ms}.ysnap
```

## Design Principles

1. **One-way sync only**: YJS → SQLite (no SQLite → YJS in this implementation)
2. **Delete file and rebuild**: On every change, delete the `.sqlite` file entirely and create fresh
3. **Debounced writes**: Same pattern as schema.json/kv.json (default 500ms)
4. **Simple mode only**: No push/pull operations; SQLite is just a queryable mirror
5. **No connection pooling**: Fresh connection each rebuild; close immediately after

### Why Delete File Instead of DROP TABLE?

- **Simpler**: No need to track open connections or handle SQLite locking
- **Cleaner**: No WAL files, no journal files, no leftover state
- **Faster for small datasets**: File delete + fresh create avoids SQLite overhead
- **Avoids edge cases**: No "database is locked" errors, no corruption from interrupted writes

## Current Codebase State

### File Location

- **Target file**: `apps/epicenter/src/lib/docs/workspace-persistence.ts`
- (NOT `tauri-workspace-persistence.ts` - file was renamed)

### Existing Structure

The file already has:

- `FILE_NAMES` constant (needs `TABLES_SQLITE` added)
- `pathsPromise` for path resolution (needs `tablesSqlitePath` added)
- `getWorkspaceDocMaps()` call that destructures `schema` and `kv` (needs `tables` added)
- Three persistence sections: Y.Doc binary, Schema JSON, KV JSON (add fourth for SQLite)
- Debounce pattern for JSON files (reuse same pattern)

### Tauri Plugin Status (Already Configured)

All Tauri SQL plugin setup is complete:

- ✅ **Cargo.toml**: `tauri-plugin-sql = { version = "2", features = ["sqlite"] }`
- ✅ **lib.rs**: `.plugin(tauri_plugin_sql::Builder::new().build())`
- ✅ **capabilities/default.json**: `"sql:default"`
- ✅ **package.json**: `"@tauri-apps/plugin-sql": "~2"`
- ✅ **tauri-plugin-fs**: Already has `remove`, `exists` we need

2. **Rust init** (`apps/epicenter/src-tauri/src/lib.rs`):

   ```rust
   .plugin(tauri_plugin_sql::Builder::default().build())
   ```

3. **Capabilities** (`apps/epicenter/src-tauri/capabilities/default.json`):

   ```json
   "sql:default",
   "sql:allow-execute"
   ```

4. **JavaScript** (`apps/epicenter/package.json`):
   ```json
   "@tauri-apps/plugin-sql": "^2"
   ```

## Y.Doc Structure Reference

The tables data lives in `Y.Map('tables')`:

```typescript
Y.Map('tables')
  └── {tableName}: Y.Map<rowId, Y.Map<fieldName, value>>
```

Type aliases from `@epicenter/hq`:

```typescript
type RowMap = Y.Map<unknown>; // Single row: fieldName → value
type TableMap = Y.Map<RowMap>; // Single table: rowId → RowMap
type TablesMap = Y.Map<TableMap>; // All tables: tableName → TableMap
```

## Implementation Plan

### 1. Add File Name Constant

In `FILE_NAMES` (around line 41):

```typescript
const FILE_NAMES = {
	WORKSPACE_YJS: 'workspace.yjs',
	SCHEMA_JSON: 'schema.json',
	KV_JSON: 'kv.json',
	TABLES_SQLITE: 'tables.sqlite', // ADD THIS
	SNAPSHOTS_DIR: 'snapshots',
} as const;
```

### 2. Add Path Resolution

In `pathsPromise` (around line 117-137), add `tablesSqlitePath`:

```typescript
const pathsPromise = (async () => {
	const baseDir = await appLocalDataDir();
	const epochDir = await join(
		baseDir,
		'workspaces',
		workspaceId,
		epoch.toString(),
	);
	const workspaceYjsPath = await join(epochDir, FILE_NAMES.WORKSPACE_YJS);
	const schemaJsonPath = await join(epochDir, FILE_NAMES.SCHEMA_JSON);
	const kvJsonPath = await join(epochDir, FILE_NAMES.KV_JSON);
	const tablesSqlitePath = await join(epochDir, FILE_NAMES.TABLES_SQLITE); // ADD THIS
	const snapshotsDir = await join(epochDir, FILE_NAMES.SNAPSHOTS_DIR);

	return {
		epochDir,
		workspaceYjsPath,
		schemaJsonPath,
		kvJsonPath,
		tablesSqlitePath, // ADD THIS
		snapshotsDir,
	};
})();
```

### 3. Get Tables Map

Change line 114 from:

```typescript
const { schema: schemaMap, kv: kvMap } = getWorkspaceDocMaps(ydoc);
```

To:

```typescript
const {
	schema: schemaMap,
	kv: kvMap,
	tables: tablesMap,
} = getWorkspaceDocMaps(ydoc);
```

### 4. Add Imports

At top of file, add:

```typescript
import Database from '@tauri-apps/plugin-sql';
import { exists, remove } from '@tauri-apps/plugin-fs'; // Add to existing import
```

Full import block becomes:

```typescript
import {
	defineExports,
	getWorkspaceDocMaps,
	type ProviderExports,
	readSchemaFromYDoc,
} from '@epicenter/hq';
import { appLocalDataDir, dirname, join } from '@tauri-apps/api/path';
import {
	exists,
	mkdir,
	readFile,
	remove,
	writeFile,
} from '@tauri-apps/plugin-fs';
import Database from '@tauri-apps/plugin-sql';
import * as Y from 'yjs';
```

### 5. Add Helper Functions

Add these before `workspacePersistence` function (around line 50-100):

```typescript
// ─────────────────────────────────────────────────────────────────────────────
// SQLite Helper Functions
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Delete a file if it exists. Silently ignores missing files.
 */
async function deleteIfExists(path: string): Promise<void> {
	try {
		if (await exists(path)) {
			await remove(path);
		}
	} catch {
		// Ignore errors - file might not exist or might be locked
	}
}

/**
 * Convert field schema type to SQLite column type.
 */
function fieldTypeToSqlite(fieldType: string): string {
	switch (fieldType) {
		case 'id':
		case 'text':
		case 'ytext':
		case 'select':
		case 'date':
			return 'TEXT';
		case 'integer':
			return 'INTEGER';
		case 'real':
			return 'REAL';
		case 'boolean':
			return 'INTEGER'; // SQLite has no boolean; use 0/1
		case 'tags':
		case 'json':
			return 'TEXT'; // JSON stored as string
		default:
			return 'TEXT';
	}
}

/**
 * Build SQLite column definitions from field schemas.
 */
function buildColumnDefinitions(fields: Record<string, unknown>): string {
	const columns: string[] = [];

	for (const [fieldName, fieldSchema] of Object.entries(fields)) {
		const schema = fieldSchema as { type: string; nullable?: boolean };
		const sqlType = fieldTypeToSqlite(schema.type);
		const nullable = schema.nullable ? '' : ' NOT NULL';
		const primary = fieldName === 'id' ? ' PRIMARY KEY' : '';

		columns.push(`"${fieldName}" ${sqlType}${nullable}${primary}`);
	}

	return columns.join(', ');
}

/**
 * Extract plain values from a Y.Map row, handling Y.Text and Y.Array.
 */
function yMapToPlainObject(yMap: Y.Map<unknown>): Record<string, unknown> {
	const obj: Record<string, unknown> = {};

	for (const [key, value] of yMap.entries()) {
		if (value instanceof Y.Text) {
			obj[key] = value.toString();
		} else if (value instanceof Y.Array) {
			obj[key] = JSON.stringify(value.toArray());
		} else if (value instanceof Y.Map) {
			obj[key] = JSON.stringify(value.toJSON());
		} else {
			obj[key] = value;
		}
	}

	return obj;
}

/**
 * Serialize a value for SQLite insertion.
 */
function serializeValue(value: unknown): unknown {
	if (value === null || value === undefined) return null;
	if (typeof value === 'boolean') return value ? 1 : 0;
	if (typeof value === 'object') return JSON.stringify(value);
	return value;
}

/**
 * Insert a row into a SQLite table.
 */
async function insertRow(
	db: Awaited<ReturnType<typeof Database.load>>,
	tableName: string,
	row: Record<string, unknown>,
): Promise<void> {
	const columns = Object.keys(row);
	if (columns.length === 0) return;

	const placeholders = columns.map((_, i) => `$${i + 1}`).join(', ');
	const values = Object.values(row).map(serializeValue);

	const sql = `INSERT INTO "${tableName}" (${columns.map((c) => `"${c}"`).join(', ')}) VALUES (${placeholders})`;
	await db.execute(sql, values);
}
```

### 6. Add SQLite Rebuild Function and Observer

Add this section after the KV JSON persistence section (around line 226, before `return defineExports`):

```typescript
// =========================================================================
// 4. SQLite Tables Persistence (tables.sqlite)
// =========================================================================

let sqliteDebounceTimer: ReturnType<typeof setTimeout> | null = null;

const rebuildSqlite = async () => {
	const { tablesSqlitePath } = await pathsPromise;

	try {
		// Step 1: Delete existing file (and any WAL/journal files)
		await deleteIfExists(tablesSqlitePath);
		await deleteIfExists(`${tablesSqlitePath}-wal`);
		await deleteIfExists(`${tablesSqlitePath}-shm`);
		await deleteIfExists(`${tablesSqlitePath}-journal`);

		// Step 2: Create fresh database
		const db = await Database.load(`sqlite:${tablesSqlitePath}`);

		try {
			// Step 3: Get schema to know table structure
			const schema = readSchemaFromYDoc(schemaMap);

			// Step 4: For each table in schema, create table and insert rows
			for (const [tableName, tableSchema] of Object.entries(schema.tables)) {
				// Build CREATE TABLE statement from schema
				const columns = buildColumnDefinitions(tableSchema.fields);
				if (columns) {
					await db.execute(`CREATE TABLE "${tableName}" (${columns})`);
				}

				// Get rows from YJS
				const tableYMap = tablesMap.get(tableName);
				if (!tableYMap) continue;

				// Insert all rows
				for (const [_rowId, rowYMap] of tableYMap.entries()) {
					const row = yMapToPlainObject(rowYMap);
					await insertRow(db, tableName, row);
				}
			}

			console.log(
				`[WorkspacePersistence] Rebuilt tables.sqlite for ${workspaceId}`,
			);
		} finally {
			// Step 5: Always close the connection
			await db.close();
		}
	} catch (error) {
		console.error(
			`[WorkspacePersistence] Failed to rebuild tables.sqlite:`,
			error,
		);
	}
};

const scheduleSqliteSave = () => {
	if (sqliteDebounceTimer) clearTimeout(sqliteDebounceTimer);
	sqliteDebounceTimer = setTimeout(async () => {
		sqliteDebounceTimer = null;
		await rebuildSqlite();
	}, jsonDebounceMs);
};

// Observe tables map changes (deep observation for nested row changes)
const tablesObserverHandler = () => {
	scheduleSqliteSave();
};
tablesMap.observeDeep(tablesObserverHandler);
```

### 7. Update `whenSynced`

Add initial SQLite rebuild after JSON saves (around line 262):

```typescript
// Initial JSON saves
await saveSchemaJson();
await saveKvJson();

// Initial SQLite rebuild
await rebuildSqlite(); // ADD THIS
```

### 8. Update `destroy()`

Add cleanup for SQLite timer and observer:

```typescript
destroy() {
	// Clear debounce timers
	if (schemaDebounceTimer) {
		clearTimeout(schemaDebounceTimer);
		schemaDebounceTimer = null;
	}
	if (kvDebounceTimer) {
		clearTimeout(kvDebounceTimer);
		kvDebounceTimer = null;
	}
	if (sqliteDebounceTimer) {  // ADD THIS
		clearTimeout(sqliteDebounceTimer);
		sqliteDebounceTimer = null;
	}

	// Remove Y.Doc observer
	ydoc.off('update', saveYDoc);

	// Remove map observers
	schemaMap.unobserveDeep(schemaObserverHandler);
	kvMap.unobserve(kvObserverHandler);
	tablesMap.unobserveDeep(tablesObserverHandler);  // ADD THIS
},
```

## Tauri Plugin Setup (Already Complete)

All Tauri SQL plugin configuration has been done:

| Component    | Status | Value                                                         |
| ------------ | ------ | ------------------------------------------------------------- |
| Cargo.toml   | ✅     | `tauri-plugin-sql = { version = "2", features = ["sqlite"] }` |
| lib.rs       | ✅     | `.plugin(tauri_plugin_sql::Builder::new().build())`           |
| capabilities | ✅     | `"sql:default"`                                               |
| package.json | ✅     | `"@tauri-apps/plugin-sql": "~2"`                              |

No additional setup required. Proceed directly to TypeScript implementation.

This adds to `Cargo.toml`:

```toml
tauri-plugin-sql = { version = "2", features = ["sqlite"] }
```

### Step 2: Initialize plugin in Rust

In `apps/epicenter/src-tauri/src/lib.rs`, add the plugin:

```rust
#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_sql::Builder::default().build())  // ADD THIS
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_opener::init())
        // ... rest unchanged
```

### Step 3: Add permissions

In `apps/epicenter/src-tauri/capabilities/default.json`, add to permissions array:

```json
"sql:default",
"sql:allow-execute"
```

### Step 4: Install JS bindings

```bash
cd apps/epicenter
bun add @tauri-apps/plugin-sql
```

## Testing Checklist

- [ ] Tauri plugin setup complete (Rust + JS + capabilities)
- [ ] App builds without errors
- [ ] Create a new workspace; verify `tables.sqlite` is created in epoch folder
- [ ] Add a row to a table; verify it appears in SQLite after debounce
- [ ] Update a row; verify SQLite reflects the change (entire DB rebuilt)
- [ ] Delete a row; verify it's removed from SQLite
- [ ] Restart app; verify SQLite is rebuilt from YJS on load
- [ ] Add multiple rows quickly; verify debounce batches the rebuild
- [ ] Verify no `-wal`, `-shm`, `-journal` files left behind

## Todo

Tauri plugin setup is already complete. Only TypeScript implementation remains:

- [ ] Add `TABLES_SQLITE` to `FILE_NAMES`
- [ ] Add `tablesSqlitePath` to path resolution
- [ ] Add `tables: tablesMap` to `getWorkspaceDocMaps()` destructure
- [ ] Add imports (`Database`, `exists`, `remove`)
- [ ] Add helper functions (`deleteIfExists`, `fieldTypeToSqlite`, `buildColumnDefinitions`, `yMapToPlainObject`, `serializeValue`, `insertRow`)
- [ ] Add SQLite rebuild function and observer
- [ ] Add initial rebuild in `whenSynced`
- [ ] Add cleanup in `destroy()`
- [ ] Test end-to-end
