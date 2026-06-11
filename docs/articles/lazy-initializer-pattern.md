# Stop Writing Let-Then-Check. Use a Lazy Initializer

You've written this pattern. Everyone has. A value that's expensive to compute, only needed sometimes, so you defer it with a `let` and a null check. It works. It just feels slightly wrong every time.

Here's what it looked like in Epicenter's `YKeyValueLww` observer, where we needed to avoid recomputing `yarray.toArray()` and rebuilding an index map on every change event:

```typescript
let allEntries: YKeyValueLwwEntry<T>[] | null = null;
const getAllEntries = () => {
  allEntries ??= yarray.toArray();
  return allEntries;
};
let entryIndexMap: Map<YKeyValueLwwEntry<T>, number> | null = null;
const getEntryIndex = (entry: YKeyValueLwwEntry<T>): number => {
  if (!entryIndexMap) {
    const entries = getAllEntries();
    entryIndexMap = new Map();
    for (let i = 0; i < entries.length; i++) {
      const indexedEntry = entries[i];
      if (indexedEntry) entryIndexMap.set(indexedEntry, i);
    }
  }
  return entryIndexMap.get(entry) ?? -1;
};
```

Two `let` variables, two null checks, one function that calls another. The logic is correct but the structure is noise. The real work, `toArray()` and building the map, is buried under bookkeeping.

## The Abstraction That Was Missing

The pattern is always the same: run `init()` once, cache the result, return it on every subsequent call. That's a function. Write it once:

```typescript
export function lazy<T>(init: () => T): () => T {
  let value: T | undefined;
  let initialized = false;
  return () => {
    if (!initialized) {
      value = init();
      initialized = true;
    }
    return value as T;
  };
}
```

The `initialized` boolean is deliberate. `??=` would break if `init()` legitimately returns `undefined` or `null`: the null check would re-run the initializer on every call. The boolean flag handles those cases correctly.

## What the Code Looks Like After

```typescript
const getAllEntries = lazy(() => yarray.toArray());
const getEntryIndexMap = lazy(() => {
  const entries = getAllEntries();
  const map = new Map<YKeyValueLwwEntry<T>, number>();
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    if (entry) map.set(entry, i);
  }
  return map;
});
const getEntryIndex = (entry: YKeyValueLwwEntry<T>): number =>
  getEntryIndexMap().get(entry) ?? -1;
```

The null-tracking variables are gone. Each lazy value declares what it computes, not how it caches. `getEntryIndexMap` calls `getAllEntries()` inside its initializer. If `getAllEntries` hasn't run yet, it runs now. They compose naturally because they're just functions.

## Scope Is the Key Property

These lazy values are created inside a callback. When the callback returns, they go out of scope and get garbage collected. There's no global state, no module-level singleton, no cleanup needed. Each invocation of the observer gets its own fresh lazy values, computed on demand, discarded when done.

This helper is deliberately sync-only. It is different from the async lazy singleton pattern, where you cache a `Promise` at module scope so an expensive async operation only runs once for the lifetime of the process. That pattern is for long-lived resources: database connections, loaded configs, initialized SDKs. This pattern is for one-shot deferred computation within a single function scope: values that are expensive enough to skip if unused, but only needed for the duration of one call.

The distinction matters. Reach for an explicit promise field when async lifecycle code needs a barrier. Reach for `lazy()` when you want "compute this sync value at most once, but only if something actually asks for it."

The vague code smell from the let-then-check pattern was pointing at a real gap. `lazy()` fills it.
