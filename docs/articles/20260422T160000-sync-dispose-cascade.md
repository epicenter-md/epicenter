# Sync Dispose, Async Cleanup, Nobody Waits

When you close a document in Epicenter, the framework does one thing: it calls `ydoc.destroy()`. That's it. No awaits, no barriers, no promises. A single synchronous call, and every attachment tears itself down somewhere in the background.

This sounds irresponsible. It isn't. It's the right trade for the kind of thing a Y.Doc actually is. Let me walk through the design and the alternatives I rejected to get there.

## The shape

The `DocumentBundle` contract is three fields and nothing else:

```ts
export type DocumentBundle = {
  ydoc: Y.Doc;
  [Symbol.dispose](): void;
};
```

`[Symbol.dispose]` is synchronous. Every production bundle implements it as one line:

```ts
[Symbol.dispose]() { ydoc.destroy(); }
```

That's the whole teardown story at the bundle layer. The framework's `docs.close(id)` and `docs.closeAll()` methods call `[Symbol.dispose]` and return `void`. They don't return a promise. They don't wait for anything.

## Why `ydoc.destroy()` is enough

`Y.Doc.destroy()` does two things:

1. Sets `isDestroyed = true`. Subsequent destroys noop.
2. Emits a synchronous `'destroy'` event.

Every attachment in this codebase: `attach-indexed-db`, `attach-sync`, `attach-encryption`, `attach-kv`, `attach-sqlite`: registers a listener for that event at construction time:

```ts
export function attachIndexedDb(ydoc: Y.Doc): IndexedDbAttachment {
  const idb = new IndexeddbPersistence(ydoc.guid, ydoc);
  const { promise: whenDisposed, resolve: resolveDisposed } =
    Promise.withResolvers<void>();

  ydoc.once('destroy', async () => {
    try {
      await idb.destroy();  // ← async cleanup
    } finally {
      resolveDisposed();
    }
  });

  return { whenLoaded: idb.whenSynced.then(() => {}), whenDisposed, ... };
}
```

When `ydoc.destroy()` fires, every attachment's async `destroy` handler runs. Nothing at the framework level awaits the resulting promise. It just runs in the background. The IndexedDB connection closes, the WebSocket closes, the materializer drains.

## What "nobody awaits" actually means

Real scenarios, in order of frequency:

**Full page reload (99% of the cases that matter).** User clicks a link, the tab navigates, the JS runtime is wiped. Any in-flight IDB close or WS close is interrupted. The browser cleans up both anyway. Memory cost of the "forgotten" teardown: zero.

**SPA route change without reload.** Workspace unmounts, `docs.closeAll()` fires, route changes, `$effect` cleanups fire. IDB close completes in the background ~10ms later. WebSocket `onclose` fires after the handshake. Tens of KB of retained references until the next GC pass. Not catastrophic. Not even visible.

**Rapid close-then-reopen of the same doc (tests, mostly).** This is the only real hazard. A new `IndexeddbPersistence` opens the same database while the old one's `.destroy()` is mid-flight. Potential race on the connection handle.

**Mitigation for the last case:** the attachment exposes a `whenDisposed` promise. Tests that need the barrier reach for it explicitly:

```ts
docs.close('a');
await h.idb.whenDisposed;   // explicit, at the specific call site
const fresh = docs.open('a');
```

That's the whole opt-in story. Framework doesn't care about `whenDisposed`. It's a convention on the attachment layer for the narrow slice of callers that actually need it.

## The alternative I rejected: bundle-level teardown barrier

The earlier version of this API had the barrier baked into the bundle:

```ts
// before
export type DocumentBundle = {
  ydoc: Y.Doc;
  [Symbol.dispose](): void;
  whenDisposed?: Promise<void>;  // ← gone
};

async close(id) {
  disposeEntry(id, entry);
  await entry.bundle.whenDisposed;  // ← framework orchestrating teardown
}
```

Every builder composed `whenDisposed: Promise.all([idb.whenDisposed, sync.whenDisposed]).then(() => {})`. Every `close()` call awaited it. The framework guaranteed "teardown complete" as a contract.

The problem: that contract is a promise the framework can't actually keep cheaply. Teardown for a Y.Doc with persistence + sync can take hundreds of milliseconds in some conditions: a stuck WebSocket close handshake, an IDB transaction queued behind other work. Every `close()` becomes a multi-hundred-ms await. And 95% of callers don't care.

So: every caller paid for a guarantee they didn't need, on a promise the framework couldn't cheapen, to solve a problem only tests hit.

Invert it. Make the common case cheap. Put the barrier where the minority of callers who need it can reach for it.

## The alternative I also rejected: per-attachment `[Symbol.asyncDispose]`

A purer design would have each attachment expose `[Symbol.asyncDispose](): Promise<void>` directly, and the bundle's dispose would explicitly await each:

```ts
async [Symbol.asyncDispose]() {
  await Promise.all([
    idb[Symbol.asyncDispose](),
    sync[Symbol.asyncDispose](),
  ]);
  ydoc.destroy();
}
```

Recipe-style: you read the dispose function top-to-bottom and see exactly what's being torn down. No hidden cascade.

I walked away from this for one reason: it gives up the safety net. If anything in the codebase calls `ydoc.destroy()` outside the bundle's dispose path, whether a test, a crash handler, or a `finally` block, the explicit-call model leaks every attachment. The cascade model catches that case because attachments listen regardless.

`ydoc.destroy()` is the platform-native teardown signal. Our attachments respect it. That's idiomatic yjs. The explicit-call model is more "correct" in a platonic sense, but it trades a real property (safety) for a cosmetic one (readable recipe).

## Knowing better than yjs

Upstream `y-indexeddb` and `y-websocket` expect the caller to call `provider.destroy()` explicitly. They don't wire themselves to the Y.Doc destroy event. Our attachment wrappers do. That looks like going against the grain.

It isn't. Our wrappers *satisfy* yjs's contract (we do call `provider.destroy()` when appropriate): we just call it from a `ydoc.once('destroy')` handler instead of from our own code. That's a layering choice inside our application, not a monkey-patch on the yjs provider. The provider sees a normal `destroy()` call from its perspective.

Why this layering: a workspace framework has a lot of attachments per doc. Forcing every caller to track every attachment and dispose each one is the exact kind of ceremony frameworks exist to eliminate. Centralizing on `ydoc.destroy()` as the teardown trigger gives us one call site for the common case and preserves idempotent explicit-dispose for the uncommon one.

## 2026 follow-up: async barriers without losing the cascade

The current attachment shape keeps the cascade and exposes `whenDisposed` for callers that need an explicit barrier. The cleanup still starts from `ydoc.destroy()`. The returned promise is only a fence for tests, bundle `wipe()` methods, and daemon bundle shutdown.

That means the cascade resolves one promise field:

```ts
const { promise: whenDisposed, resolve: resolveDisposed } =
  Promise.withResolvers<void>();

ydoc.once('destroy', async () => {
  try {
    await provider.destroy();
  } finally {
    resolveDisposed();
  }
});

return {
  whenDisposed,
};
```

If `ydoc.destroy()` fires first, cleanup starts in the background. If a daemon or test later awaits `attachment.whenDisposed`, it awaits the same cleanup that the cascade already started. There is no attachment-level dispose function to call.

So the rejection in the original article was right about attachment-level async disposers, but too broad about barriers. Per-attachment `whenDisposed` is coherent because it is a promise field, not a second teardown trigger. What stays rejected is a bundle-level teardown barrier that every close path has to await.

## Cost accounting

What did we actually buy by making the framework barrier-free?

- Bundle contract is 2 fields instead of 4.
- Every builder's dispose is 1 line instead of 3.
- Every `close()` call loses an `await`.
- `closeAll()` is `void`, which means app-shutdown code is one line: `docs.closeAll()`. No awaiting, no error handling for a promise that can't meaningfully fail.

What did we give up?

- Tests that close-then-reopen the same id must explicitly await the attachment barrier. One extra line, at specific call sites, where the intent is visible.
- A conceptual "teardown is complete" guarantee that the framework no longer provides. It wasn't reliable anyway.

The framework now owns exactly three things: identity (keyed by doc id, verified by ydoc guid), refcount (open/close tracking across multiple consumers), and gcTime (optional grace period before eviction). Readiness is a builder convention. Disposal-barrier is an attachment convention. Everything else stays out.

This is the smallest coherent version of the primitive. Adding more would be adding opinion the framework doesn't have the standing to hold.
