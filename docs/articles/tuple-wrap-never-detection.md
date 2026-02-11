# Wrap in Tuple to Detect Never Types

**TL;DR**: `T extends never ? true : false` doesn't work because **conditional types distribute over `never`**. Wrap in a tuple: `[T] extends [never]`.

> Never is the empty union. Distribution over an empty union produces never, not true.

## The Bug

```typescript
type IsNever<T> = T extends never ? true : false;

type Test1 = IsNever<never>; // Expected: true, Actual: never
type Test2 = IsNever<string>; // Expected: false, Actual: false
```

`IsNever<never>` returns `never`, not `true`. This breaks any code that tries to branch on whether a type is `never`.

## Why It Happens

Conditional types distribute over union members. When you write `T extends U ? X : Y` with `T` being a union, TypeScript evaluates it for each member and unions the results.

`never` is the empty union. Distributing over zero members produces zero results. Zero results unioned together equals `never`.

```typescript
// What TypeScript does with IsNever<never>:
// 1. never is the empty union: never = (no members)
// 2. Distribute: (no iterations happen)
// 3. Union results: (nothing to union)
// 4. Result: never
```

## The Fix

Wrap both sides in a tuple to prevent distribution:

```typescript
type IsNever<T> = [T] extends [never] ? true : false;

type Test1 = IsNever<never>; // true
type Test2 = IsNever<string>; // false
```

Tuples aren't unions, so no distribution occurs. The check compares `[never]` to `[never]` directly.

## Who Uses This

XState, Drizzle, and TypeScript's own test suite:

```typescript
// XState
export type IsNever<T> = [T] extends [never] ? true : false;

// Drizzle ORM
export type IsNever<T> = [T] extends [never] ? true : false;

// TypeScript conformance tests
type IsNever<T> = [T] extends [never] ? true : false;
```

It's the standard pattern.

## When You Need It

Any time you're checking if a type resolved to `never`:

```typescript
// Checking if a mapped type produced any keys
type HasKeys<T> = [keyof T] extends [never] ? false : true;

// Checking if an intersection is impossible
type IsImpossible<T> = [T] extends [never] ? true : false;

// Conditional logic based on never
type IfNever<T, Then, Else> = [T] extends [never] ? Then : Else;
```

Without the tuple wrapper, these all break when `T` is `never`.

## The Rule

When writing `T extends never`, always use `[T] extends [never]`. There's no downside; the tuple wrapper is stripped at the type level and has zero runtime cost.
