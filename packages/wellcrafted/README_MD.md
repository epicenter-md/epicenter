# wellcrafted

[![npm version](https://badge.fury.io/js/wellcrafted.svg)](https://www.npmjs.com/package/wellcrafted)
[![TypeScript](https://img.shields.io/badge/TypeScript-Ready-blue.svg)](https://www.typescriptlang.org/)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Bundle Size](https://img.shields.io/bundlephobia/minzip/wellcrafted)](https://bundlephobia.com/package/wellcrafted)

*Delightful TypeScript utilities for elegant, type-safe applications*

This library provides a robust, Rust-inspired `Result` type, elegant brand types, and a lightweight, serializable error handling system for TypeScript. It's designed to help you write more predictable, type-safe, and composable code by making error handling an explicit part of your function signatures.

## Why wellcrafted?

### The Problem: Invisible Errors

Every JavaScript developer has been bitten by this:

```typescript
// What errors can this throw? 🤷
async function saveUser(user: User): Promise<void> {
  await validate(user);      // Throws ValidationError? 
  await checkPermissions();  // Throws AuthError?
  await database.save(user); // Throws DatabaseError?
}

// Your code becomes a minefield of hidden exceptions
try {
  await saveUser(user);
} catch (error) {
  // Which error is this? How do I handle it?
  // Is it even an Error object, or something else?
  // Good luck debugging in production! 😰
}
```

The fundamental issues with JavaScript's error handling:

1. **Function signatures lie**: A function returning `Promise<User>` tells you nothing about the errors it might throw
2. **Errors break at boundaries**: `JSON.stringify(new Error())` loses critical information. Errors don't survive serialization across APIs, workers, or IPC
3. **No type safety**: TypeScript can't help you handle different error cases because thrown errors are invisible to the type system
4. **Inconsistent error shapes**: Third-party libraries throw who-knows-what - strings, Error objects, custom classes, even `undefined`

### The Solution: Delightful Type-Safe Utilities

wellcrafted transforms unpredictable exceptions into elegant, type-safe patterns:

```typescript
// Every possible error is visible in the type signature ✨
async function saveUser(user: User): Promise<Result<void, ValidationError | AuthError | DatabaseError>> {
  const validation = await validate(user);
  if (validation.error) return validation;  // Early return on error
  
  const auth = await checkPermissions();
  if (auth.error) return auth;
  
  return await database.save(user);
}

// Handle errors with confidence and type safety
const { data, error } = await saveUser(user);

if (error) {
  switch (error.name) {
    case "ValidationError": 
      showToast(`Invalid ${error.context.field}: ${error.message}`);
      break;
    case "AuthError":       
      redirectToLogin();
      break;
    case "DatabaseError":   
      logger.error("Database issue", error);
      showToast("Please try again later");
      break;
    // TypeScript ensures you handle all cases!
  }
} else {
  showToast("User saved successfully!");
}
```

### What Makes It Delightful?

- **🎯 Explicit Error Handling**: All potential failures are visible in function signatures
- **📦 Serialization-Safe**: Errors are plain objects that work everywhere - JSON, localStorage, postMessage, fetch
- **✨ Elegant API**: Clean, intuitive patterns that feel natural in TypeScript
- **🔍 Zero Magic**: The entire core is ~50 lines of code you can understand in minutes
- **🚀 Lightweight**: Zero dependencies, tree-shakeable, less than 2KB minified
- **🎨 Composable**: Mix and match utilities - use Result for errors, Brand for type safety, or both!

## Table of Contents

- [Quick Start](#quick-start)
- [Core Utilities](#core-utilities)
  - [Result Type](#result-type)
  - [Brand Types](#brand-types)
  - [Error Utilities](#error-utilities)
- [Installation](#installation)
- [Result Pattern Guide](#result-pattern-guide)
  - [Understanding the Result Type](#understanding-the-result-type)
  - [Handling Results](#handling-results)
  - [Wrapping Unsafe Operations](#wrapping-unsafe-operations)
- [Common Patterns](#common-patterns)
- [Coming From...](#coming-from)
- [Real-World Examples](#real-world-examples)
- [API Reference](#api-reference)
- [Best Practices](#best-practices)
- [Design Philosophy](#design-philosophy)
- [FAQ](#faq)

## Quick Start

### Installation

```bash
npm install wellcrafted
```

### 30 Second Example

Transform throwing async operations into type-safe Results:

```ts
import { tryAsync } from "wellcrafted/result";
import { type TaggedError } from "wellcrafted/error";
import * as fs from 'fs/promises';

type FileError = TaggedError<"FileError">;

async function readConfig(path: string) {
  return tryAsync<string, FileError>({
    try: async () => {
      const content = await fs.readFile(path, 'utf-8');
      return content;
    },
    mapError: (error) => ({
      name: "FileError",
      message: "Failed to read configuration file",
      context: { path },
      cause: error
    })
  });
}

// Handle the result
const { data, error } = await readConfig('./config.json');

if (error) {
  console.error(`${error.name}: ${error.message}`);
  console.log("Context:", error.context);
  process.exit(1);
}

console.log("Config loaded:", data); // TypeScript knows data is safe here
```

**What just happened?** Instead of letting file operations throw unpredictable errors, `tryAsync` wraps them in a `Result` type that makes success and failure explicit in your function signatures. No more unhandled exceptions!

## Core Utilities

wellcrafted provides a collection of focused utilities that work beautifully together:

### Result Type

A Rust-inspired pattern for type-safe error handling:

```typescript
import { Result, Ok, Err, isOk, isErr } from "wellcrafted/result";

function divide(a: number, b: number): Result<number, string> {
  if (b === 0) {
    return Err("Division by zero");
  }
  return Ok(a / b);
}
```

### Brand Types

Create distinct types from primitives for better type safety:

```typescript
import { type Brand } from "wellcrafted/brand";

type UserId = Brand<string, "UserId">;
type OrderId = Brand<string, "OrderId">;

// TypeScript prevents mixing branded types
function getUser(id: UserId) { /* ... */ }
function getOrder(id: OrderId) { /* ... */ }

const userId = "user_123" as UserId;
const orderId = "order_456" as OrderId;

getUser(userId);  // ✅ Correct
getUser(orderId); // ❌ Type error!
```

### Error Utilities

Structured, serializable errors that play nicely with Result types:

```typescript
import { type TaggedError, extractErrorMessage } from "wellcrafted/error";

type ValidationError = TaggedError<"ValidationError">;

const error: ValidationError = {
  name: "ValidationError",
  message: "Email is required",
  context: { field: "email" },
  cause: undefined
};
```

## Result Pattern Guide

### Understanding the Result Type

At its heart, the Result type is beautifully simple:

```typescript
type Result<T, E> = Ok<T> | Err<E>
```

This represents an operation that either:
- **Succeeded** with a value of type `T` (wrapped in `Ok`)
- **Failed** with an error of type `E` (wrapped in `Err`)

#### The Implementation

The entire Result implementation is elegantly minimal:

```typescript
// The two possible outcomes
export type Ok<T> = { data: T; error: null };
export type Err<E> = { error: E; data: null };

// Result is just a union of these two types
export type Result<T, E> = Ok<T> | Err<E>;

// Helper functions to create each variant
export const Ok = <T>(data: T): Ok<T> => ({ data, error: null });
export const Err = <E>(error: E): Err<E> => ({ error, data: null });
```

**The Magic: Discriminated Union with `null`**

This design creates a **discriminated union** where the `error` (or `data`) property acts as the discriminant with literal types `null` vs non-`null`, allowing TypeScript to automatically narrow types:

```typescript
function handleResult<T, E>(result: Result<T, E>) {
  if (result.error === null) {
    // TypeScript knows this is Ok<T>
    console.log(result.data); // ✅ data is type T
    // console.log(result.error); // ❌ TypeScript knows this is null
  } else {
    // TypeScript knows this is Err<E>  
    console.log(result.error); // ✅ error is type E
    // console.log(result.data); // ❌ TypeScript knows this is null
  }
}
```

The beauty is in the mutual exclusivity:
- **Ok<T>**: Always has `data: T` and `error: null`
- **Err<E>**: Always has `error: E` and `data: null`

This pattern allows TypeScript's control-flow analysis to work perfectly with simple `if (error)` checks!

### Handling Results

There are two delightful patterns for working with Results:

#### Pattern 1: Destructuring (Recommended)

This approach will feel familiar if you've used Supabase or similar modern libraries:

```typescript
const { data, error } = await someOperation();

if (error) {
  // Handle the error
  console.error(`Error: ${error.message}`);
  return;
}

// Use the data - TypeScript knows it's safe
console.log(`Success: ${data}`);
```

#### Pattern 2: Type Guards

For cases where TypeScript needs extra help with type narrowing:

```typescript
import { isOk, isErr } from "wellcrafted/result";

const result = await someOperation();

if (isErr(result)) {
  // TypeScript knows this is Err<E>
  console.error(result.error);
} else {
  // TypeScript knows this is Ok<T>
  console.log(result.data);
}
```

### Wrapping Unsafe Operations

#### Synchronous Operations

Use `trySync` to wrap functions that might throw:

```typescript
import { trySync } from "wellcrafted/result";
import { type TaggedError } from "wellcrafted/error";

type ParseError = TaggedError<"ParseError">;

function parseConfig(json: string): Result<Config, ParseError> {
  return trySync<Config, ParseError>({
    try: () => {
      const parsed = JSON.parse(json);
      validateConfig(parsed); // throws if invalid
      return parsed as Config;
    },
    mapError: (error) => ({
      name: "ParseError",
      message: "Invalid configuration format",
      context: { rawJson: json },
      cause: error
    })
  });
}
```

#### Asynchronous Operations

Use `tryAsync` for async functions and promises:

```typescript
import { tryAsync } from "wellcrafted/result";

type User = { id: number; name: string };
type ApiError = TaggedError<"ApiError">;

async function fetchUser(id: number): Promise<Result<User, ApiError>> {
  return tryAsync<User, ApiError>({
    try: async () => {
      const response = await fetch(`/api/users/${id}`);
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }
      return response.json();
    },
    mapError: (error) => ({
      name: "ApiError",
      message: "Failed to fetch user",
      context: { userId: id },
      cause: error
    })
  });
}
```

## Common Patterns

### Service Layer Pattern

A complete example showing error handling in a service layer:

```typescript
// Define domain-specific errors
type UserNotFoundError = TaggedError<"UserNotFoundError">;
type ValidationError = TaggedError<"ValidationError">;
type DatabaseError = TaggedError<"DatabaseError">;
type UserServiceError = UserNotFoundError | ValidationError | DatabaseError;

class UserService {
  async createUser(input: CreateUserInput): Promise<Result<User, UserServiceError>> {
    // Validate input
    const validation = this.validateUser(input);
    if (validation.error) return validation;

    // Check for duplicates
    const existing = await this.findByEmail(input.email);
    if (existing.data) {
      return Err({
        name: "ValidationError",
        message: "A user with this email already exists",
        context: { email: input.email },
        cause: undefined
      });
    }

    // Save to database
    return this.saveUser(validation.data);
  }

  private validateUser(input: unknown): Result<ValidatedUser, ValidationError> {
    if (!isValidEmail(input.email)) {
      return Err({
        name: "ValidationError",
        message: "Invalid email format",
        context: { email: input.email },
        cause: undefined
      });
    }
    
    return Ok(input as ValidatedUser);
  }
}
```

### Parallel Operations

Process multiple operations and handle all errors elegantly:

```typescript
import { partitionResults } from "wellcrafted/result";

async function processFiles(paths: string[]) {
  const results = await Promise.all(
    paths.map(path => 
      tryAsync({
        try: () => fs.readFile(path, 'utf-8'),
        mapError: (error) => ({
          name: "FileError",
          message: `Failed to read ${path}`,
          context: { path },
          cause: error
        })
      })
    )
  );

  const { oks, errs } = partitionResults(results);

  if (errs.length > 0) {
    console.error(`Failed to read ${errs.length} files:`);
    errs.forEach(({ error }) => {
      console.error(`- ${error.context.path}: ${error.message}`);
    });
  }

  return oks.map(ok => ok.data);
}
```

### Error Recovery

Implement retry logic with typed errors:

```typescript
async function fetchWithRetry<T>(
  url: string,
  maxRetries = 3
): Promise<Result<T, NetworkError>> {
  let lastError: NetworkError | null = null;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    const result = await tryAsync<T, NetworkError>({
      try: () => fetch(url).then(r => r.json()),
      mapError: (error) => ({
        name: "NetworkError",
        message: `Request failed (attempt ${attempt}/${maxRetries})`,
        context: { url, attempt, maxRetries },
        cause: error
      })
    });

    if (result.data) return result;
    
    lastError = result.error;
    
    // Exponential backoff
    if (attempt < maxRetries) {
      await new Promise(resolve => 
        setTimeout(resolve, Math.pow(2, attempt) * 1000)
      );
    }
  }

  return Err(lastError!);
}
```

## Coming From...

### From Traditional Try-Catch

If you're used to try-catch, here's how to migrate elegantly:

```typescript
// ❌ Before: Hidden errors, no type safety
async function oldWay(id: number): Promise<User> {
  try {
    const user = await database.findUser(id);
    if (!user) {
      throw new Error("User not found");
    }
    return user;
  } catch (error) {
    console.error(error);
    throw error; // Re-throwing loses context
  }
}

// ✅ After: Explicit errors, full type safety
async function newWay(id: number): Promise<Result<User, UserNotFoundError | DatabaseError>> {
  const result = await database.findUser(id);
  
  if (result.error) return result; // Propagate database errors
  
  if (!result.data) {
    return Err({
      name: "UserNotFoundError",
      message: "User not found",
      context: { userId: id },
      cause: undefined
    });
  }
  
  return Ok(result.data);
}
```

### From fp-ts

If you're coming from fp-ts, wellcrafted offers a more pragmatic approach:

```typescript
// fp-ts style
import { pipe } from 'fp-ts/function';
import * as E from 'fp-ts/Either';
import * as TE from 'fp-ts/TaskEither';

const result = pipe(
  TE.tryCatch(
    () => fetch('/api/user'),
    (error) => new Error(String(error))
  ),
  TE.chain((response) =>
    response.ok
      ? TE.right(response)
      : TE.left(new Error('Failed'))
  )
);

// wellcrafted style - simpler, more direct
const result = await tryAsync({
  try: async () => {
    const response = await fetch('/api/user');
    if (!response.ok) throw new Error('Failed');
    return response;
  },
  mapError: (error) => ({
    name: "ApiError",
    message: "Failed to fetch user",
    context: {},
    cause: error
  })
});
```

Key differences:
- No pipe operator or complex compositions required
- Works with standard async/await
- Errors are plain objects, not classes
- Simpler mental model, gentler learning curve

### From Effect

Effect is incredibly powerful but requires buying into a whole ecosystem. wellcrafted provides similar benefits with delightful simplicity:

```typescript
// Effect style
import { Effect } from 'effect';

const program = Effect.gen(function* (_) {
  const user = yield* _(fetchUser(1));
  const validated = yield* _(validateUser(user));
  return validated;
});

// wellcrafted style - familiar async/await
async function program() {
  const userResult = await fetchUser(1);
  if (userResult.error) return userResult;
  
  const validated = validateUser(userResult.data);
  if (validated.error) return validated;
  
  return validated;
}
```

Key differences:
- No generators or special syntax
- No runtime overhead
- Works with existing TypeScript code
- Can adopt incrementally

### From neverthrow

If you like neverthrow, you'll find wellcrafted familiar but even more elegant:

```typescript
// neverthrow
const result = await fetchUser(1)
  .andThen(user => validateUser(user))
  .map(user => user.name);

// wellcrafted - explicit but clear
const userResult = await fetchUser(1);
if (userResult.error) return userResult;

const validated = validateUser(userResult.data);
if (validated.error) return validated;

return Ok(validated.data.name);
```

Key differences:
- No method chaining API to learn
- More explicit control flow
- Better debugging experience
- Errors as plain objects by default

## Real-World Examples

### Form Validation

```typescript
type FormError = TaggedError<"FormError">;
type FieldErrors = Record<string, string[]>;

function validateLoginForm(data: unknown): Result<LoginData, FormError> {
  const errors: FieldErrors = {};
  
  if (!data?.email || !isValidEmail(data.email)) {
    errors.email = ["Please enter a valid email"];
  }
  
  if (!data?.password || data.password.length < 8) {
    errors.password = ["Password must be at least 8 characters"];
  }
  
  if (Object.keys(errors).length > 0) {
    return Err({
      name: "FormError",
      message: "Please fix the errors below",
      context: { fields: errors },
      cause: undefined
    });
  }
  
  return Ok(data as LoginData);
}

// In your component
const { data, error } = validateLoginForm(formData);
if (error) {
  setFieldErrors(error.context.fields);
  return;
}

// Proceed with login
await login(data);
```

### API Route Handler

```typescript
// app/api/users/[id]/route.ts
export async function GET(
  request: Request,
  { params }: { params: { id: string } }
) {
  const userId = parseInt(params.id);
  
  if (isNaN(userId)) {
    return NextResponse.json(
      { error: "Invalid user ID" },
      { status: 400 }
    );
  }
  
  const result = await userService.getUser(userId);
  
  if (result.error) {
    switch (result.error.name) {
      case "UserNotFoundError":
        return NextResponse.json(
          { error: "User not found" },
          { status: 404 }
        );
      case "DatabaseError":
        console.error("Database error:", result.error);
        return NextResponse.json(
          { error: "Internal server error" },
          { status: 500 }
        );
    }
  }
  
  return NextResponse.json(result.data);
}
```

### React Hook with Error Handling

```typescript
function useUser(id: number) {
  const [state, setState] = useState<{
    loading: boolean;
    user?: User;
    error?: ApiError;
  }>({ loading: true });

  useEffect(() => {
    let cancelled = false;

    async function loadUser() {
      setState({ loading: true });
      
      const result = await fetchUser(id);
      
      if (!cancelled) {
        if (result.error) {
          setState({ loading: false, error: result.error });
        } else {
          setState({ loading: false, user: result.data });
        }
      }
    }

    loadUser();
    return () => { cancelled = true; };
  }, [id]);

  return state;
}
```

### Using Brand Types for Safety

```typescript
import { type Brand } from "wellcrafted/brand";

// Create branded types
type SafeHtml = Brand<string, "SafeHtml">;
type UserId = Brand<string, "UserId">;
type ApiKey = Brand<string, "ApiKey">;

// Functions that require specific branded types
function renderHtml(html: SafeHtml) {
  element.innerHTML = html; // Safe because we know it's sanitized
}

function fetchUserData(userId: UserId, apiKey: ApiKey) {
  // TypeScript ensures you can't accidentally swap parameters
  return fetch(`/api/users/${userId}`, {
    headers: { 'X-API-Key': apiKey }
  });
}

// Create branded values
const sanitized = sanitizeHtml(userInput) as SafeHtml;
const userId = "user_123" as UserId;
const apiKey = process.env.API_KEY as ApiKey;

// Use them safely
renderHtml(sanitized);
fetchUserData(userId, apiKey);
```

## API Reference

### Quick Reference

| Function | Purpose | Example |
|----------|---------|---------|
| `Ok(data)` | Create success result | `Ok({ id: 1, name: "Alice" })` |
| `Err(error)` | Create failure result | `Err({ name: "ValidationError", ... })` |
| `isOk(result)` | Check if success | `if (isOk(result)) { ... }` |
| `isErr(result)` | Check if failure | `if (isErr(result)) { ... }` |
| `trySync()` | Wrap throwing function | `trySync({ try: () => JSON.parse(str) })` |
| `tryAsync()` | Wrap async function | `tryAsync({ try: () => fetch(url) })` |
| `partitionResults()` | Split array of Results | `const { oks, errs } = partitionResults(results)` |

### Core Types

#### `Result<T, E>`
The main type representing either success (`Ok<T>`) or failure (`Err<E>`).

#### `Ok<T>`
Success variant containing `{ data: T; error: null }`.

#### `Err<E>`
Failure variant containing `{ data: null; error: E }`.

#### `TaggedError<T>`
Helper type for creating discriminated union error types:

```typescript
type TaggedError<T extends string> = {
  readonly name: T;
  message: string;
  context?: Record<string, unknown>;
  cause?: unknown;
};
```

#### `Brand<T, B>`
Creates a branded type from a base type:

```typescript
type Brand<T, B> = T & { __brand: B };
```

### Functions

#### Result Functions

- **`Ok<T>(data: T): Ok<T>`** - Creates a success Result
- **`Err<E>(error: E): Err<E>`** - Creates a failure Result
- **`isOk<T, E>(result: Result<T, E>): result is Ok<T>`** - Type guard for success
- **`isErr<T, E>(result: Result<T, E>): result is Err<E>`** - Type guard for failure
- **`trySync<T, E>(options): Result<T, E>`** - Wraps synchronous operations
- **`tryAsync<T, E>(options): Promise<Result<T, E>>`** - Wraps async operations
- **`partitionResults<T, E>(results): { oks: Ok<T>[]; errs: Err<E>[] }`** - Separates successes and failures
- **`unwrap<T, E>(result: Result<T, E>): T`** - Extracts value or throws (use sparingly!)

#### Error Utilities

- **`extractErrorMessage(error: unknown): string`** - Safely extracts error messages

## Best Practices

### Error Design

1. **Make errors specific and actionable**:
   ```typescript
   // ❌ Too generic
   type Error = TaggedError<"Error">;
   
   // ✅ Specific and meaningful
   type ConnectionTimeoutError = TaggedError<"ConnectionTimeoutError">;
   type InvalidCredentialsError = TaggedError<"InvalidCredentialsError">;
   ```

2. **Include relevant context**:
   ```typescript
   return Err({
     name: "ValidationError",
     message: "Age must be between 0 and 150",
     context: { 
       field: "age",
       value: input.age,
       min: 0,
       max: 150
     },
     cause: undefined
   });
   ```

3. **Use error types to guide behavior**:
   ```typescript
   if (error) {
     switch (error.name) {
       case "NetworkError":
         // Retry with exponential backoff
         return retryOperation();
       case "ValidationError":
         // Show form errors
         return showValidationErrors(error.context);
       case "AuthError":
         // Redirect to login
         return redirectToLogin();
     }
   }
   ```

### Function Design

1. **Make error types visible in signatures**:
   ```typescript
   // Clear about what can go wrong
   function parseUser(data: unknown): Result<User, ParseError | ValidationError> {
     // ...
   }
   ```

2. **Return early on errors**:
   ```typescript
   async function processOrder(orderId: string) {
     const order = await fetchOrder(orderId);
     if (order.error) return order;
     
     const validation = validateOrder(order.data);
     if (validation.error) return validation;
     
     const result = await submitOrder(validation.data);
     return result;
   }
   ```

3. **Use brand types for critical values**:
   ```typescript
   type CustomerId = Brand<string, "CustomerId">;
   type OrderId = Brand<string, "OrderId">;
   
   // Prevents mixing up IDs
   function processOrder(customerId: CustomerId, orderId: OrderId) {
     // TypeScript ensures you can't swap these by mistake
   }
   ```

### Testing

Test both success and failure cases:

```typescript
describe('user service', () => {
  it('should return ValidationError for invalid email', async () => {
    const result = await createUser({ email: 'not-an-email' });
    
    expect(result.error).toBeDefined();
    expect(result.error?.name).toBe('ValidationError');
    expect(result.error?.context.field).toBe('email');
  });
  
  it('should create user successfully', async () => {
    const result = await createUser({ 
      email: 'user@example.com',
      name: 'Test User'
    });
    
    expect(result.data).toBeDefined();
    expect(result.data?.email).toBe('user@example.com');
  });
});
```

## Design Philosophy

### Delightfully Simple, Surprisingly Powerful

We believe great tools should feel natural and joyful to use. wellcrafted follows these principles:

- **Embrace JavaScript, Enhance Where Needed**: We work *with* the language, not against it
- **Progressive Disclosure**: Simple things are simple, complex things are possible
- **Composition Over Configuration**: Small, focused utilities that work beautifully together
- **Type Safety Without the Boilerplate**: Let TypeScript do the heavy lifting

### Errors as Data, Not Control Flow

Traditional exceptions are hidden control flow. By treating errors as data:

- Error handling becomes explicit and predictable
- Errors can be transformed, filtered, and aggregated like any other data
- Testing becomes straightforward - no need to catch thrown errors
- Debugging is easier - errors are just values you can inspect

### Serialization First

Unlike JavaScript's Error class, our errors are plain objects. This means:

- They survive JSON.stringify/parse without losing information
- They work across process boundaries (workers, IPC)
- They can be sent over the network without special handling
- They can be stored in databases or logs as-is

### Progressive Adoption

You don't need to rewrite your entire codebase. Start small:

1. Wrap external APIs with tryAsync
2. Add Result types to new functions
3. Gradually migrate critical paths
4. Keep using throw for truly exceptional cases

## FAQ

### Why not just use try-catch?

Try-catch has fundamental limitations:

1. **No type information** - You don't know what errors a function might throw
2. **Errors are invisible** - They're not part of the function signature
3. **Non-serializable** - Error objects lose information when serialized
4. **Inconsistent** - Different libraries throw different things

Result types solve all these issues by making errors explicit, typed, and serializable.

### Why `{ data, error }` instead of `{ ok: boolean, ... }`?

Two reasons:

1. **Better ergonomics** - Destructuring `const { data, error } = ...` is cleaner
2. **Familiar pattern** - Used by Supabase, Astro Actions, and other modern libraries

The boolean flag approach isn't standardized (Zod uses `success`, others use `ok`), while our pattern is simple and intuitive.

### What about the Option/Maybe type?

JavaScript already has great support for optional values:

- Union types: `T | null` or `T | undefined`
- Optional chaining: `user?.address?.street`
- Nullish coalescing: `name ?? "Anonymous"`

An Option type would just add unnecessary abstraction over these well-understood patterns.

### How is this different from neverthrow?

While neverthrow is excellent, wellcrafted makes different trade-offs:

- **Simpler API** - No method chaining to learn
- **Plain objects** - Errors are data, not classes
- **More explicit** - Control flow is visible, not hidden in chains
- **Better debugging** - Step through clear, linear code

### Can I use this with React/Next.js/Express/etc?

Yes! wellcrafted is framework-agnostic and works anywhere TypeScript works. The examples above show Next.js App Router integration, but it works equally well with:

- React (hooks, components)
- Express/Fastify (route handlers, middleware)
- CLI tools
- Electron apps
- Node.js scripts

### How do I migrate gradually?

Start by wrapping external calls:

```typescript
// Before
try {
  const data = await fetch('/api/user');
  return await data.json();
} catch (error) {
  console.error(error);
  throw error;
}

// After - wrap with tryAsync
const result = await tryAsync({
  try: async () => {
    const data = await fetch('/api/user');
    return data.json();
  },
  mapError: (error) => ({
    name: "ApiError",
    message: "Failed to fetch user",
    context: {},
    cause: error
  })
});

return result;
```

Then gradually update your functions to return Result types instead of throwing.

### Is this production ready?

Yes! The core API is stable and the library is being used in production applications. The simple, focused design means there's very little that can go wrong.

### Where can I learn more?

- Check out the [examples directory](https://github.com/your-repo/wellcrafted/tree/main/examples) for complete applications
- Read the [source code](https://github.com/your-repo/wellcrafted/tree/main/src) - it's short and well-commented
- Join the [discussions](https://github.com/your-repo/wellcrafted/discussions) to ask questions

---

Made with ❤️ by developers who believe error handling should be delightful.