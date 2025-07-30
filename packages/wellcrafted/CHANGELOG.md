# wellcrafted

## 0.21.2

### Patch Changes

- 851983e: Updates types to include `TData` generics for improved type accuracy

## 0.21.1

### Patch Changes

- 48048a2: Adds default generics for `defineMutation`. Because we set a default generic `void` for `TVariables`, we can call `mutation.mutate()` instead of having to always put in `mutation.mutate({})`.

## 0.21.0

### Minor Changes

- 5c73e8e: Renames `mapError` parameter to `mapErr` in `trySync` and `tryAsync` functions.

  The `mapErr` parameter now returns `Err<E>` directly instead of just the error value `E`. This change provides more explicit control over error wrapping.

  **Migration required**:

  ```typescript
  // Before
  trySync({
    try: () => operation(),
    mapError: (error) => ({
      name: "MyError",
      message: "Operation failed",
      cause: error,
    }),
  });

  // After
  trySync({
    try: () => operation(),
    mapErr: (error) =>
      Err({
        name: "MyError",
        message: "Operation failed",
        cause: error,
      }),
  });
  ```

## 0.20.0

### Minor Changes

- af03f84: Rename fetchCached method to fetch in query definitions

  BREAKING CHANGE: The `fetchCached()` method on query definitions has been renamed to `fetch()` to better reflect its actual behavior. This method intelligently fetches data from cache OR network based on staleness.

  **Migration:**

  - Replace all `.fetchCached()` calls with `.fetch()`
  - No functional changes - behavior remains identical
  - See MIGRATION_FETCHCACHED_TO_FETCH.md for detailed migration guide

  **Before:**

  ```typescript
  const { data, error } = await userQuery.fetchCached();
  ```

  **After:**

  ```typescript
  const { data, error } = await userQuery.fetch();
  ```

## 0.19.1

### Patch Changes

- a4efb1b: Replaces QueryOptions with QueryObserverOptions

## 0.19.0

### Minor Changes

- 83e90fe: Add TanStack Query integration utilities

  - New `createQueryFactories` function for creating type-safe query and mutation definitions
  - Automatic Result type handling for TanStack Query
  - Dual interface pattern: reactive (for UI) and imperative (for actions)
  - Full TypeScript support with proper type inference
  - Comprehensive documentation and examples

## 0.18.0

### Minor Changes

- 5257a07: Add createTaggedError factory function for generating tagged error constructors

  Introduces a new utility function that creates factory functions for tagged errors:

  - `createTaggedError(name)` returns two factory functions:
    - One that creates plain TaggedError objects (named with "Error" suffix)
    - One that creates Err-wrapped TaggedError objects (named with "Err" suffix)
  - Automatic naming convention: "Error" suffix becomes "Err" suffix for Result-wrapped version
  - Fully typed with TypeScript generics for type safety
  - Comprehensive JSDoc documentation with examples

  This simplifies creating tagged error constructors and provides a consistent API for both plain errors and Result-wrapped errors.

  Example usage:

  ```typescript
  const { NetworkError, NetworkErr } = createTaggedError("NetworkError");

  // Creates plain error object
  const error = NetworkError({
    message: "Connection failed",
    context: { url },
    cause: undefined,
  });

  // Creates Err-wrapped error for Result types
  return NetworkErr({
    message: "Connection failed",
    context: { url },
    cause: undefined,
  });
  ```

## 0.17.0

### Minor Changes

- deb7bff: Make context property optional in TaggedError type

  The context property in BaseError and TaggedError is now optional, allowing developers to omit it when no contextual information is needed. This reduces boilerplate code and eliminates the need for empty context objects.

  Before:

  ```typescript
  return Err({
    name: "ValidationError",
    message: "Invalid input",
    context: {}, // Required but meaningless
    cause: null,
  });
  ```

  After:

  ```typescript
  return Err({
    name: "ValidationError",
    message: "Invalid input",
    cause: null,
    // context can be omitted
  });
  ```

  This is a backwards-compatible change - all existing code continues to work unchanged.

## 0.16.1

### Patch Changes

- 062ac62: Adds dts to tsdown config, fixes missing types

## 0.16.0

### Minor Changes

- b450bd1: Adds `Brand` type for nominal typing in Typescript
- 662cd35: Rebrands repo to "wellcrafted" with modular architecture

## 0.15.0

### Minor Changes

- 95f7704: Renames `unwrapIfResult` function to `resolve`

## 0.14.0

### Minor Changes

- c5a8d2a: Adds `unwrap` function to extract success value from `Result<T, E>` and throw error for `Err<E>` variant

## 0.13.1

### Patch Changes

- 27c88a4: Fixes `partitionResults` function to have default empty oks and errs arrays

## 0.13.0

### Minor Changes

- 0416841: Renames `mapErr` to `mapError`, enhance docs, introduce naming conventions for error suffix
- a708959: Renames `mapErr` to `mapError`, enhances result and error handling documentation, and introduces naming conventions for error types

## 0.12.0

### Minor Changes

- efbe590: Adds `BaseError`, `TaggedError`, `extractErrorMessage`, and comprehensive error handling guide

### Patch Changes

- 3d0539e: Add `declarationMap: true` to tsconfig

## 0.11.0

### Minor Changes

- 05a04b8: Adds unwrapIfResult function

## 0.10.0

### Minor Changes

- 422f86c: Adds isResult type guard

## 0.9.5

### Patch Changes

- d5f209a: Migrates to tsdown

## 0.9.4

### Patch Changes

- 0937db9: Adds files field to package.json

## 0.9.3

### Patch Changes

- f5ac7c1: Adds main, module, and types for improved module resolution to package.json

## 0.9.2

### Patch Changes

- 0f9bf08: Updates Typescript module and lib to NodeNext and ESNext

## 0.9.1

### Patch Changes

- 208a06d: Adds output support for CommonJS

## 0.9.0

### Minor Changes

- c750a55: Adds partitionResults utility function to separate Result objects into success and error arrays
- 55cfbff: Enhances Result documentation and add extraction utilities

### Patch Changes

- d6d6b6e: Updates TypeScript configuration and package.json exports

## 0.8.0

### Minor Changes

- ff97dbb: Adds partitionResults utility function to separate Result objects into success and error arrays

## 0.7.2

### Patch Changes

- b85bd17: Adds "require" to exports for more compatibility

## 0.7.1

### Patch Changes

- 5cfccdd: Fixes tsup config and entry points

## 0.7.0

### Minor Changes

- 0b32ddd: Updates mapErr handling in trySync and tryAsync functions, now automatically wrapping with Err<>
- 50498bf: Removes discriminated union implementation of result in favor of exclusive (data/error) pattern

### Patch Changes

- 1c4ef64: Make second arg of mutate optional, use Partial Typescript helper

## 0.6.0

### Minor Changes

- 5e6133a: Added new onSuccessLocal, onErrorLocal, onSettledLocal

## 0.5.2

### Patch Changes

- d1d5257: Restore old ok and err behavior

## 0.5.1

### Patch Changes

- fe51ba1: Updated generics of trySync and tryAsync again

## 0.5.0

### Minor Changes

- 344f3d5: Update generics in trySync and tryAsync functions; remove services.ts

### Patch Changes

- 7f49d16: Add OnMutateError generic to createMutation function

## 0.4.2

### Patch Changes

- 57a88a6: Simplify Result type definition by consolidating Ok and Err types

## 0.4.1

### Patch Changes

- 35dbcdd: Update mapError to take in Err and spit out Err

## 0.4.0

### Minor Changes

- 75df94c: Rename catch parameter to mapErr in trySync and tryAsync functions for improved clarity

## 0.3.2

### Patch Changes

- 9b4bf3e: createMutation function returns function directly

## 0.3.1

### Patch Changes

- 0cf54d2: Update first parameter of createMutation for improved clarity
- 043d624: Add InferOk and InferErr utility types for Result type inference
- b4a0bc4: Add ServiceFn type and update exports in index.ts

## 0.3.0

### Minor Changes

- 9598e2a: Add createMutation function

## 0.2.6

### Patch Changes

- 53e8cf2: Make MutationFn callbacks optional

## 0.2.5

### Patch Changes

- 2bbf651: Make callbacks optional

## 0.2.4

### Patch Changes

- 69be638: Fix callback type definitions in MutationFn for improved clarity and consistency

## 0.2.3

### Patch Changes

- 5739f07: Correct type definition for tryAsync function to ensure it always returns a Promise
- 732009a: Rename and update ServiceResultFactoryFns to ServiceErrorFns for improved clarity and consistency in error handling
- 6c1b688: Update type definition for tryAsync function to enforce promise return type

## 0.2.2

### Patch Changes

- c39ff0f: Export service-related functions from index

## 0.2.1

### Patch Changes

- fe27e9b: Update ServiceResultFactoryFns type definitions for improved clarity and consistency

## 0.2.0

### Minor Changes

- 7b3a558: Create service result factory functions

### Patch Changes

- 5aec8f9: Simplify logic of createServiceResultFactoryFns
- 42b2163: Extracted /index to /result and reexported

## 0.1.1

### Patch Changes

- dd4ce91: Simplify Ok and Err functions

## 0.1.0

### Minor Changes

- 4485244: Initial features scaffolded (ok, err, result, trySync, tryAsync)

### Patch Changes

- 6ef1580: Added keywords to package metadata to improve npm discoverability
