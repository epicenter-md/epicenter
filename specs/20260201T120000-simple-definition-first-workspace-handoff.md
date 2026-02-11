# Agent Handoff: Simple Definition-First Workspace Implementation

**Spec**: `specs/20260201T120000-simple-definition-first-workspace.md`
**Branch**: `feat/auto-injected-version-discriminant`

---

## Context

You are implementing a simplified workspace API for the Epicenter app. The goal is to enable a **definition-first** pattern where:

1. Workspace schema lives in JSON files (`{workspaceId}/definition.json`)
2. `createWorkspace(definition)` takes a `WorkspaceDefinition` directly (no HeadDoc needed)
3. Y.Doc is created with `gc: true` for efficient storage
4. No epoch folders - flat structure

Read the full spec at `specs/20260201T120000-simple-definition-first-workspace.md` before starting.

---

## Your Tasks

### Phase 1: Package Changes (`packages/epicenter/src/dynamic`)

**1.1 Update `workspace/create-workspace.ts`**

Add a function overload so `createWorkspace` can accept either:

- `definition` directly (simple mode, new)
- `{ headDoc, definition }` config object (versioned mode, existing)

```typescript
// Simple mode - NEW
export function createWorkspace<...>(
  definition: WorkspaceDefinition<TTableDefinitions, TKvFields>,
): WorkspaceClientBuilder<TTableDefinitions, TKvFields>;

// Versioned mode - EXISTING
export function createWorkspace<...>(
  config: CreateWorkspaceConfig<TTableDefinitions, TKvFields>,
): WorkspaceClientBuilder<TTableDefinitions, TKvFields>;

// Implementation detects which overload
export function createWorkspace<...>(
  configOrDefinition: WorkspaceDefinition<...> | CreateWorkspaceConfig<...>,
): WorkspaceClientBuilder<...> {
  const isSimpleMode = 'id' in configOrDefinition && !('headDoc' in configOrDefinition);

  if (isSimpleMode) {
    const definition = configOrDefinition;
    const ydoc = new Y.Doc({ guid: definition.id, gc: true }); // gc: true!
    // ... create tables, kv, return builder
  } else {
    // existing versioned implementation
  }
}
```

Key differences in simple mode:

- `gc: true` (not `gc: false` like versioned mode)
- `workspaceId` comes from `definition.id`
- `epoch` is always `0`

**1.2 Update `workspace/types.ts`**

Add `definition` to `ExtensionContext`:

```typescript
export type ExtensionContext<TTableDefinitions, TKvFields> = {
	ydoc: Y.Doc;
	workspaceId: string;
	epoch: number;
	tables: Tables<TTableDefinitions>;
	kv: Kv<TKvFields>;
	extensionId: string;
	definition: WorkspaceDefinition<TTableDefinitions, TKvFields>; // ADD THIS
};
```

Update `create-workspace.ts` to pass definition into the context.

**1.3 Verify exports in `index.ts`**

Ensure `WorkspaceDefinition` type is exported from `@epicenter/hq/dynamic`.

---

### Phase 2: App Changes (`apps/epicenter`)

**2.1 Create `src/lib/services/workspaces.ts`**

New service for workspace CRUD via JSON files:

```typescript
// List all workspaces (list directories, read definition.json from each)
export async function listWorkspaces(): Promise<WorkspaceDefinition[]>

// Get single workspace by ID
export async function getWorkspace(id: string): Promise<WorkspaceDefinition | null>

// Create new workspace (write JSON + create folder)
export async function createWorkspaceDefinition(input: ...): Promise<WorkspaceDefinition>

// Update workspace definition
export async function updateWorkspaceDefinition(id: string, updates: ...): Promise<WorkspaceDefinition | null>

// Delete workspace (remove JSON + folder)
export async function deleteWorkspace(id: string): Promise<boolean>
```

Storage layout:

```
{appLocalDataDir}/workspaces/
└── {id}/
    ├── definition.json   # WorkspaceDefinition
    ├── workspace.yjs     # Y.Doc binary
    └── kv.json           # KV values mirror
```

**2.2 Simplify `src/lib/docs/workspace.ts`**

Replace complex HeadDoc-based creation with:

```typescript
import {
	createWorkspace,
	type WorkspaceDefinition,
} from '@epicenter/hq/dynamic';
import { workspacePersistence } from './workspace-persistence';

export function createWorkspaceClient(definition: WorkspaceDefinition) {
	return createWorkspace(definition).withExtensions({
		persistence: (ctx) => workspacePersistence(ctx),
	});
}
```

**2.3 Update `src/lib/docs/workspace-persistence.ts`**

Simplify to flat structure (no epochs):

- Remove epoch folder logic
- Storage paths: `{id}/definition.json`, `{id}/workspace.yjs`, `{id}/kv.json`
- Skip SQLite for now (placeholder or remove)

**2.4 Archive old files (don't delete)**

Move these to `src/lib/docs/_archive/` for future reference:

- `head.ts`
- `head-persistence.ts`
- `registry.ts`
- `registry-persistence.ts`
- `reactive-head.svelte.ts`

**2.5 Update `src/lib/query/workspaces.ts`**

Replace with calls to the new workspaces service. The TanStack Query layer should:

- Use `listWorkspaces()` for queries
- Use `createWorkspaceDefinition()`, `updateWorkspaceDefinition()`, `deleteWorkspace()` for mutations

**2.6 Update route loaders**

`src/routes/(workspace)/workspaces/[id]/+layout.ts`:

```typescript
import { error } from '@sveltejs/kit';
import { getWorkspace } from '$lib/services/workspaces';
import { createWorkspaceClient } from '$lib/docs/workspace';

export async function load({ params }) {
	const definition = await getWorkspace(params.id);
	if (!definition) {
		throw error(404, `Workspace not found`);
	}

	const client = createWorkspaceClient(definition);
	await client.whenSynced;

	return { definition, client };
}
```

**2.7 Fix templates**

`src/lib/templates/entries.ts` and `whispering.ts` need to match `WorkspaceDefinition` format:

- `tables` should be an array of `TableDefinition`
- Each field needs explicit `id` property
- Use: `text({ id: 'title', name: 'Title' })` not `text({ name: 'Title' })`

---

## Validation

After implementation, run:

```bash
# Type check package
cd packages/epicenter && bun run typecheck

# Type check app
cd apps/epicenter && bun run typecheck

# Run tests
bun test
```

The app should:

1. List workspaces by reading `*.json` files
2. Create new workspaces (writes JSON + creates folder)
3. Open workspaces (loads definition from JSON, creates Y.Doc client)
4. Persist changes (workspace.yjs immediate, kv.json debounced)

---

## Important Notes

1. **GC Setting**: Simple mode MUST use `gc: true` for efficient YKeyValueLww storage. This is critical - see `docs/articles/ykeyvalue-gc-the-hidden-variable.md`.

2. **Don't delete old code**: Archive to `_archive/` folder for future reference. The head/registry patterns will be needed when implementing versioned workspaces.

3. **Skip SQLite for now**: The spec mentions SQLite materialized views but this can be a follow-up task. Focus on the core JSON + YJS persistence first.

4. **Imports**: The app imports from `@epicenter/hq` (the root), which re-exports from dynamic. Make sure the new types/functions are exported properly.

---

## Files Summary

### Create

- `apps/epicenter/src/lib/services/workspaces.ts`
- `apps/epicenter/src/lib/docs/_archive/` (folder)

### Modify

- `packages/epicenter/src/dynamic/workspace/create-workspace.ts`
- `packages/epicenter/src/dynamic/workspace/types.ts`
- `apps/epicenter/src/lib/docs/workspace.ts`
- `apps/epicenter/src/lib/docs/workspace-persistence.ts`
- `apps/epicenter/src/lib/query/workspaces.ts`
- `apps/epicenter/src/lib/templates/entries.ts`
- `apps/epicenter/src/lib/templates/whispering.ts`
- `apps/epicenter/src/routes/(workspace)/workspaces/[id]/+layout.ts`

### Archive (move to `_archive/`)

- `apps/epicenter/src/lib/docs/head.ts`
- `apps/epicenter/src/lib/docs/head-persistence.ts`
- `apps/epicenter/src/lib/docs/registry.ts`
- `apps/epicenter/src/lib/docs/registry-persistence.ts`
- `apps/epicenter/src/lib/docs/reactive-head.svelte.ts`

---

## Related Documents

- **Full Specification**: `specs/20260201T120000-simple-definition-first-workspace.md`
- **Archived Patterns**: `docs/articles/archived-head-registry-patterns.md` - HeadDoc and Registry patterns for future versioned workspace implementation
- **GC Decision Guide**: `docs/articles/ykeyvalue-vs-ymap-decision-guide.md`
