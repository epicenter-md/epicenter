---
"wellcrafted": minor
---

Add createTaggedError factory function for generating tagged error constructors

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
const { NetworkError, NetworkErr } = createTaggedError('NetworkError');

// Creates plain error object
const error = NetworkError({ message: 'Connection failed', context: { url }, cause: undefined });

// Creates Err-wrapped error for Result types
return NetworkErr({ message: 'Connection failed', context: { url }, cause: undefined });
```