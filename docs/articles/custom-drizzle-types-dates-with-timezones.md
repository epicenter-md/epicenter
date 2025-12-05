# Custom Types in Drizzle: Storing Dates with Time Zones

When building applications that need to track time accurately across different time zones, you need a robust way to store and retrieve temporal data. Here's how I implemented a custom date-with-timezone type in Drizzle ORM that maintains both the moment in time and its original timezone context.

## The Problem

SQLite doesn't have a native datetime type that preserves timezone information. You can store UTC timestamps, but you lose the context of which timezone the user was in when the event occurred. For many applications, knowing "3:00 PM Pacific" is more meaningful than just knowing the UTC timestamp.

## The Solution: Custom Type Implementation

I created a custom Drizzle type that bridges the gap between JavaScript's in-memory representation and SQLite's text storage:

```typescript
const dateWithTimezoneType = customType<{
    data: DateWithTimezoneType;
    driverData: DateWithTimezoneString;
}>({
    dataType: () => 'text',
    toDriver: (value: DateWithTimezoneType): DateWithTimezoneString =>
        value.toJSON(),
    fromDriver: (value: DateWithTimezoneString): DateWithTimezoneType =>
        DateWithTimezoneFromString(value),
});
```

## Understanding Data vs Driver Data

The type definition uses two key concepts:

- **`data`**: The in-memory JavaScript representation (`DateWithTimezoneType`) that your application code works with
- **`driverData`**: The serialized string format (`DateWithTimezoneString`) that gets stored in SQLite

Think of it as a translation layer: your application speaks in rich objects, but SQLite speaks in strings.

## The Serialization Strategy

The implementation relies on a clean separation between the in-memory and serialized representations:

```typescript
// In-memory representation
type DateWithTimezoneType = {
    date: Date;
    timezone: string;
    toJSON(): DateWithTimezoneString;  // Built-in serialization
}

// Serialized representation (stored in SQLite)
type DateWithTimezoneString = string;  // e.g., "2025-01-04T15:30:00-08:00[America/Los_Angeles]"
```

### Why toJSON()?

Instead of creating a standalone `serialize()` function, I embedded serialization directly into the type via `toJSON()`. This has two benefits:

1. **Namespacing**: The serialization logic lives with the type itself, not scattered across utility functions
2. **Natural integration**: JavaScript's `JSON.stringify()` automatically calls `toJSON()` when serializing objects, so you get correct serialization for free:

```typescript
const event = { timestamp: dateWithTimezone };
console.log(JSON.stringify(event));  // Automatically serializes the timestamp correctly
```

## How It Works

When you write to the database:

```typescript
// Application code works with rich objects
const appointment = {
    time: {
        date: new Date('2025-01-04T23:30:00Z'),
        timezone: 'America/Los_Angeles',
        toJSON: () => '2025-01-04T15:30:00-08:00[America/Los_Angeles]'
    }
};

// Drizzle calls toDriver(), which calls toJSON()
db.insert(appointments).values(appointment);
// Stores: "2025-01-04T15:30:00-08:00[America/Los_Angeles]"
```

When you read from the database:

```typescript
// SQLite returns: "2025-01-04T15:30:00-08:00[America/Los_Angeles]"

// Drizzle calls fromDriver()
const appointment = await db.select().from(appointments).get();

// You get back the full object:
// {
//   date: Date('2025-01-04T23:30:00Z'),
//   timezone: 'America/Los_Angeles',
//   toJSON: [Function]
// }
```

## The Lesson

Custom types in Drizzle are about creating clean boundaries between your application's domain model and the database's storage format. By leveraging JavaScript's built-in serialization protocol (`toJSON`), you can make these conversions feel natural and automatic rather than requiring explicit serialization calls throughout your codebase.

This pattern works for any scenario where SQLite's primitive types don't match your application's needs: structured data, custom number formats, encoded binary data, or in this case, timezone-aware timestamps.
