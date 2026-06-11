# A Reactive Touch With No Consumer Is a Missing Subscription

**TL;DR**: **If you're reading a reactive value on its own line just to wake up `$effect`, the producer is missing a subscription API.** Add one. The framework's dependency tracker is not a pubsub bus.

---

I was writing this:

```svelte
$effect(() => {
  auth.token;     // touched, not used: wake signal
  sync.reconnect();
});
```

What that code actually means is this:

```ts
auth.onTokenChange(() => sync.reconnect());
```

And the fact that I couldn't just write the second version told me something. I'd built a Svelte-specific adapter on top of an auth layer that was also Svelte-specific. The fix wasn't to keep patching at the Svelte level. I needed a lower-level primitive written in plain JavaScript, with imperative `on*` callbacks, and the Svelte reactive layer should have been a thin wrapper over that.

## Why the pattern appears

Reactive getter APIs. Svelte runes, Vue refs, MobX observables. Expose state as a value you read. You access `auth.token` and the framework records that read, tracks the dependency, and wakes up any effects that consumed it. That model is perfect for templates and derived values.

But sometimes you don't want the value. You want to be told "the token changed" so you can do something imperative: kick a reconnect, invalidate a cache, write to a log. You need a subscription, not a getter.

When the producer only exposes a reactive getter and no subscription API, you end up doing this:

```ts
$effect(() => {
  auth.token;        // dependency established, value discarded
  doSomethingImperative();
});
```

The `$effect` is filling a gap left by the publisher. That gap has a name: a missing `onTokenChange` method.

## The tell

The dead read is the tell. A bare property access with no consumer. No assignment, no argument, no template binding. It has no meaning outside of a framework-aware reader. Someone new to the codebase can't tell what it does. A linter might even flag it as unused.

```ts
// ❌ Framework plumbing pretending to be business logic
$effect(() => {
  auth.token;
  sync.reconnect();
});

// ✅ Business logic that happens to run in Svelte
$effect(() => {
  const cleanup = auth.onTokenChange(() => sync.reconnect());
  return cleanup;
});
```

Even the Svelte version is cleaner once the subscription exists. The `$effect` sets up and tears down the callback. It doesn't pretend to consume a value it doesn't need.

## The real fix is upstream

The subscriber isn't the problem. The publisher is.

`auth` shouldn't expose only `auth.token`. It should expose both: a reactive getter for templates, and an imperative subscription for callbacks. Different use cases, different APIs.

```ts
type AuthCore = {
  // imperative read: works anywhere
  getToken(): string | null;

  // reactive read: for templates and derived state
  get token(): string | null;

  // imperative subscribe: for side effects
  onTokenChange(fn: (token: string | null) => void): () => void;
};
```

The reactive getter becomes a thin Svelte layer on top of the imperative core. Not a replacement for the subscription API. You implement `onTokenChange` once, and both templates and effects can wire up correctly.

## When a reactive touch is fine

The smell is specifically the *discarded* read. When you use the value, you're fine.

```ts
// ✅ Fine: you need the value
$effect(() => {
  console.log('token changed to:', auth.token);
});

// ✅ Fine: deriving something from the value
const header = $derived(
  auth.token ? `Bearer ${auth.token}` : null
);

// ❌ Smell: the value is irrelevant, only the change matters
$effect(() => {
  auth.token;
  sync.reconnect();
});
```

Rule of thumb: if removing the reactive read would break the logic, it belongs there. If removing it would only stop triggering the effect, it's a notification pretending to be a read.

## The same shape in other frameworks

This isn't Svelte-specific.

```ts
// React: deps array is the side channel
useEffect(() => {
  sync.reconnect();
}, [authToken]);  // ← touched for tracking, not used in the body

// Vue: honest separation
watch(() => auth.token, () => sync.reconnect());

// MobX: most explicit: splits "what to observe" from "what to do"
reaction(
  () => auth.token,
  () => sync.reconnect()
);
```

Vue and MobX force you to separate the read expression from the action. Different syntactic homes. React's deps array keeps them close but still splits them. Svelte 5 is the sneakiest: the bare `auth.token;` line looks like dead code.

MobX's `reaction` is probably the most honest shape. It names what it's doing: observe this expression, run this action when it changes. That's a subscription with extra steps.

## One table

| Pattern | Works without framework | Meaning is self-evident | Can be tested in Node |
| --- | --- | --- | --- |
| `$effect(() => { auth.token; fn(); })` | No | No | No |
| `auth.onTokenChange(() => fn())` | Yes | Yes | Yes |
| `reaction(() => auth.token, fn)` | Partial (MobX only) | Yes | Yes |

The framework-idiomatic version loses on every axis that matters outside of Svelte components.

## The golden rule

**If the reactive read has no consumer, the publisher is missing an event.**

Don't paper over it with `$effect`. Add the subscription method. Your components get simpler, your tests get easier, and the code says what it does.
