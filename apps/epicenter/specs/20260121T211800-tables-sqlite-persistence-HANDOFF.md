# Handoff: Implement tables.sqlite Persistence

## Context

You are implementing SQLite persistence for workspace table data. The goal is simple: when YJS table data changes, delete the SQLite file and rebuild it from scratch.

**Specification:** `apps/epicenter/specs/20260121T211800-tables-sqlite-persistence.md`

## Tauri Plugin Setup (Already Complete)

All Tauri SQL plugin configuration has been done:

| Component    | Status                                                           |
| ------------ | ---------------------------------------------------------------- |
| Cargo.toml   | ✅ `tauri-plugin-sql = { version = "2", features = ["sqlite"] }` |
| lib.rs       | ✅ `.plugin(tauri_plugin_sql::Builder::new().build())`           |
| capabilities | ✅ `"sql:default"`                                               |
| package.json | ✅ `"@tauri-apps/plugin-sql": "~2"`                              |

**No setup required. Proceed directly to TypeScript implementation.**

## File to Modify

**Single file:** `apps/epicenter/src/lib/docs/workspace-persistence.ts`

## Implementation Steps

### 1. Add Imports (top of file)

Add `Database` import and expand the `@tauri-apps/plugin-fs` import:

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

### 2. Add `TABLES_SQLITE` to `FILE_NAMES` (~line 41)

```typescript
const FILE_NAMES = {
	WORKSPACE_YJS: 'workspace.yjs',
	SCHEMA_JSON: 'schema.json',
	KV_JSON: 'kv.json',
	TABLES_SQLITE: 'tables.sqlite', // ADD THIS
	SNAPSHOTS_DIR: 'snapshots',
} as const;
```

### 3. Add Helper Functions (before `workspacePersistence` function, ~line 50)

```typescript
// ─────────────────────────────────────────────────────────────────────────────
// SQLite Helper Functions
// ─────────────────────────────────────────────────────────────────────────────

async function deleteIfExists(path: string): Promise<void> {
	try {
		if (await exists(path)) {
			await remove(path);
		}
	} catch {
		// Ignore errors
	}
}

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
			return 'INTEGER';
		case 'tags':
		case 'json':
			return 'TEXT';
		default:
			return 'TEXT';
	}
}

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

function serializeValue(value: unknown): unknown {
	if (value === null || value === undefined) return null;
	if (typeof value === 'boolean') return value ? 1 : 0;
	if (typeof value === 'object') return JSON.stringify(value);
	return value;
}

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

### 4. Add `tablesSqlitePath` to `pathsPromise` (~line 125)

```typescript
const tablesSqlitePath = await join(epochDir, FILE_NAMES.TABLES_SQLITE);

return {
	epochDir,
	workspaceYjsPath,
	schemaJsonPath,
	kvJsonPath,
	tablesSqlitePath, // ADD THIS
	snapshotsDir,
};
```

### 5. Destructure `tables: tablesMap` (~line 114)

Change:

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

### 6. Add SQLite Persistence Section (after KV JSON section, ~line 226)

```typescript
// =========================================================================
// 4. SQLite Tables Persistence (tables.sqlite)
// =========================================================================

let sqliteDebounceTimer: ReturnType<typeof setTimeout> | null = null;

const rebuildSqlite = async () => {
	const { tablesSqlitePath } = await pathsPromise;

	try {
		// Delete existing file and WAL/journal files
		await deleteIfExists(tablesSqlitePath);
		await deleteIfExists(`${tablesSqlitePath}-wal`);
		await deleteIfExists(`${tablesSqlitePath}-shm`);
		await deleteIfExists(`${tablesSqlitePath}-journal`);

		// Create fresh database
		const db = await Database.load(`sqlite:${tablesSqlitePath}`);

		try {
			const schema = readSchemaFromYDoc(schemaMap);

			for (const [tableName, tableSchema] of Object.entries(schema.tables)) {
				const columns = buildColumnDefinitions(tableSchema.fields);
				if (columns) {
					await db.execute(`CREATE TABLE "${tableName}" (${columns})`);
				}

				const tableYMap = tablesMap.get(tableName);
				if (!tableYMap) continue;

				for (const [_rowId, rowYMap] of tableYMap.entries()) {
					const row = yMapToPlainObject(rowYMap);
					await insertRow(db, tableName, row);
				}
			}

			console.log(
				`[WorkspacePersistence] Rebuilt tables.sqlite for ${workspaceId}`,
			);
		} finally {
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

const tablesObserverHandler = () => {
	scheduleSqliteSave();
};
tablesMap.observeDeep(tablesObserverHandler);
```

### 7. Add Initial Rebuild in `whenSynced` (~line 262)

After the existing JSON saves, add:

```typescript
// Initial JSON saves
await saveSchemaJson();
await saveKvJson();

// Initial SQLite rebuild
await rebuildSqlite();
```

### 8. Add Cleanup in `destroy()`

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
	if (sqliteDebounceTimer) {
		clearTimeout(sqliteDebounceTimer);
		sqliteDebounceTimer = null;
	}

	// Remove Y.Doc observer
	ydoc.off('update', saveYDoc);

	// Remove map observers
	schemaMap.unobserveDeep(schemaObserverHandler);
	kvMap.unobserve(kvObserverHandler);
	tablesMap.unobserveDeep(tablesObserverHandler);
},
```

## Key Details

### SQLite Parameter Syntax

Tauri SQL plugin uses `$1, $2, $3` placeholders (NOT `?`).

### The Rebuild Pattern

Delete file → Create fresh DB → Create tables → Insert rows → Close connection.

### Type Conversions

| YJS Type  | Plain Value                  |
| --------- | ---------------------------- |
| `Y.Text`  | `.toString()`                |
| `Y.Array` | `JSON.stringify(.toArray())` |
| `Y.Map`   | `JSON.stringify(.toJSON())`  |

## Verification

1. Run `bun dev` in `apps/epicenter` - should build without errors
2. Create a workspace with tables
3. Check `~/Library/Application Support/com.epicenter.app/workspaces/{id}/{epoch}/` for `tables.sqlite`
4. Add/edit/delete rows - SQLite should rebuild after 500ms debounce

## After Completion

1. Run `bun typecheck` in `apps/epicenter`
2. Mark todos complete in the spec
3. Add `## Review` section to spec summarizing changes
4. Commit: `feat(epicenter): add tables.sqlite persistence to workspace docs`

## References

- **Spec**: `apps/epicenter/specs/20260121T211800-tables-sqlite-persistence.md`
- **Target**: `apps/epicenter/src/lib/docs/workspace-persistence.ts`
