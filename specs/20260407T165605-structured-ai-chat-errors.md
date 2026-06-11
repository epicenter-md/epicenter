# Structured AI Chat Errors: defineErrors End-to-End

**Date**: 2026-04-07
**Status**: Draft
**Author**: AI-assisted

## Overview

Carry wellcrafted `defineErrors` structured errors from the API's JSON response all the way to the client's chat UI, so the frontend can show "Sign in to use AI Chat" instead of "HTTP error! status: 401". The server already sends structured errors. The client just doesn't read them.

## Motivation

### Current State

The server returns structured, discriminated errors:

```ts
// apps/api/src/ai-chat.ts
const AiChatError = defineErrors({
  InsufficientCredits: ({ balance }) => ({ message: 'Insufficient credits', balance }),
  ModelRequiresPaidPlan: ({ model, credits }) => ({
    message: `${model} requires a paid plan (costs ${credits} credits)`,
    model, credits,
  }),
});

return c.json(AiChatError.InsufficientCredits({ balance }), 402);
// Wire: { "data": null, "error": { "name": "InsufficientCredits", "message": "...", "balance": 42 } }
```

But TanStack AI's `fetchServerSentEvents` throws before reading the body:

```ts
// @tanstack/ai-client: connection-adapters.ts:297
if (!response.ok) {
  throw new Error(`HTTP error! status: ${response.status} ${response.statusText}`)
  //                ▲ body is NEVER read: structured error is lost
}
```

The client parses status codes from error message strings:

```ts
// apps/opensidian/src/lib/chat/chat-state.svelte.ts
get isCreditsExhausted() {
  return chat.error.message.includes('status: 402');  // fragile string parsing
},
```

This creates problems:

1. **Lost structured data**: The server sends `{ name, message, balance, model, credits }` but the client only sees `"HTTP error! status: 402"`. All fields besides the status code are discarded.
2. **Fragile discrimination**: `error.message.includes('status: 402')` breaks if TanStack AI ever changes the message format. Can't distinguish between different error variants that share a status code.
3. **No actionable UI**: The error banner shows `"HTTP error! status: 401"` instead of "Sign in to use AI Chat" with a sign-in button. Each error type should drive specific UI affordances.

### Desired State

```ts
// Client-side: typed, structured error from the server
const err = chat.error;
if (isAiChatError(err)) {
  switch (err.serverError.name) {
    case 'Unauthorized':
      // Show sign-in prompt
      break;
    case 'InsufficientCredits':
      // Show "upgrade plan" with err.serverError.balance
      break;
    case 'ModelRequiresPaidPlan':
      // Show "this model needs Pro" with err.serverError.model
      break;
    case 'ProviderNotConfigured':
      // Show BYOK API key prompt
      break;
  }
}
```

## Research Findings

### TanStack AI Error Pipeline

Traced the full path from server response to client `onError`:

```
fetchServerSentEvents
  └─ calls fetchClient(url, opts)
       └─ gets Response
            └─ if (!response.ok) throw Error(`HTTP error! status: ${status}`)
                                       ▲ body never read
                                       │
normalizeConnectionAdapter.send()
  └─ catches thrown error
       └─ pushes RUN_ERROR chunk: { type: 'RUN_ERROR', error: { message: err.message } }
       └─ re-throws the error
            │
ChatClient.streamResponse()
  └─ catches thrown error
       └─ reportStreamError(err)
            └─ setError(err)         → chat.error
            └─ onError(err)          → your callback
```

**Key finding**: The `Error` instance thrown by `fetchServerSentEvents` is the exact same `Error` object that arrives at `onError`. It's not re-wrapped or cloned. Any properties we attach to it survive the entire pipeline.

**Key finding**: `fetchClient` is called *before* the `!response.ok` check. If our custom `fetchClient` throws first (after reading the body), TanStack AI's check never executes. The thrown error propagates directly through the same catch chain.

### wellcrafted defineErrors Wire Format

`defineErrors` produces `Err(Object.freeze({ ...body, name }))` which Hono's `c.json()` serializes as:

```json
{
  "data": null,
  "error": {
    "name": "InsufficientCredits",
    "message": "Insufficient credits",
    "balance": 42
  }
}
```

The `name` field is the discriminant. Identical to how `switch (error.name)` works in the Result pattern. The full `error` object is a frozen plain object, fully JSON-serializable, no prototype chain.

### Can We Avoid Throwing Entirely?

**Constraint**: TanStack AI's `ChatClient` consumes the connection adapter via `await this.connection.send(messages, body, signal)`. The only error channel is throwing: `send()` returns `void`, and `ChatClient.streamResponse()` only checks for errors via the catch block (line 636) and the `RUN_ERROR` chunk.

We cannot change `ChatClient`'s internal error handling without forking TanStack AI. The throw boundary is inside `ChatClient`: it's their code.

**However**: We control everything *before* the throw. The `fetchClient` option lets us:
1. Read the response body
2. Parse the structured error
3. Attach it to the `Error` object we throw
4. The `Error` propagates unchanged to `onError`

So the answer is: **defineErrors all the way down to the throw boundary, then attach the structured data to the Error that crosses it**. On the client side, we extract it back out.

## Design Decisions

| Decision | Choice | Rationale |
|---|---|---|
| Where to read error body | Custom `fetchClient` wrapper | Only intervention point before TanStack AI discards the body. The `fetchClient` option is explicitly designed for this (auth, proxies, custom transport). |
| How to attach structured data | Properties on the thrown `Error` | The same `Error` instance propagates to `onError`: verified by tracing the code. No cloning or re-wrapping occurs. |
| Error shape on the wire | Keep `{ data, error }` Result envelope | Already in place. `c.json(AiChatError.Variant(), status)` produces this. No server changes needed for serialization. |
| Client-side type narrowing | Type guard function `isAiChatHttpError(err)` | Clean narrowing. Avoids `as any` casts. Single place to define the shape. |
| Client-side error type | `InferErrors<typeof AiChatError>` reused from server's `defineErrors` | No manual type mirroring. The server defines the error variants once; the client imports the type. `switch (err.serverError.name)` gives full TypeScript narrowing with variant-specific fields. |
| Where to define shared errors | `@epicenter/constants` | Both server and client import from here. Server uses the factories at runtime; client uses `InferErrors` type-only + the type guard at runtime. |
| Server response changes | Merge `Unauthorized` into `AiChatError` | Currently `AuthError.Unauthorized()` is in `app.ts` separately. Moving it into the shared `AiChatError` keeps all `/ai/chat` errors in one discriminated union. |

## Architecture

### Error Flow (After)

```
SERVER                              WIRE                          CLIENT
──────                              ────                          ──────

AiChatError                         HTTP 402                      createAiFetchClient
  .InsufficientCredits              Body:                           │
  ({ balance: 42 })                 ┌──────────────────┐            ▼
    │                               │{ "data": null,   │         response = await
    ▼                               │  "error": {      │           authFetch(url, init)
  c.json(result, 402)              │    "name":       │         if (!response.ok) {
                                    │     "Insufficient│           body = await response.json()
                                    │      Credits",   │           ──────────────────────────
                                    │    "message":    │           READS BODY ← key change
                                    │     "Insuffici..."│          ──────────────────────────
                                    │    "balance": 42 │           const err = new Error(...)
                                    │  }               │           err.status = 402
                                    │}                 │           err.serverError = body.error
                                    └──────────────────┘           throw err
                                                                     │
                                    (body IS read this time)         │
                                                                     ▼
                                                                  normalizeConnectionAdapter
                                                                    └─ re-throws (same err)
                                                                       │
                                                                       ▼
                                                                  ChatClient.reportStreamError
                                                                    └─ setError(err)
                                                                    └─ onError(err)
                                                                       │
                                                                       ▼
                                                                  chat.error  ← has .serverError
                                                                       │
                                                                       ▼
                                                                  AiChat.svelte
                                                                    if isAiChatError(err):
                                                                      switch (err.serverError.name)
                                                                        "Unauthorized" → sign-in UI
                                                                        "InsufficientCredits" → upgrade
                                                                        "ModelRequiresPaidPlan" → hint
                                                                        "ProviderNotConfigured" → BYOK
```

### Type Hierarchy

The key insight: `InferErrors<typeof AiChatError>` already produces the exact discriminated union that goes over the wire. We reuse the server's type directly. No manual mirroring.

```ts
// What InferErrors<typeof AiChatError> produces:
| Readonly<{ name: "ProviderNotConfigured"; message: string; provider: string }>
| Readonly<{ name: "UnknownModel"; message: string; model: string }>
| Readonly<{ name: "InsufficientCredits"; message: string; balance: unknown }>
| Readonly<{ name: "ModelRequiresPaidPlan"; message: string; model: string; credits: number }>

// This is the EXACT shape that c.json() serializes into response.error.
// The client type-asserts the parsed JSON into this union.
// switch (error.name) narrows to the specific variant with all its fields.
```

```
                   Error (JS built-in)
                     │
                     ▼
               AiChatHttpError extends Error
                 ├── status: number
                 ├── serverError: InferErrors<typeof AiChatError>
                 │                      ▲
                 │                      │ same type from server's defineErrors
                 │                      │ reused via type-only import
                 └── message: string (from serverError.message or fallback)
```

## Implementation Plan

### Phase 1: Extract Shared Error Definitions

- [ ] **1.1** Move `AiChatError` defineErrors (and the `AuthError.Unauthorized` variant for `/ai/*`) into a shared location that both server and client can import. Two options:

**Option A (recommended)**: Extract the `defineErrors` call into a shared package (e.g. `packages/constants/src/ai-chat-errors.ts`). The server imports and uses the factories. The client imports the type only (`InferErrors`).

```ts
// packages/constants/src/ai-chat-errors.ts
import { defineErrors, type InferErrors } from 'wellcrafted/error';

export const AiChatError = defineErrors({
  Unauthorized: () => ({ message: 'Unauthorized' }),
  ProviderNotConfigured: ({ provider }: { provider: string }) => ({
    message: `${provider} not configured`,
    provider,
  }),
  UnknownModel: ({ model }: { model: string }) => ({
    message: `Unknown model: ${model}`,
    model,
  }),
  InsufficientCredits: ({ balance }: { balance: unknown }) => ({
    message: 'Insufficient credits',
    balance,
  }),
  ModelRequiresPaidPlan: ({
    model,
    credits,
  }: {
    model: string;
    credits: number;
  }) => ({
    message: `${model} requires a paid plan (costs ${credits} credits)`,
    model,
    credits,
  }),
});

/** Discriminated union of all AI chat error payloads. Reused by both server and client. */
export type AiChatError = InferErrors<typeof AiChatError>;
```

**Option B**: Keep `defineErrors` in `apps/api/src/ai-chat.ts` and export only the type. The client imports `type AiChatError` from the API package. Simpler if you don't want to move runtime code, but creates a dependency from client → API types.

- [ ] **1.2** Create the type guard and HTTP error type using `InferErrors`:

```ts
// packages/constants/src/ai-chat-errors.ts (continued)

/** An Error with structured server error data attached. */
export type AiChatHttpError = Error & {
  status: number;
  serverError: AiChatError;  // ← the InferErrors union, not a manual type
};

/** Type guard: narrows an Error to AiChatHttpError with full variant discrimination. */
export function isAiChatHttpError(err: unknown): err is AiChatHttpError {
  return (
    err instanceof Error &&
    'status' in err &&
    typeof (err as any).status === 'number' &&
    'serverError' in err &&
    typeof (err as any).serverError === 'object' &&
    (err as any).serverError !== null &&
    'name' in (err as any).serverError
  );
}
```

Now the client gets full TypeScript narrowing:

```ts
if (isAiChatHttpError(err)) {
  switch (err.serverError.name) {
    case 'InsufficientCredits':
      err.serverError.balance;  // ← TypeScript knows this exists
      break;
    case 'ModelRequiresPaidPlan':
      err.serverError.model;    // ← narrowed to string
      err.serverError.credits;  // ← narrowed to number
      break;
    case 'Unauthorized':
      // no extra fields, just show sign-in UI
      break;
  }
}
```

- [ ] **1.3** Export from `packages/constants/src/index.ts` and verify the package builds.

### Phase 2: Custom fetchClient Wrapper

- [ ] **2.1** Create `packages/svelte-utils/src/auth/create-ai-fetch-client.ts`:

```ts
import type { AiChatError } from '@epicenter/constants';

/**
 * Wrap an authenticated fetch client to read structured error bodies
 * before TanStack AI's adapter can throw a generic status-only error.
 *
 * When the server returns a non-2xx response, this wrapper:
 * 1. Reads the JSON body (wellcrafted's { data, error } envelope)
 * 2. Extracts the structured error (name, message, variant fields)
 * 3. Throws an Error with .status and .serverError attached
 *
 * The thrown Error propagates unchanged through TanStack AI's
 * ChatClient pipeline to onError / chat.error.
 */
export function createAiFetchClient(authFetch: typeof fetch): typeof fetch {
  return async (input, init) => {
    const response = await authFetch(input, init);

    if (!response.ok) {
      let serverError: AiChatError | undefined;
      try {
        const body = await response.json();
        // wellcrafted Err envelope: { data: null, error: { name, message, ... } }
        if (body?.error && typeof body.error === 'object' && 'name' in body.error) {
          serverError = body.error as AiChatError;
        }
      } catch {
        // Body wasn't JSON: fall through with undefined serverError
      }

      const message = serverError?.message ?? `HTTP error! status: ${response.status}`;
      const error = new Error(message) as Error & {
        status: number;
        serverError: AiChatError | undefined;
      };
      error.status = response.status;
      error.serverError = serverError;
      throw error;
    }

    return response;
  };
}
```

- [ ] **2.2** Export from `packages/svelte-utils/src/index.ts`.

### Phase 3: Wire Into Chat State

- [ ] **3.1** Update `apps/opensidian/src/lib/chat/chat-state.svelte.ts`:

```ts
import { createAiFetchClient } from '@epicenter/svelte-utils';
import { isAiChatHttpError } from '@epicenter/constants';

// In createConversationHandle:
connection: fetchServerSentEvents(
  () => `${APP_URLS.API}/ai/chat`,
  async () => ({
    fetchClient: createAiFetchClient(auth.fetch),  // ← swap
    body: { data: { ... } },
  }),
),
```

- [ ] **3.2** Replace string-based error detection with typed checks:

```ts
get isCreditsExhausted() {
  return isAiChatHttpError(chat.error)
    && chat.error.serverError.name === 'InsufficientCredits';
},

get isUnauthorized() {
  return isAiChatHttpError(chat.error)
    && chat.error.serverError.name === 'Unauthorized';
},

get isModelRestricted() {
  return isAiChatHttpError(chat.error)
    && chat.error.serverError.name === 'ModelRequiresPaidPlan';
},
```

- [ ] **3.3** Apply the same changes to `apps/tab-manager/src/lib/chat/chat-state.svelte.ts` (same pattern).

### Phase 4: Server: Unify Auth Error Into AiChatError

- [ ] **4.1** The `authGuard` in `app.ts` returns `AuthError.Unauthorized()` before the request reaches `ai-chat.ts`. Two options:

**Option A (minimal)**: Keep `AuthError` in `app.ts` as-is. The fetchClient wrapper already reads any `{ data, error }` envelope regardless of which `defineErrors` produced it. The `name: "Unauthorized"` field matches the shared type.

**Option B (clean)**: Add `Unauthorized` to `AiChatError` in `ai-chat.ts` and use a route-level middleware override for `/ai/chat` that returns the ai-chat-specific error. This keeps all `/ai/chat` error variants in one union.

**Recommendation**: Option A. The existing `AuthError.Unauthorized()` already produces `{ name: "Unauthorized", message: "Unauthorized" }` which the client type guard handles. No server changes needed.

### Phase 5: UI Error States

- [ ] **5.1** Update `AiChat.svelte` to show contextual error UI:

```svelte
{#if active?.isUnauthorized}
  <div class="...">
    <span>Sign in to use AI Chat</span>
    <Button onclick={() => /* open auth popover or navigate */}>Sign In</Button>
  </div>
{:else if active?.isCreditsExhausted}
  <div class="...">
    <span>You're out of credits</span>
    <Button onclick={() => /* open billing */}>Upgrade</Button>
  </div>
{:else if active?.isModelRestricted}
  <div class="...">
    <span>{active.error?.serverError?.message}</span>
    <Button onclick={() => /* switch to free model */}>Switch Model</Button>
  </div>
{:else if errorVisible}
  <!-- Generic fallback for unknown errors -->
  <div class="...">{active?.error?.message}</div>
{/if}
```

- [ ] **5.2** Decide whether to also show a subtle auth indicator in the chat header (e.g. small "Not signed in" badge) *before* the user sends a message.

## Edge Cases

### Non-JSON Error Responses

1. Server returns HTML error page (502 from Cloudflare, proxy error)
2. `response.json()` throws in the wrapper
3. `serverError` stays `undefined`, `message` falls back to `HTTP error! status: 502`
4. UI shows generic error banner. Same as today, but with a cleaner message

### Network Errors (No Response At All)

1. `fetch()` itself throws (DNS failure, offline)
2. Wrapper never reaches the `!response.ok` check. The thrown error propagates directly
3. `isAiChatHttpError` returns `false` (no `.status` or `.serverError`)
4. UI shows generic error banner with the network error message

### BYOK Requests That Fail

1. User provides their own API key, server's provider adapter throws
2. Server catches in `ai-chat.ts`, refunds credits via `afterResponse`
3. The thrown error from the stream adapter is a different shape (not from `defineErrors`)
4. Client shows generic error. This is correct behavior, the error is from the LLM provider, not from our auth/billing

### Concurrent Conversations With Different Auth States

1. User is signed in, opens conversation A, starts streaming
2. Token expires mid-stream
3. Conversation B send fails with 401
4. Each conversation handle has independent `error` state. Conversation A continues, B shows auth prompt
5. No global state corruption

## Open Questions

1. **Should we show an auth state indicator before the user sends?**
   - Options: (a) Subtle "Not signed in" badge in chat header, (b) Nothing until they try to send, (c) Replace the input placeholder text with "Sign in to chat..."
   - **Recommendation**: (b) initially. The "discover, try, get prompted" flow is what you described. Can add (a) or (c) later if users are confused.

2. **Where should the shared error types live?**
   - Options: (a) `@epicenter/constants`, (b) New `@epicenter/ai-errors` package, (c) Inline in each app
   - **Recommendation**: (a) `@epicenter/constants`: it already exists and holds shared cross-app types. The error type is small and stable.

3. **Should we expose `serverError` directly on the conversation handle, or keep it internal?**
   - Options: (a) `active.serverError` property on ConversationHandle, (b) Only expose boolean helpers like `isUnauthorized`, (c) Both
   - **Recommendation**: (c) Both. Booleans for common cases in templates, raw access for uncommon cases.

4. **Should we attempt to parse `defineErrors` bodies from ALL non-2xx routes, or only `/ai/chat`?**
   - The wrapper is generic. It'll parse any `{ data, error }` envelope from any Hono route. Could be reused for sync errors, billing errors, asset errors.
   - **Recommendation**: Make the wrapper generic (it already is). Use the specific `AiChatErrorName` union only for the AI chat UI logic. Other features can define their own unions later.

## Success Criteria

- [ ] Sending a message when not authenticated shows "Sign in to use AI Chat" (not "HTTP error! status: 401")
- [ ] Running out of credits shows "You're out of credits" with the balance from the server
- [ ] Using an expensive model on free tier shows the model name and credit cost from the server
- [ ] Network errors still show a reasonable generic message
- [ ] No `error.message.includes('status:')` string parsing anywhere in the codebase
- [ ] `isAiChatHttpError` type guard works with TypeScript narrowing
- [ ] Both opensidian and tab-manager apps use the same pattern
- [ ] Existing behavior for successful requests is unchanged

## References

- `apps/api/src/app.ts`: `authGuard` middleware, `AuthError.Unauthorized()` (lines 274-291)
- `apps/api/src/ai-chat.ts`: `AiChatError` defineErrors, all error responses (lines 37-61, 89-120)
- `apps/opensidian/src/lib/chat/chat-state.svelte.ts`: Chat state, `fetchServerSentEvents` wiring, `isCreditsExhausted` (lines 97-128, 208-211)
- `apps/tab-manager/src/lib/chat/chat-state.svelte.ts`: Same pattern, needs same changes
- `packages/svelte-utils/src/auth/create-auth.svelte.ts`: `auth.fetch` implementation (lines 410-415)
- `tmp-search/tanstack-ai/.../connection-adapters.ts`: `fetchServerSentEvents` `!response.ok` branch (lines 297-301)
- `tmp-search/tanstack-ai/.../chat-client.ts`: `reportStreamError`, error propagation (lines 328-344, 636-644)
- `node_modules/.bun/wellcrafted@0.34.1/.../error/index.js`: `defineErrors` runtime, `Err` wrapper (lines 57-67)
