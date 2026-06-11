# How `createSubscriber` Works

`createSubscriber` shipped in Svelte 5.7.0 and it's one of the most underappreciated tools in the reactivity system. It solves a specific problem: connecting external event sources to Svelte's reactive graph without `$state` as an intermediary. To use it well, you need to understand what it's actually doing.

## The Problem It Solves

Svelte's reactivity is pull-based. When you write `$state(0)` and read it in a template, Svelte tracks the read and knows to re-render when the value changes. But what about a value that lives outside Svelte entirely? A `window.matchMedia` result. A Yjs CRDT. A database cursor. These systems have their own change notification mechanisms (`addEventListener`, `observe`, `subscribe`) that Svelte knows nothing about.

You need a bridge: something that says "Svelte, this external thing changed. Please re-read my getter."

That bridge is `createSubscriber`.

## The API

```typescript
import { createSubscriber } from 'svelte/reactivity';

const subscribe = createSubscriber((update) => {
	// Called when first reactive consumer appears.
	// Set up your external listener here.
	// Call update() whenever the external source changes.

	return () => {
		// Called when last reactive consumer disappears.
		// Clean up your external listener here.
	};
});
```

`createSubscriber` returns a function. Call that function inside a getter to make the getter reactive. The `start` callback runs lazily. Only when at least one reactive context is reading the value.

## What Happens Under the Hood

The implementation is ~30 lines. Here's the mental model:

```
createSubscriber(start)
  │
  ├── version = source(0)     ← invisible signal, starts at 0
  ├── subscribers = 0          ← reference counter
  ├── stop = undefined         ← cleanup function from start()
  │
  └── returns subscribe()
        │
        ├── if not in reactive context → do nothing
        │
        └── if in reactive context:
              ├── get(version)           ← register dependency
              ├── create render_effect:
              │     ├── if subscribers === 0 → call start(update)
              │     ├── subscribers++
              │     └── teardown:
              │           ├── subscribers--
              │           └── if subscribers === 0 → call stop()
              └── done
```

Three moving parts: a version signal, a subscriber count, and a start/stop lifecycle.

## The Version Signal

`createSubscriber` allocates a single Svelte `source` initialized to `0`. This is the invisible reactive signal that makes everything work. Two things interact with it:

When a getter calls `subscribe()`, it runs `get(version)`. This registers the current reactive context (an `$effect`, `$derived`, or template expression) as a dependency of `version`. Svelte now knows: "if version changes, re-run this effect."

When the external system fires and your code calls `update()`, it runs `increment(version)`. This bumps the signal from 0 to 1, then 1 to 2, and so on. Every dependent effect re-runs, which means every getter that called `subscribe()` gets re-read.

The version number itself is meaningless. It's just a counter that increments to trigger invalidation. Svelte doesn't care that version went from 7 to 8; it only cares that it changed.

## Lazy Start, Lazy Stop

The `start` callback doesn't run when you call `createSubscriber`. It runs when the first reactive consumer appears. Specifically, when `subscribers` goes from 0 to 1. This is the "lazy" part.

```typescript
const mq = new MediaQuery('(prefers-color-scheme: dark)');
// At this point, NO event listener is registered on matchMedia.
// start() hasn't run. Nothing is subscribed.

// Later, in a component template:
// <p>{mq.current ? 'dark' : 'light'}</p>
// NOW start() runs, because a template expression read mq.current,
// which called subscribe(), which saw subscribers === 0.
```

The cleanup function (returned by `start`) runs when the last consumer disappears. When `subscribers` goes from 1 to 0. If a component using the `MediaQuery` unmounts, and no other component reads `.current`, the `change` listener is removed from `matchMedia`. If a new component later reads `.current`, `start` runs again.

This is reference counting. Multiple effects can depend on the same `createSubscriber` instance. The external subscription stays alive as long as at least one consumer exists.

## The render_effect

Each consumer gets its own `render_effect` inside `subscribe()`. This effect does two things: increment the subscriber count on creation, and decrement it on teardown. The teardown uses `queue_micro_task` to avoid tearing down and immediately re-subscribing during synchronous component re-renders.

The `start` callback itself runs inside `untrack()`. This prevents any reactive reads inside `start` from becoming dependencies of the `render_effect`. Your setup code can read whatever it needs without accidentally creating circular dependencies.

## How Svelte Uses It Internally

Svelte's own codebase has two uses that demonstrate the pattern perfectly.

`MediaQuery` bridges `window.matchMedia`:

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
		return this.#query.matches; // read directly from matchMedia, no $state
	}
}
```

No `$state` anywhere. The value (`this.#query.matches`) is read directly from the browser API on every access. `createSubscriber` just tells Svelte when to re-read it. This is the purest form of the pattern: external state, no shadow copy, event-driven invalidation.

`fromStore` adapts Svelte 4 stores to Svelte 5 runes:

```typescript
function fromStore(store) {
	let value = store_get(store);

	const subscribe = createSubscriber((update) => {
		return store.subscribe((v) => {
			value = v;
			update();
		});
	});

	return {
		get current() {
			subscribe();
			return value;
		},
	};
}
```

This one does use a local `value` variable (not `$state`, just a plain `let`) as a shadow copy, updated inside the store's subscription callback. `update()` tells Svelte to re-read the getter, which returns the now-updated `value`.

Both follow the same shape: set up a listener in `start`, call `update` when something changes, clean up in the returned function, expose a getter that calls `subscribe()`.

## Best Practices

**Always call `subscribe()` inside a getter, not in the constructor.** The getter is what components read. If you call `subscribe()` during construction, you're subscribing before any reactive context exists: `effect_tracking()` returns `false`, and `subscribe()` silently does nothing.

```typescript
// Wrong: subscribe() in constructor does nothing
class Bad {
	constructor() {
		this.#subscribe = createSubscriber(/* ... */);
		this.#subscribe(); // effect_tracking() is false here. No-op.
	}
}

// Right: subscribe() in getter, called during render
class Good {
	get value() {
		this.#subscribe(); // effect_tracking() is true during render
		return this.#computeValue();
	}
}
```

**Return a cleanup function from `start`.** If you don't, the external listener leaks when all consumers disappear. The whole point of `createSubscriber` managing the lifecycle is that it can clean up for you. If you skip the cleanup, you lose the main benefit over just registering listeners manually.

**Don't call `update()` if you also mutate `$state`.** If your `start` callback mutates a `$state` variable and also calls `update()`, you're signaling the change twice. `$state` mutation already triggers re-renders for its consumers. `update()` would additionally invalidate anything depending on the version signal. Pick one owner for the reactivity. If you're using `$state` as a shadow copy, the `$state` mutation is sufficient and `update()` is redundant. If you're reading directly from the external source (like `MediaQuery` does), `update()` is the only signal mechanism.

**Use it for expensive subscriptions that should be lazy.** If subscribing costs nothing (like adding a DOM event listener), you might not need `createSubscriber` at all. Just register the listener and mutate `$state` directly. `createSubscriber` shines when the act of subscribing is expensive: opening a WebSocket, starting a polling interval, connecting to a database. The lazy start/stop lifecycle means you only pay that cost when someone is actually reading the value.

**On the server, `createSubscriber` is a no-op.** The returned `subscribe` function does nothing during SSR. There are no reactive contexts, no effects, no consumers. If you're reading from an external source during SSR, you'll get the initial value from your getter but no reactivity. Plan accordingly.

## When You Don't Need It

If your external events mutate `$state` directly, skip `createSubscriber`. The `$state` proxy already handles reactivity. You'd be adding a lifecycle manager for a subscription that doesn't need lifecycle management. Browser event listeners, cheap callbacks, module-level subscriptions that should always be active. These don't benefit from lazy start/stop semantics.

## Further Reading

For a consumer-focused guide with practical examples (BroadcastChannel, IntersectionObserver, and more), see [Using createSubscriber](./using-createsubscriber.md). For choosing between `$state` and `createSubscriber` when both could work, see [`$state` vs `createSubscriber`: Who Owns the Reactivity?](./state-vs-createsubscriber-who-owns-reactivity.md). For a Yjs-specific example with shadow state and bidirectional sync, see [Syncing External State with createSubscriber](./svelte-5-createsubscriber-pattern.md).
