# The Lazy Singleton Pattern

When you have async initialization and multiple concurrent callers, the naive approach breaks. The fix is simple: store the promise.

## The Naive Approach

You need a singleton with async initialization. The obvious code:

```typescript
let registry: RegistryDoc | null = null;

async function getRegistry(): Promise<RegistryDoc> {
	if (!registry) {
		const doc = createRegistryDoc({ registryId: 'local' });
		await registryPersistence(doc.ydoc);
		registry = doc;
	}
	return registry;
}
```

This looks correct. It creates the registry once, then returns the cached instance on subsequent calls. But there's a subtle bug.

## The Race Condition

Consider what happens when two components call `getRegistry()` at nearly the same time:

```
Time 0ms:   Component A calls getRegistry()
            → registry is null
            → starts async initialization (takes 50ms)

Time 10ms:  Component B calls getRegistry()
            → registry is STILL null (init hasn't finished)
            → starts ANOTHER async initialization

Time 50ms:  Component A's init finishes, sets registry
Time 60ms:  Component B's init finishes, OVERWRITES registry
```

You now have two RegistryDoc instances. Component A holds one; `registry` points to a different one. Any state updates to one won't reflect in the other.

This isn't theoretical. In SvelteKit, layouts re-evaluate on navigation. Multiple child routes can load concurrently. Any situation where your getter might be called while initialization is in-flight creates this race.

## The Fix: Store the Promise

The solution is to cache the initialization promise:

```typescript
let registryPromise: Promise<RegistryDoc> | null = null;

async function getRegistry(): Promise<RegistryDoc> {
	if (!registryPromise) {
		registryPromise = (async () => {
			const doc = createRegistryDoc({ registryId: 'local' });
			await registryPersistence(doc.ydoc);
			return doc;
		})();
	}
	return registryPromise;
}
```

One variable. [Store the promise, not the value](./store-the-promise-not-the-value.md): await it every time.

Now the same scenario plays out differently:

```
Time 0ms:   Component A calls getRegistry()
            → registryPromise is null
            → creates promise, starts async init

Time 10ms:  Component B calls getRegistry()
            → registryPromise EXISTS
            → returns same promise (doesn't create new one)

Time 50ms:  Promise resolves
            → Both A and B receive the same RegistryDoc instance
```

The first caller creates the promise. All subsequent callers share that same promise. When it resolves, everyone gets the same instance.

## Keyed Singletons

Sometimes you need multiple singletons indexed by key. For example, one HeadDoc per workspace:

```typescript
const headPromises = new Map<string, Promise<HeadDoc>>();

async function getHeadDoc(workspaceId: string): Promise<HeadDoc> {
	let promise = headPromises.get(workspaceId);
	if (!promise) {
		promise = (async () => {
			const doc = createHeadDoc({ workspaceId });
			await headPersistence(doc.ydoc, workspaceId);
			return doc;
		})();
		headPromises.set(workspaceId, promise);
	}
	return promise;
}

async function removeHeadDoc(workspaceId: string): Promise<void> {
	const promise = headPromises.get(workspaceId);
	if (promise) {
		const head = await promise;
		head.destroy();
		headPromises.delete(workspaceId);
	}
}
```

Same pattern, but with a Map. Each key gets its own singleton, and concurrent requests for the same key share one initialization promise.

## Extracting a Utility

The boilerplate is mechanical:

```typescript
function createLazySingleton<T>(init: () => Promise<T>) {
	let promise: Promise<T> | null = null;

	return async function get(): Promise<T> {
		if (!promise) {
			promise = init();
		}
		return promise;
	};
}
```

Usage becomes one line:

```typescript
export const getRegistry = createLazySingleton(async () => {
	const doc = createRegistryDoc({ registryId: 'local' });
	await registryPersistence(doc.ydoc);
	return doc;
});
```

The keyed version:

```typescript
function createKeyedLazySingleton<K, T>(init: (key: K) => Promise<T>) {
	const promises = new Map<K, Promise<T>>();

	return {
		get: async (key: K): Promise<T> => {
			let promise = promises.get(key);
			if (!promise) {
				promise = init(key);
				promises.set(key, promise);
			}
			return promise;
		},
		remove: (key: K) => {
			promises.delete(key);
		},
	};
}
```

## Performance Optimization (Usually Not Worth It)

You might want to skip the promise await on subsequent calls by also storing the resolved instance:

```typescript
let registry: RegistryDoc | null = null;
let registryPromise: Promise<RegistryDoc> | null = null;

async function getRegistry(): Promise<RegistryDoc> {
	if (registry) return registry; // Fast path: skip await

	if (!registryPromise) {
		registryPromise = (async () => {
			const doc = createRegistryDoc({ registryId: 'local' });
			await registryPersistence(doc.ydoc);
			registry = doc;
			return doc;
		})();
	}

	return registryPromise;
}
```

The fast path (`if (registry) return registry`) is synchronous. After initialization completes, you don't await anything.

In practice, this optimization rarely matters. Awaiting an already-resolved promise is cheap. The two-variable version adds complexity and more state to track. Stick with the single-promise pattern unless you've measured a bottleneck.

## Related Patterns

- **[Store the Promise, Not the Value](./store-the-promise-not-the-value.md)**: Related pattern for tracking in-flight operations during cleanup
- **[Sync Client Initialization](./sync-client-initialization.md)**: The `whenReady` pattern for synchronous construction with deferred async work
- **[Factory Function Pattern](./factory-function-pattern.md)**: How to structure the initialization function itself
