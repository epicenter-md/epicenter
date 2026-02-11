# Epicenter App: Three-Fetch Pattern Migration

**Created**: 2026-01-09T17:49:00  
**Updated**: 2026-01-09T18:10:00  
**Status**: Ready for Implementation

## Problem

The `apps/epicenter` app stores workspace schemas as JSON files (`AppLocalData/workspaces/{id}/definition.json`) and creates clients directly without following the three-fetch protocol documented in `packages/epicenter/src/core/docs/README.md`.

Current flow (broken):

```
JSON file → defineWorkspace() → workspace.create()
```

Target flow (three-fetch pattern):

```
Registry Doc → Head Doc → workspace.create({ epoch })
     ↓             ↓              ↓
  Get IDs     Get epoch    Create client at epoch
```

## Architecture Overview

### The Three Documents

| Step | Document  | Y.Doc GUID              | File Path                              | Purpose                     |
| ---- | --------- | ----------------------- | -------------------------------------- | --------------------------- |
| 1    | Registry  | `local`                 | `registry.yjs`                         | List of workspace GUIDs     |
| 2    | Head      | `{workspaceId}`         | `workspaces/{workspaceId}/head.yjs`    | Current epoch for workspace |
| 3    | Workspace | `{workspaceId}-{epoch}` | `workspaces/{workspaceId}/{epoch}.yjs` | Schema + data               |

### File System Structure

All files stored in Tauri's `appLocalDataDir()`:

- macOS: `~/Library/Application Support/{bundle-identifier}/`
- Windows: `C:\Users\{user}\AppData\Local\{bundle-identifier}\`
- Linux: `~/.local/share/{bundle-identifier}/`

```
{appLocalDataDir}/
├── registry.yjs                      # Single registry doc
└── workspaces/
    ├── abc123xyz789012/              # Folder per workspace (GUID as folder name)
    │   ├── head.yjs                  # Epoch pointer for this workspace
    │   ├── 0.yjs                     # Workspace doc at epoch 0
    │   └── 1.yjs                     # Workspace doc at epoch 1 (after migration)
    │
    └── def456uvw890345/              # Another workspace
        ├── head.yjs
        └── 0.yjs
```

### Key Insight: Schema Lives in Workspace Doc

The `defineWorkspace()` config gets merged INTO the Y.Doc on `.create()`. The Y.Doc IS the source of truth. The code schema is just the initial seed that gets merged (idempotent).

This means:

- No separate JSON file needed for schema storage
- Schema can evolve via CRDT (Notion-like collaborative schema editing)
- Epochs enable migrations and compaction

### Routing: Slug in URL, GUID Internally

- **URL**: `/workspaces/{slug}` (human-readable, e.g., `my-blog`)
- **File system**: `workspaces/{guid}/` (stable identifier)
- **Mapping**: Registry stores GUID, workspace doc stores slug in metadata

When navigating to `/workspaces/my-blog`:

1. Get all workspace GUIDs from registry
2. For each, check workspace doc metadata for matching slug
3. Or: maintain a slug→GUID index in registry

## Implementation Plan

### Phase 1: Tauri Persistence Providers

Create specialized persistence providers in the app (not in `@epicenter/hq` package).

#### File: `apps/epicenter/src/lib/capabilities/tauri-persistence.ts`

```typescript
import { readFile, writeFile, mkdir } from '@tauri-apps/plugin-fs';
import { appLocalDataDir, join } from '@tauri-apps/api/path';
import * as Y from 'yjs';

// ─────────────────────────────────────────────────────────────────────────────
// Internal: Shared persistence logic
// ─────────────────────────────────────────────────────────────────────────────

async function persistYDoc(ydoc: Y.Doc, relativePath: string) {
	const baseDir = await appLocalDataDir();
	const filePath = await join(baseDir, ...relativePath.split('/'));

	// Ensure parent directory exists
	// Use Tauri's join() for cross-platform path handling
	const pathParts = relativePath.split('/');
	if (pathParts.length > 1) {
		const parentParts = pathParts.slice(0, -1);
		const parentDir = await join(baseDir, ...parentParts);
		await mkdir(parentDir, { recursive: true }).catch(() => {});
	}

	// Load existing state
	try {
		const savedState = await readFile(filePath);
		Y.applyUpdate(ydoc, new Uint8Array(savedState));
	} catch {
		// File doesn't exist yet - that's fine
	}

	// Auto-save on updates
	const saveHandler = async () => {
		const state = Y.encodeStateAsUpdate(ydoc);
		await writeFile(filePath, state);
	};
	ydoc.on('update', saveHandler);

	return {
		whenSynced: Promise.resolve(),
		destroy() {
			ydoc.off('update', saveHandler);
		},
	};
}

// ─────────────────────────────────────────────────────────────────────────────
// Exported: Specialized providers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Persist the registry doc to `registry.yjs`.
 *
 * The registry stores which workspace GUIDs exist for this user.
 */
export function registryPersistence(ydoc: Y.Doc) {
	return persistYDoc(ydoc, 'registry.yjs');
}

/**
 * Persist a head doc to `workspaces/{workspaceId}/head.yjs`.
 *
 * The head doc stores the current epoch for a workspace.
 */
export function headPersistence(ydoc: Y.Doc, workspaceId: string) {
	return persistYDoc(ydoc, `workspaces/${workspaceId}/head.yjs`);
}

/**
 * Persist a workspace doc to `workspaces/{workspaceId}/{epoch}.yjs`.
 *
 * The workspace doc stores schema + data at a specific epoch.
 */
export function workspacePersistence(
	ydoc: Y.Doc,
	workspaceId: string,
	epoch: number,
) {
	return persistYDoc(ydoc, `workspaces/${workspaceId}/${epoch}.yjs`);
}
```

**Important Tauri path handling notes:**

- Use `join()` from `@tauri-apps/api/path` for cross-platform paths
- Never use string concatenation with `/` directly for file paths
- `appLocalDataDir()` returns the platform-specific app data directory
- All paths are relative to the app's data directory

### Phase 2: Workspace Registry Service

Create a service that manages the three-fetch pattern.

#### File: `apps/epicenter/src/lib/services/workspace-registry.ts`

```typescript
import {
	createRegistryDoc,
	createHeadDoc,
	generateGuid,
	type RegistryDoc,
	type HeadDoc,
	type WorkspaceSchema,
} from '@epicenter/hq';
import {
	registryPersistence,
	headPersistence,
} from '$lib/capabilities/tauri-persistence';

// ─────────────────────────────────────────────────────────────────────────────
// Module State
// ─────────────────────────────────────────────────────────────────────────────

const REGISTRY_ID = 'local';

let registry: RegistryDoc | null = null;
let registryInitPromise: Promise<RegistryDoc> | null = null;

const headDocs = new Map<string, HeadDoc>();
const headInitPromises = new Map<string, Promise<HeadDoc>>();

// In-memory schema cache (loaded from workspace docs on demand)
const schemaCache = new Map<string, WorkspaceSchema>();

// ─────────────────────────────────────────────────────────────────────────────
// Registry Access
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Get the registry doc (singleton, lazy-initialized with persistence).
 */
export async function getRegistry(): Promise<RegistryDoc> {
	if (registry) return registry;

	// Avoid race conditions on concurrent calls
	if (!registryInitPromise) {
		registryInitPromise = (async () => {
			const doc = createRegistryDoc({ registryId: REGISTRY_ID });
			await registryPersistence(doc.ydoc);
			registry = doc;
			return doc;
		})();
	}

	return registryInitPromise;
}

// ─────────────────────────────────────────────────────────────────────────────
// Head Doc Access
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Get a head doc for a workspace (cached, lazy-initialized with persistence).
 */
export async function getHeadDoc(workspaceId: string): Promise<HeadDoc> {
	const existing = headDocs.get(workspaceId);
	if (existing) return existing;

	// Avoid race conditions on concurrent calls for same workspace
	let initPromise = headInitPromises.get(workspaceId);
	if (!initPromise) {
		initPromise = (async () => {
			const doc = createHeadDoc({ workspaceId });
			await headPersistence(doc.ydoc, workspaceId);
			headDocs.set(workspaceId, doc);
			return doc;
		})();
		headInitPromises.set(workspaceId, initPromise);
	}

	return initPromise;
}

// ─────────────────────────────────────────────────────────────────────────────
// Schema Cache (for defineWorkspace config)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Store a workspace schema in the cache.
 *
 * This is used when creating a new workspace to remember the schema
 * before the workspace doc is created.
 */
export function setWorkspaceSchema(
	workspaceId: string,
	schema: WorkspaceSchema,
) {
	schemaCache.set(workspaceId, schema);
}

/**
 * Get a workspace schema from the cache.
 *
 * Returns undefined if not cached. In the future, this could load
 * from the workspace doc's schema map.
 */
export function getWorkspaceSchema(
	workspaceId: string,
): WorkspaceSchema | undefined {
	return schemaCache.get(workspaceId);
}

// ─────────────────────────────────────────────────────────────────────────────
// Lookup Helpers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Find a workspace GUID by its slug.
 *
 * Searches through cached schemas. Returns undefined if not found.
 */
export function findWorkspaceBySlug(slug: string): WorkspaceSchema | undefined {
	for (const schema of schemaCache.values()) {
		if (schema.slug === slug) {
			return schema;
		}
	}
	return undefined;
}

/**
 * Get all workspace schemas (from cache).
 */
export function getAllWorkspaceSchemas(): WorkspaceSchema[] {
	return Array.from(schemaCache.values());
}
```

### Phase 3: Update Query Layer

#### File: `apps/epicenter/src/lib/query/workspaces.ts`

Replace JSON file operations with registry operations:

```typescript
import { defineQuery, defineMutation, queryClient } from './client';
import {
	getRegistry,
	getHeadDoc,
	getWorkspaceSchema,
	setWorkspaceSchema,
	getAllWorkspaceSchemas,
	findWorkspaceBySlug,
} from '$lib/services/workspace-registry';
import { generateGuid } from '@epicenter/hq';
import { Ok, Err } from 'wellcrafted/result';

const workspaceKeys = {
	all: ['workspaces'] as const,
	list: () => [...workspaceKeys.all, 'list'] as const,
	detail: (id: string) => [...workspaceKeys.all, 'detail', id] as const,
};

export const workspaces = {
	listWorkspaces: defineQuery({
		queryKey: workspaceKeys.list(),
		queryFn: async () => {
			const registry = await getRegistry();
			const guids = registry.getWorkspaceIds();

			// Return schemas from cache
			// Filter out any that aren't cached (shouldn't happen normally)
			const schemas = guids
				.map((guid) => getWorkspaceSchema(guid))
				.filter((s): s is WorkspaceSchema => s !== undefined);

			return Ok(schemas);
		},
	}),

	getWorkspace: (slugOrGuid: string) =>
		defineQuery({
			queryKey: workspaceKeys.detail(slugOrGuid),
			queryFn: async () => {
				// Try direct GUID lookup first
				let schema = getWorkspaceSchema(slugOrGuid);

				// Fall back to slug lookup
				if (!schema) {
					schema = findWorkspaceBySlug(slugOrGuid);
				}

				if (!schema) {
					return Err({ message: `Workspace "${slugOrGuid}" not found` });
				}

				return Ok(schema);
			},
		}),

	createWorkspace: defineMutation({
		mutationKey: ['workspaces', 'create'],
		mutationFn: async (input: { name: string; slug: string }) => {
			const registry = await getRegistry();

			// Check if slug already exists
			if (findWorkspaceBySlug(input.slug)) {
				return Err({
					message: `Workspace with slug "${input.slug}" already exists`,
				});
			}

			// Generate GUID for sync coordination
			const guid = generateGuid();

			// Create schema
			const schema: WorkspaceSchema = {
				id: guid,
				slug: input.slug,
				name: input.name,
				tables: {},
				kv: {},
			};

			// Cache the schema
			setWorkspaceSchema(guid, schema);

			// Add to registry (persisted automatically)
			registry.addWorkspace(guid);

			// Initialize head doc (creates file, epoch starts at 0)
			await getHeadDoc(guid);

			// Invalidate list query
			queryClient.invalidateQueries({ queryKey: workspaceKeys.list() });

			return Ok(schema);
		},
	}),

	deleteWorkspace: defineMutation({
		mutationKey: ['workspaces', 'delete'],
		mutationFn: async (guid: string) => {
			const registry = await getRegistry();

			// Remove from registry
			registry.removeWorkspace(guid);

			// Note: This doesn't delete the files. That's intentional for now.
			// In the future, add file cleanup here.

			queryClient.invalidateQueries({ queryKey: workspaceKeys.list() });
			queryClient.removeQueries({ queryKey: workspaceKeys.detail(guid) });

			return Ok(undefined);
		},
	}),

	// Table and KV operations move to workspace client actions
	// (they operate on the live workspace doc, not storage)
};
```

### Phase 4: Update Layout Load

#### File: `apps/epicenter/src/routes/(workspace)/workspaces/[id]/+layout.ts`

```typescript
import { defineWorkspace } from '@epicenter/hq';
import {
	getHeadDoc,
	getWorkspaceSchema,
	findWorkspaceBySlug,
} from '$lib/services/workspace-registry';
import { workspacePersistence } from '$lib/capabilities/tauri-persistence';
import { error } from '@sveltejs/kit';
import type { LayoutLoad } from './$types';

export const load: LayoutLoad = async ({ params }) => {
	// Step 1: Find workspace by slug (params.id is the slug from URL)
	const schema =
		findWorkspaceBySlug(params.id) ?? getWorkspaceSchema(params.id);

	if (!schema) {
		error(404, { message: `Workspace "${params.id}" not found` });
	}

	// Step 2: Get epoch from Head Doc
	const head = await getHeadDoc(schema.id);
	const epoch = head.getEpoch();

	// Step 3: Create client at this epoch
	const workspace = defineWorkspace(schema);
	const client = await workspace.create({
		epoch,
		capabilities: {
			persistence: (ctx) => workspacePersistence(ctx.ydoc, schema.id, epoch),
		},
	});

	// Wait for persistence to load existing data
	await client.capabilities.persistence.whenSynced;

	return {
		workspace: schema,
		client,
		head,
		epoch,
	};
};
```

### Phase 5: Bootstrap on App Start

The registry and cached schemas need to be loaded when the app starts.

#### File: `apps/epicenter/src/lib/services/bootstrap.ts`

```typescript
import { getRegistry, setWorkspaceSchema } from './workspace-registry';
import { defineWorkspace } from '@epicenter/hq';
import { workspacePersistence } from '$lib/capabilities/tauri-persistence';

/**
 * Bootstrap the app by loading the registry and all workspace schemas.
 *
 * Call this once on app initialization (e.g., in root +layout.ts).
 */
export async function bootstrap() {
	const registry = await getRegistry();
	const guids = registry.getWorkspaceIds();

	// Load each workspace's schema from its workspace doc
	for (const guid of guids) {
		await loadWorkspaceSchema(guid);
	}
}

/**
 * Load a workspace's schema from its workspace doc into the cache.
 */
async function loadWorkspaceSchema(guid: string) {
	// Create a temporary workspace to load from
	const tempWorkspace = defineWorkspace({
		id: guid,
		slug: '', // Will be read from doc
		name: '', // Will be read from doc
		tables: {},
		kv: {},
	});

	// Load at epoch 0 to read schema
	// Note: In the future, should read from head doc first
	const tempClient = await tempWorkspace.create({
		epoch: 0,
		capabilities: {
			persistence: (ctx) => workspacePersistence(ctx.ydoc, guid, 0),
		},
	});

	await tempClient.capabilities.persistence.whenSynced;

	// Read schema from the Y.Doc's meta and schema maps
	const metaMap = tempClient.ydoc.getMap<string>('meta');
	const schemaMap = tempClient.ydoc.getMap('schema');

	const name = metaMap.get('name') ?? 'Untitled';
	const slug = metaMap.get('slug') ?? guid;

	// Reconstruct schema from Y.Doc
	// This is a simplified version - full implementation would read tables/kv too
	const schema = {
		id: guid,
		slug,
		name,
		tables: {}, // TODO: Read from schemaMap
		kv: {}, // TODO: Read from schemaMap
	};

	setWorkspaceSchema(guid, schema);

	// Clean up temp client
	await tempClient.destroy();
}
```

## Files Changed Summary

| File                                                               | Action      | Description                                           |
| ------------------------------------------------------------------ | ----------- | ----------------------------------------------------- |
| `apps/epicenter/src/lib/capabilities/tauri-persistence.ts`         | **Create**  | Three specialized Tauri persistence providers         |
| `apps/epicenter/src/lib/services/workspace-registry.ts`            | **Create**  | Registry/Head doc management with caching             |
| `apps/epicenter/src/lib/services/bootstrap.ts`                     | **Create**  | App initialization, loads schemas from workspace docs |
| `apps/epicenter/src/lib/services/workspace-storage.ts`             | **Delete**  | No longer needed (JSON file storage)                  |
| `apps/epicenter/src/lib/query/workspaces.ts`                       | **Rewrite** | Use registry instead of JSON files                    |
| `apps/epicenter/src/routes/(workspace)/workspaces/[id]/+layout.ts` | **Rewrite** | Three-fetch pattern                                   |
| `apps/epicenter/src/routes/+layout.ts`                             | **Update**  | Call bootstrap() on app init                          |

## Decisions Made

1. **No `.epicenter/` subfolder** — App data directory is already app-specific
2. **Slug in URLs, GUID in filesystem** — Best of both worlds
3. **Specialized providers (Option B)** — Path logic centralized, type-safe
4. **Tauri persistence in app, not package** — Keeps `@epicenter/hq` dependency-lean
5. **No backwards compatibility** — Existing JSON workspaces won't be migrated

## Open Implementation Questions

These can be decided by the implementing agent:

1. **Schema reconstruction from Y.Doc** — The `bootstrap.ts` loads schemas from workspace docs. The exact structure of reading tables/kv from the schema Y.Map needs implementation.

2. **Error handling granularity** — Should persistence failures be:
   - Silent (log only)
   - Surfaced to UI
   - Fatal errors

3. **Write debouncing** — Should `persistYDoc` debounce writes to avoid excessive I/O on rapid changes? Current implementation writes on every update.

4. **Workspace deletion** — Current plan removes from registry but doesn't delete files. Should it clean up `workspaces/{guid}/` folder?

5. **Slug uniqueness enforcement** — Current check is in-memory only. Need to ensure uniqueness across app restarts.

## Todo

- [ ] Create `tauri-persistence.ts` with three specialized providers
- [ ] Create `workspace-registry.ts` service
- [ ] Create `bootstrap.ts` for app initialization
- [ ] Update root `+layout.ts` to call bootstrap
- [ ] Rewrite `workspaces.ts` query layer
- [ ] Rewrite workspace `+layout.ts` for three-fetch pattern
- [ ] Delete `workspace-storage.ts`
- [ ] Update `+page.svelte` home page if needed
- [ ] Test: Create workspace → restart app → workspace still exists
- [ ] Test: Navigate to workspace by slug
- [ ] Test: Multiple workspaces with different epochs

## References

- `packages/epicenter/src/core/docs/README.md` — Three-document architecture
- `packages/epicenter/src/core/docs/head-doc.ts` — CRDT-safe epoch implementation
- `packages/epicenter/src/core/docs/registry-doc.ts` — Registry implementation
- `packages/epicenter/src/core/workspace/contract.ts` — defineWorkspace/create
- `packages/epicenter/src/core/workspace/README.md` — Workspace usage patterns
- Tauri Plugin FS: https://v2.tauri.app/plugin/file-system/
- Tauri Path API: https://v2.tauri.app/reference/javascript/api/namespacepath/
