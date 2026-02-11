---
name: drizzle-orm
description: Drizzle ORM patterns for type branding and custom types. Use when working with Drizzle column definitions, branded types, or custom type conversions.
---

# Drizzle ORM Guidelines

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
