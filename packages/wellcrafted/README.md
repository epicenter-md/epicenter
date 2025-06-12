# A Modern Approach to Error Handling in TypeScript

[![npm version](https://badge.fury.io/js/@epicenterhq%2Fresult.svg)](https://www.npmjs.com/package/@epicenterhq/result)
[![TypeScript](https://img.shields.io/badge/TypeScript-Ready-blue.svg)](https://www.typescriptlang.org/)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Bundle Size](https://img.shields.io/bundlephobia/minzip/@epicenterhq/result)](https://bundlephobia.com/package/@epicenterhq/result)

This library provides a robust, Rust-inspired `Result` type and a lightweight, serializable error handling system for TypeScript. It's designed to help you write more predictable, type-safe, and composable code by making error handling an explicit part of your function signatures.

## Table of Contents

- [Quick Start](#quick-start)
- [Core Idea: The Result Type](#core-idea-the-result-type)
- [Installation](#installation)
- [Understanding TaggedError](#understanding-taggederror)
- [Basic Usage](#basic-usage)
- [Handling Operation Outcomes](#handling-operation-outcomes)
- [Wrapping Functions That Throw](#wrapping-functions-that-throw)
- [API Reference](#api-reference)
- [Design Philosophy](#design-philosophy)
- [FAQ](#faq)

## Quick Start

**30-second example:** Turn unpredictable functions into type-safe operations.

```bash
npm install @epicenterhq/result
```

```ts
import { Result, Ok, Err, type TaggedError } from "@epicenterhq/result";

type ParseError = TaggedError<"ParseError">;

function parseUser(json: string): Result<{ name: string }, ParseError> {
  try {
    const data = JSON.parse(json);
    if (typeof data.name !== "string") {
      return Err({
        name: "ParseError",
        message: "User must have a name property of type string",
        context: { receivedValue: data.name },
        cause: undefined
      });
    }
    return Ok(data);
  } catch (e) {
    return Err({
      name: "ParseError", 
      message: "Invalid JSON provided",
      context: { rawString: json },
      cause: e
    });
  }
}

// Handle the result
const { data, error } = parseUser('{"name": "Alice"}');

if (error) {
  console.error(`${error.name}: ${error.message}`);
  console.log("Context:", error.context);
  return;
}

console.log(`Welcome, ${data.name}!`); // TypeScript knows data is safe here
```

**What just happened?** Instead of throwing errors, the function returns a `Result` that explicitly shows success or failure in the type system. No more surprise runtime errors!

---

## Core Idea: The Result Type

> **💡 TL;DR:** Replace `throw new Error()` with `return Err()` to make errors visible in your function signatures.

JavaScript's traditional error handling, based on `try...catch` and throwing `Error` objects, has two major drawbacks for modern application development:
1.  **It's not type-safe**: A function signature `function doSomething(): User` doesn't tell you that it might throw a `NetworkError` or a `ValidationError`. Errors are invisible until they strike at runtime.
2.  **It's not serialization-friendly**: `Error` class instances lose their prototype chain when sent over the network as JSON, breaking `instanceof` checks.

This library solves these problems with the `Result<T, E>` type. Instead of throwing, functions return a `Result` object that explicitly represents either a success or a failure.

A `Result` is a union of two "variants":
- **`Ok<T>`**: Represents a successful outcome, containing a `data` field with the success value. In this variant, the `error` property is always `null`.
- **`Err<E>`**: Represents a failure outcome, containing an `error` field with the error value. In this variant, the `data` property is always `null`.

This structure allows TypeScript's control-flow analysis to act as if it's a **discriminated union**. By checking if `result.error === null`, TypeScript knows it must be an `Ok` variant and can safely access `result.data`. This makes error handling explicit, type-safe, and predictable.

---

## Installation

```bash
npm install @epicenterhq/result
```

---

## Understanding TaggedError

This library promotes a **serializable, type-safe error system** using plain objects instead of JavaScript's `Error` class. The foundation of this system is the `TaggedError` type.

### Why Plain Objects for Errors?

1.  **Serialization-First**: Plain objects can be easily serialized to JSON (`JSON.stringify`) and transmitted across boundaries (network APIs, IPC, web workers) without losing information, unlike `Error` classes.
2.  **Type Safety**: Use TypeScript's literal and union types to create a discriminated union of possible errors, allowing `switch` statements to safely narrow down error types.
3.  **Lightweight**: Avoids the overhead of class instantiation and the complexities of `instanceof` checks.
4.  **Structured Context**: Easily enforce that all errors carry structured, machine-readable context.

Every `TaggedError` contains four essential properties that work together to create a robust, debuggable error system:

### The Four Properties

```ts
type TaggedError<T extends string> = {
  readonly name: T;                    // 1. The discriminant
  message: string;                     // 2. Human-readable description  
  context: Record<string, unknown>;    // 3. Debugging data
  cause?: unknown;                     // 4. Root cause (optional)
};
```

#### 1. **`name`** - The Discriminant (Tagged Field)

This is your error's unique identifier and the key to pattern matching. Use it in `if` statements and `switch` statements to handle different error types:

```ts
type ValidationError = TaggedError<"ValidationError">;
type NetworkError = TaggedError<"NetworkError">;
type FileError = TaggedError<"FileError">;

function handleError(error: ValidationError | NetworkError | FileError) {
  switch (error.name) {
    case "ValidationError":
      // TypeScript knows this is ValidationError
      console.log("Invalid input:", error.context);
      break;
    case "NetworkError": 
      // TypeScript knows this is NetworkError
      console.log("Network failed:", error.message);
      break;
    case "FileError":
      // TypeScript knows this is FileError
      console.log("File issue:", error.context);
      break;
  }
}
```

#### 2. **`message`** - Human-Readable Text

Pure text description that explains what went wrong. Keep it clear and actionable:

```ts
return Err({
  name: "ValidationError",
  message: "Email address must contain an @ symbol",  // Clear, specific
  context: { email: userInput },
  cause: undefined
});
```

#### 3. **`context`** - Debugging Data

Include function inputs and any data that would help debug the issue. This is invaluable for logging and troubleshooting:

```ts
function processUser(id: number, options: UserOptions): Result<User, ProcessError> {
  return Err({
    name: "ProcessError",
    message: "User processing failed",
    context: {
      userId: id,           // Function input
      options,              // Function input  
      timestamp: new Date().toISOString(),  // Additional context
      retryCount: 3         // Useful debugging info
    },
    cause: undefined
  });
}
```

#### 4. **`cause`** - Root Cause Bubbling

- **For new errors**: Set `cause: undefined`
- **For wrapping existing errors**: Pass the original error as `cause`

```ts
// Creating a new error
return Err({
  name: "ValidationError",
  message: "Invalid user data",
  context: { input },
  cause: undefined  // New error, no underlying cause
});

// Wrapping an existing error
try {
  await database.save(user);
} catch (dbError) {
  return Err({
    name: "SaveError", 
    message: "Failed to save user",
    context: { userId: user.id },
    cause: dbError  // Bubble up the original database error
  });
}
```

### Creating Domain-Specific Errors

You can define a set of possible errors for a specific domain:

```typescript
// Define your specific error types
export type FileNotFoundError = TaggedError<"FileNotFoundError">;
export type PermissionDeniedError = TaggedError<"PermissionDeniedError">;
export type DiskFullError = TaggedError<"DiskFullError">;

// Create a union of all possible errors for this domain
export type FileSystemError = FileNotFoundError | PermissionDeniedError | DiskFullError;

// A factory function to create an error
function createFileNotFoundError(path: string, cause?: unknown): FileNotFoundError {
  return {
    name: "FileNotFoundError",
    message: `The file at path "${path}" was not found.`,
    context: { path },
    cause
  };
}
```

Because `name` is a unique literal type for each error, TypeScript can use it to discriminate between them in a `switch` statement:

```ts
function handleError(error: FileSystemError) {
  switch (error.name) {
    case "FileNotFoundError":
      // TypeScript knows `error` is `FileNotFoundError` here.
      console.error(`Path not found: ${error.context.path}`);
      break;
    case "PermissionDeniedError":
      // TypeScript knows `error` is `PermissionDeniedError` here.
      console.error("Permission was denied.");
      break;
    case "DiskFullError":
      // ...
      break;
  }
}
```

### Best Practices for Errors

#### 1. Include Meaningful Context
Always include function inputs and other relevant state in the `context` object. This is invaluable for logging and debugging.

```typescript
function createDbError(
  message: string,
  query: string,
  params: unknown[],
  cause: unknown
): DbError {
  return {
    name: "DbError",
    message,
    context: {
      query,
      params,
      timestamp: new Date().toISOString(),
    },
    cause,
  };
}
```

#### 2. Handle Errors at the Right Level
Handle or transform errors where you can add more context or make a recovery decision.

```ts
async function initializeApp(): Promise<Result<App, FsError | ValidationError>> {
  const configResult = await readConfig("./config.json");

  // Propagate the file system error directly if config read fails
  if (isErr(configResult)) {
    return configResult;
  }

  // If config is read, but is invalid, return a *different* kind of error
  const validationResult = validateConfig(configResult.data);
  if (isErr(validationResult)) {
    return validationResult;
  }

  return Ok(new App(validationResult.data));
}
```

This structure makes errors **trackable**, **debuggable**, and **type-safe** while maintaining clean separation between different failure modes in your application.

---

## Basic Usage

Now that you understand TaggedError, let's see how to use it with Result types:

```ts
import { Result, Ok, Err, isOk, type TaggedError } from "@epicenterhq/result";

// --- Example 1: A Safe Division Function ---

// 1. Define a specific error for math-related failures
type MathError = TaggedError<"MathError">;

// 2. Create a function that returns a Result with our structured error
function divide(numerator: number, denominator: number): Result<number, MathError> {
  if (denominator === 0) {
    return Err({
      name: "MathError",
      message: "Cannot divide by zero.",
      context: { numerator, denominator },
      cause: undefined 
    });
  }
  return Ok(numerator / denominator);
}

// 3. Handle the result
const divisionResult = divide(10, 0);

if (!isOk(divisionResult)) {
  // `divisionResult.error` is a fully-typed MathError object
  console.error(`Error (${divisionResult.error.name}): ${divisionResult.error.message}`);
  console.log("Context:", divisionResult.error.context); // { numerator: 10, denominator: 0 }
}

// --- Example 2: Parsing a User Object ---

// 1. Define a specific error for parsing failures
type ParseError = TaggedError<"ParseError">;

// 2. Create a function that returns a Result with our structured error
function parseUser(json: string): Result<{ name: string }, ParseError> {
  try {
    const data = JSON.parse(json);
    if (typeof data.name !== "string") {
      return Err({
        name: "ParseError",
        message: "User object must have a name property of type string.",
        context: { receivedValue: data.name },
        cause: undefined
      });
    }
    return Ok(data);
  } catch (e) {
    return Err({
      name: "ParseError",
      message: "Invalid JSON provided.",
      context: { rawString: json },
      cause: e,
    });
  }
}

// 3. Handle the result
const userResult = parseUser('{"name": "Alice"}');

if (isOk(userResult)) {
  console.log(`Welcome, ${userResult.data.name}!`);
} else {
  // `userResult.error` is a fully-typed ParseError object
  console.error(`Error (${userResult.error.name}): ${userResult.error.message}`);
  console.log("Context:", userResult.error.context);
}
```

---

## Handling Operation Outcomes

Now that you can create Result values with structured errors, let's explore the two main patterns for working with Results in your application code. Choose the pattern that best fits your preference for code style and the specific context of your code.

### Pattern 1: Destructuring (Preferred)

This pattern will feel familiar to developers working with modern libraries like Supabase or Astro Actions. You can destructure the `data` and `error` properties directly from the result object and use a simple conditional check on the `error` property.

This approach is often cleaner and more direct for handling the two possible outcomes, as it gives you immediate access to the inner `data` and `error` values.

```ts
const { data, error } = divide(10, 2);

if (error) {
  // `error` holds the inner error value from the Err variant.
  console.error(`An error occurred: ${error}`);
  return; // Or handle the error appropriately
}

// If `error` is null, `data` holds the inner success value from the Ok variant.
// In most modern TypeScript setups, `data` will be correctly inferred as `number`.
console.log(`The result is: ${data}`);
```

### Pattern 2: Using Type Guards

In some complex scenarios or with certain TypeScript configurations, the compiler might not be able to perfectly infer the relationship between `data` and `error` when they are destructured into separate variables. In these cases, using the `isOk()` and `isErr()` type guards is a more robust solution. TypeScript's control flow analysis is designed to work flawlessly with this pattern, guaranteeing type safety within each conditional block.

```ts
import { isOk, isErr } from "@epicenterhq/result";

const result = divide(10, 0); // This returns an Err variant

if (isErr(result)) {
  // TypeScript *guarantees* that `result` is `Err<string>` here.
  // The `result.data` property is `null`.
  // The `result.error` property is `string`.
  const errorValue = result.error; // string
  console.error(errorValue);

} else {
  // If it's not an error, it must be a success.
  // TypeScript *guarantees* that `result` is `Ok<number>` here.
  // The `result.error` property is `null`.
  // The `result.data` property is `number`.
  const successValue = result.data; // number
  console.log(successValue);
}
```

> **When to use Type Guards:** While destructuring is preferred for its simplicity, reach for `isOk()` and `isErr()` whenever you notice that TypeScript isn't correctly narrowing the type of `data` after an error check. This ensures your code remains fully type-safe without needing manual type assertions.

---

## Wrapping Functions That Throw

When integrating with existing code that throws exceptions (like `JSON.parse`, fetch APIs, or database clients), you'll need a way to convert these throwing functions into safe `Result`-returning functions. This library provides `trySync` and `tryAsync` to handle this conversion seamlessly.

### Synchronous Operations with `trySync`

Use `trySync` for synchronous functions that might throw. You provide the operation and a `mapError` function to transform the caught exception into your desired error type.

```ts
import { trySync, Result } from "@epicenterhq/result";

function parseJson(raw: string): Result<object, Error> {
  return trySync({
    try: () => JSON.parse(raw),
    mapError: (err: unknown) => err as Error, // Map the unknown error to a typed Error
  });
}

const result = parseJson('{"key": "value"}'); // Ok<{key: string}>
const failedResult = parseJson('not json'); // Err<SyntaxError>
```

### Asynchronous Operations with `tryAsync`

Use `tryAsync` for functions that return a `Promise`. It handles both rejected promises and synchronous throws within the async function.

```ts
import { tryAsync, Result } from "@epicenterhq/result";

type User = { id: number; name: string };
type NetworkError = { message: string; statusCode?: number };

async function fetchUser(userId: number): Promise<Result<User, NetworkError>> {
  return tryAsync({
    try: async () => {
      const response = await fetch(`https://api.example.com/users/${userId}`);
      if (!response.ok) {
        // You can throw a custom error object
        throw { message: "Request failed", statusCode: response.status };
      }
      return response.json();
    },
    mapError: (err: unknown) => err as NetworkError, // Transform the caught error
  });
}

const userResult = await fetchUser(1);
```

---

## API Reference

### Quick Reference Table

| Function | Purpose | Example |
|----------|---------|---------|
| `Ok(data)` | Create success result | `Ok("hello")` |
| `Err(error)` | Create failure result | `Err("failed")` |
| `isOk(result)` | Check if success | `if (isOk(res)) { ... }` |
| `isErr(result)` | Check if failure | `if (isErr(res)) { ... }` |
| `trySync()` | Wrap throwing function | `trySync({ try: () => JSON.parse(str) })` |
| `tryAsync()` | Wrap async throwing function | `tryAsync({ try: () => fetch(url) })` |

### Detailed API

#### Types
- **`Result<T, E>`**: The core union type, representing `Ok<T> | Err<E>`.
- **`Ok<T>`**: Represents a success. Contains `{ data: T; error: null; }`.
- **`Err<E>`**: Represents a failure. Contains `{ data: null; error: E; }`.
- **`BaseError` / `TaggedError<T>`**: Helpers for creating a structured error system.

#### Core Result Functions
- **`Ok(data)`**: Creates a success `Result`.
- **`Err(error)`**: Creates a failure `Result`.
- **`isOk(result)`**: Type guard. Returns `true` if the result is an `Ok` variant.
- **`isErr(result)`**: Type guard. Returns `true` if the result is an `Err` variant.
- **`unwrap(result)`**: Unwraps a `Result`, returning data on `Ok` or throwing error on `Err`.
- **`resolve(value)`**: Resolves a value that may or may not be a `Result`, returning the final value or throwing on `Err`.
- **`isResult(value)`**: Type guard. Returns `true` if a value has the shape of a `Result`.

#### Async/Sync Wrappers
- **`trySync({ try, mapError })`**: Wraps a synchronous function that may throw.
- **`tryAsync({ try, mapError })`**: Wraps an asynchronous function that may throw or reject.

#### Error Utilities
- **`extractErrorMessage(error)`**: Safely extracts a string message from any error value.

#### Utility Functions
- **`partitionResults(results)`**: Partitions an array of Results into separate arrays of `Ok` and `Err` variants.

---

## Design Philosophy

This library is built on a set of core principles designed to create a robust, predictable, and developer-friendly experience. Understanding these principles will help you get the most out of the library and see why its API is designed the way it is.

### 1. Embrace JavaScript Primitives

A fundamental disagreement we have with some otherwise excellent libraries is the idea that JavaScript's core abstractions need to be completely reinvented. While we have immense respect for the power and type-level ingenuity of ecosystems like Effect-TS, we believe the cost of onboarding developers to an entirely new programming paradigm (like generators for async control flow) is too high for most projects.

This library is built on the philosophy of leaning into JavaScript's native primitives whenever they are "good enough." We prefer to build on the familiar foundations of `async/await`, `Promise`, and standard union types (`T | null`) because they are already well-understood by the vast majority of TypeScript developers. This drastically reduces the learning curve and makes the library easy to adopt incrementally.

We only introduce new abstractions where JavaScript has a clear and significant weakness. In our view, the two biggest pain points in modern TypeScript are:
1.  **Error Handling**: The imperative nature of `try/catch` and the non-serializable, class-based `Error` object.
2.  **Data Validation**: Ensuring that `unknown` data conforms to a known type at runtime.

This library provides `Result` to solve the first problem. It intentionally omits an `Option` type because native features like optional chaining (`?.`) and nullish coalescing (`??`) provide excellent and familiar ergonomics for handling optional values.

### 2. Prioritize Ergonomics and Pragmatism

Flowing from the first principle, our API design prioritizes developer experience. This is most evident in our choice of the `{ data, error }` shape for the `Result` type. The ability to destructure `const { data, error } = ...` is a clean, direct, and pragmatic pattern that is already familiar to developers using popular libraries like Supabase and Astro Actions. We chose this pattern for its superior ergonomics, even if other patterns might be considered more "academically pure."

### 3. Lightweight, Zero-Dependency, and Tree-Shakable

This library is designed to be as lightweight as possible. It ships with **zero runtime dependencies**, meaning it won't add any extra weight to your `node_modules` folder or your final bundle.

Every function is exported as a pure, standalone module, making the entire library **tree-shakable**. If you only use the `Result` type and the `isOk` function, the rest of the library's code won't be included in your application's build.

We believe a library should have a focused scope and not be overwhelming. While comprehensive ecosystems like Effect-TS are incredibly powerful, their scope can be daunting. This library aims to solve the specific and critical problem of type-safe error handling without pulling in a large, all-encompassing framework. It's a small tool that does one job well.

### 4. Serialization-First

A core requirement of this library is that all of its data structures, especially errors, must be reliably serializable. They need to behave identically whether you are passing them between functions, sending them over a network (HTTP), or passing them to a web worker. This is why the library fundamentally avoids classes for its error-handling system and instead promotes plain objects.

### 5. Opinionated yet Flexible

This library is opinionated in that it provides a clear, recommended path for best practices. We believe that a degree of standardization leads to more maintainable and predictable codebases. However, these opinions are not enforced at a technical level. The core `Result` type is deliberately decoupled from the error system, meaning you are free to use a different error implementation if your project requires it.

## Inspirations and Relationship to Effect-TS

This library's approach is heavily inspired by the powerful concepts pioneered by the **[Effect-TS](https://github.com/Effect-TS/effect)** ecosystem. Effect has indelibly shaped our thinking on how to structure services, handle errors, and compose applications in a type-safe way.

However, this library represents a different set of trade-offs and priorities, based on a few key disagreements with the Effect-TS approach:

1.  **Familiarity Over Novelty**: While we agree that Promises can be a flawed abstraction, we believe the cost of replacing them entirely is too high for most teams. Effect introduces a new, powerful, but unfamiliar execution model based on generators (`yield`), which requires a significant investment to learn. This library chooses to embrace the familiar patterns of `async/await` and Promises, even with their imperfections, to ensure a gentle learning curve. The goal is to provide 80% of the benefit with 20% of the learning curve.

2.  **Simplicity and Lightweight Integration**: We aim for this library to be as lightweight as possible, easy to adopt incrementally, and simple to integrate with other tools. It is not an all-encompassing application framework but rather a focused tool to solve the specific problem of `Result`-based error handling.

That said, the influence of Effect is clear. Functions like `trySync` and `tryAsync` are directly inspired by similar utilities in Effect. The core difference is that we aim to apply these powerful concepts on top of familiar JavaScript primitives, rather than creating a new ecosystem around them. This philosophy also informs our decision to omit an `Option<T>` type, as we believe that native TypeScript features (`T | null`, optional chaining, and nullish coalescing) are "good enough" and more idiomatic for the majority of use cases.

---

## FAQ

### Why `{ data, error }` instead of a boolean flag like `{ ok: boolean, ... }`?

Some libraries use a discriminated union with a boolean flag, like `{ ok: true, data: T } | { ok: false, error: E }`. While a valid pattern, we chose the `{ data, error }` shape for two main reasons:

1.  **Ergonomics and Familiarity**: The destructuring pattern `const { data, error } = operation()` is clean and will feel familiar to developers using modern libraries like Supabase and Astro Actions. It provides immediate access to the inner values without an extra layer of property access. Checking a boolean flag first (`if (result.ok)`) and then accessing the value (`result.data`) is slightly more verbose.

2.  **Lack of Standardization**: The boolean flag approach isn't standardized. Zod's `.safeParse`, for example, returns `{ success: boolean, ... }`. By adopting the `{ data, error }` pattern, we align with a simple, common, and intuitive structure for handling success and failure states in modern JavaScript.

### What's the difference between an `Err` variant and an `error` value?

This is a key distinction in the library's terminology:

-   **`Err<E>` (The Variant/Container)**: This is one of the two possible "shapes" of a `Result` object. It's the wrapper itself, whose structure is `{ data: null, error: E }`. You can think of it as the box that signifies a failure.

-   **`error` (The Value/Payload)**: This is the actual *value* inside the `Err` container. It is the content of the `error` property on the `Err` object. This is the piece of data that describes what went wrong, and its type is `E`.

When you use the `isErr()` type guard, you are checking if a `Result` is the `Err` variant. Once that check passes, you can then access the `.error` property to get the error value.

### Why doesn't this library include an `Option<T>` type?

An `Option<T>` type (sometimes called `Maybe`) is common in other languages to represent a value that might be missing. However, we've intentionally omitted it because **modern JavaScript and TypeScript already have excellent, first-class support for handling potentially missing values.**

A custom `Option<T>` type would add a layer of abstraction that is largely unnecessary. Instead, you can and should use:

1.  **Union Types with `null`**: Simply type your value as `T | null`. This is the idiomatic way to represent an optional value in TypeScript.

2.  **Optional Chaining (`?.`)**: Safely access nested properties of an object that might be null or undefined.
    ```ts
    const street = user?.address?.street; // Returns undefined if user or address is null/undefined
    ```

3.  **Nullish Coalescing (`??`)**: Provide a default value for a `null` or `undefined` expression.
    ```ts
    const displayName = user.name ?? "Guest";
    ```

These built-in language features provide better ergonomics and are more familiar to JavaScript developers than a custom `Option` type would be. This library focuses on solving for `Result`, where the language does not have a built-in equivalent.