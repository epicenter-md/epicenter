# The Accessor Pattern: Why Your Svelte 5 Queries Need Functions, Not Values

You change `recordingId` from `'abc'` to `'xyz'`, but the audio player doesn't update. The UI is stuck showing the old recording. You've just hit the accessor pattern problem.

Here's what happened: you passed a value directly to your query instead of a function that returns the value. This broke Svelte 5's reactivity chain, and now your component can't track changes.

## The Pattern

When using TanStack Query with Svelte 5, you need to pass accessor functions (getters) instead of values directly:

```typescript
// ❌ WRONG: Passing value directly
const query = createQuery(
  rpc.db.recordings.getById(recordingId).options
);

// ✅ CORRECT: Passing accessor function
const query = createQuery(
  rpc.db.recordings.getById(() => recordingId).options
);
```

That `() => recordingId` is not just syntax ceremony. It's the boundary that preserves reactive tracking.

## Why Accessor Functions?

Svelte 5 uses signals for reactivity. When you create `$state`, you're creating a signal that tracks subscriptions.

```typescript
let recordingId = $state('abc');  // This creates a signal
```

The problem is what happens when you pass this to a function.

### What's Really Happening: State Variables Are Getters

Here's the key insight: when you use `$state` in Svelte 5, you're not creating a simple variable. You're creating a getter function that Svelte can track.

Think about JavaScript object getters:

```javascript
const counter = {
  _count: 0,
  get count() {
    return this._count;
  }
};

// Looks like property access:
console.log(counter.count);
// But actually calls the getter function behind the scenes
```

Svelte 5's `$state` works the same way. When you write:

```typescript
let recordingId = $state('abc');
```

Accessing `recordingId` looks like reading a variable, but it's actually calling a getter function. This is how Svelte tracks which components depend on this value. Every time you read `recordingId`, Svelte can register: "This code depends on recordingId's current value."

That's why `() => recordingId` works. You're creating a lazy function that:
1. Gets called by TanStack Query when it needs the value
2. Calls Svelte's getter (by accessing `recordingId`)
3. Establishes a reactive subscription in the process

The accessor function `() => recordingId` is essentially saying: "Don't give me the value now. Give me a way to call the getter later, so Svelte can track the subscription when you do."

Without the accessor wrapper, you'd be passing the result of calling the getter (the value `'abc'`), not the getter itself. The reactive tracking chain would be broken.

### Passing Values Directly Breaks Reactivity

```typescript
// This evaluates recordingId RIGHT NOW
const query = createQuery(
  rpc.db.recordings.getById(recordingId).options
);
```

What actually runs:

```typescript
// Step 1: Svelte evaluates recordingId (current value: 'abc')
// Step 2: Passes 'abc' to getById
// Step 3: Creates query with key ['db', 'recordings', 'abc']
```

Later, when you update `recordingId`:

```typescript
recordingId = 'xyz';  // Signal updates
// BUT: Query still has key ['db', 'recordings', 'abc']
// The reactive chain is broken
```

The query was created with the VALUE at that moment (`'abc'`), not with a SUBSCRIPTION to the signal. When the signal changes, nothing tells the query to update.

### Passing Accessor Functions Preserves Reactivity

```typescript
// This creates a getter function
const query = createQuery(
  rpc.db.recordings.getById(() => recordingId).options
);
```

What actually runs:

```typescript
// Step 1: Pass FUNCTION to getById
// Step 2: getById calls the function to get current value
// Step 3: Creates query with key based on function result
// Step 4: TanStack Query can call this function again later
```

Now when you update `recordingId`:

```typescript
recordingId = 'xyz';  // Signal updates
// TanStack Query re-evaluates the function
// Gets new value 'xyz'
// Updates query key to ['db', 'recordings', 'xyz']
// Fetches new data
```

The accessor function creates a lazy evaluation boundary. Instead of capturing a snapshot, you're passing a recipe that can be evaluated again when needed.

## The Lazy Evaluation Boundary Concept

Think of it like the difference between a photo and a live camera feed.

**Passing a value directly** is like taking a photo:
```typescript
// "Here's what recordingId looks like RIGHT NOW"
getById(recordingId)  // Snapshot: 'abc'
```

**Passing an accessor function** is like giving someone a live camera:
```typescript
// "Here's how to check what recordingId is at any time"
getById(() => recordingId)  // Live feed: check current value
```

The accessor function `() => recordingId` creates a boundary where Svelte's reactivity system can establish subscriptions. When TanStack Query calls this function, it happens within a reactive context that tracks which signals are accessed.

This is how Svelte knows: "This query depends on the recordingId signal. When that signal changes, re-evaluate everything that depends on it."

## How the Pattern Works in Practice

Here's the actual implementation from our codebase:

```typescript
// In /lib/query/db.ts
getById: (id: Accessor<string>) =>
  defineQuery({
    queryKey: dbKeys.recordings.byId(id()),
    resultQueryFn: () => services.db.recordings.getById(id()),
  }),
```

The `Accessor<string>` type is defined by TanStack Query:

```typescript
type Accessor<T> = () => T;
```

It's just a function that returns a value. Simple.

When you use it in a component:

```typescript
// In a component
let recordingId = $state('abc');

const recordingQuery = createQuery(
  rpc.db.recordings.getById(() => recordingId).options
);

// Later...
recordingId = 'xyz';  // Query automatically updates!
```

The flow:

1. `getById(() => recordingId)` receives the accessor function
2. Inside `getById`, it calls `id()` to get the current value
3. TanStack Query stores this accessor for future re-evaluation
4. When `recordingId` changes, Svelte's reactivity system triggers
5. TanStack Query re-evaluates the accessor, gets new value
6. Query key changes, new data is fetched

## Real Examples from Our Codebase

### Example 1: Recording Row Actions

```typescript
// From: /routes/(config)/recordings/row-actions/RecordingRowActions.svelte
let { recordingId } = $props<{ recordingId: string }>();

const recordingQuery = createQuery(
  rpc.db.recordings.getById(() => recordingId).options,
);

const recording = $derived(recordingQuery.data);
```

Why the accessor? Because `recordingId` comes from props, which can change when you select different rows in the table. The accessor ensures the query updates when props change.

### Example 2: Transformation Row Actions

```typescript
// From: /routes/(config)/transformations/TransformationRowActions.svelte
let { transformationId } = $props<{ transformationId: string }>();

const transformationQuery = createQuery(
  rpc.db.transformations.getById(() => transformationId).options,
);

const transformation = $derived(transformationQuery.data);
```

Same pattern. The component receives an ID via props, wraps it in an accessor, and the query stays reactive to prop changes.

### Example 3: Transformation Runs

```typescript
// From: /lib/query/db.ts
runs: {
  getByRecordingId: (recordingId: Accessor<string>) =>
    defineQuery({
      queryKey: dbKeys.runs.byRecordingId(recordingId()),
      resultQueryFn: () => services.db.runs.getByRecordingId(recordingId()),
    }),

  getLatestByRecordingId: (recordingId: Accessor<string>) =>
    defineQuery({
      queryKey: dbKeys.runs.byRecordingId(recordingId()),
      resultQueryFn: () => services.db.runs.getByRecordingId(recordingId()),
      select: (data) => data.at(0),
    }),
},
```

These queries need reactive recordingIds because they're used in contexts where the selected recording can change.

## What Happens If You Don't Use Accessors?

Let's trace through the broken version:

```typescript
// BAD: Direct value
let recordingId = $state('abc');

const query = createQuery(
  rpc.db.recordings.getById(recordingId).options  // Evaluates to 'abc' NOW
);

// The query is created with:
// queryKey: ['db', 'recordings', 'abc']
// resultQueryFn: () => services.db.recordings.getById('abc')
```

Later:

```typescript
recordingId = 'xyz';  // Signal updates

// But the query STILL has:
// queryKey: ['db', 'recordings', 'abc']
// resultQueryFn: () => services.db.recordings.getById('abc')

// Your UI shows old data from recording 'abc'
// Even though you wanted recording 'xyz'
```

The value was captured at creation time. When the signal changes, the query doesn't know to update.

### With Accessor Functions

```typescript
// GOOD: Accessor function
let recordingId = $state('abc');

const query = createQuery(
  rpc.db.recordings.getById(() => recordingId).options
);

// The query is created with:
// queryKey: ['db', 'recordings', <result of calling accessor>]
// resultQueryFn: () => services.db.recordings.getById(<result of calling accessor>)
```

Later:

```typescript
recordingId = 'xyz';  // Signal updates

// TanStack Query re-evaluates:
// - Calls () => recordingId
// - Gets 'xyz'
// - Updates queryKey to ['db', 'recordings', 'xyz']
// - Fetches new data for recording 'xyz'

// Your UI updates with the new recording!
```

The accessor function is called EACH TIME the query needs to evaluate. This maintains the reactive subscription.

## Common Mistake: Using .fetch() or .execute()

You might see this pattern and think you can skip the accessor when using `.fetch()`:

```typescript
// This seems fine, right?
const { data, error } = await rpc.db.transformations.getById(() => transformationId).fetch();
```

This works, but it's not reactive. `.fetch()` is for imperative, one-time queries. It doesn't subscribe to changes.

For reactive queries in components, always use `createQuery` with accessors:

```typescript
// Reactive - updates when transformationId changes
const query = createQuery(
  rpc.db.transformations.getById(() => transformationId).options
);
```

The accessor pattern is specifically for maintaining reactivity with TanStack Query's subscription system.

## When You Don't Need Accessors

If the value never changes, you can pass it directly:

```typescript
// This is fine - the ID is hardcoded
const query = createQuery(
  rpc.db.recordings.getById(() => 'fixed-id-123').options
);

// Or if you're using .fetch() imperatively
const { data } = await rpc.db.recordings.getById(() => someId).fetch();
```

But in practice, most component queries need reactivity. When in doubt, use an accessor.

## The Takeaway

Svelte 5's signals require accessor functions to preserve reactive tracking. When you pass `() => value` instead of `value`, you create a lazy evaluation boundary that allows TanStack Query to re-evaluate the query when the underlying signal changes.

Not every data access needs a service. And not every reactive value can be passed directly. The accessor pattern bridges Svelte 5's signal-based reactivity with TanStack Query's subscription system.

Remember: values are snapshots, accessors are live feeds. Choose accordingly.
