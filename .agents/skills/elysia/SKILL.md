---
name: elysia
description: Elysia.js server patterns for error handling, status responses, and plugin composition. Use when writing Elysia route handlers, returning HTTP errors, creating plugins, or working with Eden Treaty type safety.
metadata:
  author: epicenter
  version: '1.0'
---

# Elysia.js Patterns (v1.2+)

## When to Apply This Skill

Use this pattern when you need to:

- Write or refactor Elysia handlers to use `status()` responses.
- Define per-status response schemas for Eden Treaty type safety.
- Migrate handlers away from `set.status` plus error-object returns.
- Compose Elysia plugins/guards for shared auth and route behavior.
- Choose between `return status(...)` and `throw status(...)` by control-flow context.

## The `status()` Helper (ALWAYS use this)

**Never use `set.status` + return object.** Always destructure `status` from the handler context and use it for all non-200 responses. This gives you:

- Typesafe string literals with full IntelliSense (e.g. `"Bad Request"` instead of `400`)
- Automatic response type inference per status code
- Eden Treaty end-to-end type safety on error responses

### Basic Usage

```typescript
import { Elysia, t } from 'elysia';

new Elysia().post(
	'/chat',
	async ({ body, headers, status }) => {
		//                       ^^^^^^ destructure status from context

		if (!isValid(body.provider)) {
			// Use string literal for self-documenting, typesafe status codes
			return status('Bad Request', 'Unsupported provider');
		}

		if (!apiKey) {
			return status('Unauthorized', 'Missing API key');
		}

		return doWork(body);
	},
	{
		// Define response schemas per status code for full type safety
		response: {
			200: t.Any(),
			400: t.String(),
			401: t.String(),
		},
	},
);
```

### `return status()` vs `throw status()`

Both work. The framework handles either. The difference is purely control flow:

| Pattern              | Behavior                                      | Use when                                                               |
| -------------------- | --------------------------------------------- | ---------------------------------------------------------------------- |
| `return status(...)` | Normal return, continues to response pipeline | You're at a natural return point (validation guards, end of handler)   |
| `throw status(...)`  | Short-circuits execution immediately          | You're deep in nested logic or inside a try/catch and want to bail out |

**This codebase convention: prefer `return status(...)`.** It matches the existing early-return-on-error pattern used everywhere else (see `error-handling` skill). Reserve `throw status(...)` for catch blocks or deeply nested code where `return` would be awkward.

```typescript
// GOOD: return for validation guards (matches codebase style)
async ({ body, status }) => {
	if (!isValid(body.provider)) {
		return status('Bad Request', `Unsupported provider: ${body.provider}`);
	}

	const apiKey = resolveApiKey(body.provider, headerApiKey);
	if (!apiKey) {
		return status('Unauthorized', 'Missing API key');
	}

	// happy path
	return doWork(body);
};

// GOOD: throw inside catch blocks
async ({ body, status }) => {
	try {
		return await streamResponse(body);
	} catch (error) {
		if (isAbortError(error)) {
			throw status(499, 'Client closed request');
		}
		throw status('Bad Gateway', `Provider error: ${error.message}`);
	}
};
```

### Type inference is identical for both

Both `return status(...)` and `throw status(...)` produce the same `ElysiaCustomStatusResponse` object. Elysia's type system infers response types from the `response` schema in route options, not from how you invoke `status()`. Eden Treaty type safety works equally with either approach.

## Available String Status Codes (StatusMap)

Use these string literals instead of numeric codes for better readability:

| String Literal            | Code | Common Use                                 |
| ------------------------- | ---- | ------------------------------------------ |
| `'Bad Request'`           | 400  | Validation failures, malformed input       |
| `'Unauthorized'`          | 401  | Missing/invalid auth credentials           |
| `'Forbidden'`             | 403  | Valid auth but insufficient permissions    |
| `'Not Found'`             | 404  | Resource doesn't exist                     |
| `'Conflict'`              | 409  | State conflict (duplicate, already exists) |
| `'Unprocessable Content'` | 422  | Semantically invalid input                 |
| `'Too Many Requests'`     | 429  | Rate limiting                              |
| `'Internal Server Error'` | 500  | Unexpected server failure                  |
| `'Bad Gateway'`           | 502  | Upstream provider error                    |
| `'Service Unavailable'`   | 503  | Temporary overload/maintenance             |

For non-standard codes (e.g. nginx's 499), use the numeric literal directly: `status(499, 'Client closed request')`.

## Response Schemas for Eden Treaty Type Safety

Define `response` schemas per status code in route options. This is what makes Eden Treaty infer error types on the client:

```typescript
new Elysia().post(
	'/chat',
	async ({ body, status }) => {
		if (!isValid(body.provider)) {
			return status('Bad Request', `Unsupported provider: ${body.provider}`);
		}
		return streamResult;
	},
	{
		body: t.Object({
			provider: t.String(),
			model: t.String(),
		}),
		response: {
			200: t.Any(), // Success type
			400: t.String(), // Bad Request body type
			401: t.String(), // Unauthorized body type
			502: t.String(), // Bad Gateway body type
		},
	},
);
```

Eden Treaty then infers:

```typescript
const { data, error } = await api.chat.post({
	provider: 'openai',
	model: 'gpt-4',
});

if (error) {
	// error.status is typed as 400 | 401 | 502
	// error.value is typed per status code (string in this case)
	switch (error.status) {
		case 400: // error.value: string
		case 401: // error.value: string
		case 502: // error.value: string
	}
}
```

## Error Response Body: Strings vs Objects

**Prefer plain strings as error bodies.** The status code already communicates the error class. A descriptive string message is sufficient and keeps the API simple.

```typescript
// GOOD: Plain string - status code provides the category
return status('Bad Request', `Unsupported provider: ${provider}`);
return status('Unauthorized', 'Missing API key: set x-provider-api-key header');

// AVOID: Wrapping in { error: "..." } object - redundant with status code
set.status = 400;
return { error: `Unsupported provider: ${provider}` };
```

If you need structured error bodies (multiple fields, error codes, validation details), define a TypeBox schema:

```typescript
const ErrorBody = t.Object({
  message: t.String(),
  code: t.Optional(t.String()),
});

// In route options:
response: {
  400: ErrorBody,
  401: ErrorBody,
}
```

## Plugin Composition

Elysia plugins are just functions that return Elysia instances. Use `new Elysia()` inside the plugin, not `new Elysia({ prefix })` — let the consumer control mounting:

```typescript
// GOOD: Plugin is prefix-agnostic
export function createMyPlugin() {
	return new Elysia().post('/endpoint', async ({ body, status }) => {
		// ...
	});
}

// Consumer controls the prefix
app.use(new Elysia({ prefix: '/api' }).use(createMyPlugin()));
```

## Guards for Shared Auth

Use `.guard()` with `beforeHandle` for auth that applies to multiple routes:

```typescript
const authed = new Elysia().guard({
	async beforeHandle({ headers, status }) {
		const token = extractBearerToken(headers.authorization);
		if (!isValid(token)) {
			return status('Unauthorized', 'Invalid or missing token');
		}
	},
});

// All routes under this guard require auth
return authed
	.get('/protected', () => 'secret')
	.post('/admin', () => 'admin stuff');
```

## Migration Checklist: `set.status` to `status()`

When updating existing handlers:

1. Replace `set` with `status` in the handler destructuring
2. Replace `set.status = N; return { error: msg };` with `return status('String Literal', msg);`
3. In catch blocks, use `throw status(...)` instead of `set.status = N; return { error: msg };`
4. Add `response` schemas to route options for Eden Treaty type inference
5. Keep `set` in the destructuring ONLY if you still need `set.headers` for things like `content-type`

```typescript
// BEFORE
async ({ body, headers, set }) => {
	if (!valid) {
		set.status = 400;
		return { error: 'Bad input' };
	}
};

// AFTER
async ({ body, headers, status }) => {
	if (!valid) {
		return status('Bad Request', 'Bad input');
	}
};

// AFTER (when you also need set.headers)
async ({ body, headers, set, status }) => {
	if (!valid) {
		return status('Bad Request', 'Bad input');
	}
	set.headers['content-type'] = 'application/octet-stream';
	return binaryData;
};
```
