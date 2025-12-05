# The `extends true` Pattern: Type-Level Branching in TypeScript

I was building a type-safe schema system for Epicenter when I hit this problem: I needed to convert schema definitions into concrete TypeScript types, but I needed those types to be *precise*. Not just "this column might be nullable," but "this specific column *is* nullable" or "this specific column is *not* nullable."

The solution turned out to be a pattern I hadn't seen before: using boolean literals as type parameters and checking `extends true` instead of `extends boolean`. Let me show you why this matters.

## The Problem: Lost Precision

Here's what I was trying to build. Users define database schemas using function calls:

```typescript
const schema = {
  id: id(),
  title: text(),                    // NOT NULL by default
  description: text({ nullable: true }),  // explicitly nullable
};
```

Then I needed to convert these schema definitions into TypeScript types that match what you'd actually get at runtime. A non-nullable text column should give you `string`. A nullable one should give you `string | null`.

The naive approach doesn't work:

```typescript
type TextColumnSchema = {
  type: 'text';
  nullable: boolean;  // This loses information!
};

type CellValue = TextColumnSchema extends { nullable: boolean }
  ? string | null  // Always the union, never just string
  : never;
```

When `nullable` is typed as `boolean`, TypeScript doesn't know if it's `true` or `false`. You always get `string | null`, even for columns that are definitely not nullable. You've lost the precision.

## The Insight: Boolean Literals Are Types

Here's what I didn't realize at first: `true` and `false` aren't just values. They're distinct types.

In TypeScript's type system:
- The type `boolean` is actually a union: `true | false`
- The type `true` is a literal type that only accepts the value `true`
- The type `false` is a literal type that only accepts the value `false`

This means you can use boolean literals as type parameters to encode precise information:

```typescript
type TextColumnSchema<TNullable extends boolean> = {
  type: 'text';
  nullable: TNullable;
};

// These are different types!
type NonNullableText = TextColumnSchema<false>;  // nullable: false
type NullableText = TextColumnSchema<true>;      // nullable: true
```

Now the nullability is part of the type itself. When you have a `TextColumnSchema<false>`, TypeScript knows definitively that `nullable` is `false`.

## The Pattern: `extends true`

Once you have boolean literals as type parameters, you can use conditional types to branch on them:

```typescript
type CellValue<C extends ColumnSchema> =
  C extends TextColumnSchema<infer TNullable>
    ? TNullable extends true
      ? string | null      // nullable case
      : string             // non-nullable case
    : // ... other column types
```

Let's break down what's happening:

1. `C extends TextColumnSchema<infer TNullable>` - Extract the nullable type parameter
2. `TNullable extends true` - Check if it's specifically `true`
3. If yes: `string | null`
4. If no: `string`

The key is that `TNullable extends true` is asking "is this type exactly the literal type `true`?" not "is this a boolean?"

When `TNullable` is `false`, the check `false extends true` evaluates to false, and we take the else branch. When `TNullable` is `true`, the check `true extends true` evaluates to true, and we get the nullable type.

## The Full Picture: Schema to Type Conversion

Here's how this plays out in the actual Epicenter codebase. I'll show you the progression from schema definition to final type.

### Step 1: Define the schema with overloads

```typescript
export function text(opts: { nullable: true }): TextColumnSchema<true>;
export function text(opts?: { nullable?: false }): TextColumnSchema<false>;
export function text({ nullable = false }: { nullable?: boolean } = {}) {
  return { type: 'text', nullable };
}
```

These overloads do the magic. When you call `text({ nullable: true })`, the return type is `TextColumnSchema<true>`. When you call `text()` or `text({ nullable: false })`, you get `TextColumnSchema<false>`.

The runtime value (`true` or `false`) matches the type parameter. The type system and the runtime stay in sync.

### Step 2: Convert schema types to cell value types

```typescript
export type CellValue<C extends ColumnSchema = ColumnSchema> =
  C extends IdColumnSchema
    ? string
    : C extends TextColumnSchema<infer TNullable>
      ? TNullable extends true
        ? string | null
        : string
      : C extends IntegerColumnSchema<infer TNullable>
        ? TNullable extends true
          ? number | null
          : number
        : C extends BooleanColumnSchema<infer TNullable>
          ? TNullable extends true
            ? boolean | null
            : boolean
          : // ... more cases
```

Notice the pattern repeated for each column type:
1. Use `infer TNullable` to extract the boolean literal
2. Check `TNullable extends true` to branch the type
3. Return the nullable or non-nullable version

### Step 3: Build the row type

```typescript
export type Row<TTableSchema extends TableSchema = TableSchema> = {
  readonly [K in keyof TTableSchema]: CellValue<TTableSchema[K]>;
};
```

This maps over each column in the schema and applies the `CellValue` transformation. Because each column's schema carries its own precise nullable information, the resulting row type is fully typed:

```typescript
const schema = {
  id: id(),
  title: text(),
  description: text({ nullable: true }),
  views: integer(),
};

// Resulting type:
type MyRow = {
  readonly id: string;
  readonly title: string;           // not nullable
  readonly description: string | null;  // nullable
  readonly views: number;           // not nullable
};
```

## Why Not Just Use String Unions?

You might wonder: why not use string literals like `'nullable' | 'not-nullable'` instead of boolean literals?

You could, but then the runtime value doesn't match the type. With booleans:

```typescript
text({ nullable: true })  // runtime: true, type: TextColumnSchema<true>
```

The `nullable` property is *both* a runtime boolean you can check and a type-level flag. You don't need separate representations for runtime and compile-time.

## Why Not Just Check `extends boolean`?

This doesn't work:

```typescript
TNullable extends boolean
  ? string | null  // Always taken!
  : string
```

Both `true` and `false` extend `boolean`, so this condition is always true. You can't branch on it.

But `extends true` is different. Only the literal type `true` extends `true`. The literal type `false` does not extend `true`.

## When This Pattern Matters

Use this pattern when:

1. **You're building type transformations** - Converting one type representation to another
2. **You need precise branching** - The difference between `true` and `false` matters for correctness
3. **Runtime and type-time need to align** - The boolean value drives both behavior and types

Don't use it when:

1. **You just need a runtime boolean** - Regular booleans are simpler
2. **The distinction doesn't affect types** - If both cases produce the same type, you don't need literal types
3. **You're not doing conditional type logic** - This is overkill for simple type definitions

## The Bigger Picture: Type-Level Programming

This pattern is part of a broader idea: treating types as data you can manipulate. Generic type parameters are like function parameters. Conditional types are like if-statements. Type inference (`infer`) is like pattern matching.

The `extends true` pattern is type-level branching. You're asking a yes/no question about a type and returning different types based on the answer.

Once you start thinking this way, you realize TypeScript's type system is actually a functional programming language. It has:
- Variables (type parameters)
- Functions (generic types)
- Conditionals (`extends`)
- Pattern matching (`infer`)
- Recursion (types that reference themselves)

The `extends true` pattern is just an if-statement in this type-level language.

## The Lesson

When you need to preserve precise information through multiple layers of type transformation, encode that information in type parameters, not just runtime values.

Boolean literals let you represent yes/no distinctions at the type level. The `extends true` pattern lets you branch on those distinctions.

This isn't a pattern you'll use every day, but when you need it, nothing else works quite as well. It's the difference between types that are vaguely correct and types that are precisely correct.

And in a type system, precision is the point.
