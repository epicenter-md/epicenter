# Lazy Conversion with Drizzle Custom Types

> See [PR #1216](https://github.com/EpicenterHQ/epicenter/pull/1216) for the full context on this pattern.

**TL;DR**: Drizzle's `toDriver`/`fromDriver` run synchronously on every row. Keep data in its intermediate representation until the very last moment you actually need the rich type.

## Why This Matters

From Drizzle's source, `fromDriver` runs in `mapResultRow` for every column of every row:

```typescript
// drizzle-orm/src/utils.ts
const rawValue = row[columnIndex]!;
const value = rawValue === null ? null : decoder.mapFromDriverValue(rawValue);
```

Query 1000 rows with 3 date columns = 3000 synchronous `fromDriver` calls. If `fromDriver` does parsing (JSON, dates, validation), that's 3000 blocking operations before your code sees the data.

## The Realization

I was storing dates with timezones as strings in SQLite. My initial instinct was to parse them into `Temporal.ZonedDateTime` objects on read, giving me nice date math capabilities. But then I traced where that data actually goes:

1. SQLite stores `"2024-01-01T20:00:00.000Z|America/New_York"` (string)
2. Drizzle reads it, `fromDriver` parses to `Temporal.ZonedDateTime` (object)
3. API endpoint serializes response, date becomes string again
4. Frontend receives string, might parse it for display
5. User edits in a date-time picker (needs rich object briefly)
6. Component serializes back to string immediately
7. String travels back through API to database

The rich `Temporal` object only mattered for that brief moment in the date-time picker. Every other step was string → object → string → object → string for no reason.

I'd rather keep it in the intermediate string representation the whole way. Parse it lazily, right at the UI component that needs it, then serialize immediately after.

## The Pattern

Instead of converting eagerly at the database layer:

```typescript
// Eager: parse on every read, even if you're just passing it through
customType<{ data: Temporal.ZonedDateTime; driverParam: string }>({
	toDriver: (value) => toDateTimeString(value),
	fromDriver: (value) => fromDateTimeString(value), // runs N times per query
});
```

Keep data serialized and convert only when needed:

```typescript
// Lazy: strings stay strings until you need them
text().$type<DateTimeString>();

// In your date-time picker component, finally parse it
const temporal = fromDateTimeString(row.createdAt);
// User edits...
const updated = toDateTimeString(temporal);
// Immediately back to string for the return trip
```

## When You Actually Need the Rich Type

The "last responsible moment" is usually UI binding:

- Date picker needs a `Date` or `Temporal` object to render calendars and handle selection
- Rich text editor needs parsed document structure for editing
- Form validation might need typed objects for complex rules

But for everything else in between. API responses, logging, storage, passing between services. The serialized string works fine and is arguably better. These are all just passing the data through; they don't need to understand the date, just move it. We will lazily parse it.

## The Rule

If data enters serialized and leaves serialized, keep it serialized in the middle. Parse at the edges where you actually need the rich representation.
