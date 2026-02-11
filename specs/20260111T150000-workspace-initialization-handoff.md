# Handoff: Workspace Initialization & Rename-Safe Schema Architecture

## Executive Summary

**Problem**: The current workspace API has two issues:

1. `defineWorkspace()` requires all schema upfront, but apps need to read schema dynamically from Y.Doc
2. Tables/fields/rows are keyed by **names**, making renames break data

**Solution**:

1. Make `tables`, `kv`, `name`, and `slug` optional in `defineWorkspace()`. Only `id` is required.
2. Switch to **ID-based storage** internally: tables, fields, and row cells are all keyed by stable IDs
3. Add **display names** as separate metadata that users can freely rename
4. Provide a **unified API** using property chain access with TypeScript overloads

**Key Insight**: With ID-based storage, you never need "rename operations." Display names are just metadata; changing them doesn't touch any data.

---

## The Rename Problem (Current)

```
CURRENT: Names as Keys (BREAKS ON RENAME)
══════════════════════════════════════════

Schema Storage:                    Row Storage:
┌─────────────────────────────┐    ┌─────────────────────────────┐
│ 'tables': Y.Map             │    │ 'tables': Y.Map             │
│   └── 'posts': Y.Map        │    │   └── 'posts': Y.Map        │
│       └── 'fields': Y.Map   │    │       └── 'row-1': Y.Map    │
│           └── 'title': {...}│    │           └── 'title': "Hi" │
│           └── 'author':...  │    │           └── 'author': "Me"│
└─────────────────────────────┘    └─────────────────────────────┘
         ▲                                  ▲
         │                                  │
    Field NAME                         Field NAME
    as key                             as key

❌ RENAME 'title' → 'headline':
   - Must update schema key
   - Must update EVERY row's key
   - All existing code breaks
   - TypeScript types break
```

---

## The Solution: ID-Based Storage

```
PROPOSED: IDs as Keys (RENAME-SAFE)
═══════════════════════════════════

Schema Storage:                    Row Storage:
┌─────────────────────────────┐    ┌─────────────────────────────┐
│ 'schema': Y.Map             │    │ 'data': Y.Map               │
│   └── 'tbl_abc': Y.Map      │    │   └── 'tbl_abc': Y.Map      │
│       ├── codeKey: 'posts'  │    │       └── 'row-1': Y.Map    │
│       ├── displayName: ...  │    │           └── 'fld_1': "Hi" │
│       └── 'fields': Y.Map   │    │           └── 'fld_2': "Me" │
│           └── 'fld_1': Y.Map│    └─────────────────────────────┘
│               ├── codeKey:  │             ▲
│               │   'title'   │             │
│               ├── display:  │        Field ID
│               │   'Title'   │        as key
│               └── type:text │        (STABLE!)
└─────────────────────────────┘

✅ RENAME displayName 'Title' → 'Headline':
   - Just update displayName property
   - No row changes
   - No code changes
   - Data is untouched!
```

---

## Y.Doc Structure (Proposed)

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                    NEW Y.DOC STRUCTURE (ID-BASED)                           │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│   Y.Doc (guid: "{workspaceId}-{epoch}")                                     │
│   │                                                                         │
│   ├── 'meta': Y.Map                           ◄── WORKSPACE METADATA        │
│   │   ├── 'name': string                      // "My Blog"                  │
│   │   └── 'slug': string                      // "my-blog"                  │
│   │                                                                         │
│   ├── 'schema': Y.Map                         ◄── SCHEMA (ID-KEYED)         │
│   │   │                                                                     │
│   │   ├── 'tablesById': Y.Map<tableId, TableSchema>                         │
│   │   │   └── 'tbl_abc123': Y.Map                                           │
│   │   │       ├── 'codeKey': 'posts'          // TypeScript property name   │
│   │   │       ├── 'displayName': 'Posts'      // User-editable label        │
│   │   │       ├── 'description': '...'                                      │
│   │   │       ├── 'icon': { type: 'emoji', value: '📝' }                    │
│   │   │       ├── 'cover': null                                             │
│   │   │       │                                                             │
│   │   │       ├── 'fieldsById': Y.Map<fieldId, FieldSchema>                 │
│   │   │       │   └── 'fld_xyz789': Y.Map                                   │
│   │   │       │       ├── 'codeKey': 'title'  // TypeScript property name   │
│   │   │       │       ├── 'displayName': 'Title'  // User-editable label    │
│   │   │       │       ├── 'type': 'text'                                    │
│   │   │       │       ├── 'default': null                                   │
│   │   │       │       ├── 'description': '...'                              │
│   │   │       │       └── 'order': 0.5        // Fractional ordering        │
│   │   │       │                                                             │
│   │   │       └── 'indexes': Y.Map            // Fast lookups               │
│   │   │           └── 'codeKeyToFieldId': Y.Map                             │
│   │   │               └── 'title': 'fld_xyz789'                             │
│   │   │                                                                     │
│   │   └── 'indexes': Y.Map                    // Table-level indexes        │
│   │       └── 'codeKeyToTableId': Y.Map                                     │
│   │           └── 'posts': 'tbl_abc123'                                     │
│   │                                                                         │
│   ├── 'data': Y.Map                           ◄── ROW DATA (ID-KEYED)       │
│   │   └── 'tbl_abc123': Y.Map                 // Keyed by TABLE ID          │
│   │       └── 'row-uuid-1': Y.Map             // Keyed by ROW ID            │
│   │           └── 'fld_xyz789': "Hello"       // Keyed by FIELD ID          │
│   │           └── 'fld_def456': true                                        │
│   │                                                                         │
│   └── 'kv': Y.Map                             ◄── KV DATA                   │
│       └── 'kvk_theme123': Y.Map               // Keyed by KV KEY ID         │
│           ├── 'codeKey': 'theme'                                            │
│           ├── 'displayName': 'Theme'                                        │
│           ├── 'value': 'dark'                                               │
│           └── 'field': { type: 'text', ... }                                │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

## Three Types of "Name"

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                    THREE TYPES OF IDENTIFIERS                               │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│   ┌──────────────┬───────────────────────────────────────────────────────┐  │
│   │ Identifier   │ Purpose                                               │  │
│   ├──────────────┼───────────────────────────────────────────────────────┤  │
│   │              │                                                       │  │
│   │ ID           │ • Stable storage key (fld_xyz789, tbl_abc123)         │  │
│   │ (fieldId,    │ • Auto-generated, never changes                       │  │
│   │  tableId)    │ • Used in Y.Doc storage and row cells                 │  │
│   │              │ • Invisible to developers and users                   │  │
│   │              │                                                       │  │
│   ├──────────────┼───────────────────────────────────────────────────────┤  │
│   │              │                                                       │  │
│   │ codeKey      │ • TypeScript property name ('posts', 'title')         │  │
│   │              │ • Set by developer in schema definition               │  │
│   │              │ • Used in code: client.tables.posts.title             │  │
│   │              │ • Change via code refactor (not runtime operation)    │  │
│   │              │                                                       │  │
│   ├──────────────┼───────────────────────────────────────────────────────┤  │
│   │              │                                                       │  │
│   │ displayName  │ • User-visible label ('Posts', 'Title')               │  │
│   │              │ • Editable by users in UI                             │  │
│   │              │ • Change via setDisplayName() method                  │  │
│   │              │ • No impact on code or data storage                   │  │
│   │              │                                                       │  │
│   └──────────────┴───────────────────────────────────────────────────────┘  │
│                                                                             │
│   RENAME SCENARIOS:                                                         │
│   ════════════════                                                          │
│                                                                             │
│   User renames "Title" → "Headline" in UI:                                  │
│   • Just call: table.fields.title.setDisplayName('Headline')                │
│   • Data unchanged, code unchanged                                          │
│                                                                             │
│   Developer renames 'title' → 'headline' in code:                           │
│   • Refactor TypeScript code (normal code change)                           │
│   • Update codeKey in schema definition                                     │
│   • Data unchanged (stored by fieldId, not codeKey)                         │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

## Unified API Design

Based on analysis, **property chain with TypeScript overloads** provides the best DX:

```typescript
// ════════════════════════════════════════════════════════════════════════════
// TABLES API
// ════════════════════════════════════════════════════════════════════════════

client.tables.posts                    // TypedTableHelper<PostFields>
client.tables.posts.upsert({...})      // Fully typed row
client.tables.posts.get('row-id')      // Typed result
client.tables.posts.displayName        // "Posts" (getter)
client.tables.posts.setDisplayName('Blog Posts')  // Rename!

client.tables.posts.fields.title       // TypedFieldHelper
client.tables.posts.fields.title.displayName     // "Title"
client.tables.posts.fields.title.setDisplayName('Headline')

// Dynamic access (for runtime table names)
client.tables.get('posts')             // Same as client.tables.posts
client.tables.get('unknown')           // DynamicTableHelper (untyped)

// Introspection
client.tables.all()                    // All table helpers
client.tables.names()                  // ['posts', 'users', ...]
client.tables.schema                   // Full schema object

// Iteration
for (const table of client.tables.all()) {
  console.log(table.codeKey, table.displayName, table.count());
}

// ════════════════════════════════════════════════════════════════════════════
// KV API (same pattern)
// ════════════════════════════════════════════════════════════════════════════

client.kv.theme                        // TypedKvHelper
client.kv.theme.get()                  // 'dark'
client.kv.theme.set('light')
client.kv.theme.displayName            // "Theme"
client.kv.theme.setDisplayName('Color Scheme')

client.kv.get('theme')                 // Dynamic access
client.kv.all()                        // All KV helpers
client.kv.names()                      // ['theme', 'settings', ...]
```

---

## TypeScript Types

```typescript
// ════════════════════════════════════════════════════════════════════════════
// CORE TYPES
// ════════════════════════════════════════════════════════════════════════════

type TableHelper<TFields extends FieldSchemaMap, TCodeKey extends string> = {
	// Identity
	readonly id: string; // Stable table ID (tbl_abc123)
	readonly codeKey: TCodeKey; // TypeScript property name ('posts')

	// Metadata (live from Y.Doc)
	readonly displayName: string; // User-editable label
	setDisplayName(name: string): void;

	readonly description: string | null;
	setDescription(desc: string | null): void;

	readonly icon: IconDefinition | null;
	setIcon(icon: IconDefinition | null): void;

	// Schema
	readonly schema: TFields; // Field definitions
	readonly fields: FieldHelpers<TFields>; // Field helpers

	// CRUD (using codeKeys, internally resolved to fieldIds)
	upsert(row: Row<TFields>): void;
	get(id: string): GetResult<Row<TFields>>;
	getAll(): RowResult<Row<TFields>>[];
	getAllValid(): Row<TFields>[];
	update(patch: PartialRow<TFields>): UpdateResult;
	delete(id: string): DeleteResult;
	clear(): void;
	count(): number;

	// Query
	filter(predicate: (row: Row<TFields>) => boolean): Row<TFields>[];
	find(predicate: (row: Row<TFields>) => boolean): Row<TFields> | null;

	// Observe
	observeChanges(
		callback: (changes: Map<string, TableRowChange>) => void,
	): () => void;
};

type FieldHelper<TField extends FieldSchema, TCodeKey extends string> = {
	// Identity
	readonly id: string; // Stable field ID (fld_xyz789)
	readonly codeKey: TCodeKey; // TypeScript property name ('title')

	// Metadata (live from Y.Doc)
	readonly displayName: string; // User-editable label
	setDisplayName(name: string): void;

	readonly description: string | null;
	setDescription(desc: string | null): void;

	// Schema
	readonly type: string; // 'text', 'boolean', etc.
	readonly schema: TField; // Full field schema
	readonly order: number; // Display order
	setOrder(order: number): void;
};

// ════════════════════════════════════════════════════════════════════════════
// TABLES COLLECTION TYPE
// ════════════════════════════════════════════════════════════════════════════

type Tables<TTableDefs extends TableDefinitionMap> = {
	// Typed property access for known tables
	[K in keyof TTableDefs]: TableHelper<TTableDefs[K]['fields'], K & string>;
} & {
	// Dynamic access (returns typed if known, dynamic if unknown)
	get<K extends keyof TTableDefs | (string & {})>(
		codeKey: K,
	): K extends keyof TTableDefs
		? TableHelper<TTableDefs[K]['fields'], K & string>
		: DynamicTableHelper;

	// Introspection
	all(): TableHelper<any, string>[];
	names(): (keyof TTableDefs & string)[];
	schema: TTableDefs;
	has(codeKey: string): boolean;
	count(): number;
};
```

---

## How Row Data Flows

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                         ROW DATA FLOW                                       │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│   WRITE PATH:                                                               │
│   ═══════════                                                               │
│                                                                             │
│   Your code:                                                                │
│   ┌─────────────────────────────────────────────────────────────────────┐   │
│   │ client.tables.posts.upsert({                                        │   │
│   │   id: 'row-1',                                                      │   │
│   │   title: 'Hello',        // ← codeKey                               │   │
│   │   published: true,       // ← codeKey                               │   │
│   │ })                                                                  │   │
│   └─────────────────────────────────────────────────────────────────────┘   │
│                              │                                              │
│                              ▼                                              │
│   Mapping layer:  codeKey → fieldId                                         │
│                   'title' → 'fld_xyz789'                                    │
│                   'published' → 'fld_def456'                                │
│                              │                                              │
│                              ▼                                              │
│   Y.Doc storage:                                                            │
│   ┌─────────────────────────────────────────────────────────────────────┐   │
│   │ data['tbl_abc123']['row-1'] = {                                     │   │
│   │   'fld_xyz789': 'Hello',     // ← fieldId                           │   │
│   │   'fld_def456': true,        // ← fieldId                           │   │
│   │ }                                                                   │   │
│   └─────────────────────────────────────────────────────────────────────┘   │
│                                                                             │
│   ─────────────────────────────────────────────────────────────────────     │
│                                                                             │
│   READ PATH:                                                                │
│   ══════════                                                                │
│                                                                             │
│   Y.Doc storage:                                                            │
│   ┌─────────────────────────────────────────────────────────────────────┐   │
│   │ data['tbl_abc123']['row-1'] = {                                     │   │
│   │   'fld_xyz789': 'Hello',                                            │   │
│   │   'fld_def456': true,                                               │   │
│   │ }                                                                   │   │
│   └─────────────────────────────────────────────────────────────────────┘   │
│                              │                                              │
│                              ▼                                              │
│   Mapping layer:  fieldId → codeKey                                         │
│                   'fld_xyz789' → 'title'                                    │
│                   'fld_def456' → 'published'                                │
│                              │                                              │
│                              ▼                                              │
│   Your code:                                                                │
│   ┌─────────────────────────────────────────────────────────────────────┐   │
│   │ const post = client.tables.posts.get('row-1');                      │   │
│   │ if (post.status === 'valid') {                                      │   │
│   │   console.log(post.row.title);      // 'Hello' (codeKey access)     │   │
│   │   console.log(post.row.published);  // true (codeKey access)        │   │
│   │ }                                                                   │   │
│   └─────────────────────────────────────────────────────────────────────┘   │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

## JSON Export/Import Format

For export and import, use **name-centric format** for readability:

```json
{
	"format": "epicenter.workspace",
	"version": 1,
	"exportedAt": "2026-01-12T22:00:00.000Z",

	"workspace": {
		"id": "ws-abc123",
		"name": "My Blog",
		"slug": "my-blog"
	},

	"tables": {
		"posts": {
			"_id": "tbl_abc123",
			"displayName": "Posts",
			"description": "Blog posts and articles",
			"icon": { "type": "emoji", "value": "📝" },

			"fields": {
				"title": {
					"_id": "fld_xyz789",
					"displayName": "Title",
					"type": "text",
					"order": 0
				},
				"published": {
					"_id": "fld_def456",
					"displayName": "Published",
					"type": "boolean",
					"default": false,
					"order": 1
				}
			},

			"rows": [
				{ "id": "row-1", "title": "Hello World", "published": true },
				{ "id": "row-2", "title": "Draft Post", "published": false }
			]
		}
	},

	"kv": {
		"theme": {
			"_id": "kvk_theme123",
			"displayName": "Theme",
			"type": "text",
			"value": "dark"
		}
	}
}
```

**Import behavior**:

1. If `_id` matches existing entity → update (rename-safe)
2. If `_id` is new → create with that ID
3. If `_id` is missing → generate new ID, match by codeKey

---

## Two Modes of Operation

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                         TWO MODES OF OPERATION                              │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│   MODE 1: STATIC (Scripting, CLI, Tests)                                    │
│   ══════════════════════════════════════                                    │
│                                                                             │
│   const workspace = defineWorkspace({                                       │
│     id: 'blog-123',                                                         │
│     name: 'Blog',              ◄── Optional (initial value)                 │
│     slug: 'blog',              ◄── Optional (initial value)                 │
│     tables: {                  ◄── Provided → TypeScript infers types!      │
│       posts: {                                                              │
│         name: 'Posts',                                                      │
│         fields: {                                                           │
│           id: id(),                                                         │
│           title: text(),                                                    │
│           published: boolean(),                                             │
│         },                                                                  │
│       },                                                                    │
│     },                                                                      │
│     kv: {},                    ◄── Provided → TypeScript infers types!      │
│   });                                                                       │
│                                                                             │
│   const client = workspace.create();                                        │
│                                                                             │
│   // ✅ Full TypeScript inference                                           │
│   client.tables.posts.upsert({ id: '1', title: 'Hello', published: true }); │
│   client.tables.posts.setDisplayName('Blog Posts');                         │
│   client.tables.posts.fields.title.setDisplayName('Headline');              │
│                                                                             │
│   ─────────────────────────────────────────────────────────────────────     │
│                                                                             │
│   MODE 2: DYNAMIC (App, unknown schema at compile time)                     │
│   ═════════════════════════════════════════════════════                     │
│                                                                             │
│   const workspace = defineWorkspace({                                       │
│     id: 'blog-123',            ◄── Only id required                         │
│   });                                                                       │
│                                                                             │
│   const client = workspace.create({ ydoc: existingYdoc });                  │
│                                                                             │
│   // Dynamic access via .get()                                              │
│   client.tables.get('posts').upsert({ id: '1', title: 'Hello' });           │
│   client.tables.get('posts').setDisplayName('Blog Posts');                  │
│                                                                             │
│   // List what's available from Y.Doc                                       │
│   const tableNames = client.tables.names();  // ['posts', 'comments', ...]  │
│                                                                             │
│   for (const table of client.tables.all()) {                                │
│     console.log(table.codeKey, table.displayName);                          │
│   }                                                                         │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

## Implementation Checklist

### Phase 1: ID-Based Schema Storage

- [ ] Add `_id` field generation for tables (auto-generate on creation)
- [ ] Add `_id` field generation for fields (auto-generate on creation)
- [ ] Add `displayName` property to table schema
- [ ] Add `displayName` property to field schema
- [ ] Create indexes: `codeKeyToTableId`, `codeKeyToFieldId`
- [ ] Update `createDefinition()` to use new structure

### Phase 2: ID-Based Row Storage

- [ ] Update row storage to use fieldIds instead of codeKeys
- [ ] Create mapping layer: codeKey → fieldId (write path)
- [ ] Create mapping layer: fieldId → codeKey (read path)
- [ ] Update `TableHelper` to use mapping layer
- [ ] Ensure validation still works with codeKey-based schema

### Phase 3: Display Name API

- [ ] Add `displayName` getter to `TableHelper`
- [ ] Add `setDisplayName()` method to `TableHelper`
- [ ] Add `displayName` getter to `FieldHelper`
- [ ] Add `setDisplayName()` method to `FieldHelper`
- [ ] Add `displayName` getter/setter to `KvHelper`

### Phase 4: Unified Tables API

- [ ] Implement `client.tables.get(codeKey)` with TypeScript overloads
- [ ] Implement `client.tables.all()`
- [ ] Implement `client.tables.names()`
- [ ] Implement `client.tables.schema`
- [ ] Add `client.tables.posts.fields` property for field helpers
- [ ] Remove `$` prefix from utility methods

### Phase 5: Migration from Current Structure

- [ ] Create migration function: name-keyed → ID-keyed
- [ ] Handle existing Y.Docs gracefully (detect old format, migrate)
- [ ] Update tests for new structure
- [ ] Update JSON export/import to include `_id` fields

---

## Files to Modify

```
packages/epicenter/src/core/
├── workspace/
│   ├── workspace.ts           # Update Y.Doc structure, add ID generation
│   ├── definition.ts          # NEW: Separate definition helper with IDs
│   └── migration.ts           # NEW: Migrate old Y.Doc format to new
│
├── schema/
│   ├── types.ts               # Add _id, displayName to schema types
│   └── id-generator.ts        # NEW: Stable ID generation (tbl_xxx, fld_xxx)
│
├── tables/
│   ├── create-tables.ts       # Update to use ID-based storage
│   ├── table-helper.ts        # Add displayName, setDisplayName, mapping layer
│   ├── field-helper.ts        # NEW: Field-level helper with displayName
│   └── row-mapper.ts          # NEW: codeKey ↔ fieldId mapping
│
└── kv/
    ├── core.ts                # Update to use ID-based storage
    └── kv-helper.ts           # Add displayName, setDisplayName
```

---

## Key Design Decisions

### 1. IDs are Internal, codeKeys are External

Developers never see or use `tbl_abc123` or `fld_xyz789`. They always use `posts` and `title`. The IDs exist purely for rename-safe storage.

### 2. codeKey is Set in Code, Not Runtime

The `codeKey` is determined by the schema definition in your TypeScript code. It's not a runtime-editable property. To "rename" a codeKey, you refactor your code.

### 3. displayName is the Only Rename Operation

The only runtime rename operation is `setDisplayName()`. This changes what users see in the UI but has zero impact on code or data.

### 4. JSON Export Uses codeKeys (Human Readable)

Export format uses codeKeys (`posts`, `title`) not IDs (`tbl_abc`, `fld_xyz`) for maximum readability. IDs are included as `_id` for round-trip safety.

### 5. Unified API with TypeScript Overloads

Both `client.tables.posts` (typed) and `client.tables.get('dynamic')` (dynamic) work. TypeScript overloads return the appropriate type.

---

## Summary for Next Agent

**You're implementing a rename-safe workspace architecture:**

1. **Switch to ID-based storage**:
   - Tables keyed by tableId (not table name)
   - Fields keyed by fieldId (not field name)
   - Row cells keyed by fieldId (not field name)

2. **Add displayName as separate metadata**:
   - `displayName` property on tables, fields, and KV entries
   - `setDisplayName()` method for user renames
   - No data migration needed for renames

3. **Create mapping layer**:
   - codeKey → ID mapping for writes
   - ID → codeKey mapping for reads
   - Indexes maintained in Y.Doc for fast lookups

4. **Unified API**:
   - Property chain: `client.tables.posts.upsert({...})`
   - Dynamic access: `client.tables.get('posts').upsert({...})`
   - Remove `$` prefix from utility methods

**The key insight**: With ID-based storage, you never need complex rename operations. Display names are just metadata that users can freely change without affecting code or data.
