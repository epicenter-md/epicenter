---
name: workspace-api
description: Workspace API patterns for defineTable, defineKv, versioning, and migrations. Use when defining workspace schemas, adding versions to existing tables, or writing migration functions.
metadata:
  author: epicenter
  version: '4.0'
---

# Workspace API

Type-safe schema definitions for tables and KV stores.

> **Related Skills**: See `yjs` for Yjs CRDT patterns and shared types.

## When to Apply This Skill

- Defining a new table or KV store with `defineTable()` or `defineKv()`
- Adding a new version to an existing table definition
- Writing table migration functions

## Tables

### Shorthand (Single Version)

Use when a table has only one version:

```typescript
import { defineTable } from '@epicenter/workspace';
import { type } from 'arktype';

const usersTable = defineTable(type({ id: UserId, email: 'string', _v: '1' }));
export type User = InferTableRow<typeof usersTable>;
```

Every table schema must include `_v` with a number literal. The type system enforces this — passing a schema without `_v` to `defineTable()` is a compile error.

### Builder (Multiple Versions)

Use when you need to evolve a schema over time:

```typescript
const posts = defineTable()
	.version(type({ id: 'string', title: 'string', _v: '1' }))
	.version(type({ id: 'string', title: 'string', views: 'number', _v: '2' }))
	.migrate((row) => {
		switch (row._v) {
			case 1:
				return { ...row, views: 0, _v: 2 };
			case 2:
				return row;
		}
	});
```

## KV Stores

KV stores use `defineKv(schema, defaultValue)`. No versioning, no migration—invalid stored data falls back to the default.

```typescript
import { defineKv } from '@epicenter/workspace';
import { type } from 'arktype';

const sidebar = defineKv(type({ collapsed: 'boolean', width: 'number' }), { collapsed: false, width: 300 });
const fontSize = defineKv(type('number'), 14);
const enabled = defineKv(type('boolean'), true);
```

### KV Design Convention: One Scalar Per Key

Use dot-namespaced keys for logical groupings of scalar values:

```typescript
// ✅ Correct — each preference is an independent scalar
'theme.mode': defineKv(type("'light' | 'dark' | 'system'"), 'light'),
'theme.fontSize': defineKv(type('number'), 14),

// ❌ Wrong — structured object invites migration needs
'theme': defineKv(type({ mode: "'light' | 'dark'", fontSize: 'number' }), { mode: 'light', fontSize: 14 }),
```

With scalar values, schema changes either don't break validation (widening `'light' | 'dark'` to `'light' | 'dark' | 'system'` still validates old data) or the default fallback is acceptable (resetting a toggle takes one click).

Exception: discriminated unions and `Record<string, T> | null` are acceptable when they represent a single atomic value.

## Branded Table IDs (Required)

Every table's `id` field and every string foreign key field MUST use a branded type instead of plain `'string'`. This prevents accidental mixing of IDs from different tables at compile time.

### Pattern

Define a branded type + arktype validator + generator in the same file as the workspace definition:

```typescript
import type { Brand } from 'wellcrafted/brand';
import { type } from 'arktype';
import { generateId, type Id } from '@epicenter/workspace';

// 1. Branded type + arktype validator (co-located with workspace definition)
export type ConversationId = Id & Brand<'ConversationId'>;
export const ConversationId = type('string').as<ConversationId>();

// 2. Generator function — the ONLY place with the cast
export const generateConversationId = (): ConversationId =>
	generateId() as ConversationId;

// 3. Use in defineTable + co-locate type export
const conversationsTable = defineTable(
	type({
		id: ConversationId,              // Primary key — branded
		title: 'string',
		'parentId?': ConversationId.or('undefined'),  // Self-referencing FK
		_v: '1',
	}),
);
export type Conversation = InferTableRow<typeof conversationsTable>;

// 4. At call sites — use the generator, never cast directly
const newId = generateConversationId();  // Good
// const newId = generateId() as string as ConversationId;  // Bad
```

### Rules

1. **Every table gets its own ID type**: `DeviceId`, `SavedTabId`, `ConversationId`, `ChatMessageId`, etc.
2. **Foreign keys use the referenced table's ID type**: `chatMessages.conversationId` uses `ConversationId`, not `'string'`
3. **Optional FKs use `.or('undefined')`**: `'parentId?': ConversationId.or('undefined')`
4. **Composite IDs are also branded**: `TabCompositeId`, `WindowCompositeId`, `GroupCompositeId`
5. **Use generator functions**: When IDs are generated at runtime, use a `generate*` factory: `generateConversationId()`. Never scatter double-casts across call sites.
6. **Functions accept branded types**: `function switchConversation(id: ConversationId)` not `(id: string)`

### Why Not Plain `'string'`

```typescript
// BAD: Nothing prevents mixing conversation IDs with message IDs
function deleteConversation(id: string) { ... }
deleteConversation(message.id);  // Compiles! Silent bug.

// GOOD: Compiler catches the mistake
function deleteConversation(id: ConversationId) { ... }
deleteConversation(message.id);  // Error: ChatMessageId is not ConversationId
```

### Reference Implementation

See `apps/tab-manager/src/lib/workspace.ts` for the canonical example with 7 branded ID types and 4 generator functions.
See `packages/filesystem/src/ids.ts` for the reference factory pattern (`generateRowId`, `generateColumnId`, `generateFileId`).
See `specs/20260312T180000-branded-id-convention.md` for the full inventory and migration plan.

## Workspace File Structure

A workspace file has two layers:

1. **Table definitions with co-located types** — `defineTable(schema)` as standalone consts, each immediately followed by `export type = InferTableRow<typeof table>`
2. **`createWorkspace(defineWorkspace({...}))` call** — composes pre-built tables into the client

### Pattern

```typescript
import {
	createWorkspace,
	defineTable,
	defineWorkspace,
	type InferTableRow,
} from '@epicenter/workspace';

// ─── Tables (each followed by its type export) ──────────────────────────

const usersTable = defineTable(
	type({
		id: UserId,
		email: 'string',
		_v: '1',
	}),
);
export type User = InferTableRow<typeof usersTable>;

const postsTable = defineTable(
	type({
		id: PostId,
		authorId: UserId,
		title: 'string',
		_v: '1',
	}),
);
export type Post = InferTableRow<typeof postsTable>;

// ─── Workspace client ───────────────────────────────────────────────────

export const workspaceClient = createWorkspace(
	defineWorkspace({
		id: 'my-workspace',
		tables: {
			users: usersTable,
			posts: postsTable,
		},
	}),
);
```

### Why This Structure

- **Co-located types**: Each `export type` sits right below its `defineTable` — easy to verify 1:1 correspondence, easy to remove both together.
- **Error co-location**: If you forget `_v` or `id`, the error shows on the `defineTable()` call right next to the schema — not buried inside `defineWorkspace`.
- **Schema-agnostic inference**: `InferTableRow` works with any Standard Schema (arktype, zod, etc.) and handles migrations correctly (always infers the latest version's type).
- **Fast type inference**: `InferTableRow<typeof usersTable>` resolves against a standalone const. Avoids the expensive `InferTableRow<NonNullable<(typeof definition)['tables']>['key']>` chain that forces TS to resolve the entire `defineWorkspace` return type.
- **No intermediate `definition` const**: `defineWorkspace({...})` is inlined directly into `createWorkspace()` since it's only used once.

### Anti-Pattern: Inline Tables + Deep Indirection

```typescript
// BAD: Tables inline in defineWorkspace, types derived through deep indirection
const definition = defineWorkspace({
	tables: {
		users: defineTable(type({ id: 'string', email: 'string', _v: '1' })),
	},
});
type Tables = NonNullable<(typeof definition)['tables']>;
export type User = InferTableRow<Tables['users']>;

// GOOD: Extract table, co-locate type, inline defineWorkspace
const usersTable = defineTable(type({ id: UserId, email: 'string', _v: '1' }));
export type User = InferTableRow<typeof usersTable>;

export const workspaceClient = createWorkspace(
	defineWorkspace({ tables: { users: usersTable } }),
);
```

## The `_v` Convention

- `_v` is a **number** discriminant field (`'1'` in arktype = the literal number `1`)
- **Required for tables** — enforced at the type level via `CombinedStandardSchema<{ id: string; _v: number }>`
- **Not used by KV stores** — KV has no versioning; `defineKv(schema, defaultValue)` is the only pattern
- In arktype schemas: `_v: '1'`, `_v: '2'`, `_v: '3'` (number literals)
- In migration returns: `_v: 2` (TypeScript narrows automatically, `as const` is unnecessary)
- Convention: `_v` goes last in the object (`{ id, ...fields, _v: '1' }`)

## Table Migration Function Rules

1. Input type is a union of all version outputs
2. Return type is the latest version output
3. Use `switch (row._v)` for discrimination (tables always have `_v`)
4. Final case returns `row` as-is (already latest)
5. Always migrate directly to latest (not incrementally through each version)

## Table Anti-Patterns

### Incremental migration (v1 -> v2 -> v3)

```typescript
// BAD: Chains through each version
.migrate((row) => {
  let current = row;
  if (current._v === 1) current = { ...current, views: 0, _v: 2 };
  if (current._v === 2) current = { ...current, tags: [], _v: 3 };
  return current;
})

// GOOD: Migrate directly to latest
.migrate((row) => {
  switch (row._v) {
    case 1: return { ...row, views: 0, tags: [], _v: 3 };
    case 2: return { ...row, tags: [], _v: 3 };
    case 3: return row;
  }
})
```

### Note: `as const` is unnecessary

TypeScript contextually narrows `_v: 2` to the literal type based on the return type constraint. Both of these work:

```typescript
return { ...row, views: 0, _v: 2 }; // Works — contextual narrowing
return { ...row, views: 0, _v: 2 as const }; // Also works — redundant
```

## Document Content (Per-Row Y.Docs)

Tables with `.withDocument()` create a content Y.Doc per row. Content is stored using a **timeline model**: a `Y.Array('timeline')` inside the Y.Doc, where each entry is a typed `Y.Map` supporting text, richtext, and sheet modes.

### Reading and Writing Content

Use `handle.read()`/`handle.write()` on the document handle:

```typescript
const handle = await documents.open(fileId);

// Read content (timeline-backed)
const text = handle.read();

// Write content (timeline-backed)
handle.write('hello');

// Editor binding — Y.Text (converts from other modes if needed)
const ytext = handle.asText();

// Richtext editor binding — Y.XmlFragment (converts if needed)
const fragment = handle.asRichText();

// Spreadsheet binding — SheetBinding (converts if needed)
const { columns, rows } = handle.asSheet();

// Current content mode
handle.mode; // 'text' | 'richtext' | 'sheet' | undefined

// Advanced timeline operations
const tl = handle.timeline;
```

For filesystem operations, `fs.content.read(fileId)` and `fs.content.write(fileId, data)` open the handle and delegate to these methods internally.

### Batching Mutations

Use `handle.batch()` to group multiple mutations into a single Yjs transaction:

```typescript
handle.batch(() => {
  handle.write('hello');
  // ...other mutations
});
```

**Do NOT call `handle.ydoc.transact()` directly.** Use `handle.batch()` instead.

### Anti-Patterns

**Do not access `handle.ydoc` for content operations:**

```typescript
// ❌ BAD: bypasses timeline abstraction
const ytext = handle.ydoc.getText('content');
handle.ydoc.transact(() => { ... });

// ✅ GOOD: use handle methods
const ytext = handle.asText();
const fragment = handle.asRichText();
handle.batch(() => { ... });
```

`handle.ydoc` is an **escape hatch** for document extensions (persistence, sync providers) and tests. App code should never need it.

## References

- `packages/workspace/src/workspace/define-table.ts`
- `packages/workspace/src/workspace/define-kv.ts`
- `packages/workspace/src/workspace/index.ts`
- `packages/workspace/src/workspace/create-tables.ts`
- `packages/workspace/src/workspace/create-kv.ts`
