# Promise.withResolvers() replaces the most common Promise anti-pattern

Normally when you create a promise, `resolve` and `reject` are trapped inside the constructor callback:

```typescript
let resolve;
const promise = new Promise<void>((r) => {
  resolve = r; // have to "escape" it via an outer variable
});
```

This is awkward. You declare a variable, leave it uninitialized, then assign it inside a callback just to use it outside. It's the closure escape hatch pattern, and it's everywhere: cancellable timeouts, deferred results, bridging event-based APIs to async/await.

The pattern is so common it got its own built-in. `Promise.withResolvers<T>()` returns all three pieces as a plain object:

```typescript
const { promise, resolve, reject } = Promise.withResolvers<void>();
```

That's it. The `promise` is pending. `resolve(value)` fulfills it. `reject(reason)` rejects it. They're the same `resolve`/`reject` you'd get inside `new Promise((resolve, reject) => ...)`, just handed to you directly without the closure.

## Where this shines

Anywhere you need to resolve a promise from outside the constructor. A cancellable sleep:

```typescript
function createSleeper(timeout: number) {
  const { promise, resolve } = Promise.withResolvers<void>();
  setTimeout(resolve, timeout);
  return { promise, wake: resolve };
}
```

`setTimeout` resolves it after the delay. But `wake` (which is just `resolve`) can resolve it early. Since `resolve` is idempotent: calling it a second time does nothing: both paths are safe. If the timeout fires after `wake()`, it's a no-op.

## One thing to know

`resolve` is idempotent. The first call wins. This matters when you have competing resolution paths (timeout vs manual wake, race conditions, etc.). You don't need guards or flags, just call `resolve` from wherever, and the first one to arrive settles the promise. Every subsequent call is silently ignored.
