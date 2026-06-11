# TypeBox's Hidden Gem: Value.Equal

So I'm looking at my codebase and I've got this 20-line function for comparing two objects. Nested structures, discriminated unions, the whole deal. It's doing manual property checks, handling null cases, comparing nested icon objects with their own discriminants. And at the end? It falls back to `JSON.stringify` anyway.

There has to be a better way.

Turns out TypeBox has this [`Value.Equal` function that does deep structural equality on any two JavaScript values](https://sinclairzx81.github.io/typebox/#/docs/value/equal). Not just TypeBox schemas. Any values. Arrays, nested objects, whatever.

```typescript
import { Value } from 'typebox/value';

// Before: 20 lines of manual comparison
function deepEqual(a: FieldDefinition, b: FieldDefinition): boolean {
	if (a.type !== b.type) return false;
	if (a.name !== b.name) return false;
	if (a.icon !== b.icon) {
		if (!a.icon || !b.icon) return false;
		if (a.icon.type !== b.icon.type) return false;
		// ... more nested checks
	}
	return JSON.stringify(a) === JSON.stringify(b);
}

// After: one line
const deepEqual = (a: FieldDefinition, b: FieldDefinition) => Value.Equal(a, b);
```

One line. Done.

## Why Not Just Use JSON.stringify?

You might think `JSON.stringify(a) === JSON.stringify(b)` is good enough. It's not.

JSON.stringify is order-dependent. `{ a: 1, b: 2 }` and `{ b: 2, a: 1 }` produce different strings even though they're structurally identical. Value.Equal doesn't care about property order.

JSON.stringify also can't handle circular references, undefined values, or special objects. Value.Equal handles the edge cases you'd forget about.

## The Value Module Has More

`Value.Equal` is just one function in TypeBox's Value module. There's a whole toolkit:

```typescript
import { Value } from 'typebox/value';

// Deep equality
Value.Equal(a, b);

// Deep clone
Value.Clone(obj);

// Type checking (runtime validation)
Value.Check(schema, value);

// Get validation errors
Value.Errors(schema, value);

// Transform values to match a schema
Value.Cast(schema, value);

// Create default values from schema
Value.Create(schema);
```

These work on any JavaScript values. You don't need TypeBox schemas to use most of them.

## When to Use It

Anytime you're writing manual deep equality checks, reach for `Value.Equal` first. Schema merging, config diffing, cache invalidation, test assertions. It's battle-tested and handles edge cases you won't think of.

I replaced three separate comparison functions in my codebase with `Value.Equal`. Each was subtly broken in ways I hadn't noticed. The TypeBox version just works.

---

**Related**: [TypeBox is a Beast](./typebox-is-a-beast.md) covers more TypeBox fundamentals, including `Compile` vs `Value.Check` for validation.
