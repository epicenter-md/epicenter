# Generators vs Callbacks for Tree Traversal

> **TL;DR**: Use generators (`function*` + `yield`) instead of callbacks for tree traversal when you need to collect, filter, or transform results. You get:
>
> - No mutable accumulator variables
> - Natural `break` for early termination
> - Composable with `.map()`, `.filter()`, `.find()`
> - Left-to-right readable code flow
>
> ```typescript
> // Instead of this (callback)
> const paths: string[] = [];
> walkActions(actions, (_, path) => paths.push(path.join('/')));
>
> // Do this (generator)
> const paths = [...iterateActions(actions)].map(([_, path]) => path.join('/'));
> ```

---

I was building the action system for Epicenter and needed to walk a nested object structure. The type looked like this:

```typescript
type Actions = {
	[key: string]: Action<any, any> | Actions;
};
```

Actions can be nested arbitrarily deep. A user might have `actions.users.getById` or `actions.billing.subscriptions.cancel`. I needed to visit every leaf action with its full path.

My first instinct was the visitor pattern. The classic callback approach. It works, but something about it always felt clunky. This time I tried generators instead, and the difference was striking.

## The Callback Approach

Here's the visitor pattern implementation:

```typescript
function walkActions(
	actions: Actions,
	visitor: (action: Action, path: string[]) => void,
	path: string[] = [],
): void {
	for (const [key, value] of Object.entries(actions)) {
		const currentPath = [...path, key];
		if (isAction(value)) {
			visitor(value, currentPath);
		} else {
			walkActions(value, visitor, currentPath);
		}
	}
}
```

To collect all the action paths:

```typescript
const paths: string[] = [];
walkActions(actions, (_, path) => {
	paths.push(path.join('/'));
});
```

This works. But notice what happened: I had to create an external variable (`paths`), then mutate it inside the callback. The callback doesn't return anything. It's pure side effect. The relationship between "I want paths" and "here are paths" is spread across three lines with a mutable variable in between.

Want to filter? More callback soup:

```typescript
const mutations: Action[] = [];
walkActions(actions, (action, _) => {
	if (action.type === 'mutation') {
		mutations.push(action);
	}
});
```

Want to transform each action? Same pattern:

```typescript
const entries: [string, Action][] = [];
walkActions(actions, (action, path) => {
	entries.push([path.join('.'), action]);
});
```

Every operation follows the same dance: declare a variable, mutate it in a callback, use it after. The actual logic is buried inside anonymous functions.

## The Generator Approach

Now here's the same traversal as a generator:

```typescript
function* iterateActions(
	actions: Actions,
	path: string[] = [],
): Generator<[Action<any, any>, string[]]> {
	for (const [key, value] of Object.entries(actions)) {
		const currentPath = [...path, key];
		if (isAction(value)) {
			yield [value, currentPath];
		} else {
			yield* iterateActions(value, currentPath);
		}
	}
}
```

The structure is nearly identical. Same recursion, same path tracking. But instead of calling a visitor, we `yield` the result. And instead of passing callbacks down, we use `yield*` to delegate to recursive calls.

Now watch how the usage changes:

```typescript
// Collect paths - one line, no mutation
const paths = [...iterateActions(actions)].map(([_, path]) => path.join('/'));

// Filter mutations - standard array method
const mutations = [...iterateActions(actions)]
	.filter(([action]) => action.type === 'mutation')
	.map(([action]) => action);

// Transform to entries - just map
const entries = [...iterateActions(actions)].map(([action, path]) => [
	path.join('.'),
	action,
]);
```

No external variables. No mutation. Each operation reads left-to-right: spread the iterator, apply transformations, get result.

## Direct Iteration

Generators also let you iterate directly without collecting everything:

```typescript
for (const [action, path] of iterateActions(actions)) {
	console.log(action.type, path.join('.'));
}
```

This is lazy evaluation. If you break early, you don't traverse the entire tree. With the callback approach, you'd need to throw an exception or add a return flag:

```typescript
// Callback approach - awkward early exit
let found: Action | null = null;
walkActions(actions, (action, path) => {
	if (action.id === targetId) {
		found = action;
		// How do I stop? I can't.
	}
});

// Generator approach - natural early exit
for (const [action] of iterateActions(actions)) {
	if (action.id === targetId) {
		found = action;
		break; // Just works
	}
}
```

With callbacks, you'd need to add a return value to signal "stop traversing" and check it at every level. Generators give you `break` for free.

## Why Generators Win Here

The callback approach inverts control. You pass a function, and the walker calls it. Your code runs inside someone else's loop. This makes composition awkward because you can't use standard flow control.

Generators restore normal control flow. The walker yields values, and your code decides what to do with them. You're back in charge of the loop.

This matters most when you want to compose operations:

```typescript
// Find the first mutation that operates on users
const userMutation = [...iterateActions(actions)]
	.filter(([action]) => action.type === 'mutation')
	.find(([_, path]) => path[0] === 'users');
```

With callbacks, this would require nested mutable state and early-exit flags. With generators, it's just method chaining.

## The `yield*` Trick

The recursive delegation (`yield*`) deserves attention. When you write:

```typescript
yield * iterateActions(value, currentPath);
```

You're saying "yield everything from this nested generator." It flattens the recursion automatically. The caller sees a single stream of `[action, path]` tuples, regardless of nesting depth.

Without `yield*`, you'd need to manually loop:

```typescript
for (const item of iterateActions(value, currentPath)) {
	yield item;
}
```

Same result, more noise. `yield*` is syntax sugar that makes recursive generators clean.

## When to Use Each

Callbacks still make sense when:

- You need to modify the tree during traversal (generators shouldn't have side effects)
- You're integrating with callback-based APIs
- The traversal itself has complex early-termination logic that affects siblings

Generators shine when:

- You want to collect, filter, or transform results
- Early termination is a possibility
- You're composing multiple operations on the results
- You value readable, left-to-right code flow

For tree traversal that produces a stream of values, generators are almost always cleaner. The code reads naturally, composes with standard array methods, and doesn't require mutable accumulator variables.

## The Implementation Pattern

If you're converting a callback-based traversal to a generator, the pattern is mechanical:

1. Change the return type from `void` to `Generator<YourResultType>`
2. Add `*` after `function` to make it a generator
3. Replace `visitor(value)` with `yield value`
4. Replace recursive calls with `yield* recursiveCall()`
5. Remove the visitor parameter entirely

The walker's structure stays the same. Only the interface changes. From "call this function" to "produce this value."

That's the insight: generators let you separate the traversal logic from what you do with the results. The walker produces values. Your code consumes them. Clean boundaries, composable operations, readable flow.
