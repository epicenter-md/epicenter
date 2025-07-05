# wellcrafted

[![npm version](https://badge.fury.io/js/wellcrafted.svg)](https://www.npmjs.com/package/wellcrafted)
[![TypeScript](https://img.shields.io/badge/TypeScript-Ready-blue.svg)](https://www.typescriptlang.org/)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Bundle Size](https://img.shields.io/bundlephobia/minzip/wellcrafted)](https://bundlephobia.com/package/wellcrafted)

*Delightful TypeScript utilities for elegant, type-safe applications*

## Transform unpredictable errors into type-safe results

```typescript
// ❌ Before: Which errors can this throw? 🤷
try {
  await saveUser(user);
} catch (error) {
  // ... good luck debugging in production
}

// ✅ After: Every error is visible and typed
const { data, error } = await saveUser(user);
if (error) {
  switch (error.name) {
    case "ValidationError": 
      showToast(`Invalid ${error.context.field}`);
      break;
    case "AuthError":
      redirectToLogin();
      break;
    // TypeScript ensures you handle all cases!
  }
}
```

## A collection of simple, powerful primitives

### 🎯 Result Type
Make errors explicit in function signatures
```typescript
function divide(a: number, b: number): Result<number, string> {
  if (b === 0) return Err("Division by zero");
  return Ok(a / b);
}
```

### 🏷️ Brand Types
Create distinct types from primitives
```typescript
type UserId = Brand<string, "UserId">;
type OrderId = Brand<string, "OrderId">;

// TypeScript prevents mixing them up!
function getUser(id: UserId) { /* ... */ }
```

### 📋 Tagged Errors
Structured, serializable errors that work everywhere
```typescript
type ApiError = TaggedError<"ApiError">;
// Works with JSON, localStorage, postMessage, etc.
```

## Installation

```bash
npm install wellcrafted
```

## Quick Start

```typescript
import { tryAsync } from "wellcrafted/result";
import { type TaggedError } from "wellcrafted/error";

// Wrap any throwing operation
type ApiError = TaggedError<"ApiError">;

const { data, error } = await tryAsync<User, ApiError>({
  try: () => fetch('/api/user').then(r => r.json()),
  mapError: (error) => ({
    name: "ApiError",
    message: "Failed to fetch user",
    context: { endpoint: '/api/user' },
    cause: error
  })
});

if (error) {
  console.error(`${error.name}: ${error.message}`);
} else {
  console.log("User:", data);
}
```

## Core Features

<table>
<tr>
<td>

**🎯 Explicit Error Handling**  
All errors visible in function signatures

</td>
<td>

**📦 Serialization-Safe**  
Plain objects work everywhere

</td>
<td>

**✨ Elegant API**  
Clean, intuitive patterns

</td>
</tr>
<tr>
<td>

**🔍 Zero Magic**  
~50 lines of core code

</td>
<td>

**🚀 Lightweight**  
Zero dependencies, < 2KB

</td>
<td>

**🎨 Composable**  
Mix and match utilities

</td>
</tr>
</table>

## The Result Pattern Explained

The Result type makes error handling explicit and type-safe:

```typescript
// The entire implementation
type Ok<T> = { data: T; error: null };
type Err<E> = { error: E; data: null };
type Result<T, E> = Ok<T> | Err<E>;
```

**The Magic**: This creates a discriminated union where TypeScript automatically narrows types:

```typescript
if (result.error) {
  // TypeScript knows: error is E, data is null
} else {
  // TypeScript knows: data is T, error is null
}
```

## Basic Patterns

### Handle Results with Destructuring

```typescript
const { data, error } = await someOperation();

if (error) {
  // Handle error with full type safety
  return;
}

// Use data - TypeScript knows it's safe
```

### Wrap Unsafe Operations

```typescript
// Synchronous
const result = trySync({
  try: () => JSON.parse(jsonString),
  mapError: (error) => ({
    name: "ParseError",
    message: "Invalid JSON",
    context: { input: jsonString },
    cause: error
  })
});

// Asynchronous  
const result = await tryAsync({
  try: () => fetch(url),
  mapError: (error) => ({
    name: "NetworkError",
    message: "Request failed",
    context: { url },
    cause: error
  })
});
```

### Service Layer Example

```typescript
class UserService {
  async createUser(input: CreateUserInput): Promise<Result<User, ValidationError | DatabaseError>> {
    const validation = this.validateUser(input);
    if (validation.error) return validation;

    return this.saveUser(validation.data);
  }
}
```

## Why wellcrafted?

JavaScript's `try-catch` has fundamental problems:

1. **Invisible Errors**: Function signatures don't show what errors can occur
2. **Lost in Transit**: `JSON.stringify(new Error())` loses critical information  
3. **No Type Safety**: TypeScript can't help with `catch (error)` blocks
4. **Inconsistent**: Libraries throw different things (strings, errors, objects, undefined)

wellcrafted solves these with simple, composable primitives that make errors:
- **Explicit** in function signatures
- **Serializable** across all boundaries
- **Type-safe** with full TypeScript support
- **Consistent** with structured error objects

## Common Use Cases

<details>
<summary><b>API Route Handler</b></summary>

```typescript
export async function GET(request: Request) {
  const result = await userService.getUser(params.id);
  
  if (result.error) {
    switch (result.error.name) {
      case "UserNotFoundError":
        return new Response("Not found", { status: 404 });
      case "DatabaseError":
        return new Response("Server error", { status: 500 });
    }
  }
  
  return Response.json(result.data);
}
```
</details>

<details>
<summary><b>Form Validation</b></summary>

```typescript
function validateLoginForm(data: unknown): Result<LoginData, FormError> {
  const errors: Record<string, string[]> = {};
  
  if (!isValidEmail(data?.email)) {
    errors.email = ["Invalid email format"];
  }
  
  if (Object.keys(errors).length > 0) {
    return Err({
      name: "FormError",
      message: "Validation failed",
      context: { fields: errors },
      cause: undefined
    });
  }
  
  return Ok(data as LoginData);
}
```
</details>

<details>
<summary><b>React Hook</b></summary>

```typescript
function useUser(id: number) {
  const [state, setState] = useState<{
    loading: boolean;
    user?: User;
    error?: ApiError;
  }>({ loading: true });

  useEffect(() => {
    fetchUser(id).then(result => {
      if (result.error) {
        setState({ loading: false, error: result.error });
      } else {
        setState({ loading: false, user: result.data });
      }
    });
  }, [id]);

  return state;
}
```
</details>

## Comparison with Alternatives

| | wellcrafted | fp-ts | Effect | neverthrow |
|---|---|---|---|---|
| **Learning Curve** | Minimal | Steep | Steep | Moderate |
| **Syntax** | Native async/await | Pipe operators | Generators | Method chains |
| **Bundle Size** | < 2KB | ~30KB | ~50KB | ~5KB |
| **Type Safety** | ✅ Full | ✅ Full | ✅ Full | ✅ Full |
| **Serializable Errors** | ✅ Built-in | ❌ Classes | ❌ Classes | ❌ Classes |

## API Reference

### Result Functions
- **`Ok(data)`** - Create success result
- **`Err(error)`** - Create failure result  
- **`isOk(result)`** - Type guard for success
- **`isErr(result)`** - Type guard for failure
- **`trySync(options)`** - Wrap throwing function
- **`tryAsync(options)`** - Wrap async function
- **`partitionResults(results)`** - Split array into oks/errs

### Types
- **`Result<T, E>`** - Union of Ok<T> | Err<E>
- **`TaggedError<T>`** - Structured error type
- **`Brand<T, B>`** - Branded type wrapper

## Learn More

- 📖 [Full Documentation](https://github.com/your-repo/wellcrafted/wiki)
- 🚀 [Examples](https://github.com/your-repo/wellcrafted/tree/main/examples)
- 💬 [Discussions](https://github.com/your-repo/wellcrafted/discussions)

## License

MIT

---

Made with ❤️ by developers who believe error handling should be delightful.