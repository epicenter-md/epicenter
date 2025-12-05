# Two Patterns for Serializing Custom Types in TypeScript

You're building a TypeScript application, and you have complex objects that need to persist somewhere. Maybe you're saving state to localStorage, sending data over an API, or storing records in a database. The problem is that these storage layers don't understand your custom types. They want simple representations: strings, plain objects, JSON.

So you need a way to convert your complex types to simple formats and back again. You need serialization and deserialization. And you want it to be type-safe, ergonomic, and hard to misuse.

I recently refactored our `DateWithTimezone` type from one serialization pattern to another, and the result was noticeably cleaner. Let me show you both patterns and why one works better for types you control.

## The Problem

Let's say you have a `DateWithTimezone` type:

```typescript
type DateWithTimezone = {
	date: Date;
	timezone: string;
};
```

This represents a point in time with timezone information. But you can't just throw this into a database or send it over an API. The `Date` object is complex, and you need a simple, portable representation.

You need to serialize it to something like a string, and deserialize it back to the full object. The question is: what's the best pattern for this?

## Pattern 1: Serialize/Deserialize Functions

The first approach is explicit serialization functions. You create a serializer object with two methods: one to serialize, one to deserialize.

Here's a generic `Serializer` factory function that enforces type safety:

```typescript
function Serializer<TValue, TSerialized>(config: {
	serialize(value: TValue): TSerialized;
	deserialize(serialized: TSerialized): TValue;
}) {
	return config;
}
```

This factory ensures that `serialize` and `deserialize` operate on the same types, giving you type-level guarantees that they're inverses of each other.

Now let's create a serializer for `DateWithTimezone`:

```typescript
const DateSerializer = Serializer({
	serialize(value: DateWithTimezone): string {
		return `${value.date.toISOString()}|${value.timezone}`;
	},
	deserialize(serialized: string): DateWithTimezone {
		const [isoUtc, timezone] = serialized.split('|');
		return { date: new Date(isoUtc), timezone };
	},
});
```

Usage looks like this:

```typescript
const myDate: DateWithTimezone = {
	date: new Date(),
	timezone: 'America/Los_Angeles',
};

const serialized = DateSerializer.serialize(myDate);
// "2025-01-15T10:30:00.000Z|America/Los_Angeles"

const deserialized = DateSerializer.deserialize(serialized);
// { date: Date, timezone: "America/Los_Angeles" }
```

This works. It's explicit. It's type-safe. But there are some downsides.

### The Downsides

First, you need to remember to import and use `DateSerializer` everywhere. Every time you want to serialize a `DateWithTimezone`, you have to write `DateSerializer.serialize(myDate)`. That's namespace pollution. Your code ends up littered with these serializer references.

Second, it doesn't integrate with JavaScript's native serialization mechanisms. If you try to `JSON.stringify(myDate)`, you'll get a serialized `Date` object (which is just an ISO string) and the timezone separately. You'd have to manually serialize first:

```typescript
// Doesn't work as expected
JSON.stringify({ myDate });

// You have to do this instead
JSON.stringify({ myDate: DateSerializer.serialize(myDate) });
```

This becomes tedious fast, especially when you're working with frameworks that automatically serialize responses. With Hono, for example, you'd have to manually serialize before calling `c.json()`. With Next.js API routes, same thing. The serialization is always a separate, manual step.

## Pattern 2: Factory Function with toJSON

Here's a different approach. Instead of external serialization functions, put the serialization logic on the object itself using JavaScript's `toJSON` protocol.

First, define the type with a `toJSON` method:

```typescript
type DateWithTimezone = {
	date: Date;
	timezone: string;
	toJSON(): string;
};
```

Then create a factory function that constructs instances of this type:

```typescript
function DateWithTimezone({
	date,
	timezone,
}: {
	date: Date;
	timezone: string;
}): DateWithTimezone {
	return {
		date,
		timezone,
		toJSON() {
			return `${date.toISOString()}|${timezone}`;
		},
	};
}
```

For deserialization, create a separate factory function:

```typescript
function DateWithTimezoneFromString(serialized: string): DateWithTimezone {
	const [isoUtc, timezone] = serialized.split('|');
	return DateWithTimezone({
		date: new Date(isoUtc),
		timezone,
	});
}
```

Now usage looks like this:

```typescript
const myDate = DateWithTimezone({
	date: new Date(),
	timezone: 'America/Los_Angeles',
});

// Serialize by calling toJSON directly
const serialized = myDate.toJSON();

// Or let JSON.stringify call it automatically
const json = JSON.stringify({ myDate });
// {"myDate":"2025-01-15T10:30:00.000Z|America/Los_Angeles"}

// Deserialize
const deserialized = DateWithTimezoneFromString(serialized);
```

### The Symmetry

Notice the beautiful symmetry here:

1. **String → Factory → Object with toJSON**
   `DateWithTimezoneFromString(string)` takes a simple string and returns a complex object with serialization logic built in.

2. **Object with toJSON → .toJSON() → String**
   Calling `.toJSON()` on the object returns you back to the simple string representation.

3. **Round-trip**
   `DateWithTimezoneFromString(myDate.toJSON())` recreates the original object.

The serialization and deserialization operations are clear inverses of each other, and the types guide you toward correct usage.

### The Benefits

This pattern has several advantages over Pattern 1:

**Natural namespacing**: The serialization logic lives on the object itself. You don't need a separate serializer object cluttering your imports and your code. The behavior is encapsulated where it belongs.

**Works with JSON.stringify**: This is the big one. `JSON.stringify` automatically calls `toJSON` if it exists on an object. That means your custom types work seamlessly with any code that uses `JSON.stringify` under the hood, which is practically everything. Framework serializers like Hono's `c.json()`, Next.js API routes, database drivers—they all just work. No manual serialization step required.

**Cleaner imports**: You only need to import the factory functions, not a serializer object. Just `import { DateWithTimezone, DateWithTimezoneFromString }`.

**More discoverable**: `toJSON` is a standard JavaScript method. If someone looks at your type definition, they immediately see that serialization is available. TypeScript's autocomplete will show the `toJSON` method. It's self-documenting.

**Less to remember**: With Pattern 1, you have to remember "DateSerializer.serialize" and "DateSerializer.deserialize". With Pattern 2, you just have the factory function and the standard `.toJSON()` method. Simpler mental model.

## When to Use Each Pattern

Both patterns are valid. The choice depends on your constraints.

**Use Pattern 1 when:**

- You can't modify the type (third-party library types, built-in types like `Date` or `Map`)
- You're serializing primitive types or simple objects
- You need to define multiple serialization formats for the same type

**Use Pattern 2 when:**

- You control the type definition (your own domain types)
- You want ergonomic, self-documenting code
- You want seamless integration with standard JavaScript serialization

In practice, Pattern 2 is almost always better for types you own. The ergonomic benefits and integration with `JSON.stringify` make it the clear winner.

## Real-World Example

We use Pattern 2 for `DateWithTimezone` in Epicenter's production layer. The flow looks like this:

```typescript
// Create a DateWithTimezone
const dateWithTimezone = DateWithTimezone({
	date: new Date(),
	timezone: 'UTC',
});

// Serialize: Object → String
const serialized: DateWithTimezoneString = dateWithTimezone.toJSON();

// Deserialize: String → Object
const restored = DateWithTimezoneFromString(serialized);
```

The pattern creates a clean cycle: factory functions construct objects with built-in serialization, and `.toJSON()` returns you to the string representation.

## Conclusion

Both serialization patterns serve the same purpose: converting complex types to simple representations and back. But Pattern 2 leverages JavaScript's built-in `toJSON` protocol, making your custom types first-class citizens in the serialization ecosystem.

If you control the type definition and you're not already using a library like zod or io-ts for serialization, give Pattern 2 a try. Put the `toJSON` method on the object, create a factory function, and let JavaScript's native serialization do the rest. Your code will be cleaner, your imports lighter, and your future self will thank you.
