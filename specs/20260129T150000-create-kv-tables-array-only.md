# Breaking Change: createKv and createTables to Array-Only

**Status**: Completed
**Created**: 2026-01-29
**Completed**: 2026-01-29
**Depends on**: 20260129T143000-workspace-tables-kv-to-array.md (completed)

## Summary

Convert `createKv` and `createTables` from Record-based to Array-based APIs. This is a **breaking change** with no backward compatibility—the Record format will be removed entirely.

## Current State

```typescript
// Current: Record-based (deprecated but still the only option)
const kv = createKv(ydoc, {
	theme: { field: select('theme', { options: ['light', 'dark'] }) },
	fontSize: { field: integer('fontSize', { default: 14 }) },
});

const tables = createTables(ydoc, {
	posts: table('posts', { name: 'Posts', fields: [id(), text('title')] }),
	users: table('users', { name: 'Users', fields: [id(), text('name')] }),
});
```

## Proposed

```typescript
// New: Array-based (arrays all the way down)
const kv = createKv(ydoc, [
	select('theme', { options: ['light', 'dark'] }),
	integer('fontSize', { default: 14 }),
]);

const tables = createTables(ydoc, [
	table('posts', { name: 'Posts', fields: [id(), text('title')] }),
	table('users', { name: 'Users', fields: [id(), text('name')] }),
]);
```

## Motivation

1. **Consistency**: `fields` is already an array. `tables` and `kv` should match.
2. **No redundancy**: Record keys duplicate the object's `id` property
3. **Simpler types**: No `TableDefinitionMap`, `KvDefinitionMap` types needed
4. **No wrappers**: `{ field: ... }` wrapper around KV fields is unnecessary
5. **Explicit ordering**: Arrays preserve order (Records don't guarantee it in JSON)

## Type Changes

### KvFunction

```typescript
// Before
export type KvFunction<TKvDefinitionMap extends Record<string, { field: KvField }>> = {
  get<K extends keyof TKvDefinitionMap & string>(key: K): KvGetResult<...>;
  set<K extends keyof TKvDefinitionMap & string>(key: K, value: ...): void;
  // ...
  definitions: TKvDefinitionMap;
};

// After
export type KvFunction<TKvFields extends readonly KvField[]> = {
  get<K extends TKvFields[number]['id']>(key: K): KvGetResult<...>;
  set<K extends TKvFields[number]['id']>(key: K, value: ...): void;
  // ...
  definitions: TKvFields;  // Now an array, not a Record
};
```

### TablesFunction

```typescript
// Before
export type TablesFunction<TTableDefinitionMap extends Record<string, TableDefinition>> = {
  get<K extends keyof TTableDefinitionMap & string>(name: K): TableHelper<...>;
  // ...
  definitions: TTableDefinitionMap;
};

// After
export type TablesFunction<TTableDefinitions extends readonly TableDefinition[]> = {
  get<K extends TTableDefinitions[number]['id']>(name: K): TableHelper<...>;
  // ...
  definitions: TTableDefinitions;  // Now an array, not a Record
};
```

## Implementation

### createKv

```typescript
export function createKv<TKvFields extends readonly KvField[]>(
	ydoc: Y.Doc,
	kvFields: TKvFields,
): KvFunction<TKvFields> {
	const ykvMap = ydoc.getMap<KvValue>('kv');
	const kvHelpers = createKvHelpers({ ydoc, kvFields });

	return {
		get<K extends TKvFields[number]['id']>(key: K) {
			return kvHelpers[key].get();
		},

		set<K extends TKvFields[number]['id']>(key: K, value) {
			kvHelpers[key].set(value);
		},

		reset<K extends TKvFields[number]['id']>(key: K) {
			kvHelpers[key].reset();
		},

		observeKey<K extends TKvFields[number]['id']>(key: K, callback) {
			return kvHelpers[key].observe(callback);
		},

		has(key: string): boolean {
			return ykvMap.has(key);
		},

		clear(): void {
			for (const field of kvFields) {
				ykvMap.delete(field.id);
			}
		},

		definitions: kvFields,

		observe(callback: () => void): () => void {
			ykvMap.observeDeep(callback);
			return () => ykvMap.unobserveDeep(callback);
		},

		toJSON() {
			return ykvMap.toJSON();
		},
	};
}
```

### createTables

```typescript
export function createTables<
	TTableDefinitions extends readonly TableDefinition[],
>(
	ydoc: Y.Doc,
	tableDefinitions: TTableDefinitions,
): TablesFunction<TTableDefinitions> {
	const ytables: TablesMap = ydoc.getMap('tables');
	const tableHelpers = createTableHelpers({ ydoc, tableDefinitions });
	const dynamicTableHelpers = new Map<string, UntypedTableHelper>();

	const getOrCreateDynamicHelper = (name: string): UntypedTableHelper => {
		let helper = dynamicTableHelpers.get(name);
		if (!helper) {
			helper = createUntypedTableHelper({ ydoc, tableName: name, ytables });
			dynamicTableHelpers.set(name, helper);
		}
		return helper;
	};

	return {
		get(name: string) {
			if (name in tableHelpers) {
				return tableHelpers[name as keyof typeof tableHelpers];
			}
			return getOrCreateDynamicHelper(name);
		},

		has(name: string): boolean {
			return ytables.has(name);
		},

		names(): string[] {
			return Array.from(ytables.keys());
		},

		clear(): void {
			ydoc.transact(() => {
				for (const tableDef of tableDefinitions) {
					tableHelpers[tableDef.id as keyof typeof tableHelpers].clear();
				}
			});
		},

		definitions: tableDefinitions,

		toJSON(): Record<string, unknown[]> {
			const result: Record<string, unknown[]> = {};
			for (const name of ytables.keys()) {
				const helper =
					name in tableHelpers
						? tableHelpers[name as keyof typeof tableHelpers]
						: getOrCreateDynamicHelper(name);
				result[name] = helper.getAllValid();
			}
			return result;
		},
	};
}
```

## Files to Modify

| File                           | Changes                                            |
| ------------------------------ | -------------------------------------------------- |
| `core/kv/core.ts`              | Update `createKv` signature and implementation     |
| `core/tables/create-tables.ts` | Update `createTables` signature and implementation |
| `core/kv/core.ts`              | Update `KvFunction` type                           |
| `core/tables/create-tables.ts` | Update `TablesFunction` type                       |
| `core/docs/workspace-doc.ts`   | Update calls to use array format                   |
| `static/define-workspace.ts`   | Update calls to use array format                   |
| `static/create-kv.ts`          | Update re-export and docs                          |
| `static/create-tables.ts`      | Update re-export and docs                          |

## Test Migration

All tests using `createKv` and `createTables` need updates:

```typescript
// Before
const kv = createKv(ydoc, {
	theme: { field: select('theme', { options: ['light', 'dark'] }) },
});

// After
const kv = createKv(ydoc, [select('theme', { options: ['light', 'dark'] })]);
```

### Migration Script (AST-grep)

```yaml
# sg rule for createKv migration
id: migrate-createkv-to-array
language: typescript
rule:
  pattern: createKv($YDOC, { $$$ENTRIES })
fix: createKv($YDOC, [/* TODO: convert entries */])
```

Manual conversion is recommended due to the structural change.

## Deprecated Types to Remove

After migration, these types become unnecessary:

- `KvDefinitionLike` - No longer needed (was wrapper type)
- `KvDefinitionMap` - Replaced by `KvField[]`
- `TableDefinitionMap` - Replaced by `TableDefinition[]`

## Access Pattern Changes

### Accessing definitions

```typescript
// Before (Record)
kv.definitions.theme.field  // The field
Object.keys(kv.definitions)  // All keys
Object.entries(kv.definitions)  // Iterate

// After (Array)
kv.definitions.find(f => f.id === 'theme')  // The field
kv.definitions.map(f => f.id)  // All keys
kv.definitions.forEach(f => ...)  // Iterate
```

### Type-safe access

```typescript
// Before
type ThemeField = typeof kv.definitions.theme.field;

// After
type ThemeField = Extract<(typeof kv.definitions)[number], { id: 'theme' }>;
// Or use the utility:
type ThemeField = KvFieldById<typeof kv.definitions, 'theme'>;
```

## Validation Checklist

- [x] `createKv` accepts `KvField[]` only
- [x] `createTables` accepts `TableDefinition[]` only
- [x] `KvFunction` type updated
- [x] `TablesFunction` type updated
- [x] All tests migrated
- [x] All internal usages migrated (`workspace-doc.ts`, `define-workspace.ts`)
- [x] JSDoc examples updated
- [x] Type inference works (field ids inferred as literals)
- [x] All 788 tests pass

## Risks

| Risk                      | Mitigation                                               |
| ------------------------- | -------------------------------------------------------- |
| Breaking change           | No external consumers; internal refactor only            |
| Test migration effort     | ~100 test call sites; straightforward find-replace       |
| Type inference complexity | Already solved in `createKvHelpers`/`createTableHelpers` |

## Benefits

1. **Arrays all the way down**: `workspace.tables`, `workspace.kv`, `table.fields` all arrays
2. **No wrapper types**: Direct `KvField[]` instead of `Record<string, { field: KvField }>`
3. **Simpler mental model**: One pattern for all collections
4. **Better JSON serialization**: Arrays have guaranteed order
5. **Cleaner internal code**: `createKv`/`createTables` can directly use `createKvHelpers`/`createTableHelpers`

## Review

### Summary of Changes

This breaking change converted `createKv` and `createTables` from Record-based to Array-based APIs across the entire codebase.

### Files Modified

**Core API:**

- `src/core/kv/core.ts` - Updated `createKv` signature and `KvFunction` type
- `src/core/tables/create-tables.ts` - Updated `createTables` signature and `TablesFunction` type
- `src/core/docs/workspace-doc.ts` - Updated to use array format
- `src/core/workspace/workspace.ts` - Updated `WorkspaceDefinition` type

**Deprecated code removed:**

- `src/core/schema/fields/types.ts` - Removed `TableDefinitionMap`, `KvDefinitionMap`, `KvDefinition`, `KvMap`
- `src/core/schema/fields/factories.ts` - Removed `setting()` function
- `src/core/schema/index.ts` - Removed `setting` export
- `src/cell/index.ts` - Removed `setting` export
- `src/cell/schema-helpers.ts` - Removed `schemaKv()` function

**Cell module:**

- `src/cell/types.ts` - Updated `CellWorkspaceClient` type
- `src/cell/extensions.ts` - Updated extension types
- `src/cell/create-cell-workspace.ts` - Updated table lookup from Record to array `.find()`
- `src/cell/schema-file.ts` - Updated to produce array output, updated `addTable`, `removeTable`, `addField`, `removeField`

**Test files migrated:**

- `src/core/kv/core.test.ts`
- `src/core/tables/create-tables.test.ts`
- `src/core/tables/create-tables.crdt-sync.test.ts`
- `src/core/tables/create-tables.offline-sync.test.ts`
- `src/core/tables/create-tables.types.test.ts`
- `src/core/schema/fields/definition-helper.test.ts`
- `src/cell/create-cell-workspace.test.ts`
- `src/cell/schema-file.test.ts`

**Scripts migrated:**

- `scripts/email-minimal-simulation.ts`
- `scripts/email-storage-simulation.ts`
- `scripts/yjs-vs-sqlite-comparison.ts`

### API Changes

**Before (Record format):**

```typescript
const kv = createKv(ydoc, {
	theme: { field: select('theme', { options: ['light', 'dark'] }) },
});

const tables = createTables(ydoc, {
	posts: table('posts', { name: 'Posts', fields: [id(), text('title')] }),
});
```

**After (Array format):**

```typescript
const kv = createKv(ydoc, [select('theme', { options: ['light', 'dark'] })]);

const tables = createTables(ydoc, [
	table('posts', { name: 'Posts', fields: [id(), text('title')] }),
]);
```

### Test Results

- **788 tests pass**
- **2 tests skipped** (pre-existing)
- **0 tests fail**

### Pre-existing Issues (Not Addressed)

TypeScript errors in unrelated files that existed before this migration:

- `scripts/demo-yjs-nested-map-lww.ts` - toJSON type issues
- `scripts/yjs-data-structure-benchmark.ts` - unused variables
- `scripts/yjs-gc-benchmark.ts` - string | undefined type issues
- `src/cli/cli.test.ts` - yargs type definition issues
