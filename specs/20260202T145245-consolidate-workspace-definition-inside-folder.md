# Consolidate Workspace Definition Inside Folder

## Problem

Current workspace storage has redundancy:

```
workspaces/
├── {workspaceId}.json          # Definition file (OUTSIDE folder)
└── {workspaceId}/              # Data folder
    ├── workspace.yjs
    └── kv.json
```

The workspace ID appears twice: once as the JSON filename, once as the folder name. This diverges from the original architecture planned in `specs/20260117T004421-workspace-input-normalization.md`.

## Solution

Move the definition file inside the workspace folder and rename to `definition.json`:

```
workspaces/
└── {workspaceId}/
    ├── definition.json         # Definition file (INSIDE folder, renamed)
    ├── workspace.yjs
    └── kv.json
```

### Benefits

1. **Less redundancy**: Workspace ID only appears once (folder name)
2. **Self-contained**: Each workspace is a complete, portable folder
3. **Aligns with original spec**: Matches the architecture in `20260117T004421`
4. **Cleaner discovery**: List directories instead of globbing JSON files

## Files to Update

### Code Changes (TypeScript)

| File                                                   | Change                                                                                               |
| ------------------------------------------------------ | ---------------------------------------------------------------------------------------------------- |
| `apps/epicenter/src/lib/services/workspaces.ts`        | Update `getDefinitionPath()`, `listWorkspaces()`, `createWorkspaceDefinition()`, `deleteWorkspace()` |
| `apps/epicenter/src/lib/docs/workspace-persistence.ts` | Update comment on line 56-57                                                                         |

### Documentation Changes (Markdown)

| File                                                                 | Change                                     |
| -------------------------------------------------------------------- | ------------------------------------------ |
| `apps/epicenter/src/lib/docs/README.md`                              | Update storage layout diagram and examples |
| `specs/20260201T120000-simple-definition-first-workspace.md`         | Update storage layout                      |
| `specs/20260201T120000-simple-definition-first-workspace-handoff.md` | Update storage references                  |
| `specs/20260109T174900-epicenter-app-three-fetch-migration.md`       | Update path reference                      |
| `packages/epicenter/src/core/schema/schema-file.ts`                  | Update JSDoc comment                       |

### Files Already Correct (no changes needed)

These files already reference `definition.json` inside the folder:

- `specs/20260117T004421-workspace-input-normalization.md` (original spec - correct)
- `specs/20260119T150426-workspace-storage-architecture.md`
- `docs/specs/20260123T102500-single-workspace-architecture.md`
- `docs/specs/20260122T225052-subdoc-architecture.md`

## Implementation Plan

### Part 1: Update Core Service (`workspaces.ts`)

- [ ] Change `getDefinitionPath()` to return `join(workspacesDir, id, 'definition.json')`
- [ ] Update `listWorkspaces()` to:
  1. Read directories (not JSON files)
  2. For each directory, read `definition.json` inside it
- [ ] Update `createWorkspaceDefinition()` to:
  1. Create workspace folder first
  2. Write `definition.json` inside the folder
- [ ] Update `deleteWorkspace()` to only delete the folder (definition is inside)

### Part 2: Update Documentation

- [ ] Update `apps/epicenter/src/lib/docs/README.md` storage layout
- [ ] Update `apps/epicenter/src/lib/docs/workspace-persistence.ts` comment
- [ ] Update `specs/20260201T120000-simple-definition-first-workspace.md`
- [ ] Update `specs/20260201T120000-simple-definition-first-workspace-handoff.md`
- [ ] Update `specs/20260109T174900-epicenter-app-three-fetch-migration.md`
- [ ] Update `packages/epicenter/src/core/schema/schema-file.ts` JSDoc

## Code Changes

### `workspaces.ts` - Before

```typescript
async function getDefinitionPath(id: string): Promise<string> {
	const workspacesDir = await getWorkspacesDir();
	return join(workspacesDir, `${id}.json`);
}

export async function listWorkspaces(): Promise<WorkspaceDefinition[]> {
	const workspacesDir = await getWorkspacesDir();
	// ... reads *.json files
	for (const entry of entries) {
		if (!entry.name.endsWith('.json')) continue;
		// ...
	}
}
```

### `workspaces.ts` - After

```typescript
async function getDefinitionPath(id: string): Promise<string> {
	const workspacesDir = await getWorkspacesDir();
	return join(workspacesDir, id, 'definition.json');
}

export async function listWorkspaces(): Promise<WorkspaceDefinition[]> {
	const workspacesDir = await getWorkspacesDir();
	// ... reads directories, then definition.json inside each
	for (const entry of entries) {
		if (!entry.isDirectory) continue;
		const definitionPath = await join(
			workspacesDir,
			entry.name,
			'definition.json',
		);
		// ...
	}
}
```

## Migration Consideration

Existing workspaces will need migration. Options:

1. **Manual migration**: User moves files manually (not recommended)
2. **Automatic migration on startup**: App detects old format and migrates
3. **Breaking change**: Since this is pre-release, just document the change

**Recommendation**: Option 3 (breaking change) since Epicenter is pre-release. Document in changelog that users should manually move `{id}.json` to `{id}/definition.json`.

## Testing

1. Create a new workspace - verify `{id}/definition.json` is created
2. List workspaces - verify discovery works
3. Get workspace by ID - verify loading works
4. Delete workspace - verify cleanup works
5. Verify existing workspace data (`workspace.yjs`, `kv.json`) is unaffected

---

## Review

### Summary

Implemented the consolidation of workspace definition files from `{workspaceId}.json` (outside) to `{workspaceId}/definition.json` (inside the workspace folder).

### Files Changed

| File                                                                 | Change                                                                                                                    |
| -------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| `apps/epicenter/src/lib/services/workspaces.ts`                      | Core CRUD service - updated `getDefinitionPath()`, `listWorkspaces()`, `createWorkspaceDefinition()`, `deleteWorkspace()` |
| `apps/epicenter/src/lib/docs/workspace-persistence.ts`               | Updated JSDoc comment to reflect new storage layout                                                                       |
| `apps/epicenter/src/lib/docs/README.md`                              | Updated storage layout diagram, examples, and discovery description                                                       |
| `packages/epicenter/src/core/schema/schema-file.ts`                  | Updated JSDoc comment                                                                                                     |
| `specs/20260201T120000-simple-definition-first-workspace.md`         | Updated storage layout and code examples                                                                                  |
| `specs/20260201T120000-simple-definition-first-workspace-handoff.md` | Updated storage layout and references                                                                                     |
| `specs/20260109T174900-epicenter-app-three-fetch-migration.md`       | Updated path reference                                                                                                    |

### Key Implementation Details

1. **`getDefinitionPath()`**: Now returns `join(workspacesDir, id, 'definition.json')` instead of `join(workspacesDir, `${id}.json`)`

2. **`listWorkspaces()`**: Now lists directories (via `entry.isDirectory`) and reads `definition.json` from each, instead of globbing `*.json` files

3. **`createWorkspaceDefinition()`**: Creates workspace folder first, then writes `definition.json` inside

4. **`deleteWorkspace()`**: Simplified to just delete the folder recursively (definition is inside)

### Migration Note

This is a **breaking change** for existing workspaces. Users with existing workspaces need to manually migrate:

```bash
# For each workspace:
mv {appLocalDataDir}/workspaces/{id}.json {appLocalDataDir}/workspaces/{id}/definition.json
```

### Verification

- [x] All LSP diagnostics clean
- [x] TypeScript compilation passes
- [x] Code changes match the original spec architecture from `20260117T004421`
