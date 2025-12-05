# Export-First File Organization: Organizing Code for Readers, Not Compilers

I was reorganizing a complex TypeScript file the other day and realized I was reading it backwards. Scrolling to the bottom first to see what the file actually exported. Then working my way up through the implementation details.

That's when it hit me: I was organizing files for the compiler, not for humans.

Here's what I learned about putting exports first and why it makes code so much easier to navigate.

## The Problem with Bottom-Up Organization

Most codebases organize files in dependency order. Foundation types at the top, then helper functions, then the main exports at the bottom. It follows the mental model of "build up to the big thing."

But when someone opens your file, they don't want to read your implementation journey. They want to know: what does this file do? What can I import from it?

## The Solution: Exports First

My preferred order:

1. **Exports first** - what users can import and use
2. **Most composed types/functions** - higher-level abstractions
3. **Internal helpers** - utilities scoped to this module
4. **Foundational building blocks** - the most basic types and helper functions

*Note: Constants often need to go at the very top due to execution order, even if they're foundational.*

```typescript
// 1. Exports - what users actually see and use
export function definePlugin<T>(config: PluginConfig<T>): Plugin<T> {
  return {
    id: config.id,
    tables: config.tables,
    dependencies: config.dependencies || [],
    methods: config.methods
  };
}

export type Plugin<T = unknown> = {
  id: string;
  tables: PluginTableMap;
  dependencies?: Plugin[];
  methods: (api: PluginAPI) => Record<string, PluginMethod>;
};

// 2. Composed types - higher-level abstractions
type PluginAPI = BuildDependencyNamespaces & {
  [key: string]: BuildPluginNamespace;
};

type BuildDependencyNamespaces = {
  // ...internal type composition
};

// 3. Internal helpers would go here
// (module-scoped utilities)

// 4. Foundational building blocks - most basic types and helper functions
type TableWithId = SQLiteTable & {
  id: SQLiteColumn;
};
```

Now when someone opens the file, they immediately see `definePlugin` and `Plugin`. The main things you export and use. If they need to understand how it works internally, they can keep reading down.

## Why This Actually Works

TypeScript doesn't care about declaration order for types. You can reference a type before you define it. Functions hoist in JavaScript, so named functions can be called before they're declared.

This means you can organize by importance to the reader instead of technical dependency order.

The only exception is constants. Those still need proper execution order:

```typescript
// Constants first - execution order still matters
export const DEFAULT_TIMEOUT = 5000;

// Then functions that use them
export function createClient(timeout = DEFAULT_TIMEOUT) {
  // ...
}
```

If you put the constant below the function, you get a reference error at runtime.

## The Judgment Call Part

This isn't a rigid rule. Sometimes a small helper type or constant makes more sense near the top because it clarifies the main export. Sometimes you have a file that's purely internal utilities with no clear "main" export.

The question I ask: "If someone opens this file cold, what do they need to see first?"

Usually that's the exports. The public API. What they can actually use.

## Real Example: Before and After

Here's how I reorganized one of my plugin files:

**Before (dependency order):**
```typescript
type TableWithId = SQLiteTable & { id: SQLiteColumn };
type PluginTableMap = Record<string, ColumnBuilderBase>;
type BuildPluginNamespace = Record<string, EnhancedTableType>;
type PluginAPI = BuildDependencyNamespaces & { [key: string]: BuildPluginNamespace };
type Plugin<T> = { /* ... */ };
export function definePlugin<T>(config: PluginConfig<T>): Plugin<T> { /* ... */ }
```

**After (export-first):**
```typescript
export function definePlugin<T>(config: PluginConfig<T>): Plugin<T> { /* ... */ }
export type Plugin<T> = { /* ... */ };
type PluginAPI = BuildDependencyNamespaces & { [key: string]: BuildPluginNamespace };
type BuildPluginNamespace = Record<string, EnhancedTableType>;
type PluginTableMap = Record<string, ColumnBuilderBase>;
type TableWithId = SQLiteTable & { id: SQLiteColumn };
```

Same code. Same functionality. But now when you open the file, you immediately see `definePlugin` and know what the file does.

## The Broader Principle

This applies beyond just TypeScript files. In any code organization:

1. What do people need to see first?
2. What are they likely to be looking for?
3. How can I minimize the time between "opening the file" and "understanding what it does"?

Organize for your reader's mental model, not your implementation's dependency graph.

The lesson: your code isn't just instructions for the computer. It's communication with other humans. Make it easy for them to find what they're looking for.