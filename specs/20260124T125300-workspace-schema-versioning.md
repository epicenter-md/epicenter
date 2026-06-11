# Workspace-Level Schema Versioning for YJS Local-First Apps

> **⚠️ PARTIALLY SUPERSEDED**
>
> This spec has been partially superseded by [`specs/20260124T162638-stable-id-schema-pattern.md`](./20260124T162638-stable-id-schema-pattern.md).
>
> **What changed**: The Stable ID pattern eliminates the need for per-row `_v` versioning entirely. Instead of tracking versions and running migrations, each field has a stable internal ID that never changes. Renaming is free (just change the schema key), and invalid/missing data simply returns the default value.
>
> **What's still valuable here**: The analysis of the problem space (why CRDT migrations are hard, the epoch system for breaking changes, the YJS conflict problem) remains accurate. The two-tier model (epochs for breaking changes, additive changes within epochs) is still correct. But "additive changes" no longer need version tracking.
>
> **Read this spec for**: Understanding the problem. **Read the Stable ID spec for**: The solution.

---

**Status**: Design Proposal (Partially Superseded)
**Date**: 2026-01-24
**Builds On**: `specs/20260124T004528-versioned-table-api-design.md` (table-level research)
**Context**: Designing a unified schema versioning system at the workspace level

---

## Executive Summary

This spec proposes **workspace-level schema versioning** as an alternative to per-table or per-row versioning. The key insight is that schema changes often affect multiple tables simultaneously, and versioning at the workspace level provides:

1. **Atomic schema changes**: Add fields to multiple tables in one version bump
2. **Simpler mental model**: "The workspace is at version 3" vs "Table A is v2, Table B is v4"
3. **Better type safety**: One version number → one complete TypeScript type
4. **Natural callback API**: Previous schema flows into next, enabling spreads and transforms

---

## Problem Recap

Local-first apps using YJS need to evolve schemas over time. The challenges:

| Challenge               | Description                                         |
| ----------------------- | --------------------------------------------------- |
| **Multi-peer sync**     | Data can arrive from any peer at any schema version |
| **Field-level LWW**     | YJS uses last-write-wins per field, not per row     |
| **No migration window** | Old and new clients may sync indefinitely           |
| **Coordinated changes** | Features often touch multiple tables at once        |

The previous spec explored **table-level versioning** (`versionedTable`), but this creates complexity when tables need coordinated changes.

---

## Proposed Solution: Workspace-Level Schema Versioning

### Core API

```typescript
import {
	workspace,
	id,
	text,
	select,
	integer,
	boolean,
	setting,
} from '@epicenter/workspace';

const whispering = workspace('epicenter.whispering')
	// Version 1: Initial schema (no callback - this IS the base)
	.v(1, {
		tables: {
			recordings: {
				id: id(),
				title: text(),
				transcript: text({ nullable: true }),
			},
			transformations: {
				id: id(),
				name: text(),
				prompt: text(),
			},
		},
		kv: {
			theme: setting(select(['light', 'dark']), { default: 'light' }),
		},
	})

	// Version 2: Add status to recordings, add language to KV
	.v(2, (prev) => ({
		tables: {
			recordings: {
				...prev.tables.recordings,
				status: select(['pending', 'completed'], { default: 'completed' }),
			},
			transformations: prev.tables.transformations,
		},
		kv: {
			...prev.kv,
			language: setting(select(['en', 'es', 'fr']), { default: 'en' }),
		},
	}))

	// Version 3: Add priority with computed default, add enabled to transformations
	.v(3, (prev) => ({
		tables: {
			recordings: {
				...prev.tables.recordings,
				priority: integer({
					default: 0,
					migrateFrom: (row) => (row.transcript ? 1 : 0),
				}),
			},
			transformations: {
				...prev.tables.transformations,
				enabled: boolean({ default: true }),
			},
		},
		kv: prev.kv,
	}))

	.build();
```

### Key Design Decisions

#### 1. Callback Receives Previous Schema, Returns New Schema

The migration callback receives the **fully typed previous schema** and must return the **next schema**:

```typescript
.v(2, (prev) => {
  // prev is typed as Schema_V1
  // return type must be Schema_V2
  return {
    tables: {
      recordings: {
        ...prev.tables.recordings,  // Spread existing fields
        newField: text(),            // Add new field
      },
    },
    kv: prev.kv,
  };
})
```

**Why this is better than `addFields`**:

- Full type safety end-to-end
- Explicit about what changed
- Flexible: spread, modify, restructure as needed
- No magic APIs to learn

#### 2. Defaults Drive Data Migration

New fields **must have a `default`**. This default is used when reading rows at older versions:

```typescript
status: select(['pending', 'completed'], { default: 'completed' });
```

For computed defaults based on existing row data, use `migrateFrom`:

```typescript
priority: integer({
	default: 0, // Fallback default
	migrateFrom: (row) => (row.transcript ? 1 : 0), // Computed from row
});
```

**Migration execution**:

- `migrateFrom` is called lazily when reading old rows
- If `migrateFrom` is not provided, `default` is used
- This keeps reads pure (no YJS writes during read)

#### 3. Version Stored Per-Row as `_v`

Each row stores its schema version:

```typescript
{ id: 'abc', title: 'Hello', transcript: '...', _v: 2 }
```

**Why per-row instead of per-workspace**:

- Allows gradual migration (rows upgrade when touched)
- Handles offline scenarios (device A at v2, device B at v3)
- Simpler than coordinating workspace-wide migration

**Version field rules**:

- `_v` is monotonic (only increases)
- `_v` defaults to `1` for rows without it (legacy data)
- Old clients should never downgrade `_v`

#### 4. Breaking Changes Require Epoch Bumps

This system handles **additive changes** (the common 50%):

- Add nullable field ✓
- Add field with default ✓
- Add computed field ✓
- Add new table ✓
- Add new KV setting ✓

**Breaking changes** still require epoch bumps (new Y.Doc):

- Rename field → Epoch bump
- Change field type → Epoch bump
- Remove field → Epoch bump (or soft-delete)
- Restructure data → Epoch bump

---

## Type System Design

### Builder Type Flow

```typescript
type WorkspaceBuilder<TLatest extends WorkspaceSchema> = {
	v<TNext extends WorkspaceSchema>(
		version: number,
		schema: TNext | ((prev: TLatest) => TNext),
	): WorkspaceBuilder<TNext>;

	build(): VersionedWorkspace<TLatest>;
};
```

The builder accumulates types through the chain:

```
workspace('id')           // WorkspaceBuilder<{}>
  .v(1, schema1)          // WorkspaceBuilder<Schema1>
  .v(2, prev => schema2)  // WorkspaceBuilder<Schema2>  (prev: Schema1)
  .v(3, prev => schema3)  // WorkspaceBuilder<Schema3>  (prev: Schema2)
  .build()                // VersionedWorkspace<Schema3>
```

### Schema Types

```typescript
type WorkspaceSchema = {
	tables: TableDefinitionMap;
	kv: KvDefinitionMap;
};

type TableDefinitionMap = Record<string, FieldMap>;
type FieldMap = Record<string, FieldSchema>;

type KvDefinitionMap = Record<string, KvDefinition>;
type KvDefinition = { field: FieldSchema; default?: unknown };
```

### Field Schema with Migration

```typescript
type FieldSchema = {
  type: 'text' | 'integer' | 'boolean' | 'select' | /* ... */;
  nullable?: boolean;
  default?: unknown;
  migrateFrom?: (row: Record<string, unknown>) => unknown;
};
```

### Inferred Row Types

The final `build()` returns a workspace where tables are typed to the **latest schema**:

```typescript
const ws = workspace('id').v(1, s1).v(2, s2).v(3, s3).build();

// ws.tables.recordings returns rows typed as:
type Recording = {
	id: string;
	title: string;
	transcript: string | null;
	status: 'pending' | 'completed';
	priority: number;
	_v: number;
};
```

---

## Runtime Behavior

### Reading Rows (Lazy Migration)

When reading a row, the system:

1. Reads raw data from Y.Map
2. Checks `_v` field (defaults to 1)
3. If `_v < latestVersion`, applies migrations **in memory**
4. Returns the upgraded row (does NOT write back to YJS)

```typescript
function getRow(id: string): Recording {
	const raw = rowMap.get(id)?.toJSON();
	const version = raw._v ?? 1;

	if (version < 3) {
		// Apply migrations in memory
		return workspace.upgrade(raw);
	}

	return raw as Recording;
}
```

### Writing Rows (YJS-Safe Patching)

When writing a row, the system:

1. Checks if row exists and its current `_v`
2. If upgrading, **only writes new fields** (patch-based)
3. Updates `_v` to latest version
4. Writes user's actual changes

```typescript
function upsertRow(row: Recording): void {
	ydoc.transact(() => {
		const existing = rowsMap.get(row.id);

		if (existing) {
			const currentV = existing.get('_v') ?? 1;

			// Patch new fields from migrations (YJS-safe)
			if (currentV < 2) {
				if (!existing.has('status')) {
					existing.set('status', row.status ?? 'completed');
				}
			}
			if (currentV < 3) {
				if (!existing.has('priority')) {
					existing.set('priority', row.priority ?? 0);
				}
			}

			// Update version
			existing.set('_v', 3);

			// Apply user's changes
			for (const [key, value] of Object.entries(row)) {
				if (key !== '_v') {
					existing.set(key, value);
				}
			}
		} else {
			// New row - write all fields at latest version
			const newRow = new Y.Map();
			for (const [key, value] of Object.entries(row)) {
				newRow.set(key, value);
			}
			newRow.set('_v', 3);
			rowsMap.set(row.id, newRow);
		}
	});
}
```

### Batch Migration (Optional)

For eager migration of all rows:

```typescript
async function migrateAllRows(tableName: string): Promise<void> {
	const table = workspace.tables[tableName];

	ydoc.transact(() => {
		for (const [id, rowMap] of tableMap.entries()) {
			table.ensureMigrated(rowMap);
		}
	});
}
```

---

## Integration with Existing Architecture

### Relationship to Epochs

```
┌─────────────────────────────────────────────────────────────────┐
│  EPOCH LEVEL (Breaking Changes)                                  │
│  ───────────────────────────────                                 │
│                                                                  │
│  Epoch 0 ─────────────────────────────> Epoch 1                  │
│  (Y.Doc "abc-0")                        (Y.Doc "abc-1")          │
│                                                                  │
│  • Field renames                                                 │
│  • Type changes                                                  │
│  • Field deletions                                               │
│  • Data restructuring                                            │
└─────────────────────────────────────────────────────────────────┘
                              │
                              │ Within each epoch...
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│  SCHEMA VERSION LEVEL (Additive Changes)                         │
│  ───────────────────────────────────────                         │
│                                                                  │
│  v1 ──────> v2 ──────> v3 ──────> v4                             │
│  (same Y.Doc, per-row _v field)                                  │
│                                                                  │
│  • Add nullable field                                            │
│  • Add field with default                                        │
│  • Add computed field                                            │
│  • Add new table                                                 │
│  • Add new KV setting                                            │
└─────────────────────────────────────────────────────────────────┘
```

### Relationship to Head Doc

The Head Doc continues to manage epochs. Schema versions are orthogonal:

```typescript
// Head Doc: manages epoch (which Y.Doc to use)
const head = createHeadDoc({ workspaceId: 'abc' });
const epoch = head.getEpoch(); // 0

// Workspace: manages schema versions (within that Y.Doc)
const ws = workspace('abc').v(1, s1).v(2, s2).v(3, s3).build();
const schemaVersion = ws.latestVersion; // 3

// Client: combines both
const client = createClient(head)
	.withDefinition(ws)
	.withExtensions({ persistence, sqlite });
```

### Relationship to createClient Builder

The existing builder pattern is preserved:

```typescript
// Before (current API)
const definition = defineWorkspace({
	id: 'abc',
	tables: { posts: { id: id(), title: text() } },
	kv: {},
});

const client = createClient(head)
	.withDefinition(definition)
	.withExtensions({ persistence });

// After (versioned API)
const definition = workspace('abc')
	.v(1, { tables: { posts: { id: id(), title: text() } }, kv: {} })
	.v(2, (prev) => ({ ...prev /* changes */ }))
	.build();

const client = createClient(head)
	.withDefinition(definition) // Same API!
	.withExtensions({ persistence });
```

---

## KV Store Versioning

KV settings are singletons, but they also evolve:

```typescript
.v(1, {
  tables: { /* ... */ },
  kv: {
    theme: setting(select(['light', 'dark']), { default: 'light' }),
  },
})
.v(2, (prev) => ({
  tables: { /* ... */ },
  kv: {
    ...prev.kv,
    language: setting(select(['en', 'es', 'fr']), { default: 'en' }),
  },
}))
```

### KV Migration Behavior

- New KV keys return their default until explicitly set
- No `_v` field needed for KV (presence/absence is sufficient)
- KV changes don't conflict with row migrations

---

## Forward Compatibility

### Scenario: New Client (v3) Creates Row, Old Client (v1) Edits It

```
Device A (v3): Creates row with status, priority fields
Device B (v1): Syncs row, doesn't understand status/priority
Device B: Edits title field
Sync back to A...
```

**This works IF** Device B only patches fields it knows:

```typescript
// Good: only touch known fields
rowMap.set('title', newTitle);

// Bad: rewrite entire row
const myRow = { id, title, transcript }; // Missing status, priority!
for (const [k, v] of Object.entries(myRow)) {
	rowMap.set(k, v);
}
```

**Rule**: Old clients must use patch-based updates, not full row rewrites.

### Unknown Field Preservation

When reading, preserve fields you don't recognize:

```typescript
function upgradeRow(raw: any): Recording {
	// Apply known migrations
	const upgraded = { ...raw };

	// Don't strip unknown fields
	// Future versions may have added fields we don't know about

	return upgraded;
}
```

---

## Implementation Sketch

### workspace() Builder

```typescript
type VersionEntry<T> = {
	version: number;
	schema: T;
	migrations: Map<string, FieldMigration>; // tableName.fieldName -> migrator
};

export function workspace<Id extends string>(id: Id) {
	const versions: VersionEntry<any>[] = [];

	const builder = {
		v<TSchema extends WorkspaceSchema>(
			version: number,
			schemaOrCallback: TSchema | ((prev: any) => TSchema),
		) {
			const prevSchema =
				versions.length > 0 ? versions[versions.length - 1].schema : {};

			const schema =
				typeof schemaOrCallback === 'function'
					? schemaOrCallback(prevSchema)
					: schemaOrCallback;

			// Extract migrations from fields with migrateFrom
			const migrations = extractMigrations(prevSchema, schema);

			versions.push({ version, schema, migrations });

			return builder as WorkspaceBuilder<TSchema>;
		},

		build(): VersionedWorkspace<TLatest> {
			const latest = versions[versions.length - 1];

			return {
				id,
				latestVersion: latest.version,
				schema: latest.schema,
				versions,

				upgrade(tableName: string, raw: unknown) {
					let current = { ...(raw as any) };
					let currentVersion = current._v ?? 1;

					for (const entry of versions) {
						if (entry.version <= currentVersion) continue;

						// Apply field migrations for this table
						const tableKey = tableName;
						for (const [fieldPath, migrator] of entry.migrations) {
							if (fieldPath.startsWith(tableKey + '.')) {
								const fieldName = fieldPath.split('.')[1];
								if (!(fieldName in current)) {
									current[fieldName] = migrator(current);
								}
							}
						}

						current._v = entry.version;
					}

					return current;
				},

				ensureMigrated(tableName: string, rowMap: Y.Map<any>) {
					const currentVersion = rowMap.get('_v') ?? 1;

					for (const entry of versions) {
						if (entry.version <= currentVersion) continue;

						const tableKey = tableName;
						for (const [fieldPath, migrator] of entry.migrations) {
							if (fieldPath.startsWith(tableKey + '.')) {
								const fieldName = fieldPath.split('.')[1];
								if (!rowMap.has(fieldName)) {
									const value = migrator(rowMap.toJSON());
									rowMap.set(fieldName, value);
								}
							}
						}

						rowMap.set('_v', entry.version);
					}
				},
			};
		},
	};

	return builder;
}

function extractMigrations(prev: any, next: any): Map<string, FieldMigration> {
	const migrations = new Map();

	// Compare tables
	for (const [tableName, tableSchema] of Object.entries(next.tables ?? {})) {
		const prevTable = prev.tables?.[tableName] ?? {};

		for (const [fieldName, fieldSchema] of Object.entries(tableSchema as any)) {
			if (!(fieldName in prevTable)) {
				// New field - extract migrator
				const schema = fieldSchema as FieldSchema;
				const migrator = schema.migrateFrom ?? (() => schema.default);
				migrations.set(`${tableName}.${fieldName}`, migrator);
			}
		}
	}

	return migrations;
}
```

---

## Comparison with Previous Approaches

| Aspect                  | Per-Row \_v (Table-Level)          | Workspace-Level                     |
| ----------------------- | ---------------------------------- | ----------------------------------- |
| **Granularity**         | Each table versioned independently | All tables share version chain      |
| **Coordinated changes** | Must manually sync versions        | Atomic across tables                |
| **Type safety**         | Per-table, harder to compose       | Full workspace type at each version |
| **Mental model**        | "Table A is v2, Table B is v4"     | "Workspace is v3"                   |
| **API complexity**      | Multiple `versionedTable()` calls  | Single `workspace()` chain          |
| **Migration callback**  | `addFields` or per-table transform | Full schema callback                |

---

## The YJS Conflict Problem (Reference)

### Why Full Row Transforms Are Dangerous

```
Device A (offline): Reads row v1, migrates to v2, writes entire row back
Device B (offline): Edits just the "title" field on v1
Both sync...
```

**Result**: If A's migration wrote the `title` field (even with its old value), A and B both wrote to the same key. YJS picks one: B's edit may be lost.

### Why Patch-Based Is Safe

This design only writes **new fields** during migration:

```typescript
// Safe: only add fields that don't exist
if (!rowMap.has('status')) {
	rowMap.set('status', 'completed');
}
rowMap.set('_v', 2);
```

Existing fields are never touched during migration, so concurrent edits to those fields are preserved.

---

## Open Questions

1. **Should v(1) accept a callback?**
   - Current proposal: No, v(1) is the base schema (no "previous")
   - Alternative: Allow callback that receives `{}` for consistency

2. **How to handle table additions?**
   - New tables added in v2+ start empty
   - Should there be a way to "seed" initial data for new tables?

3. **Validation of version chain?**
   - Should the builder validate that versions are sequential?
   - Should it validate that new fields have defaults?

4. **Runtime version storage location?**
   - Per-row `_v` field (current proposal)
   - Alternative: Single version in workspace metadata (all-or-nothing)

5. **Extension integration?**
   - How do SQLite/markdown extensions handle schema versions?
   - Should they auto-migrate their schemas too?

---

## Migration Path from Current API

For existing apps using `defineWorkspace`:

```typescript
// Before
const definition = defineWorkspace({
	id: 'blog',
	tables: { posts: { id: id(), title: text() } },
	kv: {},
});

// After (minimal change)
const definition = workspace('blog')
	.v(1, {
		tables: { posts: { id: id(), title: text() } },
		kv: {},
	})
	.build();

// The build() result is compatible with createClient().withDefinition()
```

---

## Recommendations

1. **Implement workspace-level versioning** as the primary API
2. **Keep `defineWorkspace` as sugar** for v1-only definitions
3. **Require defaults for new fields** (enforced by types)
4. **Use per-row `_v`** for gradual migration support
5. **Keep epoch bumps** for breaking changes
6. **Document the "additive only within epoch" rule** clearly

---

## Related Documents

- `specs/20260124T004528-versioned-table-api-design.md`: Previous table-level research and YJS conflict analysis
- `packages/epicenter/src/core/docs/README.md`: Three-document architecture (Registry, Head, Workspace)
- `packages/epicenter/src/core/workspace/README.md`: Current workspace API and epoch system

---

## Changelog

- 2026-01-24: Initial proposal for workspace-level schema versioning
