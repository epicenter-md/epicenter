# I Was Maintaining Two TypeScript Types When I Only Needed One

I was building a type-safe database layer in TypeScript. Each column has a schema that defines its type (text, number, date, etc.), and I needed to convert those schemas to their corresponding value types. A text column should give you `string`, a nullable text column should give you `string | null`, and so on.

I wrote a big conditional type to handle this:

```typescript
export type ColumnSchemaToCellValue<C extends ColumnSchema> =
  C extends IdColumnSchema ? string
  : C extends TextColumnSchema<infer TNullable> ? TNullable extends true ? string | null : string
  : C extends NumberColumnSchema ? number
  : C extends DateColumnSchema ? Date
  : never;
```

This worked great for specific columns. Pass in a `TextColumnSchema`, get back `string`. Pass in a `NumberColumnSchema`, get back `number`.

But I also needed a type for "any possible cell value." A union of all the possible outputs. So I made a second type:

```typescript
export type CellValue = ColumnSchemaToCellValue<TableSchema[keyof TableSchema]>;
```

This took the mapper type and applied it to every column in my table schema. Perfect.

Except.

I was now maintaining two types. One that mapped specific schemas to values. One that represented all possible values. They were clearly related, but separate. Whenever I added a new column type, I had to make sure both stayed in sync.

Then I realized something obvious.

`CellValue` wasn't really a different type. It was just `ColumnSchemaToCellValue` with no specific input. Or more precisely, with "all possible inputs."

What if I just made "all possible inputs" the default?

```typescript
export type CellValue<C extends ColumnSchema = ColumnSchema> =
  C extends IdColumnSchema ? string
  : C extends TextColumnSchema<infer TNullable> ? TNullable extends true ? string | null : string
  : C extends NumberColumnSchema ? number
  : C extends DateColumnSchema ? Date
  : never;
```

Now I had one type that did both jobs:
- `CellValue<TextColumnSchema>` gives you `string` (or `string | null` if nullable)
- `CellValue` with no argument gives you the union of all possible cell values

One type. Two uses. The second type was just the first type with a default parameter.

## Why This Works

TypeScript distributes conditional types over unions. When you write `CellValue` without a type argument, it uses the default: `ColumnSchema`. That's a union of all possible column schemas: `IdColumnSchema | TextColumnSchema | NumberColumnSchema | ...`

The conditional type then evaluates for each variant in the union. So you get `string | (string | null) | number | Date | ...` which simplifies to exactly what you want: all possible cell values.

The specific version (`CellValue<TextColumnSchema>`) and the general version (`CellValue`) are the same type, just with different inputs. I didn't need two types. I needed one type with a parameter that could be either specific or general.

## When to Use This Pattern

This pattern works when you have:
- A type transformer (mapped or conditional type)
- A frequent need for "all possible outputs" as a union
- An "all inputs" that can be expressed as a union

I've used this in other places since then. Type guards that narrow to specific types or to "any narrowed type." Validators that validate specific schemas or "any valid schema." The pattern repeats.

## The Lesson

Here's what I learned: When I see two types that feel related, I pause and ask if one is just the other with different parameters. Often, a default generic parameter is all I need to collapse them.

I was treating "transform this specific thing" and "transform all possible things" as separate problems. They're not. They're the same problem with different inputs. And TypeScript's default generic parameters let you express both with a single type.

That's it. No complex refactoring. No new abstractions. Just recognizing that the union type was the mapper type in disguise.
