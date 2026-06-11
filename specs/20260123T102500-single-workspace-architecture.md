# Single Workspace Architecture: One Doc Per Workspace

## Summary

An alternative to the multi-doc subdoc architecture. Instead of splitting workspace data across multiple Y.Docs (Head, Tables, KV), use a **single Y.Doc per workspace** with definitions separated from data internally for optimal observation patterns.

This document explores the structure, trade-offs, and migration path for this approach.

## Final Structure

```
┌─────────────────────────────────────────────────────────────────────────────┐
│  WORKSPACE DOC (guid: "ws-123")                                             │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│  ┌────────────────────────────────────────────────────────────────────────┐ │
│  │  COLD ZONE (rarely changes)                                            │ │
│  ├────────────────────────────────────────────────────────────────────────┤ │
│  │                                                                        │ │
│  │  Y.Map('definition')                # Workspace identity + all schemas │ │
│  │    ├── name: "My Blog"                                                 │ │
│  │    ├── icon: "emoji:📝"                                                │ │
│  │    ├── description: "..."                                              │ │
│  │    │                                                                   │ │
│  │    ├── tables: Y.Map                # Table definitions                │ │
│  │    │   └── {tableId}: Y.Map                                            │ │
│  │    │       ├── name: "Posts"                                           │ │
│  │    │       ├── icon: "emoji:📝"                                        │ │
│  │    │       ├── description: "..."                                      │ │
│  │    │       └── fields: Y.Map                                           │ │
│  │    │           └── {fieldId}: Field                                    │ │
│  │    │                                                                   │ │
│  │    └── kv: Y.Map                    # KV definitions                   │ │
│  │        └── {key}: Y.Map                                                │ │
│  │            ├── name: "Theme"                                           │ │
│  │            ├── icon: "emoji:🎨"                                        │ │
│  │            └── field: Field                                            │ │
│  │                                                                        │ │
│  └────────────────────────────────────────────────────────────────────────┘ │
│                                                                             │
│  ┌────────────────────────────────────────────────────────────────────────┐ │
│  │  HOT ZONE (changes frequently)                                         │ │
│  ├────────────────────────────────────────────────────────────────────────┤ │
│  │                                                                        │ │
│  │  Y.Map('tables')                    # Row data ONLY                    │ │
│  │    └── {tableId}: Y.Map             # This IS the rows map             │ │
│  │        └── {rowId}: Y.Map           # Row                              │ │
│  │            └── {fieldId}: value     # Cell  ←─── HOTTEST PATH          │ │
│  │                                                                        │ │
│  │  Y.Map('kv')                        # Values ONLY                      │ │
│  │    └── {key}: value                 # Just the value                   │ │
│  │                                                                        │ │
│  └────────────────────────────────────────────────────────────────────────┘ │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘


THREE TOP-LEVEL MAPS = THREE CONCERNS
═════════════════════════════════════

Y.Map('definition')  →  "What IS this workspace?"      →  definition.json
Y.Map('tables')      →  "What DATA is in the tables?"  →  tables.sqlite
Y.Map('kv')          →  "What are current settings?"   →  kv.json


OBSERVER ATTACHMENT POINTS
══════════════════════════

Cold Zone (schema changes):
  definition.observe()                        → workspace meta changed
  definition.observeDeep()                    → ANY schema change (tables, kv, fields)
  definition.get('tables').observe()          → table def added/removed
  definition.get('tables').get(id).observe()  → table meta changed
  definition.get('tables').get(id).get('fields').observe() → field added/removed

Hot Zone (data changes):
  tables.observe()                            → table data added/removed
  tables.get(id).observe()                    → row added/removed
  tables.get(id).observeDeep()                → row OR cell changed
  kv.observe()                                → any kv value changed


CHANGE FREQUENCY HEAT MAP
═════════════════════════

definition (workspace meta)                   ~1/month     ░░░░░░░░░░
definition.tables.{id} (table meta)           ~1/month     ░░░░░░░░░░
definition.tables.{id}.fields                 ~1/week      ██░░░░░░░░
definition.kv.{key}                           ~1/month     ░░░░░░░░░░
kv.{key} (value)                              ~10/day      ████░░░░░░
tables.{id} (row add/remove)                  ~100/day     ██████░░░░
tables.{id}.{rowId}.{fieldId} (cell)          ~1000/day    ██████████  ← HOTTEST
```

## Key Insight: Structure Optimized for Observation

The internal YJS structure is **separated by change frequency**, not co-located. This is intentional:

1. **Cold data (definitions)** lives in `Y.Map('definition')`
2. **Hot data (rows, values)** lives in `Y.Map('tables')` and `Y.Map('kv')`

**Why this matters:**

- Observers attach directly to the heat: `tables.get('posts').observeDeep()` only fires for row/cell changes
- No filtering needed: you don't get schema changes mixed into data observers
- Different debounce strategies: sync definitions every 5s, sync rows every 100ms

**But the API hides this!** Developers see a unified, ergonomic interface.

---

## Decision: Why Single Doc?

We evaluated two approaches:

### Option A: Multiple Docs (Current Spec)

Separate Y.Docs for each table, plus shared docs for metadata and KV.

### Option B: Single Workspace Doc (This Spec)

All tables and KV in one Y.Doc with definitions separated from data.

### Key Factors in the Decision

| Factor                    | Multiple Docs                 | Single Doc                   | Winner |
| ------------------------- | ----------------------------- | ---------------------------- | ------ |
| Implementation simplicity | More plumbing                 | Simpler                      | Single |
| Atomic multi-table ops    | Requires two-phase pattern    | Native `transact()`          | Single |
| Mental model              | Multiple docs to track        | One doc, one mental model    | Single |
| Initial load time         | Load only what's needed       | Must load entire workspace   | Multi  |
| Memory usage              | Only open tables in memory    | All tables always in memory  | Multi  |
| Sync bandwidth            | Only relevant table changes   | All changes to all users     | Multi  |
| Mobile viability          | 0.5-0.8 MB per table = 10-15s | 10-16 MB doc = 2-3 min on 3G | Multi  |
| Corruption blast radius   | Only affected table           | Entire workspace at risk     | Multi  |

### When Single Doc Works Well

- Small to medium workspaces (< 10 tables, < 5000 total rows)
- Desktop-first applications
- Single-user or small team collaboration
- Prototyping and rapid development
- When atomic cross-table operations are common

### When to Consider Multi-Doc

- Large workspaces (> 50k rows)
- Mobile-first applications
- Many concurrent editors (> 5)
- When tables are accessed independently
- When blast radius isolation is critical

---

## Why Separated Internally, Unified API

The YJS document structure is **separated by change frequency** (definitions in one tree, data in another), but the **API presents a unified view**. This gives us the best of both worlds.

### Internal Structure: Optimized for Observation

```typescript
// INTERNAL: Two separate Y.Map trees
const defYMap = doc.getMap('definition').get('tables').get('posts');
const rowsYMap = doc.getMap('tables').get('posts');

// Clean observation - no filtering needed
defYMap.get('fields').observe(() => rebuildColumns()); // Schema only
rowsYMap.observeDeep(() => syncToSqlite()); // Data only
```

### API: Optimized for Ergonomics

```typescript
// EXTERNAL: Unified TableHelper bridges both trees (use explicit .get())
const posts = workspace.tables.get('posts');

// Everything about "posts" is RIGHT HERE
posts.name;                    // reads from definition.tables.posts.name
posts.icon;                    // reads from definition.tables.posts.icon
posts.fields.get('title');     // reads from definition.tables.posts.fields
posts.upsert({ id: '1', ... }); // writes to tables.posts

// One mental model: "I have a table, it has everything"
```

### Why This Works

The API hides the internal separation:

```typescript
function createTableHelper(tableId: string) {
	// Bridge the two Y.Map trees
	const defYMap = doc.getMap('definition').get('tables').get(tableId);
	const rowsYMap = doc.getMap('tables').get(tableId);

	return {
		// Definition access (from cold zone)
		get name() {
			return defYMap.get('name');
		},
		get fields() {
			return createFieldsHelper(defYMap.get('fields'));
		},

		// CRUD operations (from hot zone)
		upsert(row) {
			rowsYMap.set(row.id, toYMap(row));
		},
		get(key) {
			return rowsYMap.get(key.id)?.toJSON();
		},

		// Observation (precise attachment points)
		observeRows(cb) {
			return rowsYMap.observeDeep(cb);
		},
		observeFields(cb) {
			return defYMap.get('fields').observe(cb);
		},
		observe(cb) {
			return defYMap.observe(cb);
		}, // Just metadata
	};
}
```

### Benefits of This Approach

1. **API ergonomics**: Developers see one unified table helper
2. **Clean observation**: Observers attach to exactly what they need
3. **No filtering**: `observeRows` only fires for rows, never for schema
4. **Atomic operations**: Still one Y.Doc, so `transact()` works across both trees
5. **Different debounce strategies**: Sync definitions slowly, sync rows quickly

---

## Why Files Mirror the Three-Map Structure

The YJS structure (3 top-level maps) directly mirrors the file output:

| Y.Map        | File              | Content                      |
| ------------ | ----------------- | ---------------------------- |
| `definition` | `definition.json` | Workspace meta + all schemas |
| `tables`     | `tables.sqlite`   | Row data only                |
| `kv`         | `kv.json`         | KV values only               |

### Right Tool for the Job

| Data Type             | Best Storage | Why                                         |
| --------------------- | ------------ | ------------------------------------------- |
| Definitions (schemas) | JSON         | Human-readable, versionable, inspectable    |
| Row data              | SQLite       | Queryable, indexed, handles large datasets  |
| KV values             | JSON         | Tiny, loaded all at once, no queries needed |

### Debugging & Inspection

```bash
# "What's the schema?"
cat definition.json | jq .

# "What are the current settings?"
cat kv.json

# "How many posts?"
sqlite3 tables.sqlite "SELECT COUNT(*) FROM posts"
```

---

## Document Structure (Detailed)

```
┌─────────────────────────────────────────────────────────────────────────────┐
│  WORKSPACE DOC (guid: "ws-123")                                             │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│  Y.Map('definition')                   # COLD: Identity + all schemas       │
│    ├── name: "My Blog"                 # Workspace name                     │
│    ├── icon: "emoji:📝"                # Tagged string (see Icon Storage)   │
│    ├── description: "..."              # Workspace description              │
│    │                                                                        │
│    ├── tables: Y.Map                   # Table definitions                  │
│    │   └── {tableId}: Y.Map                                                 │
│    │       ├── name: "Posts"                                                │
│    │       ├── icon: "emoji:📝"                                             │
│    │       ├── description: "..."                                           │
│    │       └── fields: Y.Map                                                │
│    │           └── {fieldId}: Field                                         │
│    │               ├── type: "text"                                         │
│    │               ├── name: "Title"                                        │
│    │               ├── nullable: false                                      │
│    │               └── default: undefined                                   │
│    │                                                                        │
│    └── kv: Y.Map                       # KV definitions                     │
│        └── {key}: Y.Map                                                     │
│            ├── name: "Theme"                                                │
│            ├── icon: "emoji:🎨"                                             │
│            └── field: Field                                                 │
│                ├── type: "select"                                           │
│                ├── options: ["light", "dark"]                               │
│                └── default: "light"                                         │
│                                                                             │
│  Y.Map('tables')                       # HOT: Row data only                 │
│    └── {tableId}: Y.Map                # This IS the rows map               │
│        └── {rowId}: Y.Map              # Row data                           │
│            └── {fieldId}: value        # Cell value                         │
│                                                                             │
│  Y.Map('kv')                           # WARM: Values only                  │
│    └── {key}: value                    # Just the value, no definition      │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

## Design Decisions

### 1. Three Top-Level Maps

The workspace doc has exactly three top-level Y.Maps:

```typescript
doc.getMap('definition'); // Cold: workspace meta + all schemas
doc.getMap('tables'); // Hot: row data only
doc.getMap('kv'); // Warm: values only
```

**Why three maps:**

- **Maps to file output**: Each map becomes one file
- **Maps to change frequency**: Cold, warm, hot zones
- **Clean observation boundaries**: No filtering needed

### 2. Definitions Separated from Data

Table definitions live in `definition.tables`, while row data lives in `tables`:

```typescript
// Definition (cold)
const tableDef = doc.getMap('definition').get('tables').get(tableId);
const fields = tableDef.get('fields');

// Data (hot)
const rows = doc.getMap('tables').get(tableId);
```

**Why separate:**

- **Observation alignment**: Attach observers to exactly what you need
- **Change frequency**: Definitions change rarely, rows change constantly
- **Debounce strategies**: Sync definitions every 5s, sync rows every 100ms

### 3. KV Split: Definition vs Value

KV definitions live in `definition.kv`, while values live in `kv`:

```typescript
// Definition (cold)
const kvDef = doc.getMap('definition').get('kv').get('theme');
const field = kvDef.get('field'); // { type: 'select', options: [...] }

// Value (warm)
const value = doc.getMap('kv').get('theme'); // 'dark'
```

**Why:**

- Consistent with table pattern
- Values change more often than definitions
- Clean observation for "any setting changed"

### 4. Naming: "Field" Not "Schema"

Following the codebase convention established in the recent refactor:

| Term         | Meaning                                         |
| ------------ | ----------------------------------------------- |
| `Field`      | Raw type constraint (`{ type: 'text', ... }`)   |
| `Definition` | Metadata + Field(s)                             |
| `Schema`     | Reserved for full workspace or validation logic |

### 5. API Bridges the Separation

Despite internal separation, the API presents a unified view:

```typescript
const posts = workspace.tables.get('posts');

// These read from definition.tables.posts
posts.name;
posts.fields.get('title');

// These read/write from tables.posts
posts.upsert({ id: '1', title: 'Hello' });
posts.get({ id: '1' });
```

The developer doesn't need to know about the internal separation.

---

## Icon Storage

Icons are stored as **tagged strings** throughout the system. No encoding/decoding needed:

```typescript
// Tagged string format: "{type}:{value}"
type Icon = `emoji:${string}` | `lucide:${string}` | `url:${string}`;

// Examples
const emojiIcon: Icon = 'emoji:📝';
const lucideIcon: Icon = 'lucide:file-text';
const urlIcon: Icon = 'url:https://example.com/icon.png';
```

**Why tagged strings everywhere:**

1. **LWW-safe**: If icon were `{ type: 'emoji', value: '📝' }` as nested Y.Map, concurrent edits could create invalid states (e.g., `{ type: 'emoji', value: 'file-text' }`). With tagged strings, LWW produces a valid icon. One wins, but it's always coherent.

2. **No transformation layer**: The value in YJS is the same as the value in TypeScript. No encode/decode functions to maintain.

3. **Type-safe at compile time**: TypeScript template literal types catch invalid icons:

   ```typescript
   const bad: Icon = 'invalid:foo'; // Type error!
   const good: Icon = 'emoji:📝'; // OK
   ```

4. **Easy parsing when needed**: Simple string split for rendering:
   ```typescript
   const [type, value] = icon.split(':') as [
	'emoji' | 'lucide' | 'url',
	string,
   ];
   ```

---

## ID Strategy

| Entity    | Format                | Example             | Rationale                                      |
| --------- | --------------------- | ------------------- | ---------------------------------------------- |
| Workspace | User-provided or UUID | `ws-abc123`         | Human-readable when possible                   |
| Epoch     | Integer from 0        | `0`, `1`, `2`       | Simple incrementing version                    |
| Table     | UUID/ULID             | `tbl-550e8400`      | Prevents LWW on concurrent creation            |
| Row       | UUID/ULID             | `row-6ba7b810`      | Prevents LWW on concurrent creation            |
| Field     | Slug or UUID          | `title`, `fld-abc`  | Slugs for code-defined, UUIDs for user-created |
| KV Key    | Slug                  | `theme`, `fontSize` | Always code-defined                            |

---

## Persistence Strategy

### File Layout

```
workspace/
├── workspace.yjs          # Source of truth (full co-located Y.Doc)
│
├── definition.json        # Materialized: meta + table defs + kv defs
├── tables.sqlite          # Materialized: row data only
└── kv.json                # Materialized: kv values only
```

Or with epochs:

```
workspace/
├── head.yjs               # Epoch pointer (optional)
├── epochs/
│   ├── 0.yjs              # Epoch 0 workspace doc
│   └── 1.yjs              # Epoch 1 workspace doc
│
├── definition.json        # Materialized: current epoch definitions
├── tables.sqlite          # Materialized: current epoch row data
└── kv.json                # Materialized: current epoch kv values
```

### What Gets Written Where

| YJS Path                        | Materialized To   | Content               |
| ------------------------------- | ----------------- | --------------------- |
| `definition.name`               | `definition.json` | Workspace name        |
| `definition.icon`               | `definition.json` | Workspace icon        |
| `definition.description`        | `definition.json` | Workspace description |
| `definition.tables.{id}.*`      | `definition.json` | Table definitions     |
| `definition.tables.{id}.fields` | `definition.json` | Field definitions     |
| `definition.kv.{key}.*`         | `definition.json` | KV definitions        |
| `tables.{id}.{rowId}`           | `tables.sqlite`   | Row data              |
| `kv.{key}`                      | `kv.json`         | KV values             |

### definition.json

All definitions in one human-readable file:

```json
{
	"meta": {
		"name": "My Blog",
		"icon": "emoji:📝",
		"description": "Personal blog workspace"
	},
	"tables": {
		"posts": {
			"name": "Posts",
			"icon": "emoji:📄",
			"description": "Blog posts",
			"fields": {
				"id": { "type": "id" },
				"title": { "type": "text" },
				"published": { "type": "boolean", "default": false }
			}
		},
		"users": {
			"name": "Users",
			"icon": "lucide:user",
			"fields": {
				"id": { "type": "id" },
				"email": { "type": "text" }
			}
		}
	},
	"kv": {
		"theme": {
			"name": "Theme",
			"icon": "emoji:🎨",
			"field": {
				"type": "select",
				"options": ["light", "dark"],
				"default": "light"
			}
		},
		"fontSize": {
			"name": "Font Size",
			"field": { "type": "integer", "default": 14 }
		}
	}
}
```

### tables.sqlite

Row data only. One SQLite table per YJS table:

```sql
-- tables.sqlite

CREATE TABLE posts (
  id TEXT PRIMARY KEY,
  title TEXT,
  content TEXT,
  published INTEGER
);

CREATE TABLE users (
  id TEXT PRIMARY KEY,
  email TEXT,
  name TEXT
);
```

### kv.json

KV values only. Flat map:

```json
{
	"theme": "dark",
	"fontSize": 16
}
```

### Sync Strategy: Debounced Pull-Down

```typescript
const definitionYMap = doc.getMap('definition');
const tablesYMap = doc.getMap('tables');
const kvYMap = doc.getMap('kv');

// Different debounce for different change frequencies
definitionYMap.observeDeep(() => {
	debouncedSyncDefinition(); // 5000ms debounce (cold)
});

tablesYMap.observeDeep(() => {
	debouncedSyncTables(); // 100ms debounce (hot)
});

kvYMap.observe(() => {
	debouncedSyncKv(); // 500ms debounce (warm)
});

async function syncDefinition() {
	// definition.json = Y.Map('definition').toJSON()
	const definition = definitionYMap.toJSON();
	await writeFile('definition.json', JSON.stringify(definition, null, 2));
}

async function syncKv() {
	// kv.json = Y.Map('kv').toJSON()
	const kvValues = kvYMap.toJSON();
	await writeFile('kv.json', JSON.stringify(kvValues, null, 2));
}

async function syncTables() {
	// tables.sqlite = one table per Y.Map('tables') entry
	for (const [tableId, rowsYMap] of tablesYMap.entries()) {
		const rows = rowsYMap.toJSON();
		await db.run(`DROP TABLE IF EXISTS "${tableId}"`);
		await db.run(`CREATE TABLE "${tableId}" (...)`);
		for (const [rowId, row] of Object.entries(rows)) {
			await db.run(`INSERT INTO "${tableId}" ...`, { id: rowId, ...row });
		}
	}
}
```

**Why this approach:**

1. **Aligned with structure**: Each Y.Map maps to one file
2. **Different debounce per zone**: Hot data syncs fast, cold data syncs slow
3. **Simple**: `toJSON()` gives you exactly what you need
4. **Inspectable**: Can `cat` the JSON files, query SQLite directly

---

## TypeScript Types

```typescript
// ─────────────────────────────────────────────────────────────────────────────
// Icon Type (tagged string)
// ─────────────────────────────────────────────────────────────────────────────

/** Tagged string icon format. */
type Icon = `emoji:${string}` | `lucide:${string}` | `url:${string}`;

// ─────────────────────────────────────────────────────────────────────────────
// Top-Level Y.Map Types (3 maps)
// ─────────────────────────────────────────────────────────────────────────────

/** Y.Map('definition') - workspace identity + all schemas */
type DefinitionYMap = Y.Map<unknown>;

/** Y.Map('tables') - row data only, keyed by table ID */
type TablesYMap = Y.Map<RowsYMap>;

/** Y.Map('kv') - values only, keyed by key name */
type KvValuesYMap = Y.Map<unknown>;

// ─────────────────────────────────────────────────────────────────────────────
// Definition Sub-Types
// ─────────────────────────────────────────────────────────────────────────────

/** definition.tables - all table definitions */
type TableDefinitionsYMap = Y.Map<TableDefinitionYMap>;

/** definition.tables.{id} - single table definition */
type TableDefinitionYMap = Y.Map<unknown>;

/** definition.tables.{id}.fields - field definitions for a table */
type FieldsYMap = Y.Map<Field>;

/** definition.kv - all KV definitions */
type KvDefinitionsYMap = Y.Map<KvDefinitionYMap>;

/** definition.kv.{key} - single KV definition */
type KvDefinitionYMap = Y.Map<unknown>;

// ─────────────────────────────────────────────────────────────────────────────
// Data Sub-Types
// ─────────────────────────────────────────────────────────────────────────────

/** tables.{id} - rows for a single table */
type RowsYMap = Y.Map<RowYMap>;

/** tables.{id}.{rowId} - single row */
type RowYMap = Y.Map<unknown>;

// ─────────────────────────────────────────────────────────────────────────────
// Plain Object Types (for toJSON())
// ─────────────────────────────────────────────────────────────────────────────

/** definition.toJSON() */
type WorkspaceDefinition = {
	name: string;
	icon: Icon | null;
	description: string;
	tables: Record<string, TableDefinition>;
	kv: Record<string, KvDefinition>;
};

/** definition.tables.{id}.toJSON() */
type TableDefinition = {
	name: string;
	icon: Icon | null;
	description: string;
	fields: Record<string, Field>;
};

/** definition.kv.{key}.toJSON() */
type KvDefinition = {
	name: string;
	icon: Icon | null;
	field: KvField;
};
```

---

## API Design

The API presents a **unified view** despite the internal separation. Everything about a table is accessible from one helper.

### Workspace Access

```typescript
const workspace = createWorkspace({ id: 'ws-123' });

// Metadata (reads from definition.name, definition.icon, etc.)
workspace.name;                         // 'My Blog'
workspace.setName('New Name');
workspace.icon;                         // 'emoji:📝'
workspace.setIcon('lucide:book');

// Tables (use explicit .get() for access)
workspace.tables.get('posts');          // TableHelper | undefined
workspace.tables.keys();                // ['posts', 'users']
workspace.tables.has('posts');          // true
workspace.tables.create('comments', { name: 'Comments', fields: {...} });
workspace.tables.delete('oldTable');
```

### Table Access

```typescript
const posts = workspace.tables.get('posts');

// Metadata (reads from definition.tables.posts)
posts.name; // 'Posts'
posts.setName('Blog Posts');
posts.icon; // 'emoji:📝'
posts.setIcon('lucide:file-text');

// Fields (reads from definition.tables.posts.fields)
posts.fields.get('title'); // Field | undefined
posts.fields.set('dueDate', date());
posts.fields.delete('legacyField');
posts.fields.keys(); // ['id', 'title', 'content']

// CRUD (reads/writes from tables.posts)
posts.upsert({ id: '1', title: 'Hello' });
posts.get({ id: '1' }); // Row | undefined
posts.getAll(); // Row[]
posts.filter((r) => r.published); // Row[]
posts.delete({ id: '1' });
```

### KV Access

```typescript
// KV (use explicit .get() for access)
workspace.kv.get('theme'); // KvHelper | undefined
workspace.kv.keys(); // ['theme', 'fontSize']
workspace.kv.has('theme'); // true

// Single KV entry
const theme = workspace.kv.get('theme');
theme.name; // 'Theme' (from definition.kv.theme)
theme.field; // { type: 'select', ... } (from definition.kv.theme)
theme.value; // 'dark' (from kv.theme)

// Setting/observing KV values directly
workspace.kv.set('theme', 'light');
workspace.kv.observeKey('theme', () => applyTheme());
```

### Observation Patterns

The separated internal structure enables **precise observation**:

```typescript
const posts = workspace.tables.get('posts');

// Watch table metadata (name, icon, description)
// Internally: definition.tables.posts.observe()
posts.observe(() => {
	updateSidebarUI();
});

// Watch fields only (schema changes)
// Internally: definition.tables.posts.fields.observe()
posts.fields.observe((changes) => {
	rebuildTableColumns();
});

// Watch rows (data changes)
// Internally: tables.posts.observeDeep()
posts.observeRows((changes) => {
	syncToSQLite(changes);
});

// KV value changes
// Internally: kv.observe()
workspace.kv.observeKey('theme', () => {
	applyTheme();
});

// All definition changes (for persisting definition.json)
// Internally: definition.observeDeep()
workspace.observeDefinition(() => {
	debouncedWriteDefinitionJson();
});
```

**Key insight:** Because definitions and data are in separate Y.Map trees, `posts.observeRows()` ONLY fires for row changes. It never fires for name/icon/field changes. No filtering needed.

---

## Migration from Current Architecture

### What Changes

| Current                         | New (This Spec)                                  |
| ------------------------------- | ------------------------------------------------ |
| `Y.Map('definition')` (mixed)   | `Y.Map('definition')` (workspace meta + schemas) |
| `Y.Map('tables')` = rows + meta | `Y.Map('tables')` = rows only                    |
| `Y.Map('kv')` = values + meta   | `Y.Map('kv')` = values only                      |
| Head Doc for workspace identity | `definition.{name,icon,description}`             |
| Multiple docs per workspace     | Single doc per workspace                         |

### Migration Steps

1. **Create new doc** with three top-level maps
2. **Copy workspace meta** from Head Doc → `definition.{name,icon,description}`
3. **Copy table definitions** from `definition.tables` → `definition.tables`
4. **Copy table rows** from `tables.{name}` → `tables.{name}` (structure similar)
5. **Copy KV definitions** from `definition.kv` → `definition.kv`
6. **Copy KV values** from `kv` → `kv` (now just values, no definition)

### Backward Compatibility

The old structure and new structure are incompatible.
Migration requires a full data copy (epoch bump).

### Multi-Doc Future Path

If you later need to split into multiple Y.Docs:

```
WORKSPACE DOC (ws-123)           # Light: definitions only
├── definition                   # Already the right shape!

TABLE DOC (ws-123:posts)         # Heavy: data only
└── rows                         # Move tables.posts here
```

The separated structure makes this migration trivial.

---

## Open Questions

- [ ] **Field ordering**: Y.Array for order, or `order` field in each Field?
- [ ] **Row ordering**: Same question for user-defined row order
- [ ] **Compaction timing**: When to trigger epoch bump for doc size management?
- [ ] **Maximum workspace size**: At what point should we recommend multi-doc?

---

## References

- [Y.js Documentation](https://docs.yjs.dev/)
- [Multi-Doc Architecture Spec](./20260122T225052-subdoc-architecture.md)
- [Current workspace implementation](../../packages/epicenter/src/core/docs/workspace-doc.ts)
