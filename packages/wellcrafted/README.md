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
Structured, serializable errors with convenient factory functions
```typescript
import { createTaggedError } from "wellcrafted/error";

const { ApiError, ApiErr } = createTaggedError("ApiError");
// ApiError() creates error object, ApiErr() creates Err-wrapped error
```

## Installation

```bash
npm install wellcrafted
```

## Quick Start

```typescript
import { tryAsync } from "wellcrafted/result";
import { createTaggedError } from "wellcrafted/error";

// Define your error with factory function
const { ApiError, ApiErr } = createTaggedError("ApiError");
type ApiError = ReturnType<typeof ApiError>;

// Wrap any throwing operation
const { data, error } = await tryAsync({
  try: () => fetch('/api/user').then(r => r.json()),
  catch: (error) => ApiErr({
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
  catch: (error) => Err({
    name: "ParseError",
    message: "Invalid JSON",
    context: { input: jsonString },
    cause: error
  })
});

// Asynchronous  
const result = await tryAsync({
  try: () => fetch(url),
  catch: (error) => Err({
    name: "NetworkError",
    message: "Request failed",
    context: { url },
    cause: error
  })
});
```

### Service Layer Example

```typescript
import { Result, Ok, tryAsync } from "wellcrafted/result";
import { createTaggedError } from "wellcrafted/error";

// Define service-specific errors
const { ValidationError, ValidationErr } = createTaggedError("ValidationError");
const { DatabaseError, DatabaseErr } = createTaggedError("DatabaseError");

type ValidationError = ReturnType<typeof ValidationError>;
type DatabaseError = ReturnType<typeof DatabaseError>;

// Factory function pattern - no classes!
export function createUserService(db: Database) {
  return {
    async createUser(input: CreateUserInput): Promise<Result<User, ValidationError | DatabaseError>> {
      // Direct return with Err variant
      if (!input.email.includes('@')) {
        return ValidationErr({
          message: "Invalid email format",
          context: { field: 'email', value: input.email },
          cause: undefined
        });
      }

      return tryAsync({
        try: () => db.save(input),
        catch: (error) => DatabaseErr({
          message: "Failed to save user",
          context: { operation: 'createUser', input },
          cause: error
        })
      });
    },

    async getUser(id: string): Promise<Result<User | null, DatabaseError>> {
      return tryAsync({
        try: () => db.findById(id),
        catch: (error) => DatabaseErr({
          message: "Failed to fetch user",
          context: { userId: id },
          cause: error
        })
      });
    }
  };
}

// Export type for the service
export type UserService = ReturnType<typeof createUserService>;

// Create a live instance (dependency injection at build time)
export const UserServiceLive = createUserService(databaseInstance);
```

## Smart Return Type Narrowing

The `catch` parameter in `trySync` and `tryAsync` enables smart return type narrowing based on your error handling strategy:

### Recovery Pattern (Always Succeeds)
```typescript
// When catch always returns Ok<T>, function returns Ok<T>
const alwaysSucceeds = trySync({
  try: () => JSON.parse(riskyJson),
  catch: () => Ok({ fallback: "default" }) // Always recover with fallback
});
// alwaysSucceeds: Ok<object> - No error checking needed!
console.log(alwaysSucceeds.data); // Safe to access directly
```

### Propagation Pattern (May Fail)
```typescript
// When catch can return Err<E>, function returns Result<T, E>  
const mayFail = trySync({
  try: () => JSON.parse(riskyJson),
  catch: (error) => Err(ParseError({ message: "Invalid JSON", cause: error }))
});
// mayFail: Result<object, ParseError> - Must check for errors
if (isOk(mayFail)) {
  console.log(mayFail.data); // Only safe after checking
}
```

### Mixed Strategy (Conditional Recovery)
```typescript
const smartParse = trySync({
  try: () => JSON.parse(input),
  catch: (error) => {
    // Recover from empty input
    if (input.trim() === "") {
      return Ok({}); // Return Ok<T> for fallback
    }
    // Propagate other errors  
    return Err(ParseError({ message: "Parse failed", cause: error }));
  }
});
// smartParse: Result<object, ParseError> - Mixed handling = Result type
```

This eliminates unnecessary error checking when you always recover, while still requiring proper error handling when failures are possible.

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

## Service Pattern Best Practices

Based on real-world usage, here's the recommended pattern for creating services with wellcrafted:

### Factory Function Pattern

```typescript
import { createTaggedError } from "wellcrafted/error";

// 1. Define service-specific errors
const { RecorderServiceError, RecorderServiceErr } = createTaggedError("RecorderServiceError");
type RecorderServiceError = ReturnType<typeof RecorderServiceError>;

// 2. Create service with factory function
export function createRecorderService() {
  // Private state in closure
  let isRecording = false;
  
  // Return object with methods
  return {
    startRecording(): Result<void, RecorderServiceError> {
      if (isRecording) {
        return RecorderServiceErr({
          message: "Already recording",
          context: { isRecording },
          cause: undefined
        });
      }
      
      isRecording = true;
      return Ok(undefined);
    },
    
    stopRecording(): Result<Blob, RecorderServiceError> {
      if (!isRecording) {
        return RecorderServiceErr({
          message: "Not currently recording", 
          context: { isRecording },
          cause: undefined
        });
      }
      
      isRecording = false;
      return Ok(new Blob(["audio data"]));
    }
  };
}

// 3. Export type
export type RecorderService = ReturnType<typeof createRecorderService>;

// 4. Create singleton instance
export const RecorderServiceLive = createRecorderService();
```

### Platform-Specific Services

For services that need different implementations per platform:

```typescript
// types.ts - shared interface
export type FileService = {
  readFile(path: string): Promise<Result<string, FileServiceError>>;
  writeFile(path: string, content: string): Promise<Result<void, FileServiceError>>;
};

// desktop.ts
export function createFileServiceDesktop(): FileService {
  return {
    async readFile(path) {
      // Desktop implementation using Node.js APIs
    },
    async writeFile(path, content) {
      // Desktop implementation
    }
  };
}

// web.ts  
export function createFileServiceWeb(): FileService {
  return {
    async readFile(path) {
      // Web implementation using File API
    },
    async writeFile(path, content) {
      // Web implementation
    }
  };
}

// index.ts - runtime selection
export const FileServiceLive = typeof window !== 'undefined' 
  ? createFileServiceWeb()
  : createFileServiceDesktop();
```

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

### Error Functions
- **`createTaggedError(name)`** - Creates error factory functions
  - Returns two functions: `{ErrorName}` and `{ErrorName}Err`
  - The first creates plain error objects
  - The second creates Err-wrapped errors

### Types
- **`Result<T, E>`** - Union of Ok<T> | Err<E>
- **`TaggedError<T>`** - Structured error type
- **`Brand<T, B>`** - Branded type wrapper

## License

MIT

---

Made with ❤️ by developers who believe error handling should be delightful.