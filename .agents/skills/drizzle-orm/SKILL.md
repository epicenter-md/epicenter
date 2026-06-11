---
name: drizzle-orm
description: 'Drizzle ORM patterns: schema definitions, Drizzle Kit migrations, query builders, type branding, custom types, SQLite, Postgres, D1, and Turso/libSQL boundaries. Use when mentioning Drizzle, drizzle-orm, DB schemas, migrations, branded column types, or typed SQL queries.'
metadata:
  author: epicenter
  version: '1.0'
---

# Drizzle ORM Guidelines
## Reference Repositories

- [Drizzle ORM](https://github.com/drizzle-team/drizzle-orm) : TypeScript ORM with SQL-like query builder
- [Turso](https://github.com/tursodatabase/turso) : Edge-hosted LibSQL database (Epicenter's database)

## Upstream Grounding

When Drizzle schema definitions, migration snapshots, query builder APIs, column typing, custom types, or driver integration affect correctness, use source-backed grounding before relying on memory. If DeepWiki MCP is available, ask a narrow question against `drizzle-team/drizzle-orm`; for libSQL, Turso sync, embedded replicas, D1 compatibility, or remote SQLite behavior, ask against `tursodatabase/turso`. If DeepWiki is unavailable or the repo is not indexed, use upstream source or official docs directly. Treat DeepWiki as orientation, then verify decisive details against local installed types, generated migrations, source, driver versions, or official docs before changing code.

Skip DeepWiki for repo-local schema naming and storage-boundary conventions already documented below.

## When to Apply This Skill

Use this pattern when you need to:

- Define Drizzle schemas, relations, indexes, migrations, or query code.
- Define Drizzle columns that use branded TypeScript string types.
- Choose between `$type<T>()` and `customType` for column definitions.
- Configure Drizzle Kit and understand generated migration snapshots.
- Choose a SQLite-compatible driver boundary: `bun:sqlite`, `better-sqlite3`, D1, or libSQL/Turso.
- Remove identity `toDriver`/`fromDriver` conversions that add runtime overhead.
- Keep data serialized through the storage layer and parse at UI edges.

## Schema And Migration Rules

- Export a single schema object from the app's database module and pass that same object to `drizzle(...)` and Drizzle Kit config.
- Keep table definitions, relations, and schema exports explicit. Avoid dynamic schema construction that Drizzle Kit cannot statically inspect.
- Treat Drizzle Kit snapshots as the diff source of truth. Review generated SQL and snapshot changes together.
- Pick a casing strategy once per database. Do not mix app-level camelCase with ad hoc SQL aliases unless the boundary owns that mapping.
- Use `drizzle-zod`, `drizzle-valibot`, or a local schema parser at IO boundaries when external input becomes a row. Do not treat inferred insert types as runtime validation.

## Query Builder Rules

- Prefer the typed query builder for application queries. Use raw SQL only for expressions the query builder cannot express cleanly.
- Keep joins and selected shapes near the caller that owns the response contract.
- Add indexes in schema beside the query pattern that needs them.

## Driver Boundaries

- `bun:sqlite` and `better-sqlite3` are local synchronous SQLite drivers. Do not use them in Cloudflare Workers.
- D1 is a Cloudflare binding with Worker-specific behavior. Keep it behind Worker code and generated bindings.
- libSQL and Turso are SQLite-compatible but have network, sync, and compatibility details that are not generic SQLite. Use the `turso` skill for those decisions.

## Use $type<T>() for Branded Strings, Not customType

When you need a column with a branded TypeScript type but no actual data transformation, use `$type<T>()` instead of `customType`.

### The Rule

If `toDriver` and `fromDriver` would be identity functions `(x) => x`, use `$type<T>()` instead.

### Why

Even with identity functions, `customType` still invokes `mapFromDriverValue` on every row:

```typescript
// drizzle-orm/src/utils.ts - runs for EVERY column of EVERY row
const rawValue = row[columnIndex]!;
const value = rawValue === null ? null : decoder.mapFromDriverValue(rawValue);
```

Query 1000 rows with 3 date columns = 3000 function calls doing nothing.

### Bad Pattern

```typescript
// Runtime overhead for identity functions
customType<{ data: DateTimeString; driverParam: DateTimeString }>({
	dataType: () => 'text',
	toDriver: (value) => value, // called on every write
	fromDriver: (value) => value, // called on every read
});
```

### Good Pattern

```typescript
// Zero runtime overhead - pure type assertion
text().$type<DateTimeString>();
```

`$type<T>()` is a compile-time-only type override:

```typescript
// drizzle-orm/src/column-builder.ts
$type<TType>(): $Type<this, TType> {
  return this as $Type<this, TType>;
}
```

### When to Use customType

Only when data genuinely transforms between app and database:

```typescript
// JSON: object ↔ string - actual transformation
customType<{ data: UserPrefs; driverParam: string }>({
	toDriver: (value) => JSON.stringify(value),
	fromDriver: (value) => JSON.parse(value),
});
```

## Keep Data in Intermediate Representation

Prefer keeping data serialized (strings) through the system, parsing only at the edges (UI components).

**The principle**: If data enters serialized and leaves serialized, keep it serialized in the middle. Parse at the edges where you actually need the rich representation.

### Example: DateTimeString

Instead of parsing `DateTimeString` into `Temporal.ZonedDateTime` at the database layer:

```typescript
// Bad: parse on every read, re-serialize at API boundaries
customType<{ data: Temporal.ZonedDateTime; driverParam: string }>({
	fromDriver: (value) => fromDateTimeString(value),
});
```

Keep it as a string until the UI actually needs it:

```typescript
// Good: string stays string, parse only in date-picker component
text().$type<DateTimeString>();

// In UI component:
const temporal = fromDateTimeString(row.createdAt);
// After edit:
const updated = toDateTimeString(temporal);
```
