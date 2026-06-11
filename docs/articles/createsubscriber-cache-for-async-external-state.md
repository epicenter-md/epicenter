# `$state` or `createSubscriber`? Two Questions.

Two questions decide which one you need. (A [third question](./state-vs-createsubscriber-who-owns-reactivity.md#pattern-d-both-for-lazy-lifecycle): "Is the subscription expensive?". Matters when you need lazy lifecycle management, but it's orthogonal to the choice below.)

**Do you own the data?** If your event handlers can directly assign to the variable that holds it, use `$state`. Your callbacks mutate the proxy, Svelte tracks it, done. This is how `saved-tab-state.svelte.ts` works: the Y.Doc observer calls `tabs = readAll()`, which reassigns a `$state` array, and every component reading `tabs` re-renders. No bridge needed because `$state` is both the storage and the signal.

**Can you read from the source synchronously?** If you don't own the data but the source exposes a sync read, use `createSubscriber` alone. The getter reads directly from the source on every access; `createSubscriber` just tells Svelte when to re-call that getter. `navigator.onLine` and `matchMedia.matches` work this way: there's nothing to cache because the read is instant.

```typescript
get online() {
	this.#subscribe(); // "re-read me when the event fires"
	return navigator.onLine; // sync read, no cache
}
```

When neither is true, you're in the territory this article is about.

## Async External State

`chrome.storage`, IndexedDB, and most persistence APIs return promises. You can't `await` in a getter. And you don't own the data: it lives in the browser's storage subsystem, managed by an API you didn't write. So you need two things: a cache to make reads synchronous, and `createSubscriber` to bridge the external change notification into Svelte's reactivity.

```typescript
function createReactiveStorageItem<T>(
	storageItem: WxtStorageItem<T>,
	initialValue: T,
) {
	let cached = initialValue;

	const subscribe = createSubscriber((update) => {
		const unwatch = storageItem.watch((newValue) => {
			cached = newValue;
			update();
		});
		return unwatch;
	});

	return {
		get value(): T {
			subscribe();
			return cached;
		},
		set value(v: T) {
			void storageItem.setValue(v);
		},
	};
}
```

`cached` is a plain `let`, not `$state`. `createSubscriber`'s `update()` is the sole reactivity signal. If you used `$state` here, both the proxy intercept and `update()` would mark dependents dirty. Svelte batches them into one render, so it's not a correctness issue, but having two reactivity owners makes the data flow harder to reason about. Since the whole point of this wrapper is that the external source owns the data, `createSubscriber` should own the reactivity too.

The setter in this minimal version doesn't touch `cached` directly. It calls `setValue()`, which writes to `chrome.storage`, which fires `chrome.storage.onChanged`, which triggers `.watch()`, which updates `cached` and calls `update()`. One loop, one direction: storage → watch → cache → getter. The setter never short-circuits it.

In practice you'll want **optimistic updates**: the UI should reflect the new value immediately rather than waiting for the round-trip through storage. The production version stores a reference to `update()` and uses it from the setter:

```typescript
function createReactiveStorageItem<T>(
	storageItem: WxtStorageItem<T>,
	initialValue: T,
) {
	let cached = initialValue;
	let notifyUpdate: (() => void) | undefined;

	const subscribe = createSubscriber((update) => {
		notifyUpdate = update;
		const unwatch = storageItem.watch((newValue) => {
			cached = newValue;
			update();
		});
		return () => {
			notifyUpdate = undefined;
			unwatch();
		};
	});

	return {
		get value(): T {
			subscribe();
			return cached;
		},
		set value(v: T) {
			cached = v;
			notifyUpdate?.();
			void storageItem.setValue(v);
		},
	};
}
```

The setter writes to `cached` and calls `notifyUpdate?.()` so the UI updates instantly. The async `setValue()` persists to storage, and `.watch()` fires later with the authoritative value, which wins in case of race conditions (e.g., another tab wrote concurrently). `notifyUpdate` is `undefined` when no reactive consumer is reading `.value`, so the `?.` call is safely a no-op. This breaks the pure "one direction" model, but the tradeoff is worth it: users see their changes reflected immediately instead of after a storage round-trip.

`initialValue` is passed in rather than fetched internally because `getValue()` is async. The caller awaits it before construction:

```typescript
const initial = await serverUrlItem.getValue();
const reactive = createReactiveStorageItem(serverUrlItem, initial);
reactive.value; // synchronous from here on
```

## Why This Isn't the Y.Doc Pattern

`saved-tab-state.svelte.ts` looks similar at first glance: it caches data from an external source and re-reads on change notifications. But Y.Doc's `getAllValid()` is synchronous. The observer callback can call `tabs = readAll()` and assign directly to `$state`. There's no async gap, so there's no need for `createSubscriber` to bridge anything. `$state` is both the cache and the signal.

That said, Y.Doc wrappers elsewhere in the codebase *do* use `createSubscriber`: not for the async bridge, but for lazy lifecycle management (Pattern D from the [companion article](./state-vs-createsubscriber-who-owns-reactivity.md#pattern-d-both-for-lazy-lifecycle)). The `saved-tab-state` case is simple because the observers are cheap and always wanted while the popup is open. If your Y.Doc observer opened a WebSocket or started polling, you'd want `createSubscriber`'s lazy start/stop even though reads are synchronous.

WXT storage reads are async, which breaks that simplicity. You can't call `await storageItem.getValue()` in a getter, so you maintain a separate cache. And since that cache is just a `let`, not `$state`, you need `createSubscriber` to provide the reactive signal that `$state` would have given you. The pattern exists because of the async boundary, and only because of it.

## Why Not `$effect`?

A simpler approach might seem obvious:

```typescript
function createReactiveStorageItem<T>(storageItem: WxtStorageItem<T>, initialValue: T) {
	let cached = $state(initialValue);
	$effect(() => {
		const unwatch = storageItem.watch((v) => {
			cached = v;
		});
		return unwatch;
	});
	return {
		get value() {
			return cached;
		},
		set value(v: T) {
			void storageItem.setValue(v);
		},
	};
}
```

This works, but has two downsides:

1. **Eager subscription.** `$effect` subscribes on mount even if nothing reads `.value`. `createSubscriber` only subscribes when a reactive consumer actually reads the getter. For `chrome.storage.watch()` this difference is negligible, but for expensive subscriptions (WebSocket, SSE, polling) it matters.

2. **Requires component context.** `$effect` must run during component initialization or inside `$effect.root`. `createSubscriber` works in plain `.svelte.ts` modules because it defers effect creation until a consumer reads the getter inside a reactive context. This makes `createSubscriber` wrappers more portable. You can export them from a module and use them anywhere without worrying about lifecycle.

For a settings page where values are always displayed, the `$effect` version would work fine in practice. `createSubscriber` is the better default because it composes more broadly.


## Further Reading

- [`$state` vs `createSubscriber`: Who Owns the Reactivity?](./state-vs-createsubscriber-who-owns-reactivity.md): the full decision framework with four patterns
- [Syncing External State with createSubscriber](./svelte-5-createsubscriber-pattern.md): the Y.Doc version of this pattern (sync reads, so `$state` alone)
- [How createSubscriber Works](./how-createsubscriber-works.md): the version signal and reference counting internals
