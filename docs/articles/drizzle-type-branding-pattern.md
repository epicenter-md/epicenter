# Drizzle: Use $type<T>() for Branded Strings

> See [PR #1216](https://github.com/EpicenterHQ/epicenter/pull/1216) for the full context on this pattern.

## The Pattern

When you need a column with a branded TypeScript type but no actual data transformation, use `$type<T>()` instead of `customType`.

**The rule**: If `toDriver` and `fromDriver` would be identity functions `(x) => x`, use `$type<T>()` instead.

## Why This Matters

Even with identity functions, `customType` still invokes `mapFromDriverValue` on every row:

```typescript
// drizzle-orm/src/utils.ts - runs for EVERY column of EVERY row
const rawValue = row[columnIndex]!;
const value = rawValue === null ? null : decoder.mapFromDriverValue(rawValue);
```

Query 1000 rows with 3 date columns = 3000 function calls doing nothing.

## The Problem

```typescript
// Runtime overhead for identity functions
customType<{ data: DateTimeString; driverParam: DateTimeString }>({
	dataType: () => 'text',
	toDriver: (value) => value, // called on every write
	fromDriver: (value) => value, // called on every read
});
```

## The Solution

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

It returns `this` cast to a different type. No function registered, no `mapFromDriverValue` calls. The database stores TEXT, TypeScript sees `DateTimeString`, and the data stays as-is.

## When to Use customType

Only when data genuinely transforms between app and database:

```typescript
// JSON: object ↔ string - actual transformation needed
customType<{ data: UserPrefs; driverParam: string }>({
	toDriver: (value) => JSON.stringify(value),
	fromDriver: (value) => JSON.parse(value),
});
```

## The Broader Principle

This pattern supports a broader principle: **keep data in its intermediate representation until the last responsible moment**.

If data enters serialized and leaves serialized, keep it serialized in the middle. Parse at the edges where you actually need the rich representation. Typically UI components that need to render or edit the data.

For DateTimeString, this means keeping strings through the database layer, API layer, and frontend state. Only parse into `Temporal.ZonedDateTime` when a date-picker component needs it, then immediately serialize back after editing.
