# Avoiding Infinite Type Recursion in TypeScript Dependency Graphs

I was building a workspace system where each workspace could depend on other workspaces. Seems straightforward, right? Model it as a type where the dependencies are themselves workspaces. But then TypeScript hit me with this:

```
Type instantiation is excessively deep and possibly infinite.
```

It took me longer than I'd like to admit to figure out what was happening and how to fix it.

## The Problem: TypeScript Chases Dependencies Forever

Here's the naive approach. You want to model modules that can import other modules:

```typescript
type Module<TImports extends Record<string, Module<any>>> = {
  name: string;
  imports: TImports;
  exports: unknown;
};

// Try to use it
type MyApp = Module<{
  database: Module<{
    postgres: Module<{}>,
    redis: Module<{}>
  }>,
  logger: Module<{
    fileWriter: Module<{}>
  }>
}>;
// Error: Type instantiation is excessively deep and possibly infinite.
```

What's happening? TypeScript sees `Module<TImports>` where `TImports` contains more `Module` types. So it expands those. But those modules also have imports that are modules. So it expands those. And those modules have imports...

TypeScript tries to fully expand the entire dependency tree. But if your type definition allows unlimited depth, the type checker gives up. It has to, or it would recurse forever.

## The Insight: Not All Dependencies Need Full Types

Here's what took me too long to realize: you don't actually need full type information for every level of the dependency tree.

When you're working with `MyApp`, you care about the types of its immediate dependencies (`database`, `logger`). You might even care about their dependencies (`postgres`, `redis`, `fileWriter`). But do you really need to know the full type structure of dependencies three or four levels deep?

Probably not. You just need to know they exist and what they're called.

## The Solution: Three-Tier Type System

The fix is to introduce constraint types that limit how deeply TypeScript recurses. You build three tiers:

1. **Tier 1 (Top)**: Full type information, dependencies are Tier 2
2. **Tier 2 (Immediate dependencies)**: Full type information, dependencies are Tier 3
3. **Tier 3 (Deeper dependencies)**: Minimal type information, no detailed dependency info

Here's what that looks like:

```typescript
// Tier 3: Minimal constraint type
// Just enough info to know it exists
type MinimalModule = {
  name: string;
};

// Tier 2: Can have dependencies, but they must be minimal
type ModuleWithMinimalImports<TImports extends Record<string, MinimalModule>> = {
  name: string;
  imports: TImports;
  exports: unknown;
};

// Tier 1: Full module with full dependencies
type FullModule<TImports extends Record<string, ModuleWithMinimalImports<any>>> = {
  name: string;
  imports: TImports;
  exports: unknown;
};

// Now this works
type MyApp = FullModule<{
  database: ModuleWithMinimalImports<{
    postgres: MinimalModule,
    redis: MinimalModule
  }>,
  logger: ModuleWithMinimalImports<{
    fileWriter: MinimalModule
  }>
}>;
```

No error. TypeScript expands two levels, then hits the `MinimalModule` constraint and stops.

## Visualizing the Tiers

Here's how the types map to your dependency tree:

```
MyApp (Tier 1: FullModule)
├── database (Tier 2: ModuleWithMinimalImports)
│   ├── postgres (Tier 3: MinimalModule)
│   └── redis (Tier 3: MinimalModule)
└── logger (Tier 2: ModuleWithMinimalImports)
    └── fileWriter (Tier 3: MinimalModule)
```

At Tier 1, you get full type information about `MyApp` and its immediate imports.

At Tier 2, you get full type information about `database` and `logger`, including the names of their imports.

At Tier 3, you just know that `postgres`, `redis`, and `fileWriter` exist. You don't get detailed type information about what they import.

## The Trade-Off

You're trading type information depth for the ability to compile your code.

Specifically, you lose:
- Autocomplete for properties of deeply nested dependencies
- Type checking for transitive dependency structures
- Full type information more than two levels deep

But you gain:
- Code that actually compiles
- The ability to model arbitrarily deep dependency graphs
- Still knowing what exists at all levels (just not the full types)

In practice, this is a good trade-off. You rarely need to know the detailed type structure of transitive dependencies in your type signatures. If you're working with `MyApp`, you care about `database` and `logger`. You don't typically need to know the exact shape of `postgres`'s internal dependencies.

## Runtime Is Unaffected

This is just a type constraint. At runtime, you can still access everything.

Many systems that use this pattern flatten or hoist dependencies at runtime. So even though your types show a three-level tree, your runtime might have a flat map of all modules:

```typescript
const allModules = {
  'myApp': myAppInstance,
  'database': databaseInstance,
  'logger': loggerInstance,
  'postgres': postgresInstance,
  'redis': redisInstance,
  'fileWriter': fileWriterInstance,
};
```

The type constraint doesn't limit what you can do at runtime. It just tells TypeScript to stop trying to expand types after a certain depth.

## When To Use This Pattern

This pattern is useful when you're modeling:

- Plugin systems where plugins can depend on other plugins
- Module systems with nested imports
- Workspace/monorepo tools with workspace dependencies
- Dependency injection containers with transitive dependencies
- Any directed graph where nodes reference other nodes of the same type

You probably don't need this if:

- Your dependency graph is shallow (max 2-3 levels and known at compile time)
- You don't need type information about dependencies in your signatures
- You're using runtime-only dependency resolution without TypeScript types

## The Pattern in Practice

Systems like Epicenter use this pattern to model workspace dependencies. A workspace can depend on other workspaces, which can depend on other workspaces. The three-tier system lets TypeScript provide useful type information for the workspaces you're directly interacting with, while still allowing arbitrarily deep dependency chains.

The key insight: stop the type recursion by constraining deeper types to minimal information. TypeScript doesn't need to know everything about everything to give you useful type checking where it matters.
