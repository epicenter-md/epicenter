# @epicenterhq/result

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
