# Workspace Architecture: Single Y.Doc per Workspace

## Summary

After evaluating multi-doc (per-table) vs single-doc architectures, we're keeping the **single Y.Doc per workspace** approach. The complexity of multi-doc (lazy loading orchestration, cross-doc table helpers, two-phase creation) outweighs the benefits for our current scale.

This document captures the analysis and design patterns that apply regardless of the doc strategy.

## Decision: Single Doc vs Multiple Docs

### Option A: Single Workspace Doc (Chosen)

All tables and KV in one Y.Doc with namespaced root maps.

### Option B: Multiple Docs (Rejected for now)

Separate Y.Docs for each table, plus shared docs for metadata and KV.

### Analysis

| Factor                    | Single Doc                   | Multiple Docs                 | Winner |
| ------------------------- | ---------------------------- | ----------------------------- | ------ |
| Initial load time         | Must load entire workspace   | Load only what's needed       | Multi  |
| Memory usage              | All tables always in memory  | Only open tables in memory    | Multi  |
| Sync bandwidth            | All changes to all users     | Only relevant table changes   | Multi  |
| Mobile viability          | 10-16 MB doc = 2-3 min on 3G | 0.5-0.8 MB per table = 10-15s | Multi  |
| Corruption blast radius   | Entire workspace at risk     | Only affected table           | Multi  |
| Atomic multi-table ops    | Native `transact()`          | Requires two-phase pattern    | Single |
| Implementation simplicity | Simpler                      | More plumbing                 | Single |
| API ergonomics            | Sync table access            | Async/await for lazy load     | Single |

### Why Single Doc Wins (For Now)

1. **Implementation complexity**: Multi-doc requires DocManager, lazy loading orchestration, cross-doc coordination
2. **API ergonomics**: `tables.posts.upsert()` is sync; multi-doc would require `await tables.load('posts')`
3. **Two-phase table creation**: Multi-doc needs "creating" → "ready" status to prevent partial visibility
4. **Current scale**: Most workspaces are < 10 tables, < 10k rows. Well within single-doc comfort zone

### When to Reconsider Multi-Doc

- Binary size > 20-50 MB (initial sync becomes painful)
- \> 50k rows total (memory pressure on mobile)
- \> 5 concurrent editors on different tables (bandwidth waste)
- Need for table-level access control (different collaborators per table)

## Current Architecture (Single Doc)

```
┌─────────────────────────────────────────────────────────────────────────┐
│  HEAD DOC (guid: "{workspaceId}")                                       │
│  Scope: Shared with all collaborators                                   │
│  Loaded: Always (first thing on workspace open)                         │
├─────────────────────────────────────────────────────────────────────────┤
│                                                                         │
│  Y.Map('meta')                    # Workspace identity                  │
│    ├── name: "My Blog"                                                  │
│    ├── icon: "emoji:📝"                                                 │
│    └── description: "Personal blog workspace"                           │
│                                                                         │
│  Y.Map('epochs')                  # Per-client epoch proposals          │
│    └── {clientId}: 0              # CRDT-safe max() aggregation         │
│                                                                         │
└─────────────────────────────────────────────────────────────────────────┘
                              │
                              │  Head Doc points to current epoch
                              │  Workspace Doc contains all data
                              ▼
┌─────────────────────────────────────────────────────────────────────────┐
│  WORKSPACE DOC (guid: "{workspaceId}-{epoch}")                          │
│  Scope: Shared with all collaborators                                   │
│  Loaded: When user opens workspace                                      │
├─────────────────────────────────────────────────────────────────────────┤
│                                                                         │
│  Y.Map('definition')              # Table/KV schemas                    │
│    ├── tables: {                                                        │
│    │     [tableName]: {                                                 │
│    │       name, icon, description,                                     │
│    │       fields: { [fieldName]: FieldSchema }                         │
│    │     }                                                              │
│    │   }                                                                │
│    └── kv: {                                                            │
│          [key]: { name, icon, description, field: FieldSchema }         │
│        }                                                                │
│                                                                         │
│  Y.Map('tables')                  # All table row data                  │
│    └── {tableName}: Y.Map<rowId, Y.Map<fieldName, value>>               │
│                                                                         │
│  Y.Map('kv')                      # Settings values                     │
│    └── {key}: value                                                     │
│                                                                         │
└─────────────────────────────────────────────────────────────────────────┘
```

## ID Strategy

| Entity    | Format                | Example             | Rationale                                      |
| --------- | --------------------- | ------------------- | ---------------------------------------------- |
| Workspace | User-provided or UUID | `blog`, `ws-abc123` | Human-readable when possible                   |
| Epoch     | Integer from 0        | `0`, `1`, `2`       | Simple incrementing version                    |
| Table     | Slug or UUID          | `posts`, `tbl-abc`  | Slugs for code-defined, UUIDs for user-created |
| Row       | UUID/ULID             | `row-6ba7b810-9dad` | Prevents LWW on concurrent creation            |
| Field     | Slug or UUID          | `title`, `fld-abc`  | Slugs for code-defined, UUIDs for user-created |
| KV Key    | Slug                  | `theme`, `fontSize` | Always code-defined                            |

### Why UUIDs for Rows

If two users concurrently create a row, and we use sequential IDs or content-based keys:

```typescript
// User A
rows.set('post-1', { title: 'Hello' });

// User B (concurrent)
rows.set('post-1', { title: 'World' });

// Result: LWW, one user's row is lost
```

With UUID keys:

```typescript
// User A
rows.set('row-uuid-a', { title: 'Hello' });

// User B (concurrent)
rows.set('row-uuid-b', { title: 'World' });

// Result: Both rows exist
```

### When to Use UUIDs for Tables

**Code-defined tables** (in workspace definition): Use slugs (`posts`, `users`)

- Table names are known at compile time
- No concurrent creation risk
- Better DX: `tables.posts.upsert()`

**User-created tables** (Notion-style dynamic): Use UUIDs (`tbl-550e8400`)

- Two users might create "Posts" table simultaneously
- UUID prevents LWW collision
- UI handles duplicate display names

## Icon Storage

Icons are stored as tagged strings to ensure atomic updates.

### Format

```
emoji:📝
lucide:file-text
url:https://example.com/icon.png
```

### Why Tagged Strings (Not Objects)

If icon were `{ type: 'emoji', value: '📝' }` stored as a nested Y.Map:

```typescript
// User A changes to lucide icon
iconMap.set('type', 'lucide');
iconMap.set('value', 'file-text');

// User B changes to different emoji (concurrent)
iconMap.set('type', 'emoji');
iconMap.set('value', '👤');

// Possible result after merge: { type: 'emoji', value: 'file-text' }
// Invalid! Emoji type with lucide value
```

With tagged string:

```typescript
// User A
meta.set('icon', 'lucide:file-text');

// User B (concurrent)
meta.set('icon', 'emoji:👤');

// Result: One wins (LWW), but always valid
```

### TypeScript Types

```typescript
type IconDefinition =
	| { kind: 'emoji'; emoji: string }
	| { kind: 'lucide'; name: string }
	| { kind: 'url'; url: string };

function encodeIcon(icon: IconDefinition): string {
	switch (icon.kind) {
		case 'emoji':
			return `emoji:${icon.emoji}`;
		case 'lucide':
			return `lucide:${icon.name}`;
		case 'url':
			return `url:${icon.url}`;
	}
}

function decodeIcon(raw: string): IconDefinition | null {
	const colonIndex = raw.indexOf(':');
	if (colonIndex <= 0) return null;

	const tag = raw.slice(0, colonIndex);
	const value = raw.slice(colonIndex + 1);

	switch (tag) {
		case 'emoji':
			return { kind: 'emoji', emoji: value };
		case 'lucide':
			return { kind: 'lucide', name: value };
		case 'url':
			return { kind: 'url', url: value };
		default:
			return null;
	}
}
```

## Table Creation Patterns

### Code-Defined Tables (Current)

Tables defined in workspace schema are automatically created:

```typescript
const schema = defineWorkspace({
	id: 'blog',
	tables: {
		posts: { fields: { id: id(), title: text() } },
		users: { fields: { id: id(), email: text() } },
	},
	kv: {},
});

const client = createWorkspaceClient(head, schema);
// Tables 'posts' and 'users' exist immediately
```

### Dynamic Table Creation (Notion-style)

For user-created tables at runtime, use UUID table IDs:

```typescript
function createTable(name: string, fields: FieldSchemaMap) {
	const tableId = `tbl-${crypto.randomUUID()}`;

	ydoc.transact(() => {
		// Add to definition
		const tablesDefinition = ydoc.getMap('definition').get('tables');
		tablesDefinition.set(
			tableId,
			new Y.Map([
				['name', name],
				['icon', null],
				['description', ''],
				['fields', fieldsToYMap(fields)],
			]),
		);

		// Create empty table map (rows will be added later)
		ydoc.getMap('tables').set(tableId, new Y.Map());
	});

	return tableId;
}
```

**Why no two-phase needed**: UUID prevents collision. If two users create "Posts" simultaneously, both tables exist (with different UUIDs). UI can handle duplicate display names.

### Dynamic Table Deletion (Soft Delete)

Use tombstones instead of Y.Map deletion for better sync behavior:

```typescript
function deleteTable(tableId: string) {
	ydoc.transact(() => {
		const tableDefinition = ydoc
			.getMap('definition')
			.get('tables')
			.get(tableId);
		if (tableDefinition) {
			tableDefinition.set('deletedAt', Date.now());
		}
	});

	// UI filters out tables where deletedAt !== null
	// Background job can clean up old tombstones
}
```

**Why tombstones**: Deleting a Y.Map key can cause sync issues if another client has pending writes to that key. Tombstones are explicit and merge cleanly.

## Persistence Strategy

### File Layout

```
{appLocalDataDir}/
├── registry.yjs                    # Index of all workspace IDs
└── workspaces/
    └── {workspaceId}/
        ├── head.yjs                # Epoch pointer + workspace identity
        └── epochs/
            └── {epoch}/
                ├── workspace.yjs   # Full Y.Doc (tables + kv + definition)
                ├── definition.json # Human-readable schema snapshot
                ├── kv.json         # Human-readable settings snapshot
                └── workspace.sqlite # Optional: materialized SQL view
```

### Persistence Outputs

| File               | Source                   | Write Timing    | Purpose                        |
| ------------------ | ------------------------ | --------------- | ------------------------------ |
| `workspace.yjs`    | Full Y.Doc               | Immediate       | CRDT sync, source of truth     |
| `definition.json`  | Y.Map('definition')      | Debounced 500ms | Git-friendly schema, debugging |
| `kv.json`          | Y.Map('kv')              | Debounced 500ms | Human-readable settings        |
| `workspace.sqlite` | Materialized from tables | On change       | SQL queries via Drizzle        |

## Epoch System

Epochs enable atomic migrations and compaction:

```
Epoch 0: Initial workspace
    │
    │ Schema migration needed (rename field)
    ▼
Epoch 1: Migrated data
    │
    │ Y.Doc too large, needs compaction
    ▼
Epoch 2: Compacted (fresh Y.Doc, no history)
```

### Epoch Bump Process

1. Create new Workspace Doc at `{workspaceId}:{epoch+1}`
2. Transform/copy data from old epoch
3. Update Head Doc epoch pointer (CRDT-safe max aggregation)
4. All clients observe Head Doc, switch to new epoch
5. Old epoch preserved for rollback

### CRDT-Safe Epoch Tracking

Head Doc uses per-client epoch proposals with max() aggregation:

```typescript
// Each client writes to their own key
Y.Map('epochs')
  └── "client-123": 2
  └── "client-456": 2
  └── "client-789": 3

// Current epoch = max(all values) = 3
```

This prevents concurrent epoch bumps from skipping versions.

## Cross-Table References

Foreign keys are eventually consistent. The referencing table stores the row ID; the UI must handle missing references:

```typescript
// Comment references a post
const comment = { postId: 'row-123', body: 'Great post!' };

// If post row-123 is deleted:
// - Comment still has postId: 'row-123'
// - UI shows: "Referenced post not found" or hides comment
// - Optional: background job cleans up orphans
```

**Why not enforce referential integrity**: YJS is a CRDT; you can't prevent a delete from one client while another client is writing a reference. Embrace eventual consistency.

## Future: Multi-Doc Migration Path

If we hit scale limits, the migration path to multi-doc:

1. **Add DocManager**: Orchestrates loading/caching of multiple docs
2. **Split Workspace Doc**:
   - `{workspaceId}-{epoch}-tables` → schemas only
   - `{workspaceId}-{epoch}-tables-{tableId}` → row data per table
   - `{workspaceId}-{epoch}-kv` → settings
3. **Update table helpers**: Accept DocManager, lazy-load table docs
4. **Epoch bump**: Existing workspaces migrate on next epoch bump

The key insight: **identity stays in Head Doc** (table names, icons), so the sidebar can render before loading any table data. This principle applies whether single-doc or multi-doc.

## Open Questions

- [ ] **Field ordering**: Y.Array for order, or `order` field in schema?
- [ ] **Row ordering**: Same question for user-defined row order (kanban, manual sort)
- [ ] **Compaction timing**: When to trigger epoch bump for doc size management?
- [ ] **Garbage collection**: When to clean up old epochs and tombstoned tables?

## References

- [Y.js Documentation](https://docs.yjs.dev/)
- [Current docs README](../../packages/epicenter/src/core/docs/README.md)
- [Three-Doc Architecture (app layer)](../../apps/epicenter/src/lib/docs/README.md)
