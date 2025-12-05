# When TypeScript Can't Infer Dependent Property Types (And How to Fix It)

I needed an API where one property's type depends on another property's inferred type. Something like this:

```typescript
defineWorkspace({
  schema: {
    posts: { id: 'string', title: 'string', content: 'string' }
  },
  indexes: ({ db }) => ({
    sqlite: createSqliteIndex(db),
    markdown: createMarkdownIndex('./posts')
  }),
  actions: ({ indexes }) => ({
    getPost: async (id) => {
      // I want 'indexes.sqlite' to be properly typed here
      return indexes.sqlite.query({ id });  // But sqlite is typed as 'any'!
    }
  })
})
```

TypeScript should infer the schema types into indexes, then both into actions. It does—mostly. Schema types flow through fine, but index types get widened to `any` in actions.

**The Problem**: TypeScript infers all properties simultaneously. Using computed types like `ReturnType<>` creates a circular dependency:

```typescript
// ❌ Broken: Parameterizing function types
type Config<
  TSchema,
  TIndexesFn extends (ctx: { db: Db<TSchema> }) => any,
  TActionsFn extends (ctx: {
    db: Db<TSchema>,
    indexes: ReturnType<TIndexesFn>  // Circular! Needs TIndexesFn to be inferred
  }) => any
> = {
  schema: TSchema,
  indexes: TIndexesFn,
  actions: TActionsFn
}
```

TypeScript needs `ReturnType<TIndexesFn>` to check `TActionsFn`, but must finish inferring `TIndexesFn` first. Deadlock. It widens to `any` to break the cycle.

**The Solution**: Parameterize return values directly, not function types:

```typescript
// ✅ Works: Parameterizing values
type Config<
  TSchema,
  TIndexMap,  // The value, not the function
  TActionMap
> = {
  schema: TSchema,
  indexes: (ctx: { db: Db<TSchema> }) => TIndexMap,
  actions: (ctx: { db: Db<TSchema>, indexes: TIndexMap }) => TActionMap  // No ReturnType needed!
}
```

TypeScript infers `TIndexMap` from the concrete return value. No circular dependency—you're inferring from values, not types-of-types-being-inferred.

This pattern applies to any API with dependent properties: ORMs where queries depend on schemas, routers where handlers depend on middleware, form libraries where validation depends on field types.

Complete code example with detailed comments explaining why the broken approach fails and why this works: [typescript-inference-pattern.ts](./typescript-inference-pattern.ts)

The key insight: you CAN have a single object literal API with full inference and dependent types. Structure type parameters to match how TypeScript's inference algorithm actually works.