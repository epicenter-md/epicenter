---
"wellcrafted": minor
---

Renames `mapError` parameter to `mapErr` in `trySync` and `tryAsync` functions.

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
