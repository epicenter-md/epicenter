# Versioned Schemas with Migrate-on-Read

Most developers struggle with migrations in local-first apps. The core issue: how do you rename columns, change field types, or restructure data when that data is replicated across many clients with different app versions?

Epicenter solves this with a pattern we call **migrate-on-read**: store data in its original schema version, validate and migrate when reading.

## The Problem with Traditional Migrations

In a traditional database, migrations are applied once to all data:

```sql
ALTER TABLE posts ADD COLUMN views INTEGER DEFAULT 0;
```

Every row gets the new column. Done.

But in a local-first app:

- Data lives on many devices
- Devices might be offline for weeks
- Old app versions might still be writing data
- You can't run a migration "on the database" because there are thousands of databases

Running migrations on sync is fragile. What if the migration fails halfway? What if two clients sync different versions simultaneously?

## Migrate-on-Read

Instead of migrating data in place, Epicenter migrates when you read:

```typescript
// Storage contains original data:
{ id: "row-1", title: "Hello", _v: 1 }  // v1 schema (no views field)

// When you read:
const post = tables.posts.get("row-1");
// → { id: "row-1", title: "Hello", views: 0, _v: 3 }  // Migrated to v3
```

The migration function transforms old data to the latest schema on-the-fly. The original data stays untouched in storage.

**Key benefits:**

- No migrations to run
- Old and new clients can coexist
- Data is always valid when you use it
- Failed migrations don't corrupt storage

## Defining Versioned Schemas

You define schemas with `.version()` and provide a migration function with `.migrate()`:

```typescript
const posts = defineTable('posts')
	// V1: Original schema
	.version(
		type({
			id: 'string',
			title: 'string',
			_v: '1',
		}),
	)
	// V2: Added views counter
	.version(
		type({
			id: 'string',
			title: 'string',
			views: 'number',
			_v: '2',
		}),
	)
	// V3: Added tags
	.version(
		type({
			id: 'string',
			title: 'string',
			views: 'number',
			tags: 'string[]',
			_v: '3',
		}),
	)
	.migrate((row) => {
		// row is V1 | V2 | V3, must return V3
		switch (row._v) {
			case 1:
				return { ...row, views: 0, tags: [], _v: 3 };
			case 2:
				return { ...row, tags: [], _v: 3 };
			case 3:
				return row;
		}
	});
```

## How Validation Works

Internally, Epicenter creates a union of all your schemas using Standard Schema:

```typescript
function createUnionStandardSchema(
	schemas: StandardSchemaV1[],
): StandardSchemaV1 {
	return {
		'~standard': {
			version: 1,
			vendor: 'epicenter',
			validate: (value) => {
				for (const schema of schemas) {
					const result = schema['~standard'].validate(value);
					if (!result.issues) return result; // Found a match
				}
				return { issues: [{ message: 'No schema version matched' }] };
			},
		},
	};
}
```

When you read data:

1. Validate against the union (tries each schema until one matches)
2. Run the migration function to normalize to latest
3. Return strongly-typed latest version

**Library-agnostic by design.** Because we use Standard Schema (the common interface implemented by validation libraries), you can use ArkType, Zod, TypeBox, or Valibot. Mix and match if you want - they all work.

Note: ArkType automatically discriminates unions for O(1) performance. For other libraries, validation is O(n) where n = number of versions. For typical apps with 3-5 versions, this is negligible.

## The Discriminator Pattern

Every table schema includes a `_v` field — a number literal that identifies the schema version. The type system enforces this: passing a schema without `_v` to `defineTable()` is a compile error.

```typescript
.version(type({ id: 'string', title: 'string', _v: '1' }))
.version(type({ id: 'string', title: 'string', views: 'number', _v: '2' }))
```

This makes migrations a clean switch statement:

```typescript
.migrate((row) => {
  switch (row._v) {
      case 1: return { ...row, views: 0, _v: 2 };
      case 2: return row;
  }
})
```

## Migration Strategy: Incremental vs Direct

Your migration function receives any version and must return the latest. You have two choices:

**Incremental (v1→v2→v3):**

```typescript
.migrate((row) => {
  let current = row;
  if (current._v === 1) current = { ...current, views: 0, _v: 2 };
  if (current._v === 2) current = { ...current, tags: [], _v: 3 };
  return current;
})
```

**Direct (v1→v3):**

```typescript
.migrate((row) => {
  switch (row._v) {
    case 1: return { ...row, views: 0, tags: [], _v: 3 };
    case 2: return { ...row, tags: [], _v: 3 };
    case 3: return row;
  }
})
```

Both work. Direct is slightly more efficient (fewer object spreads) but incremental is easier to maintain as you add versions. The choice is yours - Epicenter doesn't enforce either pattern.

## Why a Single `.migrate()` Function?

We considered putting migrations on each `.version()` call:

```typescript
// Alternative API we didn't choose
.version(v1Schema)
.version(v2Schema, (v1) => ({ ...v1, views: 0 }))
.version(v3Schema, (v2) => ({ ...v2, tags: [] }))
```

We chose a single `.migrate()` at the end because:

1. **Full control** - You can implement incremental, direct, or hybrid strategies
2. **Simpler types** - The function receives a union and returns the latest
3. **Easier refactoring** - All migration logic in one place

The trade-off is you must handle all versions yourself, but TypeScript helps ensure you don't miss any.

## KV Storage

KV stores don't use versioning or migration. They use validate-or-default semantics—if stored data fails validation, it falls back to the default value:

```typescript
const fontSize = defineKv(type('number'), 14);
const mode = defineKv(type("'light' | 'dark' | 'system'"), 'light');

// Usage
client.kv.set('fontSize', 16);
client.kv.get('fontSize'); // 16 (valid) or 14 (invalid/missing)
```

This works because KV stores hold preferences, not accumulated data. Widening an enum (`'light' | 'dark'` to `'light' | 'dark' | 'system'`) still validates old data. Narrowing a type resets to the default—acceptable for a preference.

## Reads Are Pure

An important design decision: **reads don't write back migrated data**.

When you read a v1 row and get a v3 result, the storage still contains v1. We don't automatically persist the migration because:

- Reads causing writes is unexpected
- It would increase sync traffic
- It could cause conflicts if multiple clients read simultaneously

If you want to persist migrated data, do it explicitly:

```typescript
const result = tables.posts.get('post-1');
if (result.status === 'valid') {
	tables.posts.upsert(result.row); // Explicitly write back
}
```

## Storage: YKeyValue for Bounded Memory

Both tables and KV use YKeyValue (not Y.Map) for storage. Benchmarks show Y.Map has unbounded memory growth with frequent updates:

| Updates/Key | Y.Map   | YKeyValue |
| ----------- | ------- | --------- |
| 10          | 562 B   | 241 B     |
| 100         | 4.43 KB | 254 B     |
| 1000        | 44 KB   | 259 B     |

YKeyValue uses an append-and-cleanup pattern that keeps memory bounded regardless of update frequency.

## When to Use This Pattern

**Good fit:**

- Apps with evolving schemas (most apps)
- Document-style data edited by one user at a time
- Apps where data integrity matters more than concurrent field editing

**Consider alternatives if:**

- You need concurrent editing of individual fields
- Your schema is completely stable
- You're building a highly collaborative real-time editor

## Summary

1. Define table schemas with `.version()` for each schema evolution
2. Provide a `.migrate()` function that normalizes any version to latest
3. Tables require a `_v` number discriminant on every version (enforced by the type system)
4. KV stores use `defineKv(schema, defaultValue)` with validate-or-default semantics (no migration)
5. Table data is validated and migrated on read, not in storage

This approach eliminates "CRDT migration hell" by embracing row-level atomicity and lazy migration. Tables always see the latest schema shape, regardless of when the underlying data was written. KV stores take a simpler path—validate or reset to default.
