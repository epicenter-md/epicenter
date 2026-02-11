# Simplified Workspace Architecture

## Overview

Two ways to work with workspaces:

| Function          | Use Case                               | Schema Source   | TypeScript Types   |
| ----------------- | -------------------------------------- | --------------- | ------------------ |
| `defineWorkspace` | Developer builds app with known schema | Code (static)   | Full inference     |
| `loadWorkspace`   | App loads user-created workspace       | Y.Doc (dynamic) | None (dynamic API) |

---

## Y.Doc Structure

Both functions use the same Y.Doc structure:

```
Y.Doc (guid: "{workspaceId}-{epoch}")
│
├── 'meta': Y.Map
│   ├── 'name': string                    // "My Blog"
│   └── 'slug': string                    // "blog"
│
├── 'schema': Y.Map
│   ├── 'tables': Y.Map<tableId, TableSchema>
│   │   └── 'posts': Y.Map
│   │       ├── 'name': 'Blog Posts'
│   │       ├── 'description': '...'
│   │       ├── 'icon': { type: 'emoji', value: '📝' }
│   │       ├── 'cover': null
│   │       └── 'fields': Y.Map<fieldId, FieldSchema>
│   │           └── 'title': { name: 'Title', type: 'text', ... }
│   │
│   └── 'kv': Y.Map<kvId, KvSchema>
│       └── 'theme': { name: 'Theme', field: { type: 'select', ... } }
│
├── 'data': Y.Map
│   └── 'posts': Y.Map
│       └── 'row-uuid-1': { title: "Hello", published: true }
│
└── 'kv': Y.Map
    └── 'theme': 'dark'
```

---

## Two Identifiers Per Entity

| Identifier | Description                        | Mutability             |
| ---------- | ---------------------------------- | ---------------------- |
| **id**     | Storage key, used in code and URLs | Immutable within epoch |
| **name**   | User-visible label                 | Freely editable        |

**ID formats:**

| Source            | Format            | Example                   |
| ----------------- | ----------------- | ------------------------- |
| Developer-defined | Meaningful word   | `posts`, `title`, `theme` |
| User-created      | nanoid (10 chars) | `k7x9m2p4q8`              |

No prefixes needed; meaningful words vs random strings are visually distinct.

---

## `defineWorkspace` — Static Schema

For developers building apps with known table structures.

### API

```typescript
const workspace = defineWorkspace({
	id: 'abc123xyz789', // required: workspace GUID
	slug: 'blog', // required: URL-friendly identifier
	name: 'My Blog', // required: display name
	tables: {
		// optional: table definitions
		posts: table({
			name: 'Blog Posts',
			icon: '📝',
			fields: {
				id: id(),
				title: text({ name: 'Article Title' }),
				published: boolean({ default: false }),
			},
		}),
	},
	kv: {
		// optional: KV definitions
		theme: setting({
			name: 'Color Theme',
			field: select({ options: ['light', 'dark'] }),
		}),
	},
});

// Create client (sync construction)
const client = workspace.create({
	epoch: 0,
	capabilities: { sqlite, persistence },
});

// Fully typed API
client.tables.posts.upsert({ id: '1', title: 'Hello', published: false });
client.kv.theme.set('dark');

await client.whenSynced;
```

### Behavior

1. Create Y.Doc with guid `{id}-{epoch}`
2. Write definition to Y.Doc (`meta`, `schema`)
3. Create typed table/kv helpers
4. Start capabilities (persistence, sqlite, etc.)
5. Return client immediately (sync construction)

**Schema source:** Code is truth. Definition writes to Y.Doc.

### Helper Functions

Two equivalent styles:

**Inline JSON (verbose):**

```typescript
tables: {
  posts: {
    name: 'Blog Posts',
    icon: { type: 'emoji', value: '📝' },
    cover: null,
    description: 'Blog posts',
    fields: {
      id: id(),
      title: text({ name: 'Title' }),
    },
  },
}
```

**Helper functions (concise):**

```typescript
tables: {
  posts: table({
    name: 'Blog Posts',
    icon: '📝',  // shorthand
    fields: {
      id: id(),
      title: text({ name: 'Title' }),
    },
  }),
}
```

Both produce identical shapes. Helpers provide defaults and convenience.

---

## `loadWorkspace` — Dynamic Schema

For apps like Epicenter where users create tables at runtime.

### API

```typescript
// Load workspace by ID only
const client = await loadWorkspace({
	id: 'abc123xyz789', // required: workspace GUID
	epoch: 0, // optional: defaults to 0
	capabilities: {
		// optional: capabilities to attach
		sqlite,
		persistence,
	},
});

// Dynamic API (no static types)
const tables = client.schema.tables.list();
const posts = client.tables.get('posts');
posts?.upsert({ id: '1', title: 'Hello' });

// Read metadata from Y.Doc
console.log(client.name); // from Y.Doc meta
console.log(client.slug); // from Y.Doc meta
```

### Behavior

1. Create Y.Doc with guid `{id}-{epoch}`
2. Start capabilities (persistence loads data)
3. Wait for sync (`await` is required)
4. Schema discovered from Y.Doc
5. Return client with dynamic API

**Schema source:** Y.Doc is truth. No code schema.

### Dynamic Table Operations

```typescript
// List all tables
const tables = client.schema.tables.list();
// Returns: [{ id: 'posts', name: 'Blog Posts', ... }, ...]

// Get table by ID
const posts = client.tables.get('posts');

// Create table at runtime
const tableId = generateTableId(); // "k7x9m2p4q8"
client.schema.tables.create({
	id: tableId,
	name: 'Shopping List',
	fields: {
		id: id(),
		item: text({ name: 'Item' }),
		done: boolean({ name: 'Done', default: false }),
	},
});

// Update table name
client.schema.tables.get('posts').setName('Articles');

// Create field at runtime
const fieldId = generateFieldId();
client.schema.tables.get('posts').fields.create({
	id: fieldId,
	name: 'Category',
	type: 'select',
	options: ['tech', 'personal'],
});
```

---

## Comparison

| Aspect           | `defineWorkspace`          | `loadWorkspace`              |
| ---------------- | -------------------------- | ---------------------------- |
| Schema source    | Code (definition)          | Y.Doc                        |
| TypeScript types | Full inference             | Dynamic/untyped              |
| `id`             | Required                   | Required                     |
| `slug`, `name`   | Required                   | From Y.Doc                   |
| `tables`, `kv`   | From definition            | From Y.Doc                   |
| Construction     | Sync (returns immediately) | Async (must await)           |
| Primary use      | Developer-built apps       | Notion-like apps             |
| Table access     | `client.tables.posts`      | `client.tables.get('posts')` |

---

## Rename Safety

Both functions use the same rename-safe model:

| What Changes          | Impact                   | Migration? |
| --------------------- | ------------------------ | ---------- |
| User edits `name`     | Zero                     | No         |
| Dev/user changes `id` | Requires epoch migration | Yes        |

**Within an epoch:** IDs are immutable, names are freely editable.

**Across epochs:** Full migration via epoch system.

---

## Export/Import Format

Human-readable JSON (same for both):

```json
{
	"format": "epicenter.workspace",
	"version": 1,

	"workspace": {
		"id": "abc123xyz789",
		"name": "My Blog",
		"slug": "blog"
	},

	"schema": {
		"tables": {
			"posts": {
				"name": "Blog Posts",
				"icon": { "type": "emoji", "value": "📝" },
				"fields": {
					"id": { "name": "ID", "type": "id" },
					"title": { "name": "Title", "type": "text" }
				}
			}
		},
		"kv": {
			"theme": {
				"name": "Theme",
				"field": { "type": "select", "options": ["light", "dark"] }
			}
		}
	},

	"data": {
		"posts": [{ "id": "row-1", "title": "Hello World", "published": true }]
	},

	"kv": {
		"theme": "dark"
	}
}
```

---

## Implementation Checklist

### Phase 1: Y.Doc Structure

- [ ] Split `'definition'` map into `'meta'` + `'schema'`
- [ ] Update `createDefinition()` to use new structure
- [ ] Migrate existing workspaces on load

### Phase 2: `defineWorkspace` Updates

- [ ] Implement `table()` helper with icon shorthand
- [ ] Implement `setting()` helper for KV
- [ ] Keep current sync construction pattern
- [ ] Ensure definition writes to Y.Doc before capabilities start

### Phase 3: `loadWorkspace` Implementation

- [ ] New function that only takes `id`, `epoch`, `capabilities`
- [ ] Async construction (must await)
- [ ] Dynamic table API (`client.tables.get(id)`)
- [ ] Schema discovery from Y.Doc

### Phase 4: Dynamic Schema API

- [ ] `client.schema.tables.list()` — enumerate tables
- [ ] `client.schema.tables.create({ id, name, fields })` — create table
- [ ] `client.schema.tables.get(id).setName(name)` — rename
- [ ] `client.schema.tables.get(id).fields.create(...)` — add field
- [ ] Same pattern for KV

### Phase 5: ID Generation

- [ ] Use existing `generateTableId()`, `generateFieldId()`, `generateKvKeyId()`
- [ ] No prefixes (nanoid vs meaningful words are distinct)

---

## Summary

| Function          | Schema Source | Types   | Required Params      |
| ----------------- | ------------- | ------- | -------------------- |
| `defineWorkspace` | Code → Y.Doc  | Static  | `id`, `slug`, `name` |
| `loadWorkspace`   | Y.Doc         | Dynamic | `id` only            |

**Key benefits:**

- Clear separation of concerns
- No complex merge logic
- Each function does one thing well
- Y.Doc structure is human-readable
- Rename-safe via id/name separation
