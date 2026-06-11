# The `{ key?: never }` Pattern for Reserved Key Prevention

When you build a type-safe API that accepts user-defined fields: like an error builder where users define `{ status: number; provider: string }`: you need to prevent collisions with keys your system already owns.

In WellCrafted's `createTaggedError`, every error has a `name` discriminant tag. If someone defines `.withFields<{ name: string }>()`, the flat spread would silently overwrite it. That's a nasty bug at runtime with zero compile-time feedback.

The question: how do you reject specific keys at the type level?

## The Obvious Approach: Conditional Types

```typescript
type ReservedKeys = 'name';

type ValidFields<T extends JsonObject> =
  keyof T & ReservedKeys extends never ? T : never;
```

This resolves to `T` when the keys are clean, `never` when they collide. It works as a standalone check:

```typescript
type Good = ValidFields<{ status: number }>;  // { status: number }
type Bad = ValidFields<{ name: string }>;      // never
```

But try using it as a generic constraint on a method:

```typescript
// This is circular: TypeScript can't resolve it
withFields<T extends ValidFields<T>>(): ErrorBuilder<T>;
```

TypeScript can't evaluate `ValidFields<T>` when `T` is the type parameter being constrained. The conditional type depends on `T`, but `T`'s constraint depends on the conditional type. Circular. You get cryptic errors like "Type 'X' does not satisfy constraint 'never'" with no indication that `name` was the problem.

## The Fix: Intersection with `{ key?: never }`

```typescript
type NoReservedKeys = { name?: never };

withFields<T extends JsonObject & NoReservedKeys>(): ErrorBuilder<TName, T>;
```

This works because `never` as a property type means "this key cannot exist with any value." The `?` makes it optional so objects without the key still pass. But any object that has `name` as a key fails the constraint. The value type can't be `never`.

```typescript
// OK: { status: number } extends { name?: never }
// (status is unrelated, name doesn't exist, optional never is fine)
.withFields<{ status: number }>()

// Compile error: { name: string } does NOT extend { name?: never }
// (string is not assignable to never)
.withFields<{ name: string }>()
```

The error message is clear: "Type 'string' is not assignable to type 'never'" on the `name` property.

### Why Only `name`?

You might expect `message` to be reserved too. It's not, because `message` is handled by the API design itself:

- **With `.withMessage()`**: The message is sealed by the template function. `message` simply doesn't appear in the factory input type at all: there's nothing to collide with.
- **Without `.withMessage()`**: `message` is a required built-in input (like `name` is a built-in output), separate from user-defined fields.

Either way, there's no scenario where a user-defined field named `message` would silently overwrite the error's message. The type system prevents it structurally rather than needing a `{ message?: never }` guard. A developer can immediately see what's wrong.

## Why This Is Better

| Aspect | `ValidFields<T>` conditional | `{ key?: never }` intersection |
|--------|-------------------------------|-------------------------------|
| Standalone utility | Works | Works |
| Generic constraint | Circular reference error | Works |
| Error message | "Type 'X' does not satisfy constraint 'never'" | "'name' is not assignable to 'never'" |
| Composability | Can't intersect with other constraints | Natural intersection with `&` |
| Scope | Rejects all listed keys regardless of API mode | Only reserves keys that are always structurally owned |

## The Pattern Generalized

Any time you need to reserve keys in a user-provided type parameter:

```typescript
// Reserve specific keys
type NoReservedKeys = { [K in 'name']?: never };

// Use as intersection constraint
function builder<T extends Record<string, unknown> & NoReservedKeys>(fields: T): T {
  return fields;
}
```

This pattern scales: add more reserved keys by extending the union. The constraint is evaluated eagerly (no conditional type resolution needed), so TypeScript handles it without any circular reference issues.

The key insight: only reserve keys that are **always structurally owned** by the system. Keys like `message` that are conditionally present based on API mode are better handled by the API design itself (e.g., `.withMessage()` removing `message` from the input type entirely).

## In WellCrafted

We use both approaches:

- **`NoReservedKeys`**: intersection constraint in the builder's `.withFields<T>()` method. Prevents overwriting `name`.
- **`ValidFields<T>`**: exported as a standalone utility type for consumers who want to validate field types outside the builder chain.

The builder prevents you from accidentally overwriting `name` with your error fields. `message` doesn't need guarding because the API handles it structurally: `.withMessage()` seals it (removing it from the input type), and without `.withMessage()` it's a separate built-in input.

```typescript
// With .withMessage(): message sealed by template, not in input type
const { ResponseError } = createTaggedError('ResponseError')
  .withFields<{ status: number; provider: string }>()
  .withMessage(({ status }) => `HTTP ${status}`);

const error = ResponseError({ status: 401, provider: 'openai' });
// error.name     → 'ResponseError' (guaranteed, can't be overwritten)
// error.message  → 'HTTP 401' (sealed by template: no override possible)
// error.status   → 401 (user field, flat on the object)
// error.provider → 'openai' (user field, flat on the object)

// Without .withMessage(): message required at call site, separate from fields
const { FsError } = createTaggedError('FsError');
const error2 = FsError({ message: 'File not found' });
// error2.name    → 'FsError'
// error2.message → 'File not found' (provided by caller)
```
