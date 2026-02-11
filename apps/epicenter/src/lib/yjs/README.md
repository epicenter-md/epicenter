# Simple Definition-First Architecture

Epicenter uses a simple definition-first architecture where workspace schema lives in JSON files and Y.Doc contains only data.

## Overview

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                    SIMPLE DEFINITION-FIRST ARCHITECTURE                      │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│   ┌──────────────────────┐          ┌──────────────────────┐               │
│   │  DEFINITION (JSON)   │   ──▶    │    WORKSPACE DOC     │               │
│   │                      │          │                      │               │
│   │  "Schema + Metadata" │          │  "Data (Y.Doc)"      │               │
│   └──────────────────────┘          └──────────────────────┘               │
│           │                                  │                              │
│           ▼                                  ▼                              │
│     {id}/definition.json             {id}/workspace.yjs                     │
│                                      {id}/kv.json                           │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

## Storage Layout

```
{appLocalDataDir}/workspaces/
├── blog-workspace/
│   ├── definition.json              # WorkspaceDefinition (schema + metadata)
│   ├── workspace.yjs                # Y.Doc binary (source of truth)
│   └── kv.json                      # KV values mirror
└── notes-app/
    ├── definition.json
    ├── workspace.yjs
    └── kv.json
```

## Definition JSON Format

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
			"description": "Blog posts",
			"fields": [
				{ "id": "id", "type": "id" },
				{ "id": "title", "type": "text", "name": "Title" },
				{ "id": "content", "type": "text", "name": "Content" }
			]
		}
	],
	"kv": [
		{
			"id": "theme",
			"type": "select",
			"options": ["light", "dark"],
			"default": "light"
		}
	]
}
```

## Y.Doc Structure

```typescript
// Y.Doc guid: definition.id
// gc: true (for efficient YKeyValueLww storage)

// Table data (rows as LWW entries)
Y.Array('table:posts');
Y.Array('table:users');

// Workspace-level key-values
Y.Array('kv');
```

## API Usage

### Loading a Workspace

```typescript
import { getWorkspace } from '$lib/workspaces/dynamic/service';
import { createWorkspaceClient } from '$lib/yjs/workspace';

// 1. Load definition from JSON file
const definition = await getWorkspace(workspaceId);
if (!definition) {
	throw new Error('Workspace not found');
}

// 2. Create workspace client with persistence
const client = createWorkspaceClient(definition);
await client.whenSynced;

// 3. Use the client
client.tables.get('posts').upsert({ id: '1', title: 'Hello' });
```

### Creating a Workspace

```typescript
import { createWorkspaceDefinition } from '$lib/workspaces/dynamic/service';

const definition = await createWorkspaceDefinition({
	id: 'my-workspace',
	name: 'My Workspace',
	description: '',
	icon: null,
	tables: [],
	kv: [],
});
```

### Listing Workspaces

```typescript
import { listWorkspaces } from '$lib/workspaces/dynamic/service';

const workspaces = await listWorkspaces();
// Returns all WorkspaceDefinition objects from definition.json files
```

## File Structure

```
$lib/
├── yjs/
│   ├── README.md                    # This file
│   ├── workspace.ts                 # Creates workspace client from definition
│   └── workspace-persistence.ts     # Y.Doc + KV persistence extension
└── workspaces/
    ├── dynamic/
    │   ├── service.ts               # CRUD operations for definition JSON files
    │   └── queries.ts               # TanStack Query wrappers
    └── static/
        ├── service.ts               # Static workspace registry operations
        ├── queries.ts               # TanStack Query wrappers
        └── types.ts                 # Static workspace type definitions
```

## Key Decisions

### GC Setting

Simple mode uses `gc: true` for efficient YKeyValueLww storage:

- Tombstones from updates get merged into tiny metadata
- 200-1000x smaller than Y.Map for update-heavy data
- Trade-off: No snapshot/time-travel capability

See `docs/articles/ykeyvalue-gc-the-hidden-variable.md` for details.

### No Registry

Workspaces are discovered by listing directories in the workspaces folder and reading `definition.json` from each. No separate registry Y.Doc needed.

### No HeadDoc

Definition (schema + metadata) lives in JSON files, not in a Y.Doc. This simplifies the architecture and makes definitions human-editable.

## Future: Versioned Workspaces

When epoch-based versioning is needed (time travel, snapshots, schema migrations), a separate API will be added. The HeadDoc pattern is archived in `docs/articles/archived-head-registry-patterns.md`.
