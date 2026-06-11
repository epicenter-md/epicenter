# `$state` vs `createSubscriber`: Who Owns the Reactivity?

Svelte 5 gives you two ways to tell the framework "something changed, re-render." Most of the time you only need one. Picking the wrong one adds complexity for no benefit; picking the right one makes external integrations trivially simple. The distinction comes down to a single question: who owns the reactivity?

## The Core Question

`$state` and `createSubscriber` are both mechanisms for signaling change. They serve different purposes:

| Mechanism          | What it does                                        |
| ------------------ | --------------------------------------------------- |
| `$state`           | "This value changed. Re-render whoever reads it."   |
| `createSubscriber` | "Is anyone listening? Should I bother subscribing?" |

If your external events directly mutate `$state`, the reactivity is already handled. Adding `createSubscriber` on top is redundant. If your value is computed on-read from an external source with no `$state` involved, `createSubscriber` is the only way Svelte knows to re-read the getter.

## Pattern A: `$state` Owns Reactivity

When external events mutate stored state, `$state` handles everything:

```typescript
class TabStore {
	#tabs = $state<Tab[]>([]);

	constructor() {
		this.#seed();

		browser.tabs.onCreated.addListener((tab) => {
			this.#tabs.push(tab); // $state proxy intercepts this. Svelte knows.
		});

		browser.tabs.onRemoved.addListener((tabId) => {
			this.#tabs = this.#tabs.filter((t) => t.id !== tabId); // Reassignment. Svelte knows.
		});
	}

	async #seed() {
		const windows = await browser.windows.getAll({ populate: true });
		this.#tabs = windows.flatMap((w) => w.tabs ?? []);
	}

	get tabs() {
		return this.#tabs; // Reactive because #tabs is $state
	}
}
```

The browser event listener is just a plain callback that happens to mutate reactive state. `$state` is a proxy. It intercepts `.push()`, index assignment, property mutation, reassignment. Every component reading `this.#tabs` already gets re-rendered when it changes. No `createSubscriber` needed.

## Pattern B: No `$state`, Only `createSubscriber`

When the value is computed fresh on every read and nothing is stored:

```typescript
class Clock {
	#subscribe;

	constructor() {
		this.#subscribe = createSubscriber((update) => {
			const interval = setInterval(update, 1000);
			return () => clearInterval(interval);
		});
	}

	get now() {
		this.#subscribe(); // Registers this getter as a reactive dependency
		return new Date(); // Computed fresh. Not stored in $state.
	}
}
```

There is no `$state` here. `new Date()` is computed on read. Without `createSubscriber`, Svelte would read `now` once and never again because there's no tracked signal to invalidate. `createSubscriber` creates an invisible version signal internally (`source(0)` that increments on each `update()` call). Reading `this.#subscribe()` in the getter tells Svelte "track this." Calling `update()` from the interval tells Svelte "re-read the getter."

## Pattern C: External State You Can't Wrap

The more realistic use case for `createSubscriber` alone: a third-party library managing its own state.

```typescript
import { externalDB } from 'some-library';

class DBView {
	#subscribe;

	constructor() {
		this.#subscribe = createSubscriber((update) => {
			const unsub = externalDB.onChange(() => update());
			return unsub;
		});
	}

	get records() {
		this.#subscribe();
		return externalDB.getAll(); // Reads from EXTERNAL state, not $state
	}
}
```

You can't make `externalDB` use `$state`: it's not your code. `createSubscriber` bridges the gap: when the DB emits a change event, Svelte re-reads the getter.

## Pattern D: Both, For Lazy Lifecycle

This is the subtle case. You use `$state` for reactivity and `createSubscriber` for subscription lifecycle management:

```typescript
class LivePrices {
	#prices = $state<Map<string, number>>(new Map());
	#subscribe;

	constructor() {
		this.#subscribe = createSubscriber((update) => {
			// WebSocket ONLY opens when a component reads .prices
			const ws = new WebSocket('wss://prices.example.com/stream');

			ws.onmessage = (e) => {
				const { symbol, price } = JSON.parse(e.data);
				this.#prices.set(symbol, price); // $state handles reactivity
				// update() not needed here: $state already triggers re-render
			};

			// WebSocket CLOSES when no components read .prices
			return () => ws.close();
		});
	}

	get prices() {
		this.#subscribe(); // Controls WebSocket lifecycle, not reactivity
		return this.#prices;
	}
}
```

`createSubscriber`'s `start` function is lazy. It only fires when subscribers go from 0 to 1. The cleanup fires when the last consumer stops reading. So if a component conditionally shows a price widget, the WebSocket opens when it appears and closes when it disappears.

The `$state` mutation handles all the reactivity. `createSubscriber` answers a different question entirely: "should this expensive resource even be active right now?"

## When You Don't Need `createSubscriber`

Browser extension event listeners are cheap to register. No network connections, no resources to manage. They're always wanted while the popup is open, and they're automatically cleaned up when the popup closes (the entire JS context dies). There's no expensive subscription to lazily manage.

For a browser tab manager, the answer is Pattern A:

```typescript
class BrowserTabStore {
	#tabs = $state<Tab[]>([]);

	constructor() {
		this.#seed();
		browser.tabs.onCreated.addListener((tab) => {
			/* mutate $state */
		});
		browser.tabs.onRemoved.addListener((tabId) => {
			/* mutate $state */
		});
		browser.tabs.onUpdated.addListener((_id, _info, tab) => {
			/* mutate $state */
		});
	}

	get tabs() {
		return this.#tabs;
	}
}
```

Register on construction. Let popup destruction handle cleanup. `$state` handles the rest.

## The Decision Table

| Scenario                                      |    `$state`     | `createSubscriber` |
| --------------------------------------------- | :-------------: | :----------------: |
| Events mutate stored state                    |       ✅        |         -          |
| Value computed on-read, no storage            |        -        |         ✅         |
| External library state you can't proxy        |        -        |         ✅         |
| Expensive subscription, lazy lifecycle needed | ✅ (reactivity) |   ✅ (lifecycle)   |
| Cheap event listeners, always wanted          |       ✅        |         -          |

`$state` answers "this value changed." `createSubscriber` answers "is anyone listening, and should I bother subscribing?" Most of the time you need one or the other. When you need both, they serve distinct roles that don't overlap.

For more worked examples. ResizeObserver, network status, SSE, RxJS, page visibility, and others. See [Using createSubscriber](./using-createsubscriber.md).

## Further Reading

For a practical guide on using `createSubscriber` with real browser APIs, see [Using createSubscriber](./using-createsubscriber.md). For the version signal, reference counting, and `render_effect` internals, see [How createSubscriber Works](./how-createsubscriber-works.md). For a Yjs-specific example with shadow state and bidirectional sync, see [Syncing External State with createSubscriber](./svelte-5-createsubscriber-pattern.md).
