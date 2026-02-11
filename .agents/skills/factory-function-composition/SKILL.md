---
name: factory-function-composition
description: Apply factory function patterns to compose clients and services with proper separation of concerns. Use when creating functions that depend on external clients, wrapping resources with domain-specific methods, or refactoring code that mixes client/service/method options together.
metadata:
  author: epicenter
  version: '1.0'
---

# Factory Function Composition

This skill helps you apply factory function patterns for clean dependency injection and function composition in TypeScript.

## When to Apply This Skill

Use this pattern when you see:

- A function that takes a client/resource as its first argument
- Options from different layers (client, service, method) mixed together
- Client creation happening inside functions that shouldn't own it
- Functions that are hard to test because they create their own dependencies

## The Universal Signature

**Every factory function follows this signature:**

```typescript
function createSomething(dependencies, options?) {
	return {
		/* methods */
	};
}
```

- **First argument**: Always the resource(s). Either a single client or a destructured object of multiple dependencies.
- **Second argument**: Optional configuration specific to this factory. Never client config—that belongs at client creation.

Two arguments max. First is resources, second is config. No exceptions.

## The Core Pattern

```typescript
// Single dependency
function createService(client, options = {}) {
	return {
		method(methodOptions) {
			// Uses client, options, and methodOptions
		},
	};
}

// Multiple dependencies
function createService({ db, cache }, options = {}) {
	return {
		method(methodOptions) {
			// Uses db, cache, options, and methodOptions
		},
	};
}

// Usage
const client = createClient(clientOptions);
const service = createService(client, serviceOptions);
service.method(methodOptions);
```

## Key Principles

1. **Client configuration belongs at client creation time** — don't pipe clientOptions through your factory
2. **Each layer has its own options** — client, service, and method options stay separate
3. **Dependencies come first** — factory functions take dependencies as the first argument
4. **Return objects with methods** — not standalone functions that need the resource passed in

## Recognizing the Anti-Patterns

### Anti-Pattern 1: Function takes client as first argument

```typescript
// Bad
function doSomething(client, options) { ... }
doSomething(client, options);

// Good
const service = createService(client);
service.doSomething(options);
```

### Anti-Pattern 2: Client creation hidden inside

```typescript
// Bad
function doSomething(clientOptions, methodOptions) {
	const client = createClient(clientOptions); // Hidden!
	// ...
}

// Good
const client = createClient(clientOptions);
const service = createService(client);
service.doSomething(methodOptions);
```

### Anti-Pattern 3: Mixed options blob

```typescript
// Bad
doSomething({
	timeout: 5000, // Client option
	retries: 3, // Client option
	endpoint: '/users', // Method option
	payload: data, // Method option
});

// Good
const client = createClient({ timeout: 5000, retries: 3 });
const service = createService(client);
service.doSomething({ endpoint: '/users', payload: data });
```

### Anti-Pattern 4: Multiple layers hidden

```typescript
// Bad
function doSomething(clientOptions, serviceOptions, methodOptions) {
	const client = createClient(clientOptions);
	const service = createService(client, serviceOptions);
	return service.method(methodOptions);
}

// Good — each layer visible and configurable
const client = createClient(clientOptions);
const service = createService(client, serviceOptions);
service.method(methodOptions);
```

## Multiple Dependencies

When your service needs multiple clients:

```typescript
function createService(
	{ db, cache, http }, // Dependencies as destructured object
	options = {}, // Service options
) {
	return {
		method(methodOptions) {
			// Uses db, cache, http
		},
	};
}

// Usage
const db = createDbConnection(dbOptions);
const cache = createCacheClient(cacheOptions);
const http = createHttpClient(httpOptions);

const service = createService({ db, cache, http }, serviceOptions);
service.method(methodOptions);
```

## The Mental Model

Think of it as a chain where each link:

- Receives a resource from the previous link
- Adds its own configuration
- Produces something for the next link

```
createClient(...)  →  createService(client, ...)  →  service.method(...)
     ↑                       ↑                            ↑
 clientOptions          serviceOptions              methodOptions
```

## Benefits

- **Testability**: Inject mock clients easily
- **Reusability**: Share clients across multiple services
- **Flexibility**: Configure each layer independently
- **Clarity**: Clear ownership of configuration at each level

## References

See the full articles for more details:

- [The Universal Factory Function Signature](../../docs/articles/universal-factory-signature.md) — signature explained in depth
- [Stop Passing Clients as Arguments](../../docs/articles/stop-passing-clients-as-arguments.md) — practical guide
- [The Factory Function Pattern](../../docs/articles/factory-function-pattern.md) — detailed explanation
- [Factory Method Patterns](../../docs/articles/factory-method-patterns.md) — separating options and method patterns
