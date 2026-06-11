# TypeScript's `in` Operator Knows More Than TypeScript Does

Here's something weird about TypeScript.

The `in` operator checks if a key _exists_ in an object. Not if the value is defined.

```typescript
const obj = { key: undefined };

'key' in obj; // true - the key exists
'other' in obj; // false - no such key
```

But here's the thing: TypeScript's type system doesn't distinguish between "key is missing" and "key is undefined." To TypeScript, these are the same:

```typescript
type A = { key?: string };
type B = { key: string | undefined };
```

So JavaScript's `in` operator can tell the difference at runtime, but TypeScript can't at compile time.

The fix? Enable `exactOptionalPropertyTypes` in your tsconfig.

Now `key?: string` means "missing or string". Not "missing or string or undefined."

And suddenly, TypeScript understands what `in` has known all along.
