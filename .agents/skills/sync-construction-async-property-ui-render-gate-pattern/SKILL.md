---
name: sync-construction-async-property-ui-render-gate-pattern
description: Sync construction with async property pattern. Use when creating clients that need async initialization but must be exportable from modules and usable synchronously in UI components.
metadata:
  author: epicenter
  version: '1.0'
---

# Sync Construction, Async Property

> The initialization of the client is synchronous. The async work is stored as a property you can await, while passing the reference around.

## When to Apply This Pattern

Use this when you have:

- Async client initialization (IndexedDB, server connection, file system)
- Module exports that need to be importable without `await`
- UI components that want sync access to the client
- SvelteKit apps where you want to gate rendering on readiness

Signals you're fighting async construction:

- `await getX()` patterns everywhere
- Top-level await complaints from bundlers
- Getter functions wrapping singleton access
- Components that can't import a client directly

## The Problem

Async constructors can't be exported:

```typescript
// This doesn't work
export const client = await createClient(); // Top-level await breaks bundlers
```

So you end up with getter patterns:

```typescript
let client: Client | null = null;

export async function getClient() {
	if (!client) {
		client = await createClient();
	}
	return client;
}

// Every consumer must await
const client = await getClient();
```

Every call site needs `await`. You're passing promises around instead of objects.

## The Pattern

Make construction synchronous. Attach async work to the object:

```typescript
// client.ts
export const client = createClient();

// Sync access works immediately
client.save(data);
client.load(id);

// Await the async work when you need to
await client.whenSynced;
```

Construction returns immediately. The async initialization (loading from disk, connecting to servers) happens in the background and is tracked via `whenSynced`.

## The UI Render Gate

In Svelte, await once at the root:

```svelte
<!-- +layout.svelte -->
<script>
	import { client } from '$lib/client';
</script>

{#await client.whenSynced}
	<LoadingSpinner />
{:then}
	{@render children?.()}
{/await}
```

The gate guarantees: by the time any child component's script runs, the async work is complete. Children use sync access without checking readiness.

## Implementation

The `withCapabilities()` fluent builder attaches async work to a sync-constructed object:

```typescript
function createClient() {
	const state = initializeSyncState();

	return {
		save(data) {
			/* sync method */
		},
		load(id) {
			/* sync method */
		},

		withCapabilities({ persistence }) {
			const whenSynced = persistence(state);
			return Object.assign(this, { whenSynced });
		},
	};
}

// Usage
export const client = createClient().withCapabilities({
	persistence: (state) => loadFromIndexedDB(state),
});
```

## Before and After

| Aspect         | Async Construction        | Sync + whenSynced       |
| -------------- | ------------------------- | ----------------------- |
| Module export  | Can't export directly     | Export the object       |
| Consumer code  | `await getX()` everywhere | Direct import, sync use |
| UI integration | Awkward promise handling  | Single `{#await}` gate  |
| Type signature | `Promise<X>`              | `X` with `.whenSynced`  |

## Real-World Example: y-indexeddb

The Yjs ecosystem uses this pattern everywhere:

```typescript
const provider = new IndexeddbPersistence('my-db', doc);
// Constructor returns immediately

provider.on('update', handleUpdate); // Sync access works

await provider.whenSynced; // Wait when you need to
```

They never block construction. The async work is always deferred to a property you can await.

## Related Patterns

- [Lazy Singleton](../lazy-singleton/SKILL.md) — when you need race-condition-safe lazy initialization
- [Don't Use Parallel Maps](../../docs/articles/instance-state-attachment-pattern.md) — attach state to instances instead of tracking separately

## References

- [Full article](/docs/articles/sync-construction-async-property-ui-render-gate-pattern.md) — detailed explanation with diagrams
- [Comprehensive guide](/docs/articles/sync-client-initialization.md) — 480-line deep dive
