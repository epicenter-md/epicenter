# Comprehensive Error Handling Guide

A deep dive into effective error handling patterns using the lightweight tagged error system.

## Philosophy: Errors as Data

This library treats errors as first-class data rather than exceptional control flow. This approach, inspired by functional programming languages like Rust and Go, offers several advantages:

1. **Explicit Error Handling**: All potential failures are visible in function signatures
2. **Composable Error Handling**: Errors can be transformed, chained, and recovered from systematically
3. **Serializable by Design**: Errors are plain objects that can cross any boundary
4. **Type-Safe Error Handling**: Full TypeScript support for tagged union error types and recovery patterns

## Terminology

### Key Concepts

- **Error Type**: The actual error value (e.g., `ValidationError`, `NetworkError`) that follows the convention of ending with "Error" suffix
- **Err Data Structure**: The wrapper `{ error: E; data: null }` that contains an error type in the Result system
- **Result**: The union type `Ok<T> | Err<E>` that represents either success or failure

## Tagged Union Error System

### Why "Tagged" Errors?

The error system uses **tagged unions** (also called discriminated unions), where the `name` property acts as a **tag** that allows TypeScript to:

1. **Discriminate between error types** at compile time
2. **Enable exhaustive pattern matching** in switch statements
3. **Provide intelligent autocomplete** and type narrowing
4. **Catch missing error handling cases** at compile time

```typescript
// The "name" property is the tag that discriminates between error types
// Note: Error types follow the convention of ending with "Error" suffix
type AppError = 
  | { name: "ValidationError"; context: { field: string; value: unknown } }
  | { name: "NetworkError"; context: { url: string; status: number } }
  | { name: "DatabaseError"; context: { query: string; table: string } };

// TypeScript can exhaustively check all cases
function handleAppError(error: AppError) {
  switch (error.name) { // TypeScript knows this is the discriminant tag
    case "ValidationError":
      // TypeScript narrows to ValidationError type here
      console.log(`Validation failed for field: ${error.context.field}`);
      break;
    case "NetworkError":
      // TypeScript narrows to NetworkError type here
      console.log(`Network error: ${error.context.status}`);
      break;
    case "DatabaseError":
      // TypeScript narrows to DatabaseError type here
      console.log(`Database error in table: ${error.context.table}`);
      break;
    // TypeScript will warn if we miss any cases!
  }
}
```

## Design Decision: Why No Generator Function?

While this library provides the foundational `BaseError` structure and `TaggedError` type as an opinionated choice for the framework, you might wonder why there isn't a built-in generator function to simplify the creation of typed error handling functions.

### The BaseError Foundation

The library establishes `BaseError` as the foundation for all error types:

```typescript
export type BaseError = Readonly<{
  name: string;
  message: string;
  context: Record<string, unknown>;
  cause: unknown;
}>;

export type TaggedError<T extends string> = BaseError & {
  readonly name: T;
};
```

This structure is an **opinionated design choice** that provides:
- **Consistent error shape** across all applications
- **Serializable error objects** that can cross any boundary
- **Rich context preservation** for debugging and monitoring
- **Type-safe discrimination** through the `name` tag

### The Generator Function Experiment

A helper function like `createTryFns` could theoretically simplify error creation:

```typescript
export function createTryFns<TName extends string>(name: TName) {
	type TError = TaggedError<TName>;
	return {
		trySync: <T>({
			try: operation,
			catch: catchFn,
		}: {
			try: () => T;
			catch: (error: unknown) => Omit<TError, "name">;
		}) =>
			trySync<T, TError>({
				try: operation,
				catch: (error) => Err({
					...catchFn(error),
					name,
				}),
			}),
		tryAsync: <T>({
			try: operation,
			catch: catchFn,
		}: {
			try: () => Promise<T>;
			catch: (error: unknown) => Omit<TError, "name">;
		}) =>
			tryAsync<T, TError>({
				try: operation,
				catch: (error) => Err({ ...catchFn(error), name }),
			}),
	};
}
```

**Usage example:**

```typescript
import {
  type Result,
  type TaggedError,
  createTryFns,
} from 'wellcrafted/result';

export type ClipboardServiceError = TaggedError<'ClipboardServiceError'>;
export const clipboardService = createTryFns('ClipboardServiceError');

export function createClipboardServiceExtension(): ClipboardService {
  return {
    setClipboardText: (text) =>
      clipboardService.tryAsync({
        try: () => navigator.clipboard.writeText(text),
        catch: (error) => Err({
          message: 'Unable to write to clipboard',
          context: { text },
          cause: error,
        }),
      }),

    writeTextToCursor: (text) =>
      clipboardService.trySync({
        try: () => writeTextToCursor(text),
        catch: (error) => Err({
          message: 'Unable to paste text to cursor',
          context: { text },
          cause: error,
        }),
      }),
  };
}
```

### Why This Approach Was Rejected

After multiple attempts at implementing and using generator functions, several ergonomic issues emerged:

#### 1. **Complex Type Inference**
The generator function creates a layer of indirection that makes TypeScript's type inference less predictable. Users often need to provide explicit type annotations that wouldn't be necessary with direct `tryAsync`/`trySync` usage.

#### 2. **Verbose Function Passing**
You end up passing around generator functions, which creates gnarly syntax:
```typescript
// With generator - passing functions around
const { tryAsync } = createTryFns('MyError');
await someFunction(tryAsync);

// Without generator - plain objects are simpler
await tryAsync({ try: operation, catch: mapper });
```

#### 3. **Hidden Error Structure**
The generator obscures the actual error object structure, making it less clear what the final error will look like. With direct usage, the error shape is explicit and visible.

#### 4. **Import Complexity**
Generator functions require additional imports and setup:
```typescript
// Generator approach - more imports, more setup
import { createTryFns, type TaggedError } from 'wellcrafted/result';
export type MyError = TaggedError<'MyError'>;
export const myErrorHandlers = createTryFns('MyError');

// Direct approach - simpler imports
import { tryAsync, type TaggedError } from 'wellcrafted/result';
export type MyError = TaggedError<'MyError'>;
```

#### 5. **Reduced Flexibility**
Generator functions lock you into a specific pattern. Direct usage allows for more flexibility in error mapping and handling edge cases.

#### 6. **Plain Objects Are Better**
Having plain, visible error objects is more transparent and easier to reason about than function-generated abstractions. You can see exactly what you're creating.

### Error Constructor Functions: Another Rejected Approach

You might consider a simpler alternative to generator functions: error constructor functions that just add the `name` property:

```typescript
export const ClipboardServiceErr = (
  error: Omit<ClipboardServiceError, 'name'>,
) => {
  return Err({
    name: 'ClipboardServiceError',
    ...error,
  });
};

export function createClipboardServiceExtension(): ClipboardService {
  return {
    setClipboardText: (text) =>
      tryAsync({
        try: () => navigator.clipboard.writeText(text),
        catch: (error) => Err(
          ClipboardServiceErr({
            message: 'Unable to write to clipboard',
            context: { text },
            cause: error,
          }),
      }),

    writeTextToCursor: (text) =>
      trySync({
        try: () => writeTextToCursor(text),
        catch: (error) => Err(
          ClipboardServiceErr({
            message: 'Unable to paste text to cursor',
            context: { text },
            cause: error,
          }),
      }),
  };
}
```

While this approach is simpler than the full generator function pattern, it still suffers from several issues that make it less desirable than direct error object creation:

#### **Hidden Implementation Details**
When you see `ClipboardServiceErr(...)` in your code, you can't immediately know what this function does without examining its implementation. The function could potentially:
- Add multiple properties beyond just `name`
- Transform the input in unexpected ways
- Have side effects like logging
- Change behavior over time as the implementation evolves

#### **Unnecessary Abstraction Layer**
The function serves only to add a single property (`name`) to an object. This minimal functionality doesn't justify the abstraction overhead. You're essentially trading one line of clarity for a function call.

#### **Editor Obfuscation**
In your text editor, when you click on `ClipboardServiceErr`, you navigate to a function definition rather than seeing the actual error structure inline. This breaks the immediate visual connection between the error usage and its shape.

#### **Extra Indentation**
Constructor functions require an additional function call, which often leads to more indentation levels:

```typescript
// With constructor function - more indentation
catch: (error) => Err(
  ClipboardServiceErr({
    message: 'Unable to write to clipboard',
    context: { text },
    cause: error,
  }),

// Direct approach - flatter structure  
catch: (error) => Err( ({
  name: 'ClipboardServiceError',
  message: 'Unable to write to clipboard',
  context: { text },
  cause: error,
}),
```

#### **Refactoring Trade-offs**
Yes, constructor functions make refactoring error names easier (change in one place vs. find-and-replace), but this convenience comes at the cost of:
- Runtime overhead (function calls)
- Cognitive overhead (additional abstraction)
- Debugging complexity (extra stack frame)
- Code clarity (hidden behavior)

The refactoring benefit is a **worthwhile trade-off** for the increased transparency and simplicity of direct object creation.

### The Philosophy: Explicit Over Convenient

Both generator functions and error constructor functions prioritize convenience over explicitness. The direct approach is preferred because:

- **What you see is what you get**: The error object shape is immediately visible
- **No hidden behavior**: Every property is explicitly declared at the usage site
- **Simpler mental model**: No functions to understand, just plain object creation
- **Better inline documentation**: The error structure serves as its own documentation
- **Minimal abstraction**: Only abstractions that provide significant value are justified

**Explicit error handling over convenient abstractions.** While generator functions and constructor functions might save a few lines of code, they introduce cognitive overhead and reduce transparency. The current approach prioritizes:

- **Clarity**: You can see exactly what error objects are being created
- **Simplicity**: Fewer abstractions to learn and understand  
- **Flexibility**: No constraints imposed by function signatures
- **Debuggability**: Error creation is traceable and obvious

### Using Alternative Patterns (If You Want To)

Both the `createTryFns` generator function and error constructor patterns are viable alternatives included in or possible with the library. However, they're not the recommended approach. If you find these patterns suit your team's preferences, you can use them, but be aware of the trade-offs discussed above.

**Recommendation**: Start with the direct `tryAsync`/`trySync` approach with inline error object creation. Only consider alternative patterns if you have many similar error handlers and the benefits outweigh the ergonomic costs for your specific use case.

## Error Classification Framework

### By Origin: New vs. Bubbled-Up Errors

Following principles from [Miguel Grinberg's error handling guide](https://blog.miguelgrinberg.com/post/the-ultimate-guide-to-error-handling-in-python), we classify errors by their origin:

#### New Errors
Error types that your code detects and creates:


```typescript
// Input validation error type
function validateAge(age: unknown): Result<number, ValidationError> {
  if (typeof age !== "number" || age < 0 || age > 150) {
    return Err({
      name: "ValidationError", // Tag that identifies this error type
      message: "Age must be a number between 0 and 150",
      context: { providedAge: age, validRange: [0, 150] },
      cause: null,
    });
  }
  return Ok(age);
}

// Business logic error type
function withdrawFunds(account: Account, amount: number): Result<Account, BusinessError> {
  if (account.balance < amount) {
    return Err({
      name: "BusinessError", // Tag that identifies this error type
      message: "Insufficient funds for withdrawal",
      context: { 
        accountId: account.id, 
        requestedAmount: amount, 
        availableBalance: account.balance 
      },
      cause: null,
    });
  }
  
  return Ok({
    ...account,
    balance: account.balance - amount,
  });
}
```

#### Bubbled-Up Errors
Error types that your code receives from functions it calls:

```typescript
import { extractErrorMessage } from "wellcrafted/error";

// Catching and re-wrapping external errors into typed error types
async function saveUserData(user: User): Promise<Result<void, StorageError>> {
  return await tryAsync({
    try: () => database.save(user),
    catch: (error) => StorageErr({
      name: "StorageError",
      message: `Failed to save user data: ${extractErrorMessage(error)}`,
      context: { userId: user.id, timestamp: new Date().toISOString() },
      cause: error, // Preserve the original error
    }),
  });
}
```

### By Recoverability: What Should You Do?

#### 1. Recoverable Errors (Handle Locally)

Error types that your current function can meaningfully address:

```typescript
async function fetchWithRetry<T>(
  url: string, 
  maxRetries = 3
): Promise<Result<T, NetworkError>> {
  let lastError: NetworkError | null = null;
  
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    const result = await tryAsync({
      try: () => fetch(url).then(r => r.json()),
      catch: (error) => NetworkErr({
        name: "NetworkError",
        message: `Request failed (attempt ${attempt}/${maxRetries}): ${extractErrorMessage(error)}`,
        context: { url, attempt, maxRetries },
        cause: error,
      }),
    });
    
    if (isOk(result)) {
      return result;
    }
    
    lastError = result.error;
    
    // Wait before retry (exponential backoff)
    if (attempt < maxRetries) {
      await new Promise(resolve => setTimeout(resolve, Math.pow(2, attempt) * 1000));
    }
  }
  
  // All retries failed - return Err data structure containing NetworkError type
  return Err({
    name: "NetworkError",
    message: `All ${maxRetries} retry attempts failed`,
    context: { url, maxRetries, finalError: lastError },
    cause: lastError,
  });
}
```

#### 2. Non-Recoverable Errors (Propagate Up)

Error types that should be handled by a higher-level function:

```typescript
// Just propagate database error types up - the HTTP handler will deal with them
async function getUser(id: number): Promise<Result<User, DbError | ValidationError>> {
  // Validate input
  if (id <= 0) {
    return Err({
      name: "ValidationError",
      message: "User ID must be positive",
      context: { providedId: id },
      cause: null,
    });
  }
  
  // Let database error types bubble up unchanged
  const result = await database.findUser(id);
  return result; // Result<User, DbError>
}

// HTTP handler deals with different error types appropriately
async function handleGetUser(req: Request): Promise<Response> {
  const userId = parseInt(req.params.id);
  const result = await getUser(userId);
  
  if (isErr(result)) {
    switch (result.error.name) {
      case "ValidationError":
        return new Response(JSON.stringify(result.error), { 
          status: 400,
          headers: { "Content-Type": "application/json" }
        });
      case "DbError":
        // Log the full error context but return generic message
        console.error("Database error:", result.error);
        return new Response(
          JSON.stringify({ message: "Internal server error" }), 
          { status: 500, headers: { "Content-Type": "application/json" }}
        );
    }
  }
  
  return new Response(JSON.stringify(result.data), {
    headers: { "Content-Type": "application/json" }
  });
}
```

#### 3. Transformative Errors (Convert and Propagate)

Error types that need to be converted to a more appropriate type for the calling context:

```typescript
// Low-level database function
async function executeQuery(sql: string): Promise<Result<any[], DbError>> {
  return await tryAsync({
    try: () => database.query(sql),
    catch: (error) => DbErr({
      name: "DbError",
      message: `Query execution failed: ${extractErrorMessage(error)}`,
      context: { sql: sql.substring(0, 100) }, // Truncate for logging
      cause: error,
    }),
  });
}

// Higher-level user service transforms DB error types to domain error types
async function createUser(userData: UserData): Promise<Result<User, UserServiceError>> {
  const result = await executeQuery(
    "INSERT INTO users (name, email) VALUES (?, ?)",
    [userData.name, userData.email]
  );
  
  if (isErr(result)) {
    // Transform database error type to domain-specific error type
    return Err({
      name: "UserServiceError",
      message: result.error.message.includes("UNIQUE constraint")
        ? "A user with this email already exists"
        : "Failed to create user",
      context: { 
        userData: { name: userData.name, email: userData.email },
        originalError: result.error 
      },
      cause: result.error,
    });
  }
  
  return Ok(result.data[0]);
}
```

## Advanced Patterns

### Error Aggregation

When you need to collect multiple errors:

```typescript
type ValidationResult<T> = Result<T, ValidationError[]>;

function validateUser(data: unknown): ValidationResult<User> {
  const errors: ValidationError[] = [];
  const result: Partial<User> = {};
  
  // Validate each field
  const nameResult = validateName(data.name);
  if (isErr(nameResult)) {
    errors.push(nameResult.error);
  } else {
    result.name = nameResult.data;
  }
  
  const emailResult = validateEmail(data.email);
  if (isErr(emailResult)) {
    errors.push(emailResult.error);
  } else {
    result.email = emailResult.data;
  }
  
  const ageResult = validateAge(data.age);
  if (isErr(ageResult)) {
    errors.push(ageResult.error);
  } else {
    result.age = ageResult.data;
  }
  
  if (errors.length > 0) {
    return Err(errors);
  }
  
  return Ok(result as User);
}
```

### Error Context Enrichment

Add context as errors bubble up through layers:

```typescript
// Storage layer
async function writeFile(path: string, content: string): Promise<Result<void, StorageError>> {
  return await tryAsync({
    try: () => fs.writeFile(path, content),
    catch: (error) => StorageErr({
      name: "StorageError",
      message: `File write failed: ${extractErrorMessage(error)}`,
      context: { path, contentLength: content.length },
      cause: error,
    }),
  });
}

// Service layer - adds business context
async function saveDocument(doc: Document): Promise<Result<void, DocumentServiceError>> {
  const filePath = `/documents/${doc.id}.json`;
  const content = JSON.stringify(doc);
  
  const result = await writeFile(filePath, content);
  if (isErr(result)) {
    return Err({
      name: "DocumentServiceError",
      message: `Failed to save document: ${result.error.message}`,
      context: {
        documentId: doc.id,
        documentTitle: doc.title,
        userId: doc.authorId,
        storageError: result.error,
        // Enrich with business context
        attemptTimestamp: new Date().toISOString(),
        documentSize: content.length,
      },
      cause: result.error,
    });
  }
  
  return Ok(undefined);
}

// API layer - adds request context
async function handleSaveDocument(req: Request): Promise<Response> {
  const document = await req.json();
  const result = await saveDocument(document);
  
  if (isErr(result)) {
    // Add HTTP request context
    const enrichedError = {
      ...result.error,
      context: {
        ...result.error.context,
        // Add request-specific context
        requestId: req.headers.get("x-request-id"),
        userAgent: req.headers.get("user-agent"),
        timestamp: new Date().toISOString(),
      },
    };
    
    // Log the enriched error
    console.error("Document save failed:", enrichedError);
    
    return new Response(
      JSON.stringify({ error: "Failed to save document" }),
      { status: 500, headers: { "Content-Type": "application/json" }}
    );
  }
  
  return new Response(JSON.stringify({ success: true }));
}
```

### Parallel Error Handling

When dealing with multiple independent operations:

```typescript
import { partitionResults } from "wellcrafted/result";

async function processMultipleFiles(paths: string[]): Promise<Result<ProcessedFile[], ProcessingError>> {
  // Process all files in parallel
  const results = await Promise.all(
    paths.map(path => processFile(path))
  );
  
  // Partition successes and failures
  const { oks, errs } = partitionResults(results);
  
  if (errs.length > 0) {
    return Err({
      name: "ProcessingError",
      message: `Failed to process ${errs.length} out of ${paths.length} files`,
      context: {
        totalFiles: paths.length,
        successCount: oks.length,
        failureCount: errs.length,
        failures: errs.map(err => err.error),
        successfulPaths: oks.map((ok, i) => paths[results.indexOf(ok)]),
      },
      cause: errs[0]?.error, // Use first error as primary cause
    });
  }
  
  return Ok(oks.map(ok => ok.data));
}
```

### Circuit Breaker Pattern

Implement resilience patterns with typed errors:

```typescript
type CircuitState = "closed" | "open" | "half-open";

class CircuitBreaker<T, E extends BaseError> {
  private state: CircuitState = "closed";
  private failureCount = 0;
  private lastFailureTime = 0;
  
  constructor(
    private readonly operation: () => Promise<Result<T, E>>,
    private readonly failureThreshold = 5,
    private readonly resetTimeout = 60000
  ) {}
  
  async execute(): Promise<Result<T, CircuitBreakerError | E>> {
    if (this.state === "open") {
      if (Date.now() - this.lastFailureTime < this.resetTimeout) {
        return Err({
          name: "CircuitBreakerError",
          message: "Circuit breaker is open",
          context: {
            state: this.state,
            failureCount: this.failureCount,
            lastFailureTime: this.lastFailureTime,
            resetTimeout: this.resetTimeout,
          },
          cause: null,
        });
      }
      this.state = "half-open";
    }
    
    const result = await this.operation();
    
    if (isErr(result)) {
      this.onFailure();
      return result;
    }
    
    this.onSuccess();
    return result;
  }
  
  private onSuccess(): void {
    this.failureCount = 0;
    this.state = "closed";
  }
  
  private onFailure(): void {
    this.failureCount++;
    this.lastFailureTime = Date.now();
    
    if (this.failureCount >= this.failureThreshold) {
      this.state = "open";
    }
  }
}

type CircuitBreakerError = TaggedError<"CircuitBreakerError">;
```

## Error Monitoring and Observability

### Structured Logging

```typescript
interface ErrorLogEntry {
  level: "error";
  message: string;
  error: BaseError;
  timestamp: string;
  traceId?: string;
  spanId?: string;
}

function logError(error: BaseError, traceId?: string): void {
  const logEntry: ErrorLogEntry = {
    level: "error",
    message: error.message,
    error,
    timestamp: new Date().toISOString(),
    traceId,
  };
  
  console.error(JSON.stringify(logEntry));
  
  // Send to monitoring service
  monitoring.recordError(logEntry);
}
```

### Error Metrics

```typescript
function recordErrorMetrics(error: BaseError): void {
  // Increment error counter by type
  metrics.increment("errors.total", {
    errorType: error.name,
    function: error.context.functionName,
  });
  
  // Record error rate
  metrics.histogram("errors.rate", 1, {
    errorType: error.name,
  });
}
```

## Testing Error Scenarios

### Unit Testing Errors

```typescript
import { describe, it, expect } from "vitest";

describe("file operations", () => {
  it("should return FsError when file does not exist", async () => {
    const result = await readFileContent("/nonexistent/file.txt");
    
    expect(isErr(result)).toBe(true);
    if (isErr(result)) {
      expect(result.error.name).toBe("FsError");
      expect(result.error.message).toContain("Failed to read file content");
      expect(result.error.context).toEqual({
        path: "/nonexistent/file.txt",
      });
      expect(result.error.cause).toBeDefined();
    }
  });
  
  it("should handle error propagation correctly", async () => {
    const result = await initializeApp();
    
    if (isErr(result)) {
      // Should be either ValidationError or FsError
      expect(["ValidationError", "FsError"]).toContain(result.error.name);
    }
  });
});
```

### Integration Testing with Error Injection

```typescript
// Mock that can be configured to fail
class MockDatabase {
  private shouldFail = false;
  
  configureFail(shouldFail: boolean): void {
    this.shouldFail = shouldFail;
  }
  
  async findUser(id: number): Promise<Result<User, DbError>> {
    if (this.shouldFail) {
      return Err({
        name: "DbError",
        message: "Database connection failed",
        context: { userId: id, timestamp: Date.now() },
        cause: new Error("Connection timeout"),
      });
    }
    
    return Ok({ id, name: "Test User", email: "test@example.com" });
  }
}

describe("user service with database failures", () => {
  it("should handle database failures gracefully", async () => {
    const mockDb = new MockDatabase();
    mockDb.configureFail(true);
    
    const result = await getUserService.getUser(123);
    
    expect(isErr(result)).toBe(true);
    if (isErr(result)) {
      expect(result.error.name).toBe("DbError");
    }
  });
});
```

## Migration Strategies

### Gradual Migration from Throwing Errors

```typescript
// Legacy function that throws
function legacyFunction(input: string): string {
  if (!input) {
    throw new Error("Input is required");
  }
  return input.toUpperCase();
}

// Wrapper that converts to Result
function safeLegacyFunction(input: string): Result<string, ValidationError> {
  return trySync({
    try: () => legacyFunction(input),
    catch: (error) => ValidationErr({
      name: "ValidationError",
      message: extractErrorMessage(error),
      context: { input },
      cause: error,
    }),
  });
}

// New function using Result pattern directly
function newFunction(input: string): Result<string, ValidationError> {
  if (!input) {
    return Err({
      name: "ValidationError",
      message: "Input is required",
      context: { input },
      cause: null,
    });
  }
  return Ok(input.toUpperCase());
}
```

### Interoperability with Promise-based APIs

```typescript
// Convert Result to Promise (for libraries expecting promises)
function resultToPromise<T, E extends BaseError>(result: Result<T, E>): Promise<T> {
  if (isOk(result)) {
    return Promise.resolve(result.data);
  }
  
  // Convert error object to Error instance for promise rejection
  const error = new Error(result.error.message);
  error.name = result.error.name;
  (error as any).context = result.error.context;
  (error as any).cause = result.error.cause;
  
  return Promise.reject(error);
}

// Convert Promise to Result (for integrating promise-based libraries)
async function promiseToResult<T, E extends BaseError>(
  promise: Promise<T>,
  catch: (error: unknown) => Err<E>
): Promise<Result<T, E>> {
  return await tryAsync({
    try: () => promise,
    catch,
  });
}
```

This comprehensive approach to error handling provides a robust foundation for building reliable, maintainable applications with excellent observability and debugging capabilities. 