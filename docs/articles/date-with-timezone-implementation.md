# How Epicenter Implements DateTime in "2024-01-01T20:00:00.000Z|America/New_York" Format

## The Problem

Working with dates and timezones in databases is notoriously tricky. Most databases either:
- Store dates without timezone info (losing crucial context)
- Have complex timezone types that vary between database engines
- Force you to always store in UTC and handle timezone conversion in application code

We wanted something better: a consistent way to store dates with their timezone information that works across database engines and provides a great developer experience.

## Our Solution: The "ISO_UTC|TIMEZONE" Format

We store dates as text in a simple, human-readable format:
```
2024-01-01T20:00:00.000Z|America/New_York
```

This format has several advantages:
- **Human readable**: You can see both the UTC time and the original timezone
- **Sortable**: ISO strings sort chronologically
- **Portable**: Works in any database that supports text columns
- **Lossless**: Preserves both the moment in time and the timezone context

## The Type System

We built a robust type system around this storage format using TypeScript branded types:

```typescript
// ISO 8601 UTC datetime string from Date.toISOString()
export type UtcIsoString = string & Brand<'UtcIsoString'>;

// IANA timezone identifier
export type TimezoneId = string & Brand<'TimezoneId'>;

// The storage format (what goes in the database)
export type DateTimeWithTimezoneString = `${UtcIsoString}|${TimezoneId}` &
    Brand<'DateTimeWithTimezoneString'>;

// The application format (what developers work with)
export type DateTimeWithTimezone = {
    date: Date;      // JavaScript Date object
    timezone: string; // IANA timezone identifier
};
```

The branded types prevent accidental string misuse - you can't accidentally pass a regular string where a `DateTimeWithTimezoneString` is expected, and the template literal type ensures the storage format is properly structured.

## The Drizzle Custom Type

At the heart of our implementation is a Drizzle custom type that bridges the gap between our application types and database storage:

```typescript
const dateTimeWithTimezoneType = customType<{
    data: DateTimeWithTimezone;           // What the app sees
    driverData: DateTimeWithTimezoneString;   // What gets stored
}>({
    dataType: () => 'text',
    toDriver: (value: DateTimeWithTimezone): DateTimeWithTimezoneString =>
        DateTimeWithTimezoneSerializer.serialize(value),
    fromDriver: (value: DateTimeWithTimezoneString): DateTimeWithTimezone =>
        DateTimeWithTimezoneSerializer.deserialize(value),
});
```

This creates a clean separation:
- **Application layer**: Works with `{ date: Date, timezone: string }` objects
- **Database layer**: Stores as `"ISO_UTC|TIMEZONE"` strings
- **Drizzle**: Handles the conversion automatically

## The Serializer Pattern

We implemented a general-purpose serializer pattern that can be reused for other custom types:

```typescript
export function Serializer<TStorage, TInput extends any[], TOutput>(config: {
    serialize(...args: TInput): TStorage;
    deserialize(storage: TStorage): TOutput;
}) {
    return config;
}
```

For dates with timezone, this becomes:

```typescript
export const DateTimeWithTimezoneSerializer = Serializer({
    serialize(value: Date | DateTimeWithTimezone): DateTimeWithTimezoneString {
        const { date, timezone } = normalizeToDateTimeWithTimezone(value);
        const isoUtc = date.toISOString();
        return asDateTimeWithTimezoneString(`${isoUtc}|${timezone}`);
    },

    deserialize(storage: DateTimeWithTimezoneString): DateTimeWithTimezone {
        const [isoUtc, timezone] = storage.split('|');
        if (!isoUtc || !timezone) {
            throw new Error(`Invalid DateTimeWithTimezone format: ${storage}`);
        }
        return {
            date: new Date(isoUtc),
            timezone,
        };
    },
});
```

## Smart Normalization

One of the key UX decisions was allowing developers to pass either a `Date` or a full `DateTimeWithTimezone` object. When they pass just a `Date`, we automatically use their system timezone:

```typescript
function normalizeToDateTimeWithTimezone(
    value: Date | DateTimeWithTimezone,
): DateTimeWithTimezone {
    if (value instanceof Date) {
        const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
        return { date: value, timezone };
    }
    return value;
}
```

This normalization happens:
1. **In the serializer** when converting to storage format
2. **In default value handling** for column definitions

## The DateTime Column Function

The user-facing API is a `datetime()` function that creates these custom columns:

```typescript
export function datetime({
    nullable = false,
    unique = false,
    default: defaultValue,
}: {
    nullable?: boolean;
    unique?: boolean;
    default?: Date | DateTimeWithTimezone | (() => Date | DateTimeWithTimezone);
} = {}) {
    const dateTimeWithTimezoneType = customType<{
        data: DateTimeWithTimezone;
        driverData: DateTimeWithTimezoneString;
    }>({
        dataType: () => 'text',
        toDriver: (value: DateTimeWithTimezone): DateTimeWithTimezoneString =>
            DateTimeWithTimezoneSerializer.serialize(value),
        fromDriver: (value: DateTimeWithTimezoneString): DateTimeWithTimezone =>
            DateTimeWithTimezoneSerializer.deserialize(value),
    });

    let column = dateTimeWithTimezoneType();

    if (!nullable) column = column.notNull();
    if (unique) column = column.unique();

    if (defaultValue !== undefined) {
        column =
            typeof defaultValue === 'function'
                ? column.$defaultFn(() => normalizeToDateTimeWithTimezone(defaultValue()))
                : column.default(normalizeToDateTimeWithTimezone(defaultValue));
    }

    return column;
}
```

## Usage Examples

### Basic Usage
```typescript
import { datetime } from './columns';

// Simple datetime column (NOT NULL by default)
const createdAt = datetime();

// Nullable datetime column
const deletedAt = datetime({ nullable: true });

// DateTime with default value (uses system timezone)
const publishedAt = datetime({ default: new Date() });

// DateTime with specific timezone
const scheduledAt = datetime({
    default: {
        date: new Date(),
        timezone: 'America/New_York'
    }
});

// Dynamic default with function
const updatedAt = datetime({ default: () => new Date() });
```

### In Table Definitions
```typescript
export const posts = table('posts', {
    id: id(),
    title: text(),
    content: text(),
    createdAt: datetime(),
    publishedAt: datetime({ nullable: true }),
    scheduledFor: datetime({
        default: {
            date: new Date(),
            timezone: 'UTC'
        }
    }),
});
```

### Working with the Data
```typescript
// Insert - can use Date or DateTimeWithTimezone
await db.insert(posts).values({
    title: 'Hello World',
    content: 'This is my first post',
    createdAt: new Date(), // Uses system timezone
    publishedAt: {
        date: new Date(),
        timezone: 'America/New_York'
    },
});

// Select - always returns DateTimeWithTimezone
const post = await db.select().from(posts).where(eq(posts.id, '123'));
console.log(post.createdAt); // { date: Date, timezone: string }
```

## Why This Approach Works

### 1. **Type Safety**
The branded types prevent string confusion, and the custom type ensures proper conversion at the boundaries.

### 2. **Developer Experience**
Developers can pass a simple `Date` for convenience, but get back rich timezone information when they need it.

### 3. **Performance**
- Normalization is O(1) object creation, not string parsing
- Serialization only happens at database boundaries
- No unnecessary conversions in application code

### 4. **Portability**
The storage format works in any SQL database that supports text columns.

### 5. **Debuggability**
You can examine the database directly and see both the UTC time and timezone in a human-readable format.

## Design Decisions Explained

### Why Not Store Separate Columns?
We considered storing `utc_timestamp` and `timezone` as separate columns, but this approach has downsides:
- More complex queries (always need to join both columns)
- Easy to forget the timezone column
- Takes more storage space

### Why Not Use Database-Native Timezone Types?
Database timezone support varies significantly:
- PostgreSQL has good timezone support, but SQLite doesn't
- MySQL timezone support is limited
- We wanted a solution that works everywhere

### Why the Pipe Separator?
- It's not a valid character in ISO dates or timezone names
- It's human-readable and debuggable
- It makes parsing simple and unambiguous

### Why Serialize as ISO UTC?
- ISO format is sortable and standardized
- Storing as UTC avoids timezone calculation bugs
- The original timezone is preserved separately

## Future Extensibility

The serializer pattern we've built is general-purpose and can be extended for other custom types:

```typescript
// Example: JSON with schema validation
const ValidatedJSON = Serializer({
    serialize(value: MyType): string {
        validateSchema(value);
        return JSON.stringify(value);
    },
    deserialize(storage: string): MyType {
        const parsed = JSON.parse(storage);
        validateSchema(parsed);
        return parsed;
    },
});

// Example: Encrypted strings
const EncryptedText = Serializer({
    serialize(value: string): string {
        return encrypt(value);
    },
    deserialize(storage: string): string {
        return decrypt(storage);
    },
});
```

This pattern gives us a consistent way to handle complex data types with proper serialization, validation, and type safety.

## Conclusion

This datetime with timezone implementation gives us the best of both worlds: a simple, portable storage format with a rich, type-safe application interface. The normalization logic makes it easy to use while the serializer pattern keeps the implementation clean and extensible.

The key insight is that we don't need complex database features when we can build elegant abstractions in the type system. By storing a simple text format and handling conversion at the boundaries, we get consistency, portability, and great developer experience.