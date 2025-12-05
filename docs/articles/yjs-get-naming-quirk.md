# The Curious Case of `.get()` in Yjs

I hit an interesting API quirk in Yjs that took me a moment to notice.

When you call `.getMap()` on a Yjs document, you're guaranteed to get a map back:

```typescript
const doc = new Y.Doc();
const myMap = doc.getMap('users'); // Always returns a YMap
```

If the map doesn't exist, Yjs creates it. So `.getMap()` is really `ensureMap()` in disguise.

But when you call `.get()` on an actual YMap, you might get undefined:

```typescript
const user = myMap.get('john'); // Might be undefined
```

Same `.get` prefix, completely different behavior. One creates if missing, the other tells you the truth.

The lesson: API naming is hard. When the same verb means "ensure exists" in one context and "return or undefined" in another, you've got a footgun waiting to happen.

Would `ensureMap()` and `getMap()` have been clearer? Probably. But here we are.
