# wellcrafted

[![npm version](https://badge.fury.io/js/wellcrafted.svg)](https://www.npmjs.com/package/wellcrafted)
[![TypeScript](https://img.shields.io/badge/TypeScript-Ready-blue.svg)](https://www.typescriptlang.org/)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Bundle Size](https://img.shields.io/bundlephobia/minzip/wellcrafted)](https://bundlephobia.com/package/wellcrafted)

*Delightful TypeScript utilities for elegant, type-safe applications*

This library provides a robust, Rust-inspired `Result` type, elegant brand types, and a lightweight, serializable error handling system for TypeScript. It's designed to help you write more predictable, type-safe, and composable code by making error handling an explicit part of your function signatures.

## Table of Contents

- [Quick Start](#quick-start)
- [Core Idea: The Result Type](#core-idea-the-result-type)
- [Installation](#installation)
- [Handling Operation Outcomes](#handling-operation-outcomes)
- [Understanding TaggedError](#understanding-taggederror)
- [Basic Usage](#basic-usage)
- [Wrapping Functions That Throw](#wrapping-functions-that-throw)
- [API Reference](#api-reference)
- [Design Philosophy](#design-philosophy)
- [FAQ](#faq)

## Quick Start

**30-second example:** Transform throwing async operations into type-safe Results.

```bash
npm install wellcrafted
```

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

---

## Core Idea: The Result Type

> **💡 TL;DR:** Replace `throw new Error()` with `return Err()` to make errors visible in your function signatures.

JavaScript's traditional error handling, based on `try...catch` and throwing `Error` objects, has two major drawbacks for modern application development:
1.  **It's not type-safe**: A function signature `function doSomething(): User` doesn't tell you that it might throw a `NetworkError` or a `ValidationError`. Errors are invisible until they strike at runtime.
2.  **It's not serialization-friendly**: `Error` instances lose their prototype chain when crossing serialization boundaries (JSON.stringify/parse, network requests, worker threads), breaking `instanceof` checks.

This library solves these problems with the `Result<T, E>` type. Instead of throwing, functions return a `Result` object that explicitly represents either a success or a failure.

A `Result` is a union of two "variants":
- **`Ok<T>`**: Represents a successful outcome, containing a `data` field with the success value. In this variant, the `error` property is always `null`.
- **`Err<E>`**: Represents a failure outcome, containing an `error` field with the error value. In this variant, the `data` property is always `null`.

This structure allows TypeScript's control-flow analysis to act as if it's a **discriminated union**. By checking if `result.error === null`, TypeScript knows it must be an `Ok` variant and can safely access `result.data`. This makes error handling explicit, type-safe, and predictable.

### Anatomy of a Result Type

Here's the complete TypeScript implementation - it's simpler than you might think:

```ts
// The two possible outcomes
export type Ok<T> = { data: T; error: null };
export type Err<E> = { error: E; data: null };

// Result is just a union of these two types
export type Result<T, E> = Ok<T> | Err<E>;

// Helper functions to create each variant
export const Ok = <T>(data: T): Ok<T> => ({ data, error: null });
export const Err = <E>(error: E): Err<E> => ({ error, data: null });
```

**That's it!** The entire foundation is built on this elegant simplicity:

- **`Ok<T>`** always has `data: T` and `error: null`
- **`Err<E>`** always has `error: E` and `data: null`  
- **`Result<T, E>`** is simply `Ok<T> | Err<E>`

This design creates a **discriminated union** where the `error` (or `data`) property acts as the discriminant (with literal types `null` vs non-null), allowing TypeScript to automatically narrow types:

```ts
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

The beauty is in the transparency - you can see exactly how it works under the hood, yet it provides powerful type safety and ergonomics.

---

## Installation

```bash
npm install wellcrafted
```

---

## Handling Operation Outcomes

Once you have a `Result`, there are two main patterns for working with it. Choose the pattern that best fits your preference for code style and the specific context of your code.

### Pattern 1: Destructuring (Preferred)

This pattern will feel familiar to developers working with modern libraries like Supabase or Astro Actions. You can destructure the `data` and `error` properties directly from the result object and use a simple conditional check on the `error` property.

This approach is often cleaner and more direct for handling the two possible outcomes, as it gives you immediate access to the inner `data` and `error` values.

```ts
const { data, error } = someOperation();

if (error) {
  // `error` holds the inner error value from the Err variant.
  console.error(`An error occurred: ${error.message}`);
  return; // Or handle the error appropriately
}

// If `error` is null, `data` holds the inner success value from the Ok variant.
// In most modern TypeScript setups, `data` will be correctly inferred as the success type.
console.log(`The result is: ${data}`);
```

### Pattern 2: Using Type Guards

In some complex scenarios or with certain TypeScript configurations, the compiler might not be able to perfectly infer the relationship between `data` and `error` when they are destructured into separate variables. In these cases, using the `isOk()` and `isErr()` type guards is a more robust solution. TypeScript's control flow analysis is designed to work flawlessly with this pattern, guaranteeing type safety within each conditional block.

```ts
import { isOk, isErr } from "wellcrafted/result";

const result = someOperation();

if (isErr(result)) {
  // TypeScript *guarantees* that `result` is `Err<E>` here.
  // The `result.data` property is `null`.
  // The `result.error` property contains the error value.
  const errorValue = result.error;
  console.error(errorValue);

} else {
  // If it's not an error, it must be a success.
  // TypeScript *guarantees* that `result` is `Ok<T>` here.
  // The `result.error` property is `null`.
  // The `result.data` property contains the success value.
  const successValue = result.data;
  console.log(successValue);
}
```

> **When to use Type Guards:** While destructuring is preferred for its simplicity, reach for `isOk()` and `isErr()` whenever you notice that TypeScript isn't correctly narrowing the type of `data` after an error check. This ensures your code remains fully type-safe without needing manual type assertions.

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
  context?: Record<string, unknown>;    // 3. Function inputs & debugging data (optional)
  cause: unknown;                     // 4. Root cause
};
```

> The `context` property should include the function's input parameters and any relevant variables in the closure. If there are none, then it can be omitted. This creates a complete picture of what data led to the error, making debugging straightforward.

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

#### 3. **`context`** - Function Inputs & Debugging Data

The primary purpose of `context` is to capture the function's input parameters, relevant variables in the closure, and additional context.

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

Now that you understand how to handle Result values and the TaggedError structure, let's see complete examples that combine both concepts:

```ts
import { Result, Ok, Err, isOk } from "wellcrafted/result";
import { type TaggedError } from "wellcrafted/error";

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

## Wrapping Functions That Throw

When integrating with existing code that throws exceptions (like `JSON.parse`, fetch APIs, or database clients), you'll need a way to convert these throwing functions into safe `Result`-returning functions. This library provides `trySync` and `tryAsync` to handle this conversion seamlessly.

### Synchronous Operations with `trySync`

Use `trySync` for synchronous functions that might throw. You provide the operation and a `mapError` function to transform the caught exception into your desired error type.

```ts
import { trySync, Result } from "wellcrafted/result";
import { type TaggedError } from "wellcrafted/error";

type ParseError = TaggedError<"ParseError">;

function parseJson(raw: string): Result<object, ParseError> {
  return trySync({
    try: () => JSON.parse(raw),
    mapError: (error) => ({
      name: "ParseError",
      message: "Failed to parse JSON",
      context: { raw },
      cause: error
    })
  });
}

const result = parseJson('{"key": "value"}'); // Ok<{key: string}>
const failedResult = parseJson('not json'); // Err<ParseError>
```

### Asynchronous Operations with `tryAsync`

Use `tryAsync` for functions that return a `Promise`. It handles both rejected promises and synchronous throws within the async function.

```ts
import { tryAsync, Result } from "wellcrafted/result";
import { type TaggedError } from "wellcrafted/error";

type User = { id: number; name: string };
type NetworkError = TaggedError<"NetworkError">;

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
    mapError: (error) => ({
      name: "NetworkError",
      message: "Failed to fetch user",
      context: { userId },
      cause: error
    })
  });
}

const userResult = await fetchUser(1);
```

### Type Safety with Generics

When using `trySync` and `tryAsync`, you have two approaches to ensure your `mapError` function returns the correct TaggedError type:

#### Approach 1: Explicit Generics

Pass the success type and error type as generic parameters. This approach is clear and explicit about the expected types:

```ts
// For tryAsync
async function readConfig(path: string) {
  return tryAsync<string, FileError>({  // 👈 <SuccessType, ErrorType>
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

// For trySync
function parseConfig(content: string) {
  return trySync<Config, ParseError>({  // 👈 <SuccessType, ErrorType>
    try: () => {
      const parsed = JSON.parse(content);
      validateConfig(parsed); // throws if invalid
      return parsed as Config;
    },
    mapError: (error) => ({
      name: "ParseError",
      message: "Invalid configuration format",
      context: { contentLength: content.length },
      cause: error
    })
  });
}
```

#### Approach 2: Return Type Annotation on mapError

Annotate the return type of the `mapError` function. This approach can be cleaner when generics would format awkwardly:

```ts
// For tryAsync
async function saveUser(user: User) {
  return tryAsync({
    try: async () => {
      const result = await db.users.insert(user);
      return result.id;
    },
    mapError: (error): DatabaseError => ({  // 👈 Annotate return type
      name: "DatabaseError",
      message: "Failed to save user to database",
      context: { userId: user.id },
      cause: error
    })
  });
}

// For trySync
function validateEmail(email: string) {
  return trySync({
    try: () => {
      if (!email.includes('@')) {
        throw new Error('Invalid email format');
      }
      return email.toLowerCase();
    },
    mapError: (error): ValidationError => ({  // 👈 Annotate return type
      name: "ValidationError",
      message: "Email validation failed",
      context: { email },
      cause: error
    })
  });
}
```

**Key points:**
- Both approaches ensure `mapError` returns your exact TaggedError type
- Avoid using `as const` - always map to proper TaggedError objects
- Choose explicit generics for clarity, or return type annotation for brevity
- The important thing is ensuring type safety for your error handling

---

## Partitioning Results

When working with multiple asynchronous operations that return `Result` objects, you'll often need to separate the successful results from the failed ones. The `partitionResults` utility function makes this easy by splitting an array of Results into two separate arrays.

### When to Use `partitionResults`

Use `partitionResults` when you have:
- Multiple async operations that might fail independently
- A need to handle all errors collectively
- Successful results that should be processed together

### Common Pattern: Map → Filter → Partition

This is a typical workflow when processing multiple commands or operations:

```ts
import { partitionResults } from "wellcrafted/result";

// Example: Processing multiple commands that might fail
const results = await Promise.all(
  commands
    .map((command) => {
      const config = getCommandConfig(command.id);
      if (!config) return; // Early return if config missing
      return executeCommand({ command, config });
    })
    .filter((result) => result !== undefined) // Remove undefined values
);

const { oks, errs } = partitionResults(results);

// Handle all errors at once
if (errs.length > 0) {
  const errorMessages = errs.map(({ error }) => error.message).join(', ');
  showNotification(`${errs.length} operations failed: ${errorMessages}`);
  return;
}

return oks.map(ok => ok.data); // Return processed content
```

### Real-World Example: Batch File Processing

```ts
import { tryAsync, partitionResults } from "wellcrafted/result";
import { type TaggedError } from "wellcrafted/error";
import * as fs from 'fs/promises';

type FileError = TaggedError<"FileError">;

async function processFiles(filePaths: string[]) {
  // Map each file path to a Result-returning operation
  const results = await Promise.all(
    filePaths
      .map((path) => {
        if (!path.endsWith('.txt')) return; // Skip non-text files
        return tryAsync<string, FileError>({
          try: async () => {
            const content = await fs.readFile(path, 'utf-8');
            return content.toUpperCase(); // Process the content
          },
          mapError: (error) => ({
            name: "FileError",
            message: "Failed to process file",
            context: { path },
            cause: error
          })
        });
      })
      .filter((result) => result !== undefined)
  );

  const { oks, errs } = partitionResults(results);

  // Report all errors together
  if (errs.length > 0) {
    console.error(`Failed to process ${errs.length} files:`);
    errs.forEach(err => {
      console.error(`- ${err.error.context.path}: ${err.error.message}`);
    });
  }

  // Process successful results
  if (oks.length > 0) {
    console.log(`Successfully processed ${oks.length} files`);
    return oks.map(ok => ok.data); // Return processed content
  }

  return [];
}
```

### Key Benefits

1. **Batch Error Handling**: Instead of stopping at the first error, you can collect all failures and present them together
2. **Type Safety**: The returned `oks` and `errs` arrays are properly typed as `Ok<T>[]` and `Err<E>[]` respectively
3. **Clean Separation**: Successful and failed operations are cleanly separated for different handling logic
4. **Composability**: Works seamlessly with the map → filter → partition pattern for complex data processing

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
| `partitionResults()` | Split Results into oks/errs | `const { oks, errs } = partitionResults(results)` |

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

Some libraries use a boolean flag for their discriminated union, like `{ ok: true, data: T } | { ok: false, error: E }`. While a valid pattern, we chose the `{ data, error }` shape for two main reasons:

1.  **Ergonomics and Familiarity**: The destructuring pattern `const { data, error } = operation()` is clean and will feel familiar to developers using modern libraries like Supabase and Astro Actions. It provides immediate access to the inner values without an extra layer of property access. Checking a boolean flag first (`if (result.ok)`) and then accessing the value (`result.data`) is slightly more verbose.

2.  **Lack of Standardization**: The boolean flag approach isn't standardized. Zod's `.safeParse`, for example, returns `{ success: boolean, ... }`. By adopting the `{ data, error }` pattern, we align with a simple, common, and intuitive structure for handling success and failure states in modern JavaScript.

**Note**: The `{ data, error }` pattern is also a discriminated union—you can use either `data` or `error` as the discriminant key and check if either of them is null. This creates the same type-narrowing benefits as a boolean flag while maintaining cleaner destructuring ergonomics.

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