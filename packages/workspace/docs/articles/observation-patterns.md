# Observation Patterns

## Philosophy

All observers in Epicenter follow a simple principle: **notify at the Y.Map boundary, let the consumer fetch the data**.

Observers don't reconstruct or validate data. They just tell you what changed. You call the appropriate getter to fetch current state when you need it.

## Why This Design

1. **Efficiency**: No wasted work reconstructing data the consumer might not need
2. **Simplicity**: Observer implementation is trivial (just watch Y.Map events)
3. **Consistency**: Same pattern across all data structures
4. **Flexibility**: Consumer decides when and how to fetch data

## Pattern by Structure Type

### Single Y.Map (schema, KV top-level)

For structures backed by a single Y.Map, the observer just notifies that something changed:

```typescript
// Observer signature
observe(callback: () => void): () => void

// Usage
const unsub = kv.observe(() => {
  // Something changed - fetch if needed
  const snapshot = kv.toJSON();
  saveToFile(snapshot);
});

const unsub = schema.observe(() => {
  const snapshot = schema.get();
  rebuildValidators(snapshot);
});
```

### Nested Y.Map with known keys (schema.tables, schema.kv)

For Y.Maps where children are also Y.Maps, notify which keys changed:

```typescript
// Observer signature
observe(callback: (changes: Map<string, 'add' | 'delete'>) => void): () => void

// Usage
schema.tables.observe((changes) => {
  for (const [tableName, action] of changes) {
    if (action === 'add') {
      const tableSchema = schema.tables.get(tableName);
      registerTable(tableName, tableSchema);
    } else {
      unregisterTable(tableName);
    }
  }
});
```

### Deeply nested Y.Map (tables = rows)

For tables where each row is a Y.Map, notify which row IDs changed:

```typescript
// Observer signature
observe(callback: (changes: Map<string, 'add' | 'update' | 'delete'>, transaction: Y.Transaction) => void): () => void

// Usage
tables.posts.observe((changes, transaction) => {
  for (const [id, action] of changes) {
    if (action === 'delete') {
      removeFromCache(id);
    } else {
      // Fetch row data only when needed
      const result = tables.posts.get(id);
      if (result.status === 'valid') {
        updateCache(id, result.row);
      }
    }
  }
});
```

## Summary Table

| Structure                   | Observer Callback Receives               | Consumer Fetches With     |
| --------------------------- | ---------------------------------------- | ------------------------- |
| `kv` (top-level)            | `() => void`                             | `kv.toJSON()`             |
| `kv.observeKey('key', ...)` | `(change: KvChange) => void`             | (change has the value)    |
| `schema`                    | `() => void`                             | `schema.get()`            |
| `schema.tables`             | `Map<string, 'add'\|'delete'>`           | `schema.tables.get(name)` |
| `schema.kv`                 | `Map<string, 'add'\|'delete'>`           | `schema.kv.get(name)`     |
| `tables.{name}`             | `Map<string, 'add'\|'update'\|'delete'>` | `tables.{name}.get(id)`   |

## The Y.Map Boundary Rule

The observer tells you **which Y.Map changed**. You read that Y.Map yourself.

- Single Y.Map: "it changed" (no args)
- Parent of Y.Maps: "these children changed" (Map of keys to actions)

This keeps observers simple and puts the consumer in control of when to fetch data.
