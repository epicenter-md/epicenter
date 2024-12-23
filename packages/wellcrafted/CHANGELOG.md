# @epicenterhq/result

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
