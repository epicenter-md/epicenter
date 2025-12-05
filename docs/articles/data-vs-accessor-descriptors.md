# Data Descriptors vs Accessor Descriptors

When you use `Object.defineProperty()` or `Object.defineProperties()`, you're creating a property descriptor. There are two types, and they're mutually exclusive.

## Data Descriptor: Storing a Value

A data descriptor stores an actual value and controls how that value can be accessed and modified.

```javascript
Object.defineProperty(obj, 'count', {
  value: 0,
  writable: true,
  enumerable: true,
  configurable: true,
});

obj.count; // 0
obj.count = 5; // Works because writable: true
```

Properties:
- `value`: The actual value to store
- `writable`: Whether the property can be changed
- `enumerable`: Whether it shows up in `for...in` loops
- `configurable`: Whether it can be deleted or reconfigured

## Accessor Descriptor: Running Functions

An accessor descriptor runs functions when you read or write the property. Instead of storing a value directly, you define what happens.

```javascript
const internal = {};

Object.defineProperty(obj, 'name', {
  get: () => internal.name?.toUpperCase(),
  set: (value) => internal.name = value,
  enumerable: true,
  configurable: true,
});

obj.name = 'alice';
obj.name; // 'ALICE' (getter ran and transformed it)
```

Properties:
- `get`: Function called when reading the property
- `set`: Function called when writing the property
- `enumerable`: Whether it shows up in `for...in` loops
- `configurable`: Whether it can be deleted or reconfigured

## They're Mutually Exclusive

You cannot mix them in a single descriptor:

```javascript
// This throws an error
Object.defineProperty(obj, 'bad', {
  value: 42,
  get: () => 42,  // ERROR: can't have both
});
```

JavaScript won't let you define a property with both a stored value and getter/setter functions. They represent fundamentally different approaches.

## Why Accessor Descriptors Are Powerful

The real power emerges when you're wrapping an external data structure. Instead of exposing the raw object, you can create properties that intercept access and delegate to the underlying system.

### Example: Wrapping a Yjs Map

Imagine you have a Yjs map (a collaborative data structure) and you want to expose it as a normal JavaScript object:

```javascript
function wrapYMap(ymap) {
  const obj = {};

  const descriptors = Object.fromEntries(
    Array.from(ymap.keys()).map((key) => [
      key,
      {
        get: () => ymap.get(key),           // Read from Yjs
        set: (value) => ymap.set(key, value), // Write to Yjs
        enumerable: true,
        configurable: true,
      },
    ]),
  );

  Object.defineProperties(obj, descriptors);
  return obj;
}

const wrapped = wrapYMap(ymap);
wrapped.title = 'New Title'; // Writes to Yjs automatically
console.log(wrapped.title);   // Reads from Yjs automatically
```

From the outside, `wrapped` looks like a normal object. But every property access is actually lazily talking to the Yjs map.

### Why This Matters

Without accessor descriptors, you'd have to choose between:
1. Exposing the raw Yjs API: `ymap.get('title')`, `ymap.set('title', val)` (awkward)
2. Making a copy of the data: `{ title: ymap.get('title') }` (stale, doesn't sync changes)
3. Writing getters manually: repetitive and error-prone

With accessor descriptors, you get:
- Natural JavaScript syntax: `obj.title = 'New Title'`
- Live binding to the source: changes to Yjs show up immediately
- Transparent delegation: code using `obj` doesn't know or care it's backed by Yjs

## When to Use Each

**Use data descriptors** when you're storing static values:
```javascript
Object.defineProperty(config, 'apiUrl', {
  value: 'https://api.example.com',
  writable: false, // Make it read-only
});
```

**Use accessor descriptors** when you want custom logic on access:
- Wrapping another data structure (Yjs, databases, APIs)
- Computing values on the fly
- Validating or transforming data
- Triggering side effects on change
- Creating computed properties

The pattern is: whenever you see `.something` and you want it to do more than just return a stored value, that's when accessor descriptors shine.
