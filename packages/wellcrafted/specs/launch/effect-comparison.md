# Well Crafted vs Effect-TS: A Detailed Comparison

## Quick Overview

| Feature | Effect-TS | Well Crafted |
|---------|-----------|--------------|
| Result Types | ✅ Effect<A, E, R> | ✅ Result<T, E> |
| Tagged Errors | ✅ Class-based | ✅ Object-based |
| Async Handling | Generators/Fibers | async/await |
| Bundle Size | ~50KB+ | ~4KB |
| Learning Curve | Steep | Gentle |
| Dependencies | Many | Zero |
| Serialization | Complex | Native |
| Type Inference | Powerful but complex | Simple and predictable |
| Ecosystem | Comprehensive | Focused |

## Code Comparison

### Basic Error Handling

**Effect-TS:**
```typescript
import { Effect } from "effect";

const divide = (a: number, b: number): Effect.Effect<number, DivisionError> =>
  b === 0
    ? Effect.fail(new DivisionError("Cannot divide by zero"))
    : Effect.succeed(a / b);

// Usage requires generator syntax
const program = Effect.gen(function* (_) {
  const result = yield* _(divide(10, 2));
  console.log(result);
});

Effect.runPromise(program);
```

**Well Crafted:**
```typescript
import { Result, Ok, Err } from "wellcrafted/result";

function divide(a: number, b: number): Result<number, MathError> {
  if (b === 0) {
    return Err({
      name: "MathError",
      message: "Cannot divide by zero",
      context: { numerator: a, denominator: b },
      cause: undefined
    });
  }
  return Ok(a / b);
}

// Usage with familiar patterns
const { data, error } = divide(10, 2);
if (error) {
  console.error(error.message);
} else {
  console.log(data);
}
```

### Async Operations

**Effect-TS:**
```typescript
import { Effect } from "effect";

const fetchUser = (id: string) =>
  Effect.tryPromise({
    try: () => fetch(`/api/users/${id}`).then(r => r.json()),
    catch: (error) => new NetworkError({ error })
  });

const program = Effect.gen(function* (_) {
  const user = yield* _(fetchUser("123"));
  const posts = yield* _(fetchUserPosts(user.id));
  return { user, posts };
});
```

**Well Crafted:**
```typescript
import { tryAsync } from "wellcrafted/result";

async function fetchUser(id: string) {
  return tryAsync<User, NetworkError>({
    try: async () => {
      const response = await fetch(`/api/users/${id}`);
      return response.json();
    },
    mapErr: (error) => Err({
      name: "NetworkError",
      message: "Failed to fetch user",
      context: { userId: id },
      cause: error
    })
  });
}

// Just use async/await
const { data: user, error } = await fetchUser("123");
if (error) return handleError(error);

const { data: posts } = await fetchUserPosts(user.id);
```

### Error Composition

**Effect-TS:**
```typescript
class ValidationError {
  readonly _tag = "ValidationError";
  constructor(readonly field: string, readonly message: string) {}
}

class NetworkError {
  readonly _tag = "NetworkError";
  constructor(readonly status: number) {}
}

type AppError = ValidationError | NetworkError;

const program = pipe(
  validateInput(data),
  Effect.flatMap(saveToApi),
  Effect.catchTag("ValidationError", (e) => 
    Effect.succeed({ fallback: true })
  )
);
```

**Well Crafted:**
```typescript
type ValidationError = TaggedError<"ValidationError">;
type NetworkError = TaggedError<"NetworkError">;
type AppError = ValidationError | NetworkError;

async function processData(input: unknown) {
  const validationResult = validateInput(input);
  if (validationResult.error) {
    return validationResult;
  }
  
  const saveResult = await saveToApi(validationResult.data);
  if (saveResult.error) {
    switch (saveResult.error.name) {
      case "ValidationError":
        return Ok({ fallback: true });
      case "NetworkError":
        return saveResult;
    }
  }
  
  return saveResult;
}
```

## Philosophy Differences

### Effect-TS Philosophy
- **Comprehensive**: Full FP ecosystem with STM, streaming, fibers
- **Purity**: Mathematical correctness and composability
- **Power**: Can model any computational pattern
- **Learning Investment**: Requires understanding new concepts

### Well Crafted Philosophy
- **Focused**: Solves error handling, nothing more
- **Pragmatic**: Works with existing JavaScript patterns
- **Familiar**: Looks and feels like modern TypeScript
- **Incremental**: Adopt one function at a time

## When to Use Which

### Use Well Crafted When:
- ✅ You want better error handling without changing architecture
- ✅ Your team knows async/await but not generators
- ✅ You need errors that serialize cleanly
- ✅ Bundle size is a concern
- ✅ You want to try Result types without commitment

### Use Effect When:
- ✅ You need advanced FP patterns (STM, fibers, streaming)
- ✅ Your team is bought into functional programming
- ✅ You're building complex concurrent systems
- ✅ You want a complete application framework
- ✅ Mathematical correctness is paramount

## Migration Path

### From Effect to Well Crafted
```typescript
// Effect
const getUser = (id: string) =>
  Effect.tryPromise({
    try: () => fetchUser(id),
    catch: () => new UserError()
  });

// Well Crafted (almost identical!)
const getUser = (id: string) =>
  tryAsync({
    try: () => fetchUser(id),
    mapErr: () => Err({
      name: "UserError",
      message: "Failed to fetch user",
      context: { id },
      cause: undefined
    })
  });
```

The concepts transfer directly - you're just using simpler syntax.

## FAQ

**Q: Is Well Crafted anti-Effect?**
A: Not at all! We have immense respect for Effect. We just believe there's room for a simpler solution for teams that only need error handling.

**Q: Can I use both?**
A: Yes! Use Well Crafted for simple error handling and Effect for complex orchestration.

**Q: What about Effect's dependency injection?**
A: We recommend traditional patterns: constructor injection, factory functions, or React context. These are well-understood and don't require runtime magic.

**Q: Will Well Crafted add more Effect features?**
A: No. Our focus is on doing one thing well: type-safe error handling with familiar patterns.