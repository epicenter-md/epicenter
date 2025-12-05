# You Might Not Need Proxy, especially if you know the keys in advance, since Object.defineProperty

I was wrapping a Yjs map to make it feel like a regular JavaScript object. My first instinct was Proxy. It's powerful, flexible, handles any property. But as I implemented it, something felt off. I was paying for features I didn't need.

Proxy intercepts everything. Every property access, every assignment, every operation. That's overhead. And in most TypeScript codebases, you know your properties upfront. Your data has a schema.

Here's what I realized: accessor descriptors handle most of what people use Proxy for. You define specific properties with get/set functions. That's it. No universal trap, no overhead on unknown properties, no mysterious behavior.

## Common Use Cases

Consider lazy loading. You want to load data only when accessed:

```typescript
// With Object.defineProperty
let _data = null;
Object.defineProperty(obj, 'data', {
  get() {
    if (!_data) _data = loadExpensiveData();
    return _data;
  }
});
```

Or validation on assignment:

```typescript
Object.defineProperty(user, 'age', {
  get() { return this._age; },
  set(value) {
    if (value < 0) throw new Error('Age must be positive');
    this._age = value;
  }
});
```

Or computed properties:

```typescript
Object.defineProperty(rect, 'area', {
  get() { return this.width * this.height; }
});
```

These patterns don't need Proxy. You know which properties need special behavior. Define them explicitly.

## Wrapping Yjs: A Real Comparison

Here's how you'd wrap a Yjs map with Proxy:

```typescript
function wrapYMap(ymap) {
  return new Proxy({}, {
    get(target, prop) { return ymap.get(prop); },
    set(target, prop, value) {
      ymap.set(prop, value);
      return true;
    }
  });
}
```

And with Object.defineProperty:

```typescript
type Schema = { name: string; count: number };

function wrapYMap<T extends Record<string, any>>(
  ymap: Y.Map<any>,
  keys: (keyof T)[]
): T {
  const wrapper = {} as T;
  for (const key of keys) {
    Object.defineProperty(wrapper, key, {
      get() { return ymap.get(key as string); },
      set(value) { ymap.set(key as string, value); }
    });
  }
  return wrapper;
}

const wrapped = wrapYMap<Schema>(myMap, ['name', 'count']);
```

The Object.defineProperty version requires knowing the keys upfront. But you usually do! TypeScript types already encode your schema. The explicit version is lighter, gives you autocomplete, and makes your intent clear.

## The Trade-offs

Proxy gives you flexibility. Any property works. You can trap delete, in, has operations. If you're building a generic library that truly doesn't know what properties exist, Proxy makes sense.

Object.defineProperty is explicit. You define specific properties with specific behavior. It's lighter weight, easier to debug, and clearer to readers. The constraint (knowing properties upfront) is often not a constraint at all.

## When You Actually Need Proxy

Reach for Proxy when:
- Property names are genuinely unknown at definition time
- You need to trap operations like delete or in
- You're building a generic abstraction over arbitrary objects
- You need to intercept prototype chain access

But for wrapping known data structures, implementing lazy loading, adding validation, or creating computed properties? Object.defineProperty with accessor descriptors is simpler and sufficient.

## The Lesson

Not every reactive property needs Proxy. When you know your schema, Object.defineProperty is lighter, clearer, and more explicit about what's actually happening. Save Proxy for when you genuinely need its power.
