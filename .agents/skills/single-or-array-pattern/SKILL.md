---
name: single-or-array-pattern
description: Pattern for functions that accept either a single item or an array. Use when creating CRUD operations, batch processing APIs, or factory functions that should flexibly handle one or many inputs.
metadata:
  author: epicenter
  version: '1.0'
---

# Single-or-Array Overload Pattern

Accept both single items and arrays, normalize internally, delegate to array-only implementation.

## Quick Reference

```typescript
// Option 1: Explicit overloads (cleaner IDE signatures)
function create(item: T): Promise<Result<T, E>>;
function create(items: T[]): Promise<Result<T[], E>>;
function create(itemOrItems: T | T[]): Promise<Result<T | T[], E>> {
	const items = Array.isArray(itemOrItems) ? itemOrItems : [itemOrItems];
	return createInternal(items);
}

// Option 2: Union type (less boilerplate)
function create(itemOrItems: T | T[]): Promise<Result<void, E>> {
	const items = Array.isArray(itemOrItems) ? itemOrItems : [itemOrItems];
	// ... implementation
}
```

## The Structure

1. **Public API**: Accepts `T | T[]`
2. **Normalization**: `Array.isArray()` check, wrap single in array
3. **Internal function**: Only handles arrays

```typescript
// Public: flexible API
function createServer(clientOrClients: Client | Client[], options?: Options) {
	const clients = Array.isArray(clientOrClients)
		? clientOrClients
		: [clientOrClients];
	return createServerInternal(clients, options);
}

// Internal: array-only, all real logic here
function createServerInternal(clients: Client[], options?: Options) {
	// Implementation only handles arrays
}
```

## Naming Conventions

| Parameter               | Normalized Variable |
| ----------------------- | ------------------- |
| `recordingOrRecordings` | `recordings`        |
| `clientOrClients`       | `clients`           |
| `itemOrItems`           | `items`             |
| `paramsOrParamsArray`   | `paramsArray`       |

## When to Use

**Good fit:**

- CRUD operations (create, update, delete)
- Batch processing APIs
- Factory functions accepting dependencies
- Any "do this to one or many" scenario

**Skip when:**

- Single vs batch have different semantics
- Return types vary significantly
- Array version needs different options

## Codebase Examples

### Server Factory (`packages/epicenter/src/server/server.ts`)

```typescript
function createServer(
	client: AnyWorkspaceClient,
	options?: ServerOptions,
): ReturnType<typeof createServerInternal>;
function createServer(
	clients: AnyWorkspaceClient[],
	options?: ServerOptions,
): ReturnType<typeof createServerInternal>;
function createServer(
	clientOrClients: AnyWorkspaceClient | AnyWorkspaceClient[],
	options?: ServerOptions,
) {
	const clients = Array.isArray(clientOrClients)
		? clientOrClients
		: [clientOrClients];
	return createServerInternal(clients, options);
}
```

### Database Service (`apps/whispering/src/lib/services/isomorphic/db/web.ts`)

```typescript
delete: async (recordingOrRecordings) => {
  const recordings = Array.isArray(recordingOrRecordings)
    ? recordingOrRecordings
    : [recordingOrRecordings];
  const ids = recordings.map((r) => r.id);
  return tryAsync({
    try: () => db.recordings.bulkDelete(ids),
    catch: (error) => DbServiceErr({ message: `Error deleting: ${error}` }),
  });
},
```

### Query Mutations (`apps/whispering/src/lib/query/isomorphic/db.ts`)

```typescript
delete: defineMutation({
  mutationFn: async (recordings: Recording | Recording[]) => {
    const recordingsArray = Array.isArray(recordings)
      ? recordings
      : [recordings];

    for (const recording of recordingsArray) {
      services.db.recordings.revokeAudioUrl(recording.id);
    }

    const { error } = await services.db.recordings.delete(recordingsArray);
    if (error) return Err(error);
    return Ok(undefined);
  },
}),
```

## Anti-Patterns

### Don't: Separate functions for single vs array

```typescript
// Harder to maintain, users must remember two APIs
function createRecording(recording: Recording): Promise<...>;
function createRecordings(recordings: Recording[]): Promise<...>;
```

### Don't: Force arrays everywhere

```typescript
// Awkward for single items
createRecordings([recording]); // Ugly
```

### Don't: Duplicate logic in overloads

```typescript
// BAD: Logic duplicated
function create(item: T) {
	return db.insert(item); // Duplicated
}
function create(items: T[]) {
	return db.bulkInsert(items); // Different code path
}

// GOOD: Single implementation
function create(itemOrItems: T | T[]) {
	const items = Array.isArray(itemOrItems) ? itemOrItems : [itemOrItems];
	return db.bulkInsert(items); // One code path
}
```

## References

- [Full article](../../docs/articles/single-or-array-overload-pattern.md) — detailed explanation with more examples
