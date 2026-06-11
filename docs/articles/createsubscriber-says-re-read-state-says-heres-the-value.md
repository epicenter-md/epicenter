# `createSubscriber` Says "Re-read." `$state` Says "Here's the Value."

Svelte 5 gives you two ways to bridge external sources into runes. The difference is one sentence: `createSubscriber` says "hey, something changed. Go re-read the source." `$state` says "here's the new value, I'll hold it for you."

That distinction decides which one you reach for.

## No Copy vs. Cached Copy

`createSubscriber` stores nothing. It holds a version counter internally and bumps it when the external source changes. Your getter re-reads the source every time:

```typescript
import { createSubscriber } from 'svelte/reactivity';
import { on } from 'svelte/events';

class MediaQuery {
  #query;
  #subscribe;

  constructor(query: string) {
    this.#query = window.matchMedia(`(${query})`);
    this.#subscribe = createSubscriber((update) => {
      const off = on(this.#query, 'change', update);
      return off;
    });
  }

  get current() {
    this.#subscribe();          // "track me"
    return this.#query.matches; // reads the source directly, no copy
  }
}
```

`$state` creates a reactive copy. External events push new values into it:

```typescript
class MediaQuery {
  #query;
  current = $state(false);

  constructor(query: string) {
    this.#query = window.matchMedia(`(${query})`);
    this.current = this.#query.matches;

    $effect(() => {
      const off = on(this.#query, 'change', () => {
        this.current = this.#query.matches; // copies into $state
      });
      return off;
    });
  }
}
```

Same result, different ownership. The first has zero shadow state. The second maintains a mirror that can drift if you miss an event.

## The Comparison

|                           | `createSubscriber`                | `$state` + subscribe           |
| ------------------------- | --------------------------------- | ------------------------------ |
| Value storage             | None. Reads source directly        | Duplicates into Svelte proxy   |
| When subscription starts  | Lazy. First effect that reads      | Eager. When `$effect` runs      |
| When subscription stops   | Auto. Last dependent effect dies   | Manual: `$effect` cleanup      |
| Memory overhead           | One integer (version counter)     | Full proxy wrapper             |
| Notification model        | Binary "dirty" signal             | Full value propagation         |
| SSR behavior              | No-op (safe)                      | Allocates state (wasteful)     |

## When Each One Wins

`createSubscriber` is the right call when the source is readable on demand. Browser APIs like `matchMedia`, `navigator.onLine`, `document.visibilityState`, `localStorage`. You don't need to cache what you can always re-read.

`$state` is the right call when the source is push-only. You can't "re-read" which keys are pressed from any browser API; you have to track `keydown`/`keyup` events and accumulate them. The value doesn't exist anywhere except in your state.

Here's how Whispering's `createPressedKeys` handles this:

```typescript
export function createPressedKeys({ preventDefault = true }) {
  let pressedKeys = $state<KeyboardEventSupportedKey[]>([]);

  $effect(() => {
    const keydown = on(window, 'keydown', (e) => {
      if (!pressedKeys.includes(key)) {
        pressedKeys.push(key); // mutation. Needs the $state proxy
      }
    });

    const keyup = on(window, 'keyup', (e) => {
      pressedKeys = pressedKeys.filter((k) => k !== key); // reassignment
    });

    return () => { /* cleanup */ };
  });

  return {
    get current() { return pressedKeys; },
  };
}
```

Array mutations (`.push()`, `.filter()`, reassignment) signal Svelte through the proxy. Event listeners are cheap and always wanted while the component is mounted. `createSubscriber` would be wrong here because there's no external source to re-read; the state IS the source.

## The Decision

```
External source readable on demand?
├── YES → createSubscriber (notification-only, read from source)
└── NO (push-only / accumulation needed)
     └── $state (store the value yourself)
```

Svelte's [best practices page](https://svelte.dev/docs/svelte/best-practices#Observe-external-sources) makes the recommendation explicit: "If you need to observe something external to Svelte, use `createSubscriber`."

For the full decision framework with worked examples (WebSocket lifecycle, browser extensions, third-party libraries), see [`$state` vs `createSubscriber`: Who Owns the Reactivity?](./state-vs-createsubscriber-who-owns-reactivity.md). For the version signal internals, see [How createSubscriber Works](./how-createsubscriber-works.md).
