# Refactor: Schema Fields from Record to Array

**Status**: Completed
**Created**: 2026-01-29
**Updated**: 2026-01-29

## Decision Summary

Convert `TableDefinition.fields` from `Record<string, Field>` to `Field[]` (array) with **no type lies**. The array approach is cleaner, preserves explicit ordering, and aligns better with JSON serialization semantics.

**Key decisions:**

1. **Array all the way down** - No hybrid Record input / Array output
2. **ID-first factories** - `text('title')` not `field('title', text())`
3. **Rename types** - `Field` → `FieldSchema`, `FieldWithId` → `Field`
4. **Full type rewrite** - `Row<TFields>` works with arrays natively

## Problem Statement

Currently, `TableDefinition.fields` is typed as `Record<string, Field>`. This has limitations:

1. **Field order is implicit** - Object key order in JSON is not guaranteed by spec
2. **ID is implicit** - The field's identifier is the object key, not a visible property
3. **Type gymnastics** - Converting between Record and Array requires complex type utilities

## Current vs Proposed

### JSON Serialization

**Current (Record):**

```json
{
	"name": "Posts",
	"fields": {
		"id": { "type": "id", "name": "", "icon": null },
		"title": { "type": "text", "name": "", "icon": null },
		"status": { "type": "select", "options": ["draft", "published"] }
	}
}
```

**Proposed (Array):**

```json
{
	"name": "Posts",
	"fields": [
		{ "id": "id", "type": "id", "name": "", "icon": null },
		{ "id": "title", "type": "text", "name": "", "icon": null },
		{ "id": "status", "type": "select", "options": ["draft", "published"] }
	]
}
```

### TypeScript Definition

**Current:**

```typescript
const posts = table({
	name: 'Posts',
	fields: {
		id: id(),
		title: text(),
		status: select({ options: ['draft', 'published'] as const }),
	},
});
```

**Proposed (ID-first factories):**

```typescript
const posts = table({
	name: 'Posts',
	fields: [
		id(), // defaults to 'id'
		text('title'),
		select('status', { options: ['draft', 'published'] as const }),
	] as const,
});
```

## Type System Changes

### Naming Changes

```typescript
// BEFORE
Field; // Union: IdField | TextField | SelectField | ...
FieldWithId; // Field & { id: string }
FieldMap; // { id: IdField } & Record<string, Field>

// AFTER
FieldSchema; // Union: IdFieldSchema | TextFieldSchema | SelectFieldSchema | ...
Field; // FieldSchema & { id: string } - THE field type everywhere
// No FieldMap - concept removed entirely
```

### Core Types

```typescript
// Base field schemas (without id)
type IdFieldSchema = FieldMetadata & { type: 'id' };
type TextFieldSchema<TNullable extends boolean = boolean> = FieldMetadata & {
	type: 'text';
	nullable?: TNullable;
	default?: string;
};
// ... etc for all field types

// Union of all field schemas
type FieldSchema =
	| IdFieldSchema
	| TextFieldSchema
	| RichtextFieldSchema
	| IntegerFieldSchema
	| RealFieldSchema
	| BooleanFieldSchema
	| DateFieldSchema
	| SelectFieldSchema
	| TagsFieldSchema
	| JsonFieldSchema;

// THE Field type - schema + id
type Field = FieldSchema & { id: string };

// Table definition with array fields
type TableDefinition<TFields extends readonly Field[] = Field[]> = {
	name: string;
	description: string;
	icon: Icon | null;
	fields: TFields;
};
```

### Type Utilities

```typescript
// Get union of all field ids from array
type FieldIds<TFields extends readonly Field[]> = TFields[number]['id'];

// Get specific field by id
type FieldById<TFields extends readonly Field[], K extends string> = Extract<
	TFields[number],
	{ id: K }
>;

// Row type - maps field ids to their value types
type Row<TFields extends readonly Field[]> = {
	[K in TFields[number]['id']]: CellValue<FieldById<TFields, K>>;
};

// Partial row - id required, rest optional
type PartialRow<TFields extends readonly Field[]> = { id: string } & Partial<
	Omit<Row<TFields>, 'id'>
>;
```

### CellValue Update

```typescript
// CellValue now works with FieldSchema (base types without id)
type CellValue<F extends FieldSchema = FieldSchema> =
  F extends IdFieldSchema ? string :
  F extends TextFieldSchema ? (IsNullable<F> extends true ? string | null : string) :
  // ... etc
```

## Factory Changes

### ID-First Factory Signatures

```typescript
// id() - defaults to 'id', can override
function id(): IdFieldSchema & { id: 'id' };
function id<const K extends string>(fieldId: K): IdFieldSchema & { id: K };

// text() - id first, options second
function text<const K extends string>(
	id: K,
	opts?: { nullable?: false; default?: string } & FieldOptions,
): TextFieldSchema<false> & { id: K };

function text<const K extends string>(
	id: K,
	opts: { nullable: true; default?: string } & FieldOptions,
): TextFieldSchema<true> & { id: K };

// select() - id first, then options object with required `options`
function select<
	const K extends string,
	const TOptions extends readonly [string, ...string[]],
>(
	id: K,
	opts: {
		options: TOptions;
		nullable?: false;
		default?: TOptions[number];
	} & FieldOptions,
): SelectFieldSchema<TOptions, false> & { id: K };

// ... similar pattern for all factories
```

### Factory Implementation Example

```typescript
export function text<const K extends string>(
	id: K,
	{
		nullable = false,
		default: defaultValue,
		name = '',
		description = '',
		icon = null,
	}: {
		nullable?: boolean;
		default?: string;
	} & FieldOptions = {},
): TextFieldSchema<boolean> & { id: K } {
	return {
		id,
		type: 'text',
		name,
		description,
		icon,
		...(nullable && { nullable: true }),
		...(defaultValue !== undefined && { default: defaultValue }),
	};
}
```

### table() Factory

```typescript
export function table<const TFields extends readonly Field[]>(options: {
	name: string;
	fields: TFields;
	description?: string;
	icon?: string | Icon | null;
}): TableDefinition<TFields> {
	return {
		name: options.name,
		description: options.description ?? '',
		icon: normalizeIcon(options.icon),
		fields: options.fields,
	};
}
```

## Call Site Examples

### Simple Table

```typescript
const posts = table({
	name: 'Posts',
	fields: [
		id(),
		text('title'),
		text('subtitle', { nullable: true }),
		integer('views', { default: 0 }),
		boolean('published', { default: false }),
		select('status', { options: ['draft', 'review', 'published'] as const }),
		tags('categories'),
		date('createdAt'),
	] as const,
});
```

### With Metadata

```typescript
const posts = table({
	name: 'Posts',
	icon: '📝',
	description: 'Blog posts and articles',
	fields: [
		id(),
		text('title', { name: 'Post Title', icon: 'emoji:📝' }),
		select('status', {
			options: ['draft', 'published'] as const,
			name: 'Status',
			icon: 'emoji:📊',
			default: 'draft',
		}),
	] as const,
});
```

### Type Inference Works

```typescript
// Row type inferred correctly
type PostRow = Row<typeof posts.fields>;
// { id: string; title: string; subtitle: string | null; views: number; ... }

// Field access
const titleField = posts.fields.find((f) => f.id === 'title');
// Type: Field (narrowed from union)
```

## Files to Modify

### Phase 1: Core Type Renames

| File                          | Changes                                                                                                              |
| ----------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| `core/schema/fields/types.ts` | Rename `Field` → `FieldSchema`, add new `Field = FieldSchema & { id }`, remove `FieldMap`, update `Row`/`PartialRow` |

### Phase 2: Factory Updates

| File                              | Changes                                     |
| --------------------------------- | ------------------------------------------- |
| `core/schema/fields/factories.ts` | Update all factories to ID-first signatures |

### Phase 3: Consumer Updates

| File                                   | Changes                                     |
| -------------------------------------- | ------------------------------------------- |
| `core/schema/converters/to-drizzle.ts` | Iterate array instead of `Object.entries()` |
| `core/schema/converters/to-arktype.ts` | Same                                        |
| `core/tables/*.ts`                     | Update field access patterns                |
| `core/definition-helper/*.ts`          | Update field access patterns                |
| `cell/*.ts`                            | Already mostly done, verify alignment       |

### Phase 4: Test Updates

| File                               | Changes                                  |
| ---------------------------------- | ---------------------------------------- |
| `core/tables/*.test.ts`            | Update table definitions to array syntax |
| `core/definition-helper/*.test.ts` | Same                                     |
| `core/schema/converters/*.test.ts` | Same                                     |
| `cell/*.test.ts`                   | Already done, verify                     |

## Migration Patterns

### Field Access

```typescript
// BEFORE
const titleField = table.fields.title;
const fieldIds = Object.keys(table.fields);
for (const [id, field] of Object.entries(table.fields)) { ... }

// AFTER
const titleField = table.fields.find(f => f.id === 'title');
const fieldIds = table.fields.map(f => f.id);
for (const field of table.fields) { ... }  // field.id available
```

### Helper Functions (already exist in cell package)

```typescript
// Get field by id (returns undefined if not found)
function getFieldById(fields: Field[], id: string): Field | undefined {
	return fields.find((f) => f.id === id);
}

// Get all field ids
function getFieldIds(fields: Field[]): string[] {
	return fields.map((f) => f.id);
}
```

## Implementation Order

1. **Rename types** in `types.ts` (Field → FieldSchema, FieldWithId → Field)
2. **Update `Row` and `PartialRow`** to use array-based type utilities
3. **Update factories** to ID-first signatures
4. **Update `table()` factory** to accept array directly
5. **Update converters** (to-drizzle, to-arktype)
6. **Update core tests** to new syntax
7. **Verify cell package** still works (should need minimal changes)
8. **Run full test suite**

## Validation Checklist

- [x] All 505 core/cell tests pass
- [x] All core table tests pass
- [x] All converter tests pass
- [x] Definition helper tests pass
- [x] No TypeScript errors in core/cell (`bunx tsc --noEmit`)
- [x] Type inference works in call sites

## Risks and Mitigations

| Risk                     | Mitigation                                      |
| ------------------------ | ----------------------------------------------- |
| Breaking existing code   | This is internal refactor; no external API yet  |
| Type inference regresses | Test with complex select/tags options to verify |
| `as const` forgotten     | Add lint rule or document prominently           |
| Duplicate field ids      | Add runtime validation in `table()` factory     |

## Notes

- ~~The `as const` on the fields array is required for literal type inference~~ **UPDATE**: `as const` is no longer needed! The factory functions use `<const T>` generics which infer literal types automatically.
- ~~Consider adding a helper like `fields(...)` that auto-applies const assertion~~ Not needed anymore.
- The `id()` factory defaults to `'id'` since that's always the name

## Follow-up: Removed `as const` Requirement (2026-01-29)

A follow-up refactor removed the need for `as const` at call sites:

**Before:**

```typescript
const posts = table('posts', {
	name: 'Posts',
	fields: [
		id(),
		text('title'),
		select('status', { options: ['draft', 'published'] as const }),
	] as const,
});
```

**After:**

```typescript
const posts = table('posts', {
	name: 'Posts',
	fields: [
		id(),
		text('title'),
		select('status', { options: ['draft', 'published'] }),
	],
});
```

**How it works:**

- The `table()` factory has `<const TFields extends readonly Field[]>` in its generic
- The `select()` and `tags()` factories have `<const TOptions extends readonly [string, ...string[]]>`
- TypeScript infers literal types when the function has a `const` type parameter

**Changes made:**

- Updated type defaults: `TableDefinition<TFields = readonly Field[]>`, `Row<TFields = readonly Field[]>`, `PartialRow<TFields = readonly Field[]>`
- Removed 193 instances of `as const` from call sites
- Updated all JSDoc examples
