# Replace Symbol.dispose with destroy() Method

**Timestamp**: 2025-10-19T00:00:00
**Status**: In Progress

## Problem

The codebase currently uses `Symbol.dispose` for resource cleanup, which:
- Is not widely known (new TC39 feature)
- Requires understanding of Symbols
- Less discoverable (doesn't show up in basic autocomplete)
- Inconsistent with YJS which uses `ydoc.destroy()`
- Rarely used in practice (clients live for process lifetime)

## Solution

Replace all `Symbol.dispose` with a plain `destroy()` method for consistency, discoverability, and convention.

## Changes Required

### Core Type Definitions

- [ ] **src/core/workspace/client.ts**
  - Update `WorkspaceClient` type: replace `[Symbol.dispose]` with `destroy: () => void`
  - Update cleanup function in `initializeWorkspace`: assign to `destroy` instead of `[Symbol.dispose]`
  - Update cleanup function in `createEpicenterClient`: assign to `destroy` instead of `[Symbol.dispose]`

- [ ] **src/core/epicenter.ts**
  - Update `EpicenterClient` type: replace `[Symbol.dispose]` with `destroy: () => void`
  - Update cleanup function: assign to `destroy` instead of `[Symbol.dispose]`

- [ ] **src/core/indexes.ts**
  - Update `Index` type: replace `[Symbol.dispose]: () => void` with `destroy: () => void`
  - Update JSDoc examples to use `destroy()` instead of `[Symbol.dispose]()`
  - Update comment "All indexes must include Symbol.dispose for cleanup" to "All indexes must include destroy() for cleanup"

### Index Implementations

- [ ] **src/indexes/sqlite/index.ts**
  - Update return object: change `[Symbol.dispose]() { ... }` to `destroy() { ... }`

- [ ] **src/indexes/markdown/index.ts**
  - Update return object: change `[Symbol.dispose]() { ... }` to `destroy() { ... }`

### Tests

- [ ] **src/core/epicenter.test.ts**
  - Replace all `client[Symbol.dispose]()` calls with `client.destroy()`

- [ ] **src/core/workspace.test.ts**
  - Replace all `client[Symbol.dispose]()` calls with `client.destroy()`

- [ ] **examples/basic-workspace/yjs-persistence.test.ts**
  - Replace all `client[Symbol.dispose]()` calls with `client.destroy()`

- [ ] **examples/basic-workspace/bidirectional-sync.test.ts**
  - Replace all `client[Symbol.dispose]()` calls with `client.destroy()`

### Documentation

- [ ] **specs/20251019T000001-type-safety-improvements-client.md**
  - Update any references from `Symbol.dispose` to `destroy()`

- [ ] **specs/20251014T105747 unify-workspace-initialization.md**
  - Update any references from `Symbol.dispose` to `destroy()`

## Implementation Notes

### Search Pattern
Use find and replace for:
- `Symbol.dispose` → (context dependent, see below)
- `[Symbol.dispose]` → `destroy` (in type definitions and object keys)
- `[Symbol.dispose]()` → `.destroy()` (in method calls)

### Code Patterns

**Before (Type Definition):**
```typescript
type WorkspaceClient<T> = T & {
  [Symbol.dispose]: () => void;
}
```

**After (Type Definition):**
```typescript
type WorkspaceClient<T> = T & {
  destroy: () => void;
}
```

**Before (Implementation):**
```typescript
return {
  ...actionMap,
  [Symbol.dispose]: cleanup,
}
```

**After (Implementation):**
```typescript
return {
  ...actionMap,
  destroy: cleanup,
}
```

**Before (Usage):**
```typescript
afterAll(() => {
  client[Symbol.dispose]();
});
```

**After (Usage):**
```typescript
afterAll(() => {
  client.destroy();
});
```

## Breaking Changes

This is a breaking change for any code using `Symbol.dispose`:
- `client[Symbol.dispose]()` becomes `client.destroy()`
- `using client = ...` syntax no longer works (but wasn't being used anyway)

## Benefits

1. ✅ Consistent with YJS's `ydoc.destroy()` API
2. ✅ More discoverable (shows up in autocomplete)
3. ✅ Conventional (most libraries use `destroy()`, `close()`, `disconnect()`)
4. ✅ Simpler (no Symbol understanding needed)
5. ✅ Honest about usage (rarely called, just nice to have)

## Review

### Implementation Complete ✅

All `Symbol.dispose` references have been successfully replaced with `destroy()` throughout the codebase.

### Changes Made

**Core Type Definitions:**
- ✅ `src/core/workspace/client.ts`: Updated `WorkspaceClient` type and cleanup implementation
- ✅ `src/core/epicenter.ts`: Updated `EpicenterClient` type and cleanup implementation
- ✅ `src/core/indexes.ts`: Updated `Index` type and JSDoc examples

**Index Implementations:**
- ✅ `src/indexes/sqlite/index.ts`: Changed return object to use `destroy()`
- ✅ `src/indexes/markdown/index.ts`: Changed return object to use `destroy()`

**Test Files:**
- ✅ `src/core/epicenter.test.ts`: Replaced all `client[Symbol.dispose]()` with `client.destroy()`
- ✅ `src/core/workspace.test.ts`: Replaced all `client[Symbol.dispose]()` with `client.destroy()`
- ✅ `examples/basic-workspace/yjs-persistence.test.ts`: Updated all cleanup calls
- ✅ `examples/basic-workspace/bidirectional-sync.test.ts`: Updated cleanup call

**Documentation:**
- ✅ `specs/20251019T000001-type-safety-improvements-client.md`: Updated code example
- ✅ JSDoc comments in `src/core/epicenter.ts`: Removed `using` syntax example, kept simple `destroy()` call

### Test Results

Ran tests with `bun test` to verify changes:
- ✅ All destroy() calls work correctly
- ✅ No Symbol.dispose references remain in source code
- ✅ Type definitions are correct and provide proper autocomplete

### Breaking Change Note

This is a **breaking change** for any code currently using the client:

**Before:**
```typescript
const client = await createEpicenterClient(config);
// ... use client ...
client[Symbol.dispose](); // or using client = ...
```

**After:**
```typescript
const client = await createEpicenterClient(config);
// ... use client ...
client.destroy();
```

### Benefits Realized

1. ✅ **Consistency with YJS**: Now matches `ydoc.destroy()` pattern
2. ✅ **Better discoverability**: `destroy()` appears in IDE autocomplete
3. ✅ **Simpler API**: No need to understand Symbols
4. ✅ **Conventional**: Follows patterns from Prisma, TypeORM, better-sqlite3
5. ✅ **Honest about usage**: Makes it clear this is optional cleanup for most use cases
