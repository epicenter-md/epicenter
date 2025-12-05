# Don't Suppress Errors, Expect Them

When your IDE's quick-fix suggests `// biome-ignore` or `// eslint-disable`, pause. There's a better way.

## The Problem

You're working and hit a type error. Biome shows: "Unexpected any. Specify a different type." You hit `Cmd+.` (or your IDE's quick action shortcut), and it offers "Suppress rule lint/suspicious/noExplicitAny" as a fix.

The IDE is misleading you. If you accept that suggestion, you get this:

```typescript
// biome-ignore lint/suspicious/noExplicitAny: union type compatibility
row: serializedRow as any,
```

This suppresses the linter warning about `as any`, but you're still casting away type safety. The comment is vague ("union type compatibility"). And if someone fixes the underlying type issue later, this line just sits there silently doing nothing.

## The Better Pattern

Use `@ts-expect-error` instead:

```typescript
// @ts-expect-error SerializedRow<TSchema[string]> is not assignable to SerializedRow<TTableSchema> due to union type from $tables() iteration
row: serializedRow,
```

Notice three things:

1. **No `as any` cast**: You're not throwing away type information
2. **Precise documentation**: The comment shows the actual TypeScript error
3. **Self-cleaning code**: If someone fixes the type issue, TypeScript will error on this line because there's no longer an error to expect

## Why This Matters

`@ts-expect-error` turns a code smell into self-documenting, self-cleaning code. When you come back six months later and see that comment, you know exactly what TypeScript is complaining about. And if the types get fixed, the build fails until you remove the now-unnecessary suppression.

Compare:

```typescript
// Before: Vague, permanent, loses type safety
// biome-ignore lint/suspicious/noExplicitAny: union type compatibility
table: { name, schema, validators } as any,

// After: Specific, temporary, preserves type safety
// @ts-expect-error TableHelper<TSchema[keyof TSchema]> is not assignable to TableContext<TSchema[string]> due to union type from $tables() iteration
table,
```

The lesson: Don't suppress errors. Expect them, document them, and let TypeScript clean them up when they're fixed.
