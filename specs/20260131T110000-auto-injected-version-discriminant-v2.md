# Auto-Injected Version Discriminant (v2)

> **STATUS: DEFERRED**
>
> This spec documents a potential future breaking change. After implementation and review,
> we decided to **keep the explicit API** (where users include `_v` in their schemas) for now.
>
> **Rationale:**
>
> - Explicit is clearer - you see exactly what's stored
> - Industry doesn't use this pattern - we'd be inventing new conventions
> - Consistency - same rules for tables and KV (no special auto-injection for tables only)
> - The explicit approach works fine once you understand it
>
> This spec is preserved for future reference if we decide to revisit this design.

---

## Overview

This specification proposes a new `.version(tag, schema)` API that auto-injects a `_v` discriminant field, eliminating all manual `_v` management from user code.

### Goals

1. **Zero `_v` boilerplate** - User never types `_v` in schemas, writes, or migrate returns
2. **Full TypeScript narrowing** - Discriminated unions work perfectly in migrate function
3. **Flexible version tags** - Support both string and number tags
4. **Simple conflict handling** - Just merge for now; add stricter checks later

### Related Specs

- `specs/20260125T120000-versioned-table-kv-specification.md` - Original versioning design
- `specs/20260131T104800-auto-injected-version-discriminant.md` - Initial analysis (superseded by this spec)

---

## Current API (Explicit `_v` - What We're Keeping)

```typescript
import { defineTable } from 'epicenter/static';
import { type } from 'arktype';

const posts = defineTable()
	.version(type({ id: 'string', title: 'string', _v: '"1"' }))
	.version(type({ id: 'string', title: 'string', views: 'number', _v: '"2"' }))
	.migrate((row) => {
		if (row._v === '1') return { ...row, views: 0, _v: '2' as const };
		return row;
	});

// Write - must include _v
posts.set({ id: '1', title: 'Hello', views: 0, _v: '2' });
```

**Pros:**

- Explicit - you see exactly what gets stored
- Consistent - same pattern for tables and KV
- Industry-aligned - follows how Zod/Effect handle discriminated unions
- No magic - what you write is what you get

**Cons:**

- More boilerplate (`_v` in every schema, every write, every migrate return)
- Must know arktype literal syntax (`'"1"'` for string literal)
- Easy to forget or typo `_v`

---

## Proposed Future API (Auto-Injected `_v`)

---

## API Design

### Before (Current API)

```typescript
import { defineTable } from 'epicenter/static';
import { type } from 'arktype';

const posts = defineTable()
	.version(type({ id: 'string', title: 'string', _v: '"1"' }))
	.version(type({ id: 'string', title: 'string', views: 'number', _v: '"2"' }))
	.migrate((row) => {
		if (row._v === '1') return { ...row, views: 0, _v: '2' as const };
		return row;
	});

// Write - must include _v
posts.set({ id: '1', title: 'Hello', views: 0, _v: '2' });
```

**Pain points:**

- `_v` in every schema definition
- `_v` in every `.set()` call
- `_v` in migrate return
- Easy to typo or forget

### After (Proposed API)

```typescript
import { defineTable } from 'epicenter/static';
import { type } from 'arktype';

const posts = defineTable()
	.version(1, type({ id: 'string', title: 'string' }))
	.version(2, type({ id: 'string', title: 'string', views: 'number' }))
	.migrate((row) => {
		if (row._v === 1) return { ...row, views: 0 };
		return row;
	});

// Write - NO _v needed!
posts.set({ id: '1', title: 'Hello', views: 0 });
```

**Improvements:**

- Version tag is first argument (clear, can't forget)
- No `_v` in schema definitions
- No `_v` in `.set()` calls
- No `_v` in migrate return (auto-set to latest)
- TypeScript narrowing works via injected literal types

---

## Version Tag Type

### Supported Types

The version tag can be **string** or **number**:

```typescript
// Numeric tags (recommended for simplicity)
defineTable().version(1, schema1).version(2, schema2);

// String tags (for semantic versioning, dates, etc.)
defineTable().version('1.0', schema1).version('2.0', schema2);

// Date-based tags
defineTable().version('2024-01', schema1).version('2024-06', schema2);
```

### Type Definition

```typescript
/**
 * Valid version tag types.
 * Both string and number work as discriminants in TypeScript.
 */
type VersionTag = string | number;
```

### Storage Format

Regardless of input type, `_v` is stored as-is in YJS:

```json
// Numeric tag
{ "id": "1", "title": "Hello", "views": 0, "_v": 2 }

// String tag
{ "id": "1", "title": "Hello", "views": 0, "_v": "2.0" }
```

### TypeScript Narrowing

Both work for discriminated unions:

```typescript
// Numeric
if (row._v === 1) {
	/* row narrowed to V1 */
}

// String
if (row._v === '1.0') {
	/* row narrowed to V1 */
}
```

---

## Type System Design

### Core Types

```typescript
/**
 * Valid version tag types for discriminated unions.
 */
type VersionTag = string | number;

/**
 * The reserved key used for version discrimination.
 * This field is auto-injected by the versioning system.
 */
const VERSION_KEY = '_v' as const;
type VersionKey = typeof VERSION_KEY;

/**
 * A schema with its version tag.
 * Created internally when .version(tag, schema) is called.
 */
type VersionedSchema<
	TSchema extends StandardSchemaV1,
	TTag extends VersionTag,
> = {
	tag: TTag;
	schema: TSchema;
};
```

### Row Type Inference

```typescript
/**
 * Infer the output type of a versioned schema with _v injected.
 *
 * @example
 * // Schema: type({ id: 'string', title: 'string' })
 * // Tag: 1
 * // Result: { id: string; title: string; _v: 1 }
 */
type InferVersionedOutput<
	TSchema extends StandardSchemaV1,
	TTag extends VersionTag,
> = StandardSchemaV1.InferOutput<TSchema> & { [VERSION_KEY]: TTag };

/**
 * Infer the union of all versioned outputs (for migrate input).
 *
 * @example
 * // Versions: [{ tag: 1, schema: V1 }, { tag: 2, schema: V2 }]
 * // Result: ({ ...V1Output, _v: 1 } | { ...V2Output, _v: 2 })
 */
type InferVersionUnion<TVersions extends VersionedSchema<any, any>[]> = {
	[K in keyof TVersions]: TVersions[K] extends VersionedSchema<infer S, infer T>
		? InferVersionedOutput<S, T>
		: never;
}[number];

/**
 * Infer the latest version's output type (for writes and migrate output).
 * This is the LAST schema in the versions array.
 */
type InferLatestVersionedOutput<TVersions extends VersionedSchema<any, any>[]> =
	TVersions extends [...any[], VersionedSchema<infer S, infer T>]
		? InferVersionedOutput<S, T>
		: never;

/**
 * The write type - latest schema WITHOUT _v (auto-injected on write).
 */
type InferWriteRow<TVersions extends VersionedSchema<any, any>[]> =
	TVersions extends [...any[], VersionedSchema<infer S, infer T>]
		? StandardSchemaV1.InferOutput<S> & { id: string }
		: never;

/**
 * The read type - latest schema WITH _v.
 */
type InferReadRow<TVersions extends VersionedSchema<any, any>[]> =
	InferLatestVersionedOutput<TVersions> & { id: string };
```

### Builder Types

````typescript
/**
 * Builder for defining table schemas with versioning support.
 *
 * @typeParam TVersions - Tuple of versioned schemas added via .version()
 *
 * @example
 * ```typescript
 * const posts = defineTable()
 *   .version(1, type({ id: 'string', title: 'string' }))
 *   .version(2, type({ id: 'string', title: 'string', views: 'number' }))
 *   .migrate((row) => {
 *     if (row._v === 1) return { ...row, views: 0 };
 *     return row;
 *   });
 * ```
 */
type TableBuilder<TVersions extends VersionedSchema<any, any>[]> = {
	/**
	 * Add a schema version with explicit tag.
	 *
	 * The tag becomes the `_v` discriminant value for this version.
	 * Tags can be numbers (1, 2, 3) or strings ('1.0', '2024-01').
	 *
	 * @param tag - Version identifier (literal type for TypeScript narrowing)
	 * @param schema - Standard Schema for this version's row shape
	 * @returns Builder with this version added
	 *
	 * @example
	 * ```typescript
	 * // Numeric tags
	 * defineTable()
	 *   .version(1, type({ id: 'string', name: 'string' }))
	 *   .version(2, type({ id: 'string', name: 'string', email: 'string' }))
	 *
	 * // String tags
	 * defineTable()
	 *   .version('2024-01', type({ id: 'string', name: 'string' }))
	 *   .version('2024-06', type({ id: 'string', name: 'string', email: 'string' }))
	 * ```
	 */
	version<TTag extends VersionTag, TSchema extends StandardSchemaV1>(
		tag: TTag,
		schema: StandardSchemaV1.InferOutput<TSchema> extends { id: string }
			? TSchema
			: never,
	): TableBuilder<[...TVersions, VersionedSchema<TSchema, TTag>]>;

	/**
	 * Provide a migration function that normalizes any version to the latest.
	 *
	 * The migrate function receives rows with `_v` for type narrowing.
	 * The return value should be the latest schema shape (without `_v` - it's auto-set).
	 *
	 * @param fn - Migration function
	 * @returns Completed table definition
	 *
	 * @example
	 * ```typescript
	 * .migrate((row) => {
	 *   // row._v is typed as 1 | 2 for narrowing
	 *   if (row._v === 1) {
	 *     // row is narrowed to V1 type here
	 *     return { ...row, views: 0 };
	 *   }
	 *   // row is narrowed to V2 type here
	 *   return row;
	 * })
	 * ```
	 */
	migrate(
		fn: (
			row: InferVersionUnion<TVersions>,
		) => Omit<InferLatestVersionedOutput<TVersions>, '_v'>,
	): TableDefinition<TVersions>;
};

/**
 * A completed table definition ready for use.
 *
 * @typeParam TVersions - Tuple of all versioned schemas
 */
type TableDefinition<TVersions extends VersionedSchema<any, any>[]> = {
	/** Internal: tuple of versioned schemas */
	_versions: TVersions;

	/** Internal: union schema for validation */
	schema: StandardSchemaV1;

	/** Internal: migration function */
	migrate: (row: unknown) => unknown;

	/** Internal: latest version tag (for auto-injection on writes) */
	latestTag: VersionTag;
};
````

### TableHelper Types

````typescript
/**
 * Helper for a single versioned table.
 *
 * @typeParam TWriteRow - Row type for writes (no _v)
 * @typeParam TReadRow - Row type for reads (with _v)
 */
type TableHelper<
	TWriteRow extends { id: string },
	TReadRow extends { id: string; _v: VersionTag },
> = {
	// ═══════════════════════════════════════════════════════════════════════════
	// WRITE (auto-injects _v with latest version tag)
	// ═══════════════════════════════════════════════════════════════════════════

	/**
	 * Set a row (insert or replace).
	 *
	 * The `_v` field is automatically set to the latest version tag.
	 * You only need to provide the data fields.
	 *
	 * @param row - Row data (without _v)
	 *
	 * @example
	 * ```typescript
	 * // Definition has versions 1 and 2
	 * // Writes automatically get _v: 2
	 * posts.set({ id: '1', title: 'Hello', views: 0 });
	 * // Stored as: { id: '1', title: 'Hello', views: 0, _v: 2 }
	 * ```
	 */
	set(row: TWriteRow): void;

	// ═══════════════════════════════════════════════════════════════════════════
	// READ (returns rows with _v after migration)
	// ═══════════════════════════════════════════════════════════════════════════

	/**
	 * Get a row by ID.
	 *
	 * Returns the row migrated to latest version with `_v` field.
	 *
	 * @param id - Row ID
	 * @returns GetResult with status: 'valid' | 'invalid' | 'not_found'
	 *
	 * @example
	 * ```typescript
	 * const result = posts.get('1');
	 * if (result.status === 'valid') {
	 *   console.log(result.row._v); // 2 (latest)
	 *   console.log(result.row.views); // migrated field
	 * }
	 * ```
	 */
	get(id: string): GetResult<TReadRow>;

	/**
	 * Get all rows with validation status.
	 * All valid rows are migrated to latest version.
	 */
	getAll(): RowResult<TReadRow>[];

	/**
	 * Get all valid rows (skips invalid).
	 * All rows are migrated to latest version.
	 */
	getAllValid(): TReadRow[];

	// ... other methods same as before, using TReadRow for reads
};
````

---

## Implementation Details

### Schema Wrapping

When `.version(tag, schema)` is called, we create a wrapped schema that:

1. Validates the original schema
2. Injects `_v: tag` into the output

```typescript
function wrapSchemaWithVersion<TTag extends VersionTag>(
	schema: StandardSchemaV1,
	tag: TTag,
): StandardSchemaV1 {
	return {
		'~standard': {
			version: 1,
			vendor: 'epicenter',
			validate: (value) => {
				// First validate with original schema
				const result = schema['~standard'].validate(value);
				if (result instanceof Promise) {
					throw new TypeError('Async schemas not supported');
				}

				if (result.issues) {
					return result;
				}

				// Check _v if present in data matches tag
				const data = result.value as Record<string, unknown>;
				if ('_v' in data && data._v !== tag) {
					return {
						issues: [
							{
								message: `Version mismatch: expected _v=${tag}, got _v=${data._v}`,
								path: ['_v'],
							},
						],
					};
				}

				// Inject _v into output
				return {
					value: { ...data, _v: tag },
				};
			},
		},
	};
}
```

### Union Schema Creation

```typescript
function createVersionedUnionSchema(
	versions: Array<{ tag: VersionTag; schema: StandardSchemaV1 }>,
): StandardSchemaV1 {
	const wrappedSchemas = versions.map(({ tag, schema }) =>
		wrapSchemaWithVersion(schema, tag),
	);

	return {
		'~standard': {
			version: 1,
			vendor: 'epicenter',
			validate: (value) => {
				// Try each wrapped schema
				for (const schema of wrappedSchemas) {
					const result = schema['~standard'].validate(value);
					if (result instanceof Promise) {
						throw new TypeError('Async schemas not supported');
					}
					if (!result.issues) {
						return result; // Includes _v from wrapper
					}
				}

				return {
					issues: [
						{
							message: `Value did not match any schema version. Tried ${versions.length} version(s).`,
							path: [],
						},
					],
				};
			},
		},
	};
}
```

### Write Path (Auto-inject `_v`)

```typescript
function createTableHelper<TVersions extends VersionedSchema<any, any>[]>(
	ykv: YKeyValueLww<unknown>,
	definition: TableDefinition<TVersions>,
): TableHelper<InferWriteRow<TVersions>, InferReadRow<TVersions>> {
	return {
		set(row) {
			// Auto-inject _v with latest tag
			const rowWithVersion = {
				...row,
				_v: definition.latestTag,
			};
			ykv.set(row.id, rowWithVersion);
		},

		// ... other methods
	};
}
```

### Read Path (Validate + Migrate)

```typescript
function parseRow(id: string, raw: unknown): GetResult<TReadRow> {
	// Validate against union schema (injects _v based on which version matched)
	const result = definition.schema['~standard'].validate(raw);

	if (result.issues) {
		return { status: 'invalid', id, errors: result.issues, row: raw };
	}

	// Migrate to latest (migrate function handles version switching)
	const migrated = definition.migrate(result.value);

	// Ensure _v is set to latest (migrate may or may not include it)
	const finalRow = {
		...migrated,
		_v: definition.latestTag,
	};

	return { status: 'valid', row: finalRow };
}
```

### Migrate Function Behavior

The migrate function:

1. Receives row WITH `_v` (for type narrowing)
2. Returns row WITHOUT needing `_v` (implementation adds it)

```typescript
.migrate((row) => {
  // row has _v for narrowing
  if (row._v === 1) {
    // Narrowed to V1, add missing fields
    return { ...row, views: 0 };
    // Note: spreading row includes _v: 1, but implementation overwrites to latest
  }
  return row;
})
```

The implementation always overwrites `_v` to `latestTag` after migrate, so:

- User can include `_v` in return (it gets overwritten)
- User can omit `_v` in return (it gets added)
- Either way, stored data has correct `_v`

---

## Conflict Handling (Deferred)

### Current Behavior: Just Merge

For now, if user's schema has a `_v` field:

- Types merge via intersection: `UserSchema & { _v: TTag }`
- If compatible (`string` narrowing to literal), it works
- If incompatible (`number` vs string literal), type becomes weird but we don't error

### Future Enhancement

Later, we can add:

1. **Compile-time check** (type-level):

```typescript
version<TTag extends VersionTag, TSchema extends StandardSchemaV1>(
  tag: TTag,
  schema: '_v' extends keyof StandardSchemaV1.InferOutput<TSchema>
    ? "Error: Schema cannot contain reserved field '_v'"
    : TSchema,
): ...
```

2. **Runtime warning**:

```typescript
version(tag, schema) {
  // Check if schema output has _v
  const testResult = schema['~standard'].validate({ id: 'test' });
  if (testResult.value && '_v' in testResult.value) {
    console.warn(
      `[epicenter] Schema has '_v' field which will be overwritten. ` +
      `Consider removing '_v' from your schema.`
    );
  }
  // Continue normally
}
```

This is deferred to keep initial implementation simple.

---

## Complete Example

### Definition

```typescript
import { defineTable, createWorkspace } from 'epicenter/static';
import { type } from 'arktype';

// Define versioned table
const posts = defineTable()
	.version(1, type({ id: 'string', title: 'string' }))
	.version(2, type({ id: 'string', title: 'string', views: 'number' }))
	.version(
		3,
		type({
			id: 'string',
			title: 'string',
			views: 'number',
			author: 'string | null',
		}),
	)
	.migrate((row) => {
		// row._v is 1 | 2 | 3
		if (row._v === 1) {
			return { ...row, views: 0, author: null };
		}
		if (row._v === 2) {
			return { ...row, author: null };
		}
		return row;
	});

// Create workspace
const client = createWorkspace({
	id: 'blog',
	tables: { posts },
});
```

### Write Operations

```typescript
// Write - NO _v needed
client.tables.posts.set({
	id: '1',
	title: 'Hello World',
	views: 0,
	author: null,
});
// Stored as: { id: '1', title: 'Hello World', views: 0, author: null, _v: 3 }

// TypeScript enforces latest schema shape:
client.tables.posts.set({
	id: '2',
	title: 'Missing fields',
	// ❌ Error: missing 'views' and 'author'
});
```

### Read Operations

```typescript
// Read - returns row WITH _v
const result = client.tables.posts.get('1');

if (result.status === 'valid') {
	const row = result.row;
	// row type: { id: string; title: string; views: number; author: string | null; _v: 3 }

	console.log(row._v); // 3
	console.log(row.views); // 0
	console.log(row.author); // null
}

// Get all - all migrated to latest
const allPosts = client.tables.posts.getAllValid();
// type: Array<{ id: string; title: string; views: number; author: string | null; _v: 3 }>
```

### Observing Changes

```typescript
client.tables.posts.observe((changedIds) => {
	for (const id of changedIds) {
		const result = client.tables.posts.get(id);
		if (result.status === 'valid') {
			// Can use _v if needed (always latest for valid rows)
			console.log(`Post ${id} updated, version: ${result.row._v}`);
		}
	}
});
```

---

## Migration Guide

### From Current API

**Before:**

```typescript
const posts = defineTable()
	.version(type({ id: 'string', title: 'string', _v: '"1"' }))
	.version(type({ id: 'string', title: 'string', views: 'number', _v: '"2"' }))
	.migrate((row) => {
		if (row._v === '1') return { ...row, views: 0, _v: '2' as const };
		return row;
	});

posts.set({ id: '1', title: 'Hi', views: 0, _v: '2' });
```

**After:**

```typescript
const posts = defineTable()
	.version(1, type({ id: 'string', title: 'string' }))
	.version(2, type({ id: 'string', title: 'string', views: 'number' }))
	.migrate((row) => {
		if (row._v === 1) return { ...row, views: 0 };
		return row;
	});

posts.set({ id: '1', title: 'Hi', views: 0 });
```

**Changes:**

1. Move version from schema to first argument of `.version()`
2. Remove `_v` from schema definitions
3. Remove `_v` from migrate return
4. Remove `_v` from `.set()` calls
5. Change string tags to numbers (optional, strings still work)

### Data Compatibility

Existing stored data with `_v` fields will continue to work:

- Old data: `{ id: '1', title: 'Hi', _v: '1' }` (string)
- New definition: `.version(1, ...)` (number)

If you need to support both:

```typescript
.migrate((row) => {
  // Handle both old string and new number tags
  if (row._v === '1' || row._v === 1) {
    return { ...row, views: 0 };
  }
  return row;
});
```

Or keep using string tags to match existing data:

```typescript
.version('1', type({ ... }))
.version('2', type({ ... }))
```

---

## Implementation Checklist

### Phase 1: Core Implementation

- [ ] Add `VersionTag` type (`string | number`)
- [ ] Add `VERSION_KEY` constant (`'_v'`)
- [ ] Update `TableBuilder.version()` signature to `(tag, schema)`
- [ ] Implement `wrapSchemaWithVersion()` for schema wrapping
- [ ] Update `createVersionedUnionSchema()` to use wrapped schemas
- [ ] Store `latestTag` in `TableDefinition`
- [ ] Update `TableHelper.set()` to auto-inject `_v`
- [ ] Update `parseRow()` to ensure `_v` is latest after migrate
- [ ] Update `InferWriteRow` to exclude `_v`
- [ ] Update `InferReadRow` to include `_v`

### Phase 2: Tests

- [ ] Test numeric version tags
- [ ] Test string version tags
- [ ] Test mixed version tags (migration from string to number)
- [ ] Test write without `_v` stores with `_v`
- [ ] Test read returns `_v`
- [ ] Test migrate receives `_v` for narrowing
- [ ] Test TypeScript narrowing in migrate function
- [ ] Test existing data with old `_v` format

### Phase 3: Documentation

- [ ] Update JSDoc on all public APIs
- [ ] Update README examples
- [ ] Update existing spec references
- [ ] Add migration guide

### Phase 4: Future Enhancements (Deferred)

- [ ] Compile-time error for `_v` in user schema
- [ ] Runtime warning for `_v` in user schema
- [ ] Consider `_v` conflict detection in union validation

---

## Open Questions (Resolved)

1. **Should version tag be string only or string | number?**
   - **Resolved: Both** - `string | number` for flexibility

2. **Should `.set()` require `_v`?**
   - **Resolved: No** - Auto-injected (Option B)

3. **Should migrate return require `_v`?**
   - **Resolved: No** - Implementation adds it after migrate

4. **What about `_v` conflicts?**
   - **Resolved: Merge for now** - Add checks later

5. **What about existing data with different `_v` format?**
   - **Resolved: Handle in migrate** - User can check both formats
