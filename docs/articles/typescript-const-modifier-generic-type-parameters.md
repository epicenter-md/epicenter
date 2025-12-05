# TypeScript's `const` Modifier: No More `as const` Everywhere

I was refactoring some schema definitions today and hit a pattern I've been annoyed by for years. You want to pass literal types through a function, so you have to tell every caller to add `as const`:

```typescript
function select(opts: { options: readonly string[] }) {
  // ...
}

// Without as const, you get string[]
select({ options: ['low', 'medium', 'high'] })  // Type: string[]

// With as const, you get the literals
select({ options: ['low', 'medium', 'high'] as const })  // Type: readonly ['low', 'medium', 'high']
```

That `as const` has to be everywhere. Every single call site. And if someone forgets it, they lose all the type precision you carefully designed for.

TypeScript 5.0 introduced a `const` modifier for generic type parameters. You can now tell TypeScript "infer the narrowest possible type" directly in the function signature:

```typescript
function select<const TOptions extends readonly string[]>(
  opts: { options: TOptions }
) {
  // ...
}

// Just works. No as const needed.
select({ options: ['low', 'medium', 'high'] })  // TOptions: readonly ['low', 'medium', 'high']
```

That's it. The `const` in `<const TOptions>` tells TypeScript to preserve literal types automatically.

## Before and After

**Before:** You had to add `as const` after every array to preserve literal types:

```typescript
select({ options: ['draft', 'published'] as const })
```

**After:** The `const` modifier captures literal types automatically:

```typescript
function select<const TOptions extends readonly string[]>(opts: {
  options: TOptions;
}): SelectColumnSchema<TOptions[number]> {
  // ...
}

// No as const needed
select({ options: ['draft', 'published'] })
```

## Why This Matters

When you write `['low', 'high']`, TypeScript assumes you want the flexible `string[]` type, not the restrictive `readonly ['low', 'high']` literal type.

Before the `const` modifier, you had two bad choices:

1. Make callers add `as const` everywhere (annoying, easy to forget)
2. Accept `string[]` and lose type precision (defeats the purpose)

The `const` modifier gives you a third option: design functions that capture literal types by default, with no caller-side annotations needed.

## When to Use It

Use the `const` modifier when you're building APIs that work with literal types, like status values, option lists, or enum-like strings. When you want to infer exact literals instead of widened types.

The result: library APIs that just work, without requiring callers to understand TypeScript's widening behavior or remember to add `as const`.
