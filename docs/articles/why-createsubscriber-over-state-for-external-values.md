# You Can Use `$state` Instead of `createSubscriber`, So Why Use `createSubscriber`?

You can use `$state` for `navigator.online`. It would work:

```typescript
let online = $state(navigator.online);
window.addEventListener('online', () => { online = true; });
window.addEventListener('offline', () => { online = false; });
```

But now `online` is a copy. A shadow variable you have to keep in sync with the browser's actual value. For `navigator.online` it's trivial. Two events, two assignments, done. But the `createSubscriber` version has no copy at all:

```typescript
get online() {
	this.#subscribe();
	return navigator.online;  // Always the truth. No variable to drift.
}
```

The getter reads fresh from the source every single time. Zero shadow state. Nothing can be stale.

That's the real reason: not performance, not lifecycle. No copy to keep in sync. The external source already has the value. Why maintain a mirror of it? `createSubscriber` lets you read the source directly and just tells Svelte when to re-read. For read-only external state, that's strictly simpler than maintaining a `$state` shadow.

## The Shadow Copy Problem

`$state` is a proxy. When you write `let matches = $state(query.matches)`, you're creating a reactive variable that Svelte tracks. But you're also creating a second source of truth. The browser has the real value; your `$state` variable has a copy. Now you need event listeners to keep them in sync, and if you miss an edge case. An event you didn't anticipate, a race condition during initialization. The copy drifts.

For `navigator.online`, there are exactly two events (`online`, `offline`) and the value is a boolean. Hard to get wrong. For `matchMedia`, there's one `change` event. Still manageable. But the pattern doesn't scale gracefully. The more complex the external source, the more event handlers you need to keep your shadow copy accurate, and the more opportunities for drift.

`createSubscriber` sidesteps the problem entirely. There is no copy. The getter reads from the source. The source is always right.

## The Lazy Lifecycle Bonus

The lazy lifecycle (start/stop reference counting) is the bonus on top, and it only matters for expensive subscriptions like WebSocket or SSE where you genuinely don't want the connection open unless someone's reading:

```typescript
class LivePrices {
	#subscribe;
	#prices = new Map<string, number>();

	constructor() {
		this.#subscribe = createSubscriber((update) => {
			// WebSocket ONLY opens when a component reads .prices
			const ws = new WebSocket('wss://prices.example.com/stream');
			ws.onmessage = (e) => {
				const { symbol, price } = JSON.parse(e.data);
				this.#prices.set(symbol, price);
				update();
			};
			// WebSocket CLOSES when no components read .prices
			return () => ws.close();
		});
	}

	get prices() {
		this.#subscribe();
		return this.#prices;
	}
}
```

For cheap listeners like DOM events, this laziness isn't buying you anything. Register eagerly, who cares. But for a WebSocket, a database cursor, an SSE stream, or a polling interval, you want the resource active only when someone is looking at the data. `createSubscriber`'s reference counting gives you that for free.

## When `$state` Is the Right Call

If the external source doesn't have a synchronous read API, such as `chrome.storage`, IndexedDB, or anything that returns a promise, you can't read from the source in a getter. You need a cache. And if you need a cache, `$state` is a fine choice for that cache (though a plain `let` with `createSubscriber` as the sole reactivity owner is simpler; see [createSubscriber Cache for Async External State](./createsubscriber-cache-for-async-external-state.md)).

And if your event handlers are already mutating `$state` because the value is state you own. Not a mirror of something external. Then `$state` is all you need. No bridge required. See [`$state` Already Signals Svelte](./state-already-signals-svelte.md) for why adding `createSubscriber` on top of `$state` is redundant.

## Further Reading

For worked examples with `BroadcastChannel`, `IntersectionObserver`, `ResizeObserver`, and more, see [Using createSubscriber](./using-createsubscriber.md). For the full decision framework, see [`$state` vs `createSubscriber`: Who Owns the Reactivity?](./state-vs-createsubscriber-who-owns-reactivity.md). For the version signal internals, see [How createSubscriber Works](./how-createsubscriber-works.md).
