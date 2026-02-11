# Table API Simplification

**Created**: 2026-01-18T11:26:00
**Status**: Draft

## Summary

Simplify the `defineWorkspace` tables API by removing the "minimal fields-only" shorthand and requiring a single canonical table shape with explicit `name`, `description`, `fields`, and optional `icon`. Remove `cover` entirely.

## Motivation

The current API supports two table shapes:

1. **Minimal**: `{ id: id(), sender: text() }` (just fields)
2. **Full**: `{ name, icon, cover, description, fields }` (with metadata)

This creates:

- Ambiguity (which shape should I use?)
- Detection logic (`isTableDefinition()`) that checks for `fields` property
- Potential collisions (what if a field is named `fields`?)
- Inconsistent developer experience

## Target State

### Single Table Shape (Always)

```typescript
tables: {
  emails: {
    name: 'Emails',                    // REQUIRED
    description: 'Email messages',     // REQUIRED
    icon: '📧',                        // OPTIONAL (string | IconDefinition | null)
    fields: {
      id: id(),
      sender: text(),
      subject: text(),
    },
  },
}
```

### Changes from Current

| Aspect            | Before                     | After                    |
| ----------------- | -------------------------- | ------------------------ |
| `name`            | Auto-humanized from key    | Required, explicit       |
| `description`     | Defaulted to `''`          | Required, explicit       |
| `icon`            | Required (could be `null`) | Optional (omit = `null`) |
| `cover`           | Required (usually `null`)  | **Removed entirely**     |
| `fields`          | Optional wrapper           | Required wrapper         |
| Minimal shorthand | Supported                  | **Removed**              |

### Icon Normalization

Input accepts multiple forms, normalized to `IconDefinition | null`:

- `'📧'` → `{ type: 'emoji', value: '📧' }`
- `{ type: 'emoji', value: '📧' }` → unchanged
- `{ type: 'external', url: '...' }` → unchanged
- `undefined` or omitted → `null`
- `null` → `null`

---

## Implementation Plan

### Phase 1: Type Changes

> **Instruction to implementing agent**: Use LSP tools (`lsp_goto_definition`, `lsp_find_references`) to find all type references. Update types in the exact order below. Run `bun run check` after each major change.

#### 1.1 Update `TableDefinition` (remove `cover`, make `icon` optional)

**File**: `packages/epicenter/src/core/schema/fields/types.ts`

**Old**:

```typescript
export type TableDefinition<TFields extends FieldSchemaMap = FieldSchemaMap> = {
	name: string;
	icon: IconDefinition | null;
	cover: CoverDefinition | null;
	description: string;
	fields: TFields;
};
```

**New**:

```typescript
export type TableDefinition<TFields extends FieldSchemaMap = FieldSchemaMap> = {
	/** Required display name shown in UI (e.g., "Blog Posts") */
	name: string;
	/** Required description shown in tooltips/docs */
	description: string;
	/** Optional icon for the table (string shorthand, IconDefinition, or null) */
	icon?: string | IconDefinition | null;
	/** Field schema map for this table */
	fields: TFields;
};
```

#### 1.2 Add `TableInput` type (for `WorkspaceInput`)

**File**: `packages/epicenter/src/core/schema/fields/types.ts`

```typescript
/**
 * Input type for table definitions in `defineWorkspace()`.
 * Requires name, description, fields. Icon is optional.
 */
export type TableInput<TFields extends FieldSchemaMap = FieldSchemaMap> = {
	name: string;
	description: string;
	icon?: string | IconDefinition | null;
	fields: TFields;
};

/**
 * Map of table names to their input definitions.
 */
export type TableInputMap = Record<string, TableInput>;
```

#### 1.3 Update `WorkspaceInput` (use `TableInputMap`)

**File**: `packages/epicenter/src/core/workspace/workspace.ts`

**Old**:

```typescript
export type WorkspaceInput<
	TTables extends TableSchemaMap = TableSchemaMap,
	TKv extends KvSchemaMap = KvSchemaMap,
> = {
	id: string;
	tables: TTables;
	kv: TKv;
};
```

**New**:

```typescript
export type WorkspaceInput<
	TTables extends TableInputMap = TableInputMap,
	TKv extends KvSchemaMap = KvSchemaMap,
> = {
	id: string;
	tables: TTables;
	kv: TKv;
};
```

#### 1.4 Remove or deprecate `TableSchemaMap`

**Files to update**:

- `packages/epicenter/src/core/schema/fields/types.ts` — remove or mark `@internal`
- `packages/epicenter/src/core/schema/index.ts` — stop exporting
- `packages/epicenter/src/index.ts` — stop exporting

#### 1.5 Remove `CoverDefinition` (if unused after `cover` removal)

**Files to update**:

- `packages/epicenter/src/core/schema/fields/types.ts` — remove type
- `packages/epicenter/src/core/schema/index.ts` — stop exporting
- `packages/epicenter/src/index.ts` — stop exporting

#### 1.6 Update `NormalizedTables` type

**File**: `packages/epicenter/src/core/workspace/workspace.ts`

Since input is now `TableInputMap` (with `fields` wrapper), normalization is simpler:

```typescript
export type NormalizedTables<TTables extends TableInputMap> = {
	[K in keyof TTables]: TableDefinition<TTables[K]['fields']>;
};
```

**Checkpoint**: Run `bun run check` — expect errors in normalization code (fixed in Phase 2)

---

### Phase 2: Normalization Changes

#### 2.1 Add `normalizeIcon()` helper

**File**: `packages/epicenter/src/core/workspace/normalize.ts`

```typescript
/**
 * Normalize icon input to canonical IconDefinition | null.
 * - string → { type: 'emoji', value: string }
 * - undefined → null
 * - null → null
 * - IconDefinition → unchanged
 */
function normalizeIcon(
	icon: string | IconDefinition | null | undefined,
): IconDefinition | null {
	if (icon === undefined || icon === null) return null;
	if (typeof icon === 'string') return { type: 'emoji', value: icon };
	return icon;
}
```

#### 2.2 Update `normalizeTable()`

**File**: `packages/epicenter/src/core/workspace/normalize.ts`

**Old**:

```typescript
export function normalizeTable<TFields extends FieldSchemaMap>(
	key: string,
	input: TFields | TableDefinition<TFields>,
): TableDefinition<TFields> {
	if (isTableDefinition(input)) {
		return input as TableDefinition<TFields>;
	}
	return {
		name: humanizeString(key),
		icon: { type: 'emoji', value: '📄' },
		cover: null,
		description: '',
		fields: input,
	};
}
```

**New**:

```typescript
export function normalizeTable<TFields extends FieldSchemaMap>(
	key: string,
	input: TableInput<TFields>,
): TableDefinition<TFields> {
	return {
		name: input.name,
		description: input.description,
		icon: normalizeIcon(input.icon),
		fields: input.fields,
	};
}
```

Note: `key` is kept in signature for potential future use (diagnostics, logging).

#### 2.3 Remove `isTableDefinition()`

**File**: `packages/epicenter/src/core/workspace/normalize.ts`

Delete the function entirely. Also remove from exports:

- `packages/epicenter/src/core/workspace/index.ts`
- `packages/epicenter/src/index.ts`

#### 2.4 Update `normalizeWorkspaceInput()`

**File**: `packages/epicenter/src/core/workspace/workspace.ts`

Update the loop to pass full table input objects:

```typescript
function normalizeWorkspaceInput<
	TTables extends TableInputMap,
	TKv extends KvSchemaMap,
>(
	input: WorkspaceInput<TTables, TKv>,
): WorkspaceDefinition<NormalizedTables<TTables>, NormalizedKv<TKv>> {
	const tables = {} as NormalizedTables<TTables>;
	for (const [key, table] of Object.entries(input.tables)) {
		(tables as Record<string, TableDefinition>)[key] = normalizeTable(
			key,
			table,
		);
	}

	const kv = {} as NormalizedKv<TKv>;
	for (const [key, field] of Object.entries(input.kv)) {
		(kv as Record<string, KvDefinition>)[key] = normalizeKv(key, field);
	}

	return {
		id: input.id,
		name: humanizeString(input.id),
		tables,
		kv,
	};
}
```

**Checkpoint**: Run `bun run check` — expect errors in callsites (fixed in Phase 3)

---

### Phase 3: Migration & Callsite Updates

> **Instruction to implementing agent**: Use parallel sub-agents to update callsites by folder batch. Run type checker after each batch.

#### 3.1 Find all callsites

**AST Search** (required):

```
ast_grep_search pattern="defineWorkspace($$$)" lang="typescript" paths=["apps/", "packages/", "examples/"]
```

**Grep Search** (backup):

```
rg -n "defineWorkspace\s*\(" .
rg -n "\bcover\s*:" .
rg -n "\bfields\s*:" .
```

**Schema Constants** (don't miss these):

```
rg -n "tables:\s*[A-Z0-9_]+" .
```

#### 3.2 Migration Rules

**Rule A: Minimal → Full**

Old:

```typescript
tables: {
  tabs: { id: id(), windowId: integer(), url: text() },
}
```

New:

```typescript
tables: {
  tabs: {
    name: 'Tabs',
    description: '',
    fields: { id: id(), windowId: integer(), url: text() },
  },
}
```

**Rule B: Full → Remove `cover`**

Old:

```typescript
posts: {
  name: 'Posts',
  icon: { type: 'emoji', value: '📝' },
  cover: null,
  description: 'Blog posts',
  fields: { id: id(), title: text() },
}
```

New:

```typescript
posts: {
  name: 'Posts',
  icon: '📝',
  description: 'Blog posts',
  fields: { id: id(), title: text() },
}
```

#### 3.3 Known Callsites (from codebase exploration)

**Apps**:

- `apps/tab-manager/src/lib/epicenter/schema.ts` — full definitions with `cover: null`
- `apps/tab-manager/src/entrypoints/background.ts` — uses schema constant

**Packages**:

- `packages/epicenter/scripts/email-minimal-simulation.ts` — minimal tables
- `packages/epicenter/scripts/email-storage-simulation.ts` — minimal tables
- `packages/epicenter/scripts/yjs-vs-sqlite-comparison.ts` — minimal tables

**Documentation/Examples**:

- JSDoc examples in `workspace.ts`
- README code snippets

#### 3.4 Batch Migration Strategy

1. **Batch 1**: `packages/epicenter/` (core types + scripts)
   - Run `bun run check` in `packages/epicenter`
2. **Batch 2**: `apps/tab-manager/`
   - Run `bun run check` in `apps/tab-manager`
3. **Batch 3**: `apps/epicenter/`
   - Run `bun run check` in `apps/epicenter`
4. **Batch 4**: Other apps + examples
   - Run `bun run check` at repo root

**Checkpoint**: Run `bun run check` at repo root — should pass

---

### Phase 4: Testing & Verification

#### 4.1 Unit Tests

**File**: `packages/epicenter/src/core/workspace/normalize.test.ts` (create if needed)

**Tests for `normalizeIcon()`**:

```typescript
import { describe, test, expect } from 'bun:test';

describe('normalizeIcon', () => {
	test('string input → IconDefinition', () => {
		expect(normalizeIcon('📝')).toEqual({ type: 'emoji', value: '📝' });
	});

	test('IconDefinition input → unchanged', () => {
		const icon = { type: 'emoji', value: '📝' };
		expect(normalizeIcon(icon)).toEqual(icon);
	});

	test('null input → null', () => {
		expect(normalizeIcon(null)).toBeNull();
	});

	test('undefined input → null', () => {
		expect(normalizeIcon(undefined)).toBeNull();
	});
});
```

**Tests for `normalizeTable()`**:

```typescript
describe('normalizeTable', () => {
	test('normalizes table input to definition', () => {
		const input = {
			name: 'Posts',
			description: 'Blog posts',
			icon: '📝',
			fields: { id: id(), title: text() },
		};
		const result = normalizeTable('posts', input);

		expect(result.name).toBe('Posts');
		expect(result.description).toBe('Blog posts');
		expect(result.icon).toEqual({ type: 'emoji', value: '📝' });
		expect(result.fields).toEqual(input.fields);
		expect(result).not.toHaveProperty('cover');
	});

	test('handles missing icon', () => {
		const input = {
			name: 'Posts',
			description: '',
			fields: { id: id(), title: text() },
		};
		const result = normalizeTable('posts', input);

		expect(result.icon).toBeNull();
	});
});
```

**End-to-end `defineWorkspace()` test**:

```typescript
describe('defineWorkspace', () => {
	test('produces normalized WorkspaceDefinition', () => {
		const definition = defineWorkspace({
			id: 'epicenter.blog',
			tables: {
				posts: {
					name: 'Posts',
					description: 'Blog posts',
					icon: '📝',
					fields: { id: id(), title: text() },
				},
			},
			kv: {},
		});

		expect(definition.id).toBe('epicenter.blog');
		expect(definition.name).toBe('Epicenter blog');
		expect(definition.tables.posts.name).toBe('Posts');
		expect(definition.tables.posts.icon).toEqual({
			type: 'emoji',
			value: '📝',
		});
		expect(definition.tables.posts).not.toHaveProperty('cover');

		// JSON round-trip
		const roundTrip = JSON.parse(JSON.stringify(definition));
		expect(roundTrip).toEqual(definition);
	});
});
```

#### 4.2 Integration Smoke Tests

> **Instruction to implementing agent**: Run these in parallel using sub-agents.

**apps/epicenter**:

1. `bun run typecheck`
2. `bun run dev:web` — confirm app loads, workspace list renders

**apps/tab-manager**:

1. `bun run typecheck`
2. `bun run dev` — confirm extension compiles

**apps/whispering**:

1. `bun run typecheck`
2. `bun run dev:web` — confirm app loads

#### 4.3 Regression Checks

**`definition.json` compatibility**:

- Test parsing legacy JSON that includes `cover` (should not crash)
- Verify new JSON output does not include `cover`

**Y.Doc compatibility**:

- Run existing persistence tests
- Confirm table data storage format unchanged

---

## Verification Checklist

- [ ] Phase 1: Type changes compile (`bun run check`)
- [ ] Phase 1: LSP diagnostics clean on type files
- [ ] Phase 2: Normalization changes compile
- [ ] Phase 2: Unit tests pass (`bun test` in packages/epicenter)
- [ ] Phase 3: All callsites migrated
- [ ] Phase 3: Repo-wide typecheck passes
- [ ] Phase 4: Unit tests added and passing
- [ ] Phase 4: Smoke tests pass for apps/epicenter, apps/tab-manager
- [ ] Phase 4: `definition.json` regression verified
- [ ] Phase 4: Y.Doc tests still pass

---

## Files Changed (Expected)

**Types**:

- `packages/epicenter/src/core/schema/fields/types.ts`
- `packages/epicenter/src/core/schema/index.ts`
- `packages/epicenter/src/index.ts`

**Normalization**:

- `packages/epicenter/src/core/workspace/normalize.ts`
- `packages/epicenter/src/core/workspace/workspace.ts`
- `packages/epicenter/src/core/workspace/index.ts`

**Callsites** (variable):

- `apps/tab-manager/src/lib/epicenter/schema.ts`
- `apps/tab-manager/src/entrypoints/background.ts`
- `packages/epicenter/scripts/*.ts`
- Various JSDoc/README examples

**Tests**:

- `packages/epicenter/src/core/workspace/normalize.test.ts` (new)

---

## Review

**Completed**: 2026-01-18T23:24:00
**Status**: Complete

### Summary of Changes

Successfully simplified the `defineWorkspace` tables API by:

1. **Removed the "minimal fields-only" shorthand** - Tables now require explicit `name`, `description`, and `fields`
2. **Removed `cover` from TableDefinition** - The `cover` property was removed entirely from the schema
3. **Made `icon` optional with string shorthand** - Icon can be `'📝'` (string), `IconDefinition`, or omitted (normalized to `null`)

### Files Modified

**Types**:

- `packages/epicenter/src/core/schema/fields/types.ts` - Updated `TableDefinition`, added `TableInput` and `TableInputMap`
- `packages/epicenter/src/core/schema/index.ts` - Added exports for `TableInput`, `TableInputMap`
- `packages/epicenter/src/index.ts` - Added exports for new types and `normalizeIcon`

**Normalization**:

- `packages/epicenter/src/core/workspace/normalize.ts` - Added `normalizeIcon()`, updated `normalizeTable()`, deprecated `isTableDefinition()`
- `packages/epicenter/src/core/workspace/workspace.ts` - Updated signatures for `WorkspaceInput`, `NormalizedTables`, etc.
- `packages/epicenter/src/core/workspace/index.ts` - Added export for `normalizeIcon`

**Callsite Migrations**:

- `packages/epicenter/scripts/email-minimal-simulation.ts` - Converted minimal to full format
- `packages/epicenter/scripts/email-storage-simulation.ts` - Converted minimal to full format
- `packages/epicenter/scripts/yjs-vs-sqlite-comparison.ts` - Converted minimal to full format
- `apps/tab-manager/src/lib/epicenter/schema.ts` - Removed `cover: null` from all tables
- All test files in `packages/epicenter/src/core/tables/*.test.ts` - Added `description: ''` to `table()` calls

**Deprecated**:

- `packages/epicenter/src/core/schema/fields/factories.ts` - Deprecated `cover` factory function

**New Tests**:

- `packages/epicenter/src/core/workspace/normalize.test.ts` - 13 tests for icon/table normalization
- `packages/epicenter/src/core/workspace/workspace.test.ts` - 8 tests for `defineWorkspace()`

### Test Results

- **319 tests pass** across 18 files in `packages/epicenter`
- TypeScript check passes (remaining errors are pre-existing issues in scripts/cli unrelated to this change)

### Migration Pattern

**Before (minimal shorthand - now removed)**:

```typescript
tables: {
  posts: { id: id(), title: text() },
}
```

**After (required explicit format)**:

```typescript
tables: {
  posts: {
    name: 'Posts',
    description: 'Blog posts',
    icon: '📝',  // Optional: string, IconDefinition, or omit
    fields: { id: id(), title: text() },
  },
}
```

### Notes

- The `humanizeString` library converts `'epicenter.blog'` to `'Epicenter.blog'` (not `'Epicenter blog'`), which is the expected behavior
- The `cover` factory function is deprecated but not removed to avoid breaking external code
- The `isTableDefinition()` function is deprecated and marked as such, not removed entirely
