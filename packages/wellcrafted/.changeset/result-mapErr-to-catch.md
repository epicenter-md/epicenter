---
"wellcrafted": minor
---

Rename mapErr to catch and add smart return type narrowing to trySync/tryAsync

**Breaking Change**: The `mapErr` parameter in `trySync` and `tryAsync` functions has been renamed to `catch` for better semantic clarity.

**New Feature**: Added function overloads that provide smart return type narrowing:
- When `catch` always returns `Ok<T>`, the function returns `Ok<T>` (guaranteed success)
- When `catch` can return `Err<E>`, the function returns `Result<T, E>` (may succeed or fail)

This eliminates unnecessary error checking when you know your error handler always recovers, while still requiring proper error handling when failures are possible.

**Migration**: Replace `mapErr` with `catch` in all `trySync` and `tryAsync` calls:

```typescript
// Before
trySync({
  try: () => operation(),
  mapErr: (error) => Err(new Error("Failed"))
});

// After  
trySync({
  try: () => operation(),
  catch: (error) => Err(new Error("Failed"))
});
```

Improved JSDoc documentation with clearer examples and better hover experience.