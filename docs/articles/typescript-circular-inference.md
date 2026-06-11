# When TypeScript Can't Infer Dependent Property Types (And How to Fix It)

I needed an API where one property's type depends on another property's inferred type. Something like this:

> **Note:** The `defineWorkspace({ tables, providers, actions })` API shown below is from an earlier Epicenter iteration and no longer exists: the current primitive is `defineDocument((id) => ({ ydoc, tables, ... }))` with inline composition instead of the `providers` / `actions` callback chain. The TypeScript circular-inference problem this article teaches generalizes to any config API where one property's type depends on another's inferred type.

```typescript
defineWorkspace({
	tables: {
		posts: { id: 'string', title: 'string', content: 'string' },
	},
	providers: ({ tables }) => ({
		sqlite: createSqliteProvider(tables),
		markdown: createMarkdownProvider('./posts'),
	}),
	actions: ({ providers }) => ({
		getPost: async (id) => {
			// I want 'providers.sqlite' to be properly typed here
			return providers.sqlite.query({ id }); // But sqlite is typed as 'any'!
		},
	}),
});
```

TypeScript should infer the table types into providers, then both into exports. It does. Mostly. Table types flow through fine, but provider types get widened to `any` in exports.

**The Problem**: TypeScript infers all properties simultaneously. Using computed types like `ReturnType<>` creates a circular dependency:

```typescript
// ❌ Broken: Parameterizing function types
type Config<
	TSchema,
	TProvidersFn extends (ctx: { tables: Tables<TSchema> }) => any,
	TExportsFn extends (ctx: {
		tables: Tables<TSchema>;
		providers: ReturnType<TProvidersFn>; // Circular! Needs TProvidersFn to be inferred
	}) => any,
> = {
	tables: TSchema;
	providers: TProvidersFn;
	exports: TExportsFn;
};
```

TypeScript needs `ReturnType<TProvidersFn>` to check `TExportsFn`, but must finish inferring `TProvidersFn` first. Deadlock. It widens to `any` to break the cycle.

**The Solution**: Parameterize return values directly, not function types:

```typescript
// ✅ Works: Parameterizing values
type Config<
	TSchema,
	TProviderMap, // The value, not the function
	TExportMap,
> = {
	tables: TSchema;
	providers: (ctx: { tables: Tables<TSchema> }) => TProviderMap;
	exports: (ctx: {
		tables: Tables<TSchema>;
		providers: TProviderMap;
	}) => TExportMap; // No ReturnType needed!
};
```

TypeScript infers `TProviderMap` from the concrete return value. No circular dependency. You're inferring from values, not types-of-types-being-inferred.

This pattern applies to any API with dependent properties: ORMs where queries depend on schemas, routers where handlers depend on middleware, form libraries where validation depends on field types.

Complete code example with detailed comments explaining why the broken approach fails and why this works: [typescript-inference-pattern.ts](./typescript-inference-pattern.ts)

The key insight: you CAN have a single object literal API with full inference and dependent types. Structure type parameters to match how TypeScript's inference algorithm actually works.
