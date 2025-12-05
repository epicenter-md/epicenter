# The "Let and Await Promise Pattern": Eliminating Code Duplication in Async Wrappers

Note: this is inspired by Standard Schema's example [in their GitHub README](https://github.com/standard-schema/standard-schema#how-do-i-accept-standard-schemas-in-my-library):

```
  let result = schema['~standard'].validate(input);
  if (result instanceof Promise) result = await result;
```

When wrapping functions that might return Promises or raw values, you often face a choice: duplicate your logic for sync and async cases, or find a way to normalize both paths. The "let and await promise pattern" offers an elegant solution.

## The Problem: Code Duplication

Consider this common scenario: you're wrapping a handler that might be synchronous or asynchronous, and you need to post-process the result in both cases.

### Pattern 1: Explicit Branching (The Old Way)

```typescript
const wrappedHandler = (...args: any[]) => {
	const result = config.handler(...args);

	// Handle async handlers
	if (result instanceof Promise) {
		return result.then((value) => {
			if (isResult(value)) return value;
			return Ok(value);
		});
	}

	// Handle sync handlers - DUPLICATED LOGIC
	if (isResult(result)) return result;
	return Ok(result);
};
```

Notice the duplication? The logic `if (isResult(value)) return value; return Ok(value)` appears twice: once in the `.then()` callback for async results, and once at the bottom for sync results.

### Pattern 2: Let-Await Normalization (The Clean Way)

```typescript
const wrappedHandler = async (...args: any[]) => {
	let result = config.handler(...args);
	if (result instanceof Promise) {
		result = await result;
	}

	// Common logic runs only once!
	if (isResult(result)) return result;
	return Ok(result);
};
```

By using a `let` variable and conditionally awaiting, we normalize both cases to the same code path. The post-processing logic only needs to be written once.

## How It Works

The pattern leverages a key insight: JavaScript allows you to reassign variables, and `await` unwraps Promises.

```typescript
let result = handler(); // Might be Promise<T> or T

if (result instanceof Promise) {
	result = await result; // Now result is definitely T
}

// From this point on, result is the unwrapped value
```

After the `if` statement, `result` is guaranteed to be the unwrapped value, whether the handler was sync or async. TypeScript's control flow analysis understands this and narrows the type accordingly.

## Why "let" Is Required

You might prefer `const` for everything, but this pattern requires `let` because we're reassigning the variable:

```typescript
let result = handler(); // Initial assignment
if (result instanceof Promise) {
	result = await result; // Reassignment - requires let
}
```

This is one of the few cases where `let` is genuinely the right choice over `const`.

## The Trade-off: Always Async

There's an important trade-off to understand:

**Pattern 1 (Branching)** preserves the sync/async distinction:

- Sync handler → sync wrapper (no Promise overhead)
- Async handler → async wrapper

**Pattern 2 (Normalization)** makes everything async:

- The wrapper is marked `async`, so it always returns a Promise
- Even sync handlers pay a small async tax (microtask queue)

### When This Trade-off Is Worth It

In most modern codebases, this trade-off is worthwhile because:

1. **Uniform interface**: Callers always get a Promise, simplifying their code
2. **Negligible overhead**: Modern JS engines optimize Promises heavily
3. **Uniform error handling**: Both sync throws and async rejections become Promise rejections
4. **Code clarity**: The implementation is easier to understand and maintain

## When This Pattern Shines

### 1. Wrapping Plugin Systems

```typescript
async function callPlugin(plugin: Plugin, data: any) {
	let result = plugin.process(data); // Might be sync or async
	if (result instanceof Promise) {
		result = await result;
	}

	// Common validation - only written once!
	if (!isValid(result)) {
		throw new Error('Invalid plugin output');
	}

	return normalizeResult(result);
}
```

### 2. Lazy Loading with Caching

```typescript
async function getData(key: string) {
	let data = cache.get(key); // Sync cache hit

	if (!data) {
		data = await fetch(`/api/${key}`); // Async cache miss
		cache.set(key, data);
	}

	// Common transformation runs either way
	return transformData(data);
}
```

### 3. Sequential Operations

```typescript
async function process(input: any) {
	let step1 = transform1(input);
	if (step1 instanceof Promise) step1 = await step1;

	let step2 = transform2(step1);
	if (step2 instanceof Promise) step2 = await step2;

	// Would be a nightmare with nested .then() chains
	return finalizeResult(step2);
}
```

### 4. Action Wrappers (Our Use Case)

```typescript
export function defineQuery(config: any): any {
	const wrappedHandler = async (...args: any[]) => {
		// Call the user's handler
		let result = config.handler(...args);

		// Normalize sync/async
		if (result instanceof Promise) {
			result = await result;
		}

		// Common wrapping logic (only written once)
		if (isResult(result)) return result;
		return Ok(result);
	};

	return Object.assign(wrappedHandler, {
		type: 'query' as const,
		input: config.input,
		description: config.description,
	});
}
```

## Alternative: Just Await Everything?

You might wonder: why not just `await` directly?

```typescript
const wrappedHandler = async (...args: any[]) => {
	let result = await config.handler(...args);
	if (isResult(result)) return result;
	return Ok(result);
};
```

This works, but it has a subtle difference:

- `await` on a non-Promise value wraps it in a Promise and immediately unwraps it
- This creates an extra Promise allocation for sync handlers
- The `instanceof Promise` check avoids this allocation

The difference is negligible in most cases, but the explicit check is a micro-optimization that says: "Only use Promise machinery if we actually have a Promise."

## Potential Gotchas

### 1. TypeScript Type Narrowing

The type of `result` changes after the if statement:

```typescript
let result: T | Promise<T> = handler();
if (result instanceof Promise) {
	result = await result; // Now result is T, not Promise<T>
}
```

TypeScript's control flow analysis handles this, but be aware the type is changing.

### 2. Doesn't Catch Thenables

The `instanceof Promise` check only catches actual Promises, not thenable objects with a `.then()` method. If you need to handle thenables, just `await` directly:

```typescript
let result = await handler(); // Handles both Promises and thenables
```

### 3. Testing Becomes Uniform

All tests must handle Promises, even when testing sync handlers:

```typescript
test('sync handler', async () => {
	const result = await wrappedHandler(); // Must await even though handler is sync
	expect(result).toBe(expected);
});
```

## When NOT to Use This Pattern

- **Performance-critical hot paths** where you can't afford any async overhead
- **You need different behavior for sync vs async** (rare)
- **Semantic distinction matters** (e.g., "sync must complete this tick")
- **Low-level libraries** where callers need to optimize for sync cases

## The Mental Model

Think of it as **normalization** rather than **branching**:

**Branching**: "I have two paths. Let me handle each separately."

- Fork in the road with different instructions for each path

**Normalization**: "I might have a value or a ticket for a value. Let me get the value first, then process it."

- Unpacking a box before working with its contents, regardless of wrapping

## Conclusion

The "let and await promise pattern" is a powerful technique for eliminating code duplication when wrapping potentially-async operations. By normalizing both sync and async cases to the same code path, you get:

- **No duplication**: Common logic written once
- **Uniform interface**: Always returns a Promise
- **Uniform errors**: Both throws and rejections become Promise rejections
- **Better maintainability**: Simpler, more linear code flow

The small performance cost of making sync operations async is almost always worth it for the dramatic improvement in code clarity and maintainability.
