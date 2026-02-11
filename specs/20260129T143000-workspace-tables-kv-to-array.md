# Refactor: defineWorkspace tables/kv from Record to Array

**Status**: Partially Complete (Scope Reduced)
**Created**: 2026-01-29
**Depends on**: 20260129T000000-fields-record-to-array.md (completed)

## Decision Summary

Convert `defineWorkspace({ tables, kv })` from `Record<string, T>` to `T[]` (array) for consistency with `TableDefinition.fields` which is now an array.

**Key decisions:**

1. **Array all the way down** - tables, kv, and fields are all arrays
2. **Remove setting() wrapper** - KV fields have id/name/icon built-in, no wrapper needed
3. **Remove TableDefinitionMap/KvDefinitionMap** - Use `TableDefinition[]` and `KvField[]` directly
4. **Deprecate defineWorkspace v1** - Keep backward compat via separate function or overload

## Problem Statement

After converting `TableDefinition.fields` to array, there's now an inconsistency:

```typescript
defineWorkspace({
  tables: {                                          // ← Record (inconsistent)
    posts: table('posts', { ... }),                  // ← key 'posts' duplicates table.id
  },
  kv: {                                              // ← Record (inconsistent)
    theme: setting({ field: select('theme', ...) }), // ← key 'theme' duplicates field.id
  },
});
```

**Issues:**

1. `tables` and `kv` use Records while `fields` uses Array
2. Keys are redundant with the object's `id` property
3. `setting()` wrapper adds no value - KV fields already have id/name/icon
4. Record key order isn't guaranteed by JSON spec

## Current vs Proposed

### TypeScript Definition

**Current (v1):**

```typescript
defineWorkspace({
	tables: {
		posts: table('posts', { name: 'Posts', fields: [id(), text('title')] }),
		users: table('users', { name: 'Users', fields: [id(), text('name')] }),
	},
	kv: {
		theme: setting({
			name: 'Theme',
			field: select('theme', { options: ['light', 'dark'] }),
		}),
		fontSize: setting({
			name: 'Font Size',
			field: integer('fontSize', { default: 14 }),
		}),
	},
});
```

**Proposed (v2):**

```typescript
defineWorkspace({
	tables: [
		table('posts', { name: 'Posts', fields: [id(), text('title')] }),
		table('users', { name: 'Users', fields: [id(), text('name')] }),
	],
	kv: [
		select('theme', { name: 'Theme', options: ['light', 'dark'] }),
		integer('fontSize', { name: 'Font Size', default: 14 }),
	],
});
```

### JSON Serialization

**Current:**

```json
{
  "tables": {
    "posts": { "id": "posts", "name": "Posts", "fields": [...] },
    "users": { "id": "users", "name": "Users", "fields": [...] }
  },
  "kv": {
    "theme": { "name": "Theme", "field": { "id": "theme", "type": "select", ... } }
  }
}
```

**Proposed:**

```json
{
  "tables": [
    { "id": "posts", "name": "Posts", "fields": [...] },
    { "id": "users", "name": "Users", "fields": [...] }
  ],
  "kv": [
    { "id": "theme", "name": "Theme", "type": "select", ... },
    { "id": "fontSize", "name": "Font Size", "type": "integer", "default": 14 }
  ]
}
```

## Type System Changes

### Before

```typescript
type WorkspaceDefinition<
	TTableDefinitionMap extends TableDefinitionMap = TableDefinitionMap,
	TKvDefinitionMap extends KvDefinitionMap = KvDefinitionMap,
> = {
	name: string;
	description: string;
	icon: Icon | null;
	tables: TTableDefinitionMap; // Record<string, TableDefinition>
	kv: TKvDefinitionMap; // Record<string, KvDefinition>
};

type KvDefinition<TField extends KvField = KvField> = {
	name: string;
	icon: Icon | null;
	description: string;
	field: TField; // Wrapper around the field
};
```

### After

```typescript
type WorkspaceDefinition<
	TTables extends readonly TableDefinition[] = readonly TableDefinition[],
	TKv extends readonly KvField[] = readonly KvField[],
> = {
	name: string;
	description: string;
	icon: Icon | null;
	tables: TTables; // TableDefinition[] directly
	kv: TKv; // KvField[] directly (no wrapper!)
};

// KvDefinition wrapper is REMOVED - KvField already has id, name, icon, description
```

### Type Utilities

```typescript
// Get table by id (replaces bracket access)
type TableById<
	TTables extends readonly TableDefinition[],
	K extends string,
> = Extract<TTables[number], { id: K }>;

// Get KV field by id (replaces bracket access)
type KvFieldById<TKv extends readonly KvField[], K extends string> = Extract<
	TKv[number],
	{ id: K }
>;

// Get all table ids
type TableIds<TTables extends readonly TableDefinition[]> =
	TTables[number]['id'];

// Get all KV field ids
type KvFieldIds<TKv extends readonly KvField[]> = TKv[number]['id'];
```

## KV Field Changes

The `setting()` wrapper becomes unnecessary:

**Before:**

```typescript
kv: {
  theme: setting({
    name: 'Theme',
    icon: 'emoji:🎨',
    description: 'Color theme',
    field: select('theme', { options: ['light', 'dark'] })
  }),
}
```

**After:**

```typescript
kv: [
	select('theme', {
		name: 'Theme',
		icon: 'emoji:🎨',
		description: 'Color theme',
		options: ['light', 'dark'],
	}),
];
```

The field factories already accept `name`, `icon`, `description` in their options. No wrapper needed.

## Migration Patterns

### Table Access

```typescript
// BEFORE
const postsTable = workspace.tables.posts;
const tableIds = Object.keys(workspace.tables);
for (const [id, table] of Object.entries(workspace.tables)) { ... }

// AFTER
const postsTable = workspace.tables.find(t => t.id === 'posts');
const tableIds = workspace.tables.map(t => t.id);
for (const table of workspace.tables) { ... }  // table.id available
```

### KV Access

```typescript
// BEFORE
const theme = workspace.kv.theme;
const kvField = workspace.kv.theme.field;

// AFTER
const theme = workspace.kv.find((k) => k.id === 'theme');
// No .field wrapper - theme IS the field
```

### Helper Functions

```typescript
// Get table by id
function getTableById(
	tables: TableDefinition[],
	id: string,
): TableDefinition | undefined {
	return tables.find((t) => t.id === id);
}

// Get KV field by id
function getKvFieldById(kv: KvField[], id: string): KvField | undefined {
	return kv.find((k) => k.id === id);
}
```

## Files to Modify

### Phase 1: Type Changes

| File                              | Changes                                                     |
| --------------------------------- | ----------------------------------------------------------- |
| `core/schema/fields/types.ts`     | Add `WorkspaceDefinitionV2` or update `WorkspaceDefinition` |
| `core/schema/fields/factories.ts` | Deprecate or remove `setting()`                             |

### Phase 2: defineWorkspace Updates

| File                          | Changes                                     |
| ----------------------------- | ------------------------------------------- |
| `core/workspace/workspace.ts` | Update `defineWorkspace()` to accept arrays |

### Phase 3: Consumer Updates

| File                           | Changes                         |
| ------------------------------ | ------------------------------- |
| `core/docs/workspace-doc.ts`   | Update table/kv access patterns |
| `core/tables/create-tables.ts` | Update to iterate arrays        |
| `core/kv/*.ts`                 | Update to iterate arrays        |
| `cell/*.ts`                    | Verify alignment                |

### Phase 4: Test Updates

All test files using `defineWorkspace()` need migration.

## Backward Compatibility Options

### Option A: New Function Name

```typescript
// Keep old function
defineWorkspace({ tables: { posts: table(...) }, kv: { theme: setting(...) } });

// Add new function
defineWorkspaceV2({ tables: [table(...)], kv: [select(...)] });
```

### Option B: Overload (RECOMMENDED)

```typescript
// Detect format by checking if tables is array or object
function defineWorkspace(def: {
	tables: TableDefinition[];
	kv: KvField[];
}): WorkspaceDefinitionV2;
function defineWorkspace(def: {
	tables: TableDefinitionMap;
	kv: KvDefinitionMap;
}): WorkspaceDefinition;
function defineWorkspace(def: any) {
	if (Array.isArray(def.tables)) {
		return def; // New format
	}
	// Convert old format to new internally
	return {
		...def,
		tables: Object.values(def.tables),
		kv: Object.values(def.kv).map((k) => k.field),
	};
}
```

### Option C: Breaking Change

Just change it. This is internal code, no external consumers yet.

**Recommendation**: Option C (breaking change) since there are no external consumers. If there were, Option B would be cleanest.

## Implementation Order

1. **Add new types** `WorkspaceDefinitionV2` with array-based tables/kv
2. **Add `defineWorkspaceV2()`** function or update signature with overload
3. **Update consumers** to use new array-based access patterns
4. **Deprecate `setting()`** wrapper (KvField has all needed properties)
5. **Update tests** to new syntax
6. **Run full test suite**
7. **(Optional)** Remove old types if no backward compat needed

## Validation Checklist

- [ ] All tests pass
- [ ] TypeScript compiles without errors
- [ ] Type inference works (table ids, kv field ids inferred as literals)
- [ ] No runtime regressions
- [ ] JSDoc examples updated

## Risks and Mitigations

| Risk                         | Mitigation                                           |
| ---------------------------- | ---------------------------------------------------- |
| Breaking existing code       | No external consumers yet; internal refactor         |
| O(n) lookups for table by id | Cache in a Map at runtime if needed; rarely hot path |
| Type inference complexity    | Already solved in fields array refactor              |

## Benefits

1. **Consistency**: tables, kv, fields all use the same pattern
2. **No redundancy**: No duplicate keys (`posts: table('posts', ...)`)
3. **Simpler types**: No `TableDefinitionMap`, `KvDefinitionMap`, `KvDefinition` wrapper
4. **Explicit ordering**: Arrays preserve order for UI display
5. **Less boilerplate**: Remove `setting()` wrapper entirely

## Notes

- WorkspaceDefinitionV2 already exists in workspace.ts but isn't the default
- The `as const` is no longer needed (previous refactor added `<const T>` generics)
- Consider runtime validation for duplicate table/kv ids

---

## Review: Phase 1 - Type Utilities & Helper Cleanup (2026-01-29)

### What Was Done

#### 1. Type utilities added (`packages/epicenter/src/core/schema/fields/types.ts`)

- `TableById<TTables, K>` - Get table by id from array
- `TableIds<TTables>` - Get union of all table ids
- `KvFieldById<TKv, K>` - Get KV field by id from array
- `KvFieldIds<TKv>` - Get union of all KV field ids
- Runtime helpers: `tablesToMap()`, `kvFieldsToMap()`, `getTableById()`, `getKvFieldById()`

#### 2. Internal helpers now ONLY accept arrays

**`createKvHelpers`** (`kv-helper.ts`):

```typescript
// Before: accepted union
createKvHelpers({ ydoc, definitions: TKvDefinitionMap | readonly KvField[] })

// After: array only
createKvHelpers({ ydoc, kvFields: readonly KvField[] })
```

**`createTableHelpers`** (`table-helper.ts`):

```typescript
// Before: accepted union
createTableHelpers({ ydoc, tableDefinitions: TTableDefinitionMap | readonly TableDefinition[] })

// After: array only
createTableHelpers({ ydoc, tableDefinitions: readonly TableDefinition[] })
```

#### 3. Public APIs build helpers directly (no delegation)

**`createKv`** (`core.ts`) - still accepts Record format (deprecated API):

```typescript
// Builds helpers directly using Record keys, doesn't call createKvHelpers
const kvHelpers = Object.fromEntries(
	Object.entries(definitions).map(([keyName, definition]) => [
		keyName,
		createKvHelper({ keyName, ykvMap, field: definition.field }),
	]),
);
```

**`createTables`** (`create-tables.ts`) - still accepts Record format (deprecated API):

```typescript
// Builds helpers directly using Record keys, doesn't call createTableHelpers
const tableHelpers = Object.fromEntries(
	Object.entries(tableDefinitions).map(([tableName, tableDefinition]) => [
		tableName,
		createTableHelper({
			ydoc,
			tableName,
			ytables,
			fields: tableDefinition.fields,
		}),
	]),
);
```

#### 4. Exported `createTableHelper` (singular)

Previously internal, now exported for direct use.

### Architecture After This Change

```
┌─────────────────────────────────────────────────────────────────────────┐
│ Array-only helpers (internal, for new code)                             │
│                                                                         │
│   createKvHelpers({ kvFields: KvField[] })                              │
│   createTableHelpers({ tableDefinitions: TableDefinition[] })           │
│   createKvHelper({ keyName, ykvMap, field })    ← now exported          │
│   createTableHelper({ ydoc, tableName, ytables, fields })               │
└─────────────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────────────┐
│ Record-based public APIs (deprecated, frozen)                           │
│                                                                         │
│   createKv(ydoc, Record<string, { field }>)                             │
│   createTables(ydoc, Record<string, TableDefinition>)                   │
│                                                                         │
│   These build helpers DIRECTLY using Record keys,                       │
│   they do NOT call createKvHelpers/createTableHelpers anymore.          │
└─────────────────────────────────────────────────────────────────────────┘
```

### Gap Identified

There's no public API for array-based definitions:

| API                                        | Format | Returns                                              |
| ------------------------------------------ | ------ | ---------------------------------------------------- |
| `createKv(ydoc, Record)`                   | Record | Full `KvFunction`                                    |
| `createTables(ydoc, Record)`               | Record | Full `TablesFunction`                                |
| `createKvHelpers({ kvFields })`            | Array  | Just helper map (no `has`, `clear`, `observe`, etc.) |
| `createTableHelpers({ tableDefinitions })` | Array  | Just helper map                                      |

**Missing**: `createKv(ydoc, KvField[])` and `createTables(ydoc, TableDefinition[])` that return the full public API.

**Next step**: See `specs/20260129T150000-create-kv-tables-array-only.md` for the breaking change proposal.

### Tests

All 788 tests pass.
