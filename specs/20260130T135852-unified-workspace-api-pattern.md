# Workspace API Patterns

> **Status: Superseded**: This spec was a design document. The API evolved during implementation. The current API uses `createWorkspace(definition)` instead of `workspace.create()`. See `packages/epicenter/src/static/README.md` for the current API.

**Status**: Implemented
**Created**: 2026-01-30
**Updated**: 2026-01-30

## Design Decision: Intentionally Different APIs

Grid and Static workspaces serve different purposes and have **intentionally different APIs**.

| Aspect              | Static Workspace           | Grid Workspace                            |
| ------------------- | -------------------------- | ----------------------------------------- |
| **Purpose**         | Config-like data, settings | User content, documents, recordings       |
| **ID location**     | In `defineWorkspace()`     | In `createGridWorkspace()` options        |
| **Creation**        | `workspace.create()`       | `createGridWorkspace({ id, definition })` |
| **HeadDoc**         | ❌ Not supported           | ✅ Supported for time-travel              |
| **Extensions**      | Passed to `.create()`      | `.withExtensions()` builder               |
| **Backup strategy** | Binary backups             | Epochs/snapshots                          |

## Why Different APIs?

### Static Workspaces are Simple

Static workspaces store configuration-like data:

- Theme settings
- User preferences
- App configuration

They don't need:

- HeadDoc/epoch support (binary backups are sufficient)
- Complex builder patterns
- Time-travel features

**Simple API for simple data.**

### Grid Workspaces are Complex

Grid workspaces store user content:

- Recordings
- Transcripts
- Documents
- Any data where history matters

They need:

- HeadDoc for loading historical snapshots
- Epoch support for time-travel ("show me 3 minutes ago")
- Builder pattern for flexible extension composition

**Powerful API for powerful features.**

## Final API Design

### Static Workspace

```typescript
import { defineWorkspace, defineTable, defineKv } from '@epicenter/workspace/static';
import { type } from 'arktype';

// ═══════════════════════════════════════════════════════════════
// Step 1: Define workspace schema (ID included in definition)
// ═══════════════════════════════════════════════════════════════

const workspace = defineWorkspace({
	id: 'blog',
	tables: {
		posts: defineTable(type({ id: 'string', title: 'string', published: 'boolean', _v: '1' })),
	},
	kv: {
		theme: defineKv(type({ mode: "'light' | 'dark'", _v: '1' })),
	},
});

// ═══════════════════════════════════════════════════════════════
// Step 2: Create workspace (simple, no HeadDoc)
// ═══════════════════════════════════════════════════════════════

const client = workspace.create({
	persistence, // Optional capabilities
	sqlite,
});

// Result:
// - client.ydoc.guid = "blog"
// - client.ydoc.gc = true (efficient, no history)
// - No time-travel, just current state
```

### Grid Workspace

```typescript
import { createGridWorkspace } from '@epicenter/workspace/grid';

// ═══════════════════════════════════════════════════════════════
// Step 1: Define workspace schema (ID is NOT in definition)
// ═══════════════════════════════════════════════════════════════

const definition = {
	name: 'Whispering',
	description: 'Voice recordings workspace',
	icon: { type: 'emoji', value: '🎙️' },
	tables: [
		{
			id: 'recordings',
			name: 'Recordings',
			fields: [
				{ id: 'title', type: 'text', name: 'Title' },
				{ id: 'duration', type: 'number', name: 'Duration' },
				{ id: 'transcript', type: 'text', name: 'Transcript' },
			],
		},
	],
};

// ═══════════════════════════════════════════════════════════════
// Step 2: Create workspace (ID in options, HeadDoc supported)
// ═══════════════════════════════════════════════════════════════

const client = createGridWorkspace({
	id: 'whispering', // ID is here, NOT in definition
	definition,
	headDoc, // Optional: load from historical snapshot
}).withExtensions({
	persistence: (ctx) => persistence(ctx, { filePath: './whispering.yjs' }),
	sqlite: (ctx) => sqlite(ctx, { dbPath: './whispering.db' }),
});

// Result:
// - client.ydoc.guid = "whispering"
// - client.ydoc.gc = false (preserves history for epochs)
// - Time-travel enabled via HeadDoc
```

## Backup Strategy Per Workspace Type

| Use Case                                  | Static (Binary Backup) | Grid (HeadDoc/Epochs) |
| ----------------------------------------- | ---------------------- | --------------------- |
| "Restore my data from yesterday"          | ✅ Works               | ✅ Works              |
| "Undo my last 5 edits"                    | ❌ Only restore points | ✅ Works              |
| "Show me what this looked like 3 min ago" | ❌ Only save points    | ✅ Works              |
| "Zoom into a snapshot"                    | ❌ Not supported       | ✅ Works              |
| Real-time multi-user collaboration        | ❌ Conflicts           | ✅ Designed for this  |

## Implementation Summary

### What Was Built

**Static Workspace:**

- `defineWorkspace({ id, tables, kv })` - Define schema with ID
- `defineStaticWorkspace()` - Alias for `defineWorkspace()`
- `workspace.create(capabilities)` - Simple creation, no HeadDoc

**Grid Workspace:**

- `createGridWorkspace({ id, definition, headDoc })` - ID in options
- `.withExtensions()` - Builder pattern for extensions
- HeadDoc support for time-travel

### What Was Removed

- ~~`createStaticWorkspace()`~~ - Removed (too complex for simple data)
- ~~`defineGridWorkspace()`~~ - Removed (ID belongs in options, not definition)
- ~~HeadDoc in static workspaces~~ - Removed (binary backups sufficient)

## Files Changed

```
packages/epicenter/src/static/
├── define-workspace.ts     (simplified .create(), no HeadDoc)
├── types.ts                (removed StaticHeadDoc, extension types)
└── index.ts                (cleaned up exports)

packages/epicenter/src/grid/
├── create-grid-workspace.ts (ID required in options)
├── types.ts                 (removed GridWorkspaceDefinitionWithId)
└── index.ts                 (removed defineGridWorkspace export)

Deleted:
- packages/epicenter/src/static/create-static-workspace.ts
- packages/epicenter/src/static/create-static-workspace.test.ts
- packages/epicenter/src/grid/define-grid-workspace.ts
```

## Test Results

All 799 tests pass after these changes.
