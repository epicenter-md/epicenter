# The TanStack Query Accessor Pattern in Svelte 5

I was building a recording list view in Svelte 5 with TanStack Query for data fetching. Everything worked on the first load, but when I clicked a different recording, the details wouldn't update. The query stayed stuck on the old recording.

Here's the code I wrote:

```typescript
const recordingId = $state('abc-123');
const query = createQuery(rpc.recordings.get(recordingId).options);
```

This looks right. `recordingId` is reactive. TanStack Query should pick up the change when it updates. But it doesn't.

## The Fix

Wrap reactive values in accessor functions:

```typescript
const recordingId = $state('abc-123');
const query = createQuery(rpc.recordings.get(() => recordingId).options);
```

That `() => recordingId` is the key. One character difference, completely different behavior.

## Why This Works

Svelte 5's reactivity is based on signals and getters. When you write `recordingId` in your code, Svelte's compiler turns that into a getter call that tracks dependencies. But when you pass `recordingId` directly to a function, you're passing the current value. A snapshot. TanStack Query doesn't know it's reactive.

When you pass `() => recordingId`, you're giving Query a function it can call. Every time Query calls that function, Svelte can track the dependency. Query can subscribe to changes. Now when `recordingId` updates, Query knows to re-run.

Here's the thing that took me too long to realize: Svelte's reactivity tracking happens at the call site. If you don't give TanStack Query a way to call into your reactive scope, it can't participate in reactivity tracking.

## When to Use Accessor Functions

If the value can change during the component's lifetime, use an accessor:

```typescript
// Props: wrap in accessor
const query = createQuery(rpc.recordings.get(() => props.recordingId).options);

// $state variables: wrap in accessor
const recordingId = $state('abc-123');
const query = createQuery(rpc.recordings.get(() => recordingId).options);

// $derived values: wrap in accessor
const computedId = $derived(props.userId + '-' + props.timestamp);
const query = createQuery(rpc.recordings.get(() => computedId).options);
```

If the value will never change, pass it directly:

```typescript
// String literals: pass directly
const query = createQuery(rpc.recordings.get('static-id').options);

// Constants: pass directly
const RECORDING_ID = 'abc-123';
const query = createQuery(rpc.recordings.get(RECORDING_ID).options);
```

## Common Mistakes

The method syntax trips people up. I've seen this written backwards:

```typescript
// Wrong: calling .options with the accessor
createQuery(rpc.method.options(() => param));

// Right: call the method with the accessor, then access .options
createQuery(rpc.method(() => param).options);
```

The accessor goes in the method call, not after `.options`. That's because the method (like `rpc.recordings.get`) returns an object that has an `.options` property. You're calling the method with reactive parameters, then accessing its options.

Another common mistake is forgetting the accessor for reactive values:

```typescript
// Wrong: passing reactive value directly
const recordingId = $state('abc-123');
createQuery(rpc.recordings.get(recordingId).options);

// Right: wrapping in accessor
const recordingId = $state('abc-123');
createQuery(rpc.recordings.get(() => recordingId).options);
```

I made this mistake a lot early on because it looks so similar. The broken version even works on the first render. It only breaks when the value changes, which makes it harder to catch.

## The Rule I Follow Now

If it can change, use an accessor function. If it's static, pass it directly.

That's it. When I'm writing a Query and I'm about to pass a parameter, I ask: can this value change? If yes, wrap it in `() => value`. If no, pass it as-is. This simple rule has saved me from a lot of reactivity bugs.

The accessor pattern is a small detail, but it's the difference between queries that update when they should and queries that mysteriously stay stuck on old data. Once you internalize it, it becomes second nature.
