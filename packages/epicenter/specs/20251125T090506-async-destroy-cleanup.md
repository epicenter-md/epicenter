# Async Destroy Cleanup API

**Timestamp**: 2025-11-25T09:05:06
**Status**: Complete

## Problem

There's a type/runtime mismatch in the destroy cleanup API:

1. **IndexExports type** declares `destroy: () => void` (sync)
2. **SQLite and Markdown indexes** implement `async destroy()` (returns Promise)
3. **Call site in client.ts** calls `index.destroy?.()` without await (promise dropped!)

This means async cleanup operations (like `await logger.close()`) are fire-and-forget, potentially causing:
- Logs not flushed before process exit
- Database WAL files not checkpointed
- Resource leaks in tests

## Solution

1. **IndexExports**: Update type to allow async destroys
2. **WorkspaceClient**: Support both `destroy()` method and `Symbol.asyncDispose`
3. **Call sites**: Properly await all destroy operations

## Changes Required

### Core Type Definitions

- [ ] **src/core/indexes.ts**
  - Update `IndexExports` type: `destroy: () => void | Promise<void>`
  - Update JSDoc to document async support

- [ ] **src/core/workspace/client.ts**
  - Update `WorkspaceClient` type to include both:
    - `destroy: () => Promise<void>`
    - `[Symbol.asyncDispose]: () => Promise<void>`
  - Make cleanup function async
  - Await all index destroy calls with `Promise.all()`
  - Assign cleanup to both `destroy` and `Symbol.asyncDispose`

### Tests

- [ ] **Find all test files using Symbol.dispose or destroy**
  - Update to use `await client.destroy()` or `await using` syntax
  - Ensure proper async cleanup in afterAll/afterEach hooks

## Implementation Notes

### IndexExports Type Change

```typescript
// Before
export type IndexExports = {
  destroy: () => void;
};

// After
export type IndexExports = {
  destroy: () => void | Promise<void>;
};
```

### WorkspaceClient Type Change

```typescript
// Before
export type WorkspaceClient<TExports extends WorkspaceExports> = TExports & {
  [Symbol.dispose]: () => void;
};

// After
export type WorkspaceClient<TExports extends WorkspaceExports> = TExports & {
  destroy: () => Promise<void>;
  [Symbol.asyncDispose]: () => Promise<void>;
};
```

### Cleanup Function Change

```typescript
// Before
const cleanup = () => {
  for (const index of Object.values(indexes)) {
    index.destroy?.();  // Promise dropped!
  }
  ydoc.destroy();
};

const client: WorkspaceClient<any> = {
  ...exports,
  [Symbol.dispose]: cleanup,
};

// After
const cleanup = async () => {
  await Promise.all(
    Object.values(indexes).map(index => index.destroy?.())
  );
  ydoc.destroy();
};

const client: WorkspaceClient<any> = {
  ...exports,
  destroy: cleanup,
  [Symbol.asyncDispose]: cleanup,
};
```

## Benefits

1. **No silent failures**: Async cleanup is properly awaited
2. **Type safety**: Type matches runtime behavior
3. **Flexibility**: Users can choose `await client.destroy()` or `await using client`
4. **Backwards compatible**: Sync destroy functions still work (Promise.all handles non-promises)
5. **Consistent**: Matches patterns from Prisma, TypeORM, etc.
