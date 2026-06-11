# Arktype Optional Keys Need the Undefined Union

You define an optional property in arktype:

```typescript
const AuthUser = type({
  id: 'string',
  email: 'string',
  'name?': 'string',
});
```

Looks right. The `?` makes the key optional, just like TypeScript's `name?: string`. Then your API returns `{ id: "abc", email: "a@b.com", name: undefined }` and validation fails. The error says "name must be a string (was undefined)."

## Why It Fails

Arktype defaults to `exactOptionalPropertyTypes: true` behavior at the validation layer. This is stricter than most TypeScript projects, which leave that compiler flag off.

Here's what each pattern actually accepts:

| Pattern | key absent | `key: undefined` | `key: "foo"` |
|---|---|---|---|
| `'key?': 'string'` | passes | **fails** | passes |
| `'key?': 'string \| undefined'` | passes | passes | passes |

With `'name?': 'string'`, the key can be missing entirely, but if it's present, it must be a real string. `undefined` is not a string. Arktype rejects it.

This catches people because TypeScript's default behavior is the opposite. Without `exactOptionalPropertyTypes`, TypeScript treats `name?: string` as `name?: string | undefined` automatically. You never think about it. Arktype forces you to think about it.

## The Fix

Always include `| undefined` when the value might actually be `undefined`:

```typescript
const AuthUser = type({
  id: 'string',
  email: 'string',
  'name?': 'string | undefined',
});
```

Now all three cases pass: key absent, key explicitly `undefined`, key with a real string value.

## When You Want the Strict Behavior

Sometimes `'key?': 'string'` is exactly what you want. If you're validating user input for a PATCH endpoint, you might want to distinguish between "field not provided" (don't update) and "field set to undefined" (that's a bug, reject it). The strict behavior catches malformed payloads where someone accidentally sends `undefined` instead of omitting the field.

The rule: use `'key?': 'string'` when `undefined` as a value is always a mistake. Use `'key?': 'string | undefined'` when the data source might legitimately include `undefined`, which is most of the time with HTTP JSON bodies, database results, and third-party APIs.

## The Global Escape Hatch

Arktype lets you disable this behavior globally:

```typescript
import { configure } from 'arktype/config';

configure({ exactOptionalPropertyTypes: false });
```

With this, `'key?': 'string'` behaves like TypeScript's default: `undefined` values are accepted. But this is a blunt instrument. You lose the ability to be strict anywhere. Better to be explicit per-field with `| undefined` and keep the default strict behavior as a safety net.

## The Pattern

When defining optional properties in arktype, ask: "Can this value actually be `undefined` at runtime?" If yes, and for most real-world data sources the answer is yes, always write both `?` and `| undefined`:

```typescript
const Schema = type({
  'temperature?': 'number | undefined',
  'maxTokens?': 'number | undefined',
  'name?': 'string | undefined',
});
```

The `?` controls key presence. The `| undefined` controls value type. They're independent. You almost always want both.
