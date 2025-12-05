# Working Around Y.Map's Single Generic Parameter

I was building a YJS-based data structure and hit this weird typing error. Had a nested map where I knew exactly what keys existed: `rowsById` (a map of maps) and `rowOrder` (an array of strings). Seemed perfect for a Y.Map, right?

Wrong.

## The Problem

Y.Map only accepts one generic parameter:

```typescript
type Y.Map<T> = // ... can only specify value type
```

When you have heterogeneous values (different types for different keys), you end up fighting the type system:

```typescript
// This doesn't work cleanly
const tableMap = new Y.Map<Y.Map<YjsValue> | Y.Array<string>>();
tableMap.set('rowsById', new Y.Map()); // type: Y.Map<YjsValue>
tableMap.set('rowOrder', new Y.Array()); // type: Y.Array<string>

// TypeScript can't verify which key has which type
const rowsById = tableMap.get('rowsById'); // Y.Map<YjsValue> | Y.Array<string>
```

You need type assertions everywhere. Messy.

This is different from regular TypeScript where you'd just write:

```typescript
type TableStructure = {
	rowsById: Map<string, RowData>;
	rowOrder: string[];
};
```

With regular types, TypeScript knows exactly what's at each key. With Y.Map's single generic, you lose that precision.

## The Insight

Here's what took me too long to realize: if you know the keys at compile time, you probably don't need a Y.Map.

Y.Map is designed for dynamic keys where you don't know what keys will exist. It tracks additions and deletions of keys. But I had exactly two keys, both always present, both known at compile time: `rowsById` and `rowOrder`.

That's not a dynamic key-value store. That's a struct.

So I thought:

> If you know the keys at compile time, you don't really need a [Y.Map](http://Y.Map), you can use a plain object

But that's not exactly true.

## The Reality Check

Here's where I hit a wall: YJS requires nested shared types to be integrated into the document tree. You can't just create a plain object with Y.Map/Y.Array values and store it in a Y.Map. YJS needs to track these nested structures.

So the actual implementation still uses Y.Map:

```typescript
const tableMap = new Y.Map<RowsById | RowOrder>();
tableMap.set('rowsById', new Y.Map<Y.Map<YjsValue>>());
tableMap.set('rowOrder', new Y.Array<string>());
tables.set(tableName, tableMap);
```

But here's the key insight: while the runtime uses Y.Map, you can wrap access with type-safe helper methods:

```typescript
// Type aliases for clarity
type RowsById = Y.Map<Y.Map<YjsValue>>;
type RowOrder = Y.Array<string>;
type TableMap = Y.Map<RowsById | RowOrder>;

// Encapsulate access in factory function
export function createYjsDocument(
	workspaceId: string,
	tableSchemas: Record<string, TableSchema>,
) {
	const ydoc = new Y.Doc({ guid: workspaceId });
	const tables = ydoc.getMap<TableMap>('tables');

	// Initialize tables
	for (const tableName of Object.keys(tableSchemas)) {
		const tableMap = new Y.Map<RowsById | RowOrder>();
		tableMap.set('rowsById', new Y.Map<Y.Map<YjsValue>>());
		tableMap.set('rowOrder', new Y.Array<string>());
		tables.set(tableName, tableMap);
	}

	return {
		// Type-safe accessors hide the union type complexity
		getTableRowsById(tableName: string): RowsById {
			const table = tables.get(tableName);
			return table.get('rowsById') as RowsById;
		},

		getTableRowOrder(tableName: string): RowOrder {
			const table = tables.get(tableName);
			return table.get('rowOrder') as RowOrder;
		},
	};
}
```

Now consumers get type-safe access without dealing with union types:

```typescript
const doc = createYjsDocument('workspace-id', tableSchemas);
const rowsById = doc.getTableRowsById('posts'); // RowsById - no union!
const rowOrder = doc.getTableRowOrder('posts'); // RowOrder - no union!

// Full type safety when using them
rowsById.set('post-1', new Y.Map()); // ✅ TypeScript knows this is valid
rowOrder.push(['post-1']); // ✅ TypeScript knows this is valid
```

The type assertion is contained to one place (the helper method), and consumers get clean, type-safe APIs.

## When to Use This Pattern

This pattern is ideal when you have:

1. **Fixed schema with heterogeneous types**: You know exactly what keys exist (`rowsById`, `rowOrder`) and they have different types
2. **Nested collaborative structures**: The values themselves are Y types that need CRDT tracking
3. **TypeScript codebase**: You want compile-time safety without runtime overhead

### Anti-patterns to avoid:

**Don't do this** (union types everywhere):

```typescript
// Consumer has to deal with union types
const table = tables.get('posts'); // Y.Map<RowsById | RowOrder>
const rowsById = table.get('rowsById'); // RowsById | RowOrder 😞
// Need type assertion or type guard at every call site
```

**Do this instead** (encapsulated access):

```typescript
// Consumer gets concrete types
const rowsById = doc.getTableRowsById('posts'); // RowsById ✅
// No assertions needed at call sites
```

## The Actual Structure

Here's what the vault structure looks like:

```typescript
ydoc
  └─ tables (Y.Map<TableMap>)
      └─ tableName (Y.Map)
          ├─ rowsById (Y.Map<Y.Map<YjsValue>>)
          └─ rowOrder (Y.Array<string>)
```

Runtime: Y.Map for everything (YJS requirement)
Interface: Typed helpers that hide the union type complexity

## The Lesson

Y.Map's single generic parameter isn't a limitation you can avoid with YJS - it's a constraint you work around with better abstractions.

When you have fixed keys with heterogeneous value types:

1. Use Y.Map at runtime (YJS requirement for nested shared types)
2. Wrap access in typed helper methods
3. Consumers get type safety without union types or assertions

The structure is collaborative where it needs to be, typed where you want it to be.

## See Also

For a deeper explanation of why you must use Y.Map (and can't use plain objects) for nested Y types, see: [Why You Can't Nest Y Types in Plain Objects](./20251001T220815-yjs-document-tree-integration.md)

That article explains the YJS document tree integration requirement and shows concrete examples of what breaks when you try to use plain objects as containers.
