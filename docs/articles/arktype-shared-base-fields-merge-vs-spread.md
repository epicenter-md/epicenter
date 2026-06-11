# Two Ways to Compose Arktype Types

When multiple types share the same base fields, you need a way to define those fields once and extend them. Arktype gives you two approaches: object spread with `as const`, or `.merge()`. Both work. We lean toward `.merge()`.

## The Two Patterns

### Pattern 1: Object Spread with `as const`

```typescript
const BaseFields = {
  id: 'string',
  name: 'string',
  createdAt: 'string',
} as const;

const UserV1 = type({
  ...BaseFields,
  role: '"admin" | "user"',
});

const UserV2 = type({
  ...BaseFields,
  role: '"admin" | "user" | "guest"',
  email: 'string',
});
```

### Pattern 2: `.merge()`

```typescript
const BaseFields = type({
  id: 'string',
  name: 'string',
  createdAt: 'string',
});

const UserV1 = BaseFields.merge({
  role: '"admin" | "user"',
});

const UserV2 = BaseFields.merge({
  role: '"admin" | "user" | "guest"',
  email: 'string',
});
```

## The Real Difference

With object spread, `BaseFields` is just a plain object until you spread it into `type()`. With `.merge()`, `BaseFields` is a full arktype validator from the start. Both produce the same runtime behavior.

## Why We Prefer `.merge()`

**The base is a real type.** With `.merge()`, `BaseFields` is a full arktype validator from the moment you define it. If you have a typo in a spread-style base, you won't know until something uses it.

**It's explicit composition.** `.merge()` says exactly what's happening: "take this type and add these fields." Spread syntax hides the composition inside object literal construction.

**The base is independently usable.** If you later need to validate against just the base fields for a partial update, a migration check, or a test fixture, it's already a validator. With the spread pattern you'd have to go back and wrap it in `type()`.

## When Object Spread Is Fine

Object spread isn't wrong. If your base fields are truly just a bag of definitions that you'll never use independently, spread is slightly less ceremony. But the moment you want to use the base on its own, you'll wish you'd used `.merge()`.

## Example: Schema Versioning

`.merge()` makes versioned schemas clear:

```typescript
const TransformationStepBase = type({
  id: 'string',
  type: type.enumerated('prompt_transform', 'find_replace'),
  // ... other shared fields
});

const TransformationStepV1 = TransformationStepBase.merge({
  version: '1 = 1',  // Default to 1 for old data
});

const TransformationStepV2 = TransformationStepBase.merge({
  version: '2',
  'custom.model': 'string',
  'custom.baseUrl': 'string',
});
```

V1 and V2 are clearly extensions of a common base. The relationship is in the code, not just in a comment.

## Quick Comparison

| Aspect | `.merge()` | Object Spread |
|--------|-----------|--------------|
| Base definition | `type({...})`: real validator | Plain object with `as const` |
| Extension syntax | `Base.merge({ newField })` | `type({ ...Base, newField })` |
| Base validates immediately | Yes | No, only when spread into `type()` |
| Base usable independently | Yes | No, need to wrap in `type()` first |
| Readability | Explicit composition | Familiar JS syntax |
