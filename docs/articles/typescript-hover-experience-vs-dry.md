# TypeScript Hover Experience vs DRY Principle

## The Problem with Extracted Base Types

When writing TypeScript, there's often a tension between following the DRY (Don't Repeat Yourself) principle and maintaining good developer experience. Here's a concrete example from our method helper types.

## The "Clean" Approach (Poor DX)

Initially, we might be tempted to extract shared properties into a base type:

```typescript
type BaseMethod<TSchema, TOutput> = {
  input: TSchema;
  handler: (input: StandardSchemaV1.InferOutput<TSchema>) => TOutput | Promise<TOutput>;
  description?: string;
};

export type QueryMethod<TSchema, TOutput> = BaseMethod<TSchema, TOutput> & {
  type: 'query';
};

export type MutationMethod<TSchema, TOutput> = BaseMethod<TSchema, TOutput> & {
  type: 'mutation';
};
```

This follows DRY perfectly - no duplicated type definitions. However, when you hover over `QueryMethod` in your IDE, you see:

```typescript
type QueryMethod<TSchema, TOutput> = BaseMethod<TSchema, TOutput> & {
  type: 'query';
}
```

This tells you almost nothing about what properties are actually available. You have to navigate to the `BaseMethod` definition to understand the full structure.

## The "Duplicated" Approach (Better DX)

Instead, we chose to inline the shared properties:

```typescript
export type QueryMethod<TSchema, TOutput> = {
  type: 'query';
  input: TSchema;
  handler: (input: StandardSchemaV1.InferOutput<TSchema>) => TOutput | Promise<TOutput>;
  description?: string;
};

export type MutationMethod<TSchema, TOutput> = {
  type: 'mutation';
  input: TSchema;
  handler: (input: StandardSchemaV1.InferOutput<TSchema>) => TOutput | Promise<TOutput>;
  description?: string;
};
```

Now when you hover over `QueryMethod`, you immediately see:

```typescript
type QueryMethod<TSchema, TOutput> = {
  type: 'query';
  input: TSchema;
  handler: (input: StandardSchemaV1.InferOutput<TSchema>) => TOutput | Promise<TOutput>;
  description?: string;
}
```

This gives you complete information at a glance - you can see exactly what properties are available without any additional navigation.

## The Trade-off

- **DRY Approach**: Less duplication, but poor discoverability
- **Inline Approach**: Some duplication, but excellent discoverability

## When to Choose Each Approach

### Choose DRY (extracted base types) when:
- The shared logic is complex and changes frequently
- The types are used internally and developers are familiar with the codebase
- The base type provides meaningful semantic value beyond just shared properties

### Choose Inline (duplication) when:
- The shared properties are simple and stable
- The types are part of a public API that developers need to discover
- Developer experience and discoverability are priorities
- The duplication is minimal (just a few properties)

## The Principle

**Developer experience often trumps theoretical code cleanliness.**

If duplicating a few lines of code makes your API more discoverable and easier to use, that's usually the right choice. The goal is to write code that's easy to understand and work with, not code that follows abstract principles at the expense of usability.

## Real-world Impact

In our case, someone using `defineQuery()` can hover over the function and immediately understand what properties they need to provide:

```typescript
const myQuery = defineQuery({
  input: mySchema,
  handler: (input) => { /* ... */ },
  description: "Fetches user data", // They can see this is optional
});
```

Without the inline approach, they'd have to hunt through type definitions to understand the full API surface.

## Conclusion

Sometimes the "messy" code is the right choice. When in doubt, optimize for the person who will be using your code (including future you) rather than abstract principles.