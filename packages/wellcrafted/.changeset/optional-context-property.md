---
"wellcrafted": minor
---

Make context property optional in TaggedError type

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