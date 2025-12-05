# Functions Are Objects Too: Why I Made Actions Callable

I was designing the action system for Epicenter and hit an interesting decision: how do you create an API that's both ergonomic to call AND provides access to metadata?

The problem sounds simple until you try to solve it. You want developers to write `action({ id: '123' })` for clean invocation. But you also need access to the action's input schema for type inference, validation, and composition. These feel like competing goals.

Here's what I mean. If actions are objects, you get metadata but verbose calls:

```typescript
const action = {
  input: Type.Object({ id: Type.String() }),
  handler: async ({ id }) => { /* ... */ }
};

// Verbose - requires .handler()
action.handler({ id: '123' });

// But you get metadata
action.input; // Type.Object(...)
```

If actions are bare functions, you get clean calls but no metadata:

```typescript
const action = async ({ id }) => { /* ... */ };

// Clean invocation
action({ id: '123' });

// But where's the schema?
action.input; // undefined ❌
```

Neither option gave me what I wanted. I needed both clean invocation AND metadata access.

## The Insight

Then it hit me: functions in JavaScript are objects. I can have my cake and eat it too.

What if the action itself is callable (the handler IS the action), but I attach metadata as properties on the function? That would give me:
- `action(input)` for invocation
- `action.input` for metadata access
- `action.type` to distinguish queries from mutations

No `.handler()` suffix. No wrapper objects. Just a function with extra properties.

## The Implementation

`Object.assign` makes this elegant:

```typescript
export function defineQuery<
  TOutput,
  TInput extends TSchema | undefined = undefined,
>(config: {
  input?: TInput;
  handler: (
    input: TInput extends TSchema ? Static<TInput> : undefined,
  ) =>
    | Result<TOutput, EpicenterOperationError>
    | Promise<Result<TOutput, EpicenterOperationError>>;
  description?: string;
}): QueryAction<TInput, TOutput> {
  return Object.assign(config.handler, {
    type: 'query' as const,
    input: config.input,
    description: config.description,
  });
}
```

That's it. `Object.assign` takes the handler function and attaches metadata properties to it. The function is still callable, but now it carries its schema and type information.

Usage looks like this:

```typescript
const getUserById = defineQuery({
  input: Type.Object({ id: Type.String() }),
  handler: async ({ id }) => {
    // ... fetch user
  },
  description: 'Get a user by ID'
});

// Call it directly - no .handler() needed
getUserById({ id: '123' });

// Access metadata - it's right there
getUserById.input;       // Type.Object(...)
getUserById.type;        // 'query'
getUserById.description; // 'Get a user by ID'
```

## The Type System

The tricky part was getting TypeScript to understand this. I wanted:
- Actions with parameters: `action({ id: '123' })`
- Actions without parameters: `action(undefined)`
- Full type inference from the schema

The unified base type uses conditional types to make this work:

```typescript
export type Action<
  TType extends 'query' | 'mutation',
  TInput extends TSchema | undefined = TSchema | undefined,
  TOutput = unknown,
> = {
  // Callable signature with conditional input type
  (input: TInput extends TSchema ? Static<TInput> : undefined):
    | Result<TOutput, EpicenterOperationError>
    | Promise<Result<TOutput, EpicenterOperationError>>;
  // Metadata properties
  type: TType;
  input?: TInput;
  description?: string;
};
```

The key line is `input: TInput extends TSchema ? Static<TInput> : undefined`. This tells TypeScript:
- If you have a schema, infer the parameter type from it
- If you don't have a schema, the parameter is `undefined`

Then I created type aliases for queries and mutations:

```typescript
export type QueryAction<
  TInput extends TSchema | undefined = TSchema | undefined,
  TOutput = unknown,
> = Action<'query', TInput, TOutput>;

export type MutationAction<
  TInput extends TSchema | undefined = TSchema | undefined,
  TOutput = unknown,
> = Action<'mutation', TInput, TOutput>;
```

This keeps the API clean while sharing the underlying implementation. I can add specialized behavior for queries vs mutations later if needed.

## What This Enables

The real payoff comes from composability. When every action carries its own metadata, you can:

**Introspect actions for validation**: Check the input schema before calling the action, or validate user input against it.

**Generate APIs automatically**: Read `action.type`, `action.input`, and `action.description` to build REST endpoints or GraphQL resolvers without manual configuration.

**Compose actions**: Pass actions as arguments to other functions, knowing they carry their schemas. Build higher-order actions that wrap or combine existing ones.

**Type-safe clients**: The schema lives with the action, so TypeScript can infer parameter types throughout your codebase. Change the schema in one place, and all call sites update automatically.

Here's a concrete example from Epicenter. The library merges actions from different sources (indexes, table helpers, dependencies) into a unified client interface:

```typescript
const client = await createWorkspaceClient(workspace);

// All of these are callable actions with metadata
client.indexes.getUserById({ id: '123' });
client.tables.users.create({ email: 'test@example.com' });
client.deps.auth.login({ email: '...', password: '...' });

// Every action exposes its schema
client.indexes.getUserById.input; // Type.Object({ id: Type.String() })
client.tables.users.create.type;  // 'mutation'
```

Each action knows what it is and what it expects. No separate configuration files. No manual type annotations. The metadata travels with the function.

## The Lesson

When you're designing an API, look for the hidden flexibility in your platform. JavaScript functions are objects, so they can carry properties. That's not a weird hack - it's how methods on prototypes work, how bind() works, how the language itself works.

I almost built a wrapper object with separate `.handler()` and `.input` properties because that felt "cleaner." But the simpler solution was right there: just attach the properties to the function itself.

The pattern works because it aligns with how developers already think. You call an action by calling it. You access its metadata by accessing its properties. The function is the action, and the action is the function. No mental model mismatch. No ceremony.

Not every data access pattern needs this level of sophistication. But when you're building a library that composes multiple sources of functionality and needs to generate type-safe clients, having metadata attached to your functions changes what's possible.
