# Two Ways to Compose Arktype Types

When you need to extend or compose arktype schemas, there are two approaches: object spread with `as const`, or using `type().merge()`.

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

### Pattern 2: `type().merge()`

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

## Quick Comparison

| Aspect | Object Spread | `.merge()` |
|--------|--------------|------------|
| Base definition | Plain object with `as const` | `type({...})` |
| Extension syntax | `type({ ...Base, newField })` | `Base.merge({ newField })` |
| Runtime validation of base | Only when spread into `type()` | Immediate |
| Readability | Familiar JS syntax | Explicit composition API |

## When to Use Each

**Use object spread when:**
- You want familiar JavaScript syntax
- The base is truly just a bag of field definitions
- You're not using the base type directly anywhere

**Use `.merge()` when:**
- You want the base type to be validated immediately
- You prefer explicit composition over spreading
- You might use the base type independently

## The Real Difference

With object spread, `BaseFields` is just a plain object until you spread it into `type()`. With `.merge()`, `BaseFields` is a full arktype validator from the start.

Both produce the same runtime behavior. The difference is stylistic and about when validation definitions get parsed.

## Example: Schema Versioning

Here's how we use `.merge()` for versioned schemas:

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

The `.merge()` pattern makes it clear that V1 and V2 are extensions of a common base.

## The Lesson

Both patterns work. Object spread is more familiar; `.merge()` is more explicit. Pick whichever reads better for your use case.
