# Schema Migration Patterns for Epicenter

**Status**: Research & Planning  
**Date**: 2026-01-16  
**Author**: Braden + Claude

---

## Executive Summary

This specification explores schema migration strategies for Epicenter, a local-first collaborative workspace system built on YJS CRDTs. The challenge is unique: unlike traditional databases, Epicenter's schemas live in YJS documents that sync across devices, the data persists even when schemas change, and validation is opt-in at read time.

The core insight: **Epicenter already has most of the building blocks for schema migrations**. The question is how to orchestrate them elegantly.

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                    SCHEMA MIGRATION LANDSCAPE                                │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│   Traditional DB          Local-First (Epicenter)                           │
│   ──────────────          ─────────────────────────                         │
│                                                                             │
│   Schema = Structure      Schema = Validation                               │
│   ↓                       ↓                                                 │
│   Data MUST conform       Data PERSISTS regardless                          │
│   ↓                       ↓                                                 │
│   Migration = Required    Migration = Optional (validate-on-read)           │
│   ↓                       ↓                                                 │
│   Centralized             Distributed (every peer has data)                 │
│   ↓                       ↓                                                 │
│   Downtime OK             Zero downtime (offline-first)                     │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

## Table of Contents

1. [Problem Statement](#problem-statement)
2. [Current Architecture Analysis](#current-architecture-analysis)
3. [Migration Strategy Options](#migration-strategy-options)
4. [Version Notification Mechanisms](#version-notification-mechanisms)
5. [Schema Registry & Distribution](#schema-registry--distribution)
6. [Implementation Recommendations](#implementation-recommendations)
7. [Migration Patterns Deep Dive](#migration-patterns-deep-dive)
8. [Open Questions](#open-questions)

---

## Problem Statement

### The Core Challenge

Epicenter uses a **contract-based architecture** where:

1. **Schemas are JSON-serializable** — defined in code, stored in Y.Doc
2. **Data persists in Y.Doc** — survives schema changes automatically
3. **Validation is opt-in** — rows can exist without matching the schema
4. **Multiple peers** — devices may run different schema versions concurrently

This creates unique challenges not present in traditional databases:

| Challenge         | Traditional DB | Epicenter         |
| ----------------- | -------------- | ----------------- |
| **Schema change** | ALTER TABLE    | Merge into Y.Doc  |
| **Data format**   | Must conform   | Persists as-is    |
| **Rollback**      | Restore backup | Read old epoch    |
| **Coordination**  | Single server  | Distributed peers |
| **Downtime**      | Often required | Never acceptable  |

### Specific Questions to Answer

1. **How do peers know a schema has changed?**
   - Push notification? Pull on connect? Version field?

2. **When should data be migrated?**
   - On write (eager)? On read (lazy)? Never (just validate)?

3. **How do we handle version conflicts?**
   - Client A has schema v2, Client B has schema v3. Who wins?

4. **Where does the "canonical" schema live?**
   - Code? Y.Doc? Central registry? GitHub?

5. **How do downstream consumers update?**
   - Auto-update? Manual migration? Breaking change notice?

---

## Current Architecture Analysis

### What Epicenter Already Has

#### 1. Epoch System (Version Isolation)

The **epoch** system provides complete version isolation at the Y.Doc level:

```
┌─────────────────────────────────────────────────────────────────────────────┐
│  HEAD Y.Doc (stable pointer)          WORKSPACE Y.Docs (immutable by ID)    │
│  ─────────────────────────            ──────────────────────────────────    │
│                                                                             │
│  Y.Map('epochs')                      {workspaceId}-0   (epoch 0 data)      │
│    └── {clientId}: number             {workspaceId}-1   (epoch 1 data)      │
│                                       {workspaceId}-2   (epoch 2 data)      │
│  getEpoch() → max(all values)                                               │
│                                                                             │
│  Purpose: "What version are we on?"   Purpose: "Data for that version"      │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

**Key insight**: Epoch bumps create NEW Y.Docs. Old data remains accessible. This is perfect for schema migrations—migrate data from epoch N to epoch N+1.

#### 2. Definition Merge System

The `definition.merge()` function in `workspace.create()` already handles schema evolution:

```typescript
// In workspace.ts
definition.merge(config);

// Merge rules:
// - Table doesn't exist → add it
// - Table exists → merge metadata (name, icon, cover, description)
// - Field doesn't exist → add it
// - Field exists with different value → update it
// - Field exists with same value → no-op (CRDT handles)
```

**Key insight**: Schema updates are already idempotent and CRDT-safe. The infrastructure exists.

#### 3. Live Definition Access

Tables have `.definition` getters that read from Y.Doc:

```typescript
client.tables.posts.definition; // Y.Map (live) | null
client.tables.posts.schema; // FieldSchemaMap (static from code)
```

**Key insight**: Both "what code expects" and "what Y.Doc has" are accessible at runtime.

#### 4. Validation at Read Time

Epicenter already separates "storage" from "validation":

```typescript
// Data exists regardless of schema
const result = table.get({ id: '1' });

switch (result.status) {
	case 'valid': // Row passes schema validation
	case 'invalid': // Row exists but fails validation
	case 'not_found': // Row doesn't exist
}
```

**Key insight**: Invalid rows aren't deleted—they're just marked invalid. Perfect for lazy migrations.

### What's Missing

| Gap                     | Description                          | Impact                          |
| ----------------------- | ------------------------------------ | ------------------------------- |
| **Version field**       | No explicit schema version stored    | Can't tell if migration needed  |
| **Migration functions** | No standard way to define transforms | Each migration is ad-hoc        |
| **Notification system** | No pub/sub for schema changes        | Clients don't know to update    |
| **Registry pattern**    | No central "source of truth"         | Schemas scattered in codebases  |
| **Backward compat**     | No formal compatibility rules        | Breaking changes surprise users |

---

## Migration Strategy Options

### Option A: Epoch-Based Migration (Current Model, Enhanced)

**Philosophy**: Every schema change bumps the epoch. Old data lives in old epoch, new data in new epoch.

```
┌─────────────────────────────────────────────────────────────────────────────┐
│  EPOCH-BASED MIGRATION                                                       │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│  SCHEMA v1                 MIGRATION                 SCHEMA v2              │
│  ─────────                 ─────────                 ─────────              │
│                                                                             │
│  posts: {                  Transform:                posts: {               │
│    id, title               - Add status column         id, title,           │
│  }                         - Default 'draft'           status               │
│                                                      }                      │
│       │                         │                          │                │
│       ▼                         ▼                          ▼                │
│  ┌─────────┐              ┌─────────┐              ┌─────────┐             │
│  │ Epoch 0 │  ─────────▶  │ Migrate │  ─────────▶  │ Epoch 1 │             │
│  │ v1 data │              │ Script  │              │ v2 data │             │
│  └─────────┘              └─────────┘              └─────────┘             │
│                                                                             │
│  Pros:                                                                      │
│  + Clean isolation (old data preserved)                                     │
│  + Rollback = use old epoch                                                 │
│  + Already implemented                                                      │
│                                                                             │
│  Cons:                                                                      │
│  - Requires explicit migration step                                         │
│  - Storage doubles during migration                                         │
│  - All peers must run migration                                             │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

**Implementation**:

```typescript
// Migration script
async function migrateToV2() {
	const head = createHeadDoc({ workspaceId });
	const oldEpoch = head.getEpoch();
	const newEpoch = oldEpoch + 1;

	// Create clients at both epochs
	const oldClient = await workspace.create({ epoch: oldEpoch });
	const newClient = await workspaceV2.create({ epoch: newEpoch });

	// Transform data
	for (const post of oldClient.tables.posts.getAllValid()) {
		newClient.tables.posts.upsert({
			...post,
			status: 'draft', // New required field
		});
	}

	// Bump epoch (notifies other peers)
	head.bumpEpoch();

	// Cleanup
	await oldClient.destroy();
	await newClient.destroy();
}
```

### Option B: Migrate-on-Read (Lazy Migration)

**Philosophy**: Data stays as-is. Transform when reading. Optionally persist transformed version.

```
┌─────────────────────────────────────────────────────────────────────────────┐
│  MIGRATE-ON-READ (Lazy)                                                      │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│  Y.Doc (raw data)          Read Path                Output (transformed)    │
│  ────────────────          ─────────                ────────────────────    │
│                                                                             │
│  posts: {                  ArkType pipe:            posts: {                │
│    id: "1",                V1.or(V2).pipe(          id: "1",                │
│    title: "Hello"            v => migrateV2(v)        title: "Hello",       │
│    // no status            )                          status: "draft"       │
│  }                                                  }                       │
│       │                         │                          │                │
│       ▼                         ▼                          ▼                │
│  ┌─────────┐              ┌─────────┐              ┌─────────┐             │
│  │ Storage │  ─────────▶  │ Validate│  ─────────▶  │  Memory │             │
│  │ (V1)    │              │ + Xform │              │  (V2)   │             │
│  └─────────┘              └─────────┘              └─────────┘             │
│                                 │                                           │
│                                 │ Optional: persist if user edits           │
│                                 ▼                                           │
│                            ┌─────────┐                                      │
│                            │ Storage │                                      │
│                            │ (V2)    │                                      │
│                            └─────────┘                                      │
│                                                                             │
│  Pros:                                                                      │
│  + Zero downtime                                                            │
│  + No migration script needed                                               │
│  + Gradual (only touched data migrates)                                     │
│  + Works offline                                                            │
│                                                                             │
│  Cons:                                                                      │
│  - Read-time CPU cost                                                       │
│  - Transform logic must handle all versions                                 │
│  - SQLite index may have stale data                                         │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

**Implementation** (ArkType union/pipe pattern):

```typescript
// Define version-aware validator
const PostV1 = type({ id: 'string', title: 'string' });
const PostV2 = type({
	id: 'string',
	title: 'string',
	status: '"draft" | "published"',
});

const Post = PostV1.or(PostV2).pipe((v) => {
	if (!('status' in v)) {
		return { ...v, status: 'draft' as const };
	}
	return v;
});

// Use in table helper
const validPost = Post(rawData); // Always returns V2 shape
```

**Persist-on-Write Enhancement**:

```typescript
// Only persist migrated data when user actually edits
table.update({ id, ...changes }); // Triggers write with migrated format
```

### Option C: Schema-in-Y.Doc (Collaborative Schema)

**Philosophy**: Schema lives in Y.Doc alongside data. Changes sync like any other CRDT update.

```
┌─────────────────────────────────────────────────────────────────────────────┐
│  SCHEMA-IN-YDOC (Collaborative)                                              │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│  Y.Doc                                                                      │
│  ─────                                                                      │
│                                                                             │
│  Y.Map('definition')                                                        │
│    ├── name: "Blog"                                                         │
│    ├── slug: "blog"                                                         │
│    ├── schemaVersion: 2              ← Version marker                       │
│    ├── tables: Y.Map                                                        │
│    │     └── posts: Y.Map                                                   │
│    │           ├── name: "Posts"                                            │
│    │           ├── fields: Y.Map                                            │
│    │           │     ├── id: { type: 'id' }                                │
│    │           │     ├── title: { type: 'text' }                            │
│    │           │     └── status: { type: 'select', ... }  ← New field      │
│    │           └── migrations: Y.Array  ← Migration history                │
│    └── kv: Y.Map                                                            │
│                                                                             │
│  Y.Map('tables')                                                            │
│    └── posts: Y.Map<rowId, Y.Map<field, value>>                            │
│                                                                             │
│  Pros:                                                                      │
│  + Schema syncs automatically                                               │
│  + Peers always see latest schema                                           │
│  + Migration history tracked                                                │
│  + Enables Notion-like schema editing UI                                    │
│                                                                             │
│  Cons:                                                                      │
│  - TypeScript types still come from code                                    │
│  - Runtime schema != compile-time schema                                    │
│  - Must handle schema/data version mismatch                                 │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

**This is partially implemented** in the current architecture. The `definition.merge()` function already syncs schema to Y.Doc.

### Option D: Version Field + Migrate-on-Read

**Philosophy**: Add `_schemaVersion` field to each row. Migrate based on version when reading.

```
┌─────────────────────────────────────────────────────────────────────────────┐
│  ROW-LEVEL VERSIONING                                                        │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│  Row in Y.Doc:                        Read path:                            │
│                                                                             │
│  {                                    if (row._schemaVersion < CURRENT) {   │
│    id: "post-1",                        return migrate(row);                │
│    title: "Hello",                    }                                     │
│    _schemaVersion: 1   ← Version      return row;                           │
│  }                                                                          │
│                                                                             │
│  Pros:                                                                      │
│  + Fine-grained (per-row versioning)                                        │
│  + Can migrate incrementally                                                │
│  + Explicit version visible                                                 │
│                                                                             │
│  Cons:                                                                      │
│  - Version field pollutes schema                                            │
│  - Must increment on every row write                                        │
│  - Complex version comparison logic                                         │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

### Recommendation: Hybrid Approach

**Use epoch-based migration for breaking changes, migrate-on-read for additive changes.**

```
┌─────────────────────────────────────────────────────────────────────────────┐
│  RECOMMENDED: HYBRID STRATEGY                                                │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│  Change Type          Strategy           Example                            │
│  ───────────          ────────           ───────                            │
│                                                                             │
│  Add nullable field   Migrate-on-read    Add 'tags?: string[]'              │
│  Add field w/default  Migrate-on-read    Add 'status' default 'draft'       │
│  Rename field         Epoch bump         'author_id' → 'authorId'           │
│  Remove field         Epoch bump         Remove 'deprecated_field'          │
│  Change type          Epoch bump         'views: string' → 'views: number'  │
│  Add table            Merge (automatic)  Add 'comments' table               │
│                                                                             │
│  Decision flow:                                                             │
│                                                                             │
│  Is it additive AND backward-compatible?                                    │
│       │                                                                     │
│       ├── YES → Migrate-on-read (lazy, no coordination)                     │
│       │                                                                     │
│       └── NO  → Epoch bump (coordinate, explicit migration)                 │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

## Version Notification Mechanisms

How do downstream consumers know a schema has changed?

### Option 1: Schema Version in Y.Doc

Store an explicit version number in the definition map:

```typescript
// In Y.Doc definition
Y.Map('definition')
  └── schemaVersion: 3  // Integer version

// Read flow
const remoteVersion = client.ydoc.getMap('definition').get('schemaVersion');
const codeVersion = workspace.schemaVersion;

if (remoteVersion > codeVersion) {
  console.warn('Schema update available. Update your code.');
}
```

**Pros**: Simple, works with any transport
**Cons**: Requires manual version management

### Option 2: Epoch Observer Pattern

Use the existing `head.observeEpoch()` to notify of schema changes:

```typescript
const head = createHeadDoc({ workspaceId });

head.observeEpoch((newEpoch) => {
	console.log(`Schema updated! New epoch: ${newEpoch}`);
	// Destroy old client, create new one at new epoch
	await client.destroy();
	client = await workspace.create({ epoch: newEpoch });
});
```

**Pros**: Already implemented, automatic
**Cons**: Epoch bump = schema change (may be overkill)

### Option 3: Definition Observer

Add an observer specifically for schema changes:

```typescript
// Proposed API
client.observeSchemaChanges(({ tablesAdded, tablesRemoved, fieldsChanged }) => {
	if (fieldsChanged.length > 0) {
		console.warn('Schema fields changed:', fieldsChanged);
	}
});
```

**Pros**: Fine-grained, doesn't require epoch bump
**Cons**: New code to write

### Option 4: GitHub Releases / NPM Versions

For published workspaces, use package versioning:

```json
// package.json
{
	"name": "@epicenter/blog-workspace",
	"version": "2.0.0",
	"main": "./dist/index.js"
}
```

Consumers can use standard dependency management:

```bash
npm update @epicenter/blog-workspace
```

**Pros**: Standard ecosystem tooling, familiar to developers
**Cons**: Only works for published packages, not collaborative editing

### Recommendation: Layered Notification

```
┌─────────────────────────────────────────────────────────────────────────────┐
│  LAYERED NOTIFICATION SYSTEM                                                 │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│  Layer 1: Epoch Observer (Breaking Changes)                                 │
│  ─────────────────────────────────────────                                  │
│  head.observeEpoch(epoch => reinitializeClient(epoch))                      │
│                                                                             │
│  Layer 2: Definition Observer (Non-Breaking Changes)                        │
│  ────────────────────────────────────────────────────                       │
│  client.observeSchemaChanges(changes => refreshValidators(changes))         │
│                                                                             │
│  Layer 3: Package Versions (Published Workspaces)                           │
│  ─────────────────────────────────────────────────                          │
│  npm update @epicenter/workspace-name                                       │
│                                                                             │
│  Layer 4: AI-Assisted Migrations (Future)                                   │
│  ────────────────────────────────────────                                   │
│  AI generates migration code based on schema diff                           │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

## Schema Registry & Distribution

Where does the "canonical" schema live?

### Option A: Code-as-Schema (Current)

Schema is defined in TypeScript code:

```typescript
// blog-workspace.ts
export const blogWorkspace = defineWorkspace({
	id: 'blog-123',
	tables: { posts: { id: id(), title: text() } },
});
```

**Pros**: Type safety, compile-time checks, versioned with git
**Cons**: Requires code deployment to update

### Option B: JSON Schema Files

Schema as JSON, loaded at runtime:

```json
// schemas/blog-v2.json
{
	"$schema": "https://epicenter.so/schemas/workspace-v1.json",
	"id": "blog-123",
	"version": 2,
	"tables": {
		"posts": {
			"fields": {
				"id": { "type": "id" },
				"title": { "type": "text" }
			}
		}
	}
}
```

**Pros**: Editable without code, can be stored anywhere
**Cons**: Lose TypeScript type inference

### Option C: GitHub as Registry

Use GitHub releases for schema distribution:

```
org/workspace-schemas/
├── blog/
│   ├── v1.json
│   ├── v2.json
│   └── migrations/
│       └── v1-to-v2.ts
└── crm/
    ├── v1.json
    └── ...
```

Fetch at runtime:

```typescript
const schema = await fetch(
	'https://raw.githubusercontent.com/org/workspace-schemas/main/blog/v2.json',
).then((r) => r.json());
```

**Pros**: Versioned, auditable, familiar workflow
**Cons**: Requires network, potential single point of failure

### Option D: NPM-like Central Registry

Publish workspaces as packages:

```bash
epicenter publish @myorg/blog-workspace
epicenter install @myorg/blog-workspace@2.0.0
```

**Pros**: Familiar developer experience, version resolution, dependencies
**Cons**: Significant infrastructure to build

### Option E: Y.Doc as Registry (Decentralized)

Schema lives in Y.Doc, syncs via CRDT:

```
Registry Y.Doc (global)
├── workspaces/
│   ├── blog-123/
│   │   ├── latestVersion: 2
│   │   ├── owner: "user-456"
│   │   └── schemaUrl: "https://..."
│   └── crm-789/
│       └── ...
```

**Pros**: Decentralized, works offline, CRDT conflict resolution
**Cons**: No permission model, potential spam/conflicts

### Recommendation: Hybrid Registry

```
┌─────────────────────────────────────────────────────────────────────────────┐
│  HYBRID REGISTRY STRATEGY                                                    │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│  Internal/Personal Workspaces:                                              │
│  ─────────────────────────────                                              │
│  Code-as-schema + Git versioning                                            │
│  defineWorkspace({ ... }) in your repo                                      │
│                                                                             │
│  Shared/Team Workspaces:                                                    │
│  ───────────────────────                                                    │
│  GitHub repo with JSON schemas + migration scripts                          │
│  CI validates schema changes, publishes releases                            │
│                                                                             │
│  Published Workspaces:                                                      │
│  ────────────────────                                                       │
│  NPM packages with TypeScript types                                         │
│  npm install @epicenter/workspace-name                                      │
│                                                                             │
│  AI-Generated Workspaces:                                                   │
│  ────────────────────────                                                   │
│  JSON schema files in user's workspace folder                               │
│  ~/.epicenter/workspaces/habit-tracker/schema.json                          │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

## Implementation Recommendations

### Phase 1: Add Schema Version to Y.Doc (Low Effort)

Add explicit version tracking to workspace definitions:

```typescript
// In defineWorkspace
export const blogWorkspace = defineWorkspace({
  id: 'blog-123',
  schemaVersion: 2,  // ← Add this
  tables: { ... }
});

// Stored in Y.Doc
definition.merge(config);  // Also stores schemaVersion

// Queryable at runtime
const version = client.ydoc.getMap('definition').get('schemaVersion');
```

**Files to modify**:

- `packages/epicenter/src/core/workspace/workspace.ts`
- `packages/epicenter/src/core/schema/fields/types.ts`

### Phase 2: Definition Observer API (Medium Effort)

Add fine-grained schema change observation:

```typescript
// Proposed API
client.observeSchemaChanges(
	({
		tablesAdded,
		tablesRemoved,
		fieldsAdded,
		fieldsRemoved,
		fieldsChanged,
	}) => {
		console.log('Schema changed:', { tablesAdded, fieldsChanged });
	},
);
```

**Files to create**:

- `packages/epicenter/src/core/workspace/schema-observer.ts`

### Phase 3: Migration Function Registry (Medium Effort)

Define standard migration format:

```typescript
// migrations/v1-to-v2.ts
export const migration = {
	from: 1,
	to: 2,

	tables: {
		posts: {
			// Add new field with default
			addFields: {
				status: {
					type: 'select',
					options: ['draft', 'published'],
					default: 'draft',
				},
			},

			// Transform existing rows
			transform: (row) => ({
				...row,
				status: row.published ? 'published' : 'draft',
			}),

			// Remove old fields
			removeFields: ['published'],
		},
	},
};

// Apply migration
await applyMigration(workspace, migration);
```

### Phase 4: Migrate-on-Read Infrastructure (Higher Effort)

Implement lazy migration in table helpers:

```typescript
// In table-helper.ts
function createTableHelper({ ..., migrations }) {
  return {
    get({ id }) {
      const raw = ymap.get(id);
      if (!raw) return { status: 'not_found', id };

      // Apply migrations lazily
      const migrated = applyMigrations(raw, migrations);

      // Validate against current schema
      const validation = validator.Check(migrated);
      if (!validation) {
        return { status: 'invalid', id, errors: validator.Errors(migrated), row: migrated };
      }

      return { status: 'valid', row: migrated };
    }
  };
}
```

### Phase 5: AI-Assisted Migrations (Future)

Leverage AI to generate migration code:

```typescript
// User describes change
const diff = "Add a 'tags' field to posts, defaulting to empty array";

// AI generates migration
const migration = await ai.generateMigration({
	workspace: blogWorkspace,
	description: diff,
	currentVersion: 2,
	targetVersion: 3,
});

// Review and apply
console.log(migration);
await applyMigration(workspace, migration);
```

---

## Migration Patterns Deep Dive

### Pattern 1: Additive Changes (Safe)

Adding nullable fields or fields with defaults:

```typescript
// V1
tables: {
  posts: { id: id(), title: text() }
}

// V2 - Add nullable field
tables: {
  posts: { id: id(), title: text(), tags: tags({ nullable: true }) }
}
```

**Migration strategy**: None required. Old rows are valid (missing field = null).

### Pattern 2: Add Required Field with Default

```typescript
// V1
tables: {
  posts: { id: id(), title: text() }
}

// V2 - Add required field with default
tables: {
  posts: { id: id(), title: text(), status: select({ options: ['draft', 'published'], default: 'draft' }) }
}
```

**Migration strategy**: Migrate-on-read. Apply default when field missing.

```typescript
const Post = PostV1.or(PostV2).pipe((v) => {
	if (!('status' in v)) return { ...v, status: 'draft' };
	return v;
});
```

### Pattern 3: Rename Field

```typescript
// V1
tables: {
  posts: { id: id(), author_id: text() }
}

// V2 - Rename field
tables: {
  posts: { id: id(), authorId: text() }  // camelCase now
}
```

**Migration strategy**: Epoch bump + explicit migration.

```typescript
// Migration script
for (const post of oldClient.tables.posts.getAllValid()) {
	newClient.tables.posts.upsert({
		id: post.id,
		authorId: post.author_id, // Rename
	});
}
head.bumpEpoch();
```

### Pattern 4: Change Field Type

```typescript
// V1
tables: {
  posts: { id: id(), views: text() }  // Stored as string (oops)
}

// V2 - Fix type
tables: {
  posts: { id: id(), views: integer({ default: 0 }) }
}
```

**Migration strategy**: Epoch bump + transformation.

```typescript
// Migration script
for (const post of oldClient.tables.posts.getAllValid()) {
	newClient.tables.posts.upsert({
		id: post.id,
		views: parseInt(post.views, 10) || 0, // Convert
	});
}
head.bumpEpoch();
```

### Pattern 5: Remove Field

```typescript
// V1
tables: {
  posts: { id: id(), title: text(), deprecated_field: text() }
}

// V2 - Remove field
tables: {
  posts: { id: id(), title: text() }
}
```

**Migration strategy**: Soft remove (field stays in Y.Doc, just not validated).

```typescript
// No migration needed - Y.Doc keeps the data
// Validation just ignores unknown fields
```

Or hard remove with epoch bump:

```typescript
// Migration script - explicitly copy only wanted fields
for (const post of oldClient.tables.posts.getAllValid()) {
	newClient.tables.posts.upsert({
		id: post.id,
		title: post.title,
		// deprecated_field not copied
	});
}
head.bumpEpoch();
```

---

## Open Questions

### 1. Should schema version be per-workspace or per-table?

**Per-workspace** (current assumption):

- Simpler mental model
- One version to track
- All tables migrate together

**Per-table**:

- Fine-grained control
- Independent table evolution
- More complex coordination

**Recommendation**: Start per-workspace, add per-table later if needed.

### 2. How do we handle offline migrations?

**Scenario**: Client A is offline with schema v1. Client B bumps to v2 online. Client A comes online.

**Options**:

1. **Force sync**: Client A must accept v2 schema
2. **Epoch fork**: Client A stays on old epoch until manually migrated
3. **Merge conflict**: Show user a resolution UI

**Recommendation**: Use epoch system—Client A reconnects to new epoch, old data is read-only.

### 3. Should migrations be reversible?

**Reversible**:

- Epoch system already supports this (old epoch = old schema + data)
- No explicit "down" migration needed

**Recommendation**: Use epochs for "rollback" rather than explicit down migrations.

### 4. Who can modify schemas in collaborative settings?

**Options**:

1. **Anyone**: All collaborators can edit schema (Notion-like)
2. **Owner only**: Only workspace owner can change schema
3. **Role-based**: Admins can edit, members can only use

**Recommendation**: Start with "anyone" (CRDT handles conflicts), add roles later.

### 5. How do AI-generated schemas handle versioning?

**Scenario**: User says "add a category field to tasks". AI modifies schema.json.

**Options**:

1. **Auto-increment version**: AI bumps schemaVersion
2. **User confirms**: Show diff, user approves
3. **Migrations inline**: AI generates transform function too

**Recommendation**: AI auto-increments version + generates migration hint.

---

## Summary

Epicenter already has strong foundations for schema migration:

| Building Block             | Status      | Migration Use                          |
| -------------------------- | ----------- | -------------------------------------- |
| **Epoch system**           | Implemented | Version isolation for breaking changes |
| **Definition merge**       | Implemented | CRDT-safe schema updates               |
| **Live definition access** | Implemented | Runtime schema inspection              |
| **Validation separation**  | Implemented | Invalid rows persist, not deleted      |

**Recommended additions**:

1. **Add `schemaVersion` field** to workspace definition (low effort, high value)
2. **Add definition observer** for fine-grained change notification (medium effort)
3. **Define migration function format** for standardized transforms (medium effort)
4. **Implement migrate-on-read** for additive changes (higher effort)
5. **AI-assisted migrations** for complex transformations (future)

**Key principle**:

> **Additive changes → Migrate-on-read (lazy)**
> **Breaking changes → Epoch bump (explicit)**

This hybrid approach minimizes coordination overhead while maintaining data integrity.

---

## References

- `specs/20260108T133200-collaborative-workspace-config-ydoc-handoff.md` - Y.Doc architecture
- `specs/20260111T141856-live-table-definitions.md` - Live definition access
- `specs/20260106T000000-json-serializable-rows.md` - Row storage format
- `packages/epicenter/src/core/docs/head-doc.ts` - Epoch implementation
- `packages/epicenter/src/core/workspace/workspace.ts` - Definition merge
- `docs/articles/why-epicenter-uses-contracts.md` - Contract architecture
