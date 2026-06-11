# `$state` Already Signals Svelte

`$state` already signals Svelte. The whole point of `createSubscriber` is to tell Svelte "hey, re-read this getter." But if the value lives in `$state`, Svelte already knows. Every `.push()`, `.filter()`, and reassignment goes through the proxy. Adding `createSubscriber` on top is a second signal to a system that's already listening.

## Two Signal Chains, One Job

Under the hood, `$state([])` wraps your array in a JavaScript `Proxy`. The proxy has `get` and `set` traps. Each array element gets its own `Source` signal stored in an internal `Map`, and the array itself has a version signal that increments on structural changes. When you call `pressedKeys.push(key)`, the `set` trap fires, the `Source` for that index updates, the proxy's version increments, and every `$effect` or `$derived` reading the array is marked dirty. That's the full re-render path, start to finish.

`createSubscriber` has its own separate signal chain. It allocates a `Source` initialized to `0`. When you call `update()`, it increments that source. When a getter calls `subscribe()`, it reads that source, registering a dependency. Calling `update()` bumps the counter, dependents re-run, getter re-reads.

Both paths end at the same place: Svelte marks dependent effects dirty and re-runs them. If you use both, you get two signal chains doing the same job. Svelte batches the updates into one render pass, so there's no visual bug. But two independent mechanisms are firing for every keystroke, every state mutation, every event callback. The `update()` calls are pure overhead.

```typescript
// Double-signaling: $state fires, then update() fires again
const subscribe = createSubscriber((update) => {
	window.addEventListener('keydown', (e) => {
		pressedKeys.push(key);  // $state proxy → Source update → effects dirty
		update();               // version signal → Source update → effects dirty (again)
	});
	return () => window.removeEventListener('keydown', handler);
});

get current() {
	subscribe();
	return pressedKeys;
}
```

## `createSubscriber` Is a Bridge, Not a Booster

`createSubscriber` exists for values that live outside Svelte's reactive graph entirely. `navigator.onLine` is a browser-managed boolean. `matchMedia.matches` lives on a `MediaQueryList`. A Yjs Y.Map fires `.observe()` callbacks. None of these are `$state`. Svelte has no proxy intercepting their changes, no `Source` signal tracking their mutations. Without `createSubscriber`, Svelte would read the getter once and never again because there's nothing to invalidate.

Svelte's own `MediaQuery` class demonstrates the pattern in its purest form:

```typescript
class MediaQuery {
	#query;
	#subscribe;

	constructor(query) {
		this.#query = window.matchMedia(query);
		this.#subscribe = createSubscriber((update) => {
			this.#query.addEventListener('change', update);
			return () => this.#query.removeEventListener('change', update);
		});
	}

	get current() {
		this.#subscribe();
		return this.#query.matches;  // Not $state. Bridge needed.
	}
}
```

No `$state` anywhere. The value comes from the browser API, and `createSubscriber`'s version signal is the only thing telling Svelte to re-read it. That's the intended use.

The moment you store the value in `$state`, the bridge becomes redundant. `$state` is already inside Svelte's reactive graph. Its proxy already fires signals on mutation. Adding `createSubscriber` wraps a signal in a signal.

## The Simplification

If `$state` owns the data, drop `createSubscriber` and let `$effect` handle the event listener lifecycle:

```typescript
export function createPressedKeys(options) {
	let pressedKeys = $state<string[]>([]);

	$effect(() => {
		const onKeydown = (e: KeyboardEvent) => {
			const key = e.key.toLowerCase();
			if (!pressedKeys.includes(key)) {
				pressedKeys.push(key);  // $state handles reactivity. Done.
			}
		};

		window.addEventListener('keydown', onKeydown);
		return () => window.removeEventListener('keydown', onKeydown);
	});

	return {
		get current() {
			return pressedKeys;  // No subscribe(). $state is enough.
		},
	};
}
```

`$effect` teardown gives you the same cleanup guarantee as `createSubscriber`'s stop function. When the component unmounts, the effect tears down, the listener is removed. The only thing you lose is lazy lifecycle management: `createSubscriber` delays attaching listeners until the first reactive consumer reads the getter. For cheap listeners like `keydown` on `window`, that laziness isn't buying you anything.

## When You Still Need `createSubscriber`

The decision comes down to one question: is `$state` the storage?

If yes, `$state` owns the reactivity. Events mutate the proxy, Svelte tracks it, components re-render. `createSubscriber` is redundant.

If no. The value lives in `navigator.onLine`, `matchMedia.matches`, a Yjs CRDT, a third-party database. Then `createSubscriber` is the only way Svelte knows to re-read your getter. That's what it was built for.

## Further Reading

For worked examples with `BroadcastChannel`, `IntersectionObserver`, `ResizeObserver`, and more, see [Using createSubscriber](./using-createsubscriber.md). For the full decision framework with four patterns, see [`$state` vs `createSubscriber`: Who Owns the Reactivity?](./state-vs-createsubscriber-who-owns-reactivity.md). For the version signal, reference counting, and `render_effect` internals, see [How createSubscriber Works](./how-createsubscriber-works.md).
