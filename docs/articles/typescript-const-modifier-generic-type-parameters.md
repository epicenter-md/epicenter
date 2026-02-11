# TypeScript's `const` Modifier: No More `as const` Everywhere

**TL;DR**: Use `const T extends readonly T[]` to preserve literal types without requiring `as const` at call sites.

> The `const` modifier on the generic does the heavy lifting; the `readonly` constraint ensures compatibility with both mutable and `as const` inputs.

## The Problem

Without the `const` modifier, TypeScript widens array literals to their base types:

```typescript
function process<T extends string[]>(items: T): T {
	return items;
}

const result = process(['a', 'b', 'c']);
//    ^? string[] — literals lost!

// Caller must add `as const` to preserve literals
const fixed = process(['a', 'b', 'c'] as const);
//    ^? ["a", "b", "c"] — but now every call site needs this
```

That `as const` has to be everywhere. Every single call site. And if someone forgets it, they lose all the type precision you carefully designed for.

## The Solution

TypeScript 5.0 introduced a `const` modifier for generic type parameters. Add it to the generic, and callers get literal inference automatically:

```typescript
function process<const T extends readonly string[]>(items: T): T {
	return items;
}

const result = process(['a', 'b', 'c']);
//    ^? readonly ["a", "b", "c"] — no `as const` needed!
```

## Inference Behavior Reference

| Pattern                             | Plain `['a','b','c']`      | With `as const`            |
| ----------------------------------- | -------------------------- | -------------------------- |
| `T extends string[]`                | `string[]`                 | `["a", "b", "c"]`          |
| `T extends readonly string[]`       | `string[]`                 | `readonly ["a", "b", "c"]` |
| `const T extends string[]`          | `["a", "b", "c"]`          | `["a", "b", "c"]`          |
| `const T extends readonly string[]` | `readonly ["a", "b", "c"]` | `readonly ["a", "b", "c"]` |

The `const` modifier is what preserves literal types. The `readonly` constraint determines whether the inferred tuple is readonly or mutable. Without `const`, callers must use `as const` to get literal inference.

## Real Examples

From `packages/epicenter/src/core/schema/fields/factories.ts`:

```typescript
export function table<const TFields extends readonly Field[]>({
	id,
	fields,
}: {
	id: string;
	fields: TFields;
}): TableDefinition<TFields> {
	// ...
}

// Caller gets precise field types
const myTable = table({
	id: 'users',
	fields: [text({ id: 'name' }), number({ id: 'age' })],
	//       ^? readonly [TextField<"name">, NumberField<"age">]
});
```

```typescript
export function select<const TOptions extends readonly [string, ...string[]]>({
	id,
	options,
}: {
	id: string;
	options: TOptions;
}): SelectField<TOptions> {
	// ...
}

// Caller gets literal union type
const status = select({ id: 'status', options: ['draft', 'published'] });
//    ^? SelectField<readonly ["draft", "published"]>
// status.options[number] is "draft" | "published", not string
```

## When to Use

Use `const T extends readonly T[]` when:

- Function accepts configuration arrays (options, field definitions)
- Literal types matter for downstream inference
- You want callers to get precise types without ceremony

Use plain `T extends T[]` when:

- You don't care about literal inference
- The array will be mutated
- Simpler types are preferred

The result: library APIs that just work, without requiring callers to understand TypeScript's widening behavior or remember to add `as const`.
