# Don't Export Everything

When building TypeScript libraries like Epicenter with AI assistance, I kept finding myself with massive export lists. Every helper type, every utility function, everything was `export`ed. The problem? Most of that stuff was implementation detail that users would never need.

Here's a simple technique I use now: I ask AI to grade each export out of 10 based on how often a user might actually need it.

## The Grading Scale

Take this example from a workspace configuration API:

- `defineWorkspace` function: **10/10** - Core API, everyone needs this
- `WorkspaceConfig` type: **3/10** - Occasionally useful for typing variables, but mostly inferred
- `WorkspaceActionContext` type: **1/10** - Automatically inferred from generics, never imported
- `IndexesAPI` type: **2/10** - Maybe useful for building utilities, but niche
- `extractHandlers` function: **1/10** - Pure internal machinery

## The Rule

Anything under 3/10? Either inline it or remove the export.

For `WorkspaceActionContext`, I inlined it directly where it's used:

```typescript
// Before: exported type used once
export type WorkspaceActionContext<...> = {
  workspaces: DependencyWorkspacesAPI<TDeps>;
  db: Db<TWorkspaceSchema>;
  indexes: IndexesAPI<TIndexes>;
};

// Later...
actions: (context: WorkspaceActionContext<...>) => TActionMap;

// After: inline where needed
actions: (context: {
  workspaces: DependencyWorkspacesAPI<TDeps>;
  db: Db<TWorkspaceSchema>;
  indexes: IndexesAPI<TIndexes>;
}) => TActionMap;
```

For complex helper types like `DependencyWorkspacesAPI`, keep them as non-exported types if the name adds clarity. But simple mapped types? Just inline them.

## Why This Matters

A clean public API surface means:
- Users aren't overwhelmed by irrelevant exports
- Your library is easier to understand
- Breaking changes are less likely (fewer things to maintain)
- IDE autocomplete is actually useful

The best libraries export exactly what users need, nothing more.
