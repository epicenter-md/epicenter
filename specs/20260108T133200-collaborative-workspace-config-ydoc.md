# Collaborative Workspace Configuration via YJS

**Date**: 2026-01-08
**Status**: DRAFT
**Depends on**: `20260108T062000-local-first-workspace-discovery.md`

## Overview

This specification describes how to store workspace configurations (schema, metadata) in YJS documents instead of local JSON files, enabling real-time collaborative schema editing across users and devices.

## Problem Statement

The current architecture stores workspace configs as JSON files:

- `workspaces/blog/definition.json` → `{ id, name, tables, kv, ... }`

This creates issues:

1. **Multi-device drift**: Edit schema on Device A, Device B doesn't see it
2. **No collaboration**: Can't share schema editing with other users
3. **Manual sync**: Must export/import JSON to share configs

## Solution: 3-Document Architecture

Store workspace configuration in YJS documents that sync via CRDT.

```
╔═══════════════════════════════════════════════════════════════════════════════╗
║  DOC TYPE 1: Registry Y.Doc (per user)                                        ║
║  ID: {registryId} (from auth server)                                          ║
╠═══════════════════════════════════════════════════════════════════════════════╣
║                                                                               ║
║  Y.Map('workspaces')                                                          ║
║      └── {workspaceId} → true      ◄── Just a SET of workspace IDs            ║
║                                                                               ║
║  Purpose: Personal index of "which workspaces do I have access to?"           ║
║  Syncs: Only across user's own devices (not with other users)                 ║
║                                                                               ║
╚═══════════════════════════════════════════════════════════════════════════════╝

╔═══════════════════════════════════════════════════════════════════════════════╗
║  DOC TYPE 2: Head Y.Doc (per workspace, shared)                               ║
║  ID: {workspaceId}                                                            ║
╠═══════════════════════════════════════════════════════════════════════════════╣
║                                                                               ║
║  Y.Map('head')                                                                ║
║      └── epoch: 0                  ◄── Current data doc epoch                 ║
║                                                                               ║
║  Purpose: Pointer to current data epoch (enables atomic epoch switching)      ║
║  Syncs: With all collaborators on this workspace                              ║
║                                                                               ║
╚═══════════════════════════════════════════════════════════════════════════════╝

╔═══════════════════════════════════════════════════════════════════════════════╗
║  DOC TYPE 3: Data Y.Doc (per workspace per epoch, shared)                     ║
║  ID: {workspaceId}-{epoch}                                                    ║
╠═══════════════════════════════════════════════════════════════════════════════╣
║                                                                               ║
║  Y.Map('meta')                                                                ║
║      └── name: "My Blog"                                                      ║
║                                                                               ║
║  Y.Map('schema')                                                              ║
║      ├── tables: Y.Map<tableName, Y.Map<fieldName, FieldSchema>>              ║
║      └── kv: Y.Map<keyName, KvSchema>                                         ║
║                                                                               ║
║  Y.Map('tables')                                                              ║
║      └── {tableName}: Y.Map<rowId, Y.Map<fieldName, value>>                   ║
║                                                                               ║
║  Y.Map('kv')                                                                  ║
║      └── {keyName}: value                                                     ║
║                                                                               ║
║  Purpose: All shared workspace state (schema + data)                          ║
║  Syncs: With all collaborators on this workspace                              ║
║                                                                               ║
╚═══════════════════════════════════════════════════════════════════════════════╝
```

## Schema Storage Granularity

### Decision: Nested Y.Maps for Schema

Store schema as nested Y.Maps down to the **field level**, but field definitions themselves are plain JSON objects (not Y.Maps).

```typescript
// Structure
schema/tables/{tableName}/{fieldName} → { type: 'text', nullable: false, ... }

// Example
schema.tables.get('posts')  // → Y.Map
  .get('title')             // → { type: 'text', nullable: false }
  .get('category')          // → { type: 'select', options: ['tech', 'personal'] }
```

### Why This Granularity?

**Scenario: Alice and Bob both add columns**

```
Alice: schema.tables.posts.set('category', { type: 'select', options: [...] })
Bob:   schema.tables.posts.set('author', { type: 'text' })

CRDT merge: Both columns exist! ✅
```

**If we used JSON blob for entire table schema:**

```
Alice: schema.tables.set('posts', { id: {...}, title: {...}, category: {...} })
Bob:   schema.tables.set('posts', { id: {...}, title: {...}, author: {...} })

CRDT merge: Last-writer-wins at table level. One column lost! ❌
```

### Granularity Levels

| Level           | Structure                                        | When to Use              |
| --------------- | ------------------------------------------------ | ------------------------ |
| **Table level** | `schema.tables.{tableName}` → Y.Map              | Add/remove tables        |
| **Field level** | `schema.tables.{tableName}.{fieldName}` → JSON   | Add/remove/update fields |
| **Row level**   | `tables.{tableName}.{rowId}` → Y.Map             | Add/remove/update rows   |
| **Cell level**  | `tables.{tableName}.{rowId}.{fieldName}` → value | Update cell values       |

## Schema Merging Strategy

### Default Behavior: Merge at Field Level

When multiple collaborators edit schema:

- **Adding fields**: Merges automatically (different keys)
- **Same field edited**: Last-writer-wins on that field's definition
- **Removing fields**: Removes (but consider tombstones for undo)

### No Schema Compatibility Checking (MVP)

For MVP, do NOT check if schema changes are "compatible". Just merge/overwrite.

Rationale:

- Schema validation happens at data write time (existing behavior)
- Incompatible schema changes are rare
- Checking compatibility adds complexity
- Users can see schema in UI and coordinate

### Future: Schema Validation Mode

Could add optional validation:

```typescript
const client = await workspace.create({
	schemaValidation: 'none' | 'warn' | 'error',
});
```

## Auth Server Integration

The auth server stores minimal metadata (not user data):

```
╔═══════════════════════════════════════════════════════════════════════════════╗
║  AUTH SERVER (Postgres/SQLite)                                                ║
╠═══════════════════════════════════════════════════════════════════════════════╣
║                                                                               ║
║  users:                                                                       ║
║      userId → {                                                               ║
║          registryId: "xyz789012345abc",                                       ║
║          bootstrapSyncNodes: ["wss://cloud.epicenter.so"],                    ║
║      }                                                                        ║
║                                                                               ║
║  permissions:                                                                 ║
║      workspaceId → [{ userId, role: 'owner' | 'editor' | 'viewer' }]          ║
║                                                                               ║
║  shareLinks:                                                                  ║
║      token → { workspaceId, role, expiresAt, maxUses }                        ║
║                                                                               ║
╚═══════════════════════════════════════════════════════════════════════════════╝
```

### Sync Server Permission Check

When connecting to a Y.Doc room:

1. Validate JWT → get userId
2. Query auth server for permissions
3. Allow/deny connection based on role

## Client Boot Flow

```
1. Authenticate → get registryId + bootstrapSyncNodes from auth server

2. Connect to Registry Y.Doc ({registryId})
   → Get set of workspaceIds

3. To open a workspace:
   a. Connect to Head Y.Doc ({workspaceId})
   b. Read epoch from head.epoch
   c. Connect to Data Y.Doc ({workspaceId}-{epoch})
   d. Subscribe to head changes (for epoch bumps)

4. Use typed client for tables/kv operations
```

## Epoch System

### Purpose

Epochs enable atomic schema migrations and compaction.

### When to Bump Epoch

- Breaking schema changes (type changes, removed fields)
- Compaction (resetting Y.Doc to current state)
- Recovery from corruption

### Epoch Bump Flow

Epoch bump is an **atomic pointer flip**. No coordination flags needed.

```
1. Create new Data Y.Doc: {workspaceId}-{epoch+1}
2. Seed schema into new Data Doc (idempotent)
3. (Optional) Migrate/copy data from old → new epoch
4. Update head.epoch = max(head.epoch, epoch + 1)  ← monotonic-max!
5. All clients see epoch change → reconnect to new data doc
6. Old epochs remain accessible for historical viewing (read-only in UI)
```

**Why no `isMigrating` flag?**

- Yjs CRDTs can't enforce a write lock; any client can write anytime
- A boolean flag only _requests_ cooperation, doesn't enforce it
- If the initiator crashes, a flag stays stuck forever
- Simpler model: old epoch becomes "historical" after bump; orphaned writes are acceptable

## Code-Defined Schema Integration

### How It Works

1. User defines schema in code (TypeScript types)
2. On `workspace.create()`:
   - If Y.Doc schema is empty: serialize code schema → write to Y.Doc
   - If Y.Doc schema exists: use it (schema in Y.Doc is authoritative)
3. TypeScript types come from code schema (compile-time)
4. Runtime data uses Y.Doc schema (runtime)

### Seed vs Sync

```typescript
const workspace = defineWorkspace({
	id: 'abc123xyz789012',
	slug: 'blog',
	name: 'My Blog',
	tables: {
		posts: {
			id: id(),
			title: text(),
			published: boolean({ default: false }),
		},
	},
	kv: {},
});

const client = await workspace.create();
// If Y.Doc empty: writes code schema to Y.Doc
// If Y.Doc has schema: uses Y.Doc schema for runtime
// TypeScript types always from code schema
```

### Handling Extra Fields

If Y.Doc has fields not in code schema:

- They exist at runtime
- Not accessible via typed `client.tables.posts.extraField`
- Accessible via dynamic API: `client.runtime.getField('posts', 'extraField')`

## Implementation Notes

### Terminology

| Old Term | New Term | Description                  |
| -------- | -------- | ---------------------------- |
| `guid`   | `id`     | 15-char nanoid, used as keys |
| `id`     | `slug`   | Human-readable name          |

### Y.Doc GUID Patterns

| Doc Type | GUID Pattern            | Example             |
| -------- | ----------------------- | ------------------- |
| Registry | `{registryId}`          | `xyz789012345abc`   |
| Head     | `{workspaceId}`         | `abc123xyz789012`   |
| Data     | `{workspaceId}-{epoch}` | `abc123xyz789012-0` |

**Note**: Hyphen (`-`) is used as the epoch delimiter because y-sweet only allows alphanumeric characters, hyphens, and underscores in document IDs. Colons are NOT allowed.

### What We Removed

| Field                    | Why Removed                                                |
| ------------------------ | ---------------------------------------------------------- |
| `schemaVersion`          | Epoch handles migrations; CRDT handles incremental changes |
| `slug` in registry       | Use workspace's `meta.name`                                |
| `syncNodes` in registry  | Get from auth server                                       |
| `lastOpenedAt`, `pinned` | Add later as needed                                        |
| `deletedAt` tombstone    | Just delete + revoke access on auth server                 |
| `createdAt`              | Add later as needed                                        |

## Migration from File-Based System

### One-Time Migration

1. Scan existing workspace directories in `workspaces/`
2. For each workspace with `definition.json`:
   - Create Head Y.Doc with epoch: 0
   - Create Data Y.Doc with schema + empty tables
   - Add to user's Registry Y.Doc
3. Import existing Y.Doc data files (if any)

## Critical YJS Semantics (Must Understand)

### Y.Map Same-Key Conflict Resolution

When two peers concurrently `set()` the same key, Yjs picks the winner by **operation ID ordering** (`{clientID, clock}`), NOT by timestamp or "who saved last".

```
Alice: postsMap.set('title', { type: 'text', nullable: true })
Bob:   postsMap.set('title', { type: 'text', nullable: false })

Result: ONE wins deterministically (by clientID/clock), other is lost entirely
```

**Implication**: Field-level schema conflicts are all-or-nothing for that field's JSON definition.

### Delete Parent vs Update Child

If Alice deletes `schema.tables.posts` while Bob adds `schema.tables.posts.newColumn`:

- Delete parent removes entire nested Y.Map
- Child updates can become orphaned
- **Solution**: Use tombstones instead of hard deletes

### Epoch Monotonicity Warning

⚠️ **Y.Map `set()` for epoch can go backwards!**

If two clients race:

- Client A writes `epoch = 3`
- Client B writes `epoch = 2`
- Winner is determined by `{clientID, clock}`, NOT by numeric value
- Final epoch could be `2` even though `3` was written later

**Solution**: Store epoch as monotonic-max register:

```typescript
// Option A: Track per-client epochs, compute max
head.epochs: Y.Map<clientId, number>
currentEpoch = Math.max(...head.epochs.values())

// Option B: Epoch bump requires coordination (single writer)
```

## Edge Cases and Failure Modes

### 1. Concurrent Same-Field Edits

- **Scenario**: Alice and Bob both edit `posts.title` field definition
- **Result**: One JSON definition wins entirely (LWW by clientID/clock)
- **Handling**: Acceptable for MVP; document behavior

### 2. Delete Table vs Add Column Race

- **Scenario**: Alice deletes `posts` table, Bob adds column to `posts`
- **Result**: With hard delete, Bob's column is orphaned/lost
- **Handling**: Use tombstones for table/field deletion

```typescript
// Instead of: schema.tables.delete('posts')
// Use: schema.deletedTables.set('posts', { deletedAt, deletedBy })
```

### 3. Schema Edit During Epoch Bump

- **Scenario**: User editing schema when epoch changes
- **Result**: Edits go to old epoch doc, not migrated
- **Handling**: Acceptable for MVP; edits to old epoch are orphaned but old epoch remains viewable as history

### 4. Race Condition on Schema Seeding

- **Scenario**: Two clients both see empty schema, both seed
- **Result**: If seeding includes non-deterministic data, conflicts occur
- **Handling**: Make seeding deterministic and idempotent; detect "seeded" via `hasSchema()` (structural check) instead of a boolean flag

### 5. Corrupted Schema Recovery

- **Scenario**: Schema values are malformed JSON
- **Handling**:
  - Validate schema on load
  - Quarantine invalid entries
  - Option to reset from code schema via epoch bump

## Multi-Document Architecture Patterns

### Provider Management

**Critical: One provider per Y.Doc. Never share providers.**

```typescript
// CORRECT: Separate providers
const registryProvider = new WebsocketProvider(
	url,
	`${registryId}`,
	registryDoc,
);
const headProvider = new WebsocketProvider(url, `${workspaceId}`, headDoc);
const dataProvider = new WebsocketProvider(
	url,
	`${workspaceId}-${epoch}`,
	dataDoc,
);

// WRONG: Reusing providers across docs
```

### Connection Lifecycle

**Always disconnect before destroy. Order matters.**

```typescript
async function cleanup() {
	// 1. Disconnect providers FIRST
	for (const provider of providers) {
		provider.shouldConnect = false;
		provider.disconnect();
		provider.destroy();
	}

	// 2. THEN destroy Y.Docs
	for (const doc of docs) {
		doc.destroy();
	}
}
```

### Awareness Scope

**Awareness is per-document, NOT cross-document.**

Each Y.Doc has its own awareness instance. If you need presence across multiple docs, implement manually.

### Transactions Don't Span Docs

```typescript
// WRONG: Can't do cross-doc transactions
doc1.transact(() => {
	doc2.getMap().set('key', 'value'); // ERROR: different doc
});

// CORRECT: Separate transactions
doc1.transact(() => doc1.getMap().set('key1', 'value1'));
doc2.transact(() => doc2.getMap().set('key2', 'value2'));
```

### Persistence Per Doc

```typescript
// CORRECT: Separate persistence per doc
new IndexeddbPersistence(`${workspaceId}-registry`, registryDoc);
new IndexeddbPersistence(`${workspaceId}-head`, headDoc);
new IndexeddbPersistence(`${workspaceId}-data-${epoch}`, dataDoc);
```

## Existing Codebase Patterns to Follow

### Current Y.Doc Structure

The codebase currently uses two root Y.Maps:

- `ydoc.getMap('tables')` → `Y.Map<tableName, Y.Map<rowId, Y.Map<fieldName, value>>>`
- `ydoc.getMap('kv')` → `Y.Map<keyName, value>`

Schema is NOT currently stored in Y.Doc; it's passed as config. This spec changes that.

### Capability Context Pattern

Capabilities receive `{ id, capabilityId, ydoc, tables, kv }`. The new architecture will need to update this to handle multiple docs.

### Error Handling Pattern

Use `wellcrafted/result` with tagged errors:

```typescript
import { Ok, Err, tryAsync } from 'wellcrafted/result';

const result = await tryAsync({
	try: () => loadSchema(),
	catch: (e) => SchemaLoadErr({ message: 'Failed to load schema', cause: e }),
});
```

### Sync Coordination Pattern

Prevent infinite loops with coordination counters:

```typescript
const syncCoordination = {
	yDocChangeCount: 0, // Use counters, not booleans (for async)
	refetchCount: 0,
};

// Skip if other direction is updating
if (syncCoordination.yDocChangeCount > 0) return;
```

## Open Questions for Implementation

1. **Schema sync on startup**: Should we always sync Y.Doc schema with code schema, or only on first run?

2. **Schema conflict UI**: How should the app surface schema conflicts to users?

3. **Offline schema changes**: If offline edits to schema conflict with online changes, how to resolve?

4. **Schema rollback**: If a schema change breaks things, how to roll back?

5. **Epoch coordination**: Who can bump epochs? Single leader? Any client?

## Todo

- [ ] Implement Registry Y.Doc persistence
- [ ] Implement Head Y.Doc with epoch pointer
- [ ] Move schema storage to Data Y.Doc
- [ ] Update `defineWorkspace()` to seed schema on first run
- [ ] Add auth server permission tables
- [ ] Add sync server permission checking
- [ ] Test multi-user schema editing
- [ ] Test epoch bump flow
- [ ] Document migration path for existing users

## Implementation Review (2026-01-08)

### Completed: Terminology Refactor

The terminology changes from this spec have been implemented:

| Old Term | New Term | Notes                                                |
| -------- | -------- | ---------------------------------------------------- |
| `guid`   | `id`     | 15-char nanoid, globally unique workspace identifier |
| `id`     | `slug`   | Human-readable name for URLs, paths, CLI             |

**Changes made:**

1. **Type definitions** (`packages/epicenter/src/core/schema/fields/id.ts`):
   - Added `WorkspaceId` type (branded string)
   - Added `generateWorkspaceId()` function
   - Kept `Guid` and `generateGuid()` as deprecated aliases for backward compatibility

2. **Workspace types** (`packages/epicenter/src/core/workspace/contract.ts`):
   - `WorkspaceSchema.guid` → `WorkspaceSchema.id`
   - `WorkspaceSchema.id` → `WorkspaceSchema.slug`
   - `WorkspaceClient.guid` → `WorkspaceClient.id`
   - `WorkspaceClient.id` → `WorkspaceClient.slug`
   - Removed `TId` generic parameter (analysis showed no consumers used literal type inference)

3. **Y.Doc GUID construction** (already correct):
   - Uses `{id}-0` format where `-0` is epoch 0
   - Hyphen delimiter compatible with y-sweet

4. **Capability context**:
   - `CapabilityContext.id` remains as `slug` (for storage path namespacing)
   - Updated JSDoc to clarify this is the slug

5. **Consumer updates**:
   - `apps/epicenter` - Updated to use new terminology
   - `apps/tab-manager` - Updated (has pre-existing API issues unrelated)
   - `examples/basic-workspace` - Updated
   - `packages/epicenter/scripts/*` - Updated

### Not Yet Implemented

The following spec components are deferred to follow-up work:

- **Registry Y.Doc**: Personal workspace index per user
- **Head Y.Doc**: Epoch pointer separation from data doc
- **Schema storage in Y.Doc**: Currently schema is code-defined only
- **Schema seeding**: Auto-populate Y.Doc schema from code on first run
- **Auth server integration**: Permission tables and checks

See `specs/20260108T133200-collaborative-workspace-config-ydoc-handoff.md` for detailed handoff.

## References

- `20260108T062000-local-first-workspace-discovery.md` - Original file-based discovery spec
- `/packages/epicenter/src/core/workspace/contract.ts` - Current implementation
- `/packages/epicenter/src/core/schema/fields/factories.ts` - Schema factory functions
