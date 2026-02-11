# Unified Workspace Architecture

**Status**: Design Revised - Grid HeadDoc only
**Created**: 2026-01-30
**Updated**: 2026-01-30

> **Update**: Design decision was made to NOT add HeadDoc to Static workspaces.
> Static uses simple binary backups; Grid uses HeadDoc/epochs for time-travel.
> See `20260130T135852-unified-workspace-api-pattern.md` for rationale.
> **Depends On**:

- `20260130T025939-grid-workspace-api.md` (Grid Workspace spec)
- `20260119T150426-workspace-storage-architecture.md` (Storage architecture)
- `20260107T005800-workspace-guid-and-epochs.md` (GUID and epochs)

## Overview

This spec defines a unified architecture for both **Grid** (cell-level CRDT) and **Static** (row-level versioned) workspaces, sharing:

1. **Optional HeadDoc pattern** - Same Y.Doc GUID strategy for both
2. **Unified persistence** - Single capability for all storage needs
3. **Revision history** - Snapshots that work with both workspace types
4. **App wiring patterns** - How Epicenter apps should compose these

## Core Principle: Two Storage Strategies, One Pattern

Both Grid and Static workspaces support two modes:

| Mode       | HeadDoc | Y.Doc GUID              | GC       | Time Travel | Use Case                                    |
| ---------- | ------- | ----------------------- | -------- | ----------- | ------------------------------------------- |
| **Simple** | Absent  | `{workspaceId}`         | Enabled  | No          | Prototypes, single-user, no rollback needed |
| **Full**   | Present | `{workspaceId}-{epoch}` | Disabled | Yes         | Collaborative, epochs, snapshots            |

The workspace type (Grid vs Static) is orthogonal to the HeadDoc mode.

## Y.Doc Architecture

### Simple Mode (No HeadDoc)

```
┌─────────────────────────────────────────────────────────────────┐
│  WORKSPACE Y.Doc                                                 │
│  GUID: "{workspaceId}"                                           │
│  GC: Enabled (default)                                           │
│                                                                  │
│  Y.Map('definition')  ← Schema                                   │
│  Y.Map('kv')          ← Settings                                 │
│  Y.Map('tables')      ← Data (Grid: cell-level, Static: row)    │
│                                                                  │
│  Single document. No epochs. No snapshots.                       │
└─────────────────────────────────────────────────────────────────┘
```

### Full Mode (With HeadDoc)

```
┌─────────────────────────────────────────────────────────────────┐
│  HEAD Y.Doc                                                      │
│  GUID: "{workspaceId}"                                           │
│                                                                  │
│  Y.Map('meta')                                                   │
│    ├── name: string                                              │
│    ├── icon: Icon | null                                         │
│    └── description: string                                       │
│                                                                  │
│  Y.Map('epochs')                                                 │
│    └── {clientId}: number   ← Per-client MAX pattern             │
│                                                                  │
│  Purpose: Stable pointer to current epoch                        │
└─────────────────────────────────────────────────────────────────┘
                              │
                              │ getEpoch() → 2
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│  WORKSPACE Y.Doc                                                 │
│  GUID: "{workspaceId}-{epoch}"   ← e.g., "my-workspace-2"        │
│  GC: Disabled (required for snapshots)                           │
│                                                                  │
│  Y.Map('definition')  ← Schema                                   │
│  Y.Map('kv')          ← Settings                                 │
│  Y.Map('tables')      ← Data                                     │
│                                                                  │
│  Each epoch is a separate Y.Doc. Snapshots live here.            │
└─────────────────────────────────────────────────────────────────┘
```

## API Design

### Grid Workspace (Cell-Level CRDT)

```typescript
// Simple mode - no HeadDoc
const gridClient = createGridWorkspace({
	id: 'my-workspace',
	definition,
}).withExtensions({ persistence });

// Full mode - with HeadDoc
const gridClient = createGridWorkspace({
	id: 'my-workspace',
	definition,
	headDoc, // Optional
}).withExtensions({ persistence, revisions });
```

### Static Workspace (Row-Level Versioned)

```typescript
// Simple mode - no HeadDoc (current behavior)
const staticClient = workspace.create({ persistence });

// Full mode - with HeadDoc (NEW)
const staticClient = workspace.create({
	headDoc, // Optional - NEW parameter
	capabilities: { persistence, revisions },
});
```

### Shared Creation Logic

Both workspace types use the same internal logic:

```typescript
function createWorkspaceYDoc(options: {
	workspaceId: string;
	headDoc?: HeadDoc;
}): Y.Doc {
	if (options.headDoc) {
		// Full mode: epoch-suffixed GUID, GC disabled
		const epoch = options.headDoc.getEpoch();
		return new Y.Doc({
			guid: `${options.workspaceId}-${epoch}`,
			gc: false,
		});
	} else {
		// Simple mode: plain GUID, GC enabled
		return new Y.Doc({
			guid: options.workspaceId,
			// gc: true (default)
		});
	}
}
```

## Unified Persistence

### Single Capability for All Storage

Instead of multiple persistence extensions, one unified capability handles everything:

```typescript
type WorkspacePersistenceConfig = {
	/** Base directory for all workspace storage */
	directory: string;

	/**
	 * What to persist. All optional.
	 * When HeadDoc present, files go in epoch folders.
	 * When HeadDoc absent, files go in workspace folder directly.
	 */
	outputs?: {
		/** Write workspace.yjs (full Y.Doc binary) - default: true */
		binary?: boolean;
		/** Write definition.json + kv.json - default: false */
		json?: boolean;
		/** Write tables.sqlite via Drizzle - default: false */
		sqlite?: boolean;
	};

	/** Revision history config. Only works when HeadDoc present. */
	revisions?: {
		/** Max snapshots to keep per epoch */
		maxVersions?: number;
		/** Debounce interval for auto-save (ms) */
		debounceMs?: number;
	};
};
```

### File Layout

**Simple Mode (No HeadDoc)**:

```
{directory}/{workspaceId}/
├── workspace.yjs           # Full Y.Doc binary
├── definition.json         # Schema (if json: true)
├── kv.json                 # Settings (if json: true)
└── tables.sqlite           # Data (if sqlite: true)
```

**Full Mode (With HeadDoc)**:

```
{directory}/{workspaceId}/
├── head.yjs                # HeadDoc (epoch pointer)
├── head.json               # Human-readable
│
├── 0/                      # Epoch 0
│   ├── workspace.yjs
│   ├── definition.json
│   ├── kv.json
│   ├── tables.sqlite
│   └── snapshots/
│       ├── 1704067200000.ysnap
│       └── 1704067200000.json  # { description: "..." }
│
└── 1/                      # Epoch 1
    ├── workspace.yjs
    ├── definition.json
    ├── kv.json
    ├── tables.sqlite
    └── snapshots/
        └── ...
```

### Persistence Capability Implementation

```typescript
export function workspacePersistence<TTableDefs, TKvDefs>(
  context: ExtensionContext<TTableDefs, TKvDefs>,
  config: WorkspacePersistenceConfig,
) {
  const { ydoc, workspaceId, epoch, headDoc } = context;
  const { directory, outputs = {}, revisions } = config;

  // Determine base path based on HeadDoc presence
  const basePath = headDoc
    ? path.join(directory, workspaceId, String(epoch))
    : path.join(directory, workspaceId);

  // Initialize outputs
  const exports: Record<string, unknown> = {};

  // Binary persistence (always)
  if (outputs.binary !== false) {
    // ... write workspace.yjs on updates
  }

  // JSON export
  if (outputs.json) {
    // ... observe definition/kv maps, write JSON
  }

  // SQLite materialization
  if (outputs.sqlite) {
    // ... Drizzle integration
    exports.db = drizzleDb;
    exports.tables = drizzleTables;
  }

  // Revision history (only if HeadDoc present)
  if (revisions && headDoc) {
    if (ydoc.gc) {
      throw new Error('Revision history requires gc: false');
    }
    // ... snapshot logic
    exports.revisions = {
      save: () => {...},
      list: () => {...},
      view: (index) => {...},
      restore: (index) => {...},
    };
  }

  return defineExports(exports);
}
```

## Revision History Integration

### When Snapshots Work

| Mode   | HeadDoc | GC       | Snapshots     |
| ------ | ------- | -------- | ------------- |
| Simple | Absent  | Enabled  | Not available |
| Full   | Present | Disabled | Available     |

### Snapshot Scope

Snapshots capture the entire Workspace Y.Doc (definition + kv + tables). They are **per-epoch**:

- Epoch 0 has its own snapshot history
- When you bump to epoch 1, snapshot history starts fresh
- Old epoch snapshots can still be viewed (read-only)

### API

```typescript
// Access via persistence extension
const { revisions } = client.extensions.persistence;

// Manual save with description
await revisions.save('Before major refactor');

// List all versions in current epoch
const versions = await revisions.list();
// → [{ timestamp, description?, size, filename }, ...]

// View historical state (read-only Y.Doc)
const oldDoc = await revisions.view(5);
const oldPosts = oldDoc.getMap('tables').get('posts');

// Restore to version (applies as new change, syncs to collaborators)
await revisions.restore(5);
```

## App Wiring Patterns

### Epicenter App Example

The Epicenter desktop app uses both workspace types:

```typescript
// apps/epicenter/src/lib/workspaces/whispering.ts

import { createGridWorkspace } from '@epicenter/hq/grid';
import { createHeadDoc } from '@epicenter/hq/core/docs';
import { workspacePersistence } from '@epicenter/hq/extensions/persistence';

// 1. Create HeadDoc (if you want epochs/snapshots)
const headDoc = createHeadDoc({
	workspaceId: 'epicenter.whispering',
	providers: {
		persistence: ({ ydoc }) =>
			headDocPersistence(ydoc, {
				filePath: join(
					epicenterDir,
					'workspaces',
					'epicenter.whispering',
					'head.yjs',
				),
			}),
	},
});

await headDoc.whenSynced;

// 2. Create workspace with HeadDoc
const whisperingWorkspace = createGridWorkspace({
	id: 'epicenter.whispering',
	definition: whisperingDefinition,
	headDoc, // Enables epochs + snapshots
}).withExtensions({
	persistence: (ctx) =>
		workspacePersistence(ctx, {
			directory: join(epicenterDir, 'workspaces'),
			outputs: { binary: true, json: true, sqlite: true },
			revisions: { maxVersions: 50 },
		}),
});

// 3. Access everything through the client
await whisperingWorkspace.whenSynced;

// Tables
const recordings = whisperingWorkspace.table('recordings').getAllValid();

// KV
const theme = whisperingWorkspace.kv.get('theme');

// SQLite queries
const { db, recordings: recordingsTable } =
	whisperingWorkspace.extensions.persistence;
const recent = await db
	.select()
	.from(recordingsTable)
	.orderBy(desc(recordingsTable.createdAt))
	.limit(10);

// Revision history
const { revisions } = whisperingWorkspace.extensions.persistence;
await revisions.save('Before bulk delete');
```

### Multiple Workspaces with Shared HeadDoc Pattern

```typescript
// apps/epicenter/src/lib/workspaces/index.ts

const epicenterDir = await getEpicenterDir();

// Factory for consistent HeadDoc creation
function createWorkspaceHeadDoc(workspaceId: string) {
	return createHeadDoc({
		workspaceId,
		providers: {
			persistence: ({ ydoc }) =>
				headDocPersistence(ydoc, {
					filePath: join(epicenterDir, 'workspaces', workspaceId, 'head.yjs'),
				}),
		},
	});
}

// Factory for consistent persistence config
function createPersistenceConfig(options?: {
	sqlite?: boolean;
	revisions?: boolean;
}) {
	return (ctx: ExtensionContext) =>
		workspacePersistence(ctx, {
			directory: join(epicenterDir, 'workspaces'),
			outputs: {
				binary: true,
				json: true,
				sqlite: options?.sqlite ?? false,
			},
			revisions: options?.revisions ? { maxVersions: 50 } : undefined,
		});
}

// Whispering workspace (Grid, with SQLite for queries)
const whisperingHead = createWorkspaceHeadDoc('epicenter.whispering');
await whisperingHead.whenSynced;

export const whispering = createGridWorkspace({
	id: 'epicenter.whispering',
	definition: whisperingDefinition,
	headDoc: whisperingHead,
}).withExtensions({
	persistence: createPersistenceConfig({ sqlite: true, revisions: true }),
});

// Settings workspace (Static, simpler needs)
const settingsHead = createWorkspaceHeadDoc('epicenter.settings');
await settingsHead.whenSynced;

export const settings = settingsWorkspace.create({
	headDoc: settingsHead,
	capabilities: {
		persistence: createPersistenceConfig({ revisions: false }),
	},
});
```

## Migration Path

### Grid Workspace (New)

Implement from scratch following this spec. No migration needed.

### Static Workspace (Update)

1. Add optional `headDoc` parameter to `workspace.create()`
2. Update Y.Doc creation to use shared logic
3. Existing code (no headDoc) continues to work unchanged

```typescript
// Before (still works)
const client = workspace.create({ persistence });

// After (new option)
const client = workspace.create({
	headDoc, // NEW
	capabilities: { persistence },
});
```

### Cell Workspace (Deprecate)

Cell workspace becomes Grid workspace. Add deprecation notice:

```typescript
/**
 * @deprecated Use createGridWorkspace() instead.
 * Migration: Replace `createCellWorkspace({ headDoc, definition })`
 * with `createGridWorkspace({ id: headDoc.workspaceId, definition, headDoc })`
 */
export function createCellWorkspace(...) { ... }
```

## Implementation Checklist

### Phase 1: Shared Utilities

- [x] Create `src/core/workspace-ydoc.ts` with `createWorkspaceYDoc()` helper
  - **Note**: Implemented inline in `grid/create-grid-workspace.ts` as `createWorkspaceYDoc()`
- [x] Extract Y.Doc GUID logic to be reusable

### Phase 2: Grid Workspace

- [x] Implement `src/grid/` following grid-workspace-api.md spec
- [x] Use shared `createWorkspaceYDoc()` for Y.Doc creation
- [x] Support optional HeadDoc

### Phase 3: Static Workspace Update

**Design Decision**: HeadDoc NOT added to Static. Static uses binary backups; Grid uses epochs/snapshots.

- [x] Static uses builder pattern: `createWorkspace({ id, tables }).withExtensions({ ... })`
- [N/A] ~~Add optional `headDoc` parameter~~ - Design decision: Static uses binary backups
- [N/A] ~~Add `epoch` to client~~ - Not needed without HeadDoc
- [N/A] ~~Toggle Y.Doc GUID~~ - Static always uses `{id}` as GUID
- [N/A] ~~Disable GC~~ - Static always has GC enabled (no snapshots)
- [x] "capabilities" kept as-is (distinct from Grid's "extensions")

### Phase 4: Unified Persistence

- [ ] Create `src/extensions/workspace-persistence.ts`
- [ ] Combine binary + json + sqlite + revisions
- [ ] Handle epoch folder structure when HeadDoc present
- [ ] Handle flat structure when HeadDoc absent

### Phase 5: Deprecation

- [ ] Mark Cell workspace as deprecated
- [ ] Add migration guide to README
- [ ] Update all examples

## Open Questions

1. **Should HeadDoc be created automatically?**
   - Currently: User creates HeadDoc separately, passes to workspace
   - Alternative: `createGridWorkspace({ id, definition, epochs: true })` creates HeadDoc internally
   - Recommendation: Keep explicit for now; easier to understand data flow

2. **Should Static support cell-level operations?**
   - Currently: Static is row-level only
   - Grid is cell-level only
   - Recommendation: Keep them separate; different use cases

3. **What happens when switching from Simple to Full mode?**
   - User starts without HeadDoc, later wants epochs
   - Recommendation: Manual migration; copy data to new workspace with HeadDoc

## Success Criteria

- [x] Grid supports optional HeadDoc for time-travel
- [x] Static uses simple binary backups (no HeadDoc - by design)
- [ ] Single persistence capability handles all storage needs
- [ ] Revision history works for Grid workspaces (HeadDoc present)
- [ ] Epicenter app uses appropriate workspace type per use case
- [ ] Clear migration path from Cell to Grid
- [ ] Documentation covers all wiring patterns
