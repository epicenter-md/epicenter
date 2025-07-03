# wellcrafted

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
