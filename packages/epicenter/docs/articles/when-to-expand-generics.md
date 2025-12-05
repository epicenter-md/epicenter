# When to Expand Your Generics

I hit an interesting code smell recently. I was looking at some type definitions and noticed this pattern kept repeating:

```typescript
type ObserveHandlers<TTableSchema extends TableSchema> = {
	onAdd: (id: string, data: Row<TTableSchema>) => void;
	onUpdate: (id: string, data: Row<TTableSchema>) => void;
	onDelete: (id: string) => void;
};
```

See it? Every time I reference `TTableSchema`, it's wrapped in `Row<...>`. Three times. Same wrapper, same pattern.

That's the signal. When you're wrapping a generic with the exact same type transformation every single time you use it, your generic is probably one level too low.

## The Pattern

Here's what to look for:

**Bad**: Generic + repetitive wrapper

```typescript
type Thing<TSchema extends Schema> = {
	field1: Transform<TSchema>;
	field2: Transform<TSchema>;
	method(arg: Transform<TSchema>): Transform<TSchema>;
};
```

**Good**: Expanded generic

```typescript
type Thing<TData extends Transform<Schema>> = {
	field1: TData;
	field2: TData;
	method(arg: TData): TData;
};
```

## Real Example: Table Helpers

I had a `TableHelper` type that took a schema and converted it to a row type everywhere:

```typescript
// Before: Schema-level generic
export type TableHelper<TTableSchema extends TableSchema> = {
	set(data: Row<TTableSchema>): void;
	setMany(rows: Row<TTableSchema>[]): void;
	get(id: string): Row<TTableSchema> | undefined;
	getAll(): Row<TTableSchema>[];
	observe(handlers: ObserveHandlers<TTableSchema>): () => void;
	filter(predicate: (row: Row<TTableSchema>) => boolean): Row<TTableSchema>[];
};
```

Count them. `Row<TTableSchema>` appears **seven times**.

The fix? Make the generic one level higher:

```typescript
// After: Row-level generic
export type TableHelper<TRow extends Row> = {
	set(data: TRow): void;
	setMany(rows: TRow[]): void;
	get(id: string): TRow | undefined;
	getAll(): TRow[];
	observe(handlers: ObserveHandlers<TRow>): () => void;
	filter(predicate: (row: TRow) => boolean): TRow[];
};
```

Now I pass `TableHelper<Row<MySchema>>` instead of `TableHelper<MySchema>`. The conversion happens once at the call site instead of seven times in the type definition.

### But Wait, Aren't We Losing Information?

You might think: "If we use `TRow` instead of `Row<TTableSchema>`, don't we lose the connection to the schema?"

No. And here's why: TypeScript narrows the generic at the call site.

For example, if you called `createTableHelper`, TypeScript knows that `TRow` is specifically `Row<MyPostSchema>`, not just any `Row`. The type information flows through. You haven't lost anything; you've just moved the transformation to where it belongs.

Note that `Row` has a default generic:

```typescript
type Row<TTableSchema extends TableSchema = TableSchema> = {
	[K in keyof TTableSchema]: ColumnSchemaToCellValue<TTableSchema[K]>;
};
```

Now `TRow extends Row` means "TRow can be any specific row type, or the generic `Record<string, CellValue>` if unspecified." The constraint is both flexible and precise.

## Why This Matters

1. **Readability**: `TRow` is clearer than `Row<TTableSchema>` when you're reading the type
2. **Maintainability**: Change the transformation once (at call site) instead of updating eight locations
3. **Type inference**: TypeScript has an easier time with simpler generic constraints
4. **Refactoring safety**: If the transformation changes, you only update call sites, not the entire type definition

## The Three-Level Rule

Before this refactoring, I had code that accessed generics three levels deep:

```typescript
// Accessing TSchemas -> TTableName -> Row
type TRow = Row<TSchemas[TTableName]>;
```

Every time I needed the row type, I had to drill down three levels. That's a sign the abstraction is wrong.

After expanding the generic:

```typescript
// Direct access
type TRow = Row<TSchemas[typeof tableName]>;
```

Still not perfect, but one transformation instead of nested generic gymnastics.

## When NOT to Expand

Don't expand generics just because you can. Expand when:

- The wrapper appears **3+ times** in the type definition
- It's **always the same wrapper** (not different transformations)
- The generic is used primarily in its wrapped form

Keep the lower-level generic when:

- You need both the raw and transformed versions
- Different methods need different transformations
- The wrapper is just one of many uses of the generic

## The Lesson

When you see `Wrapper<TGeneric>` repeated throughout a type definition, that's probably what the generic should be. Your generic should represent the thing you're actually working with, not the thing you transform into the thing you're working with.

If you find yourself writing the same type transformation over and over, stop. Make that transformation part of the generic itself.
