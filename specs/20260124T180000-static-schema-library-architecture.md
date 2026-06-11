# Static Schema Library Architecture

> **Status: Superseded**: This spec was a design document. The API evolved during implementation. The current API uses `createWorkspace(definition)` instead of `workspace.create()`. See `packages/epicenter/src/static/README.md` for the current API.

> **📝 NOTE**: This spec should be read alongside [`specs/20260124T162638-stable-id-schema-pattern.md`](./20260124T162638-stable-id-schema-pattern.md) which introduces stable internal IDs for fields. The stable ID pattern simplifies the migration story further: instead of lazy ArkType pipe migrations, fields have permanent internal IDs and invalid data simply returns defaults.

---

**Date**: 2026-01-24
**Status**: Draft
**Author**: Braden + Claude

## Overview

This spec describes the architecture for `@epicenter/static`, a developer-focused library for building local-first apps with statically-defined TypeScript schemas. This is a separate package from the dynamic/user-editable schema system.

## Goals

1. **TypeScript-first DX**: Schemas defined in code, full type inference
2. **Lazy migrations**: Schema changes migrate data transparently on read
3. **Row-level sync**: YJS-backed synchronization at the row level
4. **Simplicity**: No Y.Doc definition storage, no epoch system for most use cases
5. **GC-enabled**: Smaller docs, no revision history requirement

## Non-Goals

- User-editable schemas at runtime (that's the dynamic library)
- Full revision/undo history (requires GC disabled)
- Epoch-based data compaction (may add later as opt-in)

---

## Architecture Comparison

| Aspect               | Current Epicenter             | @epicenter/static          |
| -------------------- | ----------------------------- | -------------------------- |
| Schema storage       | In Y.Doc `definition` map     | TypeScript only (no Y.Doc) |
| Schema introspection | Runtime via Y.Doc             | Compile-time via types     |
| Migration strategy   | Hybrid (lazy + epoch)         | Lazy only (ArkType pipes)  |
| Y.Doc structure      | `definition`, `kv`, `tables`  | `kv`, `tables` only        |
| Garbage collection   | Disabled (revision history)   | Enabled (smaller docs)     |
| Epoch system         | Required for breaking changes | Not needed                 |

---

## Schema Definition API

### Table Definition

```typescript
import {
	defineTable,
	text,
	select,
	integer,
	timestamp,
} from '@epicenter/static';

const recordings = defineTable('recordings', {
	// Required fields (non-nullable by default)
	id: text(),
	title: text(),

	// Optional fields
	subtitle: text({ nullable: true }),

	// Fields with defaults
	status: select(['pending', 'completed'], { default: 'pending' }),
	views: integer({ default: 0 }),

	// Timestamps
	createdAt: timestamp({ default: 'now' }),
	updatedAt: timestamp({ default: 'now' }),
});

// Inferred type:
type Recording = {
	id: string;
	title: string;
	subtitle: string | null;
	status: 'pending' | 'completed';
	views: number;
	createdAt: string;
	updatedAt: string;
};
```

### Workspace Definition

```typescript
import { defineWorkspace } from '@epicenter/static';
import { recordings, transformations } from './tables';

const workspace = defineWorkspace({
	id: 'epicenter.whispering',
	tables: { recordings, transformations },
	kv: {
		theme: { type: 'select', options: ['light', 'dark'], default: 'dark' },
		autoSave: { type: 'boolean', default: true },
	},
});

export type Workspace = typeof workspace;
```

---

## Migration Strategy: Lazy On-Read

### Core Principle

Schema changes are **code changes**. When you add a field with a default, old rows automatically get that default when read. No migration scripts, no epoch bumps, no coordination.

### How It Works

```typescript
// Version 1: Initial schema
const recordings = defineTable('recordings', {
	id: text(),
	title: text(),
});

// Version 2: Add field with default
const recordings = defineTable('recordings', {
	id: text(),
	title: text(),
	status: select(['pending', 'completed'], { default: 'pending' }), // NEW
});

// Old row in Y.Doc: { id: '123', title: 'Hello' }
// When read: { id: '123', title: 'Hello', status: 'pending' }  ← default applied
```

### Migration With Computed Defaults

For migrations that need to compute values from existing data:

```typescript
const recordings = defineTable('recordings', {
	id: text(),
	title: text(),
	transcript: text({ nullable: true }),

	// NEW: Computed from existing data
	hasTranscript: boolean({
		default: false,
		migrateFrom: (row) => row.transcript !== null,
	}),
});
```

**Behavior:**

1. Read row from Y.Doc
2. If `hasTranscript` missing, run `migrateFrom(row)`
3. Return row with computed value
4. Optionally persist on next write

### What's Supported (Lazy)

| Change                     | Supported | Notes                        |
| -------------------------- | --------- | ---------------------------- |
| Add nullable field         | ✅        | Returns `null` for old rows  |
| Add field with default     | ✅        | Returns default for old rows |
| Add field with migrateFrom | ✅        | Computes from row data       |
| Change default value       | ✅        | Only affects new rows        |
| Add select option          | ✅        | Non-breaking                 |

### What Requires Manual Migration

| Change               | Reason            | Solution                  |
| -------------------- | ----------------- | ------------------------- |
| Rename field         | Can't auto-detect | Migration script          |
| Change field type    | Type mismatch     | Migration script          |
| Remove field         | Data loss         | Migration script (opt-in) |
| Remove select option | Invalid values    | Requires validation       |

---

## Y.Doc Structure

### Current Epicenter

```
Y.Doc
├── Y.Map('definition')  ← Schema storage
├── Y.Map('kv')          ← Settings
└── Y.Map('tables')      ← Data
    └── {tableName}: Y.Map
        └── {rowId}: Y.Map
            └── {column}: value
```

### @epicenter/static

```
Y.Doc
├── Y.Map('kv')          ← Settings
└── Y.Map('tables')      ← Data
    └── {tableName}: Y.Map
        └── {rowId}: Y.Map
            └── {column}: value
```

**Key difference**: No `definition` map. Schema lives in TypeScript code.

---

## Read/Write Patterns

### Reading Data

```typescript
const client = await workspace.create();

// Get all recordings (lazy migration applied)
const recordings = client.tables.recordings.getAll();

// Get by ID
const recording = client.tables.recordings.get('123');

// Query (if supported)
const pending = client.tables.recordings.where({ status: 'pending' });
```

### Writing Data

```typescript
// Insert
client.tables.recordings.insert({
	id: '123',
	title: 'New Recording',
	// status defaults to 'pending'
});

// Update (patch-based, safe for concurrent edits)
client.tables.recordings.update('123', {
	title: 'Updated Title',
	// Only touches 'title' cell, not entire row
});

// Upsert
client.tables.recordings.upsert({
	id: '123',
	title: 'Upserted',
});

// Delete
client.tables.recordings.delete('123');
```

### Observing Changes

```typescript
// Subscribe to table changes
client.tables.recordings.observe((event) => {
	console.log('Changed rows:', event.changes);
});

// Subscribe to specific row
client.tables.recordings.observeRow('123', (row) => {
	console.log('Row updated:', row);
});
```

---

## Synchronization

### Provider-Agnostic

The library works with any YJS sync provider:

```typescript
import { WebsocketProvider } from 'y-websocket';
import { IndexeddbPersistence } from 'y-indexeddb';

const client = await workspace.create({
	extensions: {
		websocket: (ctx) => new WebsocketProvider(url, ctx.ydoc.guid, ctx.ydoc),
		persistence: (ctx) => new IndexeddbPersistence(ctx.ydoc.guid, ctx.ydoc),
	},
});
```

### Doc ID Format

Simple workspace-based IDs (no epoch):

```
Local: {workspaceId}
Cloud: {orgId}:{workspaceId}
```

Examples:

- `epicenter.whispering` (local)
- `org_abc123:epicenter.whispering` (cloud)

### Garbage Collection

**GC Enabled by Default**

```typescript
const ydoc = new Y.Doc({ guid: docId, gc: true });
```

This means:

- Smaller doc sizes (tombstones cleaned up)
- No revision history (can't snapshot past states)
- Simpler mental model

---

## KV Store

For app-level settings that aren't row-based:

```typescript
// Read
const theme = client.kv.theme.get(); // 'light' | 'dark'

// Write
client.kv.theme.set('dark');

// Observe
client.kv.theme.observe((value) => {
	console.log('Theme changed:', value);
});
```

### KV Migrations

```typescript
const workspace = defineWorkspace({
	kv: {
		// V1: Simple theme
		theme: { type: 'select', options: ['light', 'dark'], default: 'dark' },

		// V2: Add new setting with since version
		fontSize: {
			type: 'integer',
			default: 14,
			since: 2, // Only read from version 2+
		},
	},
});
```

---

## Validation

### Read-Time Validation

Validation happens when reading from Y.Doc:

```typescript
const recordings = client.tables.recordings.getAll();
// Returns Recording[] (validated)

const recording = client.tables.recordings.get('123');
// Returns Recording | null (validated or null if invalid)

// Access raw (unvalidated) data
const raw = client.tables.recordings.getRaw('123');
// Returns unknown (no validation)
```

### Write-Time Validation

Validation happens before writing:

```typescript
client.tables.recordings.insert({
	id: '123',
	title: 'Hello',
	status: 'invalid', // TypeScript error + runtime validation error
});
```

### Handling Invalid Data

```typescript
// Skip invalid rows (default)
const valid = client.tables.recordings.getAllValid();

// Get all with validation results
const results = client.tables.recordings.getAllWithErrors();
// [{ data: Recording, error: null }, { data: null, error: ValidationError }]
```

---

## TODO: Open Questions

### 1. Version Tracking

Do we need to track schema version anywhere?

**Option A**: No version tracking

- Schema is always "latest" (code is source of truth)
- Old data just gets defaults applied
- Simplest approach

**Option B**: Version in Y.Doc metadata

- Store `{ schemaVersion: 2 }` in a metadata map
- Enables detecting "this data is from a future version"
- Useful for forward compatibility warnings

**Recommendation**: Start with Option A, add version tracking if needed.

### 2. Breaking Changes

How do we handle truly breaking changes (field rename, type change)?

**Option A**: Manual migration scripts

- Developer writes a one-time script
- Reads old data, writes new data
- Simple but requires coordination

**Option B**: Declarative migrations

- Define renames in schema: `title: text({ renamedFrom: 'name' })`
- Library handles the migration
- More magic but less boilerplate

**Recommendation**: Start with Option A (manual scripts), consider Option B later.

### 3. Schema Diffing

Should the library detect schema changes?

**Option A**: No detection

- Developer knows what changed
- No runtime overhead

**Option B**: Runtime diffing

- Compare schema to last-known schema
- Warn on breaking changes
- Store schema hash in localStorage

**Recommendation**: Start with Option A, add diffing as debug tool.

### 4. Multi-Device Schema Mismatch

What happens when Device A has schema v2 and Device B has schema v1?

**Scenario**:

1. Device A adds field `priority: integer({ default: 0 })`
2. Device A creates row with `priority: 5`
3. Device B (still v1) syncs the row
4. Device B doesn't know about `priority` field

**Option A**: Forward-compatible by default

- Device B preserves unknown fields in Y.Doc
- Device B's reads just don't see `priority`
- When Device B updates, only touch known fields (patch-based)
- `priority: 5` survives the round-trip

**Option B**: Strict mode

- Device B rejects unknown fields
- Forces all devices to upgrade together
- Safer but less flexible

**Recommendation**: Option A (forward-compatible) with opt-in strict mode.

---

## Implementation Plan

### Phase 1: Core Schema System

- [ ] Field factory functions (`text()`, `select()`, `integer()`, etc.)
- [ ] `defineTable()` with type inference
- [ ] `defineWorkspace()` with tables and KV
- [ ] ArkType integration for validation

### Phase 2: Y.Doc Integration

- [ ] `workspace.create()` factory
- [ ] Table CRUD operations (insert, update, delete, get, getAll)
- [ ] KV operations (get, set)
- [ ] Observation (observe table, observe row, observe KV)

### Phase 3: Migration System

- [ ] Lazy defaults (apply on read)
- [ ] `migrateFrom` computed defaults
- [ ] Patch-based writes (forward-compatible)
- [ ] Unknown field preservation

### Phase 4: Sync Integration

- [ ] Extension system for providers
- [ ] GC-enabled docs
- [ ] Doc ID format (local vs cloud)
- [ ] Multi-device testing

### Phase 5: Developer Experience

- [ ] Error messages for schema mismatches
- [ ] Debug mode for migration tracking
- [ ] Typed client generation (if needed)

---

## Relationship to Existing Code

### What to Keep

- Field type definitions (`/packages/epicenter/src/core/schema/fields/types.ts`)
- ArkType converters (`/packages/epicenter/src/core/schema/converters/`)
- Table helper patterns (`/packages/epicenter/src/core/tables/`)
- Extension system concept

### What to Change

- Remove `definition` Y.Map storage
- Remove epoch system (for this library)
- Enable GC by default
- Simplify doc ID format

### What to Add

- `migrateFrom` computed defaults
- Forward-compatible unknown field handling
- Simpler `workspace.create()` API

---

## References

- `/specs/20260124T125300-workspace-schema-versioning.md` - Previous versioning proposal
- `/specs/20260116T082500-schema-migration-patterns.md` - Migration strategy research
- `/docs/articles/yjs-ymap-is-not-a-hashmap.md` - YJS internals
- `/packages/epicenter/src/core/schema/README.md` - Current schema docs
