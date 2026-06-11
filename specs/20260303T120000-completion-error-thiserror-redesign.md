# Completion Error Redesign: thiserror-Inspired Variants

**Created**: 2026-03-03
**Status**: Implemented
**Scope**: `apps/whispering/src/lib/services/isomorphic/completion/`: 7 files

## Summary

Redesign `CompletionError` from 11 status-code-mapped variants to 4 recovery-strategy-based variants, following Rust's `thiserror` principle: **each variant represents a different recovery strategy, not a different cause.** HTTP status codes become data on the `Http` variant rather than separate variant identities.

## Motivation

The current design has 11 variants (`BadRequest`, `Unauthorized`, `Forbidden`, `ModelNotFound`, `UnprocessableEntity`, `RateLimit`, `ServerError`, `ConnectionFailed`, `EmptyResponse`, `MissingParam`, `Api`). Problems:

1. **No consumer discriminates on the HTTP variants.** Every call site does `if (completionError) return Err(completionError.message)`: the `.tag` is never inspected for `BadRequest` vs `RateLimit` vs `Unauthorized`.
2. **30 lines of status-code mapping duplicated 3 times** across `groq.ts`, `anthropic.ts`, and `openai-compatible.ts`. Identical `if (status === 400) ... if (status === 401) ...` chains.
3. **Redundant message prefixes.** `"Rate limit exceeded: Rate limit exceeded on ..."`: the SDK error already contains the descriptive message, and `extractErrorMessage` pulls it out. The prefix duplicates what the cause already says.
4. **8 of 11 variants have identical shape** (`{ cause: unknown }` → `{ message, cause }`), differing only in message prefix. This is a `thiserror` anti-pattern: when variants share shape and handling, they're the same variant with different data.

## Design

### New `CompletionError` (4 variants)

```typescript
// types.ts
export const CompletionError = defineErrors({
	/** HTTP-level failure from the provider API. Status preserved for callers that need it. */
	Http: ({ status, cause }: { status: number; cause: unknown }) => ({
		message: `Request failed (${status}): ${extractErrorMessage(cause)}`,
		status,
		cause,
	}),
	/** Network/DNS/TLS failure, never reached the server */
	ConnectionFailed: ({ cause }: { cause: unknown }) => ({
		message: `Connection failed: ${extractErrorMessage(cause)}`,
		cause,
	}),
	/** Provider returned a successful response with no usable content */
	EmptyResponse: ({ providerLabel }: { providerLabel: string }) => ({
		message: `${providerLabel} API returned an empty response`,
		providerLabel,
	}),
	/** Required parameter was not provided */
	MissingParam: ({ param }: { param: string }) => ({
		message: `${param} is required`,
		param,
	}),
});
export type CompletionError = InferErrors<typeof CompletionError>;
```

**Why each variant exists:**

| Variant | Recovery strategy | Example consumer action |
|---|---|---|
| `Http` | Show message; caller can inspect `.status` for retry (429), re-auth (401), etc. | `if (error.status === 429) showRetryTimer()` |
| `ConnectionFailed` | "Check your internet" / automatic retry | Different from Http: server was never reached |
| `EmptyResponse` | Model/prompt issue: user should adjust | No cause to inspect, just a provider label |
| `MissingParam` | Validation error: fix the form | No cause, just which param is missing |

### Removed variants

`BadRequest`, `Unauthorized`, `Forbidden`, `ModelNotFound`, `UnprocessableEntity`, `RateLimit`, `ServerError`, `Api`: all collapse into `Http`. The status code is preserved as `error.status` for any future consumer that needs it.

### Status message overrides (`openai-compatible.ts`)

OpenRouter's `statusMessageOverrides` (e.g., `402: 'Insufficient credits...'`) still work naturally. When an override exists, the override string becomes the cause:

```typescript
const override = config.statusMessageOverrides?.[status];
if (override) {
	return CompletionError.Http({ status, cause: override });
}
```

This produces: `"Request failed (402): Insufficient credits in your OpenRouter account."`: cleaner than before because there's no redundant "API error:" prefix.

## File-by-File Changes

### 1. `types.ts`: Replace error definitions

**Before:** 11 variants (53 lines of `defineErrors`)
**After:** 4 variants (~20 lines)

Remove `BadRequest`, `Unauthorized`, `Forbidden`, `ModelNotFound`, `UnprocessableEntity`, `RateLimit`, `ServerError`, `Api`. Add `Http` with `status: number` field. Keep `ConnectionFailed`, `EmptyResponse`, `MissingParam` unchanged.

### 2. `groq.ts`: Replace status mapping with 2-branch catch

**Before (lines 37-66):** 30-line if-chain mapping status codes to individual variants.

**After:**
```typescript
const { data: completion, error: groqApiError } = await tryAsync({
	try: () =>
		client.chat.completions.create({
			model,
			messages: [
				{ role: 'system', content: systemPrompt },
				{ role: 'user', content: userPrompt },
			],
		}),
	catch: (error) => {
		if (error instanceof Groq.APIConnectionError) {
			return CompletionError.ConnectionFailed({ cause: error });
		}
		if (!(error instanceof Groq.APIError)) throw error;
		return CompletionError.Http({ status: error.status, cause: error });
	},
});

if (groqApiError) return Err(groqApiError);
```

The entire 30-line status mapping collapses into 2 branches inside the catch handler. The `instanceof APIConnectionError` check comes first (since it's a subclass of `APIError`), and after that guard, TypeScript narrows `error.status` to `number`: no `?? 0` needed.

### 3. `anthropic.ts`: Same pattern as groq

**Before (lines 34-63):** 30-line if-chain.

**After:** Same 2-branch catch pattern. `instanceof Anthropic.APIConnectionError` first, then `instanceof Anthropic.APIError` guard. `error.status` narrows to `number` after the connection error early return.

### 4. `openai-compatible.ts`: Same pattern + status overrides

**Before (lines 152-187):** 35-line if-chain with status override check.

**After:**
```typescript
catch: (error) => {
	if (error instanceof OpenAI.APIConnectionError) {
		return CompletionError.ConnectionFailed({ cause: error });
	}
	if (!(error instanceof OpenAI.APIError)) throw error;
	const override = config.statusMessageOverrides?.[error.status];
	return CompletionError.Http({
		status: error.status,
		cause: override ?? error,
	});
},
```

The `instanceof APIConnectionError` check comes first: since it's a subclass of `APIError`, it must be caught before the general `APIError` guard. After the connection error early return, TypeScript narrows `error.status` to `number` (not `number | undefined`), eliminating the need for `?? 0`. Status override check uses `error.status` directly.

### 5. `google.ts`: No changes

Google already uses a single catch-all pattern (`CompletionError.Api({ cause: error })`). Change `Api` → `Http` with `status: 0` (Google's SDK doesn't expose status codes, so 0 signals "unknown"):

```typescript
catch: (error) =>
	CompletionError.Http({ status: 0, cause: error }),
```

### 6. `openai.ts`, `openrouter.ts`, `custom.ts`: No changes

These files use the `createOpenAiCompatibleCompletionService` factory. They don't reference `CompletionError` variants directly (except `custom.ts` which uses `MissingParam`, which is unchanged).

### 7. Consumer: `transformer.ts`: No changes needed

Every consumer already does `if (completionError) return Err(completionError.message)`. The `.message` field still exists on all variants. No consumer matches on `.tag`, so no consumer breaks.

## Verification

1. `bun run typecheck` passes in `apps/whispering`
2. `bun test` passes (if completion-related tests exist)
3. Grep for any remaining references to removed variant names: `CompletionError.BadRequest`, `CompletionError.Unauthorized`, `CompletionError.Forbidden`, `CompletionError.ModelNotFound`, `CompletionError.UnprocessableEntity`, `CompletionError.RateLimit`, `CompletionError.ServerError`, `CompletionError.Api`: should return 0 results
4. Grep for `CompletionError.Http`: should appear in `groq.ts`, `anthropic.ts`, `openai-compatible.ts`, `google.ts`
