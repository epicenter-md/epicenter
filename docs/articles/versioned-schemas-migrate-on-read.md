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
// Storage carries the original data with a library-managed `_v` stamp:
//   { id: "row-1", title: "Hello", _v: 1 }   // v1 row in storage

// When you read, the library validates, migrates, and strips `_v` before
// returning the user-facing row:
const { data: post, error } = tables.posts.get("row-1");
// → post is { id: "row-1", title: "Hello", views: 0 }  // migrated to v3 shape
```

The migration function transforms old data to the latest schema on-the-fly. The original data stays untouched in storage.

**Key benefits:**

- No migrations to run
- Old and new clients can coexist
- Data is always valid when you use it
- Failed migrations don't corrupt storage

## Defining Versioned Schemas

Each version is a positional argument to `defineTable(...)`. `_v` is
library-managed, so you never declare it as a column or include it in the
migrate return value: the version is the argument position (1-indexed).
Multi-version tables require `.migrate(({ value, version }) => ...)`:

```typescript
import { column, defineTable } from '@epicenter/workspace';

const posts = defineTable(
	// V1: original schema
	{
		id: column.string(),
		title: column.string(),
	},
	// V2: added views counter
	{
		id: column.string(),
		title: column.string(),
		views: column.number(),
	},
	// V3: added tags
	{
		id: column.string(),
		title: column.string(),
		views: column.number(),
		tags: column.json(Type.Array(Type.String())),
	},
).migrate(({ value, version }) => {
	// `value` is narrowed to the matching version's user-facing columns.
	switch (version) {
		case 1:
			return { ...value, views: 0, tags: [] };
		case 2:
			return { ...value, tags: [] };
		case 3:
			return value;
	}
});
```

## How Validation Works

The library composes a per-version augmented schema (your user-facing columns
plus `_v: Type.Literal(N)`) and stores them keyed by version number. On read:

1. Read the `_v` stamp off the stored row to pick the matching version's schema
2. Validate the stored row against that schema with TypeBox's `Value.Check`
3. Strip `_v` and pass `{ value, version }` to your migrate function
4. Return the latest-shape row to the caller

Routing by stamped `_v` is O(1), and stripping `_v` from the migrate input
means the user's switch arm reads in terms of its own columns, never the
library's discriminator.

## The Discriminator Pattern

The library owns the discriminator. Each stored row carries a `_v` stamp that
the library writes on every `set` and reads on every `get`. Users never type
`_v` in column declarations, write calls, or migrate returns: the version is
the positional argument index in `defineTable(v1, v2, ...)`.

The migrate function receives `{ value, version }` where `version` is the
1-indexed schema number. `switch (version)` narrows `value` to the matching
version's user-facing columns:

```typescript
.migrate(({ value, version }) => {
  switch (version) {
    case 1: return { ...value, views: 0 };
    case 2: return value;
  }
})
```

## Migration Strategy: Direct

Your migrate function receives any version's `value` and must return the
latest user-facing row. Direct (each case returns the latest shape) is the
ergonomic default because the discriminated union narrows `value` per case:

```typescript
.migrate(({ value, version }) => {
  switch (version) {
    case 1: return { ...value, views: 0, tags: [] };
    case 2: return { ...value, tags: [] };
    case 3: return value;
  }
})
```

Epicenter doesn't enforce a strategy; if you prefer to chain through helpers,
you can, but you can't reassign `value` and re-narrow without re-discriminating
because the discriminator now lives on `version`, not on the value.

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

KV stores don't use versioning or migration. They use validate-or-default semantics: if stored data fails validation, it falls back to the default value. The default is a factory (`() => value`) so every consumer gets a fresh instance:

```typescript
import { column, defineKv } from '@epicenter/workspace';

const fontSize = defineKv(column.number(), () => 14);
const mode = defineKv(column.enum(['light', 'dark', 'system']), () => 'light' as const);

// Usage
kv['fontSize'].set(16);
kv['fontSize'].get(); // 16 (valid) or 14 (invalid/missing)
```

This works because KV stores hold preferences, not accumulated data. Widening an enum (`'light' | 'dark'` to `'light' | 'dark' | 'system'`) still validates old data. Narrowing a type resets to the default. Acceptable for a preference.

## Reads Are Pure

An important design decision: **reads don't write back migrated data**.

When you read a v1 row and get a v3 result, the storage still contains v1. We don't automatically persist the migration because:

- Reads causing writes is unexpected
- It would increase sync traffic
- It could cause conflicts if multiple clients read simultaneously

If you want to persist migrated data, do it explicitly:

```typescript
const { data: row, error } = tables.posts.get('post-1');
if (!error && row) {
	tables.posts.set(row); // explicitly stamp the latest version
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

1. Pass each version's columns to `defineTable(v1, v2, ...)` in order
2. Multi-version tables require `.migrate(({ value, version }) => ...)`; single-version tables don't migrate
3. `_v` is library-managed: never declared, never written, never returned to user code
4. KV uses `defineKv(schema, () => defaultValue)` with validate-or-default semantics (no migration)
5. Table data is validated and migrated on read, not in storage

This approach eliminates "CRDT migration hell" by embracing row-level atomicity and lazy migration. Tables always see the latest schema shape, regardless of when the underlying data was written. KV stores take a simpler path: validate or reset to default.
