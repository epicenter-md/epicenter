# Simple Definition-First Workspace API

**Date**: 2026-02-01
**Status**: Implemented
**Branch**: `feat/auto-injected-version-discriminant`
**PR**: Pending

## Implementation Notes

This specification has been fully implemented with the following changes:

### Breaking Changes

- Removed `HeadDoc` entirely from the codebase
- Removed `createHeadDoc()` function
- Removed `registry` module (workspace discovery via JSON files now)
- `createWorkspace()` now takes `WorkspaceDefinition` directly (not `{ headDoc, definition }`)
- Removed epoch-based folder structure (flat structure now)

### Deferred to Future

- SQLite materialized views (`tables.sqlite`) - placeholder for now
- Versioned workspaces with `versionControl: true` flag - archived patterns preserved in `docs/articles/archived-head-registry-patterns.md`

### Files Changed

- **Package**: `create-workspace.ts`, `types.ts`, `index.ts` (HeadDoc removed)
- **App**: New `services/workspaces.ts`, simplified `workspace.ts`, updated persistence
- **Deleted**: `head-doc.ts`, `head.ts`, `head-persistence.ts`, `registry.ts`, `registry-persistence.ts`, `reactive-*.svelte.ts`

## Summary

Introduce a simplified `createWorkspace(definition)` API that takes a `WorkspaceDefinition` directly, without requiring a HeadDoc. This enables a clean, definition-first pattern where workspace schema lives in JSON files and the Y.Doc contains only data.

## Motivation

The current API requires creating a HeadDoc even for simple workspaces that don't need epoch-based versioning:

```typescript
// Current: Ceremony even for simple use cases
const head = createHeadDoc({ workspaceId, providers: { persistence } });
await head.whenSynced;
const workspace = createWorkspace({ headDoc: head, definition });
```

Most workspaces don't need:

- Epoch-based versioning
- Time-travel / snapshots
- Schema migrations across epochs

For these simple cases, the HeadDoc is overhead. The `WorkspaceDefinition` already contains the workspace ID, so we can derive everything from it.

## Design

### New API

```typescript
import { createWorkspace } from '@epicenter/hq/dynamic';

const workspace = createWorkspace(definition).withExtensions({
	persistence,
	sqlite,
});

await workspace.whenSynced;
```

### WorkspaceDefinition (unchanged)

```typescript
type WorkspaceDefinition = {
	id: string; // Workspace identifier (Y.Doc guid)
	name: string; // Display name
	description: string; // Description
	icon: Icon | null; // Emoji or Lucide icon
	tables: TableDefinition[];
	kv: KvField[];
};
```

### Y.Doc Configuration

```typescript
// Simple mode: gc: true for efficient storage
const ydoc = new Y.Doc({
	guid: definition.id,
	gc: true, // Tombstones get merged → 200-1000x smaller
});
```

With `gc: true`, YKeyValueLww is extremely efficient:

- Tombstones from updates get merged into tiny metadata
- 200-1000x smaller than Y.Map for update-heavy data
- Trade-off: No snapshot/time-travel capability

### Storage Layout

```
{appDataDir}/workspaces/
└── {workspaceId}/
    ├── definition.json         # WorkspaceDefinition (schema + metadata)
    ├── workspace.yjs           # Y.Doc binary (source of truth)
    ├── tables.sqlite           # Materialized view for queries
    └── kv.json                 # KV values mirror
```

**Example:**

```
workspaces/
├── blog-workspace/
│   ├── definition.json
│   ├── workspace.yjs
│   ├── tables.sqlite
│   └── kv.json
└── notes-app/
    ├── definition.json
    ├── workspace.yjs
    ├── tables.sqlite
    └── kv.json
```

### Definition JSON Format

`{workspaceId}/definition.json`:

```json
{
	"id": "blog-workspace",
	"name": "My Blog",
	"description": "Personal blog content",
	"icon": "emoji:📝",
	"tables": [
		{
			"id": "posts",
			"name": "Posts",
			"icon": "emoji:📄",
			"fields": [
				{ "id": "id", "type": "id" },
				{ "id": "title", "type": "text", "name": "Title" },
				{ "id": "content", "type": "text", "name": "Content" },
				{ "id": "published", "type": "boolean", "default": false }
			]
		}
	],
	"kv": [
		{
			"id": "theme",
			"type": "select",
			"options": ["light", "dark"],
			"default": "light"
		},
		{ "id": "postsPerPage", "type": "integer", "default": 10 }
	]
}
```

### Workspace Enumeration

List all workspaces by globbing JSON files:

```typescript
import { readDir } from '@tauri-apps/plugin-fs';

async function listWorkspaces(): Promise<WorkspaceDefinition[]> {
	const baseDir = await appLocalDataDir();
	const workspacesDir = await join(baseDir, 'workspaces');

	const entries = await readDir(workspacesDir);
	const definitions: WorkspaceDefinition[] = [];

	for (const entry of entries) {
		if (entry.name?.endsWith('.json')) {
			const content = await readTextFile(await join(workspacesDir, entry.name));
			definitions.push(JSON.parse(content));
		}
	}

	return definitions;
}
```

## Package Changes

### packages/epicenter/src/dynamic/workspace/create-workspace.ts

Add new overload that takes definition directly:

````typescript
/**
 * Create a simple workspace from a definition.
 *
 * This is the recommended API for workspaces that don't need:
 * - Epoch-based versioning
 * - Time-travel / snapshots
 * - Schema migrations
 *
 * The Y.Doc is created with gc: true for efficient storage.
 *
 * @example
 * ```typescript
 * const workspace = createWorkspace(definition)
 *   .withExtensions({ persistence });
 *
 * workspace.tables.get('posts').upsert({ id: '1', title: 'Hello' });
 * ```
 */
export function createWorkspace<
	const TTableDefinitions extends readonly TableDefinition[],
	const TKvFields extends readonly KvField[],
>(
	definition: WorkspaceDefinition<TTableDefinitions, TKvFields>,
): WorkspaceClientBuilder<TTableDefinitions, TKvFields>;

/**
 * Create a versioned workspace with HeadDoc for epoch management.
 *
 * Use this when you need:
 * - Epoch-based versioning
 * - Time-travel / snapshots (requires gc: false internally)
 * - Schema migrations across epochs
 *
 * @example
 * ```typescript
 * const head = createHeadDoc({ workspaceId, providers: {...} });
 * const workspace = createWorkspace({ headDoc: head, definition });
 * ```
 */
export function createWorkspace<
	const TTableDefinitions extends readonly TableDefinition[],
	const TKvFields extends readonly KvField[],
>(
	config: CreateWorkspaceConfig<TTableDefinitions, TKvFields>,
): WorkspaceClientBuilder<TTableDefinitions, TKvFields>;

// Implementation
export function createWorkspace<
	const TTableDefinitions extends readonly TableDefinition[],
	const TKvFields extends readonly KvField[],
>(
	configOrDefinition:
		| WorkspaceDefinition<TTableDefinitions, TKvFields>
		| CreateWorkspaceConfig<TTableDefinitions, TKvFields>,
): WorkspaceClientBuilder<TTableDefinitions, TKvFields> {
	// Detect which overload was called
	const isSimpleMode =
		'id' in configOrDefinition && !('headDoc' in configOrDefinition);

	if (isSimpleMode) {
		// Simple mode: definition only, gc: true
		const definition = configOrDefinition as WorkspaceDefinition<
			TTableDefinitions,
			TKvFields
		>;
		const workspaceId = definition.id;

		// gc: true for efficient YKeyValueLww storage
		const ydoc = new Y.Doc({ guid: workspaceId, gc: true });

		const tables = createTables(ydoc, definition.tables ?? []);
		const kv = createKv(ydoc, definition.kv ?? []);

		// ... rest of implementation (same pattern as current)
	} else {
		// Versioned mode: existing implementation with HeadDoc
		const config = configOrDefinition as CreateWorkspaceConfig<
			TTableDefinitions,
			TKvFields
		>;
		// ... existing implementation
	}
}
````

### packages/epicenter/src/dynamic/workspace/types.ts

Add definition to ExtensionContext for persistence access:

```typescript
export type ExtensionContext<
	TTableDefinitions extends readonly TableDefinition[] =
		readonly TableDefinition[],
	TKvFields extends readonly KvField[] = readonly KvField[],
> = {
	ydoc: Y.Doc;
	workspaceId: string;
	epoch: number; // 0 for simple mode
	tables: Tables<TTableDefinitions>;
	kv: Kv<TKvFields>;
	extensionId: string;
	definition: WorkspaceDefinition<TTableDefinitions, TKvFields>; // ADD THIS
};
```

### packages/epicenter/src/dynamic/index.ts

Ensure exports are correct:

```typescript
export { createWorkspace } from './workspace/create-workspace';
export type { WorkspaceDefinition } from '../core/schema/workspace-definition';
// ... rest unchanged
```

## App Changes

### apps/epicenter/src/lib/docs/workspace.ts

Simplify to use new API:

```typescript
import {
	createWorkspace,
	type WorkspaceDefinition,
} from '@epicenter/hq/dynamic';
import { workspacePersistence } from './workspace-persistence';

/**
 * Create a workspace client with persistence.
 *
 * Loads definition from JSON file if not provided.
 */
export function createWorkspaceClient(definition: WorkspaceDefinition) {
	return createWorkspace(definition).withExtensions({
		persistence: (ctx) => workspacePersistence(ctx),
	});
}
```

### apps/epicenter/src/lib/docs/workspace-persistence.ts

Update to work with simple mode:

```typescript
import {
	defineExports,
	type ExtensionContext,
	type Lifecycle,
} from '@epicenter/hq/dynamic';
import { appLocalDataDir, join } from '@tauri-apps/api/path';
import { mkdir, readFile, writeFile } from '@tauri-apps/plugin-fs';
import * as Y from 'yjs';

export type WorkspacePersistenceConfig = {
	/** Debounce interval for SQLite/JSON writes. @default 500 */
	debounceMs?: number;
};

const FILE_NAMES = {
	WORKSPACE_YJS: 'workspace.yjs',
	TABLES_SQLITE: 'tables.sqlite',
	KV_JSON: 'kv.json',
} as const;

export function workspacePersistence<TTableDefs, TKvFields>(
	ctx: ExtensionContext<TTableDefs, TKvFields>,
	config: WorkspacePersistenceConfig = {},
): Lifecycle {
	const { ydoc, workspaceId, tables, kv } = ctx;
	const { debounceMs = 500 } = config;

	// Resolve paths
	const pathsPromise = (async () => {
		const baseDir = await appLocalDataDir();
		const workspaceDir = await join(baseDir, 'workspaces', workspaceId);
		return {
			workspaceDir,
			yjsPath: await join(workspaceDir, FILE_NAMES.WORKSPACE_YJS),
			sqlitePath: await join(workspaceDir, FILE_NAMES.TABLES_SQLITE),
			kvPath: await join(workspaceDir, FILE_NAMES.KV_JSON),
		};
	})();

	// ─────────────────────────────────────────────────────────────────────────
	// 1. Y.Doc Binary Persistence (immediate on every update)
	// ─────────────────────────────────────────────────────────────────────────

	const saveYDoc = async () => {
		const { yjsPath } = await pathsPromise;
		const state = Y.encodeStateAsUpdate(ydoc);
		await writeFile(yjsPath, state);
	};

	ydoc.on('update', saveYDoc);

	// ─────────────────────────────────────────────────────────────────────────
	// 2. SQLite Materialized View (debounced full dump)
	// ─────────────────────────────────────────────────────────────────────────

	let sqliteTimer: ReturnType<typeof setTimeout> | null = null;

	const saveSqlite = async () => {
		const { sqlitePath } = await pathsPromise;
		// Full dump of all tables to SQLite
		// Implementation: iterate tables.names(), get all rows, write to SQLite
		// For now, this is a placeholder - actual SQLite impl needed
		console.log(`[Persistence] Would save SQLite to ${sqlitePath}`);
	};

	const scheduleSqliteSave = () => {
		if (sqliteTimer) clearTimeout(sqliteTimer);
		sqliteTimer = setTimeout(() => {
			sqliteTimer = null;
			saveSqlite();
		}, debounceMs);
	};

	// Observe all table changes
	for (const tableName of tables.names()) {
		tables.get(tableName).observe(scheduleSqliteSave);
	}

	// ─────────────────────────────────────────────────────────────────────────
	// 3. KV JSON Persistence (debounced)
	// ─────────────────────────────────────────────────────────────────────────

	let kvTimer: ReturnType<typeof setTimeout> | null = null;

	const saveKvJson = async () => {
		const { kvPath } = await pathsPromise;
		const kvData = kv.toJSON();
		const json = JSON.stringify(kvData, null, '\t');
		await writeFile(kvPath, new TextEncoder().encode(json));
	};

	const scheduleKvSave = () => {
		if (kvTimer) clearTimeout(kvTimer);
		kvTimer = setTimeout(() => {
			kvTimer = null;
			saveKvJson();
		}, debounceMs);
	};

	kv.observe(scheduleKvSave);

	// ─────────────────────────────────────────────────────────────────────────
	// Return Lifecycle
	// ─────────────────────────────────────────────────────────────────────────

	return defineExports({
		whenSynced: (async () => {
			const { workspaceDir, yjsPath } = await pathsPromise;

			// Ensure directory exists
			await mkdir(workspaceDir, { recursive: true }).catch(() => {});

			// Load existing Y.Doc state
			try {
				const savedState = await readFile(yjsPath);
				Y.applyUpdate(ydoc, new Uint8Array(savedState));
				console.log(`[Persistence] Loaded ${workspaceId}/workspace.yjs`);
			} catch {
				console.log(`[Persistence] Creating new ${workspaceId}/workspace.yjs`);
				await saveYDoc();
			}

			// Initial saves
			await saveKvJson();
		})(),

		destroy() {
			ydoc.off('update', saveYDoc);
			if (sqliteTimer) clearTimeout(sqliteTimer);
			if (kvTimer) clearTimeout(kvTimer);
		},
	});
}
```

### apps/epicenter/src/lib/services/workspaces.ts

New service for workspace management:

```typescript
import type { WorkspaceDefinition } from '@epicenter/hq/dynamic';
import { appLocalDataDir, join } from '@tauri-apps/api/path';
import {
	readDir,
	readTextFile,
	writeTextFile,
	mkdir,
	remove,
} from '@tauri-apps/plugin-fs';
import { generateGuid } from '@epicenter/hq';

const WORKSPACES_DIR = 'workspaces';

/**
 * Get the workspaces directory path.
 */
async function getWorkspacesDir(): Promise<string> {
	const baseDir = await appLocalDataDir();
	return join(baseDir, WORKSPACES_DIR);
}

/**
 * List all workspace definitions by reading JSON files.
 */
export async function listWorkspaces(): Promise<WorkspaceDefinition[]> {
	const dir = await getWorkspacesDir();

	try {
		const entries = await readDir(dir);
		const definitions: WorkspaceDefinition[] = [];

		for (const entry of entries) {
			if (entry.name?.endsWith('.json') && entry.isFile) {
				try {
					const filePath = await join(dir, entry.name);
					const content = await readTextFile(filePath);
					definitions.push(JSON.parse(content));
				} catch (e) {
					console.warn(`Failed to parse ${entry.name}:`, e);
				}
			}
		}

		return definitions;
	} catch {
		// Directory doesn't exist yet
		return [];
	}
}

/**
 * Get a single workspace definition by ID.
 */
export async function getWorkspace(
	id: string,
): Promise<WorkspaceDefinition | null> {
	const dir = await getWorkspacesDir();
	const filePath = await join(dir, id, 'definition.json');

	try {
		const content = await readTextFile(filePath);
		return JSON.parse(content);
	} catch {
		return null;
	}
}

/**
 * Create a new workspace.
 */
export async function createWorkspaceDefinition(
	input: Omit<WorkspaceDefinition, 'id'> & { id?: string },
): Promise<WorkspaceDefinition> {
	const dir = await getWorkspacesDir();

	const definition: WorkspaceDefinition = {
		id: input.id ?? generateGuid(),
		name: input.name,
		description: input.description ?? '',
		icon: input.icon ?? null,
		tables: input.tables ?? [],
		kv: input.kv ?? [],
	};

	// Create workspace folder
	const workspaceDir = await join(dir, definition.id);
	await mkdir(workspaceDir, { recursive: true });

	// Write definition.json inside the folder
	const filePath = await join(workspaceDir, 'definition.json');
	await writeTextFile(filePath, JSON.stringify(definition, null, '\t'));

	return definition;
}

/**
 * Update a workspace definition.
 */
export async function updateWorkspaceDefinition(
	id: string,
	updates: Partial<Omit<WorkspaceDefinition, 'id'>>,
): Promise<WorkspaceDefinition | null> {
	const existing = await getWorkspace(id);
	if (!existing) return null;

	const updated: WorkspaceDefinition = {
		...existing,
		...updates,
		id, // Ensure ID doesn't change
	};

	const dir = await getWorkspacesDir();
	const filePath = await join(dir, id, 'definition.json');
	await writeTextFile(filePath, JSON.stringify(updated, null, '\t'));

	return updated;
}

/**
 * Delete a workspace and all its data.
 */
export async function deleteWorkspace(id: string): Promise<boolean> {
	const dir = await getWorkspacesDir();

	try {
		// Delete workspace folder (includes definition.json)
		await remove(await join(dir, id), { recursive: true });
		return true;
	} catch {
		return false;
	}
}
```

### apps/epicenter/src/routes/(workspace)/workspaces/[id]/+layout.ts

Update route loader:

```typescript
import { error } from '@sveltejs/kit';
import { getWorkspace } from '$lib/services/workspaces';
import { createWorkspaceClient } from '$lib/docs/workspace';

export async function load({ params }) {
	const { id } = params;

	// Load definition from JSON file
	const definition = await getWorkspace(id);
	if (!definition) {
		throw error(404, `Workspace "${id}" not found`);
	}

	// Create workspace client
	const client = createWorkspaceClient(definition);
	await client.whenSynced;

	return {
		definition,
		client,
	};
}
```

## Implementation Steps

### Phase 1: Package Changes (packages/epicenter)

1. **Update `createWorkspace` with overload**
   - Add function overload for `createWorkspace(definition)`
   - Detect simple vs versioned mode
   - Create Y.Doc with `gc: true` for simple mode
   - Pass `definition` through to ExtensionContext

2. **Update `ExtensionContext` type**
   - Add `definition` field

3. **Update exports**
   - Ensure all needed types are exported from `/dynamic`

### Phase 2: App Changes (apps/epicenter)

1. **Create workspaces service**
   - `listWorkspaces()` - glob JSON files
   - `getWorkspace(id)` - read single definition
   - `createWorkspaceDefinition()` - write new JSON + create folder
   - `updateWorkspaceDefinition()` - update JSON
   - `deleteWorkspace()` - remove JSON + folder

2. **Update workspace persistence**
   - Remove HeadDoc dependency
   - Remove epoch folders (flat structure)
   - Add SQLite materialized view (placeholder for now)

3. **Update workspace client factory**
   - Use new `createWorkspace(definition)` API
   - Remove HeadDoc creation

4. **Update route loaders**
   - Load definition from JSON
   - Pass to createWorkspaceClient

5. **Update UI components**
   - Use workspaces service for CRUD
   - Remove HeadDoc-related code

6. **Remove dead code**
   - `head.ts` / `head-persistence.ts` (not needed for simple mode)
   - `registry.ts` / `registry-persistence.ts` (using JSON files instead)
   - Any epoch-related code in persistence

### Phase 3: Templates

1. **Update template format**
   - Ensure templates match WorkspaceDefinition structure
   - Fix field definitions (array format, explicit IDs)

## File Changes Summary

### packages/epicenter/

| File                                        | Action                               |
| ------------------------------------------- | ------------------------------------ |
| `src/dynamic/workspace/create-workspace.ts` | Add overload for simple mode         |
| `src/dynamic/workspace/types.ts`            | Add `definition` to ExtensionContext |
| `src/dynamic/index.ts`                      | Verify exports                       |

### apps/epicenter/

| File                                    | Action                                  |
| --------------------------------------- | --------------------------------------- |
| `src/lib/services/workspaces.ts`        | **NEW** - Workspace CRUD via JSON files |
| `src/lib/docs/workspace.ts`             | Simplify to use new API                 |
| `src/lib/docs/workspace-persistence.ts` | Remove epochs, add SQLite placeholder   |
| `src/lib/docs/head.ts`                  | **DELETE** (not needed)                 |
| `src/lib/docs/head-persistence.ts`      | **DELETE** (not needed)                 |
| `src/lib/docs/registry.ts`              | **DELETE** (using JSON files)           |
| `src/lib/docs/registry-persistence.ts`  | **DELETE** (using JSON files)           |
| `src/lib/docs/reactive-head.svelte.ts`  | **DELETE** (not needed)                 |
| `src/lib/templates/*.ts`                | Fix to match WorkspaceDefinition format |
| `src/lib/query/workspaces.ts`           | Update to use workspaces service        |
| `src/routes/**/+layout.ts`              | Update loaders                          |

## Future Considerations

### Registry Y.Doc (Phase 2)

Later, we can add a Registry Y.Doc that stores definitions for sync:

```typescript
// Future: Registry stores definitions in YKeyValueLww
const registry = createRegistry();
registry.set('workspace-abc', definition); // LWW, syncs across devices

// Still write JSON mirrors for debugging/backup
```

### Versioned Workspaces

When `versionControl: true` is needed:

```typescript
// Future: Separate function or flag
const workspace = createVersionedWorkspace({ headDoc, definition });

// Or flag in definition
const definition = { ...def, versionControl: true };
const workspace = createWorkspace(definition); // Detects flag, uses HeadDoc internally
```

### SQLite Implementation

The SQLite materialized view needs:

- Drizzle schema generation from TableDefinition
- Full table dump on debounced save
- Query API via `workspace.extensions.sqlite.db`

This can be a separate extension or built into persistence.

## Testing

1. **Unit tests** for new `createWorkspace(definition)` overload
2. **Integration tests** for workspace service CRUD
3. **E2E tests** for workspace creation/loading flow
4. **Migration test** - existing workspaces should still work (or have migration path)

## Migration Path

Existing workspaces use the epoch folder structure:

```
workspaces/{id}/head.yjs
workspaces/{id}/{epoch}/workspace.yjs
```

Migration options:

1. **Manual**: User exports and reimports
2. **Automatic**: Detect old structure, migrate on first load
3. **Parallel**: Support both structures during transition

Recommendation: Start fresh for now (dev mode), add migration later if needed.

## Related Documents

- **Handoff Prompt**: `specs/20260201T120000-simple-definition-first-workspace-handoff.md` - Copy-paste prompt for agent execution
- **Archived Patterns**: `docs/articles/archived-head-registry-patterns.md` - HeadDoc and Registry patterns preserved for future versioned workspace implementation
- **GC Decision Guide**: `docs/articles/ykeyvalue-vs-ymap-decision-guide.md` - Why we use `gc: true` with YKeyValueLww
- **GC Deep Dive**: `docs/articles/ykeyvalue-gc-the-hidden-variable.md` - The hidden variable that determines data structure choice
- **Storage Guide**: `docs/articles/yjs-gc-on-vs-off-storage-guide.md` - Complete guide to GC on vs off
