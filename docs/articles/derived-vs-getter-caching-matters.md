# `$derived` vs Getter. Both Reactive, Only One Caches

A getter that reads from a `SvelteMap` is reactive. Svelte tracks the `SvelteMap` read, and anything consuming the getter re-renders when the map changes. So why bother with `$derived`?

Caching.

## The Two Approaches

```typescript
function createSavedTabState() {
  const tabsMap = fromTable(workspaceClient.tables.savedTabs);

  // Option A: $derived: computes once, caches until tabsMap changes
  const tabs = $derived(tabsMap.values().toArray().sort((a, b) => b.savedAt - a.savedAt));

  return {
    get tabs() { return tabs; },
  };

  // Option B: plain getter: recomputes on every access
  return {
    get tabs() {
      return tabsMap.values().toArray().sort((a, b) => b.savedAt - a.savedAt);
    },
  };
}
```

Both are reactive. Both return fresh data. The difference is what happens when `tabs` is read multiple times in the same render cycle.

## What Each Does

**`$derived`** creates a reactive signal. The expression runs once when its dependencies change, and the result is memoized. Ten reads in the same cycle. Template, a count badge, a conditional, a child component. All hit the cache. The sort runs once.

**A plain getter** is just a JavaScript getter. Every access runs `values().toArray().sort()` from scratch. Ten reads means ten sorts. Svelte doesn't know it's a computed value. It only tracks the `SvelteMap` reads inside the getter body.

## Why It Matters

For a list of 20 saved tabs, the performance difference is negligible. But the principle scales. As the dataset grows, as more consumers read the same derived value, caching pays off. And `$derived` is the idiomatic Svelte 5 way to express "computed from reactive state". It communicates intent.

Both approaches are reactive because both ultimately read from a `SvelteMap` that Svelte's runtime tracks. The getter doesn't break reactivity. `$derived` adds caching on top.

## The Rule

Prefer `$derived` for any computation derived from reactive state. Use a getter only to expose the derived value as a public API. Not to house the computation itself.

```typescript
// Correct: $derived holds the computation, getter exposes it
const tabs = $derived(tabsMap.values().toArray().sort((a, b) => b.savedAt - a.savedAt));
return {
  get tabs() { return tabs; },
};
```

This is the three-layer pattern: `fromTable` (reactive source) → `$derived` (cached computation) → `get` (public API). The getter is a pass-through, not a computation site.
